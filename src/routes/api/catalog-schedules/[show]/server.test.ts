import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mock = vi.hoisted(() => ({
	feature: true,
	authenticated: true,
	hosted: true,
	getSchedule: vi.fn(),
	putSchedule: vi.fn(),
	cooldown: vi.fn(),
	load: vi.fn()
}));
vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: () => (mock.hosted ? { origin: 'https://example.test' } : null),
	hasHostedSession: () => mock.authenticated
}));
vi.mock('$lib/utils/catalog-schedule-store.server', () => ({
	schedulesEnabled: () => mock.feature,
	ScheduleStore: class {
		getSchedule = mock.getSchedule;
		putSchedule = mock.putSchedule;
		cooldown = mock.cooldown;
	}
}));
vi.mock('$lib/utils/catalog-cloud.server', async () => ({
	...(await vi.importActual<typeof import('$lib/utils/catalog-cloud.server')>(
		'$lib/utils/catalog-cloud.server'
	)),
	loadCloudProgress: mock.load
}));
import { GET, PUT } from './+server';

function event(body?: unknown, origin = 'https://example.test'): RequestEvent {
	return {
		params: { show: 'channeling' },
		request: new Request(
			'https://example.test/api/catalog-schedules/channeling',
			body === undefined
				? {}
				: {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json', Origin: origin },
						body: JSON.stringify(body)
					}
		)
	} as RequestEvent;
}
describe('schedule API authorization and consent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mock.feature = true;
		mock.hosted = true;
		mock.authenticated = true;
		mock.getSchedule.mockResolvedValue(null);
		mock.putSchedule.mockResolvedValue(undefined);
		mock.load.mockResolvedValue({ progress: { retry: { cooldownUntil: 0 } } });
	});
	it('is unavailable unless explicitly configured on the hosted site', async () => {
		mock.feature = false;
		expect((await GET(event())).status).toBe(404);
		mock.feature = true;
		mock.hosted = false;
		expect((await PUT(event({ enabled: true, frequency: 'weekly', version: null }))).status).toBe(
			404
		);
		expect(mock.putSchedule).not.toHaveBeenCalled();
	});
	it('requires the signed permitted-account session for reads and writes', async () => {
		mock.authenticated = false;
		expect((await GET(event())).status).toBe(401);
		expect((await PUT(event({ enabled: true, frequency: 'weekly', version: null }))).status).toBe(
			401
		);
		expect(mock.getSchedule).not.toHaveBeenCalled();
	});
	it('rejects cross-origin writes and unbounded or invalid schedule input', async () => {
		expect(
			(await PUT(event({ enabled: true, frequency: 'weekly', version: null }, 'https://evil.test')))
				.status
		).toBe(403);
		for (const body of [
			{ enabled: true, frequency: 'hourly', version: null },
			{ enabled: 'true', frequency: 'weekly', version: null },
			{ enabled: true, frequency: 'weekly', version: 'bad' },
			{ enabled: true, frequency: 'weekly', version: null, extra: 'x'.repeat(5000) }
		])
			expect((await PUT(event(body))).status).toBe(400);
		expect(mock.putSchedule).not.toHaveBeenCalled();
	});
	it('requires existing cloud progress before enabling scans', async () => {
		mock.load.mockResolvedValue(null);
		const response = await PUT(event({ enabled: true, frequency: 'weekly', version: null }));
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'save_cloud_progress_first' });
		expect(mock.putSchedule).not.toHaveBeenCalled();
	});
	it('carries an existing cooldown into shared coordination on enable', async () => {
		mock.load.mockResolvedValue({ progress: { retry: { cooldownUntil: Date.now() + 86400_000 } } });
		expect(
			(await PUT(event({ enabled: true, frequency: 'fortnightly', version: null }))).status
		).toBe(200);
		expect(mock.cooldown).toHaveBeenCalled();
		expect(mock.putSchedule.mock.calls[0][0]).toMatchObject({
			showAlias: 'channeling',
			enabled: true,
			frequency: 'fortnightly'
		});
	});
	it('allows pausing without loading progress and rejects stale settings', async () => {
		expect((await PUT(event({ enabled: false, frequency: 'weekly', version: null }))).status).toBe(
			200
		);
		expect(mock.load).not.toHaveBeenCalled();
		mock.getSchedule.mockResolvedValue({ version: '2026-10-01T12:00:00Z', value: {} });
		expect((await PUT(event({ enabled: true, frequency: 'weekly', version: null }))).status).toBe(
			409
		);
	});
	it('returns no-store settings and sanitized service failures', async () => {
		const result = await GET(event());
		expect(result.headers.get('cache-control')).toBe('no-store');
		expect(await result.json()).toEqual({ schedule: null, version: null });
		mock.getSchedule.mockRejectedValue(new Error('private credentials'));
		expect(await (await GET(event())).json()).toEqual({ error: 'schedules_unavailable' });
	});
});
