import { describe, expect, it } from 'vitest';
import { validateSpotifyConfiguration } from './spotify-config.server';

describe('Spotify application configuration', () => {
	it.each([
		[undefined, 'secret'],
		['', 'secret'],
		['   ', 'secret'],
		['client', undefined],
		['client', ''],
		['client', '\t\r\n']
	])('rejects a missing client ID or secret without exposing either value', (clientId, secret) => {
		expect(validateSpotifyConfiguration(clientId, secret)).toBeNull();
	});

	it('accepts a fully configured application', () => {
		expect(validateSpotifyConfiguration('client', 'secret')).toEqual({
			clientId: 'client',
			clientSecret: 'secret'
		});
	});
});
