import { env } from '$env/dynamic/private';
import type { BasicTrack, Match, MatchedTrack, SpotifyTrackSearchResult } from '$lib/types';

type Fetcher = typeof fetch;

let cachedToken: { value: string; expiresAt: number } | null = null;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getClientCredentials = async (request: Fetcher = fetch) => {
	if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
	if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;

	const response = await request('https://accounts.spotify.com/api/token', {
		method: 'POST',
		body: new URLSearchParams({ grant_type: 'client_credentials' }),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: `Basic ${Buffer.from(
				`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
			).toString('base64')}`
		}
	});

	if (!response.ok) return null;
	const data = (await response.json()) as { access_token: string; expires_in: number };
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

export const searchSpotifyTrack = async (
	track: BasicTrack,
	token: string,
	request: Fetcher = fetch
): Promise<MatchedTrack> => {
	let fallback = false;

	for (;;) {
		let url = `https://api.spotify.com/v1/search?type=track&limit=10&q=track:${encodeURIComponent(
			track.title
		)}`;
		if (!fallback) url += `%20artist:${encodeURIComponent(track.artist)}`;

		const response = await request(url, {
			headers: { Authorization: `Bearer ${token}` }
		});

		if (response.status === 429) {
			await sleep(Number(response.headers.get('Retry-After') || 1) * 1000);
			continue;
		}
		if (!response.ok) throw new Error(`Spotify search failed (${response.status})`);

		const result = (await response.json()) as SpotifyTrackSearchResult;
		const matches = (result.tracks?.items || []).map<Match>((item) => ({
			artist: item.artists.map(({ name }) => name).join(', '),
			title: item.name,
			uri: item.uri,
			preview: item.preview_url || undefined,
			cover: item.album.images[0]?.url,
			href: item.external_urls.spotify
		}));

		if (matches.length === 0 && !fallback) {
			fallback = true;
			continue;
		}

		return {
			...track,
			matches,
			fallback,
			confident: !fallback && matches.length > 0 && isConfidentMatch(track, matches[0])
		};
	}
};

export const mapWithConcurrency = async <T, R>(
	items: T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await mapper(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
};
