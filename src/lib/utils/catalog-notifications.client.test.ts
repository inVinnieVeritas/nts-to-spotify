import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
	});
});
