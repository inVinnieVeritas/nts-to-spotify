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
		expect(setHeaders).toHaveBeenCalledWith({
			'Retry-After': '30785',
			'X-Spotify-Rate-Limit-Reason': 'rate-limited'
		});
	});

	it('returns a distinct sanitized 429 for Development Mode quota exhaustion', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(mapWithConcurrency).mockRejectedValue({
			name: 'SpotifyRateLimitError',
			retryAfterSeconds: 30_785,
			reason: 'quota-exceeded'
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
			body: {
				message:
					'Spotify Development Mode quota exhausted. Try again after the Retry-After interval.'
			}
		});
		expect(setHeaders).toHaveBeenCalledWith({
			'Retry-After': '30785',
			'X-Spotify-Rate-Limit-Reason': 'quota-exceeded'
		});
	});

	it('returns a sanitized 502 for a systemic Spotify response failure', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(mapWithConcurrency).mockRejectedValue({
			name: 'SpotifyResponseValidationError',
			privateUpstreamValue: 'must not be exposed'
		});
		const fetcher = vi.fn(async () => new Response('<html></html>', { status: 200 }));

		await expect(
			load({
				params: { show: 'show', episode: 'episode' },
				fetch: fetcher,
				request: new Request('http://localhost/shows/show/episodes/episode'),
				setHeaders: vi.fn()
			} as never)
		).rejects.toMatchObject({
			status: 502,
			body: { message: 'Spotify returned an invalid search response. Try again later.' }
		});
	});

	it('returns a sanitized 503 when Spotify Search is unavailable', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(mapWithConcurrency).mockRejectedValue({
			name: 'SpotifySearchUnavailableError',
			reason: 'network',
			privateUpstreamValue: 'must not be exposed'
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
			status: 503,
			body: { message: 'Spotify search is temporarily unavailable. Try again later.' }
		});
		expect(setHeaders).toHaveBeenCalledWith({
			'X-Spotify-Search-Error-Reason': 'network'
		});
	});

	it('never sends raw thrown properties to single-episode logging', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(mapWithConcurrency).mockRejectedValue({
			name: 'PrivateFailure',
			token: 'must-not-be-logged',
			url: 'https://private.example/callback'
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi.fn(async () => new Response('<html></html>', { status: 200 }));
		try {
			await expect(
				load({
					params: { show: 'show', episode: 'episode' },
					fetch: fetcher,
					request: new Request('http://localhost/shows/show/episodes/episode'),
					setHeaders: vi.fn()
				} as never)
			).rejects.toMatchObject({ status: 500 });
			expect(consoleError).toHaveBeenCalledWith('Single-episode load failed', 'unexpected_error');
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('must-not-be-logged');
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private.example');
		} finally {
			consoleError.mockRestore();
		}
	});

	it('returns a fixed missing-configuration response before Spotify Search', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue(null);
		vi.mocked(mapWithConcurrency).mockClear();
		const fetcher = vi.fn(async () => new Response('<html></html>', { status: 200 }));

		await expect(
			load({
				params: { show: 'show', episode: 'episode' },
				fetch: fetcher,
				request: new Request('http://localhost/shows/show/episodes/episode'),
				setHeaders: vi.fn()
			} as never)
		).rejects.toMatchObject({
			status: 503,
			body: { message: 'Spotify application is not configured' }
		});
		expect(mapWithConcurrency).not.toHaveBeenCalled();
	});

	it('returns a fixed response for a configured token acquisition failure', async () => {
		vi.mocked(getClientCredentials).mockRejectedValue({
			name: 'SpotifyTokenAcquisitionError',
			reason: 'upstream',
			access_token: 'must-not-be-exposed'
		});
		const fetcher = vi.fn(async () => new Response('<html></html>', { status: 200 }));
		let failure: unknown;
		try {
			await load({
				params: { show: 'show', episode: 'episode' },
				fetch: fetcher,
				request: new Request('http://localhost/shows/show/episodes/episode'),
				setHeaders: vi.fn()
			} as never);
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toMatchObject({
			status: 502,
			body: { message: 'Spotify token service is temporarily unavailable. Try again later.' }
		});
		expect(JSON.stringify(failure)).not.toContain('must-not-be-exposed');
	});
});
