import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPOTIFY_SCOPES } from '$lib/constants';
import { RequestTimeoutError } from './abort';
import {
	getSpotifyProfile,
	parseSpotifyProfile,
	SpotifyProfileError,
	SPOTIFY_PROFILE_TIMEOUT_MS
} from './spotify-profile.server';

describe('Spotify profile minimization', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('exposes only the canonical ID, display name and first safe image', () => {
		const profile = parseSpotifyProfile({
			id: 'spotify-user',
			display_name: 'Listener',
			email: 'private@example.test',
			href: 'https://api.spotify.com/v1/users/spotify-user',
			images: [
				{ url: 'javascript:alert(1)' },
				{ url: 'https://i.scdn.co/image/first' },
				{ url: 'https://i.scdn.co/image/second' }
			]
		});
		expect(profile).toEqual({
			id: 'spotify-user',
			display_name: 'Listener',
			image: 'https://i.scdn.co/image/first'
		});
		expect(JSON.stringify(profile)).not.toContain('private@example.test');
	});

	it('requests no email or image-upload OAuth scopes', () => {
		expect(SPOTIFY_SCOPES.split(' ')).toEqual([
			'playlist-modify-public',
			'playlist-modify-private'
		]);
	});

	it.each([
		null,
		{},
		{ id: '', display_name: 'Listener' },
		{ id: '   ', display_name: 'Listener' },
		{ id: 'bad\nvalue', display_name: 'Listener' }
	])('rejects an invalid required profile shape', (value) => {
		expect(() => parseSpotifyProfile(value)).toThrow(SpotifyProfileError);
	});

	it('falls back for whitespace-only display names without rewriting legitimate Unicode text', () => {
		expect(parseSpotifyProfile({ id: 'user', display_name: '   ' }).display_name).toBe(
			'Spotify user'
		);
		expect(parseSpotifyProfile({ id: 'user', display_name: '  Björk 李  ' }).display_name).toBe(
			'  Björk 李  '
		);
		expect(parseSpotifyProfile({ id: 'user', display_name: 'bad\u0007name' }).display_name).toBe(
			'Spotify user'
		);
	});

	it('uses a bounded deadline for response-body consumption', async () => {
		vi.useFakeTimers();
		const body = new ReadableStream({ start: (controller) => void controller });
		const request = vi.fn(async () => new Response(body, { status: 200 }));
		const loading = getSpotifyProfile(request as typeof fetch, 'redacted');
		const expectation = expect(loading).rejects.toBeInstanceOf(RequestTimeoutError);
		await vi.advanceTimersByTimeAsync(SPOTIFY_PROFILE_TIMEOUT_MS);
		await expectation;
	});

	it('uses a bounded deadline while waiting for response headers', async () => {
		vi.useFakeTimers();
		const request = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener(
						'abort',
						() => reject(Object.assign(new Error('private timeout'), { name: 'AbortError' })),
						{ once: true }
					)
				)
		) as typeof fetch;
		const loading = getSpotifyProfile(request, 'redacted');
		const expectation = expect(loading).rejects.toBeInstanceOf(RequestTimeoutError);
		await vi.advanceTimersByTimeAsync(SPOTIFY_PROFILE_TIMEOUT_MS);
		await expectation;
	});

	it('sanitizes non-successful and invalid JSON responses', async () => {
		await expect(
			getSpotifyProfile(
				vi.fn(async () => new Response('private upstream body', { status: 500 })) as typeof fetch,
				'redacted'
			)
		).rejects.toMatchObject({ name: 'SpotifyProfileError', reason: 'unavailable' });
		await expect(
			getSpotifyProfile(
				vi.fn(async () => new Response('not json', { status: 200 })) as typeof fetch,
				'redacted'
			)
		).rejects.toMatchObject({ name: 'SpotifyProfileError', reason: 'invalid-response' });
	});
});
