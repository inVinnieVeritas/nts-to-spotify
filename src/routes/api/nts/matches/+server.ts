import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isValidNTSSlug } from '$lib/utils/nts';
import { getNTSEpisodeTracklist } from '$lib/utils/nts.server';
import {
	getClientCredentials,
	getSpotifyRateLimitReason,
	getSpotifySessionMetrics,
	isSpotifyRateLimitError,
	isSpotifyResponseValidationError,
	isSpotifySearchUnavailableError,
	mapWithConcurrency,
	searchSpotifyTrack
} from '$lib/utils/spotify.server';
import { getAccessToken } from '$lib/utils/auth.server';
import { createAbortScope, isAbortError, RequestTimeoutError } from '$lib/utils/abort';

const EPISODE_TIMEOUT_MS = 3 * 60 * 1000;

export const POST: RequestHandler = async (event) => {
	if (!(await getAccessToken(event))) throw error(401, 'Login with Spotify first');

	const { request, fetch } = event;
	const { show, episode } = (await request.json()) as { show?: string; episode?: string };

	if (!show || !episode || !isValidNTSSlug(show) || !isValidNTSSlug(episode)) {
		throw error(400, 'Valid NTS show and episode aliases are required');
	}

	const scope = createAbortScope(request.signal, EPISODE_TIMEOUT_MS);
	try {
		const token = await getClientCredentials(fetch as typeof globalThis.fetch, scope.signal);
		if (!token) throw error(401, 'Spotify application credentials are not configured');
		const tracks = await getNTSEpisodeTracklist(
			show,
			episode,
			fetch as typeof globalThis.fetch,
			scope.signal
		);

		const matches = await mapWithConcurrency(
			tracks,
			4,
			(track, _index, signal) =>
				searchSpotifyTrack(track, token, fetch as typeof globalThis.fetch, signal),
			scope.signal
		);

		return json({ tracks: matches, spotifySessionMetrics: getSpotifySessionMetrics() });
	} catch (cause) {
		if (isSpotifyRateLimitError(cause)) {
			return json(
				{
					error: 'spotify_rate_limited',
					retryAfterSeconds: cause.retryAfterSeconds,
					reason: getSpotifyRateLimitReason(cause),
					spotifySessionMetrics: getSpotifySessionMetrics()
				},
				{
					status: 429,
					headers: { 'Retry-After': String(cause.retryAfterSeconds) }
				}
			);
		}
		if (isSpotifyResponseValidationError(cause)) {
			return json(
				{
					error: 'spotify_response_invalid',
					spotifySessionMetrics: getSpotifySessionMetrics()
				},
				{ status: 502 }
			);
		}
		if (isSpotifySearchUnavailableError(cause)) {
			return json(
				{
					error: 'spotify_search_unavailable',
					spotifySessionMetrics: getSpotifySessionMetrics()
				},
				{ status: 503 }
			);
		}
		if (cause instanceof RequestTimeoutError || scope.didTimeout()) {
			throw error(504, 'Episode scan timed out');
		}
		if (isAbortError(cause)) throw error(499, 'Episode scan cancelled');
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error('Catalogue episode matching failed', 'unexpected_error');
		throw error(502, 'Unable to match this NTS episode');
	} finally {
		scope.cleanup();
	}
};
