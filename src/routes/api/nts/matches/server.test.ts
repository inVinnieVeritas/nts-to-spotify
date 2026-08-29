import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn() }));
vi.mock('$lib/utils/nts.server', () => ({ getNTSEpisodeTracklist: vi.fn() }));
vi.mock('$lib/utils/spotify.server', async () => {
	const actual = await vi.importActual<typeof import('$lib/utils/spotify.server')>(
		'$lib/utils/spotify.server'
	);
	return { ...actual, getClientCredentials: vi.fn() };
});

import { getAccessToken } from '$lib/utils/auth.server';
import { getNTSEpisodeTracklist } from '$lib/utils/nts.server';
import { getClientCredentials, resetSpotifyServerSessionForTests } from '$lib/utils/spotify.server';
import { POST } from './+server';

const DUPLICATED_ENSEMBLE_ARTIST = Array.from(
	{ length: 24 },
	() => 'Brown Ensemble, Fizzled Out Players'
).join(', ');

const expectMetricSums = (metrics: Record<string, number>) => {
	expect(metrics.primarySearchRequests + metrics.fallbackSearchRequests).toBe(
		metrics.searchRequests
	);
	expect(metrics.primaryPersistentCacheHits + metrics.fallbackPersistentCacheHits).toBe(
		metrics.persistentCacheHits
	);
};

describe('/api/nts/matches rate-limit response', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		resetSpotifyServerSessionForTests();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(getNTSEpisodeTracklist).mockResolvedValue([{ artist: 'Artist', title: 'Track' }]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns sanitized quota 429 responses with metrics and fails fast during cooldown', async () => {
		const spotifyFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { reason: 'QUOTA_EXCEEDED', message: 'private' } }), {
					status: 429,
					headers: { 'Retry-After': '30785' }
				})
		);
		const makeRequest = () =>
			new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			});

		const response = await POST({ request: makeRequest(), fetch: spotifyFetch } as never);
		const body = await response.json();

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('30785');
		expect(body).toEqual({
			error: 'spotify_rate_limited',
			retryAfterSeconds: 30_785,
			reason: 'quota-exceeded',
			spotifySessionMetrics: {
				searchRequests: 1,
				primarySearchRequests: 1,
				fallbackSearchRequests: 0,
				cacheHits: 0,
				persistentCacheHits: 0,
				primaryPersistentCacheHits: 0,
				fallbackPersistentCacheHits: 0,
				transientRetries: 0,
				rateLimitResponses: 0,
				quotaExceededResponses: 1
			}
		});
		expect(JSON.stringify(body)).not.toContain('private');
		expect(spotifyFetch).toHaveBeenCalledOnce();

		const repeatedResponse = await POST({ request: makeRequest(), fetch: spotifyFetch } as never);
		const repeatedBody = await repeatedResponse.json();

		expect(repeatedResponse.status).toBe(429);
		expect(repeatedResponse.headers.get('Retry-After')).toBe('30785');
		expect(repeatedBody).toMatchObject({
			error: 'spotify_rate_limited',
			retryAfterSeconds: 30_785,
			reason: 'quota-exceeded',
			spotifySessionMetrics: { searchRequests: 1, quotaExceededResponses: 1 }
		});
		expect(spotifyFetch).toHaveBeenCalledOnce();
	});

	it('includes metrics on successful responses and cache hits without extra HTTP searches', async () => {
		const spotifyFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tracks: {
							items: [
								{
									artists: [{ name: 'Artist' }],
									name: 'Track',
									uri: 'spotify:track:0123456789ABCDEFGHIJKL',
									preview_url: null,
									album: { images: [] },
									external_urls: {
										spotify: 'https://open.spotify.com/track/0123456789ABCDEFGHIJKL'
									}
								}
							]
						}
					})
				)
		);
		const makeRequest = () =>
			new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			});

		const firstBody = await (
			await POST({ request: makeRequest(), fetch: spotifyFetch } as never)
		).json();
		const secondBody = await (
			await POST({ request: makeRequest(), fetch: spotifyFetch } as never)
		).json();

		expect(firstBody.spotifySessionMetrics).toMatchObject({
			searchRequests: 1,
			primarySearchRequests: 1,
			fallbackSearchRequests: 0,
			cacheHits: 0
		});
		expect(secondBody.spotifySessionMetrics).toMatchObject({
			searchRequests: 1,
			primarySearchRequests: 1,
			fallbackSearchRequests: 0,
			cacheHits: 1
		});
		expectMetricSums(firstBody.spotifySessionMetrics);
		expectMetricSums(secondBody.spotifySessionMetrics);
		expect(spotifyFetch).toHaveBeenCalledOnce();
	});

	it('falls back unknown upstream reasons to an ordinary sanitized rate limit', async () => {
		const spotifyFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { reason: 'UNTRUSTED_REASON' } }), {
					status: 429,
					headers: { 'Retry-After': '7201' }
				})
		);
		const response = await POST({
			request: new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('7201');
		expect(await response.json()).toMatchObject({
			error: 'spotify_rate_limited',
			retryAfterSeconds: 7_201,
			reason: 'rate-limited',
			spotifySessionMetrics: {
				searchRequests: 1,
				transientRetries: 0,
				rateLimitResponses: 1,
				quotaExceededResponses: 0
			}
		});
	});

	it('returns a structured sanitized 502 for a systemic Spotify response failure', async () => {
		const spotifyFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ tracks: { unexpected: 'private upstream content' } }))
		);
		const response = await POST({
			request: new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);
		const body = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual({
			error: 'spotify_response_invalid',
			spotifySessionMetrics: {
				searchRequests: 1,
				primarySearchRequests: 1,
				fallbackSearchRequests: 0,
				cacheHits: 0,
				persistentCacheHits: 0,
				primaryPersistentCacheHits: 0,
				fallbackPersistentCacheHits: 0,
				transientRetries: 0,
				rateLimitResponses: 0,
				quotaExceededResponses: 0
			}
		});
		expect(JSON.stringify(body)).not.toContain('private upstream content');
	});

	it('returns a structured sanitized 503 when Spotify Search is unavailable', async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const spotifyFetch = vi.fn(
			async () => new Response(JSON.stringify({ token: 'private-upstream-value' }), { status: 503 })
		);
		const pendingResponse = POST({
			request: new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);
		await vi.advanceTimersByTimeAsync(7_000);
		const response = await pendingResponse;
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toEqual({
			error: 'spotify_search_unavailable',
			reason: 'upstream',
			spotifySessionMetrics: {
				searchRequests: 3,
				primarySearchRequests: 3,
				fallbackSearchRequests: 0,
				cacheHits: 0,
				persistentCacheHits: 0,
				primaryPersistentCacheHits: 0,
				fallbackPersistentCacheHits: 0,
				transientRetries: 2,
				rateLimitResponses: 0,
				quotaExceededResponses: 0
			}
		});
		expect(JSON.stringify(body)).not.toContain('private-upstream-value');
		expect(consoleError).not.toHaveBeenCalled();
		expect(spotifyFetch).toHaveBeenCalledTimes(3);
	});

	it('returns only a validated status for a sanitized request-rejected 503', async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(getNTSEpisodeTracklist).mockResolvedValue([
			{ artist: 'PRIVATE_ARTIST', title: 'PRIVATE_QUERY' }
		]);
		const spotifyFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'PRIVATE_RESPONSE_BODY' }), {
					status: 400,
					headers: { 'X-Private-Upstream-Header': 'PRIVATE_HEADER_VALUE' }
				})
		);
		const pendingResponse = POST({
			request: new Request('http://localhost/api/nts/matches?PRIVATE_URL_VALUE', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);
		await vi.advanceTimersByTimeAsync(2_000);
		const response = await pendingResponse;
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toEqual({
			error: 'spotify_search_unavailable',
			reason: 'request-rejected',
			upstreamStatus: 400,
			spotifySessionMetrics: {
				searchRequests: 2,
				primarySearchRequests: 1,
				fallbackSearchRequests: 1,
				cacheHits: 0,
				persistentCacheHits: 0,
				primaryPersistentCacheHits: 0,
				fallbackPersistentCacheHits: 0,
				transientRetries: 0,
				rateLimitResponses: 0,
				quotaExceededResponses: 0
			}
		});
		expect(response.headers.get('X-Private-Upstream-Header')).toBeNull();
		for (const privateValue of [
			'PRIVATE_ARTIST',
			'PRIVATE_QUERY',
			'PRIVATE_RESPONSE_BODY',
			'PRIVATE_HEADER_VALUE',
			'PRIVATE_URL_VALUE'
		]) {
			expect(JSON.stringify(body)).not.toContain(privateValue);
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateValue);
		}
		expect(consoleError).not.toHaveBeenCalled();
		expect(spotifyFetch).toHaveBeenCalledTimes(2);
	});

	it('completes an episode through the title-only fallback after a rejected primary 400', async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(getNTSEpisodeTracklist).mockResolvedValue([
			{
				artist: DUPLICATED_ENSEMBLE_ARTIST,
				title: 'Brown, Fizzled Out (2013/2014) For Ensemble'
			}
		]);
		const spotifyFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'PRIVATE_RESPONSE_BODY' }), {
					status: 400,
					headers: { 'X-Private-Upstream-Header': 'PRIVATE_HEADER_VALUE' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						tracks: {
							items: [
								{
									artists: [{ name: 'Brown Ensemble' }],
									name: 'Brown, Fizzled Out',
									uri: 'spotify:track:0123456789ABCDEFGHIJKL',
									preview_url: null,
									album: { images: [] },
									external_urls: {
										spotify: 'https://open.spotify.com/track/0123456789ABCDEFGHIJKL'
									}
								}
							]
						}
					})
				)
			);
		const pendingResponse = POST({
			request: new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);

		await vi.advanceTimersByTimeAsync(2_000);
		const response = await pendingResponse;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.tracks).toEqual([
			expect.objectContaining({
				artist: DUPLICATED_ENSEMBLE_ARTIST,
				fallback: true,
				matches: [expect.objectContaining({ title: 'Brown, Fizzled Out' })]
			})
		]);
		expect(body.spotifySessionMetrics).toMatchObject({
			searchRequests: 2,
			transientRetries: 0,
			cacheHits: 0
		});
		expect(spotifyFetch).toHaveBeenCalledTimes(2);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('keeps raw internal exception properties out of an unexpected 503', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const spotifyFetch = vi.fn(async () => {
			throw Object.assign(new Error('PRIVATE_RAW_MESSAGE'), {
				token: 'PRIVATE_TOKEN',
				url: 'https://private.example/search?PRIVATE_QUERY'
			});
		});
		const response = await POST({
			request: new Request('http://localhost/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ show: 'show', episode: 'episode' })
			}),
			fetch: spotifyFetch
		} as never);
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			error: 'spotify_search_unavailable',
			reason: 'unexpected',
			spotifySessionMetrics: { searchRequests: 1, transientRetries: 0 }
		});
		expect(body).not.toHaveProperty('upstreamStatus');
		expect(JSON.stringify(body)).not.toContain('PRIVATE');
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE');
		expect(consoleError).not.toHaveBeenCalled();
		expect(spotifyFetch).toHaveBeenCalledOnce();
	});

	it('never sends raw thrown properties to catalogue-route logging', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(getNTSEpisodeTracklist).mockRejectedValue({
			name: 'PrivateFailure',
			token: 'must-not-be-logged',
			url: 'https://private.example/callback'
		});
		try {
			await expect(
				POST({
					request: new Request('http://localhost/api/nts/matches', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ show: 'show', episode: 'episode' })
					}),
					fetch: vi.fn()
				} as never)
			).rejects.toMatchObject({ status: 502 });
			expect(consoleError).toHaveBeenCalledWith(
				'Catalogue episode matching failed',
				'unexpected_error'
			);
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('must-not-be-logged');
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private.example');
		} finally {
			consoleError.mockRestore();
		}
	});

	it('returns a fixed configuration error before NTS acquisition or Spotify Search', async () => {
		vi.mocked(getClientCredentials).mockResolvedValue(null);
		await expect(
			POST({
				request: new Request('http://localhost/api/nts/matches', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ show: 'show', episode: 'episode' })
				}),
				fetch: vi.fn()
			} as never)
		).rejects.toMatchObject({
			status: 503,
			body: { message: 'Spotify application is not configured' }
		});
		expect(getNTSEpisodeTracklist).not.toHaveBeenCalled();
	});

	it('keeps configured token acquisition failures distinct and sanitized', async () => {
		vi.mocked(getClientCredentials).mockRejectedValue({
			name: 'SpotifyTokenAcquisitionError',
			reason: 'authentication',
			access_token: 'must-not-be-exposed',
			responseBody: 'private-upstream-body'
		});
		let failure: unknown;
		try {
			await POST({
				request: new Request('http://localhost/api/nts/matches', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ show: 'show', episode: 'episode' })
				}),
				fetch: vi.fn()
			} as never);
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toMatchObject({
			status: 502,
			body: { message: 'Spotify token service is temporarily unavailable' }
		});
		expect(JSON.stringify(failure)).not.toContain('must-not-be-exposed');
		expect(JSON.stringify(failure)).not.toContain('private-upstream-body');
	});
});
