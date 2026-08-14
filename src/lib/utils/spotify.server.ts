import { env } from '$env/dynamic/private';
import type { BasicTrack, Match, MatchedTrack, SpotifyTrackSearchResult } from '$lib/types';
import { abortableDelay, createAbortError, throwIfAborted } from './abort';
import { fetchWithTimeout, type Fetcher } from './request';

const TOKEN_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
export const SPOTIFY_SEARCH_INTERVAL_MS = 750;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

let cachedToken: { value: string; expiresAt: number } | null = null;

export class SpotifyRateLimitError extends Error {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super('Spotify rate limit reached');
		this.name = 'SpotifyRateLimitError';
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export const isSpotifyRateLimitError = (
	cause: unknown
): cause is { name: 'SpotifyRateLimitError'; retryAfterSeconds: number } => {
	if (!cause || typeof cause !== 'object') return false;
	const candidate = cause as Record<string, unknown>;
	return (
		candidate.name === 'SpotifyRateLimitError' &&
		typeof candidate.retryAfterSeconds === 'number' &&
		Number.isSafeInteger(candidate.retryAfterSeconds) &&
		candidate.retryAfterSeconds > 0
	);
};

export const parseRetryAfter = (value: string | null, now = Date.now()) => {
	if (!value) return DEFAULT_RETRY_AFTER_SECONDS;

	const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
		? Number(value)
		: (Date.parse(value) - now) / 1000;
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_SECONDS;

	return Math.max(1, Math.ceil(seconds));
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

	setCooldown(seconds: number) {
		this.blockedUntil = Math.max(this.blockedUntil, Date.now() + seconds * 1000);
	}

	private cooldownError() {
		const remainingMs = this.blockedUntil - Date.now();
		return remainingMs > 0
			? new SpotifyRateLimitError(Math.max(1, Math.ceil(remainingMs / 1000)))
			: null;
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

export const getClientCredentials = async (request: Fetcher = fetch, signal?: AbortSignal) => {
	if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
	if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;

	const data = await fetchWithTimeout(
		request,
		'https://accounts.spotify.com/api/token',
		{
			method: 'POST',
			body: new URLSearchParams({ grant_type: 'client_credentials' }),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${Buffer.from(
					`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
				).toString('base64')}`
			}
		},
		TOKEN_TIMEOUT_MS,
		async (response) => {
			if (!response.ok) {
				await response.body?.cancel();
				return null;
			}
			return (await response.json()) as { access_token: string; expires_in: number };
		},
		signal
	);

	if (!data) return null;
	cachedToken = {
		value: data.access_token,
		expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000
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

const requestSpotifySearch = async (
	url: string,
	token: string,
	request: Fetcher,
	signal?: AbortSignal
) =>
	spotifySearchQueue.enqueue(
		() =>
			fetchWithTimeout(
				request,
				url,
				{ headers: { Authorization: `Bearer ${token}` } },
				SEARCH_TIMEOUT_MS,
				async (response) => {
					if (response.status === 429) {
						const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
						spotifySearchQueue.setCooldown(retryAfterSeconds);
						await response.body?.cancel();
						throw new SpotifyRateLimitError(retryAfterSeconds);
					}
					if (!response.ok) {
						await response.body?.cancel();
						throw new Error(`Spotify search failed (${response.status})`);
					}

					return (await response.json()) as SpotifyTrackSearchResult;
				},
				signal
			),
		signal
	);

export const searchSpotifyTrack = async (
	track: BasicTrack,
	token: string,
	request: Fetcher = fetch,
	signal?: AbortSignal
): Promise<MatchedTrack> => {
	for (const fallback of [false, true]) {
		throwIfAborted(signal);
		let url = `https://api.spotify.com/v1/search?type=track&limit=10&q=track:${encodeURIComponent(
			track.title
		)}`;
		if (!fallback) url += `%20artist:${encodeURIComponent(track.artist)}`;

		const result = await requestSpotifySearch(url, token, request, signal);
		const matches = (result.tracks?.items || []).map<Match>((item) => ({
			artist: item.artists.map(({ name }) => name).join(', '),
			title: item.name,
			uri: item.uri,
			preview: item.preview_url || undefined,
			cover: item.album.images[0]?.url,
			href: item.external_urls.spotify
		}));

		if (matches.length === 0 && !fallback) continue;

		return {
			...track,
			matches,
			fallback,
			confident: !fallback && matches.length > 0 && isConfidentMatch(track, matches[0])
		};
	}

	throw new Error('Spotify search did not produce a result');
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
