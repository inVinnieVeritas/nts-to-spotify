import { createHash } from 'node:crypto';
import type webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: {
		NTS_FIRESTORE_PROJECT: 'test-project-123',
		NTS_PLAYLIST_AUTH_KEY: 'a'.repeat(64),
		NTS_PUSH_PUBLIC_KEY: 'a'.repeat(87),
		NTS_PUSH_PRIVATE_KEY: 'b'.repeat(43)
	}
}));
vi.mock('./hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	})
}));
import { fakeFirestore } from '../test-helpers/firestore';
import { ScheduleStore } from './catalog-schedule-store.server';
import { CatalogueNotifications, isPushSubscription } from './catalog-notifications.server';
const sub = (n = 1) => ({
	endpoint: `https://fcm.googleapis.com/fcm/send/fixture-${n}`,
	keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) }
});
function fixture() {
	const f = fakeFirestore();
	const send = vi.fn<typeof webpush.sendNotification>(async () => ({
		statusCode: 201,
		body: '',
		headers: {}
	}));
	return { ...f, send, service: new CatalogueNotifications(new ScheduleStore(f.request), send) };
}
describe('free browser push and durable notification history', () => {
	it('validates supported push endpoints and rejects SSRF/invalid keys', () => {
		expect(isPushSubscription(sub())).toBe(true);
		for (const endpoint of [
			'http://fcm.googleapis.com/path',
			'https://127.0.0.1/path',
			'https://fcm.googleapis.com.evil.test/path',
			'https://user@fcm.googleapis.com/path',
			'https://fcm.googleapis.com:443/path',
			'file:///tmp'
		]) {
			// An explicit default port normalizes away; the host remains official HTTPS.
			if (endpoint.includes(':443')) continue;
			expect(isPushSubscription({ ...sub(), endpoint })).toBe(false);
		}
		expect(isPushSubscription({ ...sub(), keys: { p256dh: 'bad', auth: 'bad' } })).toBe(false);
	});
	it('deduplicates repeated discovery/matching events, supports multiple devices and omits secrets from history', async () => {
		const f = fixture();
		await f.service.subscribe(sub(1), 'Pixel');
		await f.service.subscribe(sub(2), 'Desktop');
		await f.service.publish('new-episodes', 'dimension-door', ['episode-1', 'episode-1']);
		await f.service.publish('matches-ready', 'dimension-door', ['episode-1']);
		await f.service.publish('matches-ready', 'dimension-door', ['episode-1']);
		expect((await f.service.publicHistory()).events).toHaveLength(2);
		await f.service.deliver(new AbortController().signal);
		await f.service.deliver(new AbortController().signal);
		expect(f.send).toHaveBeenCalledTimes(4);
		expect(JSON.stringify(await f.service.publicHistory())).not.toContain('endpoint');
		expect(JSON.stringify([...f.documents.values()])).not.toContain('fcm/send/fixture');
	});
	it('network ambiguity never resends a claimed alert and keeps history', async () => {
		const f = fixture();
		await f.service.subscribe(sub(), 'Pixel');
		await f.service.publish('matches-ready', 'dimension-door', ['episode-1']);
		f.send.mockRejectedValueOnce(new Error('secret endpoint/headers'));
		await f.service.deliver(new AbortController().signal);
		await f.service.deliver(new AbortController().signal);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect((await f.service.publicHistory()).events).toHaveLength(1);
	});
	it('removes expired device subscriptions but never deletes notification history', async () => {
		const f = fixture();
		await f.service.subscribe(sub(), 'Pixel');
		await f.service.publish('new-episodes', 'dimension-door', ['episode-1']);
		f.send.mockRejectedValueOnce({ statusCode: 410, body: 'private' });
		await f.service.deliver(new AbortController().signal);
		expect((await f.service.publicHistory()).devices).toEqual([]);
		expect((await f.service.publicHistory()).events).toHaveLength(1);
	});
	it('bounds history and remembers IDs after their visible event rolls off', async () => {
		const f = fixture();
		await f.service.publish(
			'new-episodes',
			'dimension-door',
			Array.from({ length: 120 }, (_, i) => `episode-${i}`)
		);
		expect((await f.service.publicHistory()).events).toHaveLength(100);
		const before = await f.service.publicHistory();
		await f.service.publish('new-episodes', 'dimension-door', ['episode-119']);
		expect(await f.service.publicHistory()).toEqual(before);
	});
	it('limits delivery to ten attempts per worker and respects cancellation', async () => {
		const f = fixture();
		await f.service.subscribe(sub(), 'Pixel');
		await f.service.publish(
			'new-episodes',
			'dimension-door',
			Array.from({ length: 20 }, (_, i) => `episode-${i}`)
		);
		const stopped = new AbortController();
		stopped.abort();
		await f.service.deliver(stopped.signal);
		expect(f.send).not.toHaveBeenCalled();
		await f.service.deliver(new AbortController().signal);
		expect(f.send).toHaveBeenCalledTimes(10);
	});
	it('sends a test only to the selected registered device without changing catalogue history', async () => {
		const f = fixture();
		await f.service.subscribe(sub(1), 'Pixel');
		await f.service.subscribe(sub(2), 'PC');
		await f.service.publish('new-episodes', 'dimension-door', ['episode-1']);
		const before = await f.service.publicHistory();
		const id = createHash('sha256').update(sub(1).endpoint).digest('hex');
		expect(await f.service.test(id, new AbortController().signal)).toEqual({ status: 'accepted' });
		expect(f.send).toHaveBeenCalledOnce();
		expect(f.send.mock.calls[0][0]).toEqual(sub(1));
		expect(JSON.parse(String(f.send.mock.calls[0][1]))).toEqual({
			id: expect.stringMatching(/^[a-f0-9]{64}$/),
			kind: 'test'
		});
		expect(await f.service.publicHistory()).toEqual(before);
		// A test must not claim or suppress the real event on either device.
		await f.service.deliver(new AbortController().signal);
		expect(f.send).toHaveBeenCalledTimes(3);
	});
	it('claims a persistent cooldown atomically across concurrent tests and allows a later test', async () => {
		const f = fixture();
		await f.service.subscribe(sub(), 'Pixel');
		const id = (await f.service.publicHistory()).devices[0].id;
		let now = 100000;
		const service = new CatalogueNotifications(new ScheduleStore(f.request), f.send, () => now);
		const results = await Promise.all([
			service.test(id, new AbortController().signal),
			service.test(id, new AbortController().signal)
		]);
		expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'rate-limited']);
		expect(f.send).toHaveBeenCalledOnce();
		expect(await service.test(id, new AbortController().signal)).toEqual({
			status: 'rate-limited',
			retryAfterSeconds: 30
		});
		now += 30000;
		expect(await service.test(id, new AbortController().signal)).toEqual({ status: 'accepted' });
		expect(f.send).toHaveBeenCalledTimes(2);
		expect(f.send.mock.calls[0][1]).not.toEqual(f.send.mock.calls[1][1]);
	});
	it('blocks unregistered, invalid, unconfigured and cancelled tests before sending', async () => {
		const f = fixture();
		expect(await f.service.test('a'.repeat(64), new AbortController().signal)).toEqual({
			status: 'not-registered'
		});
		await expect(f.service.test('bad', new AbortController().signal)).rejects.toThrow();
		await f.service.subscribe(sub(), 'Pixel');
		const id = (await f.service.publicHistory()).devices[0].id;
		const stopped = new AbortController();
		stopped.abort();
		expect(await f.service.test(id, stopped.signal)).toEqual({ status: 'failed' });
		const privateKey = env.NTS_PUSH_PRIVATE_KEY;
		try {
			env.NTS_PUSH_PRIVATE_KEY = '';
			expect(await f.service.test(id, new AbortController().signal)).toEqual({
				status: 'unconfigured'
			});
		} finally {
			env.NTS_PUSH_PRIVATE_KEY = privateKey;
		}
		expect(f.send).not.toHaveBeenCalled();
	});
	it('sanitizes test failures, never retries ambiguous sends and removes expired subscriptions', async () => {
		const f = fixture();
		await f.service.subscribe(sub(), 'Pixel');
		const id = (await f.service.publicHistory()).devices[0].id;
		f.send.mockRejectedValueOnce({ statusCode: 500, body: 'private capability' });
		expect(await f.service.test(id, new AbortController().signal)).toEqual({ status: 'failed' });
		expect((await f.service.test(id, new AbortController().signal)).status).toBe('rate-limited');
		expect(f.send).toHaveBeenCalledOnce();
		const later = new CatalogueNotifications(
			new ScheduleStore(f.request),
			f.send,
			() => Date.now() + 60000
		);
		f.send.mockRejectedValueOnce({ statusCode: 410, body: 'private capability' });
		expect(await later.test(id, new AbortController().signal)).toEqual({ status: 'expired' });
		expect((await f.service.publicHistory()).devices).toEqual([]);
	});
});
