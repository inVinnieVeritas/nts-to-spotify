import { env } from '$env/dynamic/private';

export type SpotifyConfiguration = {
	clientId: string;
	clientSecret: string;
};

export const validateSpotifyConfiguration = (
	clientId: unknown,
	clientSecret: unknown
): SpotifyConfiguration | null => {
	if (
		typeof clientId !== 'string' ||
		clientId.trim().length === 0 ||
		typeof clientSecret !== 'string' ||
		clientSecret.trim().length === 0
	) {
		return null;
	}

	return { clientId, clientSecret };
};

export const getSpotifyConfiguration = () =>
	validateSpotifyConfiguration(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET);
