import type { PageServerLoad } from './$types';
import { routeParamsToNtsUrl } from '$lib/utils/nts';
import { load as cheerioLoad } from 'cheerio';
import { error } from '@sveltejs/kit';
import { getNTSData } from './utils.server';
import {
	getClientCredentials,
	mapWithConcurrency,
	searchSpotifyTrack
} from '$lib/utils/spotify.server';

export const load: PageServerLoad = async ({ params, fetch }) => {
	const { show, episode } = params;

	try {
		// load NTS episode
		const res = await fetch(routeParamsToNtsUrl(show, episode));

		if (!res.ok) throw new Error();

		const cheerio = cheerioLoad(await res.text());

		const data = getNTSData(cheerio);

		const token = await getClientCredentials(fetch as typeof globalThis.fetch);

		if (!token) throw error(401, 'Not authorized');

		const tracks = await mapWithConcurrency(data.tracks, 4, (track) =>
			searchSpotifyTrack(track, token, fetch as typeof globalThis.fetch)
		);

		return {
			...data,
			tracks
		};
	} catch (err) {
		console.error(err);
		throw error(500, `Unable to load document from url: ${routeParamsToNtsUrl(show, episode)}`);
	}
};
