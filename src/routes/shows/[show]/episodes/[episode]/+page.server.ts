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
import { isSpotifyTokenAcquisitionError } from '$lib/utils/spotify-token.server';

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

		if (!token) throw error(503, 'Spotify application is not configured');

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
			setHeaders({ 'X-Spotify-Search-Error-Reason': err.reason });
			throw error(503, 'Spotify search is temporarily unavailable. Try again later.');
		}
		if (isSpotifyTokenAcquisitionError(err)) {
			throw error(502, 'Spotify token service is temporarily unavailable. Try again later.');
		}
		if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
			const status = (err as { status: unknown }).status;
			const message = (err as { body?: { message?: unknown } }).body?.message;
			if (status === 503 && message === 'Spotify application is not configured') throw err;
		}
		console.error('Single-episode load failed', 'unexpected_error');
		throw error(500, `Unable to load document from url: ${routeParamsToNtsUrl(show, episode)}`);
	} finally {
		scope.cleanup();
	}
};
