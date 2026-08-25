import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./spotify-config.server', () => ({
	getSpotifyConfiguration: () => ({
		clientId: 'configured-client',
		clientSecret: 'configured-secret'
	})
}));

import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { getAccessToken, startUserSession } from './auth.server';

const eventWithCookies = (initial: Record<string, string> = {}) => {
	const values = new Map(Object.entries(initial));
	const writes: Array<{ name: string; value: string }> = [];
	return {
		writes,
		event: {
			url: new URL('https://app.example/login'),
			request: new Request('https://app.example/login'),
			cookies: {
				get: (name: string) => values.get(name),
				set: (name: string, value: string) => {
					writes.push({ name, value });
					values.set(name, value);
				}
			}
		}
	};
};

describe('Spotify user-token cookie boundary', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does not write cookies for a malformed successful authorization response', async () => {
		const context = eventWithCookies();
		await expect(
			startUserSession(
				context.event as never,
				'redacted-code',
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								access_token: 'private-access',
								expires_in: 3_600,
								token_type: 'Bearer'
							})
						)
				) as typeof fetch
			)
		).rejects.toMatchObject({ reason: 'invalid-response' });
		expect(context.writes).toEqual([]);
	});

	it('retains the existing refresh cookie when rotation omits a replacement', async () => {
		const context = eventWithCookies({ [REFRESH_TOKEN_KEY]: 'existing-refresh' });
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: 'new-access',
							expires_in: 3_600,
							token_type: 'Bearer'
						})
					)
			)
		);

		await expect(getAccessToken(context.event as never)).resolves.toBe('new-access');
		expect(context.writes).toEqual([
			{ name: ACCESS_TOKEN_KEY, value: 'new-access' },
			{ name: REFRESH_TOKEN_KEY, value: 'existing-refresh' }
		]);
	});
});
