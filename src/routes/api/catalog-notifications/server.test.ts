import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ authorized: false, test: vi.fn() }));
vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	}),
	hasHostedSession: () => mocks.authorized
}));
vi.mock('$lib/utils/catalog-schedule-store.server', () => ({ schedulesEnabled: () => true }));
vi.mock('$lib/utils/catalog-notifications.server', () => ({
	CatalogueNotifications: class {
		test = mocks.test;
	}
}));
import { POST } from './+server';
const event = (origin = 'https://nts2spotify.vincentvanderveken.com') =>
	({
		request: new Request('https://nts2spotify.vincentvanderveken.com/api/catalog-notifications', {
			method: 'POST',
			headers: { Origin: origin, 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'test', id: 'a'.repeat(64) })
		})
	}) as unknown as RequestEvent;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.authorized = false;
});
describe('explicit push test endpoint', () => {
	it('rejects signed-out and cross-origin sends before accessing subscriptions', async () => {
		expect((await POST(event())).status).toBe(401);
		mocks.authorized = true;
		expect((await POST(event('https://evil.test'))).status).toBe(403);
		expect(mocks.test).not.toHaveBeenCalled();
	});
	it('dispatches one explicit test and returns only a safe result', async () => {
		mocks.authorized = true;
		mocks.test.mockResolvedValueOnce({ status: 'accepted' });
		expect(await (await POST(event())).json()).toEqual({ status: 'accepted' });
		expect(mocks.test).toHaveBeenCalledWith('a'.repeat(64), expect.any(AbortSignal));
	});
	it('never exposes raw push errors or subscription endpoints', async () => {
		mocks.authorized = true;
		mocks.test.mockRejectedValueOnce({ endpoint: 'private', headers: 'private' });
		const response = await POST(event());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'notifications_unavailable' });
	});
});
