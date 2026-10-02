import type { MatchedTrack, NTSShowCatalog } from '$lib/types';
import type { CatalogProgress } from './catalog-scan';
import { reconcileSavedCatalogWithNTS } from './catalog-update';
import { SCHEDULE_INTERVALS, type ScheduleStatus } from './catalog-schedule';
import { CloudProgressError } from './catalog-cloud.server';
import { getSpotifyRateLimitReason, isSpotifyRateLimitError } from './spotify.server';
import type { ScheduleStore } from './catalog-schedule-store.server';

type Copy = { progress: CatalogProgress; version: string };
export type ScheduleWorkerDependencies = {
	store: Pick<
		ScheduleStore,
		'listSchedules' | 'getSchedule' | 'putSchedule' | 'acquire' | 'owns' | 'release' | 'cooldown'
	>;
	load: (show: string) => Promise<Copy | null>;
	save: (show: string, progress: CatalogProgress, version: string) => Promise<string>;
	catalog: (show: string, signal: AbortSignal) => Promise<NTSShowCatalog>;
	match: (show: string, episode: string, signal: AbortSignal) => Promise<MatchedTrack[]>;
	searchCount: () => number;
	now: () => number;
	signal: AbortSignal;
	afterBatch?: (show: string, signal: AbortSignal) => Promise<number | undefined>;
	notify?: (
		kind: 'new-episodes' | 'matches-ready',
		show: string,
		episodes: string[]
	) => Promise<void>;
};
export const SCHEDULE_EPISODE_LIMIT = 5;
const CONTINUE_AFTER_MS = 60 * 60_000;

// One bounded catalogue batch per invocation. Every episode is saved before the next starts.
// Playlist automation is a separate opt-in boundary, invoked only after matching releases its lease.
export async function runScheduledScan(deps: ScheduleWorkerDependencies) {
	const { store, now, signal } = deps;
	const initial = (await store.listSchedules())
		.filter((s) => s.enabled && s.nextRunAt <= now())
		.sort((a, b) => a.nextRunAt - b.nextRunAt || a.lastRunAt - b.lastRunAt)[0];
	if (!initial || signal.aborted) return { status: 'idle' as const, scanned: 0 };
	const record = await store.getSchedule(initial.showAlias);
	if (!record?.value.enabled || record.value.nextRunAt > now())
		return { status: 'idle' as const, scanned: 0 };
	const schedule = { ...record.value };
	let status: ScheduleStatus = 'waiting';
	let scanned = 0;
	let nextRunAt = now() + CONTINUE_AFTER_MS;
	const searchesBefore = deps.searchCount();
	let acquired: string | undefined;
	try {
		// Hold the shared lock during discovery and each episode. Reacquire between episodes
		// so manual scans can take over; the five-minute lease survives crashes without deadlock.
		for (let index = 0; index < SCHEDULE_EPISODE_LIMIT && !signal.aborted; index++) {
			const currentSchedule = await store.getSchedule(schedule.showAlias);
			if (!currentSchedule?.value.enabled || currentSchedule.version !== record.version) {
				status = 'conflict';
				break;
			}
			const claim = await store.acquire('scheduled', now());
			if (!claim.lease) {
				status = claim.cooldownUntil ? 'cooldown' : 'busy';
				nextRunAt = Math.max(nextRunAt, claim.cooldownUntil ?? 0);
				break;
			}
			acquired = claim.lease.id;
			const scope = AbortSignal.any([signal, AbortSignal.timeout(3 * 60_000)]);
			try {
				let copy = await deps.load(schedule.showAlias);
				if (!copy) {
					status = 'missing-progress';
					break;
				}
				if ((copy.progress.retry?.cooldownUntil ?? 0) > now()) {
					nextRunAt = copy.progress.retry!.cooldownUntil;
					await store.cooldown(Math.ceil((nextRunAt - now()) / 1000), 'rate-limited', now());
					status = 'cooldown';
					break;
				}
				if (index === 0 && schedule.nextCheckAt <= now()) {
					const catalog = await deps.catalog(schedule.showAlias, scope);
					// Reload after the NTS request so a browser edit during discovery is retained.
					copy = await deps.load(schedule.showAlias);
					if (!copy) {
						status = 'missing-progress';
						break;
					}
					const latestEpisodesBeforeDiscovery = copy.progress.episodes;
					const reconciled = reconcileSavedCatalogWithNTS(copy.progress, catalog, now());
					if (reconciled.addedCount) {
						if (scope.aborted || !(await store.owns(acquired, now())))
							throw new CloudProgressError('conflict');
						copy.version = await deps.save(schedule.showAlias, reconciled.progress, copy.version);
						copy.progress = reconciled.progress;
						await deps.notify?.(
							'new-episodes',
							schedule.showAlias,
							Object.keys(copy.progress.episodes).filter(
								(alias) => !Object.hasOwn(latestEpisodesBeforeDiscovery, alias)
							)
						);
					}
					schedule.nextCheckAt = now() + SCHEDULE_INTERVALS[schedule.frequency];
				}
				const episode = Object.values(copy.progress.episodes)
					.filter((e) => e.status !== 'done')
					.sort(
						(a, b) =>
							Date.parse(a.broadcast) - Date.parse(b.broadcast) ||
							a.episodeAlias.localeCompare(b.episodeAlias)
					)[0];
				if (!episode) {
					status = 'complete';
					nextRunAt = schedule.nextCheckAt;
					break;
				}
				const beforeMatch = await store.getSchedule(schedule.showAlias);
				if (!beforeMatch?.value.enabled || beforeMatch.version !== record.version)
					throw new CloudProgressError('conflict');
				const tracks = await deps.match(schedule.showAlias, episode.episodeAlias, scope);
				if (scope.aborted || !(await store.owns(acquired, now())))
					throw new CloudProgressError('conflict');
				const stillEnabled = await store.getSchedule(schedule.showAlias);
				if (!stillEnabled?.value.enabled || stillEnabled.version !== record.version)
					throw new CloudProgressError('conflict');
				const latest = await deps.load(schedule.showAlias);
				if (
					!latest ||
					JSON.stringify(latest.progress.episodes[episode.episodeAlias]) !== JSON.stringify(episode)
				)
					throw new CloudProgressError('conflict');
				// Preserve every other episode's review, playlist settings/link, and newly added episodes.
				latest.progress.episodes[episode.episodeAlias] = {
					...episode,
					status: 'done',
					error: undefined,
					tracks: tracks.map((track) => ({
						...track,
						selectedMatch: track.matches[0]?.uri || null,
						checked: track.confident
					}))
				};
				latest.progress.updatedAt = now();
				if ((latest.progress.retry?.cooldownUntil ?? 0) <= now())
					latest.progress.retry = { cooldownUntil: 0, pausedByRateLimit: false };
				await deps.save(schedule.showAlias, latest.progress, latest.version);
				scanned++;
				await deps.notify?.('matches-ready', schedule.showAlias, [episode.episodeAlias]);
				if (Object.values(latest.progress.episodes).every((e) => e.status === 'done')) {
					status = 'complete';
					nextRunAt = schedule.nextCheckAt;
					break;
				}
			} catch (cause) {
				// Publish a cooldown before releasing the lock to another browser/job.
				if (isSpotifyRateLimitError(cause))
					await store.cooldown(cause.retryAfterSeconds, getSpotifyRateLimitReason(cause), now());
				throw cause;
			} finally {
				await store.release(acquired);
				acquired = undefined;
			}
		}
	} catch (cause) {
		if (isSpotifyRateLimitError(cause)) {
			nextRunAt = now() + cause.retryAfterSeconds * 1000;
			await store.cooldown(cause.retryAfterSeconds, getSpotifyRateLimitReason(cause), now());
			status = 'cooldown';
			// Carry the observed cooldown into portable cloud progress for every browser.
			const latest = await deps.load(schedule.showAlias);
			if (latest) {
				latest.progress.retry = {
					cooldownUntil: Math.max(nextRunAt, latest.progress.retry?.cooldownUntil ?? 0),
					pausedByRateLimit: true
				};
				latest.progress.updatedAt = now();
				try {
					await deps.save(schedule.showAlias, latest.progress, latest.version);
				} catch (saveError) {
					if (!(saveError instanceof CloudProgressError) || saveError.kind !== 'conflict')
						throw saveError;
				}
			}
		} else
			status =
				cause instanceof CloudProgressError && cause.kind === 'conflict'
					? 'conflict'
					: 'unavailable';
	} finally {
		if (acquired) await store.release(acquired);
	}
	if (deps.afterBatch && ['complete', 'waiting'].includes(status) && !signal.aborted) {
		const retryAt = await deps.afterBatch(schedule.showAlias, signal);
		if (retryAt !== undefined)
			nextRunAt = Math.min(nextRunAt, Math.max(now() + CONTINUE_AFTER_MS, retryAt));
	}
	// A disable or frequency change made while this job ran wins over its status write.
	try {
		await store.putSchedule(
			{
				...schedule,
				nextRunAt,
				lastRunAt: now(),
				lastStatus: status,
				lastScanned: scanned,
				lastSearches: Math.max(0, deps.searchCount() - searchesBefore)
			},
			record.version
		);
	} catch (cause) {
		if (!(cause instanceof CloudProgressError) || cause.kind !== 'conflict') throw cause;
	}
	return { status, scanned };
}
