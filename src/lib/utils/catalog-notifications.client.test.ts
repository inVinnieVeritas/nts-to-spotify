import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { notificationDeviceState, prepareNotificationWorker } from './catalog-notifications.client';
import { Script } from 'node:vm';
describe('notification-only service worker', () => {
	it('deduplicates concurrent messages locally without fetching or persisting catalogue progress', async () => {
		const handlers = new Map<string, (event: unknown) => void>();
		const seen = new Map<string, Response>();
		const notifications = vi.fn(async (_title: string, _options: unknown) => {});
		const open = vi.fn(async () => {});
		const cache = {
			match: async (r: Request) => seen.get(r.url),
			put: async (r: Request, value: Response) => {
				seen.set(r.url, value);
			},
			keys: async () => [...seen.keys()].map((url) => new Request(url)),
			delete: async (r: Request) => seen.delete(r.url)
		};
		new Script(readFileSync('static/notifications-worker.js', 'utf8')).runInNewContext({
			self: {
				location: { origin: 'https://nts2spotify.vincentvanderveken.com' },
				addEventListener: (type: string, handler: (e: unknown) => void) =>
					handlers.set(type, handler),
				registration: { showNotification: notifications }
			},
			caches: { open: async () => cache },
			clients: { openWindow: open },
			URL,
			Request,
			Response,
			Promise
		});
		const tasks: Promise<void>[] = [];
		const payload = { id: 'a'.repeat(64), showAlias: 'dimension-door', kind: 'matches-ready' };
		const push = (body: unknown) =>
			handlers.get('push')!({
				data: { json: () => body },
				waitUntil: (p: Promise<void>) => tasks.push(p)
			});
		push(payload);
		push(payload);
		push({ ...payload, id: 'bad' });
		await Promise.all(tasks);
		expect(notifications).toHaveBeenCalledTimes(1);
		expect(notifications.mock.calls[0][1]).toMatchObject({ tag: payload.id, renotify: false });
		expect(handlers.has('fetch')).toBe(false);
		expect(seen.size).toBe(1);
		handlers.get('notificationclick')!({
			notification: { close: () => {}, data: { showAlias: 'dimension-door' } },
			waitUntil: () => {}
		});
		expect(open).toHaveBeenCalledWith('/shows/dimension-door');
		push({ id: 'b'.repeat(64), kind: 'test' });
		push({ id: 'b'.repeat(64), kind: 'test' });
		await Promise.all(tasks);
		expect(notifications).toHaveBeenCalledTimes(2);
		expect(notifications.mock.calls[1][1]).toMatchObject({
			body: 'Test notification received. Notifications work on this device.',
			data: { test: true }
		});
		handlers.get('notificationclick')!({
			notification: { close: () => {}, data: { test: true } },
			waitUntil: () => {}
		});
		expect(open).toHaveBeenLastCalledWith('/');
	});
});

describe('this browser registration state', () => {
	const endpoint = 'https://fcm.googleapis.com/fcm/send/pixel-fixture';
	const id = createHash('sha256').update(endpoint).digest('hex');
	it('requires permission, the local subscription and its exact saved device ID', async () => {
		expect(await notificationDeviceState('granted', endpoint, [{ id }])).toEqual({
			status: 'registered',
			id
		});
		expect(await notificationDeviceState('granted', endpoint, [{ id: 'b'.repeat(64) }])).toEqual({
			status: 'unregistered',
			id: null
		});
		expect(await notificationDeviceState('granted', null, [{ id }])).toEqual({
			status: 'unregistered',
			id: null
		});
		expect(await notificationDeviceState('default', endpoint, [{ id }])).toEqual({
			status: 'unregistered',
			id: null
		});
		expect(await notificationDeviceState('denied', endpoint, [{ id }])).toEqual({
			status: 'blocked',
			id: null
		});
	});
	it('waits for the newly installed notification worker instead of using the old active worker', async () => {
		const worker = new EventTarget() as EventTarget & { state: string };
		worker.state = 'installing';
		const registration = { installing: worker, waiting: null, active: { state: 'activated' } };
		const register = vi.fn(async () => registration);
		vi.stubGlobal('navigator', { serviceWorker: { register } });
		try {
			let finished = false;
			const pending = prepareNotificationWorker().then((value) => {
				finished = true;
				return value;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(finished).toBe(false);
			worker.state = 'activated';
			worker.dispatchEvent(new Event('statechange'));
			expect(await pending).toBe(registration);
			expect(register).toHaveBeenCalledWith('/notifications-worker.js', {
				scope: '/',
				updateViaCache: 'none'
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
