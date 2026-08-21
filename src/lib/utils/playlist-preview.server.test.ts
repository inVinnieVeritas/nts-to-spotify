import { describe, expect, it } from 'vitest';
import {
	canonicalSpotifyTrackUri,
	compareSpotifyPlaylist,
	fingerprintSpotifyPlaylist,
	fingerprintSpotifyPlaylistPreview,
	isSpotifyPlaylistFingerprint,
	spotifyPlaylistItemTrackUri,
	type SpotifyPlaylistState
} from './playlist-preview.server';

const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV';
const uri = (index: number) => `spotify:track:${String(index).padStart(22, '0')}`;
const current = (items: (string | null)[], overrides: Partial<SpotifyPlaylistState> = {}) => ({
	playlistId,
	snapshotId: 'snapshot-1',
	name: 'Archive',
	description: 'Description',
	public: false,
	items,
	...overrides
});
const target = (tracks: string[], overrides: Record<string, unknown> = {}) => ({
	name: 'Archive',
	description: 'Description',
	public: false,
	tracks,
	...overrides
});

describe('Spotify playlist preview comparison', () => {
	it('canonicalizes only exact Spotify track URIs from valid non-local track items', () => {
		const trackUri = uri(1);
		expect(canonicalSpotifyTrackUri(trackUri)).toBe(trackUri);
		expect(canonicalSpotifyTrackUri(trackUri.slice(-22))).toBeNull();
		expect(
			canonicalSpotifyTrackUri(`https://open.spotify.com/track/${trackUri.slice(-22)}`)
		).toBeNull();
		expect(
			spotifyPlaylistItemTrackUri({
				is_local: false,
				item: { type: 'track', uri: trackUri, is_local: false }
			})
		).toBe(trackUri);
		expect(
			spotifyPlaylistItemTrackUri({
				is_local: false,
				track: { type: 'track', uri: trackUri, is_local: false }
			})
		).toBe(trackUri);
		for (const invalid of [
			{ item: null },
			{ is_local: true, item: { type: 'track', uri: trackUri } },
			{ item: { type: 'track', uri: trackUri, is_local: true } },
			{ item: { type: 'episode', uri: `spotify:episode:${'E'.repeat(22)}` } },
			{ item: { type: 'track', uri: trackUri.slice(-22) } },
			{ item: { type: 'track', uri: `https://open.spotify.com/track/${trackUri.slice(-22)}` } }
		]) {
			expect(spotifyPlaylistItemTrackUri(invalid)).toBeNull();
		}
	});

	it('counts duplicate current occurrences against a URI-deduplicated target', () => {
		expect(
			compareSpotifyPlaylist(current([uri(1), uri(1), uri(2), null]), target([uri(1), uri(3)]))
		).toEqual({
			addedCount: 1,
			removedCount: 3,
			retainedCount: 1,
			orderChanged: false,
			titleChanged: false,
			descriptionChanged: false,
			visibilityChanged: false,
			synchronized: false
		});
	});

	it('distinguishes retained-order changes from additions and removals', () => {
		expect(
			compareSpotifyPlaylist(current([uri(1), uri(2)]), target([uri(2), uri(1)])).orderChanged
		).toBe(true);
		expect(compareSpotifyPlaylist(current([uri(1)]), target([uri(1), uri(2)])).orderChanged).toBe(
			false
		);
	});

	it.each([
		['title', { name: 'New' }, [true, false, false]],
		['description', { description: 'New description' }, [false, true, false]],
		['visibility', { public: true }, [false, false, true]]
	])('reports a %s-only change independently', (_label, override, expected) => {
		const preview = compareSpotifyPlaylist(current([uri(1)]), target([uri(1)], override));
		expect([preview.titleChanged, preview.descriptionChanged, preview.visibilityChanged]).toEqual(
			expected
		);
		expect(preview.synchronized).toBe(false);
	});

	it('recognizes completely synchronized ordered contents and metadata', () => {
		expect(
			compareSpotifyPlaylist(current([uri(1), uri(2)]), target([uri(1), uri(2)]))
		).toMatchObject({
			addedCount: 0,
			removedCount: 0,
			retainedCount: 2,
			orderChanged: false,
			synchronized: true
		});
	});

	it('fingerprints every playlist-state input and validates only canonical fingerprints', () => {
		const base = current([uri(1), null]);
		const fingerprint = fingerprintSpotifyPlaylist(base);
		expect(isSpotifyPlaylistFingerprint(fingerprint)).toBe(true);
		expect(fingerprintSpotifyPlaylist({ ...base, snapshotId: 'snapshot-2' })).not.toBe(fingerprint);
		expect(fingerprintSpotifyPlaylist({ ...base, name: 'Changed' })).not.toBe(fingerprint);
		expect(fingerprintSpotifyPlaylist({ ...base, items: [null, uri(1)] })).not.toBe(fingerprint);
		expect(isSpotifyPlaylistFingerprint('A'.repeat(64))).toBe(false);
	});

	it('binds the preview fingerprint to target metadata and ordered tracks', () => {
		const state = current([uri(1)]);
		const baseTarget = target([uri(1), uri(2)]);
		const fingerprint = fingerprintSpotifyPlaylistPreview(state, baseTarget);
		expect(fingerprintSpotifyPlaylistPreview(state, { ...baseTarget, name: 'Changed' })).not.toBe(
			fingerprint
		);
		expect(
			fingerprintSpotifyPlaylistPreview(state, { ...baseTarget, tracks: [uri(2), uri(1)] })
		).not.toBe(fingerprint);
	});
});
