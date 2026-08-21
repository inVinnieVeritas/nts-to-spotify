import type { PageServerLoad } from './$types';
import { routeParamsToNtsUrl } from '$lib/utils/nts';
import { load as cheerioLoad } from 'cheerio';
import { error } from '@sveltejs/kit';
import { getNTSData } from './utils.server';
import {
	getClientCredentials,
	getSpotifyRateLimitReason,
	isSpotifyRateLimitError,
	isSpotifyResponseValidationError,
	isSpotifySearchUnavailableError,
	mapWithConcurrency,
	searchSpotifyTrack
} from '$lib/utils/spotify.server';
import { createAbortScope } from '$lib/utils/abort';
import { fetchWithTimeout } from '$lib/utils/request';

const SINGLE_EPISODE_TIMEOUT_MS = 3 * 60 * 1000;
const NTS_DOCUMENT_TIMEOUT_MS = 20_000;

export const load: PageServerLoad = async ({ params, fetch, request, setHeaders }) => {
	const { show, episode } = params;
	const scope = createAbortScope(request.signal, SINGLE_EPISODE_TIMEOUT_MS);

	try {
		// load NTS episode
		const document = await fetchWithTimeout(
			fetch as typeof globalThis.fetch,
			routeParamsToNtsUrl(show, episode),
			{},
			NTS_DOCUMENT_TIMEOUT_MS,
			async (res) => {
				if (!res.ok) {
					await res.body?.cancel();
					throw new Error();
				}
				return res.text();
			},
			scope.signal
		);

		const cheerio = cheerioLoad(document);

		const data = getNTSData(cheerio);

		const token = await getClientCredentials(fetch as typeof globalThis.fetch, scope.signal);

		if (!token) throw error(401, 'Not authorized');

		const tracks = await mapWithConcurrency(
			data.tracks,
			4,
			(track, _index, signal) =>
				searchSpotifyTrack(track, token, fetch as typeof globalThis.fetch, signal),
			scope.signal
		);

		return {
			...data,
			tracks
		};
	} catch (err) {
		if (isSpotifyRateLimitError(err)) {
			const reason = getSpotifyRateLimitReason(err);
			setHeaders({
				'Retry-After': String(err.retryAfterSeconds),
				'X-Spotify-Rate-Limit-Reason': reason
			});
			throw error(
				429,
				reason === 'quota-exceeded'
					? 'Spotify Development Mode quota exhausted. Try again after the Retry-After interval.'
					: 'Spotify rate limited. Try again after the Retry-After interval.'
			);
		}
		if (isSpotifyResponseValidationError(err)) {
			throw error(502, 'Spotify returned an invalid search response. Try again later.');
		}
		if (isSpotifySearchUnavailableError(err)) {
			throw error(503, 'Spotify search is temporarily unavailable. Try again later.');
		}
		console.error('Single-episode load failed', 'unexpected_error');
		throw error(500, `Unable to load document from url: ${routeParamsToNtsUrl(show, episode)}`);
	} finally {
		scope.cleanup();
	}
};
