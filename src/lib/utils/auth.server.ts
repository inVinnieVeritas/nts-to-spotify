import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { getSpotifyConfiguration } from './spotify-config.server';
import { secureCookieForUrl } from './oauth.server';
import { requestSpotifyToken } from './spotify-token.server';
import type { ValidatedSpotifyToken } from './spotify-token.server';

export const createTokenCookieData = (
	data: ValidatedSpotifyToken,
	existingRefreshToken?: string
) => ({
	access_token: data.accessToken,
	expires_in: data.expiresIn,
	...(data.refreshToken || existingRefreshToken
		? { refresh_token: data.refreshToken ?? existingRefreshToken }
		: {})
});

export const getAccessToken = async (event: RequestEvent) => {
	const refresh = event.cookies.get(REFRESH_TOKEN_KEY);

	if (!refresh) return null;

	return (
		event.cookies.get(ACCESS_TOKEN_KEY) ||
		(await refreshAccessToken(refresh, event, event.request.signal))
	);
};

const refreshAccessToken = async (
	refreshToken: string,
	event: RequestEvent,
	signal?: AbortSignal
) => {
	const data = await rotateAccessToken(refreshToken, signal);

	setCookies(event, createTokenCookieData(data, refreshToken));

	return data.accessToken;
};

export const setCookies = (
	event: RequestEvent,
	data: {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	}
) => {
	const secure = secureCookieForUrl(event.url);
	event.cookies.set(ACCESS_TOKEN_KEY, data.access_token, {
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: data.expires_in,
		path: '/'
	});

	if (data.refresh_token) {
		event.cookies.set(REFRESH_TOKEN_KEY, data.refresh_token, {
			httpOnly: true,
			sameSite: 'lax',
			secure,
			maxAge: 60 * 60 * 24 * 30,
			path: '/'
		});
	}
};

export const startUserSession = async (
	event: RequestEvent,
	code: string,
	request: typeof fetch = fetch
) => {
	const configuration = getSpotifyConfiguration();
	if (!configuration) throw error(503, 'Spotify application is not configured');
	const data = await requestSpotifyToken(
		request,
		configuration,
		new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: `${event.url.origin}/login`
		}),
		{ requireRefreshToken: true, signal: event.request.signal }
	);

	setCookies(event, createTokenCookieData(data));
};

export const rotateAccessToken = async (
	refreshToken: string,
	signal?: AbortSignal,
	request: typeof fetch = fetch
) => {
	const configuration = getSpotifyConfiguration();
	if (!configuration) throw error(503, 'Spotify application is not configured');
	return requestSpotifyToken(
		request,
		configuration,
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken
		}),
		{ requireRefreshToken: false, signal }
	);
};
