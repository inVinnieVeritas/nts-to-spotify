import { describe, expect, it, vi } from 'vitest';
import {
	createPlaylistPreviewInputSignature,
	dismissPlaylistPreview,
	isPlaylistPreviewCurrent,
	parseSpotifyPlaylistPreview,
	runExclusivePlaylistAction
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
