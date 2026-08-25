import type { BasicTrack, Match, MatchedTrack } from '$lib/types';
import {
	abortableDelay,
	createAbortError,
	isAbortError,
	RequestTimeoutError,
	throwIfAborted
} from './abort';
import { isSafeRetryAfterSeconds, SPOTIFY_MATCHER_VERSION } from './catalog-scan';
import { fetchWithTimeout, type Fetcher } from './request';
import { getSpotifyConfiguration } from './spotify-config.server';
import { parseOfficialSpotifyArtworkUrl } from './artwork';
import { requestSpotifyToken } from './spotify-token.server';

const SEARCH_TIMEOUT_MS = 20_000;
export const SPOTIFY_SEARCH_INTERVAL_MS = 2_000;
export const SPOTIFY_TRANSIENT_RETRY_DELAYS_MS = [2_000, 5_000] as const;
// Successful final matches live only for this Node server session. FIFO eviction keeps memory
// bounded and deterministic; neither keys nor values contain tokens or user-identifying data.
export const SPOTIFY_SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
export const SPOTIFY_SEARCH_CACHE_MAX_ENTRIES = 500;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

let cachedToken: { value: string; expiresAt: number } | null = null;

export type SpotifyRateLimitReason = 'quota-exceeded' | 'rate-limited';

export type SpotifySessionMetrics = {
	searchRequests: number;
	cacheHits: number;
	transientRetries: number;
	rateLimitResponses: number;
	quotaExceededResponses: number;
};

const spotifySessionMetrics: SpotifySessionMetrics = {
	searchRequests: 0,
	cacheHits: 0,
	transientRetries: 0,
	rateLimitResponses: 0,
	quotaExceededResponses: 0
};

// A cache hit is counted only when a caller successfully receives a settled cached result or a
// successfully coalesced in-flight result. Failed or cancelled coalesced callers are not hits.
export const getSpotifySessionMetrics = (): SpotifySessionMetrics => ({ ...spotifySessionMetrics });

export class SpotifyRateLimitError extends Error {
	readonly retryAfterSeconds: number;
	readonly reason: SpotifyRateLimitReason;

	constructor(retryAfterSeconds: number, reason: SpotifyRateLimitReason = 'rate-limited') {
		super('Spotify rate limit reached');
		this.name = 'SpotifyRateLimitError';
		this.retryAfterSeconds = retryAfterSeconds;
		this.reason = reason;
	}
}

export class SpotifyResponseValidationError extends Error {
	constructor() {
		super('Spotify search returned an invalid response');
		this.name = 'SpotifyResponseValidationError';
	}
}

export type SpotifySearchUnavailableReason =
	| 'authentication'
	| 'request-rejected'
	| 'upstream'
	| 'invalid-json'
	| 'network'
	| 'timeout'
	| 'unexpected';

const SPOTIFY_SEARCH_UNAVAILABLE_REASONS = new Set<SpotifySearchUnavailableReason>([
	'authentication',
	'request-rejected',
	'upstream',
	'invalid-json',
	'network',
	'timeout',
	'unexpected'
]);

const isSpotifySearchUnavailableReason = (
	value: unknown
): value is SpotifySearchUnavailableReason =>
	typeof value === 'string' &&
	SPOTIFY_SEARCH_UNAVAILABLE_REASONS.has(value as SpotifySearchUnavailableReason);

export const isSpotifyRequestRejectedStatus = (value: unknown): value is number =>
	typeof value === 'number' &&
	Number.isSafeInteger(value) &&
	value >= 400 &&
	value <= 499 &&
	value !== 401 &&
	value !== 403 &&
	value !== 429;

type SpotifySearchUnavailableShape =
	| {
			name: 'SpotifySearchUnavailableError';
			reason: 'request-rejected';
			upstreamStatus: number;
	  }
	| {
			name: 'SpotifySearchUnavailableError';
			reason: Exclude<SpotifySearchUnavailableReason, 'request-rejected'>;
			upstreamStatus?: never;
	  };

type ObservedSpotifyHttpFailure =
	| { reason: 'request-rejected'; upstreamStatus: number }
	| {
			reason: Exclude<SpotifySearchUnavailableReason, 'request-rejected'>;
	  };

export class SpotifySearchUnavailableError extends Error {
	readonly reason: SpotifySearchUnavailableReason;
	declare readonly upstreamStatus?: number;

	constructor(reason: Exclude<SpotifySearchUnavailableReason, 'request-rejected'>);
	constructor(reason: 'request-rejected', upstreamStatus: number);
	constructor(reason: SpotifySearchUnavailableReason, upstreamStatus?: number) {
		super('Spotify search is unavailable');
		this.name = 'SpotifySearchUnavailableError';
		this.reason = reason;
		if (reason === 'request-rejected') {
			if (!isSpotifyRequestRejectedStatus(upstreamStatus)) {
				throw new TypeError('Invalid Spotify request-rejected status');
			}
			this.upstreamStatus = upstreamStatus;
		}
	}
}

export const isSpotifySearchUnavailableError = (
	cause: unknown
): cause is SpotifySearchUnavailableShape => {
	if (!cause || typeof cause !== 'object') return false;
	const candidate = cause as Record<string, unknown>;
	if (
		candidate.name !== 'SpotifySearchUnavailableError' ||
		!isSpotifySearchUnavailableReason(candidate.reason)
	) {
		return false;
	}
	return candidate.reason === 'request-rejected'
		? isSpotifyRequestRejectedStatus(candidate.upstreamStatus)
		: candidate.upstreamStatus === undefined;
};

export const isSpotifyResponseValidationError = (
	cause: unknown
): cause is { name: 'SpotifyResponseValidationError' } =>
	Boolean(
		cause &&
		typeof cause === 'object' &&
		(cause as Record<string, unknown>).name === 'SpotifyResponseValidationError'
	);

export const isSpotifyRateLimitError = (
	cause: unknown
): cause is {
	name: 'SpotifyRateLimitError';
	retryAfterSeconds: number;
	reason?: SpotifyRateLimitReason;
} => {
	if (!cause || typeof cause !== 'object') return false;
	const candidate = cause as Record<string, unknown>;
	return (
		candidate.name === 'SpotifyRateLimitError' &&
		isSafeRetryAfterSeconds(candidate.retryAfterSeconds) &&
		(candidate.reason === undefined ||
			candidate.reason === 'quota-exceeded' ||
			candidate.reason === 'rate-limited')
	);
};

export const getSpotifyRateLimitReason = (cause: {
	reason?: SpotifyRateLimitReason;
}): SpotifyRateLimitReason =>
	cause.reason === 'quota-exceeded' ? 'quota-exceeded' : 'rate-limited';

export const parseSpotifyRateLimitReason = (payload: unknown): SpotifyRateLimitReason => {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'rate-limited';
	const error = (payload as Record<string, unknown>).error;
	if (!error || typeof error !== 'object' || Array.isArray(error)) return 'rate-limited';
	return (error as Record<string, unknown>).reason === 'QUOTA_EXCEEDED'
		? 'quota-exceeded'
		: 'rate-limited';
};

export const parseRetryAfter = (value: string | null, now = Date.now()) => {
	if (!value) return DEFAULT_RETRY_AFTER_SECONDS;

	const seconds = /^\d+$/.test(value.trim())
		? Number(value)
		: Math.ceil((Date.parse(value) - now) / 1000);
	return isSafeRetryAfterSeconds(seconds, now) ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
};

type QueueItem<T> = {
	task: () => Promise<T>;
	signal?: AbortSignal;
	resolve: (value: T) => void;
	reject: (cause: unknown) => void;
	cancelled: boolean;
	onAbort?: () => void;
};

class SpotifySearchQueue {
	private items: QueueItem<unknown>[] = [];
	private running = false;
	private nextStartAt = 0;
	private blockedUntil = 0;
	private blockedReason: SpotifyRateLimitReason = 'rate-limited';

	setCooldown(seconds: number, reason: SpotifyRateLimitReason) {
		const now = Date.now();
		const safeSeconds = isSafeRetryAfterSeconds(seconds, now)
			? seconds
			: DEFAULT_RETRY_AFTER_SECONDS;
		const nextBlockedUntil = now + safeSeconds * 1000;
		if (nextBlockedUntil >= this.blockedUntil) {
			this.blockedUntil = nextBlockedUntil;
			this.blockedReason = reason;
		}
		return safeSeconds;
	}

	private cooldownError() {
		const remainingMs = this.blockedUntil - Date.now();
		return remainingMs > 0
			? new SpotifyRateLimitError(Math.max(1, Math.ceil(remainingMs / 1000)), this.blockedReason)
			: null;
	}

	resetForTests() {
		this.items = [];
		this.running = false;
		this.nextStartAt = 0;
		this.blockedUntil = 0;
		this.blockedReason = 'rate-limited';
	}

	enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (signal?.aborted) {
				reject(createAbortError());
				return;
			}
			const cooldownError = this.cooldownError();
			if (cooldownError) {
				reject(cooldownError);
				return;
			}

			const item: QueueItem<T> = { task, signal, resolve, reject, cancelled: false };
			item.onAbort = () => {
				item.cancelled = true;
				reject(createAbortError());
			};
			signal?.addEventListener('abort', item.onAbort, { once: true });
			this.items.push(item as QueueItem<unknown>);
			void this.drain();
		});
	}

	private async drain() {
		if (this.running) return;
		const item = this.items.shift();
		if (!item) return;
		if (item.cancelled) {
			item.signal?.removeEventListener('abort', item.onAbort as () => void);
			void this.drain();
			return;
		}

		this.running = true;
		try {
			const queuedCooldownError = this.cooldownError();
			if (queuedCooldownError) throw queuedCooldownError;

			const pacingDelayMs = Math.max(0, this.nextStartAt - Date.now());
			if (pacingDelayMs > 0) await abortableDelay(pacingDelayMs, item.signal);

			throwIfAborted(item.signal);
			const dispatchCooldownError = this.cooldownError();
			if (dispatchCooldownError) throw dispatchCooldownError;
			this.nextStartAt = Date.now() + SPOTIFY_SEARCH_INTERVAL_MS;
			item.resolve(await item.task());
		} catch (cause) {
			item.reject(cause);
		} finally {
			item.signal?.removeEventListener('abort', item.onAbort as () => void);
			this.running = false;
			void this.drain();
		}
	}
}

const spotifySearchQueue = new SpotifySearchQueue();

const DO_NOT_CACHE = Symbol('do-not-cache-spotify-match');
type SpotifyMatchCacheValue = MatchedTrack & { [DO_NOT_CACHE]?: true };

const preventSpotifyMatchCaching = (track: MatchedTrack): SpotifyMatchCacheValue => {
	Object.defineProperty(track, DO_NOT_CACHE, { value: true });
	return track;
};

const cloneMatchedTrack = (track: MatchedTrack): MatchedTrack => ({
	...track,
	matches: track.matches.map((match) => ({ ...match }))
});

type CacheEntry = { value: MatchedTrack; expiresAt: number };
type InFlightSearch = {
	key: string;
	promise: Promise<MatchedTrack>;
	controller: AbortController;
	subscribers: number;
	settled: boolean;
};

export class SpotifySearchSessionCache {
	private entries = new Map<string, CacheEntry>();
	private inFlight = new Map<string, InFlightSearch>();

	constructor(
		private readonly maxEntries = SPOTIFY_SEARCH_CACHE_MAX_ENTRIES,
		private readonly ttlMs = SPOTIFY_SEARCH_CACHE_TTL_MS,
		private readonly now: () => number = Date.now,
		private readonly onHit: () => void = () => undefined
	) {}

	private pruneExpired() {
		const now = this.now();
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key);
		}
	}

	private store(key: string, value: MatchedTrack) {
		this.pruneExpired();
		this.entries.delete(key);
		while (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value as string | undefined;
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
		this.entries.set(key, { value: cloneMatchedTrack(value), expiresAt: this.now() + this.ttlMs });
	}

	private waitForOperation(
		operation: InFlightSearch,
		signal?: AbortSignal,
		countAsCoalescedHit = false
	) {
		throwIfAborted(signal);
		operation.subscribers += 1;
		return new Promise<MatchedTrack>((resolve, reject) => {
			let finished = false;
			const finish = () => {
				if (finished) return false;
				finished = true;
				signal?.removeEventListener('abort', onAbort);
				operation.subscribers -= 1;
				if (!operation.settled && operation.subscribers === 0) {
					if (this.inFlight.get(operation.key) === operation) {
						this.inFlight.delete(operation.key);
					}
					operation.controller.abort();
				}
				return true;
			};
			const onAbort = () => {
				if (finish()) reject(createAbortError());
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			operation.promise.then(
				(value) => {
					if (finish()) {
						if (countAsCoalescedHit) this.onHit();
						resolve(cloneMatchedTrack(value));
					}
				},
				(cause) => {
					if (finish()) reject(cause);
				}
			);
		});
	}

	getOrCreate(
		key: string,
		load: (signal: AbortSignal) => Promise<MatchedTrack>,
		signal?: AbortSignal
	): Promise<MatchedTrack> {
		throwIfAborted(signal);
		this.pruneExpired();
		const cached = this.entries.get(key);
		if (cached) {
			this.onHit();
			return Promise.resolve(cloneMatchedTrack(cached.value));
		}

		let operation = this.inFlight.get(key);
		if (operation) {
			return this.waitForOperation(operation, signal, true);
		}

		const controller = new AbortController();
		operation = {
			key,
			controller,
			subscribers: 0,
			settled: false,
			promise: Promise.resolve(undefined as never)
		};
		const currentOperation = operation;
		currentOperation.promise = load(controller.signal)
			.then((value) => {
				if (!(value as SpotifyMatchCacheValue)[DO_NOT_CACHE]) this.store(key, value);
				return value;
			})
			.finally(() => {
				currentOperation.settled = true;
				if (this.inFlight.get(key) === currentOperation) this.inFlight.delete(key);
			});
		this.inFlight.set(key, currentOperation);
		return this.waitForOperation(currentOperation, signal);
	}

	clear() {
		for (const operation of this.inFlight.values()) operation.controller.abort();
		this.inFlight.clear();
		this.entries.clear();
	}
}

const spotifySearchCache = new SpotifySearchSessionCache(
	SPOTIFY_SEARCH_CACHE_MAX_ENTRIES,
	SPOTIFY_SEARCH_CACHE_TTL_MS,
	Date.now,
	() => {
		spotifySessionMetrics.cacheHits += 1;
	}
);

export const normalizeSpotifySearchKeyPart = (value: string) =>
	value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');

export const createSpotifySearchCacheKey = (
	track: BasicTrack,
	matcherVersion: number,
	market?: string
) =>
	[
		String(matcherVersion),
		normalizeSpotifySearchKeyPart(market || ''),
		normalizeSpotifySearchKeyPart(track.artist),
		normalizeSpotifySearchKeyPart(track.title)
	].join('\u0000');

export const getClientCredentials = async (request: Fetcher = fetch, signal?: AbortSignal) => {
	const configuration = getSpotifyConfiguration();
	if (!configuration) return null;
	if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

	const data = await requestSpotifyToken(
		request,
		configuration,
		new URLSearchParams({ grant_type: 'client_credentials' }),
		{ requireRefreshToken: false, signal }
	);

	cachedToken = {
		value: data.accessToken,
		expiresAt: Date.now() + Math.max(0, data.expiresIn - 60) * 1000
	};
	return cachedToken.value;
};

const normalize = (value: string) =>
	value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/&/g, 'and')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

const isConfidentMatch = (track: BasicTrack, match: Match) => {
	if (normalize(track.title) !== normalize(match.title)) return false;
	const requestedArtist = normalize(track.artist);
	return match.artist
		.split(',')
		.map(normalize)
		.some(
			(artist) =>
				artist === requestedArtist ||
				(requestedArtist.length >= 5 &&
					(artist.includes(requestedArtist) || requestedArtist.includes(artist)))
		);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

type ParsedSpotifySearchResult = {
	matches: Match[];
	skippedCandidates: number;
	adjustedCandidates: number;
};

const SPOTIFY_TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;

const safeOptionalHttpsUrl = (value: unknown) => {
	if (typeof value !== 'string') return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? value : undefined;
	} catch {
		return undefined;
	}
};

type ParsedSpotifyCandidate = { match: Match; adjusted: boolean };

const parseSpotifyCandidate = (value: unknown): ParsedSpotifyCandidate | null => {
	if (!isRecord(value) || typeof value.name !== 'string' || typeof value.uri !== 'string') {
		return null;
	}
	const uriMatch = SPOTIFY_TRACK_URI.exec(value.uri);
	if (!uriMatch || !Array.isArray(value.artists)) return null;
	let adjusted = false;
	const artists = value.artists.flatMap((artist) => {
		if (!isRecord(artist) || typeof artist.name !== 'string') {
			adjusted = true;
			return [];
		}
		return [artist.name];
	});
	if (artists.length === 0) return null;

	let cover: string | undefined;
	if (value.album !== undefined && value.album !== null) {
		if (!isRecord(value.album)) adjusted = true;
		else if (value.album.images !== undefined && value.album.images !== null) {
			if (!Array.isArray(value.album.images)) adjusted = true;
			else {
				for (const image of value.album.images) {
					const imageUrl = isRecord(image) ? parseOfficialSpotifyArtworkUrl(image.url) : undefined;
					if (!imageUrl) adjusted = true;
					else if (!cover) cover = imageUrl;
				}
			}
		}
	}

	let preview: string | undefined;
	if (value.preview_url !== undefined && value.preview_url !== null) {
		preview = safeOptionalHttpsUrl(value.preview_url);
		if (!preview) adjusted = true;
	}

	const href = `https://open.spotify.com/track/${uriMatch[1]}`;
	if (value.external_urls !== undefined && value.external_urls !== null) {
		if (!isRecord(value.external_urls) || value.external_urls.spotify !== href) adjusted = true;
	}

	return {
		adjusted,
		match: {
			artist: artists.join(', '),
			title: value.name,
			uri: value.uri,
			preview,
			cover,
			href
		}
	};
};

export const parseSpotifyTrackSearchResult = (value: unknown): ParsedSpotifySearchResult => {
	if (!isRecord(value) || !isRecord(value.tracks) || !Array.isArray(value.tracks.items)) {
		throw new SpotifyResponseValidationError();
	}
	const candidates = value.tracks.items
		.map(parseSpotifyCandidate)
		.filter((candidate): candidate is ParsedSpotifyCandidate => candidate !== null);
	const matches = candidates.map(({ match }) => match);
	const skippedCandidates = value.tracks.items.length - candidates.length;
	const adjustedCandidates = candidates.filter(({ adjusted }) => adjusted).length;
	if (value.tracks.items.length > 0 && matches.length === 0) {
		throw new SpotifyResponseValidationError();
	}
	return { matches, skippedCandidates, adjustedCandidates };
};

const requestSpotifySearchAttempt = async (
	url: string,
	token: string,
	request: Fetcher,
	isRetry: boolean,
	signal?: AbortSignal
) =>
	spotifySearchQueue.enqueue(async () => {
		spotifySessionMetrics.searchRequests += 1;
		if (isRetry) spotifySessionMetrics.transientRetries += 1;
		let observedRateLimitSeconds: number | undefined;
		let observedHttpFailure: ObservedSpotifyHttpFailure | undefined;
		const rateLimitError = (reason: SpotifyRateLimitReason) => {
			const safeRetryAfterSeconds = spotifySearchQueue.setCooldown(
				observedRateLimitSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
				reason
			);
			if (reason === 'quota-exceeded') spotifySessionMetrics.quotaExceededResponses += 1;
			else spotifySessionMetrics.rateLimitResponses += 1;
			return new SpotifyRateLimitError(safeRetryAfterSeconds, reason);
		};
		const httpFailureError = (failure: ObservedSpotifyHttpFailure) =>
			failure.reason === 'request-rejected'
				? new SpotifySearchUnavailableError('request-rejected', failure.upstreamStatus)
				: new SpotifySearchUnavailableError(failure.reason);
		try {
			return await fetchWithTimeout(
				request,
				url,
				{ headers: { Authorization: `Bearer ${token}` } },
				SEARCH_TIMEOUT_MS,
				async (response) => {
					if (response.status === 429) {
						observedRateLimitSeconds = parseRetryAfter(response.headers.get('Retry-After'));
						let payload: unknown = null;
						try {
							payload = await response.json();
						} catch (cause) {
							if (isAbortError(cause)) throw cause;
						}
						const reason = parseSpotifyRateLimitReason(payload);
						throw rateLimitError(reason);
					}
					if (!response.ok) {
						observedHttpFailure = isSpotifyRequestRejectedStatus(response.status)
							? { reason: 'request-rejected', upstreamStatus: response.status }
							: {
									reason:
										response.status === 401 || response.status === 403
											? 'authentication'
											: response.status >= 500
												? 'upstream'
												: 'unexpected'
								};
						await response.body?.cancel().catch(() => undefined);
						throw httpFailureError(observedHttpFailure);
					}

					let payload: unknown;
					try {
						payload = await response.json();
					} catch (cause) {
						if (isAbortError(cause)) throw cause;
						if (cause instanceof SyntaxError) {
							throw new SpotifySearchUnavailableError('invalid-json');
						}
						throw cause;
					}
					return parseSpotifyTrackSearchResult(payload);
				},
				signal
			);
		} catch (cause) {
			if (
				isSpotifyRateLimitError(cause) ||
				isSpotifyResponseValidationError(cause) ||
				isSpotifySearchUnavailableError(cause) ||
				isAbortError(cause)
			) {
				throw cause;
			}
			if (observedRateLimitSeconds !== undefined) throw rateLimitError('rate-limited');
			if (observedHttpFailure) throw httpFailureError(observedHttpFailure);
			if (cause instanceof RequestTimeoutError) {
				throw new SpotifySearchUnavailableError('timeout');
			}
			if (cause instanceof TypeError) {
				throw new SpotifySearchUnavailableError('network');
			}
			throw new SpotifySearchUnavailableError('unexpected');
		}
	}, signal);

const TRANSIENT_SPOTIFY_SEARCH_REASONS = new Set<SpotifySearchUnavailableReason>([
	'upstream',
	'invalid-json',
	'network',
	'timeout'
]);

const requestSpotifySearch = async (
	url: string,
	token: string,
	request: Fetcher,
	signal?: AbortSignal
) => {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await requestSpotifySearchAttempt(url, token, request, attempt > 0, signal);
		} catch (cause) {
			if (
				!isSpotifySearchUnavailableError(cause) ||
				!TRANSIENT_SPOTIFY_SEARCH_REASONS.has(cause.reason) ||
				attempt >= SPOTIFY_TRANSIENT_RETRY_DELAYS_MS.length
			) {
				throw cause;
			}
			await abortableDelay(SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[attempt], signal);
		}
	}
};

const performSpotifyTrackSearch = async (
	track: BasicTrack,
	token: string,
	request: Fetcher,
	signal: AbortSignal
): Promise<MatchedTrack> => {
	let cacheable = true;
	for (const fallback of [false, true]) {
		throwIfAborted(signal);
		let url = `https://api.spotify.com/v1/search?type=track&limit=10&q=track:${encodeURIComponent(
			track.title
		)}`;
		if (!fallback) url += `%20artist:${encodeURIComponent(track.artist)}`;

		let result: Awaited<ReturnType<typeof requestSpotifySearch>>;
		try {
			result = await requestSpotifySearch(url, token, request, signal);
		} catch (cause) {
			if (
				!fallback &&
				isSpotifySearchUnavailableError(cause) &&
				cause.reason === 'request-rejected' &&
				cause.upstreamStatus === 400
			) {
				cacheable = false;
				continue;
			}
			throw cause;
		}
		const matches = result.matches;
		if (result.skippedCandidates > 0 || result.adjustedCandidates > 0) cacheable = false;

		if (matches.length === 0 && !fallback) continue;

		const matchedTrack: MatchedTrack = {
			...track,
			matches,
			fallback,
			confident: !fallback && matches.length > 0 && isConfidentMatch(track, matches[0])
		};
		return cacheable ? matchedTrack : preventSpotifyMatchCaching(matchedTrack);
	}

	throw new Error('Spotify search did not produce a result');
};

export const searchSpotifyTrack = async (
	track: BasicTrack,
	token: string,
	request: Fetcher = fetch,
	signal?: AbortSignal
): Promise<MatchedTrack> => {
	// Searches currently use application credentials and do not send a market. The key helper keeps
	// an explicit market dimension for a future market-aware caller to thread through.
	const result = await spotifySearchCache.getOrCreate(
		createSpotifySearchCacheKey(track, SPOTIFY_MATCHER_VERSION),
		(sharedSignal) => performSpotifyTrackSearch(track, token, request, sharedSignal),
		signal
	);
	return { ...result, artist: track.artist, title: track.title };
};

export const resetSpotifyServerSessionForTests = () => {
	cachedToken = null;
	spotifySearchCache.clear();
	spotifySearchQueue.resetForTests();
	spotifySessionMetrics.searchRequests = 0;
	spotifySessionMetrics.cacheHits = 0;
	spotifySessionMetrics.transientRetries = 0;
	spotifySessionMetrics.rateLimitResponses = 0;
	spotifySessionMetrics.quotaExceededResponses = 0;
};

export const mapWithConcurrency = async <T, R>(
	items: T[],
	limit: number,
	mapper: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	parentSignal?: AbortSignal
): Promise<R[]> => {
	const controller = new AbortController();
	const onParentAbort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let firstError: unknown;

	const worker = async () => {
		try {
			while (!controller.signal.aborted && nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await mapper(items[index], index, controller.signal);
			}
		} catch (cause) {
			if (firstError === undefined) firstError = cause;
			controller.abort();
		}
	};

	const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
	await Promise.all(workers);
	parentSignal?.removeEventListener('abort', onParentAbort);

	if (firstError !== undefined) throw firstError;
	throwIfAborted(parentSignal);
	return results;
};
