import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { fetchWithTimeout } from './request';

const SPOTIFY_TOKEN_TIMEOUT_MS = 15_000;

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

	setCookies(event, data);

	return data.access_token;
};

export const setCookies = (
	event: RequestEvent,
	data: {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	}
) => {
	event.cookies.set(ACCESS_TOKEN_KEY, data.access_token, {
		httpOnly: true,
		maxAge: data.expires_in,
		path: '/'
	});

	if (data.refresh_token) {
		event.cookies.set(REFRESH_TOKEN_KEY, data.refresh_token, {
			httpOnly: true,
			maxAge: 60 * 60 * 24 * 30,
			path: '/'
		});
	}
};

type AccessTokenResponse = {
	access_token: string;
	token_type: string;
	scope: string;
	expires_in: number;
};

type RefreshTokenResponse = AccessTokenResponse & {
	refresh_token: string;
};

export const startUserSession = async (event: RequestEvent, code: string) => {
	const data = await fetchWithTimeout(
		fetch,
		'https://accounts.spotify.com/api/token',
		{
			method: 'POST',
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: `${event.url.origin}/login`
			}),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${Buffer.from(
					`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
				).toString('base64')}`
			}
		},
		SPOTIFY_TOKEN_TIMEOUT_MS,
		async (res) => {
			if (!res.ok) {
				await res.body?.cancel();
				throw error(401, 'Not authorized');
			}
			return (await res.json()) as RefreshTokenResponse;
		},
		event.request.signal
	);

	setCookies(event, data);
};

export const rotateAccessToken = async (refreshToken: string, signal?: AbortSignal) => {
	return fetchWithTimeout(
		fetch,
		'https://accounts.spotify.com/api/token',
		{
			method: 'POST',
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken
			}),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${Buffer.from(
					`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
				).toString('base64')}`
			}
		},
		SPOTIFY_TOKEN_TIMEOUT_MS,
		async (res) => {
			if (!res.ok) {
				await res.body?.cancel();
				throw error(401, 'Not authorized');
			}
			return (await res.json()) as AccessTokenResponse;
		},
		signal
	);
};
