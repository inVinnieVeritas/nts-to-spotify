import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAccessToken } from '$lib/utils/auth.server';
import {
	isSafeRetryAfterSeconds,
	isSpotifyPlaylistId,
	spotifyPlaylistUrl,
	uniqueSpotifyUris
} from '$lib/utils/catalog-scan';
import {
	createAbortError,
	createAbortScope,
	isAbortError,
	RequestTimeoutError,
	throwIfAborted
} from '$lib/utils/abort';
import { fetchWithTimeout } from '$lib/utils/request';

const SPOTIFY_PLAYLIST_TIMEOUT_MS = 20_000;
const SPOTIFY_PLAYLIST_ROUTE_TIMEOUT_MS = 5 * 60 * 1000;
export const SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const SPOTIFY_PLAYLIST_MAX_TRACKS = 10_000;
const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

type PlaylistSyncRequest = {
	operation: 'sync';
	name: string;
	description: string;
	tracks: string[];
	public: boolean;
	playlistId?: string;
};

type PlaylistVerifyRequest = { operation: 'verify'; playlistId: string };
type PlaylistRequest = PlaylistSyncRequest | PlaylistVerifyRequest;

type SpotifyPlaylistFailureCategory =
	| 'authentication'
	| 'rate-limit'
	| 'not-found'
	| 'inaccessible'
	| 'ownership'
	| 'request-rejected'
	| 'upstream'
	| 'invalid-response'
	| 'network'
	| 'timeout';

class SpotifyPlaylistFailure extends Error {
	constructor(
		readonly category: SpotifyPlaylistFailureCategory,
		readonly retryAfterSeconds?: number
	) {
		super('Spotify playlist operation failed');
		this.name = 'SpotifyPlaylistFailure';
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

const parseRetryAfter = (value: string | null) => {
	const source = value?.trim() ?? '';
	const seconds = /^\d+$/.test(source) ? Number(source) : Number.NaN;
	return isSafeRetryAfterSeconds(seconds) ? seconds : 1;
};

const readChunk = <T>(reader: ReadableStreamDefaultReader<T>, signal: AbortSignal) =>
	new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
		throwIfAborted(signal);
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = () => {
			void reader.cancel().catch(() => undefined);
			finish(() => reject(createAbortError()));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		reader.read().then(
			(result) => finish(() => resolve(result)),
			(cause) => finish(() => reject(cause))
		);
	});

export const readBoundedPlaylistRequestBody = async (request: Request, signal: AbortSignal) => {
	const declaredLengthHeader = request.headers.get('Content-Length');
	if (declaredLengthHeader && /^\d+$/.test(declaredLengthHeader.trim())) {
		const declaredLength = Number(declaredLengthHeader);
		if (
			!Number.isSafeInteger(declaredLength) ||
			declaredLength > SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES
		) {
			throw new SpotifyPlaylistFailure('request-rejected');
		}
	}
	if (!request.body) throw new SpotifyPlaylistFailure('request-rejected');

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await readChunk(reader, signal);
			if (done) break;
			total += value.byteLength;
			if (total > SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new SpotifyPlaylistFailure('request-rejected');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new SpotifyPlaylistFailure('request-rejected');
	}
};

const parseRequest = async (request: Request, signal: AbortSignal): Promise<PlaylistRequest> => {
	let value: unknown;
	try {
		value = JSON.parse(await readBoundedPlaylistRequestBody(request, signal));
	} catch (cause) {
		if (cause instanceof SpotifyPlaylistFailure || isAbortError(cause)) throw cause;
		throw new SpotifyPlaylistFailure('request-rejected');
	}
	if (!isRecord(value)) throw new SpotifyPlaylistFailure('request-rejected');

	if (value.operation === 'verify') {
		if (!isSpotifyPlaylistId(value.playlistId)) {
			throw new SpotifyPlaylistFailure('request-rejected');
		}
		return { operation: 'verify', playlistId: value.playlistId };
	}

	const name = typeof value.name === 'string' ? value.name.trim() : '';
	const description = value.description;
	const tracks = value.tracks;
	const isPublic = value.public === undefined ? true : value.public;
	const playlistId = value.playlistId;
	if (
		name.length === 0 ||
		name.length > 100 ||
		typeof description !== 'string' ||
		description.length > 300 ||
		typeof isPublic !== 'boolean' ||
		!Array.isArray(tracks) ||
		tracks.length > SPOTIFY_PLAYLIST_MAX_TRACKS ||
		!tracks.every((track) => typeof track === 'string' && SPOTIFY_TRACK_URI.test(track)) ||
		(playlistId !== undefined && !isSpotifyPlaylistId(playlistId))
	) {
		throw new SpotifyPlaylistFailure('request-rejected');
	}

	return {
		operation: 'sync',
		name,
		description,
		tracks: uniqueSpotifyUris(tracks as string[]),
		public: isPublic,
		...(playlistId ? { playlistId } : {})
	};
};

const requestSpotify = async (
	request: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit,
	parentSignal: AbortSignal,
	options: { json?: boolean; notFound?: boolean; inaccessible?: boolean } = {}
) => {
	try {
		return await fetchWithTimeout(
			request,
			input,
			init,
			SPOTIFY_PLAYLIST_TIMEOUT_MS,
			async (response) => {
				if (response.status === 429) {
					const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
					await response.body?.cancel().catch(() => undefined);
					throw new SpotifyPlaylistFailure('rate-limit', retryAfterSeconds);
				}
				if (!response.ok) {
					const category: SpotifyPlaylistFailureCategory =
						response.status === 401
							? 'authentication'
							: response.status === 403 && options.inaccessible
							? 'inaccessible'
							: response.status === 403
							? 'authentication'
							: response.status === 404 && options.notFound
							? 'not-found'
							: response.status >= 500
							? 'upstream'
							: 'request-rejected';
					await response.body?.cancel().catch(() => undefined);
					throw new SpotifyPlaylistFailure(category);
				}
				if (!options.json) {
					await response.body?.cancel().catch(() => undefined);
					return null;
				}
				try {
					return await response.json();
				} catch (cause) {
					if (isAbortError(cause)) throw cause;
					throw new SpotifyPlaylistFailure('invalid-response');
				}
			},
			parentSignal
		);
	} catch (cause) {
		if (cause instanceof SpotifyPlaylistFailure || isAbortError(cause)) throw cause;
		if (cause instanceof RequestTimeoutError) throw new SpotifyPlaylistFailure('timeout');
		if (cause instanceof TypeError) throw new SpotifyPlaylistFailure('network');
		throw new SpotifyPlaylistFailure('invalid-response');
	}
};

const safeErrorResponse = (
	failure: SpotifyPlaylistFailure,
	mutationStarted: boolean,
	linkedPlaylistId?: string,
	creationOutcomeUnknown = false
) => {
	if (creationOutcomeUnknown) {
		return json({ error: 'playlist_creation_unknown' }, { status: 503 });
	}
	if (failure.category === 'rate-limit') {
		const retryAfterSeconds = failure.retryAfterSeconds ?? 1;
		return json(
			{
				error: 'spotify_rate_limited',
				retryAfterSeconds,
				...(mutationStarted ? { incomplete: true } : {}),
				...(mutationStarted && linkedPlaylistId && isSpotifyPlaylistId(linkedPlaylistId)
					? { playlistId: linkedPlaylistId, url: spotifyPlaylistUrl(linkedPlaylistId) }
					: {})
			},
			{ status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
		);
	}
	if (failure.category === 'authentication') {
		return json(
			{
				error: 'spotify_authentication',
				...(mutationStarted ? { incomplete: true } : {}),
				...(mutationStarted && linkedPlaylistId && isSpotifyPlaylistId(linkedPlaylistId)
					? { playlistId: linkedPlaylistId, url: spotifyPlaylistUrl(linkedPlaylistId) }
					: {})
			},
			{ status: 401 }
		);
	}
	if (failure.category === 'ownership')
		return json({ error: 'playlist_not_owned' }, { status: 403 });
	if (failure.category === 'not-found') {
		return json(
			{
				error: 'playlist_not_found',
				...(mutationStarted ? { incomplete: true } : {}),
				...(mutationStarted && linkedPlaylistId && isSpotifyPlaylistId(linkedPlaylistId)
					? { playlistId: linkedPlaylistId, url: spotifyPlaylistUrl(linkedPlaylistId) }
					: {})
			},
			{ status: 404 }
		);
	}
	if (failure.category === 'inaccessible') {
		return json({ error: 'playlist_inaccessible' }, { status: 403 });
	}
	if (failure.category === 'request-rejected' && !mutationStarted) {
		return json({ error: 'invalid_request' }, { status: 400 });
	}
	if (mutationStarted) {
		return json(
			{
				error: 'playlist_sync_incomplete',
				incomplete: true,
				...(linkedPlaylistId && isSpotifyPlaylistId(linkedPlaylistId)
					? { playlistId: linkedPlaylistId, url: spotifyPlaylistUrl(linkedPlaylistId) }
					: {})
			},
			{ status: 503 }
		);
	}
	return json({ error: 'spotify_unavailable' }, { status: 503 });
};

const verifyOwnership = async (
	event: Parameters<RequestHandler>[0],
	headers: Record<string, string>,
	userId: string,
	playlistId: string,
	signal: AbortSignal
) => {
	const playlistValue = await requestSpotify(
		event.fetch,
		`https://api.spotify.com/v1/playlists/${playlistId}?fields=id,owner(id)`,
		{ headers },
		signal,
		{ json: true, notFound: true, inaccessible: true }
	);
	if (
		!isRecord(playlistValue) ||
		playlistValue.id !== playlistId ||
		!isRecord(playlistValue.owner) ||
		typeof playlistValue.owner.id !== 'string'
	) {
		throw new SpotifyPlaylistFailure('invalid-response');
	}
	if (playlistValue.owner.id !== userId) throw new SpotifyPlaylistFailure('ownership');
};

const handlePlaylistRequest = async (event: Parameters<RequestHandler>[0], signal: AbortSignal) => {
	let payload: PlaylistRequest;
	try {
		payload = await parseRequest(event.request, signal);
	} catch (cause) {
		if (isAbortError(cause)) return safeErrorResponse(new SpotifyPlaylistFailure('timeout'), false);
		return safeErrorResponse(
			cause instanceof SpotifyPlaylistFailure
				? cause
				: new SpotifyPlaylistFailure('request-rejected'),
			false
		);
	}

	let token: string | null;
	try {
		token = await getAccessToken(event);
	} catch {
		return safeErrorResponse(new SpotifyPlaylistFailure('authentication'), false);
	}
	if (!token) return safeErrorResponse(new SpotifyPlaylistFailure('authentication'), false);
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`
	};
	let mutationStarted = false;
	let creationDispatched = false;
	let linkedPlaylistId = payload.playlistId;
	let mode: 'created' | 'updated' = payload.playlistId ? 'updated' : 'created';

	try {
		const profileValue = await requestSpotify(
			event.fetch,
			'https://api.spotify.com/v1/me',
			{ headers },
			signal,
			{ json: true }
		);
		if (!isRecord(profileValue) || typeof profileValue.id !== 'string' || !profileValue.id) {
			throw new SpotifyPlaylistFailure('invalid-response');
		}
		const userId = profileValue.id;

		if (payload.operation === 'verify') {
			await verifyOwnership(event, headers, userId, payload.playlistId, signal);
			return json({
				playlistId: payload.playlistId,
				url: spotifyPlaylistUrl(payload.playlistId),
				mode: 'verified'
			});
		}

		if (linkedPlaylistId) {
			await verifyOwnership(event, headers, userId, linkedPlaylistId, signal);
			mutationStarted = true;
			await requestSpotify(
				event.fetch,
				`https://api.spotify.com/v1/playlists/${linkedPlaylistId}`,
				{
					method: 'PUT',
					headers,
					body: JSON.stringify({
						name: payload.name,
						description: payload.description,
						public: payload.public
					})
				},
				signal,
				{ notFound: true }
			);
		} else {
			creationDispatched = true;
			const createdValue = await requestSpotify(
				event.fetch,
				'https://api.spotify.com/v1/me/playlists',
				{
					method: 'POST',
					headers,
					body: JSON.stringify({
						name: payload.name,
						description: payload.description,
						public: payload.public
					})
				},
				signal,
				{ json: true }
			);
			if (!isRecord(createdValue) || !isSpotifyPlaylistId(createdValue.id)) {
				throw new SpotifyPlaylistFailure('invalid-response');
			}
			linkedPlaylistId = createdValue.id;
			mutationStarted = true;
			mode = 'created';
		}

		if (!linkedPlaylistId) throw new SpotifyPlaylistFailure('invalid-response');
		if (mode === 'updated') {
			await requestSpotify(
				event.fetch,
				`https://api.spotify.com/v1/playlists/${linkedPlaylistId}/items`,
				{
					method: 'PUT',
					headers,
					body: JSON.stringify({ uris: payload.tracks.slice(0, 100) })
				},
				signal,
				{ notFound: true }
			);
		}
		const appendStart = mode === 'updated' ? 100 : 0;
		for (let index = appendStart; index < payload.tracks.length; index += 100) {
			await requestSpotify(
				event.fetch,
				`https://api.spotify.com/v1/playlists/${linkedPlaylistId}/items`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ uris: payload.tracks.slice(index, index + 100) })
				},
				signal,
				{ notFound: true }
			);
		}

		return json({
			playlistId: linkedPlaylistId,
			url: spotifyPlaylistUrl(linkedPlaylistId),
			mode,
			trackCount: payload.tracks.length
		});
	} catch (cause) {
		const failure =
			cause instanceof SpotifyPlaylistFailure
				? cause
				: new SpotifyPlaylistFailure(isAbortError(cause) ? 'network' : 'invalid-response');
		const creationOutcomeUnknown =
			creationDispatched &&
			!linkedPlaylistId &&
			['upstream', 'invalid-response', 'network', 'timeout'].includes(failure.category);
		return safeErrorResponse(failure, mutationStarted, linkedPlaylistId, creationOutcomeUnknown);
	}
};

export const POST: RequestHandler = async (event) => {
	const scope = createAbortScope(event.request.signal, SPOTIFY_PLAYLIST_ROUTE_TIMEOUT_MS);
	try {
		return await handlePlaylistRequest(event, scope.signal);
	} finally {
		scope.cleanup();
	}
};
