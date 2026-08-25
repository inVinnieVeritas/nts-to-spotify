import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ startUserSession: vi.fn() }));
vi.mock('$lib/utils/spotify-config.server', () => ({
	getSpotifyConfiguration: vi.fn(() => ({ clientId: 'configured-client', clientSecret: 'secret' }))
}));

import { OAUTH_RETURN_PATH_KEY, OAUTH_STATE_KEY } from '$lib/constants';
import { startUserSession } from '$lib/utils/auth.server';
import { getSpotifyConfiguration } from '$lib/utils/spotify-config.server';
import { GET } from './+server';

type CookieOptions = {
	maxAge?: number;
	path?: string;
	httpOnly?: boolean;
	sameSite?: string;
	secure?: boolean;
};

const createCookies = (initial: Record<string, string> = {}) => {
	const values = new Map(Object.entries(initial));
	const writes: Array<{ name: string; value: string; options: CookieOptions }> = [];
	return {
		values,
		writes,
		cookies: {
			get: (name: string) => values.get(name),
			set: (name: string, value: string, options: CookieOptions) => {
				writes.push({ name, value, options });
				if (options.maxAge === 0) values.delete(name);
				else values.set(name, value);
			}
		}
	};
};

const invoke = async (url: string, cookies: ReturnType<typeof createCookies>, referer?: string) => {
	try {
		await GET({
			url: new URL(url),
			request: new Request(url, { headers: referer ? { referer } : undefined }),
			cookies: cookies.cookies
		} as never);
		throw new Error('Expected the handler to throw');
	} catch (cause) {
		return cause as { status: number; location?: string; body?: { message?: string } };
	}
};

describe('Spotify login OAuth flow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSpotifyConfiguration).mockReturnValue({
			clientId: 'configured-client',
			clientSecret: 'secret'
		});
	});

	it('stores random state and a separate safe return path, then consumes both on success', async () => {
		const jar = createCookies();
		const start = await invoke(
			'http://127.0.0.1:5173/login',
			jar,
			'http://127.0.0.1:5173/shows/example?review=selected'
		);
		expect(start.status).toBe(303);
		const authorization = new URL(start.location as string);
		const state = authorization.searchParams.get('state') as string;
		expect(authorization.origin).toBe('https://accounts.spotify.com');
		expect(authorization.searchParams.get('client_id')).toBe('configured-client');
		expect(state).not.toContain('/shows/example');
		expect(jar.values.get(OAUTH_RETURN_PATH_KEY)).toBe('/shows/example?review=selected');
		for (const name of [OAUTH_STATE_KEY, OAUTH_RETURN_PATH_KEY]) {
			expect(jar.writes.find((write) => write.name === name)?.options).toMatchObject({
				httpOnly: true,
				sameSite: 'lax',
				secure: false,
				path: '/login'
			});
		}

		const callback = await invoke(`http://127.0.0.1:5173/login?code=redacted&state=${state}`, jar);
		expect(callback).toMatchObject({
			status: 303,
			location: '/shows/example?review=selected'
		});
		expect(startUserSession).toHaveBeenCalledOnce();
		expect(jar.values.has(OAUTH_STATE_KEY)).toBe(false);
		expect(jar.values.has(OAUTH_RETURN_PATH_KEY)).toBe(false);
	});

	it.each([
		['missing', {}],
		['malformed', { [OAUTH_STATE_KEY]: 'malformed' }],
		['mismatched', { [OAUTH_STATE_KEY]: 'A'.repeat(43) }]
	])('rejects %s callback state and consumes callback cookies', async (_label, initial) => {
		const jar = createCookies({ ...initial, [OAUTH_RETURN_PATH_KEY]: '/shows/example' });
		const result = await invoke(
			`http://127.0.0.1:5173/login?code=redacted&state=${'B'.repeat(43)}`,
			jar
		);
		expect(result).toMatchObject({ status: 400 });
		expect(startUserSession).not.toHaveBeenCalled();
		expect(jar.values.has(OAUTH_STATE_KEY)).toBe(false);
	});

	it('rejects replay after a successful callback', async () => {
		const state = 'C'.repeat(43);
		const jar = createCookies({ [OAUTH_STATE_KEY]: state, [OAUTH_RETURN_PATH_KEY]: '/' });
		expect((await invoke(`https://app.example/login?code=one&state=${state}`, jar)).status).toBe(
			303
		);
		expect((await invoke(`https://app.example/login?code=two&state=${state}`, jar)).status).toBe(
			400
		);
	});

	it('sanitizes authorization denial and consumes state', async () => {
		const state = 'D'.repeat(43);
		const jar = createCookies({ [OAUTH_STATE_KEY]: state, [OAUTH_RETURN_PATH_KEY]: '/' });
		const result = await invoke(
			`https://app.example/login?error=access_denied&error_description=private&state=${state}`,
			jar
		);
		expect(result).toMatchObject({ status: 401 });
		expect(JSON.stringify(result)).not.toContain('private');
		expect(jar.values.has(OAUTH_STATE_KEY)).toBe(false);
	});

	it('sanitizes token-exchange failures and still consumes state', async () => {
		const state = 'E'.repeat(43);
		const jar = createCookies({ [OAUTH_STATE_KEY]: state, [OAUTH_RETURN_PATH_KEY]: '/' });
		vi.mocked(startUserSession).mockRejectedValueOnce({
			token: 'must-not-be-exposed',
			url: 'https://private.example/callback'
		});
		const result = await invoke(`https://app.example/login?code=redacted&state=${state}`, jar);
		expect(result).toMatchObject({
			status: 502,
			body: { message: 'Spotify authorization could not be completed' }
		});
		expect(JSON.stringify(result)).not.toContain('must-not-be-exposed');
		expect(JSON.stringify(result)).not.toContain('private.example');
		expect(jar.values.has(OAUTH_STATE_KEY)).toBe(false);
	});

	it('maps a typed token rejection to a fixed authorization response', async () => {
		const state = 'F'.repeat(43);
		const jar = createCookies({ [OAUTH_STATE_KEY]: state, [OAUTH_RETURN_PATH_KEY]: '/' });
		vi.mocked(startUserSession).mockRejectedValueOnce({
			name: 'SpotifyTokenAcquisitionError',
			reason: 'authentication',
			authorization_code: 'must-not-be-exposed'
		});
		const result = await invoke(`https://app.example/login?code=redacted&state=${state}`, jar);
		expect(result).toMatchObject({
			status: 401,
			body: { message: 'Spotify authorization could not be completed' }
		});
		expect(JSON.stringify(result)).not.toContain('must-not-be-exposed');
	});

	it('uses secure cookies on HTTPS and returns a fixed configuration error', async () => {
		const secureJar = createCookies();
		await invoke('https://app.example/login', secureJar);
		expect(secureJar.writes.every(({ options }) => options.secure)).toBe(true);

		vi.mocked(getSpotifyConfiguration).mockReturnValue(null);
		const result = await invoke('http://127.0.0.1:5173/login', createCookies());
		expect(result).toMatchObject({ status: 503 });
		expect(JSON.stringify(result)).toContain('Spotify application is not configured');
	});
});
