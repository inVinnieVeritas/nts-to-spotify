import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchedTrack } from '$lib/types';
import {
	createSpotifySearchCacheKey,
	getSpotifySessionMetrics,
	isSpotifyRateLimitError,
	normalizeSpotifySearchKeyPart,
	parseRetryAfter,
	parseSpotifyRateLimitReason,
	parseSpotifyTrackSearchResult,
	resetSpotifyServerSessionForTests,
	searchSpotifyTrack,
	SPOTIFY_SEARCH_INTERVAL_MS,
	SpotifyRateLimitError,
	SpotifyResponseValidationError,
	SpotifySearchUnavailableError,
	SpotifySearchSessionCache
} from './spotify.server';
import type { Fetcher } from './request';

const TRACK_ID = '0123456789ABCDEFGHIJKL';

const spotifyItem = (title = 'Track') => ({
	artists: [{ name: 'Artist' }],
	name: title,
	uri: `spotify:track:${TRACK_ID}`,
	preview_url: null,
	album: { images: [] },
	external_urls: { spotify: `https://open.spotify.com/track/${TRACK_ID}` }
});

const searchResponse = (items: unknown[] = [spotifyItem()]) =>
	new Response(JSON.stringify({ tracks: { items } }), {
		headers: { 'Content-Type': 'application/json' }
	});

const matchedTrack = (title: string): MatchedTrack => ({
	artist: 'Artist',
	title,
	matches: [
		{
			artist: 'Artist',
			title,
			uri: `spotify:track:${title}`,
			href: `https://open.spotify.com/track/${title}`
		}
	],
	confident: true,
	fallback: false
});

describe('Spotify search response parsing', () => {
	it('accepts realistic candidates with optional preview, artwork, and link fields missing or null', () => {
		const missingOptional = parseSpotifyTrackSearchResult({
			tracks: {
				items: [
					{
						artists: [{ name: 'Artist' }],
						name: 'Track',
						uri: `spotify:track:${TRACK_ID}`
					}
				]
			}
		});
		const nullableOptional = parseSpotifyTrackSearchResult({
			tracks: {
				items: [
					{
						artists: [{ name: 'Artist' }],
						name: 'Track',
						uri: `spotify:track:${TRACK_ID}`,
						preview_url: null,
						album: null,
						external_urls: null
					}
				]
			}
		});

		for (const parsed of [missingOptional, nullableOptional]) {
			expect(parsed).toEqual({
				matches: [
					{
						artist: 'Artist',
						title: 'Track',
						uri: `spotify:track:${TRACK_ID}`,
						preview: undefined,
						cover: undefined,
						href: `https://open.spotify.com/track/${TRACK_ID}`
					}
				],
				skippedCandidates: 0,
				adjustedCandidates: 0
			});
		}
	});

	it('keeps usable candidates while skipping malformed individual candidates', () => {
		const parsed = parseSpotifyTrackSearchResult({
			tracks: {
				items: [
					null,
					{ name: 'Missing URI and artists' },
					{
						...spotifyItem(),
						preview_url: 'https://p.scdn.co/mp3-preview/example',
						album: {
							images: [
								{ height: null, width: null, url: 'https://i.scdn.co/image/example' },
								{ url: null }
							]
						}
					}
				]
			}
		});

		expect(parsed.skippedCandidates).toBe(2);
		expect(parsed.adjustedCandidates).toBe(1);
		expect(parsed.matches).toEqual([
			expect.objectContaining({
				uri: `spotify:track:${TRACK_ID}`,
				preview: 'https://p.scdn.co/mp3-preview/example',
				cover: 'https://i.scdn.co/image/example'
			})
		]);
	});

	it('rejects malformed top-level structures and responses with no usable candidates', () => {
		expect(() => parseSpotifyTrackSearchResult({ tracks: null })).toThrow(
			SpotifyResponseValidationError
		);
		expect(() =>
			parseSpotifyTrackSearchResult({ tracks: { items: [{ name: 'Unusable' }] } })
		).toThrow(SpotifyResponseValidationError);
	});
});

describe('Spotify rate limiting', () => {
	beforeEach(() => resetSpotifyServerSessionForTests());
	afterEach(() => {
		vi.useRealTimers();
	});

	it('parses complete delta seconds and HTTP dates and rejects invalid values', () => {
		const now = Date.parse('2026-08-14T12:00:00Z');
		expect(parseRetryAfter('12', now)).toBe(12);
		expect(parseRetryAfter('2.2', now)).toBe(1);
		expect(parseRetryAfter('Fri, 14 Aug 2026 12:00:09 GMT', now)).toBe(9);
		expect(parseRetryAfter('invalid', now)).toBe(1);
		expect(parseRetryAfter('-4', now)).toBe(1);
		expect(parseRetryAfter('30785', now)).toBe(30_785);
		expect(parseRetryAfter(String(Number.MAX_VALUE), now)).toBe(1);
		expect(parseRetryAfter(String(Number.MAX_SAFE_INTEGER), now)).toBe(1);
		expect(
			parseRetryAfter(String(Math.floor((Number.MAX_SAFE_INTEGER - now) / 1000) + 1), now)
		).toBe(1);
	});

	it('recognizes only the validated quota reason and safely falls back otherwise', () => {
		expect(parseSpotifyRateLimitReason({ error: { reason: 'QUOTA_EXCEEDED' } })).toBe(
			'quota-exceeded'
		);
		for (const payload of [
			null,
			{},
			{ error: null },
			{ error: { reason: 1 } },
			{ error: { reason: 'UNKNOWN' } },
			{ reason: 'QUOTA_EXCEEDED' }
		]) {
			expect(parseSpotifyRateLimitReason(payload)).toBe('rate-limited');
		}
	});

	it('recognizes real and structurally equivalent rate-limit errors only', () => {
		expect(isSpotifyRateLimitError(new SpotifyRateLimitError(17, 'quota-exceeded'))).toBe(true);
		expect(
			isSpotifyRateLimitError({
				name: 'SpotifyRateLimitError',
				retryAfterSeconds: 17,
				reason: 'rate-limited'
			})
		).toBe(true);
		expect(isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: 17 })).toBe(
			true
		);
		expect(
			isSpotifyRateLimitError({
				name: 'SpotifyRateLimitError',
				retryAfterSeconds: 17,
				reason: 'QUOTA_EXCEEDED'
			})
		).toBe(false);
		expect(
			isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: '17' })
		).toBe(false);
		expect(isSpotifyRateLimitError({ name: 'SpotifyRateLimitError', retryAfterSeconds: 0 })).toBe(
			false
		);
		expect(
			isSpotifyRateLimitError({
				name: 'SpotifyRateLimitError',
				retryAfterSeconds: Number.MAX_SAFE_INTEGER
			})
		).toBe(false);
		expect(isSpotifyRateLimitError({ name: 'Error', retryAfterSeconds: 17 })).toBe(false);
	});

	it('holds queue concurrency until the complete response body is consumed', async () => {
		vi.useFakeTimers();
		let firstBody: ReadableStreamDefaultController<Uint8Array> | undefined;
		const responseBody = JSON.stringify({ tracks: { items: [spotifyItem()] } });
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
			return searchResponse([spotifyItem('Other')]);
		});
		const request = requestMock as unknown as Fetcher;

		const first = searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request);
		await vi.advanceTimersByTimeAsync(0);
		const second = searchSpotifyTrack({ artist: 'Artist', title: 'Other' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		expect(request).toHaveBeenCalledTimes(1);

		firstBody?.enqueue(new TextEncoder().encode(responseBody));
		firstBody?.close();
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await Promise.all([first, second]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('paces actual request starts by two seconds', async () => {
		vi.useFakeTimers();
		const starts: number[] = [];
		const request = vi.fn(async () => {
			starts.push(Date.now());
			return searchResponse();
		}) as unknown as Fetcher;

		await searchSpotifyTrack({ artist: 'Artist', title: 'First' }, 'token', request);
		const second = searchSpotifyTrack({ artist: 'Artist', title: 'Second' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS - 1);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await second;
		expect(starts[1] - starts[0]).toBe(SPOTIFY_SEARCH_INTERVAL_MS);
	});

	it('fails queued and subsequent searches with the quota reason during an existing cooldown', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { reason: 'QUOTA_EXCEEDED' } }), {
					status: 429,
					headers: { 'Retry-After': '30785' }
				})
		) as unknown as Fetcher;

		const first = searchSpotifyTrack({ artist: 'Artist', title: 'First' }, 'token', request);
		const queued = searchSpotifyTrack({ artist: 'Artist', title: 'Queued' }, 'token', request);
		const resultsPromise = Promise.allSettled([first, queued]);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS + 1);
		const results = await resultsPromise;

		for (const result of results) {
			expect(result).toMatchObject({
				status: 'rejected',
				reason: {
					name: 'SpotifyRateLimitError',
					retryAfterSeconds: 30_785,
					reason: 'quota-exceeded'
				}
			});
		}
		expect(request).toHaveBeenCalledOnce();

		const subsequent = await searchSpotifyTrack(
			{ artist: 'Artist', title: 'Subsequent' },
			'token',
			request
		).then(
			() => null,
			(cause) => cause as SpotifyRateLimitError
		);
		expect(subsequent).not.toBeNull();
		if (!subsequent) throw new Error('Expected the active cooldown to reject the search');
		expect(subsequent).toMatchObject({ reason: 'quota-exceeded' });
		expect(subsequent.retryAfterSeconds).toBeGreaterThan(30_780);
		expect(subsequent.retryAfterSeconds).toBeLessThanOrEqual(30_785);
		expect(request).toHaveBeenCalledOnce();
		expect(getSpotifySessionMetrics()).toEqual({
			searchRequests: 1,
			cacheHits: 0,
			rateLimitResponses: 0,
			quotaExceededResponses: 1
		});
	});
});

describe('Spotify server-session search cache', () => {
	beforeEach(() => resetSpotifyServerSessionForTests());
	afterEach(() => {
		vi.useRealTimers();
	});

	it('normalizes conservatively while preserving punctuation and market distinctions', () => {
		expect(normalizeSpotifySearchKeyPart('  ARTIST\t Name  ')).toBe('artist name');
		expect(createSpotifySearchCacheKey({ artist: 'Artist', title: 'A-B' }, 1)).not.toBe(
			createSpotifySearchCacheKey({ artist: 'Artist', title: 'A B' }, 1)
		);
		expect(createSpotifySearchCacheKey({ artist: 'Artist', title: 'Track' }, 1, 'BE')).not.toBe(
			createSpotifySearchCacheKey({ artist: 'Artist', title: 'Track' }, 1, 'US')
		);
	});

	it('coalesces concurrent normalized searches into one Spotify request', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = vi.fn(async () => {
			await gate;
			return searchResponse();
		}) as unknown as Fetcher;

		const first = searchSpotifyTrack({ artist: ' Artist ', title: 'TRACK' }, 'token-a', request);
		const second = searchSpotifyTrack({ artist: 'artist', title: 'track' }, 'token-b', request);
		expect(request).toHaveBeenCalledOnce();
		release?.();
		await Promise.all([first, second]);
		expect(request).toHaveBeenCalledOnce();
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 1, cacheHits: 1 });
	});

	it('does not count failed coalesced callers as successful cache hits', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = vi.fn(async () => {
			await gate;
			return new Response('{}', { status: 401 });
		}) as unknown as Fetcher;
		const first = searchSpotifyTrack({ artist: 'Artist', title: 'Failure' }, 'token', request);
		const second = searchSpotifyTrack({ artist: 'artist', title: 'failure' }, 'token', request);
		release?.();
		await Promise.allSettled([first, second]);

		expect(request).toHaveBeenCalledOnce();
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 1, cacheHits: 0 });
	});

	it('returns settled cache hits immediately without queue pacing or mutable references', async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => searchResponse()) as unknown as Fetcher;
		const first = await searchSpotifyTrack({ artist: 'Artist', title: 'Track' }, 'token', request);
		first.matches[0].title = 'Mutated consumer value';

		const cached = await searchSpotifyTrack(
			{ artist: ' artist ', title: ' track ' },
			'another-token',
			request
		);
		expect(cached).toMatchObject({ artist: ' artist ', title: ' track ' });
		expect(cached.matches[0].title).toBe('Track');
		expect(request).toHaveBeenCalledOnce();
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 1, cacheHits: 1 });
	});

	it('caches successful empty final results', async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => searchResponse([])) as unknown as Fetcher;
		const first = searchSpotifyTrack({ artist: 'Artist', title: 'Missing' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		expect(await first).toMatchObject({ matches: [], fallback: true });
		expect(request).toHaveBeenCalledTimes(2);

		expect(
			await searchSpotifyTrack({ artist: 'artist', title: 'missing' }, 'other-token', request)
		).toMatchObject({ matches: [], fallback: true });
		expect(request).toHaveBeenCalledTimes(2);
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 2, cacheHits: 1 });
	});

	it('does not cache a sanitized result that skipped malformed candidates', async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => searchResponse([null, spotifyItem()])) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Mixed' }, 'token', request)
		).resolves.toMatchObject({ matches: [expect.objectContaining({ title: 'Track' })] });

		const repeated = searchSpotifyTrack({ artist: 'Artist', title: 'Mixed' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await expect(repeated).resolves.toMatchObject({ matches: [expect.any(Object)] });
		expect(request).toHaveBeenCalledTimes(2);
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 2, cacheHits: 0 });
	});

	it('does not cache a sanitized result that adjusted an optional candidate field', async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () =>
			searchResponse([{ ...spotifyItem(), preview_url: 'javascript:unsafe' }])
		) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Adjusted' }, 'token', request)
		).resolves.toMatchObject({ matches: [expect.objectContaining({ preview: undefined })] });

		const repeated = searchSpotifyTrack({ artist: 'Artist', title: 'Adjusted' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await expect(repeated).resolves.toMatchObject({ matches: [expect.any(Object)] });
		expect(request).toHaveBeenCalledTimes(2);
		expect(getSpotifySessionMetrics()).toMatchObject({ searchRequests: 2, cacheHits: 0 });
	});

	it('does not cache ordinary 429 responses after their cooldown expires', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			async () =>
				new Response('{}', {
					status: 429,
					headers: { 'Retry-After': '1' }
				})
		) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Limited' }, 'token', request)
		).rejects.toMatchObject({ reason: 'rate-limited' });

		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Limited' }, 'token', request)
		).rejects.toMatchObject({ reason: 'rate-limited' });
		expect(request).toHaveBeenCalledTimes(2);
		expect(getSpotifySessionMetrics()).toMatchObject({
			searchRequests: 2,
			rateLimitResponses: 2,
			quotaExceededResponses: 0
		});
	});

	it.each([
		['HTTP 401', () => Promise.resolve(new Response('{}', { status: 401 }))],
		['HTTP 403', () => Promise.resolve(new Response('{}', { status: 403 }))],
		['HTTP 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
		['HTTP 503', () => Promise.resolve(new Response('{}', { status: 503 }))],
		['invalid JSON', () => Promise.resolve(new Response('{not-json'))],
		['network rejection', () => Promise.reject(new Error('private network detail'))]
	])('wraps and does not cache systemic Spotify %s failures', async (_label, response) => {
		vi.useFakeTimers();
		const request = vi.fn(response) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Failure' }, 'token', request)
		).rejects.toBeInstanceOf(SpotifySearchUnavailableError);
		const repeated = searchSpotifyTrack({ artist: 'Artist', title: 'Failure' }, 'token', request);
		const repeatedExpectation = expect(repeated).rejects.toBeInstanceOf(
			SpotifySearchUnavailableError
		);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await repeatedExpectation;
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('keeps parser-invalid responses typed separately and non-cacheable', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			async () => new Response(JSON.stringify({ tracks: { items: [{}] } }))
		) as unknown as Fetcher;
		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Invalid' }, 'token', request)
		).rejects.toBeInstanceOf(SpotifyResponseValidationError);
		const repeated = searchSpotifyTrack({ artist: 'Artist', title: 'Invalid' }, 'token', request);
		const repeatedExpectation = expect(repeated).rejects.toBeInstanceOf(
			SpotifyResponseValidationError
		);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await repeatedExpectation;
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('does not cache a timed-out stalled response body', async () => {
		vi.useFakeTimers();
		let requestCount = 0;
		const requestMock = vi.fn(async () =>
			++requestCount === 1
				? new Response(new ReadableStream({ start: () => undefined }))
				: searchResponse()
		);
		const request = requestMock as unknown as Fetcher;
		const first = searchSpotifyTrack({ artist: 'Artist', title: 'Timeout' }, 'token', request);
		const firstExpectation = expect(first).rejects.toBeInstanceOf(SpotifySearchUnavailableError);
		await vi.advanceTimersByTimeAsync(20_000);
		await firstExpectation;

		await expect(
			searchSpotifyTrack({ artist: 'Artist', title: 'Timeout' }, 'token', request)
		).resolves.toMatchObject({ title: 'Timeout' });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('wraps a timed-out Spotify Search request as unavailable', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() =>
							reject(Object.assign(new Error('private timeout detail'), { name: 'AbortError' })),
						{ once: true }
					);
				})
		) as unknown as Fetcher;
		const pending = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Request timeout' },
			'token',
			request
		);
		const expectation = expect(pending).rejects.toBeInstanceOf(SpotifySearchUnavailableError);

		await vi.advanceTimersByTimeAsync(20_000);
		await expectation;
		expect(request).toHaveBeenCalledOnce();
	});

	it('removes an aborted in-flight search and allows a later retry', async () => {
		vi.useFakeTimers();
		let requestCount = 0;
		const requestMock = vi.fn(async () =>
			++requestCount === 1
				? new Response(new ReadableStream({ start: () => undefined }))
				: searchResponse()
		);
		const request = requestMock as unknown as Fetcher;
		const controller = new AbortController();
		const first = searchSpotifyTrack(
			{ artist: 'Artist', title: 'Cancelled' },
			'token',
			request,
			controller.signal
		);
		const firstExpectation = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await firstExpectation;

		const repeated = searchSpotifyTrack({ artist: 'Artist', title: 'Cancelled' }, 'token', request);
		await vi.advanceTimersByTimeAsync(SPOTIFY_SEARCH_INTERVAL_MS);
		await expect(repeated).resolves.toMatchObject({ title: 'Cancelled' });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([
		['rate limit', new SpotifyRateLimitError(10)],
		['timeout', new SpotifySearchUnavailableError()],
		['abort', Object.assign(new Error('cancelled'), { name: 'AbortError' })],
		['authentication', new Error('authentication failed')],
		['malformed response', new Error('malformed response')]
	])('does not cache %s failures and removes failed in-flight entries', async (_label, failure) => {
		const cache = new SpotifySearchSessionCache(10, 1_000);
		const load = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(matchedTrack('Track'));
		await expect(cache.getOrCreate('key', load)).rejects.toBe(failure);
		await expect(cache.getOrCreate('key', load)).resolves.toMatchObject({ title: 'Track' });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('aborts shared work only after every subscriber has cancelled', async () => {
		const cache = new SpotifySearchSessionCache(10, 1_000);
		let sharedSignal: AbortSignal | undefined;
		let resolveLoad: ((value: MatchedTrack) => void) | undefined;
		const load = vi.fn(
			(signal: AbortSignal) =>
				new Promise<MatchedTrack>((resolve) => {
					sharedSignal = signal;
					resolveLoad = resolve;
				})
		);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = cache.getOrCreate('key', load, firstController.signal);
		const second = cache.getOrCreate('key', load, secondController.signal);

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		expect(sharedSignal?.aborted).toBe(false);
		resolveLoad?.(matchedTrack('Track'));
		await expect(second).resolves.toMatchObject({ title: 'Track' });
		expect(load).toHaveBeenCalledOnce();
	});

	it('expires entries at the TTL and evicts the oldest entry deterministically at maximum size', async () => {
		let now = 100;
		const cache = new SpotifySearchSessionCache(2, 50, () => now);
		const load = vi.fn(async (title: string) => matchedTrack(title));
		await cache.getOrCreate('a', () => load('A'));
		await cache.getOrCreate('b', () => load('B'));
		await cache.getOrCreate('c', () => load('C'));
		await cache.getOrCreate('a', () => load('A2'));
		expect(load.mock.calls.map(([title]) => title)).toEqual(['A', 'B', 'C', 'A2']);

		now += 51;
		await cache.getOrCreate('c', () => load('C2'));
		expect(load).toHaveBeenLastCalledWith('C2');
	});
});
