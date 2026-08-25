import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn() }));
vi.mock('$lib/utils/spotify-profile.server', () => ({ getSpotifyProfile: vi.fn() }));

import { getAccessToken } from '$lib/utils/auth.server';
import { getSpotifyProfile } from '$lib/utils/spotify-profile.server';
import { load } from './+layout.server';

describe('layout authentication failure handling', () => {
	it('turns refresh-token acquisition failures into a signed-out layout without leaking details', async () => {
		vi.mocked(getAccessToken).mockRejectedValue({
			name: 'SpotifyTokenAcquisitionError',
			reason: 'network',
			refresh_token: 'must-not-be-exposed'
		});
		const result = await load({
			fetch: vi.fn(),
			request: new Request('https://app.example/'),
			url: new URL('https://app.example/')
		} as never);

		expect(result).toMatchObject({ user: null });
		expect(JSON.stringify(result)).not.toContain('must-not-be-exposed');
		expect(getSpotifyProfile).not.toHaveBeenCalled();
	});

	it('preserves the distinct fixed missing-configuration path', async () => {
		const configurationFailure = {
			status: 503,
			body: { message: 'Spotify application is not configured' }
		};
		vi.mocked(getAccessToken).mockRejectedValue(configurationFailure);
		await expect(
			load({
				fetch: vi.fn(),
				request: new Request('https://app.example/'),
				url: new URL('https://app.example/')
			} as never)
		).rejects.toBe(configurationFailure);
	});
});
