import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	bridgeRequest,
	connectLocalCloud,
	localCloudConnected,
	localCloudOwnerMatches
} from './catalog-cloud-bridge.client';

afterEach(() => vi.unstubAllGlobals());

describe('local cloud bridge', () => {
	it('accepts only the hosted popup and rejects pending work when reconnecting', async () => {
		vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
		const firstPopup = { closed: false, postMessage: vi.fn(), close: vi.fn() };
		const secondPopup = { closed: false, postMessage: vi.fn(), close: vi.fn() };
		const open = vi.fn().mockReturnValueOnce(firstPopup).mockReturnValueOnce(secondPopup);
		let receive: ((event: MessageEvent) => void) | undefined;
		const addEventListener = vi.fn((_type: string, handler: (event: MessageEvent) => void) => {
			receive = handler;
		});
		vi.stubGlobal('window', { open, addEventListener, dispatchEvent: vi.fn() });

		expect(connectLocalCloud()).toBe(true);
		const nonce = new URL(open.mock.calls[0][0]).searchParams.get('nonce');
		expect(nonce).toMatch(/^[0-9a-f]{64}$/);
		expect(firstPopup.postMessage).not.toHaveBeenCalled();
		const ready = { type: 'nts-cloud-bridge-ready', nonce, ownerId: 'owner' };
		receive?.({
			origin: 'https://evil.example',
			source: firstPopup,
			data: ready
		} as unknown as MessageEvent);
		receive?.({
			origin: 'https://nts2spotify.vincentvanderveken.com',
			source: secondPopup,
			data: ready
		} as unknown as MessageEvent);
		expect(localCloudConnected()).toBe(false);
		receive?.({
			origin: 'https://nts2spotify.vincentvanderveken.com',
			source: firstPopup,
			data: ready
		} as unknown as MessageEvent);
		expect(localCloudOwnerMatches('someone-else')).toBe(false);
		expect(localCloudOwnerMatches('owner')).toBe(true);

		const response = bridgeRequest('GET', '/api/catalog-progress');
		const sent = firstPopup.postMessage.mock.calls[0];
		expect(sent[1]).toBe('https://nts2spotify.vincentvanderveken.com');
		expect(sent[0]).toMatchObject({ type: 'nts-cloud-bridge-request', nonce, method: 'GET' });
		receive?.({
			origin: 'https://nts2spotify.vincentvanderveken.com',
			source: firstPopup,
			data: { type: 'nts-cloud-bridge-response', nonce, id: sent[0].id, status: 200, body: [] }
		} as unknown as MessageEvent);
		await expect(response).resolves.toEqual({ status: 200, body: [] });

		const pending = bridgeRequest('GET', '/api/catalog-progress');
		firstPopup.closed = true;
		expect(connectLocalCloud()).toBe(true);
		await expect(pending).rejects.toThrow('Invalid bridge reply');
		expect(addEventListener).toHaveBeenCalledTimes(1);
		expect(localCloudConnected()).toBe(false);
	});
});
