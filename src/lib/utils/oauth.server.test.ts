import { describe, expect, it } from 'vitest';
import {
	createOAuthState,
	getSafeReturnPathFromReferer,
	isValidOAuthState,
	normalizeSafeReturnPath,
	oauthStatesMatch
} from './oauth.server';

describe('Spotify OAuth state', () => {
	it('creates cryptographically shaped state and compares it safely', () => {
		const state = createOAuthState();
		expect(isValidOAuthState(state)).toBe(true);
		expect(oauthStatesMatch(state, state)).toBe(true);
		expect(oauthStatesMatch(state, createOAuthState())).toBe(false);
		expect(oauthStatesMatch('malformed', state)).toBe(false);
	});
});

describe('OAuth return paths', () => {
	it.each([
		['/shows/example', '/shows/example'],
		['/shows/example?review=fallback', '/shows/example?review=fallback'],
		['/%73hows/example', '/shows/example']
	])('allows a safe same-origin path %s', (value, expected) => {
		expect(normalizeSafeReturnPath(value)).toBe(expected);
	});

	it.each([
		'//evil.example/path',
		'/\\evil.example/path',
		'/%2f%2fevil.example/path',
		'/%25252525252525252f%25252525252525252fevil.example/path',
		'/%255c%255cevil.example/path',
		'https://evil.example/path',
		'https://user:password@evil.example/path',
		'/safe\nLocation: https://evil.example'
	])('rejects an unsafe or encoded redirect %s', (value) => {
		expect(normalizeSafeReturnPath(value)).toBe('/');
	});

	it('accepts only same-origin referrers', () => {
		expect(
			getSafeReturnPathFromReferer(
				'http://127.0.0.1:5173/shows/example?review=selected',
				'http://127.0.0.1:5173'
			)
		).toBe('/shows/example?review=selected');
		expect(
			getSafeReturnPathFromReferer(
				'https://user:password@evil.example/path',
				'http://127.0.0.1:5173'
			)
		).toBe('/');
	});
});
