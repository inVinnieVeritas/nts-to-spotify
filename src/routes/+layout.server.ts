import { getAccessToken } from '$lib/utils/auth.server';
import { getSpotifyProfile } from '$lib/utils/spotify-profile.server';
import { isSpotifyTokenAcquisitionError } from '$lib/utils/spotify-token.server';
import type { LayoutServerLoad } from './$types';

const images = ['/bg1.jpg', '/bg2.jpg', '/bg3.jpg', '/bg4.jpg', '/bg5.jpg', '/bg6.jpg', '/bg7.jpg'];

export const load: LayoutServerLoad = async (event) => {
	const bgImage = images[Math.floor(Math.random() * 100) % images.length];
	let token: string | null;

	try {
		token = await getAccessToken(event);
	} catch (cause) {
		if (isSpotifyTokenAcquisitionError(cause)) return { user: null, bgImage };
		if (
			cause &&
			typeof cause === 'object' &&
			(cause as { status?: unknown }).status === 503 &&
			(cause as { body?: { message?: unknown } }).body?.message ===
				'Spotify application is not configured'
		) {
			throw cause;
		}
		return { user: null, bgImage };
	}

	if (!token) return { user: null, bgImage };

	try {
		return {
			user: await getSpotifyProfile(
				event.fetch as typeof globalThis.fetch,
				token,
				event.request.signal
			),
			bgImage
		};
	} catch {
		return { user: null, bgImage };
	}
};
