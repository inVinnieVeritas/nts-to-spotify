import { env } from '$env/dynamic/private';
import { randomUUID } from 'node:crypto';
import {
	accessToken,
	documentBase,
	firestoreRequest,
	CloudProgressError
} from './catalog-cloud.server';
import { isCatalogSchedule, type CatalogSchedule } from './catalog-schedule';
import { isValidNTSSlug } from './nts';
import { isSafeRetryAfterSeconds } from './catalog-scan';
import type { SpotifyRateLimitReason } from './spotify.server';

const FIRESTORE = 'https://firestore.googleapis.com/v1/';
export const schedulesEnabled = () => env.NTS_CATALOG_SCHEDULES === '1';
type Stored<T> = { version: string; value: T };
type Lease = { id: string; kind: 'manual' | 'scheduled' | 'playlist'; until: number };
type Coordination = { leases: Lease[]; cooldownUntil: number; reason: SpotifyRateLimitReason };
const isCoordination = (value: unknown): value is Coordination => {
	if (!value || typeof value !== 'object') return false;
	const c = value as Coordination;
	return (
		Number.isSafeInteger(c.cooldownUntil) &&
		c.cooldownUntil >= 0 &&
		(c.reason === 'rate-limited' || c.reason === 'quota-exceeded') &&
		Array.isArray(c.leases) &&
		c.leases.length <= 4 &&
		c.leases.every(
			(l) =>
				typeof l.id === 'string' &&
				l.id.length <= 100 &&
				['manual', 'scheduled', 'playlist'].includes(l.kind) &&
				Number.isSafeInteger(l.until) &&
				l.until > 0
		)
	);
};

export class ScheduleStore {
	constructor(private request: typeof fetch = fetch) {}
	private path(collection: 'schedules' | 'automation', id: string) {
		if (!isValidNTSSlug(id)) throw new CloudProgressError('invalid');
		return `${documentBase()}/${collection}/${id}`;
	}
	private async read<T>(name: string, validate: (v: unknown) => v is T): Promise<Stored<T> | null> {
		const token = await accessToken(this.request);
		const response = await firestoreRequest(this.request, token, FIRESTORE + name);
		if (response.status === 404) return null;
		if (!response.ok) throw new CloudProgressError('unavailable');
		try {
			const doc = await response.json();
			const value: unknown = JSON.parse(doc.fields?.payload?.stringValue ?? 'null');
			if (!validate(value) || typeof doc.updateTime !== 'string') throw new Error();
			return { value, version: doc.updateTime };
		} catch {
			throw new CloudProgressError('unavailable');
		}
	}
	private async write<T>(name: string, value: T, version: string | null) {
		const token = await accessToken(this.request);
		const response = await firestoreRequest(
			this.request,
			token,
			FIRESTORE + documentBase().split('/documents/')[0] + '/documents:commit',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					writes: [
						{
							update: { name, fields: { payload: { stringValue: JSON.stringify(value) } } },
							currentDocument: version ? { updateTime: version } : { exists: false }
						}
					]
				})
			}
		);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			if ([409, 412].includes(response.status) || body?.error?.status === 'FAILED_PRECONDITION')
				throw new CloudProgressError('conflict');
			throw new CloudProgressError('unavailable');
		}
		const committed = await response.json();
		const nextVersion = committed.writeResults?.[0]?.updateTime;
		if (typeof nextVersion !== 'string') throw new CloudProgressError('unavailable');
		return nextVersion;
	}
	getSchedule(show: string) {
		return this.read(this.path('schedules', show), isCatalogSchedule);
	}
	getAutomation<T>(id: string, validate: (value: unknown) => value is T) {
		return this.read(this.path('automation', id), validate);
	}
	putAutomation<T>(id: string, value: T, version: string | null) {
		return this.write(this.path('automation', id), value, version);
	}
	async putSchedule(schedule: CatalogSchedule, version: string | null) {
		if (!isCatalogSchedule(schedule)) throw new CloudProgressError('invalid');
		await this.write(this.path('schedules', schedule.showAlias), schedule, version);
	}
	async listSchedules(): Promise<CatalogSchedule[]> {
		const token = await accessToken(this.request);
		const schedules: CatalogSchedule[] = [];
		let pageToken: string | undefined;
		do {
			const url = new URL(FIRESTORE + documentBase() + '/schedules');
			url.searchParams.set('pageSize', '100');
			if (pageToken) url.searchParams.set('pageToken', pageToken);
			const response = await firestoreRequest(this.request, token, url.toString());
			if (!response.ok) throw new CloudProgressError('unavailable');
			const body = await response.json();
			for (const doc of body.documents ?? []) {
				const value: unknown = JSON.parse(doc.fields?.payload?.stringValue ?? 'null');
				if (!isCatalogSchedule(value) || this.path('schedules', value.showAlias) !== doc.name)
					throw new CloudProgressError('unavailable');
				schedules.push(value);
			}
			pageToken = body.nextPageToken;
			if (schedules.length > 5000) throw new CloudProgressError('unavailable');
		} while (pageToken);
		return schedules;
	}
	private async changeCoordination(change: (c: Coordination) => Coordination | null) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const name = this.path('automation', 'scan-coordination');
			const stored = await this.read(name, isCoordination);
			const next = change(
				stored?.value ?? { leases: [], cooldownUntil: 0, reason: 'rate-limited' }
			);
			if (!next) return;
			try {
				await this.write(name, next, stored?.version ?? null);
				return;
			} catch (cause) {
				if (!(cause instanceof CloudProgressError) || cause.kind !== 'conflict' || attempt === 3)
					throw cause;
			}
		}
	}
	async acquire(kind: Lease['kind'], now = Date.now()) {
		const lease: Lease = { id: randomUUID(), kind, until: now + 5 * 60_000 };
		let result: { lease?: Lease; cooldownUntil?: number; reason?: SpotifyRateLimitReason } = {};
		await this.changeCoordination((c) => {
			result = {};
			if (c.cooldownUntil > now) {
				result = { cooldownUntil: c.cooldownUntil, reason: c.reason };
				return null;
			}
			const leases = c.leases.filter((l) => l.until > now);
			if (
				leases.some((l) => l.kind !== 'manual') ||
				(kind !== 'manual' && leases.length) ||
				leases.length >= 4
			)
				return null;
			result = { lease };
			return { ...c, leases: [...leases, lease] };
		});
		return result;
	}
	async owns(id: string, now = Date.now()) {
		const stored = await this.read(this.path('automation', 'scan-coordination'), isCoordination);
		return stored?.value.leases.some((l) => l.id === id && l.until > now + 30_000) ?? false;
	}
	async renew(id: string, now = Date.now()) {
		let renewed = false;
		await this.changeCoordination((c) => {
			renewed = false;
			if (!c.leases.some((l) => l.id === id && l.until > now)) return null;
			renewed = true;
			return {
				...c,
				leases: c.leases.map((l) => (l.id === id ? { ...l, until: now + 5 * 60_000 } : l))
			};
		});
		if (!renewed) throw new CloudProgressError('conflict');
	}
	async release(id: string) {
		await this.changeCoordination((c) => ({ ...c, leases: c.leases.filter((l) => l.id !== id) }));
	}
	async cooldown(seconds: number, reason: SpotifyRateLimitReason, now = Date.now()) {
		if (!isSafeRetryAfterSeconds(seconds, now)) throw new CloudProgressError('invalid');
		await this.changeCoordination((c) =>
			now + seconds * 1000 > c.cooldownUntil
				? { ...c, cooldownUntil: now + seconds * 1000, reason }
				: null
		);
	}
}
