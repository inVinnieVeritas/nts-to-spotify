import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({
	NTS_FIRESTORE_PROJECT: 'test-project-123',
	NTS_PLAYLIST_AUTH_KEY: 'a'.repeat(64)
}));
vi.mock('$env/dynamic/private', () => ({ env: settings }));
vi.mock('./hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	})
}));
vi.mock('./auth.server', () => ({ rotateAccessToken: vi.fn() }));
import { rotateAccessToken } from './auth.server';
import { SpotifyTokenAcquisitionError } from './spotify-token.server';
import {
	PlaylistAuthorization,
	encryptPlaylistAuthorization,
	decryptPlaylistAuthorization
} from './playlist-authorization.server';
import { ScheduleStore } from './catalog-schedule-store.server';
import { fakeFirestore } from '../test-helpers/firestore';
afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const f = fakeFirestore();
	const request: typeof fetch = async (input, init) =>
		String(input).endsWith('/me') ? Response.json({ id: 'owner' }) : f.request(input, init);
	const store = new ScheduleStore(request);
	const auth = new PlaylistAuthorization(store, request);
	await auth.connect('dummy-access', 'secret-refresh-fixture');
	return { ...f, store, auth };
}
describe('owner-bound encrypted background authorization', () => {
	it('uses randomized authenticated encryption and separate purposes', () => {
		const a = encryptPlaylistAuthorization('dummy-refresh');
		const b = encryptPlaylistAuthorization('dummy-refresh');
		expect(a).not.toEqual(b);
		expect(a).not.toContain('dummy-refresh');
		expect(decryptPlaylistAuthorization(a)).toBe('dummy-refresh');
		expect(() => decryptPlaylistAuthorization(a, 'nts-browser-push-v1')).toThrow();
		const changed = a.slice(0, -4) + 'AAAA';
		expect(() => decryptPlaylistAuthorization(changed)).toThrow();
	});
	it('rejects missing/invalid encryption keys without echoing the value', () => {
		const previous = settings.NTS_PLAYLIST_AUTH_KEY;
		settings.NTS_PLAYLIST_AUTH_KEY = 'sensitive-invalid';
		expect(() => encryptPlaylistAuthorization('dummy')).toThrow(
			'Background authorization unavailable'
		);
		settings.NTS_PLAYLIST_AUTH_KEY = previous;
	});
	it('stores no plaintext token and does not expose access tokens as public status', async () => {
		const f = await fixture();
		expect(JSON.stringify([...f.documents.values()])).not.toContain('secret-refresh-fixture');
		expect(await f.auth.connected()).toBe(true);
		vi.mocked(rotateAccessToken).mockResolvedValueOnce({
			accessToken: 'next-access',
			expiresIn: 3600,
			tokenType: 'Bearer'
		});
		const token = await f.auth.token();
		expect(token.accessToken).toBe('next-access');
		expect(JSON.stringify([...f.documents.values()])).not.toContain('next-access');
	});
	it('keeps the previous refresh token when Spotify omits rotation and stores a rotated token encrypted', async () => {
		const f = await fixture();
		vi.mocked(rotateAccessToken).mockResolvedValueOnce({
			accessToken: 'next',
			expiresIn: 3600,
			tokenType: 'Bearer',
			refreshToken: 'rotated-fixture'
		});
		await f.auth.token();
		vi.mocked(rotateAccessToken).mockResolvedValueOnce({
			accessToken: 'next',
			expiresIn: 3600,
			tokenType: 'Bearer'
		});
		await f.auth.token();
		expect(vi.mocked(rotateAccessToken).mock.calls.at(-1)?.[0]).toBe('rotated-fixture');
		expect(JSON.stringify([...f.documents.values()])).not.toContain('rotated-fixture');
	});
	it('revoked/expired authorization disconnects and cannot be retried indefinitely', async () => {
		const f = await fixture();
		vi.mocked(rotateAccessToken).mockRejectedValueOnce(
			new SpotifyTokenAcquisitionError('authentication')
		);
		await expect(f.auth.token()).rejects.toThrow('Background Spotify authorization required');
		expect(await f.auth.connected()).toBe(false);
		await expect(f.auth.token()).rejects.toThrow();
	});
	it('disconnect fences an already acquired token generation', async () => {
		const f = await fixture();
		vi.mocked(rotateAccessToken).mockResolvedValueOnce({
			accessToken: 'next',
			expiresIn: 3600,
			tokenType: 'Bearer'
		});
		const token = await f.auth.token();
		await f.auth.disconnect();
		await expect(f.auth.assertGeneration(token.generation)).rejects.toThrow();
		expect(JSON.stringify([...f.documents.values()])).not.toContain('ciphertext');
	});
	it('an in-flight refresh cannot resurrect a disconnected authorization', async () => {
		const f = await fixture();
		vi.mocked(rotateAccessToken).mockImplementationOnce(async () => {
			await f.auth.disconnect();
			return {
				accessToken: 'old-access',
				expiresIn: 3600,
				tokenType: 'Bearer',
				refreshToken: 'old-rotation'
			};
		});
		await expect(f.auth.token()).rejects.toThrow();
		expect(await f.auth.connected()).toBe(false);
	});
});
