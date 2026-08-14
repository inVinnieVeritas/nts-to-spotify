import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/spotify.server', async () => {
	const actual = await vi.importActual<typeof import('$lib/utils/spotify.server')>(
		'$lib/utils/spotify.server'
	);
	return {
		...actual,
		getClientCredentials: vi.fn(),
		mapWithConcurrency: vi.fn(),
		searchSpotifyTrack: vi.fn()
	};
});

import { getClientCredentials, mapWithConcurrency } from '$lib/utils/spotify.server';
import { load } from './+page.server';

describe('single-episode route deadline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('times out when the NTS response body stalls after headers', async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const fetcher = vi.fn(
				async () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
			);
			const loading = load({
				params: { show: 'show', episode: 'episode' },
				fetch: fetcher,
				request: new Request('http://localhost/shows/show/episodes/episode')
			} as never);
			const expectation = expect(loading).rejects.toMatchObject({ status: 500 });

			await vi.advanceTimersByTimeAsync(20_000);
			await expectation;
			expect(fetcher).toHaveBeenCalledOnce();
		} finally {
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});

	it('returns a sanitized 429 with Retry-After for Spotify rate limits', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(mapWithConcurrency).mockRejectedValue({
			name: 'SpotifyRateLimitError',
			retryAfterSeconds: 30_785
		});
		const setHeaders = vi.fn();
		const fetcher = vi.fn(async () => new Response('<html></html>', { status: 200 }));

		await expect(
			load({
				params: { show: 'show', episode: 'episode' },
				fetch: fetcher,
				request: new Request('http://localhost/shows/show/episodes/episode'),
				setHeaders
			} as never)
		).rejects.toMatchObject({
			status: 429,
			body: { message: 'Spotify rate limited. Try again after the Retry-After interval.' }
		});
		expect(setHeaders).toHaveBeenCalledWith({ 'Retry-After': '30785' });
	});
});
