import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { createTokenCookieData, setCookies } from './auth.server';

const createEvent = (url: string) => {
	const writes: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
	return {
		writes,
		event: {
			url: new URL(url),
			cookies: {
				set: (name: string, value: string, options: Record<string, unknown>) =>
					writes.push({ name, value, options })
			}
		}
	};
};

describe('authentication cookie policy', () => {
	it('retains the existing refresh token when a valid refresh response omits a replacement', () => {
		expect(
			createTokenCookieData(
				{ accessToken: 'new-access', expiresIn: 3_600, tokenType: 'Bearer' },
				'existing-refresh'
			)
		).toEqual({
			access_token: 'new-access',
			expires_in: 3_600,
			refresh_token: 'existing-refresh'
		});
	});

	it.each([
		['http://127.0.0.1:5173/login', false],
		['https://app.example/login', true]
	])('sets explicit token policy for %s', (url, secure) => {
		const request = createEvent(url);
		setCookies(request.event as never, {
			access_token: 'access',
			refresh_token: 'refresh',
			expires_in: 3_600
		});
		expect(request.writes.map(({ name }) => name)).toEqual([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]);
		expect(request.writes[0].options).toEqual({
			httpOnly: true,
			sameSite: 'lax',
			secure,
			maxAge: 3_600,
			path: '/'
		});
		expect(request.writes[1].options).toEqual({
			httpOnly: true,
			sameSite: 'lax',
			secure,
			maxAge: 60 * 60 * 24 * 30,
			path: '/'
		});
	});
});
