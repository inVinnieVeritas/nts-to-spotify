import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
	authorized: false,
	connect: vi.fn(),
	disconnect: vi.fn(),
	configure: vi.fn()
}));
vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	}),
	hasHostedSession: () => mocks.authorized
}));
vi.mock('$lib/utils/catalog-schedule-store.server', () => ({ schedulesEnabled: () => true }));
vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: async () => 'dummy-access' }));
vi.mock('$lib/utils/playlist-authorization.server', () => ({
	PlaylistAuthorization: class {
		connect = mocks.connect;
		disconnect = mocks.disconnect;
		connected = async () => false;
	}
}));
vi.mock('$lib/utils/catalog-playlist-automation.server', () => ({
	AutomaticPlaylistService: class {
		configure = mocks.configure;
		get = async () => null;
	},
	publicAutomaticPlaylistState: (v: unknown) => v
}));
import { GET, POST } from './+server';
import { PUT as settings } from '../catalog-playlist-automation/[show]/+server';
const event = (
	method = 'POST',
	body: unknown = { operation: 'connect' },
	origin = 'https://nts2spotify.vincentvanderveken.com'
) =>
	({
		params: { show: 'dimension-door' },
		cookies: { get: () => 'dummy-refresh' },
		request: new Request('https://nts2spotify.vincentvanderveken.com/api/playlist-authorization', {
			method,
			headers: { 'Content-Type': 'application/json', Origin: origin },
			...(method === 'GET' ? {} : { body: JSON.stringify(body) })
		})
	}) as unknown as RequestEvent;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.authorized = false;
});
describe('background authorization and settings boundary', () => {
	it('requires the permitted signed session before any credential storage or settings access', async () => {
		expect((await GET(event('GET'))).status).toBe(401);
		expect((await POST(event())).status).toBe(401);
		expect((await settings(event('PUT', { enabled: true, confirmAppCreated: true }))).status).toBe(
			401
		);
		expect(mocks.connect).not.toHaveBeenCalled();
		expect(mocks.configure).not.toHaveBeenCalled();
	});
	it('rejects cross-origin writes even with an owner session', async () => {
		mocks.authorized = true;
		expect((await POST(event('POST', { operation: 'connect' }, 'https://evil.test'))).status).toBe(
			403
		);
		expect(mocks.connect).not.toHaveBeenCalled();
	});
	it('explicitly connects/disconnects and returns only sanitized connection state', async () => {
		mocks.authorized = true;
		const response = await POST(event());
		expect(await response.json()).toEqual({ connected: true });
		expect(mocks.connect).toHaveBeenCalledWith(
			'dummy-access',
			'dummy-refresh',
			expect.any(AbortSignal)
		);
		expect(await (await POST(event('POST', { operation: 'disconnect' }))).json()).toEqual({
			connected: false
		});
		expect(mocks.disconnect).toHaveBeenCalledOnce();
	});
	it('never serializes thrown refresh tokens or raw errors', async () => {
		mocks.authorized = true;
		mocks.connect.mockRejectedValueOnce({
			token: 'secret',
			url: 'private',
			headers: { Authorization: 'private' }
		});
		const response = await POST(event());
		expect(await response.json()).toEqual({ error: 'authorization_unavailable' });
	});
	it('does not enable automation through malformed settings', async () => {
		mocks.authorized = true;
		expect((await settings(event('PUT', { enabled: true }))).status).toBe(400);
		expect(mocks.configure).not.toHaveBeenCalled();
	});
});
