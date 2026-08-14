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
import { getClientCredentials } from '$lib/utils/spotify.server';
import { POST } from './+server';

describe('/api/nts/matches rate-limit response', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
		vi.mocked(getClientCredentials).mockResolvedValue('application-token');
		vi.mocked(getNTSEpisodeTracklist).mockResolvedValue([{ artist: 'Artist', title: 'Track' }]);
	});

	it('returns truthful 429 responses from the real queue and fails fast during cooldown', async () => {
		const spotifyFetch = vi.fn(
			async () => new Response('{}', { status: 429, headers: { 'Retry-After': '7201' } })
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
		expect(response.headers.get('Retry-After')).toBe('7201');
		expect(body).toEqual({ error: 'spotify_rate_limited', retryAfterSeconds: 7_201 });
		expect(Object.keys(body)).toEqual(['error', 'retryAfterSeconds']);
		expect(spotifyFetch).toHaveBeenCalledOnce();

		const repeatedResponse = await POST({ request: makeRequest(), fetch: spotifyFetch } as never);
		const repeatedBody = await repeatedResponse.json();

		expect(repeatedResponse.status).toBe(429);
		expect(repeatedResponse.headers.get('Retry-After')).toBe('7201');
		expect(repeatedBody).toEqual({ error: 'spotify_rate_limited', retryAfterSeconds: 7_201 });
		expect(Object.keys(repeatedBody)).toEqual(['error', 'retryAfterSeconds']);
		expect(spotifyFetch).toHaveBeenCalledOnce();
	});
});
