import { describe, expect, it, vi } from 'vitest';
import {
	createPlaylistPreviewInputSignature,
	dismissPlaylistPreview,
	isPlaylistPreviewCurrent,
	parseSpotifyPlaylistPreview,
	runExclusivePlaylistAction,
	parseExistingSpotifyPlaylistId,
	verifyAndSaveExistingPlaylist
} from './playlist-preview.client';

const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';
const TRACK = 'spotify:track:0123456789ABCDEFGHIJKL';
const input = (overrides: Record<string, unknown> = {}) => ({
	playlistId: PLAYLIST_ID,
	title: 'Archive',
	description: 'Description',
	public: false,
	tracks: [TRACK],
	...overrides
});
const payload = {
	playlistId: PLAYLIST_ID,
	mode: 'preview',
	previewFingerprint: 'a'.repeat(64),
	addedCount: 1,
	removedCount: 2,
	retainedCount: 3,
	orderChanged: true,
	titleChanged: false,
	descriptionChanged: false,
	visibilityChanged: false,
	synchronized: false
};

describe('link an existing playlist', () => {
	const verified = (
		body: unknown = { mode: 'verified', playlistId: PLAYLIST_ID, public: true },
		status = 200
	) => ({
		response: new Response(null, { status }),
		body
	});

	it('accepts Spotify Share URLs without accepting a different host or resource', () => {
		for (const value of [
			PLAYLIST_ID,
			` https://open.spotify.com/playlist/${PLAYLIST_ID}?si=share-token `,
			`https://open.spotify.com/playlist/${PLAYLIST_ID}/`
		])
			expect(parseExistingSpotifyPlaylistId(value)).toBe(PLAYLIST_ID);
		for (const value of [
			`https://example.com/playlist/${PLAYLIST_ID}?si=share-token`,
			`https://open.spotify.com.evil.example/playlist/${PLAYLIST_ID}`,
			`http://open.spotify.com/playlist/${PLAYLIST_ID}`,
			`https://someone@open.spotify.com/playlist/${PLAYLIST_ID}`,
			`https://open.spotify.com/track/${PLAYLIST_ID}`,
			`https://open.spotify.com/playlist/${PLAYLIST_ID}#fragment`,
			'not a playlist'
		])
			expect(parseExistingSpotifyPlaylistId(value)).toBeUndefined();
	});

	it('verifies the exact playlist ID before saving its link, without starting a sync', async () => {
		const calls: string[] = [];
		const result = await verifyAndSaveExistingPlaylist({
			value: `https://open.spotify.com/playlist/${PLAYLIST_ID}?si=tracking`,
			verify: async (id) => {
				calls.push(`verify:${id}`);
				return verified();
			},
			persist: async (id, isPublic) => {
				calls.push(`persist:${id}:${isPublic}`);
				return true;
			},
			isCurrent: () => true
		});
		expect(result).toEqual({ status: 'linked', playlistId: PLAYLIST_ID });
		expect(calls).toEqual([`verify:${PLAYLIST_ID}`, `persist:${PLAYLIST_ID}:true`]);
	});

	it('preserves private visibility too when linking', async () => {
		const persist = vi.fn(async () => true);
		await verifyAndSaveExistingPlaylist({
			value: PLAYLIST_ID,
			verify: async () => verified({ mode: 'verified', playlistId: PLAYLIST_ID, public: false }),
			persist,
			isCurrent: () => true
		});
		expect(persist).toHaveBeenCalledWith(PLAYLIST_ID, false);
	});

	it.each([
		[403, { error: 'playlist_not_owned' }, 'rejected'],
		[429, { error: 'spotify_rate_limited', retryAfterSeconds: 120 }, 'rejected'],
		[200, { mode: 'verified', playlistId: 'another-playlist' }, 'invalid-response'],
		[200, { mode: 'created', playlistId: PLAYLIST_ID }, 'invalid-response'],
		[200, { mode: 'verified', playlistId: PLAYLIST_ID }, 'invalid-response'],
		[200, { mode: 'verified', playlistId: PLAYLIST_ID, public: null }, 'invalid-response'],
		[200, null, 'invalid-response']
	])('does not save an unverified link (%s, %j)', async (status, body, outcome) => {
		const persist = vi.fn(async () => true);
		const result = await verifyAndSaveExistingPlaylist({
			value: PLAYLIST_ID,
			verify: async () => verified(body, status),
			persist,
			isCurrent: () => true
		});
		expect(result.status).toBe(outcome);
		expect(persist).not.toHaveBeenCalled();
		if (result.status === 'rejected') expect(result.body).toEqual(body);
	});

	it('rejects invalid input before contacting Spotify', async () => {
		const verify = vi.fn(async () => verified());
		const persist = vi.fn(async () => true);
		expect(
			await verifyAndSaveExistingPlaylist({ value: 'bad', verify, persist, isCurrent: () => true })
		).toEqual({ status: 'invalid-input' });
		expect(verify).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it('does not save a late verification response after leaving the catalogue', async () => {
		let current = true;
		const persist = vi.fn(async () => true);
		const result = await verifyAndSaveExistingPlaylist({
			value: PLAYLIST_ID,
			verify: async () => {
				current = false;
				return verified();
			},
			persist,
			isCurrent: () => current
		});
		expect(result).toEqual({ status: 'cancelled' });
		expect(persist).not.toHaveBeenCalled();
	});

	it('does not report a saved link when persistence fails', async () => {
		expect(
			await verifyAndSaveExistingPlaylist({
				value: PLAYLIST_ID,
				verify: async () => verified(),
				persist: async () => false,
				isCurrent: () => true
			})
		).toEqual({ status: 'save-failed' });
	});
});

describe('playlist preview client state', () => {
	it('accepts a bounded sanitized preview and rejects malformed values', () => {
		const signature = createPlaylistPreviewInputSignature(input());
		expect(parseSpotifyPlaylistPreview(payload, PLAYLIST_ID, signature)).toMatchObject({
			inputSignature: signature,
			addedCount: 1
		});
		for (const malformed of [
			null,
			{ ...payload, playlistId: 'other' },
			{ ...payload, previewFingerprint: 'PRIVATE' },
			{ ...payload, addedCount: -1 },
			{ ...payload, retainedCount: Number.MAX_VALUE },
			{ ...payload, synchronized: 'yes' }
		]) {
			expect(parseSpotifyPlaylistPreview(malformed, PLAYLIST_ID, signature)).toBeUndefined();
		}
	});

	it.each([
		['checkbox or candidate URI', { previewKey: 'review-state-2' }],
		['playlist order', { tracks: [TRACK, 'spotify:track:1234567890ABCDEFGHIJKL'] }],
		['title', { title: 'Changed' }],
		['description', { description: 'Changed' }],
		['visibility', { public: true }],
		['linked playlist', { playlistId: 'ZYXWVUTSRQPONMLKJIHGFE' }]
	])('invalidates after a change to %s', (_label, change) => {
		const originalSignature = createPlaylistPreviewInputSignature(input());
		const preview = parseSpotifyPlaylistPreview(payload, PLAYLIST_ID, originalSignature);
		const changedSignature = createPlaylistPreviewInputSignature(input(change));
		expect(isPlaylistPreviewCurrent(preview, originalSignature)).toBe(true);
		expect(isPlaylistPreviewCurrent(preview, changedSignature)).toBe(false);
	});

	it('prevents concurrent preview or apply actions and releases the gate afterward', async () => {
		const gate = { active: false };
		let release!: () => void;
		const calls: string[] = [];
		const first = runExclusivePlaylistAction(gate, async () => {
			calls.push('first');
			await new Promise<void>((resolve) => (release = resolve));
		});
		const duplicate = runExclusivePlaylistAction(gate, async () => calls.push('duplicate'));
		expect(await duplicate).toBe(false);
		expect(calls).toEqual(['first']);
		release();
		expect(await first).toBe(true);
		expect(await runExclusivePlaylistAction(gate, async () => calls.push('next'))).toBe(true);
		expect(calls).toEqual(['first', 'next']);
	});

	it('dismisses only transient preview state without requests, mutation, or persistence', () => {
		const signature = createPlaylistPreviewInputSignature(input());
		const preview = parseSpotifyPlaylistPreview(payload, PLAYLIST_ID, signature);
		const request = vi.fn();
		const mutateSpotify = vi.fn();
		const persist = vi.fn();
		const catalogueTarget = input();
		const dismissed = dismissPlaylistPreview({
			preview,
			message: 'Preview ready',
			failure: 'Old message'
		});

		expect(dismissed).toEqual({ preview: undefined, message: '', failure: '' });
		expect(preview?.previewFingerprint).toBe('a'.repeat(64));
		expect(catalogueTarget).toEqual(input());
		expect(request).not.toHaveBeenCalled();
		expect(mutateSpotify).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});
});
