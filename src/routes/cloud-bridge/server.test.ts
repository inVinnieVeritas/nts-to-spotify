import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';

vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: vi.fn(() => ({
		origin: 'https://nts2spotify.vincentvanderveken.com',
		userId: 'owner'
	})),
	hasHostedSession: vi.fn(() => false)
}));

import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';
import { GET } from './+server';

const eventFor = (nonce = 'a'.repeat(64)) =>
	({
		url: new URL(`https://nts2spotify.vincentvanderveken.com/cloud-bridge?nonce=${nonce}`)
	}) as Parameters<typeof GET>[0];

describe('local cloud bridge boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(hostedConfiguration).mockReturnValue({
			origin: 'https://nts2spotify.vincentvanderveken.com',
			userId: 'owner'
		} as ReturnType<typeof hostedConfiguration>);
		vi.mocked(hasHostedSession).mockReturnValue(false);
	});

	it('does not serve a bridge locally or without the owner session', async () => {
		vi.mocked(hostedConfiguration).mockReturnValueOnce(null);
		expect((await GET(eventFor())).status).toBe(404);
		expect((await GET(eventFor())).status).toBe(401);
	});

	it('requires an unguessable connection nonce and restricts the target origin', async () => {
		vi.mocked(hasHostedSession).mockReturnValue(true);
		expect((await GET(eventFor('bad'))).status).toBe(400);
		const response = await GET(eventFor());
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('const localOrigin = "http://127.0.0.1:5173"');
		expect(html).toContain('event.origin !== localOrigin');
		expect(html).toContain('event.source !== window.opener');
		expect(html).toContain('message.nonce !== nonce');
		const inlineScript = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1];
		expect(inlineScript).toBeTruthy();
		expect(() => new Script(inlineScript ?? '')).not.toThrow();
		expect(inlineScript).toContain("message.method === 'PUT'");
		expect(html).not.toContain('client_secret');
		expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('allows only approved catalogue requests from the exact local window', async () => {
		vi.mocked(hasHostedSession).mockReturnValue(true);
		const html = await (await GET(eventFor())).text();
		const script = new Script(html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1] ?? '');
		const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
		const opener = { postMessage: vi.fn() };
		const request = vi.fn(async () => ({ status: 200, json: async () => ({ catalogues: [] }) }));
		const button = {
			disabled: false,
			addEventListener: (_type: string, handler: () => void) => handlers.set('click', handler)
		};
		script.runInNewContext({
			window: {
				opener,
				addEventListener: (_type: string, handler: (event: unknown) => Promise<void>) =>
					handlers.set('message', handler)
			},
			document: {
				getElementById: (id: string) => (id === 'connect' ? button : { textContent: '' })
			},
			fetch: request,
			Number,
			JSON
		});
		const message = (path: string, origin = 'http://127.0.0.1:5173', source: unknown = opener) =>
			handlers.get('message')?.({
				origin,
				source,
				data: {
					type: 'nts-cloud-bridge-request',
					nonce: 'a'.repeat(64),
					id: 1,
					method: 'GET',
					path
				}
			});
		await message('/api/catalog-progress');
		expect(request).not.toHaveBeenCalled();
		handlers.get('click')?.({});
		await message('/api/catalog-progress', 'http://evil.example');
		await message('/api/catalog-progress', 'http://127.0.0.1:5173', {});
		await message('/api/catalog-progress/../../admin');
		expect(request).not.toHaveBeenCalled();
		await message('/api/catalog-progress/channeling');
		expect(request).toHaveBeenCalledOnce();
	});
});
