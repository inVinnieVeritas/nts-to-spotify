import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('/api/nts/matches rate-limit response', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSpotifyServerSessionForTests();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(getNTSEpisodeTracklist).mockResolvedValue([{ artist: 'Artist', title: 'Track' }]);
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
				cacheHits: 0,
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

		expect(firstBody.spotifySessionMetrics).toMatchObject({ searchRequests: 1, cacheHits: 0 });
		expect(secondBody.spotifySessionMetrics).toMatchObject({ searchRequests: 1, cacheHits: 1 });
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
				cacheHits: 0,
				rateLimitResponses: 0,
				quotaExceededResponses: 0
			}
		});
		expect(JSON.stringify(body)).not.toContain('private upstream content');
	});

	it('returns a structured sanitized 503 when Spotify Search is unavailable', async () => {
		const spotifyFetch = vi.fn(async () => new Response('{invalid-json'));
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
		expect(body).toEqual({
			error: 'spotify_search_unavailable',
			spotifySessionMetrics: {
				searchRequests: 1,
				cacheHits: 0,
				rateLimitResponses: 0,
				quotaExceededResponses: 0
			}
		});
		expect(JSON.stringify(body)).not.toContain('invalid-json');
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
});
