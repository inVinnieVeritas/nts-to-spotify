import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => runtime);
import {
	hasHostedSession,
	hostedConfiguration,
	HOSTED_SESSION_COOKIE,
	setHostedSession
} from './hosted-access.server';
import { startUserSession, getAccessToken } from './auth.server';
import { handle } from '../../hooks.server';
import { POST as logout } from '../../routes/logout/+server';
import { createDefaultSpotifyMatchCache } from './spotify-match-cache.server';
import { getSpotifySessionMetrics } from './spotify.server';
import { STAGING_ORIGIN } from '../../../scripts/start-cloud-run.mjs';

const settings = {
	NTS_HOSTED_STAGING: '1',
	ORIGIN: STAGING_ORIGIN,
	PORT: '8080',
	SPOTIFY_CLIENT_ID: 'dummy-client',
	SPOTIFY_CLIENT_SECRET: 'dummy-secret',
	STAGING_SPOTIFY_USER_ID: 'permitted-user',
	STAGING_SESSION_SECRET: 'a'.repeat(64)
};
function fixture(path = '/', method = 'GET', origin?: string) {
	const values = new Map<string, string>();
	const writes: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
	const event = {
		url: new URL(path, STAGING_ORIGIN),
		request: new Request(new URL(path, STAGING_ORIGIN), {
			method,
			headers: { host: new URL(STAGING_ORIGIN).host, ...(origin ? { origin } : {}) }
		}),
		cookies: {
			get: (name: string) => values.get(name),
			set: (name: string, value: string, options: Record<string, unknown>) => {
				writes.push({ name, value, options });
				if (options.maxAge === 0) values.delete(name);
				else values.set(name, value);
			}
		}
	} as unknown as RequestEvent;
	return { event, values, writes };
}
function authorize(f: ReturnType<typeof fixture>, now = Date.now()) {
	f.values.set(ACCESS_TOKEN_KEY, 'access');
	f.values.set(REFRESH_TOKEN_KEY, 'refresh');
	setHostedSession(f.event, 'access', 'refresh', now);
}
const invoke = (event: RequestEvent, resolve = vi.fn(async () => new Response('allowed'))) =>
	handle({ event, resolve });

describe('private hosted staging boundary (no live services)', () => {
	beforeEach(() => Object.assign(runtime.env, settings));
	afterEach(() => {
		for (const key of Object.keys(runtime.env)) delete runtime.env[key];
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('leaves the local request path unchanged and performs no identity request', async () => {
		for (const key of Object.keys(runtime.env)) delete runtime.env[key];
		const f = fixture();
		const resolve = vi.fn(async () => new Response('local'));
		expect(await (await invoke(f.event, resolve)).text()).toBe('local');
		expect(resolve).toHaveBeenCalledOnce();
		expect(hasHostedSession(f.event)).toBe(true);
		expect(f.writes).toEqual([]);
	});

	it.each([
		'/api/nts/matches',
		'/api/nts/catalogue',
		'/api/spotify/playlist',
		'/shows/example',
		'/shows/example/episodes/example'
	])('blocks %s before any downstream work', async (path) => {
		const resolve = vi.fn();
		const before = getSpotifySessionMetrics();
		const result = await invoke(fixture(path).event, resolve);
		expect(result.status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
		expect(getSpotifySessionMetrics()).toEqual(before);
	});

	it('serves only a static sign-in page to anonymous users with no application load', async () => {
		const resolve = vi.fn();
		const result = await invoke(fixture().event, resolve);
		expect(await result.text()).toContain('href="/login"');
		expect(result.headers.get('cache-control')).toBe('no-store');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('never trusts an asserted IAP identity header or unsigned Spotify cookies', async () => {
		const f = fixture('/api/nts/matches');
		f.event.request.headers.set(
			'x-goog-authenticated-user-email',
			'accounts.google.com:dummy@example.com'
		);
		f.values.set(ACCESS_TOKEN_KEY, 'access');
		f.values.set(REFRESH_TOKEN_KEY, 'refresh');
		const resolve = vi.fn();
		expect((await invoke(f.event, resolve)).status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('fails closed for missing configuration, including a Cloud Run entrypoint bypass', () => {
		delete runtime.env.NTS_HOSTED_STAGING;
		runtime.env.K_SERVICE = 'dummy-service';
		expect(() => hostedConfiguration()).toThrow();
		delete runtime.env.K_SERVICE;
		runtime.env.NTS_HOSTED_STAGING = '1';
		delete runtime.env.STAGING_SESSION_SECRET;
		expect(() => hostedConfiguration()).toThrow();
	});

	it('allows a signed session, rejects substituted cookies, tampering, expiration and changed allowlist', () => {
		const f = fixture();
		const now = Date.now();
		authorize(f, now);
		expect(hasHostedSession(f.event, now)).toBe(true);
		expect(f.writes[0].options).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/'
		});
		expect(f.writes[0].value).not.toContain('refresh');
		expect(f.writes[0].value).not.toContain('access');
		f.values.set(ACCESS_TOKEN_KEY, 'other-access');
		expect(hasHostedSession(f.event, now)).toBe(false);
		f.values.delete(ACCESS_TOKEN_KEY);
		expect(hasHostedSession(f.event, now)).toBe(true);
		f.values.set(REFRESH_TOKEN_KEY, 'other-refresh');
		expect(hasHostedSession(f.event, now)).toBe(false);
		f.values.set(REFRESH_TOKEN_KEY, 'refresh');
		expect(hasHostedSession(f.event, now + 8 * 60 * 60 * 1000)).toBe(false);
		runtime.env.STAGING_SPOTIFY_USER_ID = 'different-owner';
		expect(hasHostedSession(f.event, now)).toBe(false);
		runtime.env.STAGING_SPOTIFY_USER_ID = settings.STAGING_SPOTIFY_USER_ID;
		f.values.set(HOSTED_SESSION_COOKIE, f.values.get(HOSTED_SESSION_COOKIE) + 'x');
		expect(hasHostedSession(f.event, now)).toBe(false);
	});

	it('accepts authorized reads but rejects cross-site and missing-origin writes', async () => {
		for (const origin of [undefined, 'https://attacker.invalid']) {
			const f = fixture('/api/spotify/playlist', 'POST', origin);
			authorize(f);
			const resolve = vi.fn();
			expect((await invoke(f.event, resolve)).status).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		}
		const f = fixture('/api/spotify/playlist', 'POST', STAGING_ORIGIN);
		authorize(f);
		expect(await (await invoke(f.event)).text()).toBe('allowed');
	});

	it('does not allow a noncanonical origin even with a valid authorization proof', async () => {
		const f = fixture();
		authorize(f);
		f.event.url = new URL('https://other.invalid/');
		const resolve = vi.fn();
		expect((await invoke(f.event, resolve)).status).toBe(400);
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each([
		['/', 'GET'],
		['/login', 'GET'],
		['/api/nts/catalogue', 'GET'],
		['/api/spotify/playlist', 'POST']
	])(
		'rejects run.app %s before routing despite adapter-node fixed origin',
		async (path, method) => {
			const f = fixture(path, method, STAGING_ORIGIN);
			authorize(f);
			f.event.request.headers.set('host', 'nts-staging-abc.europe-west1.run.app');
			f.event.request.headers.set('x-forwarded-host', new URL(STAGING_ORIGIN).host);
			const resolve = vi.fn();
			expect((await invoke(f.event, resolve)).status).toBe(400);
			expect(resolve).not.toHaveBeenCalled();
		}
	);

	it('fails closed when the inbound Host header is absent', async () => {
		const f = fixture('/login');
		f.event.request.headers.delete('host');
		const resolve = vi.fn();
		expect((await invoke(f.event, resolve)).status).toBe(400);
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each(['permitted-user', 'another-user'])(
		'verifies %s against Spotify before issuing any cookie',
		async (id) => {
			const f = fixture('/login');
			const request = vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						access_token: 'access',
						refresh_token: 'refresh',
						expires_in: 3600,
						token_type: 'Bearer'
					})
				)
				.mockResolvedValueOnce(Response.json({ id, display_name: 'Dummy', images: [] }));
			if (id === 'permitted-user') {
				await startUserSession(f.event, 'dummy-code', request);
				expect(hasHostedSession(f.event)).toBe(true);
				expect(await getAccessToken(f.event)).toBe('access');
			} else {
				await expect(startUserSession(f.event, 'dummy-code', request)).rejects.toMatchObject({
					status: 403,
					body: { message: 'Spotify account is not permitted' }
				});
				expect(f.writes).toEqual([]);
			}
			expect(request).toHaveBeenCalledTimes(2);
			const tokenBody = request.mock.calls[0][1].body as URLSearchParams;
			expect(tokenBody.get('redirect_uri')).toBe(STAGING_ORIGIN + '/login');
			expect(request.mock.calls[1][0]).toBe('https://api.spotify.com/v1/me');
		}
	);

	it('fails closed without token cookies if identity verification fails', async () => {
		const f = fixture('/login');
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					access_token: 'access',
					refresh_token: 'refresh',
					expires_in: 3600,
					token_type: 'Bearer'
				})
			)
			.mockRejectedValueOnce(new Error('untrusted upstream payload'));
		await expect(startUserSession(f.event, 'dummy-code', request)).rejects.toBeDefined();
		expect(f.writes).toEqual([]);
	});

	it('removes authorization proof on logout', async () => {
		const f = fixture('/logout', 'POST', STAGING_ORIGIN);
		authorize(f);
		await expect(logout(f.event as Parameters<typeof logout>[0])).rejects.toMatchObject({
			status: 303
		});
		expect(hasHostedSession(f.event)).toBe(false);
		expect(f.values.has(HOSTED_SESSION_COOKIE)).toBe(false);
	});

	it('refreshes only a proved session and rebinds both rotated tokens', async () => {
		const f = fixture();
		authorize(f);
		f.values.delete(ACCESS_TOKEN_KEY);
		const request = vi.fn().mockResolvedValue(
			Response.json({
				access_token: 'rotated-access',
				refresh_token: 'rotated-refresh',
				expires_in: 3600,
				token_type: 'Bearer'
			})
		);
		vi.stubGlobal('fetch', request);
		expect(await getAccessToken(f.event)).toBe('rotated-access');
		expect(request).toHaveBeenCalledOnce();
		expect(hasHostedSession(f.event)).toBe(true);
		f.values.set(REFRESH_TOKEN_KEY, 'unbound-refresh');
		await expect(getAccessToken(f.event)).rejects.toMatchObject({ status: 401 });
		expect(request).toHaveBeenCalledOnce();
	});

	it('never opens the local persistent cache in hosted mode', async () => {
		vi.stubEnv('NTS_HOSTED_STAGING', '1');
		const cache = createDefaultSpotifyMatchCache();
		await expect(cache.get({} as never)).resolves.toBeNull();
		await expect(cache.set({} as never, {} as never)).resolves.toBeUndefined();
		await expect(cache.flush()).resolves.toBeUndefined();
	});
});
