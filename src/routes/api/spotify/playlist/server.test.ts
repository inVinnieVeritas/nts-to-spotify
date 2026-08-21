import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn() }));

import { getAccessToken } from '$lib/utils/auth.server';
import { POST, SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES } from './+server';

const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';
const USER_ID = 'current-user';
const trackUri = (index: number) => `spotify:track:${String(index).padStart(22, '0')}`;
const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});
const emptyResponse = (status = 200, headers?: HeadersInit) =>
	new Response(null, { status, headers });

const requestFor = (overrides: Record<string, unknown> = {}) =>
	new Request('http://localhost/api/spotify/playlist', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Catalogue playlist',
			description: 'Ordered catalogue tracks',
			tracks: [trackUri(1)],
			public: false,
			...overrides
		})
	});

const successfulFetcher = () =>
	vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
		if (url.includes('?fields=id,owner(id)')) {
			return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
		}
		if (url === 'https://api.spotify.com/v1/me/playlists') return jsonResponse({ id: PLAYLIST_ID });
		return emptyResponse(init?.method === 'POST' ? 201 : 200);
	});

describe('/api/spotify/playlist synchronization', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
	});

	it('creates one playlist and preserves order through deduplication and 100-track batches', async () => {
		const ordered = Array.from({ length: 205 }, (_value, index) => trackUri(index));
		const supplied = [...ordered.slice(0, 101), ordered[0], ...ordered.slice(101)];
		const fetcher = successfulFetcher();
		const response = await POST({
			request: requestFor({ tracks: supplied }),
			fetch: fetcher
		} as never);
		const body = await response.json();
		const createRequests = fetcher.mock.calls.filter(
			([url]) => String(url) === 'https://api.spotify.com/v1/me/playlists'
		);
		const trackRequests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'));
		const batches = trackRequests.map(
			([_url, init]) => JSON.parse(String(init?.body)) as { uris: string[] }
		);

		expect(body).toEqual({
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
			mode: 'created',
			trackCount: 205
		});
		expect(createRequests).toHaveLength(1);
		expect(createRequests[0][1]?.method).toBe('POST');
		expect(trackRequests.map(([_url, init]) => init?.method)).toEqual(['POST', 'POST', 'POST']);
		expect(batches.map(({ uris }) => uris.length)).toEqual([100, 100, 5]);
		expect(batches.flatMap(({ uris }) => uris)).toEqual(ordered);
	});

	it.each([
		[0, []],
		[1, [1]],
		[99, [99]],
		[100, [100]],
		[101, [100, 1]],
		[200, [100, 100]],
		[201, [100, 100, 1]]
	])('uses current endpoints and valid creation batches for %i tracks', async (count, sizes) => {
		const fetcher = successfulFetcher();
		const response = await POST({
			request: requestFor({
				tracks: Array.from({ length: count }, (_value, index) => trackUri(index))
			}),
			fetch: fetcher
		} as never);
		const calls = fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET']);
		const itemCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'));

		expect(response.status).toBe(200);
		expect(calls.slice(0, 2)).toEqual([
			['https://api.spotify.com/v1/me', 'GET'],
			['https://api.spotify.com/v1/me/playlists', 'POST']
		]);
		expect(
			itemCalls.every(
				([url, init]) =>
					String(url) === `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items` &&
					init?.method === 'POST'
			)
		).toBe(true);
		expect(
			itemCalls.map(
				([_url, init]) => (JSON.parse(String(init?.body)) as { uris: string[] }).uris.length
			)
		).toEqual(sizes);
	});

	it.each([
		[0, [0]],
		[1, [1]],
		[99, [99]],
		[100, [100]],
		[101, [100, 1]],
		[200, [100, 100]],
		[201, [100, 100, 1]]
	])('replaces and appends at exact boundaries for %i tracks', async (count, sizes) => {
		const fetcher = successfulFetcher();
		const response = await POST({
			request: requestFor({
				playlistId: PLAYLIST_ID,
				tracks: Array.from({ length: count }, (_value, index) => trackUri(index))
			}),
			fetch: fetcher
		} as never);
		const itemCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'));

		expect(response.status).toBe(200);
		expect(itemCalls.map(([_url, init]) => init?.method)).toEqual([
			'PUT',
			...Array(Math.max(0, sizes.length - 1)).fill('POST')
		]);
		expect(
			itemCalls.map(
				([_url, init]) => (JSON.parse(String(init?.body)) as { uris: string[] }).uris.length
			)
		).toEqual(sizes);
	});

	it('verifies ownership and idempotently replaces the exact ordered linked playlist contents', async () => {
		const tracks = Array.from({ length: 205 }, (_value, index) => trackUri(index));
		const fetcher = successfulFetcher();
		const synchronize = () =>
			POST({
				request: requestFor({ playlistId: PLAYLIST_ID, tracks }),
				fetch: fetcher
			} as never);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await synchronize();
			expect(await response.json()).toEqual({
				playlistId: PLAYLIST_ID,
				url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
				mode: 'updated',
				trackCount: 205
			});
		}

		const playlistCreates = fetcher.mock.calls.filter(
			([url]) => String(url) === 'https://api.spotify.com/v1/me/playlists'
		);
		const ownershipRequests = fetcher.mock.calls.filter(([url]) =>
			String(url).includes('?fields=id,owner(id)')
		);
		const trackRequests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'));
		const detailRequests = fetcher.mock.calls.filter(
			([url, init]) => String(url).endsWith(`/playlists/${PLAYLIST_ID}`) && init?.method === 'PUT'
		);
		const firstAttemptBatches = trackRequests
			.slice(0, 3)
			.map(([_url, init]) => JSON.parse(String(init?.body)) as { uris: string[] });

		expect(playlistCreates).toHaveLength(0);
		expect(ownershipRequests).toHaveLength(2);
		expect(detailRequests.map(([_url, init]) => JSON.parse(String(init?.body)))).toEqual([
			{ name: 'Catalogue playlist', description: 'Ordered catalogue tracks', public: false },
			{ name: 'Catalogue playlist', description: 'Ordered catalogue tracks', public: false }
		]);
		expect(trackRequests.slice(0, 3).map(([_url, init]) => init?.method)).toEqual([
			'PUT',
			'POST',
			'POST'
		]);
		expect(firstAttemptBatches.map(({ uris }) => uris.length)).toEqual([100, 100, 5]);
		expect(firstAttemptBatches.flatMap(({ uris }) => uris)).toEqual(tracks);
		expect(
			trackRequests.slice(3).map(([_url, init]) => ({ method: init?.method, body: init?.body }))
		).toEqual(
			trackRequests.slice(0, 3).map(([_url, init]) => ({ method: init?.method, body: init?.body }))
		);
	});

	it('rejects an ownership mismatch before any mutation', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			return url.endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse({ id: PLAYLIST_ID, owner: { id: 'another-user' } });
		});
		const response = await POST({
			request: requestFor({ playlistId: PLAYLIST_ID }),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'playlist_not_owned' });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			'https://api.spotify.com/v1/me',
			`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=id,owner(id)`
		]);
	});

	it('verifies an existing playlist without mutating it for manual recovery', async () => {
		const fetcher = successfulFetcher();
		const response = await POST({
			request: new Request('http://localhost/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'verify', playlistId: PLAYLIST_ID })
			}),
			fetch: fetcher
		} as never);

		expect(await response.json()).toEqual({
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
			mode: 'verified'
		});
		expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
			['https://api.spotify.com/v1/me', 'GET'],
			[`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=id,owner(id)`, 'GET']
		]);
	});

	it('does not create a replacement when the linked playlist is missing', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse({ error: 'PRIVATE_UPSTREAM_BODY' }, 404)
		);
		const response = await POST({
			request: requestFor({ playlistId: PLAYLIST_ID }),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'playlist_not_found' });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('rejects invalid playlist IDs and track URIs before authentication or Spotify requests', async () => {
		const fetcher = vi.fn();
		for (const overrides of [
			{ playlistId: 'not-a-playlist' },
			{ tracks: ['spotify:album:0123456789ABCDEFGHIJKL'] }
		]) {
			const response = await POST({ request: requestFor(overrides), fetch: fetcher } as never);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'invalid_request' });
		}
		expect(getAccessToken).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects an oversized declared payload before authentication or parsing', async () => {
		const fetcher = vi.fn();
		const request = requestFor();
		request.headers.set('Content-Length', String(SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES + 1));
		const response = await POST({ request, fetch: fetcher } as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_request' });
		expect(getAccessToken).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects an incrementally oversized chunked body before authentication', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel() {
				cancelled = true;
			}
		});
		const request = new Request('http://localhost/api/spotify/playlist', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: stream,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const response = await POST({ request, fetch: vi.fn() } as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_request' });
		expect(cancelled).toBe(true);
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	it('returns a sanitized retryable incomplete result when a later update batch fails', async () => {
		const privateUri = trackUri(200);
		const tracks = Array.from({ length: 201 }, (_value, index) => trackUri(index));
		let trackRequest = 0;
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('?fields=id,owner(id)')) {
				return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
			}
			if (url.endsWith('/items')) {
				trackRequest += 1;
				return trackRequest === 3
					? jsonResponse({ error: 'PRIVATE_RAW_RESPONSE', uri: privateUri }, 503)
					: emptyResponse(init?.method === 'POST' ? 201 : 200);
			}
			return emptyResponse();
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await POST({
			request: requestFor({ playlistId: PLAYLIST_ID, tracks }),
			fetch: fetcher
		} as never);
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toEqual({
			error: 'playlist_sync_incomplete',
			incomplete: true,
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`
		});
		expect(JSON.stringify(body)).not.toContain('PRIVATE');
		expect(JSON.stringify(body)).not.toContain(privateUri);
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE');
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateUri);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('retains a newly created playlist ID when its track upload is incomplete', async () => {
		const tracks = Array.from({ length: 101 }, (_value, index) => trackUri(index));
		let itemRequest = 0;
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url === 'https://api.spotify.com/v1/me/playlists') {
				return jsonResponse({ id: PLAYLIST_ID }, 201);
			}
			if (url.endsWith('/items')) {
				itemRequest += 1;
				return itemRequest === 2
					? emptyResponse(503)
					: emptyResponse(init?.method === 'POST' ? 201 : 200);
			}
			return emptyResponse();
		});
		const response = await POST({ request: requestFor({ tracks }), fetch: fetcher } as never);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: 'playlist_sync_incomplete',
			incomplete: true,
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`
		});
		expect(
			fetcher.mock.calls.filter(
				([url]) => String(url) === 'https://api.spotify.com/v1/me/playlists'
			)
		).toHaveLength(1);
	});

	it('retries a partial update deterministically from the first replacement batch', async () => {
		const tracks = Array.from({ length: 201 }, (_value, index) => trackUri(index));
		let itemRequest = 0;
		let failed = false;
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('?fields=id,owner(id)')) {
				return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
			}
			if (url.endsWith('/items')) {
				itemRequest += 1;
				if (!failed && itemRequest === 3) {
					failed = true;
					return jsonResponse({}, 503);
				}
				return emptyResponse(init?.method === 'POST' ? 201 : 200);
			}
			return emptyResponse();
		});
		const synchronize = () =>
			POST({
				request: requestFor({ playlistId: PLAYLIST_ID, tracks }),
				fetch: fetcher
			} as never);

		expect((await synchronize()).status).toBe(503);
		expect((await synchronize()).status).toBe(200);
		const successfulRetry = fetcher.mock.calls
			.filter(([url]) => String(url).endsWith('/items'))
			.slice(-3);
		expect(successfulRetry.map(([_url, init]) => init?.method)).toEqual(['PUT', 'POST', 'POST']);
		expect(
			successfulRetry.flatMap(
				([_url, init]) => (JSON.parse(String(init?.body)) as { uris: string[] }).uris
			)
		).toEqual(tracks);
	});

	it.each(['metadata', 'replacement', 'append'])(
		'maps a linked-playlist 404 during %s to not found',
		async (stage) => {
			let itemCall = 0;
			const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
				if (url.includes('?fields=id,owner(id)')) {
					return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
				}
				if (url === `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}`) {
					return stage === 'metadata' ? emptyResponse(404) : emptyResponse(200);
				}
				if (url.endsWith('/items')) {
					itemCall += 1;
					if (stage === 'replacement' && itemCall === 1) return emptyResponse(404);
					if (stage === 'append' && itemCall === 2) return emptyResponse(404);
					return emptyResponse(init?.method === 'POST' ? 201 : 200);
				}
				return emptyResponse();
			});
			const response = await POST({
				request: requestFor({
					playlistId: PLAYLIST_ID,
					tracks: Array.from({ length: 101 }, (_value, index) => trackUri(index))
				}),
				fetch: fetcher
			} as never);

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: 'playlist_not_found',
				incomplete: true,
				playlistId: PLAYLIST_ID,
				url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`
			});
			expect(
				fetcher.mock.calls.some(
					([url]) => String(url) === 'https://api.spotify.com/v1/me/playlists'
				)
			).toBe(false);
		}
	);

	it('treats invalid JSON after creation dispatch as an ambiguous outcome', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			return new Response('{"id":', {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const response = await POST({ request: requestFor(), fetch: fetcher } as never);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'playlist_creation_unknown' });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('treats a creation timeout as an ambiguous outcome', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/v1/me')) return Promise.resolve(jsonResponse({ id: USER_ID }));
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('cancelled', 'AbortError'))
					);
				});
			});
			const pending = POST({ request: requestFor(), fetch: fetcher } as never);
			await vi.advanceTimersByTimeAsync(20_001);
			const response = await pending;
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: 'playlist_creation_unknown' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves a validated Retry-After without exposing the upstream body', async () => {
		const fetcher = vi.fn(async () =>
			jsonResponse({ error: 'PRIVATE_RATE_LIMIT_BODY' }, 429, {
				'Retry-After': '30785',
				'X-Private': 'PRIVATE_HEADER'
			})
		);
		const response = await POST({ request: requestFor(), fetch: fetcher } as never);
		const body = await response.json();

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('30785');
		expect(body).toEqual({ error: 'spotify_rate_limited', retryAfterSeconds: 30_785 });
		expect(JSON.stringify(body)).not.toContain('PRIVATE');
		expect(response.headers.get('X-Private')).toBeNull();
	});

	it.each([401, 403])('sanitizes Spotify HTTP %i authentication failures', async (status) => {
		const fetcher = vi.fn(async () => jsonResponse({ token: 'PRIVATE_TOKEN' }, status));
		const response = await POST({ request: requestFor(), fetch: fetcher } as never);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'spotify_authentication' });
	});

	it('sanitizes Spotify upstream and network failures without logging raw properties', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		for (const fetcher of [
			vi.fn(async () => jsonResponse({ error: 'PRIVATE_UPSTREAM_BODY' }, 503)),
			vi.fn(async () => {
				throw Object.assign(new TypeError('PRIVATE_NETWORK_MESSAGE'), {
					token: 'PRIVATE_TOKEN',
					url: 'https://private.example/PRIVATE_QUERY'
				});
			})
		]) {
			const response = await POST({ request: requestFor(), fetch: fetcher } as never);
			const body = await response.json();
			expect(response.status).toBe(503);
			expect(body).toEqual({ error: 'spotify_unavailable' });
			expect(JSON.stringify(body)).not.toContain('PRIVATE');
		}
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE');
		expect(consoleError).not.toHaveBeenCalled();
	});
});
