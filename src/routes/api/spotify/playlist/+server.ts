import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAccessToken } from '$lib/utils/auth.server';
import { uniqueSpotifyUris } from '$lib/utils/catalog-scan';

export const POST: RequestHandler = async (event) => {
	const {
		name,
		description,
		tracks,
		public: isPublic = true
	} = (await event.request.json()) as {
		name: string;
		description: string;
		tracks: string[];
		public?: boolean;
	};

	if (
		typeof name !== 'string' ||
		!name.trim() ||
		typeof description !== 'string' ||
		!Array.isArray(tracks) ||
		tracks.length === 0
	) {
		throw error(400, `Name, description, and at least one track are required`);
	}
	if (!tracks.every((track) => /^spotify:track:[A-Za-z0-9]+$/.test(track))) {
		throw error(400, 'Invalid Spotify track URI');
	}
	const uniqueTracks = uniqueSpotifyUris(tracks);

	const token = await getAccessToken(event);
	if (!token) throw error(401, 'Login with Spotify first');
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`
	};

	try {
		const profileResponse = await event.fetch('https://api.spotify.com/v1/me', { headers });
		if (!profileResponse.ok)
			throw new Error(`Spotify profile request failed (${profileResponse.status})`);
		const profile = (await profileResponse.json()) as { id: string };

		const createPlaylist = await event.fetch(
			`https://api.spotify.com/v1/users/${encodeURIComponent(profile.id)}/playlists`,
			{
				method: 'POST',
				body: JSON.stringify({
					name: name.trim().slice(0, 100),
					description: description.slice(0, 300),
					public: isPublic
				}),
				headers
			}
		);
		if (!createPlaylist.ok)
			throw new Error(`Spotify playlist creation failed (${createPlaylist.status})`);
		const created = (await createPlaylist.json()) as {
			id: string;
			external_urls?: { spotify?: string };
		};

		for (let index = 0; index < uniqueTracks.length; index += 100) {
			const addTracks = await event.fetch(
				`https://api.spotify.com/v1/playlists/${created.id}/tracks`,
				{
					method: 'POST',
					body: JSON.stringify({ uris: uniqueTracks.slice(index, index + 100) }),
					headers
				}
			);
			if (!addTracks.ok) throw new Error(`Spotify track import failed (${addTracks.status})`);
		}

		return json({
			id: created.id,
			url: created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}`
		});
	} catch (err) {
		console.error(err);
		throw error(500, 'Error importing');
	}
};
