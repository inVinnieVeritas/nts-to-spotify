import { describe, expect, it } from 'vitest';
import { parseOfficialNTSArtworkUrl, parseOfficialSpotifyArtworkUrl } from './artwork';

describe('official artwork origins', () => {
	it('accepts current official NTS and Spotify artwork shapes', () => {
		expect(
			parseOfficialNTSArtworkUrl('https://media.ntslive.co.uk/crop/770x770/9b1c8f50-example.jpg')
		).toBe('https://media.ntslive.co.uk/crop/770x770/9b1c8f50-example.jpg');
		expect(
			parseOfficialNTSArtworkUrl('https://media.ntslive.co.uk/resize/1600x0/example.png')
		).toBe('https://media.ntslive.co.uk/resize/1600x0/example.png');
		expect(parseOfficialSpotifyArtworkUrl('https://i.scdn.co/image/ab67616d00001e02')).toBe(
			'https://i.scdn.co/image/ab67616d00001e02'
		);
	});

	it.each([
		'http://media.ntslive.co.uk/crop/770x770/example.jpg',
		'https://user:pass@media.ntslive.co.uk/crop/770x770/example.jpg',
		'https://media.ntslive.co.uk:8443/crop/770x770/example.jpg',
		'https://media.ntslive.co.uk.evil.test/crop/770x770/example.jpg',
		'https://127.0.0.1/crop/770x770/example.jpg',
		'https://192.168.1.2/crop/770x770/example.jpg',
		'https://example.com/crop/770x770/example.jpg',
		'https://media.ntslive.co.uk/arbitrary/example.jpg',
		'https://media.ntslive.co.uk/crop/770x770/example.jpg#fragment',
		'not a URL'
	])('rejects an unofficial or malformed NTS artwork URL: %s', (value) => {
		expect(parseOfficialNTSArtworkUrl(value)).toBeUndefined();
	});

	it.each([
		'http://i.scdn.co/image/example',
		'https://user:pass@i.scdn.co/image/example',
		'https://i.scdn.co:8443/image/example',
		'https://i.scdn.co.evil.test/image/example',
		'https://localhost/image/example',
		'https://10.0.0.1/image/example',
		'https://example.com/image/example',
		'https://i.scdn.co/not-image/example',
		'https://i.scdn.co/image/example?query=1',
		'://bad'
	])('rejects an unofficial or malformed Spotify artwork URL: %s', (value) => {
		expect(parseOfficialSpotifyArtworkUrl(value)).toBeUndefined();
	});
});
