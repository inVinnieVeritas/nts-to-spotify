import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isValidNTSSlug } from '$lib/utils/nts';
import { getNTSEpisodeTracklist } from '$lib/utils/nts.server';
import {
	getClientCredentials,
	mapWithConcurrency,
	searchSpotifyTrack
} from '$lib/utils/spotify.server';
import { getAccessToken } from '$lib/utils/auth.server';

export const POST: RequestHandler = async (event) => {
	if (!(await getAccessToken(event))) throw error(401, 'Login with Spotify first');

	const { request, fetch } = event;
	const { show, episode } = (await request.json()) as { show?: string; episode?: string };

	if (!show || !episode || !isValidNTSSlug(show) || !isValidNTSSlug(episode)) {
		throw error(400, 'Valid NTS show and episode aliases are required');
	}

	try {
		const [tracks, token] = await Promise.all([
			getNTSEpisodeTracklist(show, episode, fetch as typeof globalThis.fetch),
			getClientCredentials(fetch as typeof globalThis.fetch)
		]);
		if (!token) throw error(401, 'Spotify application credentials are not configured');

		const matches = await mapWithConcurrency(tracks, 4, (track) =>
			searchSpotifyTrack(track, token, fetch as typeof globalThis.fetch)
		);

		return json({ tracks: matches });
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error(cause);
		throw error(502, 'Unable to match this NTS episode');
	}
};
