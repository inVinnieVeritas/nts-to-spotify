import type { Handle } from '@sveltejs/kit';
import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';

export const handle: Handle = async ({ event, resolve }) => {
	const configuration = hostedConfiguration();
	if (!configuration) return resolve(event);
	const headers = {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff'
	};
	// adapter-node's fixed ORIGIN also becomes event.url for requests to run.app.
	// Check the actual inbound Host, never a caller-controlled forwarded header.
	if (
		event.url.origin !== configuration.origin ||
		event.request.headers.get('host')?.toLowerCase() !== new URL(configuration.origin).host
	) {
		return new Response('Invalid staging origin', { status: 400, headers });
	}
	// JSON endpoints need the same CSRF protection as forms. Do not trust forwarded headers.
	if (
		!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
		event.request.headers.get('origin') !== configuration.origin
	) {
		return new Response('Invalid request origin', { status: 403, headers });
	}
	const path = event.url.pathname;
	if (path !== '/login' && path !== '/logout' && !hasHostedSession(event)) {
		if (path === '/' && event.request.method === 'GET') {
			return new Response(
				'<!doctype html><html lang="en"><meta charset="utf-8"><title>Private staging</title><h1>Private NTS to Spotify staging</h1><p>Only the configured Spotify account may use this installation.</p><a href="/login">Sign in with Spotify</a></html>',
				{
					headers: {
						...headers,
						'Content-Type': 'text/html; charset=utf-8',
						'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
					}
				}
			);
		}
		return new Response('Sign in with the permitted Spotify account', { status: 401, headers });
	}
	const response = await resolve(event);
	for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
	return response;
};
