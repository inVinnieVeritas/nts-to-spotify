import { describe, expect, it } from 'vitest';
import type { BasicTrack, Match } from '$lib/types';
import { isConfidentSpotifyMatch } from './spotify-match';
import {
	createSpotifyPersistentCacheIdentity,
	createSpotifyPersistentCacheKey
} from './spotify-match-cache.server';

const TRACK_ID = '0123456789ABCDEFGHIJKL';

const track = (title: string, artist = 'Artist'): BasicTrack => ({ artist, title });
const match = (title: string, artist = 'Artist'): Match => ({
	artist,
	title,
	uri: `spotify:track:${TRACK_ID}`,
	href: `https://open.spotify.com/track/${TRACK_ID}`
});

describe('Spotify match title equivalence', () => {
	it.each([
		'Song Title - Remastered',
		'Song Title - 2011 Remaster',
		'Song Title - 2011 Remastered',
		'Song Title - Remastered 2011',
		'Song Title (Remastered)',
		'Song Title (2011 Remaster)',
		'Song Title [2020 Remaster]',
		'Song Title - Remastered Version',
		'Song Title - Digital Remaster',
		'Song Title - 2009 Digital Remaster'
	])('accepts an exact title with the trailing qualifier in %s', (spotifyTitle) => {
		expect(isConfidentSpotifyMatch(track('Song Title'), match(spotifyTitle))).toBe(true);
	});

	it('applies remaster equivalence symmetrically', () => {
		expect(isConfidentSpotifyMatch(track('Song Title - 2011 Remaster'), match('Song Title'))).toBe(
			true
		);
		expect(
			isConfidentSpotifyMatch(track('Song Title (2011 Remaster)'), match('Song Title - Remastered'))
		).toBe(true);
	});

	it('combines existing case and punctuation normalization with remaster equivalence', () => {
		expect(isConfidentSpotifyMatch(track('SONG: Title!'), match('song title — REMASTERED'))).toBe(
			true
		);
		expect(isConfidentSpotifyMatch(track('Song Title'), match('Song Title: Remastered'))).toBe(
			true
		);
	});

	it('still requires an artist match', () => {
		expect(
			isConfidentSpotifyMatch(
				track('Song Title', 'Artist'),
				match('Song Title - Remastered', 'Other')
			)
		).toBe(false);
	});

	it.each([
		'Song Title - Version',
		'Song Title - 2011',
		'Song Title - Digital',
		'Song Title - Version Remastered',
		'Song Title - 24-bit Remaster',
		'Song Title - Remastered - Live',
		'Song Title - Live - Remastered',
		'Song Title - Remix',
		'Song Title - Live',
		'Song Title - Acoustic',
		'Song Title - Demo',
		'Song Title - Instrumental',
		'Song Title - Radio Edit',
		'Song Title - Edit',
		'Song Title - Extended Mix',
		'Song Title - Re-recorded',
		'Song Title - Re-recording',
		'Song Title - Cover',
		'Song Title - Alternate Take',
		'Song Title - Session Version',
		'Song Title - Mono',
		'Song Title - Stereo'
	])('keeps the non-remaster edition %s distinct', (spotifyTitle) => {
		expect(isConfidentSpotifyMatch(track('Song Title'), match(spotifyTitle))).toBe(false);
	});

	it('strips a final remaster qualifier without erasing an earlier live qualifier', () => {
		expect(
			isConfidentSpotifyMatch(track('Song Title - Live'), match('Song Title - Live - Remastered'))
		).toBe(true);
	});

	it('does not strip remaster from the middle of a legitimate title', () => {
		expect(isConfidentSpotifyMatch(track('The Remaster Project'), match('The Project'))).toBe(
			false
		);
		expect(
			isConfidentSpotifyMatch(track('The Remaster Project'), match('The Remaster Project'))
		).toBe(true);
	});

	it('keeps match-equivalent titles separate in the persistent query cache', () => {
		expect(
			createSpotifyPersistentCacheKey(createSpotifyPersistentCacheIdentity(track('Song Title'), 1))
		).not.toBe(
			createSpotifyPersistentCacheKey(
				createSpotifyPersistentCacheIdentity(track('Song Title - Remastered'), 1)
			)
		);
	});
});
