import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/nts.server', () => ({ getNTSShowCatalog: vi.fn() }));

import { getNTSShowCatalog } from '$lib/utils/nts.server';
import { POST } from './+server';

const validCatalog = {
	showAlias: 'test-show',
	name: 'Test Show',
	description: 'Description',
	cover: '',
	episodes: [
		{
			episodeAlias: 'episode-one',
			name: 'Episode One',
			broadcast: '2026-01-01T00:00:00.000Z',
			cover: '',
			genres: []
		}
	]
};

const requestFor = (body: unknown = { showAlias: 'test-show' }) =>
	new Request('http://localhost/api/nts/catalogue', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getNTSShowCatalog).mockResolvedValue(validCatalog);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('saved catalogue NTS update endpoint', () => {
	it('returns a validated catalogue without invoking Spotify', async () => {
		const fetcher = vi.fn();
		const response = await POST({ request: requestFor(), fetch: fetcher } as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ catalog: validCatalog });
		expect(getNTSShowCatalog).toHaveBeenCalledWith('test-show', fetcher, expect.any(AbortSignal));
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects malformed requests and malformed NTS catalogues', async () => {
		const invalidRequest = await POST({
			request: requestFor({ showAlias: '../private' }),
			fetch
		} as never);
		expect(invalidRequest.status).toBe(400);
		expect(await invalidRequest.json()).toEqual({ error: 'invalid_request' });
		expect(getNTSShowCatalog).not.toHaveBeenCalled();

		vi.mocked(getNTSShowCatalog).mockResolvedValueOnce({
			...validCatalog,
			episodes: [{}]
		} as never);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const malformed = await POST({ request: requestFor(), fetch } as never);
		expect(malformed.status).toBe(502);
		expect(await malformed.json()).toEqual({ error: 'nts_catalogue_unavailable' });
		expect(consoleError).toHaveBeenCalledWith(
			'Saved catalogue update check failed',
			'nts_catalogue_unavailable'
		);
	});

	it('returns sanitized network failures without exposing raw thrown properties', async () => {
		vi.mocked(getNTSShowCatalog).mockRejectedValueOnce(
			Object.assign(new TypeError('PRIVATE_NETWORK_MESSAGE'), {
				token: 'PRIVATE_TOKEN',
				url: 'https://private.example/PRIVATE_QUERY'
			})
		);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const response = await POST({ request: requestFor(), fetch } as never);
		const body = await response.json();
		expect(response.status).toBe(502);
		expect(body).toEqual({ error: 'nts_catalogue_unavailable' });
		expect(consoleError).toHaveBeenCalledWith(
			'Saved catalogue update check failed',
			'nts_catalogue_unavailable'
		);
		expect(JSON.stringify({ body, logs: consoleError.mock.calls })).not.toContain('PRIVATE');
	});

	it('enforces a finite route deadline', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(getNTSShowCatalog).mockImplementationOnce(
			(_showAlias, _fetcher, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener(
						'abort',
						() => {
							const cause = new Error('cancelled');
							cause.name = 'AbortError';
							reject(cause);
						},
						{ once: true }
					);
				})
		);

		const pending = POST({ request: requestFor(), fetch } as never);
		await vi.advanceTimersByTimeAsync(30_000);
		const response = await pending;
		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: 'nts_catalogue_timeout' });
	});
});
