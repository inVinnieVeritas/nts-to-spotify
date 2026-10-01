import { json, type RequestEvent } from '@sveltejs/kit';
import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';
import { ScheduleStore, schedulesEnabled } from '$lib/utils/catalog-schedule-store.server';
import { isScheduleFrequency, type CatalogSchedule } from '$lib/utils/catalog-schedule';
import { loadCloudProgress, CloudProgressError } from '$lib/utils/catalog-cloud.server';
import { isValidNTSSlug } from '$lib/utils/nts';

function authorize(event: RequestEvent) {
	const hosted = hostedConfiguration();
	if (!hosted || !schedulesEnabled()) return json({ error: 'schedules_disabled' }, { status: 404 });
	if (!hasHostedSession(event)) return json({ error: 'not_authorized' }, { status: 401 });
	if (!event.params.show || !isValidNTSSlug(event.params.show))
		return json({ error: 'invalid_show' }, { status: 400 });
	if (
		event.request.method !== 'GET' &&
		(event.request.headers.get('origin') !== hosted.origin ||
			event.request.headers.get('content-type')?.split(';')[0] !== 'application/json')
	)
		return json({ error: 'invalid_origin' }, { status: 403 });
}
export async function GET(event: RequestEvent) {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		const stored = await new ScheduleStore().getSchedule(event.params.show!);
		return json(
			{ schedule: stored?.value ?? null, version: stored?.version ?? null },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json({ error: 'schedules_unavailable' }, { status: 503 });
	}
}
export async function PUT(event: RequestEvent) {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		const text = await event.request.text();
		if (text.length > 4096) return json({ error: 'invalid_request' }, { status: 400 });
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return json({ error: 'invalid_request' }, { status: 400 });
		}
		if (
			!body ||
			typeof body.enabled !== 'boolean' ||
			!isScheduleFrequency(body.frequency) ||
			!(
				body.version === null ||
				(typeof body.version === 'string' && /^\d{4}-\d\d-\d\dT/.test(body.version))
			)
		)
			return json({ error: 'invalid_request' }, { status: 400 });
		const store = new ScheduleStore();
		const current = await store.getSchedule(event.params.show!);
		if ((current?.version ?? null) !== body.version)
			return json({ error: 'schedule_conflict' }, { status: 409 });
		const now = Date.now();
		if (body.enabled) {
			const copy = await loadCloudProgress(event.params.show!);
			if (!copy) return json({ error: 'save_cloud_progress_first' }, { status: 409 });
			const until = copy.progress.retry?.cooldownUntil ?? 0;
			if (until > now) await store.cooldown(Math.ceil((until - now) / 1000), 'rate-limited', now);
		}
		const schedule: CatalogSchedule = {
			showAlias: event.params.show!,
			enabled: body.enabled,
			frequency: body.frequency,
			nextRunAt: now,
			nextCheckAt: now,
			updatedAt: now,
			lastRunAt: current?.value.lastRunAt ?? 0,
			lastStatus: current?.value.lastStatus ?? 'waiting',
			lastScanned: current?.value.lastScanned ?? 0,
			lastSearches: current?.value.lastSearches ?? 0
		};
		await store.putSchedule(schedule, body.version);
		const saved = await store.getSchedule(schedule.showAlias);
		return json(
			{ schedule: saved?.value, version: saved?.version },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (cause) {
		return json(
			{
				error:
					cause instanceof CloudProgressError && cause.kind === 'conflict'
						? 'schedule_conflict'
						: 'schedules_unavailable'
			},
			{ status: cause instanceof CloudProgressError && cause.kind === 'conflict' ? 409 : 503 }
		);
	}
}
