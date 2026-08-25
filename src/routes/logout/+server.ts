import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { secureCookieForUrl } from '$lib/utils/oauth.server';

const clearAuthentication = (event: Parameters<RequestHandler>[0]) => {
	const options = {
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: secureCookieForUrl(event.url),
		path: '/',
		maxAge: 0
	};
	event.cookies.set(ACCESS_TOKEN_KEY, '', options);
	event.cookies.set(REFRESH_TOKEN_KEY, '', options);
};

export const GET: RequestHandler = async () =>
	new Response(null, { status: 405, headers: { Allow: 'POST' } });

export const POST: RequestHandler = async (event) => {
	clearAuthentication(event);
	throw redirect(303, '/');
};
