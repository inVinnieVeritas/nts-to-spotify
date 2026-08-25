import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSpotifyMatchCache, type SpotifyMatchCacheStorage } from './spotify-match-cache.server';
import {
	getSpotifySessionMetrics,
	resetSpotifyServerSessionForTests,
	searchSpotifyTrack,
	setSpotifyMatchCacheStorageForTests,
	SPOTIFY_SEARCH_INTERVAL_MS,
	SPOTIFY_TRANSIENT_RETRY_DELAYS_MS
} from './spotify.server';
import type { Fetcher } from './request';

const TRACK_ID = '0123456789ABCDEFGHIJKL';
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nts-spotify-search-cache-'));
	temporaryDirectories.push(directory);
	return directory;
};

const spotifyItem = (overrides: Record<string, unknown> = {}) => ({
	artists: [{ name: 'Artist' }],
	name: 'Track',
	uri: `spotify:track:${TRACK_ID}`,
	preview_url: null,
	album: { images: [] },
	external_urls: { spotify: `https://open.spotify.com/track/${TRACK_ID}` },
	...overrides
});

const searchResponse = (items: unknown[] = [spotifyItem()]) =>
	new Response(JSON.stringify({ tracks: { items } }), {
		headers: { 'Content-Type': 'application/json' }
	});

const storageSpy = (): SpotifyMatchCacheStorage & {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
} => ({
	get: vi.fn(async () => null),
	set: vi.fn(async () => undefined),
	flush: vi.fn(async () => undefined)
});

beforeEach(() => resetSpotifyServerSessionForTests());

afterEach(async () => {
	vi.useRealTimers();
	resetSpotifyServerSessionForTests();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
			)
	);
});

describe('Spotify persistent search integration', () => {
	it('uses a durable result after a restart with zero Spotify dispatches and separated metrics', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const firstCache = new FileSpotifyMatchCache({ directory });
		setSpotifyMatchCacheStorageForTests(firstCache);
		const firstRequest = vi.fn(async () => searchResponse()) as unknown as Fetcher;
		const track = { artist: ' Artist ', title: 'TRACK' };

		const first = await searchSpotifyTrack(track, 'first-token', firstRequest);
		await firstCache.flush();
		expect(firstRequest).toHaveBeenCalledOnce();
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 1,
			cacheHits: 0,
			persistentCacheHits: 0
		});

		resetSpotifyServerSessionForTests();
		const restartedCache = new FileSpotifyMatchCache({ directory });
		setSpotifyMatchCacheStorageForTests(restartedCache);
		const restartedRequest = vi.fn(async () => {
			throw new Error('Spotify must not be called for a persistent hit');
		}) as unknown as Fetcher;
		const loaded = await searchSpotifyTrack(
			{ artist: 'artist', title: 'track' },
			'second-token',
			restartedRequest
		);
		loaded.matches[0].title = 'Mutated caller result';

		expect(restartedRequest).not.toHaveBeenCalled();
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 0,
			cacheHits: 0,
			persistentCacheHits: 1,
			transientRetries: 0
		});
		const memoryHit = await searchSpotifyTrack(
			{ artist: 'ARTIST', title: ' Track ' },
			'third-token',
			restartedRequest
		);
		expect(memoryHit.matches[0].title).toBe(first.matches[0].title);
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 0,
			cacheHits: 1,
			persistentCacheHits: 1,
			transientRetries: 0
		});
	});

	it('persists a fully validated legitimate empty result', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const firstCache = new FileSpotifyMatchCache({ directory });
		await firstCache.flush();
		setSpotifyMatchCacheStorageForTests(firstCache);
		vi.useFakeTimers();
		const track = { artist: 'Artist', title: 'Missing' };
		const firstRequest = vi.fn(async () => searchResponse([])) as unknown as Fetcher;
		const pending = searchSpotifyTrack(track, 'token', firstRequest);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await expect(pending).resolves.toMatchObject({ matches: [], fallback: true });
		vi.useRealTimers();
		await firstCache.flush();

		resetSpotifyServerSessionForTests();
		const restartedCache = new FileSpotifyMatchCache({ directory });
		setSpotifyMatchCacheStorageForTests(restartedCache);
		const restartedRequest = vi.fn(async () => searchResponse()) as unknown as Fetcher;
		await expect(searchSpotifyTrack(track, 'token', restartedRequest)).resolves.toMatchObject({
			matches: [],
			fallback: true
		});
		expect(restartedRequest).not.toHaveBeenCalled();
		expect(getSpotifySessionMetrics()).toMatchObject({ persistentCacheHits: 1, searchRequests: 0 });
	});

	it('keeps a persistent entry valid when one coalesced caller cancels', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const value = {
			artist: 'Artist',
			title: 'Track',
			matches: [
				{
					artist: 'Artist',
					title: 'Track',
					uri: `spotify:track:${TRACK_ID}`,
					href: `https://open.spotify.com/track/${TRACK_ID}`
				}
			],
			confident: true,
			fallback: false
		};
		const storage = storageSpy();
		storage.get.mockImplementation(async () => {
			await gate;
			return value;
		});
		setSpotifyMatchCacheStorageForTests(storage);
		const request = vi.fn(async () => searchResponse()) as unknown as Fetcher;
		const controller = new AbortController();
		const first = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Track' },
			'token',
			request,
			controller.signal
		);
		const second = searchSpotifyTrack({ artist: 'artist', title: 'track' }, 'token', request);

		controller.abort();
		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		release?.();
		await expect(second).resolves.toMatchObject({ matches: [expect.any(Object)] });
		expect(request).not.toHaveBeenCalled();
		expect(storage.set).not.toHaveBeenCalled();
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 0,
			cacheHits: 0,
			persistentCacheHits: 1,
			transientRetries: 0
		});
	});

	it('does not count or populate a persistent hit when the sole caller cancels during loading', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const persistentValue = {
			artist: 'Artist',
			title: 'Track',
			matches: [
				{
					artist: 'Artist',
					title: 'Track',
					uri: `spotify:track:${TRACK_ID}`,
					href: `https://open.spotify.com/track/${TRACK_ID}`
				}
			],
			confident: true,
			fallback: false
		};
		const storage = storageSpy();
		storage.get.mockImplementationOnce(async () => {
			await gate;
			return persistentValue;
		});
		setSpotifyMatchCacheStorageForTests(storage);
		const request = vi.fn(async () => searchResponse()) as unknown as Fetcher;
		const controller = new AbortController();
		const cancelled = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Track' },
			'token',
			request,
			controller.signal
		);
		controller.abort();
		release?.();
		await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		await Promise.resolve();
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 0,
			cacheHits: 0,
			persistentCacheHits: 0,
			transientRetries: 0
		});

		storage.get.mockResolvedValueOnce(null);
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request)
		).resolves.toMatchObject({ matches: [expect.any(Object)] });
		expect(storage.get).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenCalledOnce();
	});

	it.each([
		['skipped candidate', [null, spotifyItem()]],
		['adjusted candidate', [spotifyItem({ preview_url: 'javascript:unsafe' })]]
	])('does not persist a successful result with an %s', async (_label, items) => {
		const storage = storageSpy();
		setSpotifyMatchCacheStorageForTests(storage);
		const request = vi.fn(async () => searchResponse(items)) as unknown as Fetcher;
		await expect(searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request))
			.resolves;
		expect(storage.set).not.toHaveBeenCalled();
	});

	it.each([
		['authentication 401', () => Promise.resolve(new Response('{}', { status: 401 }))],
		['authentication 403', () => Promise.resolve(new Response('{}', { status: 403 }))],
		[
			'rate limit',
			() => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }))
		],
		['request rejection', () => Promise.resolve(new Response('{}', { status: 422 }))],
		[
			'invalid structure',
			() => Promise.resolve(new Response(JSON.stringify({ tracks: { items: [{}] } })))
		]
	])('never persists a %s failure or local cooldown rejection', async (_label, response) => {
		const storage = storageSpy();
		setSpotifyMatchCacheStorageForTests(storage);
		const request = vi.fn(response) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Failure' }, 'token', request)
		).rejects.toBeDefined();
		if (_label === 'rate limit') {
			await expect(
				searchSpotifyTrack({ artist: 'Artist', title: 'Cooldown' }, 'token', request)
			).rejects.toBeDefined();
		}
		expect(storage.set).not.toHaveBeenCalled();
	});

	it.each([
		['5xx', () => Promise.resolve(new Response('{}', { status: 503 }))],
		['network', () => Promise.reject(new TypeError('private network detail'))],
		['invalid JSON', () => Promise.resolve(new Response('{truncated'))]
	])('never persists an exhausted transient %s failure', async (_label, response) => {
		vi.useFakeTimers();
		const storage = storageSpy();
		setSpotifyMatchCacheStorageForTests(storage);
		const request = vi.fn(response) as unknown as Fetcher;
		const pending = searchSpotifyTrack({ artist: 'Artist', title: 'Failure' }, 'token', request);
		const rejection = expect(pending).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(
			SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[0] + SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[1]
		);
		await rejection;
		expect(storage.set).not.toHaveBeenCalled();
	});

	it('never persists timeout or caller-aborted searches', async () => {
		vi.useFakeTimers();
		const storage = storageSpy();
		setSpotifyMatchCacheStorageForTests(storage);
		const stalledRequest = vi.fn(
			async () => new Response(new ReadableStream({ start: () => undefined }))
		) as unknown as Fetcher;
		const timeout = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Timeout' },
			'token',
			stalledRequest
		);
		const timeoutRejection = expect(timeout).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(
			20_000 * 3 + SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[0] + SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[1]
		);
		await timeoutRejection;
		expect(storage.set).not.toHaveBeenCalled();

		resetSpotifyServerSessionForTests();
		setSpotifyMatchCacheStorageForTests(storage);
		const controller = new AbortController();
		const abortRequest = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
						{ once: true }
					);
				})
		) as unknown as Fetcher;
		const aborted = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Abort' },
			'token',
			abortRequest,
			controller.signal
		);
		const abortRejection = expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await abortRejection;
		expect(storage.set).not.toHaveBeenCalled();
	});
});
