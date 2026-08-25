import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startUserSession } from '$lib/utils/auth.server';
import { OAUTH_RETURN_PATH_KEY, OAUTH_STATE_KEY, SPOTIFY_SCOPES } from '$lib/constants';
import { getSpotifyConfiguration } from '$lib/utils/spotify-config.server';
import { isSpotifyTokenAcquisitionError } from '$lib/utils/spotify-token.server';
import {
	createOAuthState,
	getSafeReturnPathFromReferer,
	normalizeSafeReturnPath,
	oauthStatesMatch,
	OAUTH_RETURN_PATH_TTL_SECONDS,
	OAUTH_STATE_TTL_SECONDS,
	secureCookieForUrl
} from '$lib/utils/oauth.server';

const oauthCookieOptions = (url: URL, maxAge: number) => ({
	httpOnly: true,
	sameSite: 'lax' as const,
	secure: secureCookieForUrl(url),
	path: '/login',
	maxAge
});

const consumeOAuthCookies = (event: Parameters<RequestHandler>[0]) => {
	event.cookies.set(OAUTH_STATE_KEY, '', oauthCookieOptions(event.url, 0));
	event.cookies.set(OAUTH_RETURN_PATH_KEY, '', oauthCookieOptions(event.url, 0));
};

export const GET: RequestHandler = async (event) => {
	const isCallback = ['code', 'error', 'state'].some((parameter) =>
		event.url.searchParams.has(parameter)
	);
	if (isCallback) {
		const expectedState = event.cookies.get(OAUTH_STATE_KEY);
		const returnPath = normalizeSafeReturnPath(event.cookies.get(OAUTH_RETURN_PATH_KEY));
		const callbackState = event.url.searchParams.get('state');
		consumeOAuthCookies(event);

		if (!oauthStatesMatch(callbackState, expectedState)) {
			throw error(400, 'Invalid Spotify authorization state');
		}
		if (event.url.searchParams.has('error')) {
			throw error(401, 'Spotify authorization was denied');
		}
		const code = event.url.searchParams.get('code');
		if (!code) throw error(400, 'Spotify authorization response is incomplete');

		try {
			await startUserSession(event, code);
		} catch (cause) {
			if (isSpotifyTokenAcquisitionError(cause)) {
				throw error(
					cause.reason === 'authentication' ? 401 : 502,
					'Spotify authorization could not be completed'
				);
			}
			if (cause && typeof cause === 'object' && 'status' in cause && 'body' in cause) {
				const status = (cause as { status: unknown }).status;
				const message = (cause as { body?: { message?: unknown } }).body?.message;
				if (
					(status === 401 && message === 'Not authorized') ||
					(status === 503 && message === 'Spotify application is not configured')
				) {
					throw cause;
				}
			}
			throw error(502, 'Spotify authorization could not be completed');
		}
		throw redirect(303, returnPath);
	}

	const configuration = getSpotifyConfiguration();
	if (!configuration) throw error(503, 'Spotify application is not configured');
	const state = createOAuthState();
	const returnPath = getSafeReturnPathFromReferer(
		event.request.headers.get('referer'),
		event.url.origin
	);
	event.cookies.set(OAUTH_STATE_KEY, state, oauthCookieOptions(event.url, OAUTH_STATE_TTL_SECONDS));
	event.cookies.set(
		OAUTH_RETURN_PATH_KEY,
		returnPath,
		oauthCookieOptions(event.url, OAUTH_RETURN_PATH_TTL_SECONDS)
	);

	throw redirect(
		303,
		`https://accounts.spotify.com/authorize?${new URLSearchParams({
			client_id: configuration.clientId,
			redirect_uri: `${event.url.origin}/login`,
			scope: SPOTIFY_SCOPES,
			state,
			response_type: 'code'
		}).toString()}`
	);
};
