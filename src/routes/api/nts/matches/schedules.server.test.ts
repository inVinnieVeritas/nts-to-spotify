import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mock = vi.hoisted(() => ({
	acquire: vi.fn(),
	release: vi.fn(),
	cooldown: vi.fn(),
	match: vi.fn(),
	token: vi.fn()
}));
vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: async () => 'user-token' }));
vi.mock('$lib/utils/nts.server', () => ({
	getNTSEpisodeTracklist: async () => [{ artist: 'Artist', title: 'Title' }]
}));
vi.mock('$lib/utils/catalog-schedule-store.server', () => ({
	schedulesEnabled: () => true,
	ScheduleStore: class {
		acquire = mock.acquire;
		release = mock.release;
		cooldown = mock.cooldown;
	}
}));
vi.mock('$lib/utils/spotify.server', async () => ({
	...(await vi.importActual<typeof import('$lib/utils/spotify.server')>(
		'$lib/utils/spotify.server'
	)),
	getClientCredentials: mock.token,
	searchSpotifyTrack: mock.match
}));
import { SpotifyRateLimitError } from '$lib/utils/spotify.server';
import { POST } from './+server';
const event = () =>
	({
		request: new Request('https://example.test/api/nts/matches', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ show: 'channeling', episode: 'episode-one' })
		}),
		fetch: vi.fn()
	}) as unknown as RequestEvent;
describe('manual scans share background coordination', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mock.acquire.mockResolvedValue({ lease: { id: 'manual' } });
		mock.release.mockResolvedValue(undefined);
		mock.cooldown.mockResolvedValue(undefined);
		mock.token.mockResolvedValue('application-token');
		mock.match.mockResolvedValue({
			artist: 'Artist',
			title: 'Title',
			matches: [],
			confident: false,
			fallback: false
		});
	});
	it('pauses a manual attempt while a job owns the lease without a Spotify call', async () => {
		mock.acquire.mockResolvedValue({});
		const response = await POST(event() as Parameters<typeof POST>[0]);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ reason: 'background-scan-active' });
		expect(mock.token).not.toHaveBeenCalled();
	});
	it('returns a saved cooldown across processes without a Spotify call', async () => {
		mock.acquire.mockResolvedValue({
			cooldownUntil: Date.now() + 60_000,
			reason: 'quota-exceeded'
		});
		const response = await POST(event() as Parameters<typeof POST>[0]);
		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({ reason: 'quota-exceeded' });
		expect(mock.token).not.toHaveBeenCalled();
	});
	it('releases leases on successful scans and records quota before releasing', async () => {
		expect((await POST(event() as Parameters<typeof POST>[0])).status).toBe(200);
		expect(mock.release).toHaveBeenCalledWith('manual');
		vi.clearAllMocks();
		mock.match.mockRejectedValue(new SpotifyRateLimitError(86400, 'quota-exceeded'));
		expect((await POST(event() as Parameters<typeof POST>[0])).status).toBe(429);
		expect(mock.cooldown).toHaveBeenCalledWith(86400, 'quota-exceeded');
		expect(mock.cooldown.mock.invocationCallOrder[0]).toBeLessThan(
			mock.release.mock.invocationCallOrder[0]
		);
	});
	it('fails closed when the coordinator cannot be reached', async () => {
		mock.acquire.mockRejectedValue(new Error('private firestore details'));
		await expect(POST(event() as Parameters<typeof POST>[0])).rejects.toMatchObject({
			status: 502
		});
		expect(mock.token).not.toHaveBeenCalled();
	});
});
