import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn() }));

import { getAccessToken } from '$lib/utils/auth.server';
import { POST } from './+server';

describe('/api/spotify/playlist track ordering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
	});

	it('preserves supplied order through exact deduplication and sequential 100-track batches', async () => {
		const jsonResponse = (body: unknown) =>
			new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
		const orderedTracks = Array.from(
			{ length: 205 },
			(_value, index) => `spotify:track:T${String(index).padStart(3, '0')}`
		);
		const suppliedTracks = [
			...orderedTracks.slice(0, 101),
			orderedTracks[0],
			...orderedTracks.slice(101)
		];
		const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: 'user' });
			if (url.includes('/users/')) return jsonResponse({ id: 'playlist' });
			return jsonResponse({ snapshot_id: 'snapshot' });
		});
		const request = new Request('http://localhost/api/spotify/playlist', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Ordered catalogue',
				description: 'Ordering test',
				tracks: suppliedTracks,
				public: false
			})
		});

		const response = await POST({ request, fetch: fetcher } as never);
		const trackRequests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/tracks'));
		const batches = trackRequests.map(
			([_url, init]) => JSON.parse(String(init?.body)) as { uris: string[] }
		);

		expect(response.status).toBe(200);
		expect(batches.map(({ uris }) => uris.length)).toEqual([100, 100, 5]);
		expect(batches.flatMap(({ uris }) => uris)).toEqual(orderedTracks);
	});
});
