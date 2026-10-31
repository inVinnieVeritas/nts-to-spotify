import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/nts-artwork.server', () => ({ getCachedNTSShowArtwork: vi.fn() }));
import { getCachedNTSShowArtwork } from '$lib/utils/nts-artwork.server';
import { GET } from './+server';

beforeEach(() => vi.resetAllMocks());

describe('catalogue artwork image endpoint', () => {
	it('redirects an image request to the validated artwork without serializing catalogue data', async () => {
		const cover = 'https://media3.ntslive.co.uk/resize/800x800/show.jpeg';
		vi.mocked(getCachedNTSShowArtwork).mockResolvedValueOnce(cover);
		const response = await GET({ params: { show: 'dimension-door' } } as never);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe(cover);
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=21600');
		expect(await response.text()).toBe('');
	});

	it('rejects invalid aliases before lookup and returns a missing image when NTS has none', async () => {
		const invalid = await GET({ params: { show: '../private' } } as never);
		expect(invalid.status).toBe(400);
		expect(getCachedNTSShowArtwork).not.toHaveBeenCalled();
		const missing = await GET({ params: { show: 'dimension-door' } } as never);
		expect(missing.status).toBe(404);
	});
});
