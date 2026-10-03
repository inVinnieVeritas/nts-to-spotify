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
	it('accepts only the observed one-pass apostrophe representation, keeping raw fingerprints', () => {
		const description =
			"A comprehensive archive of tracks played on Jim O'Rourke on NTS Radio, covering broadcasts from 20 January 2022 through 6 August 2026. Some tracks unavailable on Spotify may be missing.";
		const encoded = description.replaceAll("'", '&#x27;');
		const state = current([uri(1)], { description: encoded });
		expect(compareSpotifyPlaylist(state, target([uri(1)], { description }))).toMatchObject({
			descriptionChanged: false,
			synchronized: true
		});
		expect(fingerprintSpotifyPlaylist(state)).not.toBe(
			fingerprintSpotifyPlaylist({ ...state, description })
		);
		expect(fingerprintSpotifyPlaylistPreview(state, target([uri(1)], { description }))).not.toBe(
			fingerprintSpotifyPlaylistPreview(state, target([uri(1)], { description: encoded }))
		);
		for (const [actual, expected, changed] of [
			['Literal &#x27; text', 'Literal &#x27; text', false],
			["Literal ' text", 'Literal &#x27; text', true],
			['Literal &amp;#x27; text', 'Literal &#x27; text', true],
			[encoded.replaceAll('&#x27;', '&amp;#x27;'), description, true],
			[encoded + ' External edit', description, true],
			[encoded + ' ', description, true],
			['Jim O&#39;Rourke', "Jim O'Rourke", true],
			['<b>Archive</b>', 'Archive', true],
			['A &amp; B', 'A & B', true],
			['Already &#x27; plus &#x27;', "Already &#x27; plus '", false]
		] as const) {
			expect(
				compareSpotifyPlaylist(
					current([uri(1)], { description: actual }),
					target([uri(1)], { description: expected })
				).descriptionChanged
			).toBe(changed);
		}
	});
	it('does not infer description equivalence from escaped text or strip metadata', () => {
		const plain = 'Jim O\'Rourke & guests <archive> "quoted"';
		for (const encoded of [
			'Jim O&#x27;Rourke &amp; guests &lt;archive&gt; &quot;quoted&quot;',
			'Jim O&#39;Rourke &#38; guests &#60;archive&#62; &#34;quoted&#34;'
		]) {
			expect(
				compareSpotifyPlaylist(
					current([uri(1)], { description: encoded }),
					target([uri(1)], { description: plain })
				).synchronized
			).toBe(false);
			expect(fingerprintSpotifyPlaylist(current([uri(1)], { description: encoded }))).not.toBe(
				fingerprintSpotifyPlaylist(current([uri(1)], { description: plain }))
			);
		}
		for (const [actual, requested] of [
			['A &amp;amp; B', 'A & B'],
			['A & B', 'A &amp; B'],
			['<b>Archive</b>', 'Archive'],
			['Different description', 'Description'],
			['Description ', 'Description'],
			['&#65;rchive', 'Archive']
		])
			expect(
				compareSpotifyPlaylist(
					current([uri(1)], { description: actual }),
					target([uri(1)], { description: requested })
				).descriptionChanged
			).toBe(true);
	});
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
