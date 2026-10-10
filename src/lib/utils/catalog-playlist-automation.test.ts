import { describe, expect, it } from 'vitest';
import {
	automaticPlaylistSaveFeedback,
	AUTOMATIC_PLAYLIST_SAVE_ERRORS
} from './catalog-playlist-automation';

describe('automatic playlist save feedback', () => {
	it('shows targeted instructions without telling every failure to reconnect', () => {
		expect(automaticPlaylistSaveFeedback({ error: 'playlist_sync_required' }).message).toContain(
			'Compare with Spotify'
		);
		expect(automaticPlaylistSaveFeedback({ error: 'playlist_busy' }).message).not.toMatch(
			/reconnect|reauthorize/i
		);
		expect(automaticPlaylistSaveFeedback({ error: 'spotify_authentication' }).message).toContain(
			'Reauthorize background Spotify'
		);
	});
	it('only shows future safe deadlines for the two known waits', () => {
		const now = 1_000_000;
		for (const error of ['playlist_manual_wait', 'spotify_rate_limited']) {
			expect(
				automaticPlaylistSaveFeedback({ error, retryUntil: now + 60_000 }, now).retryUntil
			).toBe(now + 60_000);
			for (const retryUntil of [now, now - 1, -1, 'soon', Infinity, Number.MAX_SAFE_INTEGER + 1])
				expect(automaticPlaylistSaveFeedback({ error, retryUntil }, now).retryUntil).toBe(0);
		}
		expect(
			automaticPlaylistSaveFeedback(
				{ error: 'spotify_authentication', retryUntil: now + 60_000 },
				now
			).retryUntil
		).toBe(0);
	});
	it('never renders unknown errors, tokens or prototype properties', () => {
		for (const value of [
			null,
			'private-token',
			{ error: 'private-token', token: 'secret' },
			{ error: '__proto__' },
			{ error: 'constructor' }
		])
			expect(automaticPlaylistSaveFeedback(value)).toEqual({
				message: AUTOMATIC_PLAYLIST_SAVE_ERRORS.automation_unavailable,
				retryUntil: 0
			});
	});
});
