import { describe, expect, it, vi } from 'vitest';
import {
	isSpotifyRateLimitError,
	parseRetryAfter,
	searchSpotifyTrack,
	SPOTIFY_SEARCH_INTERVAL_MS,
	SpotifyRateLimitError
} from './spotify.server';
import type { Fetcher } from './request';

describe('Spotify rate limiting', () => {
	it('parses delta seconds and HTTP dates and rejects invalid values', () => {
		const now = Date.parse('2026-08-14T12:00:00Z');
		expect(parseRetryAfter('12', now)).toBe(12);
		expect(parseRetryAfter('2.2', now)).toBe(3);
		expect(parseRetryAfter('Fri, 14 Aug 2026 12:00:09 GMT', now)).toBe(9);
		expect(parseRetryAfter('invalid', now)).toBe(1);
		expect(parseRetryAfter('-4', now)).toBe(1);
		expect(parseRetryAfter('7201', now)).toBe(7201);
	});

	it('recognizes real and structurally equivalent rate-limit errors only', () => {
		expect(isSpotifyRateLimitError(new SpotifyRateLimitError(17))).toBe(true);
		expect(isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: 17 })).toBe(
			true
		);
		expect(
			isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: '17' })
		).toBe(false);
		expect(isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: 0 })).toBe(
			false
		);
		expect(isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: 1.5 })).toBe(
			false
		);
		expect(isSpotifyRateLimitError({ name: 'Error', retryAfterSeconds: 17 })).toBe(false);
	});

	it('holds queue concurrency until the complete response body is consumed', async () => {
		vi.useFakeTimers();
		try {
			let firstBody: ReadableStreamDefaultController<Uint8Array> | undefined;
			const responseBody = JSON.stringify({
				tracks: {
					items: [
						{
							artists: [{ name: 'Artist' }],
							name: 'Track',
							uri: 'spotify:track:one',
							preview_url: null,
							album: { images: [] },
							external_urls: { spotify: 'https://example.test/track' }
						}
					]
				}
			});
			const requestMock = vi.fn(async () => {
				if (requestMock.mock.calls.length === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								firstBody = controller;
							}
						})
					);
				}
				return new Response(responseBody);
			});
			const request = requestMock as unknown as Fetcher;

			const first = searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request);
			await vi.advanceTimersByTimeAsync(0);
			const second = searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request);
			await vi.advanceTimersByTimeAsync(0);
			expect(request).toHaveBeenCalledTimes(1);

			firstBody?.enqueue(new TextEncoder().encode(responseBody));
			firstBody?.close();
			await vi.advanceTimersByTimeAsync(750);
			await Promise.all([first, second]);
			expect(request).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails queued and subsequent searches fast during an existing cooldown', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			async () => new Response('{}', { status: 429, headers: { 'Retry-After': '17' } })
		) as unknown as Fetcher;

		try {
			const first = searchSpotifyTrack(
				{ artist: 'Artist', title: 'First' },
				'redacted-token',
				request
			);
			const queued = searchSpotifyTrack(
				{ artist: 'Artist', title: 'Queued' },
				'redacted-token',
				request
			);
			const settled = Promise.allSettled([first, queued]);
			await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS * 2 + 1);
			const results = await settled;

			expect(results).toHaveLength(2);
			for (const result of results) {
				expect(result.status).toBe('rejected');
				if (result.status === 'rejected') {
					expect(result.reason).toBeInstanceOf(SpotifyRateLimitError);
					expect(result.reason.retryAfterSeconds).toBe(17);
				}
			}
			expect(request).toHaveBeenCalledTimes(1);

			await expect(
				searchSpotifyTrack({ artist: 'Artist', title: 'Subsequent' }, 'redacted-token', request)
			).rejects.toMatchObject({ name: 'SpotifyRateLimitError', retryAfterSeconds: 17 });
			expect(request).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
