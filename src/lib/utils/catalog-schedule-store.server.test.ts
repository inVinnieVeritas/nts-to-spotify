import { describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: { NTS_FIRESTORE_PROJECT: 'test-project-123', NTS_CATALOG_SCHEDULES: '1' }
}));
vi.mock('./hosted-access.server', () => ({ hostedConfiguration: () => ({ userId: 'owner' }) }));
import { ScheduleStore } from './catalog-schedule-store.server';
import { CloudProgressError } from './catalog-cloud.server';
import { fakeFirestore } from '../test-helpers/firestore';
import type { CatalogSchedule } from './catalog-schedule';

describe('durable scan coordination', () => {
	it('fails closed when a conflicting renewal loses ownership before its CAS retry', async () => {
		const fixture = fakeFirestore();
		const first = new ScheduleStore(fixture.request);
		const claim = await first.acquire('playlist');
		let conflict = true;
		const request: typeof fetch = async (input, init) => {
			if (String(input).endsWith('/documents:commit') && conflict) {
				conflict = false;
				const doc = fixture.documents.values().next().value!;
				const coordination = JSON.parse(doc.fields.payload.stringValue);
				coordination.leases = [];
				doc.fields.payload.stringValue = JSON.stringify(coordination);
				doc.updateTime = new Date(Date.now() + 1000).toISOString();
				return new Response(null, { status: 409 });
			}
			return fixture.request(input, init);
		};
		await expect(new ScheduleStore(request).renew(claim.lease!.id)).rejects.toMatchObject({
			kind: 'conflict'
		});
		expect(await first.owns(claim.lease!.id)).toBe(false);
	});
	it('playlist writes are exclusive with manual/background scans and renewals fence expired owners', async () => {
		const store = new ScheduleStore(fakeFirestore().request);
		const now = Date.now();
		const claim = await store.acquire('playlist', now);
		expect(claim.lease).toBeDefined();
		expect(await store.acquire('manual', now)).toEqual({});
		expect(await store.acquire('scheduled', now)).toEqual({});
		await store.renew(claim.lease!.id, now + 60_000);
		expect(await store.owns(claim.lease!.id, now + 5 * 60_000)).toBe(true);
		await store.release(claim.lease!.id);
		await expect(store.renew(claim.lease!.id, now + 60_000)).rejects.toThrow();
	});
	it('admits exactly one concurrent job and excludes manual scans until release', async () => {
		const { request } = fakeFirestore();
		const store = new ScheduleStore(request);
		const now = Date.now();
		const claims = await Promise.all([
			store.acquire('scheduled', now),
			store.acquire('scheduled', now)
		]);
		expect(claims.filter((c) => c.lease)).toHaveLength(1);
		expect(await store.acquire('manual', now)).toEqual({});
		await store.release(claims.find((c) => c.lease)!.lease!.id);
		expect((await store.acquire('manual', now)).lease).toBeDefined();
	});
	it('allows the existing parallel manual workers, but excludes a job', async () => {
		const store = new ScheduleStore(fakeFirestore().request);
		const a = await store.acquire('manual');
		const b = await store.acquire('manual');
		expect(a.lease).toBeDefined();
		expect(b.lease).toBeDefined();
		expect(await store.acquire('scheduled')).toEqual({});
		await store.release(a.lease!.id);
		expect(await store.owns(b.lease!.id)).toBe(true);
	});
	it('recovers crashed leases and fences the expired owner', async () => {
		const store = new ScheduleStore(fakeFirestore().request);
		const now = Date.now();
		const old = await store.acquire('scheduled', now);
		const next = await store.acquire('scheduled', now + 5 * 60_000 + 1);
		expect(next.lease).toBeDefined();
		expect(await store.owns(old.lease!.id, now + 5 * 60_000 + 1)).toBe(false);
		await store.release(old.lease!.id);
		expect(await store.owns(next.lease!.id, now + 5 * 60_000 + 1)).toBe(true);
	});
	it('shares the longest cooldown across fresh instances and never shortens it', async () => {
		const { request } = fakeFirestore();
		const first = new ScheduleStore(request);
		const now = Date.now();
		await first.cooldown(86400, 'quota-exceeded', now);
		await first.cooldown(5, 'rate-limited', now);
		expect(await new ScheduleStore(request).acquire('manual', now)).toEqual({
			cooldownUntil: now + 86400_000,
			reason: 'quota-exceeded'
		});
		expect((await first.acquire('scheduled', now + 86400_000)).lease).toBeDefined();
	});
	it('fails closed if Firestore is unavailable or malformed', async () => {
		const unavailable: typeof fetch = async () => {
			throw new Error('private details');
		};
		await expect(new ScheduleStore(unavailable).acquire('scheduled')).rejects.toMatchObject({
			kind: 'unavailable'
		});
		const fixture = fakeFirestore();
		const store = new ScheduleStore(fixture.request);
		await store.acquire('manual');
		fixture.documents.values().next().value!.fields.payload.stringValue = '{"leases":null}';
		await expect(store.acquire('scheduled')).rejects.toMatchObject({ kind: 'unavailable' });
	});
	it('uses account-scoped documents and rejects stale schedule settings', async () => {
		const fixture = fakeFirestore();
		const store = new ScheduleStore(fixture.request);
		const now = Date.now();
		const schedule: CatalogSchedule = {
			showAlias: 'channeling',
			enabled: true,
			frequency: 'weekly',
			nextRunAt: now,
			nextCheckAt: now,
			updatedAt: now,
			lastRunAt: 0,
			lastStatus: 'waiting',
			lastScanned: 0,
			lastSearches: 0
		};
		await store.putSchedule(schedule, null);
		const stored = await store.getSchedule('channeling');
		await store.putSchedule({ ...schedule, enabled: false }, stored!.version);
		await expect(store.putSchedule(schedule, stored!.version)).rejects.toBeInstanceOf(
			CloudProgressError
		);
		expect(await store.listSchedules()).toEqual([{ ...schedule, enabled: false }]);
		expect([...fixture.documents.keys()].every((k) => k.includes('/ntsUsers/owner/'))).toBe(true);
	});
});
