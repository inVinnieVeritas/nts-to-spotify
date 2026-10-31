import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const access = vi.hoisted(() => ({ authenticated: true }));
vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	}),
	hasHostedSession: () => access.authenticated
}));
vi.mock('$env/dynamic/private', () => ({ env: { NTS_CATALOG_SCHEDULES: '1' } }));

import {
	AutomaticPlaylistService,
	AutomaticPlaylistConfigurationError
} from '$lib/utils/catalog-playlist-automation.server';
import { BackgroundAuthorizationError } from '$lib/utils/playlist-authorization.server';
import { CloudProgressError } from '$lib/utils/catalog-cloud.server';
import { PUT } from './+server';

const event = (
	body: unknown = { enabled: true, confirmAppCreated: true },
	origin = 'https://nts2spotify.vincentvanderveken.com'
) =>
	({
		params: { show: 'dimension-door' },
		request: new Request(
			'https://nts2spotify.vincentvanderveken.com/api/catalog-playlist-automation/dimension-door',
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', Origin: origin },
				body: JSON.stringify(body)
			}
		)
	}) as RequestEvent;

beforeEach(() => {
	access.authenticated = true;
	vi.spyOn(AutomaticPlaylistService.prototype, 'configure').mockResolvedValue(undefined);
	vi.spyOn(AutomaticPlaylistService.prototype, 'get').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('automatic playlist configuration errors', () => {
	it.each([
		['playlist_busy', 409, 0],
		['playlist_manual_wait', 409, 2_000_000],
		['spotify_rate_limited', 429, 3_000_000],
		['playlist_sync_required', 409, 0],
		['playlist_sync_uncertain', 409, 0],
		['playlist_not_owned', 403, 0]
	] as const)(
		'returns the specific %s blocker and only its safe deadline',
		async (code, status, retryUntil) => {
			vi.mocked(AutomaticPlaylistService.prototype.configure).mockRejectedValueOnce(
				new AutomaticPlaylistConfigurationError(code, status, retryUntil)
			);
			const response = await PUT(event());
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: code, ...(retryUntil ? { retryUntil } : {}) });
		}
	);
	it.each([
		[new BackgroundAuthorizationError(), 401, 'spotify_authentication'],
		[new CloudProgressError('conflict'), 409, 'cloud_progress_conflict'],
		[new CloudProgressError('unavailable'), 503, 'cloud_progress_unavailable'],
		[new Error('private-refresh-token'), 503, 'automation_unavailable']
	])('sanitizes authorization, cloud and unknown failures', async (cause, status, error) => {
		vi.mocked(AutomaticPlaylistService.prototype.configure).mockRejectedValueOnce(cause);
		const response = await PUT(event());
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});
	it('still rejects expired sessions and cross-origin writes before configuration', async () => {
		access.authenticated = false;
		expect((await PUT(event())).status).toBe(401);
		access.authenticated = true;
		expect((await PUT(event(undefined, 'https://evil.test'))).status).toBe(403);
		expect(AutomaticPlaylistService.prototype.configure).not.toHaveBeenCalled();
	});
	it('returns invalid-request feedback for malformed JSON and null bodies', async () => {
		const malformed = event();
		malformed.request = new Request(malformed.request.url, {
			method: 'PUT',
			headers: malformed.request.headers,
			body: '{'
		});
		for (const input of [malformed, event(null)]) {
			const response = await PUT(input);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'invalid_request' });
		}
		expect(AutomaticPlaylistService.prototype.configure).not.toHaveBeenCalled();
	});
	it('keeps the existing explicit enable/confirmation and pause contract', async () => {
		expect((await PUT(event())).status).toBe(200);
		expect(AutomaticPlaylistService.prototype.configure).toHaveBeenCalledWith(
			'dimension-door',
			true,
			true,
			expect.any(AbortSignal)
		);
		expect((await PUT(event({ enabled: false, confirmAppCreated: false }))).status).toBe(200);
		expect(AutomaticPlaylistService.prototype.configure).toHaveBeenLastCalledWith(
			'dimension-door',
			false,
			false,
			expect.any(AbortSignal)
		);
	});
});
