import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn() }));

import { getAccessToken } from '$lib/utils/auth.server';
import { uniqueSpotifyUris } from '$lib/utils/catalog-scan';
import { fingerprintSpotifyPlaylistPreview } from '$lib/utils/playlist-preview.server';
import {
	getSpotifySessionMetrics,
	resetSpotifyServerSessionForTests
} from '$lib/utils/spotify.server';
import { POST, _SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES } from './+server';

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

const CURRENT_PLAYLIST = {
	playlistId: PLAYLIST_ID,
	snapshotId: 'snapshot-1',
	name: 'Existing playlist',
	description: 'Existing description',
	public: true,
	items: [] as (string | null)[]
};
const playlistMetadata = (ownerId = USER_ID) => ({
	id: PLAYLIST_ID,
	owner: { id: ownerId },
	snapshot_id: CURRENT_PLAYLIST.snapshotId,
	name: CURRENT_PLAYLIST.name,
	description: CURRENT_PLAYLIST.description,
	public: CURRENT_PLAYLIST.public
});

const requestFor = (overrides: Record<string, unknown> = {}) => {
	const linked = typeof overrides.playlistId === 'string';
	const operation =
		typeof overrides.operation === 'string'
			? overrides.operation
			: linked
				? 'apply-batch'
				: 'create';
	const values = {
		name: 'Catalogue playlist',
		description: 'Ordered catalogue tracks',
		tracks: [trackUri(1)],
		public: false,
		...overrides
	};
	const applying = operation === 'apply-batch';
	const generatedFingerprint = applying
		? fingerprintSpotifyPlaylistPreview(CURRENT_PLAYLIST, {
				name: String(values.name).trim(),
				description: String(values.description),
				tracks: uniqueSpotifyUris(values.tracks as string[]),
				public: values.public as boolean
			})
		: undefined;
	const body =
		operation === 'create'
			? {
					operation,
					name: values.name,
					description: values.description,
					public: values.public,
					...overrides
				}
			: {
					...values,
					operation,
					...(applying ? { previewFingerprint: generatedFingerprint } : {}),
					...overrides
				};
	return new Request('http://localhost/api/spotify/playlist', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
};

const successfulFetcher = () =>
	vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
		if (url.includes('?fields=id,owner(id),snapshot_id,name,description,public')) {
			return jsonResponse(playlistMetadata());
		}
		if (url.includes('?fields=id,owner(id)')) {
			return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
		}
		if (url.includes('/items?')) return jsonResponse({ items: [], total: 0 });
		if (url === 'https://api.spotify.com/v1/me/playlists') return jsonResponse({ id: PLAYLIST_ID });
		if (url.endsWith('/items') && (init?.method === 'PUT' || init?.method === 'POST')) {
			return jsonResponse({ snapshot_id: 'snapshot-after' }, init.method === 'POST' ? 201 : 200);
		}
		return emptyResponse(init?.method === 'POST' ? 201 : 200);
	});

const previewRequest = (overrides: Record<string, unknown> = {}) =>
	requestFor({ operation: 'preview', playlistId: PLAYLIST_ID, ...overrides });

const playlistReadFetcher = (
	items: (string | null)[],
	metadataOverrides: Record<string, unknown> = {}
) =>
	vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
		if (url.includes('?fields=id,owner(id),snapshot_id,name,description,public')) {
			return jsonResponse({ ...playlistMetadata(), ...metadataOverrides });
		}
		if (url.includes('?fields=id,owner(id)')) {
			return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
		}
		if (url.includes('/items?')) {
			const offset = Number(new URL(url).searchParams.get('offset'));
			return jsonResponse({
				items: items
					.slice(offset, offset + 100)
					.map((track) =>
						track === null
							? { is_local: false, item: null }
							: { is_local: false, item: { type: 'track', uri: track, is_local: false } }
					),
				total: items.length
			});
		}
		return emptyResponse(init?.method === 'POST' ? 201 : 200);
	});

describe('/api/spotify/playlist synchronization', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSpotifyServerSessionForTests();
		vi.mocked(getAccessToken).mockResolvedValue('user-token');
	});

	it('creates only an empty playlist and returns its ID before any item mutation', async () => {
		const fetcher = successfulFetcher();
		const metricsBefore = getSpotifySessionMetrics();
		const response = await POST({
			request: new Request('http://localhost/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'create',
					name: 'Amanda Siegel',
					description: 'Archive',
					public: false
				})
			}),
			fetch: fetcher
		} as never);

		expect(await response.json()).toEqual({
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
			mode: 'created',
			trackCount: 0
		});
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			'https://api.spotify.com/v1/me',
			'https://api.spotify.com/v1/me/playlists'
		]);
		expect(getSpotifySessionMetrics()).toEqual(metricsBefore);
	});

	it('applies only the first bounded replacement batch and returns a validated snapshot', async () => {
		const tracks = Array.from({ length: 1508 }, (_value, index) => trackUri(index));
		const target = {
			name: 'Catalogue playlist',
			description: 'Ordered catalogue tracks',
			tracks,
			public: false
		};
		const fingerprint = fingerprintSpotifyPlaylistPreview(CURRENT_PLAYLIST, target);
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('?fields=id,owner(id),snapshot_id,name,description,public')) {
				return jsonResponse(playlistMetadata());
			}
			if (url.includes('?fields=id,owner(id)')) {
				return jsonResponse({ id: PLAYLIST_ID, owner: { id: USER_ID } });
			}
			if (url.includes('/items?')) return jsonResponse({ items: [], total: 0 });
			if (url.endsWith('/items') && init?.method === 'PUT') {
				return jsonResponse({ snapshot_id: 'snapshot-after-first-batch' });
			}
			return emptyResponse();
		});
		const response = await POST({
			request: new Request('http://localhost/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'apply-batch',
					playlistId: PLAYLIST_ID,
					previewFingerprint: fingerprint,
					...target
				})
			}),
			fetch: fetcher
		} as never);
		const itemMutations = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			playlistId: PLAYLIST_ID,
			url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
			mode: 'batch',
			confirmedPosition: 100,
			totalTrackCount: 1508,
			snapshotId: 'snapshot-after-first-batch'
		});
		expect(itemMutations).toHaveLength(1);
		expect(JSON.parse(String(itemMutations[0][1]?.body)).uris).toEqual(tracks.slice(0, 100));
	});

	it('verifies ownership and the acknowledged snapshot before one append mutation', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('?fields=id,owner(id),snapshot_id')) {
				return jsonResponse({
					...playlistMetadata(),
					snapshot_id: 'snapshot-before'
				});
			}
			if (url.endsWith('/items') && init?.method === 'POST') {
				return jsonResponse({ snapshot_id: 'snapshot-after' }, 201);
			}
			return emptyResponse();
		});
		const body = {
			operation: 'append',
			playlistId: PLAYLIST_ID,
			operationId: 'operation_1234567890',
			targetFingerprint: 'a'.repeat(64),
			expectedSnapshotId: 'snapshot-before',
			position: 100,
			totalTrackCount: 108,
			tracks: Array.from({ length: 8 }, (_value, index) => trackUri(100 + index)),
			name: CURRENT_PLAYLIST.name,
			description: CURRENT_PLAYLIST.description,
			public: CURRENT_PLAYLIST.public
		};
		const response = await POST({
			request: new Request('http://localhost/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			fetch: fetcher
		} as never);

		expect(await response.json()).toMatchObject({
			mode: 'batch',
			confirmedPosition: 108,
			snapshotId: 'snapshot-after'
		});
		expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/items'))).toHaveLength(1);
	});

	it('rejects a changed snapshot before append and performs no mutation', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse({
						...playlistMetadata(),
						snapshot_id: 'externally-changed'
					})
		);
		const response = await POST({
			request: new Request('http://localhost/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'append',
					playlistId: PLAYLIST_ID,
					operationId: 'operation_1234567890',
					targetFingerprint: 'a'.repeat(64),
					expectedSnapshotId: 'expected',
					position: 100,
					totalTrackCount: 101,
					tracks: [trackUri(100)],
					name: CURRENT_PLAYLIST.name,
					description: CURRENT_PLAYLIST.description,
					public: CURRENT_PLAYLIST.public
				})
			}),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'playlist_changed_since_sync' });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('confirms an acknowledged playlist state using reads only', async () => {
		const fetcher = successfulFetcher();
		const response = await POST({
			request: requestFor({
				operation: 'settle',
				playlistId: PLAYLIST_ID,
				expectedSnapshotId: CURRENT_PLAYLIST.snapshotId,
				name: CURRENT_PLAYLIST.name,
				description: CURRENT_PLAYLIST.description,
				public: CURRENT_PLAYLIST.public
			}),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			mode: 'settled',
			playlistId: PLAYLIST_ID,
			snapshotId: CURRENT_PLAYLIST.snapshotId
		});
		expect(fetcher.mock.calls).toHaveLength(2);
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
	});

	it('reports a bounded settlement delay without mutating Spotify', async () => {
		const fetcher = playlistReadFetcher([], { snapshot_id: 'still-propagating' });
		const response = await POST({
			request: requestFor({
				operation: 'settle',
				playlistId: PLAYLIST_ID,
				expectedSnapshotId: CURRENT_PLAYLIST.snapshotId,
				name: CURRENT_PLAYLIST.name,
				description: CURRENT_PLAYLIST.description,
				public: CURRENT_PLAYLIST.public
			}),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(409);
		expect(response.headers.get('Retry-After')).toBe('5');
		expect(await response.json()).toEqual({
			error: 'playlist_settling',
			retryAfterSeconds: 5
		});
		expect(fetcher.mock.calls).toHaveLength(2);
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
	});

	it('returns 409 without mutation when Spotify changed after the preview', async () => {
		const previewed = { ...CURRENT_PLAYLIST, items: [trackUri(1)] };
		const target = {
			name: 'Catalogue playlist',
			description: 'Ordered catalogue tracks',
			public: false,
			tracks: [trackUri(1)]
		};
		const fetcher = playlistReadFetcher([trackUri(2)], { snapshot_id: 'snapshot-2' });
		const response = await POST({
			request: requestFor({
				playlistId: PLAYLIST_ID,
				previewFingerprint: fingerprintSpotifyPlaylistPreview(previewed, target)
			}),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'playlist_changed_since_preview' });
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
	});

	it('binds the preview fingerprint to the exact catalogue export inputs', async () => {
		const currentState = { ...CURRENT_PLAYLIST, items: [trackUri(1)] };
		const previewedTarget = {
			name: 'Catalogue playlist',
			description: 'Ordered catalogue tracks',
			public: false,
			tracks: [trackUri(1)]
		};
		const fetcher = playlistReadFetcher(currentState.items);
		const response = await POST({
			request: requestFor({
				playlistId: PLAYLIST_ID,
				tracks: [trackUri(2)],
				previewFingerprint: fingerprintSpotifyPlaylistPreview(currentState, previewedTarget)
			}),
			fetch: fetcher
		} as never);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'playlist_changed_since_preview' });
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
	});

	it('rejects a deleted or ownership-changed playlist before mutation during apply', async () => {
		for (const metadataResponse of [
			emptyResponse(404),
			jsonResponse(playlistMetadata('other-user'))
		]) {
			const fetcher = vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith('/v1/me') ? jsonResponse({ id: USER_ID }) : metadataResponse.clone()
			);
			const response = await POST({
				request: requestFor({ playlistId: PLAYLIST_ID }),
				fetch: fetcher
			} as never);
			expect([403, 404]).toContain(response.status);
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(
				(fetcher.mock.calls as unknown as [RequestInfo | URL, RequestInit?][]).every(
					([_url, init]) => !init?.method
				)
			).toBe(true);
		}
	});

	it('rejects current playlists above the bounded 10,000-item maximum', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('/items?')) return jsonResponse({ items: [], total: 10_001 });
			return jsonResponse(playlistMetadata());
		});
		const response = await POST({ request: previewRequest(), fetch: fetcher } as never);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'spotify_unavailable' });
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it('stops at exactly 100 pages for the 10,000-item maximum', async () => {
		const fetcher = playlistReadFetcher(Array(10_000).fill(trackUri(1)));
		const response = await POST({
			request: previewRequest({ tracks: [] }),
			fetch: fetcher
		} as never);
		expect(response.status).toBe(200);
		expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/items?'))).toHaveLength(100);
	});

	it('rejects oversized or internally inconsistent Spotify item pages', async () => {
		for (const page of [
			{ total: 101, items: Array(101).fill({ item: null }) },
			{ total: 2, items: [] }
		]) {
			const fetcher = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
				if (url.includes('/items?')) return jsonResponse(page);
				return jsonResponse(playlistMetadata());
			});
			const response = await POST({ request: previewRequest(), fetch: fetcher } as never);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: 'spotify_unavailable' });
		}
	});

	it.each([
		[401, 401, { error: 'spotify_authentication' }],
		[403, 403, { error: 'playlist_inaccessible' }],
		[404, 404, { error: 'playlist_not_found' }],
		[500, 503, { error: 'spotify_unavailable' }]
	])('sanitizes preview Spotify HTTP %i responses', async (upstreamStatus, status, expected) => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse({ token: 'PRIVATE', body: 'PRIVATE' }, upstreamStatus)
		);
		const response = await POST({ request: previewRequest(), fetch: fetcher } as never);
		const body = await response.json();
		expect(response.status).toBe(status);
		expect(body).toEqual(expected);
		expect(JSON.stringify(body)).not.toContain('PRIVATE');
	});

	it('preserves a safe Retry-After on a preview 429', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse({ body: 'PRIVATE' }, 429, { 'Retry-After': '30785' })
		);
		const response = await POST({ request: previewRequest(), fetch: fetcher } as never);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('30785');
		expect(await response.json()).toEqual({
			error: 'spotify_rate_limited',
			retryAfterSeconds: 30_785
		});
	});

	it('sanitizes invalid JSON and network failures while previewing', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		for (const failure of ['invalid-json', 'network']) {
			const fetcher = vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
				if (failure === 'network') {
					throw Object.assign(new TypeError('PRIVATE_EXCEPTION'), { token: 'PRIVATE_TOKEN' });
				}
				return new Response('{"owner":', { status: 200 });
			});
			const response = await POST({ request: previewRequest(), fetch: fetcher } as never);
			const body = await response.json();
			expect(response.status).toBe(503);
			expect(body).toEqual({ error: 'spotify_unavailable' });
			expect(JSON.stringify(body)).not.toContain('PRIVATE');
		}
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('bounds a stalled preview Spotify request', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/v1/me')) return Promise.resolve(jsonResponse({ id: USER_ID }));
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('PRIVATE_TIMEOUT', 'AbortError'))
					);
				});
			});
			const pending = POST({ request: previewRequest(), fetch: fetcher } as never);
			await vi.advanceTimersByTimeAsync(20_001);
			const response = await pending;
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: 'spotify_unavailable' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('previews after ownership verification without making any Spotify mutation', async () => {
		const currentItems = [trackUri(1), trackUri(1), trackUri(2), null];
		const fetcher = playlistReadFetcher(currentItems);
		const response = await POST({
			request: previewRequest({ tracks: [trackUri(1), trackUri(3)] }),
			fetch: fetcher
		} as never);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			playlistId: PLAYLIST_ID,
			mode: 'preview',
			addedCount: 1,
			removedCount: 3,
			retainedCount: 1,
			orderChanged: false,
			titleChanged: true,
			descriptionChanged: true,
			visibilityChanged: true,
			synchronized: false
		});
		expect(body.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
			['https://api.spotify.com/v1/me', 'GET'],
			[`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=id,owner(id)`, 'GET'],
			[
				`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=id,owner(id),snapshot_id,name,description,public`,
				'GET'
			],
			[
				`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items?fields=items(is_local,item(type,uri,is_local)),total&limit=100&offset=0`,
				'GET'
			]
		]);
		expect(fetcher.mock.calls.every(([_url, init]) => !init?.method)).toBe(true);
	});

	it.each([0, 1, 99, 100, 101, 200, 201])(
		'reads all %i current playlist items with bounded 100-item pagination',
		async (count) => {
			const fetcher = playlistReadFetcher(
				Array.from({ length: count }, (_value, index) => trackUri(index))
			);
			const response = await POST({
				request: previewRequest({ tracks: [] }),
				fetch: fetcher
			} as never);
			const body = await response.json();
			const itemReads = fetcher.mock.calls.filter(([url]) => String(url).includes('/items?'));

			expect(response.status).toBe(200);
			expect(body.removedCount).toBe(count);
			expect(itemReads).toHaveLength(Math.max(1, Math.ceil(count / 100)));
			expect(itemReads.every(([_url, init]) => !init?.method)).toBe(true);
		}
	);

	it('matches current items[].item.uri identities to the unchanged catalogue target', async () => {
		const tracks = [trackUri(1), trackUri(2), trackUri(3)];
		const fetcher = playlistReadFetcher(tracks, {
			name: 'Catalogue playlist',
			description: 'Ordered catalogue tracks',
			public: false
		});
		const response = await POST({ request: previewRequest({ tracks }), fetch: fetcher } as never);

		expect(await response.json()).toMatchObject({
			addedCount: 0,
			removedCount: 0,
			retainedCount: 3,
			orderChanged: false,
			titleChanged: false,
			descriptionChanged: false,
			visibilityChanged: false,
			synchronized: true
		});
	});

	it('accepts only canonical track items while preserving unusable occurrence counts', async () => {
		const validUri = trackUri(1);
		const episodeUri = `spotify:episode:${'E'.repeat(22)}`;
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return jsonResponse({ id: USER_ID });
			if (url.includes('/items?')) {
				return jsonResponse({
					total: 10,
					items: [
						{ is_local: false, item: { type: 'track', uri: validUri, is_local: false } },
						{ is_local: false, item: { type: 'track', uri: validUri, is_local: false } },
						{ is_local: false, item: null },
						{},
						{ is_local: false, item: { type: 'episode', uri: episodeUri } },
						{ is_local: true, item: { type: 'track', uri: validUri } },
						{ is_local: false, item: { type: 'track', uri: validUri, is_local: true } },
						{ is_local: false, item: { type: 'track', uri: validUri.slice(-22) } },
						{
							is_local: false,
							item: { type: 'track', uri: `https://open.spotify.com/track/${validUri.slice(-22)}` }
						},
						{ is_local: false, track: { type: 'track', uri: validUri, is_local: false } }
					]
				});
			}
			return jsonResponse(playlistMetadata());
		});
		const response = await POST({
			request: previewRequest({ tracks: [validUri] }),
			fetch: fetcher
		} as never);
		expect(await response.json()).toMatchObject({
			addedCount: 0,
			removedCount: 9,
			retainedCount: 1,
			orderChanged: false
		});
	});

	it('does not touch Spotify Search cache or metrics while previewing', async () => {
		const before = getSpotifySessionMetrics();
		const response = await POST({
			request: previewRequest(),
			fetch: playlistReadFetcher([])
		} as never);
		expect(response.status).toBe(200);
		expect(getSpotifySessionMetrics()).toEqual(before);
	});

	it('rejects an ownership mismatch before any mutation', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input);
			return url.endsWith('/v1/me')
				? jsonResponse({ id: USER_ID })
				: jsonResponse(playlistMetadata('another-user'));
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
		request.headers.set('Content-Length', String(_SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES + 1));
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
				controller.enqueue(new Uint8Array(_SPOTIFY_PLAYLIST_MAX_PAYLOAD_BYTES));
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
