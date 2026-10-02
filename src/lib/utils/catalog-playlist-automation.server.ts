import { randomUUID, createHash } from 'node:crypto';
import { json, type RequestEvent } from '@sveltejs/kit';
import { hostedConfiguration, hasHostedSession } from './hosted-access.server';
import { ScheduleStore, schedulesEnabled } from './catalog-schedule-store.server';
import {
	CloudProgressError,
	loadCloudProgress,
	loadCloudProgressVersion
} from './catalog-cloud.server';
import {
	PlaylistAuthorization,
	BackgroundAuthorizationError
} from './playlist-authorization.server';
import {
	automaticPlaylistTarget,
	automaticReviewCount,
	isAutomaticPlaylistPublicState,
	type AutomaticPlaylistPublicState
} from './catalog-playlist-automation';
import { fingerprintSpotifyPlaylist } from './playlist-preview.server';
import {
	fingerprintPlaylistSyncTarget,
	isCatalogPlaylistSyncRecord,
	runPlaylistSyncBatches,
	CATALOG_PLAYLIST_SYNC_VERSION,
	type CatalogPlaylistSyncRecord,
	type PlaylistSyncTarget
} from './playlist-sync.client';
import { _handlePlaylistRequest, _parseRequest } from '../../routes/api/spotify/playlist/+server';
import { isSpotifyPlaylistId, isSafeRetryAfterSeconds } from './catalog-scan';
import { isValidNTSSlug } from './nts';

type Registry = {
	appCreated: true;
	baseline?: string;
	manualUntil: number;
	uncertain: boolean;
	target?: PlaylistSyncTarget;
	automaticShow?: string;
};
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is number =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRegistry = (v: unknown): v is Registry => {
	if (!v || typeof v !== 'object') return false;
	const r = v as Registry;
	return (
		r.appCreated === true &&
		(r.baseline === undefined || hash(r.baseline)) &&
		timestamp(r.manualUntil) &&
		typeof r.uncertain === 'boolean' &&
		(r.automaticShow === undefined || isValidNTSSlug(r.automaticShow)) &&
		(r.target === undefined || isTarget(r.target))
	);
};
const isTarget = (target: PlaylistSyncTarget) =>
	target &&
	typeof target.name === 'string' &&
	target.name.length > 0 &&
	target.name.length <= 100 &&
	typeof target.description === 'string' &&
	target.description.length <= 300 &&
	typeof target.public === 'boolean' &&
	Array.isArray(target.tracks) &&
	target.tracks.length <= 10000 &&
	target.tracks.every((t) => /^spotify:track:[A-Za-z0-9]{22}$/.test(t));
export type AutomaticPlaylistRecord = AutomaticPlaylistPublicState & {
	baseline: string;
	targetHash: string;
	pendingAdded?: number;
	sync?: CatalogPlaylistSyncRecord;
	target?: PlaylistSyncTarget;
};
export const isAutomaticPlaylistRecord = (v: unknown): v is AutomaticPlaylistRecord => {
	if (!isAutomaticPlaylistPublicState(v)) return false;
	const r = v as AutomaticPlaylistRecord;
	return (
		hash(r.baseline) &&
		hash(r.targetHash) &&
		(r.pendingAdded === undefined ||
			(Number.isSafeInteger(r.pendingAdded) && r.pendingAdded >= 0 && r.pendingAdded <= 10000)) &&
		(!r.sync || isCatalogPlaylistSyncRecord(r.sync)) &&
		(!r.target || isTarget(r.target)) &&
		Boolean(r.sync) === Boolean(r.target) &&
		(!r.sync ||
			(r.sync.playlistId === r.playlistId && r.sync.totalTrackCount === r.target!.tracks.length))
	);
};
export const publicAutomaticPlaylistState = (
	r: AutomaticPlaylistRecord
): AutomaticPlaylistPublicState => ({
	enabled: r.enabled,
	playlistId: r.playlistId,
	status: r.status,
	lastUpdatedAt: r.lastUpdatedAt,
	added: r.added,
	awaitingReview: r.awaitingReview,
	retryUntil: r.retryUntil
});
const id = (show: string) => `playlist-${show}`;
const registryId = (playlist: string) =>
	`owned-${createHash('sha256').update(playlist).digest('hex')}`;

export class AutomaticPlaylistService {
	constructor(
		readonly store = new ScheduleStore(),
		readonly request: typeof fetch = fetch,
		readonly auth = new PlaylistAuthorization(store, request),
		readonly now = Date.now,
		readonly load = (show: string) => loadCloudProgress(show, request),
		readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>,
		readonly versionOf = (show: string) => loadCloudProgressVersion(show, request)
	) {}
	get(show: string) {
		return this.store.getAutomation(id(show), isAutomaticPlaylistRecord);
	}
	async execute(
		body: unknown,
		token: string,
		signal: AbortSignal,
		beforeMutation?: () => Promise<void>
	) {
		const response = await _handlePlaylistRequest(
			{
				request: new Request('https://nts2spotify.vincentvanderveken.com/api/spotify/playlist', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					signal
				}),
				fetch: this.request
			} as Parameters<typeof _handlePlaylistRequest>[0],
			signal,
			{ token, owner: hostedConfiguration()!.userId },
			beforeMutation
		);
		const value = await response.json();
		if (response.status === 429 && isSafeRetryAfterSeconds(value.retryAfterSeconds, this.now()))
			await this.store.cooldown(value.retryAfterSeconds, 'rate-limited', this.now());
		return { response, body: value as Record<string, unknown> };
	}
	async configure(show: string, enabled: boolean, confirmLegacy: boolean, signal: AbortSignal) {
		const old = await this.get(show);
		if (!enabled) {
			if (old) {
				const next = { ...old.value, enabled: false, status: 'off' as const };
				// Acknowledged/pre-dispatch work can be abandoned explicitly in favour
				// of a fresh manual preview. Never discard an uncertain dispatch.
				if (
					next.sync &&
					!['dispatching', 'uncertain'].includes(next.sync.phase) &&
					next.sync.reason !== 'uncertain'
				) {
					delete next.sync;
					delete next.target;
					delete next.pendingAdded;
				}
				await this.store.putAutomation(id(show), next, old.version);
			}
			return;
		}
		const claim = await this.store.acquire('playlist', this.now());
		if (!claim.lease) throw new Error('Playlist automation busy');
		try {
			if (old?.value.sync && old.value.sync.phase !== 'completed')
				throw new Error('Playlist operation requires review');
			const copy = await this.load(show);
			const playlistId = copy?.progress.playlist.linkedPlaylistId;
			if (!copy || !isSpotifyPlaylistId(playlistId) || copy.progress.playlist.creationPending)
				throw new Error('Linked playlist required');
			const registry = await this.store.getAutomation(registryId(playlistId), isRegistry);
			if (registry?.value.automaticShow && registry.value.automaticShow !== show) {
				const other = await this.get(registry.value.automaticShow);
				if (other?.value.enabled || other?.value.sync)
					throw new Error('Playlist already managed by another catalogue');
			}
			if (registry?.value.uncertain || (registry?.value.manualUntil ?? 0) > this.now())
				throw new Error('Playlist operation requires review');
			if (!registry && !confirmLegacy) throw new Error('App-created confirmation required');
			const authorization = await this.auth.token(signal);
			const target = automaticPlaylistTarget(copy.progress);
			const preview = await this.execute(
				{ operation: 'preview', playlistId, ...target },
				authorization.accessToken,
				signal
			);
			if (
				!preview.response.ok ||
				preview.body.synchronized !== true ||
				!hash(preview.body.stateFingerprint)
			)
				throw new Error('Synchronize linked playlist first');
			await this.auth.assertGeneration(authorization.generation);
			const latest = await this.load(show);
			if (latest?.version !== copy.version) throw new CloudProgressError('conflict');
			await this.store.putAutomation(
				registryId(playlistId),
				{
					appCreated: true,
					automaticShow: show,
					baseline: preview.body.stateFingerprint,
					manualUntil: 0,
					uncertain: false
				},
				registry?.version ?? null
			);
			await this.store.putAutomation(
				id(show),
				{
					enabled: true,
					playlistId,
					status: 'ready',
					lastUpdatedAt: old?.value.lastUpdatedAt ?? 0,
					added: 0,
					awaitingReview: automaticReviewCount(copy.progress),
					retryUntil: 0,
					baseline: preview.body.stateFingerprint,
					targetHash: await fingerprintPlaylistSyncTarget(playlistId, target)
				},
				old?.version ?? null
			);
		} finally {
			await this.store.release(claim.lease.id);
		}
	}
	async run(show: string, signal: AbortSignal) {
		let stored = await this.get(show);
		if (!stored?.value.enabled || signal.aborted) return;
		let record = structuredClone(stored.value);
		const save = async () => {
			const version = await this.store.putAutomation(id(show), record, stored!.version);
			stored = { value: structuredClone(record), version };
		};
		const copy = await this.load(show);
		if (
			!copy ||
			copy.progress.playlist.linkedPlaylistId !== record.playlistId ||
			copy.progress.playlist.creationPending
		) {
			record.status = 'progress-changed';
			record.enabled = false;
			await save();
			return;
		}
		const target = automaticPlaylistTarget(copy.progress);
		const targetHash = await fingerprintPlaylistSyncTarget(record.playlistId, target);
		record.awaitingReview = automaticReviewCount(copy.progress);
		// No OAuth/profile/playlist reads if the selected target is unchanged.
		if (!record.sync && record.targetHash === targetHash) {
			if (record.awaitingReview !== stored.value.awaitingReview) await save();
			return;
		}
		if (record.retryUntil > this.now()) return;
		const claim = await this.store.acquire('playlist', this.now());
		if (!claim.lease) {
			record.status = claim.cooldownUntil ? 'cooldown' : 'busy';
			record.retryUntil = claim.cooldownUntil ?? 0;
			await save();
			return;
		}
		const lease = claim.lease.id;
		try {
			const registry = await this.store.getAutomation(registryId(record.playlistId), isRegistry);
			if (!registry || registry.value.uncertain) {
				record.status = 'uncertain';
				await save();
				return;
			}
			if (registry.value.manualUntil > this.now()) {
				record.status = 'busy';
				record.retryUntil = registry.value.manualUntil;
				await save();
				return;
			}
			if (registry.value.target) {
				// An acknowledged manual prefix is still a manual operation after its
				// short lease expires. Never restart replacement behind that client.
				record.status = 'progress-changed';
				record.enabled = false;
				await save();
				return;
			}
			const authorization = await this.auth.token(signal);
			const assertWriter = async () => {
				await this.store.renew(lease, this.now());
				await this.auth.assertGeneration(authorization.generation);
				const current = await this.get(show);
				const latestVersion = await this.versionOf(show);
				if (
					!current?.value.enabled ||
					current.version !== stored!.version ||
					latestVersion !== copy.version
				)
					throw new CloudProgressError('conflict');
			};
			const guardedRequest = async (body: unknown, requestSignal?: AbortSignal) => {
				await assertWriter();
				return this.execute(body, authorization.accessToken, requestSignal ?? signal, assertWriter);
			};
			let previewFingerprint: string | undefined;
			if (!record.sync) {
				const preview = await guardedRequest({
					operation: 'preview',
					playlistId: record.playlistId,
					...target
				});
				if (!preview.response.ok) {
					record.status =
						preview.response.status === 429
							? 'cooldown'
							: preview.response.status === 401
								? 'authentication'
								: 'unavailable';
					record.retryUntil =
						preview.response.status === 429
							? this.now() + Number(preview.body.retryAfterSeconds) * 1000
							: 0;
					await save();
					return;
				}
				// Manual updates made through the coordinated endpoint advance the registry baseline.
				if (preview.body.stateFingerprint !== (registry.value.baseline ?? record.baseline)) {
					record.status = 'external-change';
					record.enabled = false;
					await save();
					return;
				}
				if (preview.body.synchronized === true) {
					record.targetHash = targetHash;
					record.baseline = preview.body.stateFingerprint as string;
					record.status = 'unchanged';
					record.retryUntil = 0;
					await save();
					return;
				}
				if (!hash(preview.body.previewFingerprint)) throw new Error('Invalid preview');
				previewFingerprint = preview.body.previewFingerprint;
				record.pendingAdded = Number(preview.body.addedCount);
				record.target = target;
				record.sync = {
					version: CATALOG_PLAYLIST_SYNC_VERSION,
					revision: 0,
					catalogueAlias: show,
					operationId: randomUUID(),
					playlistId: record.playlistId,
					targetFingerprint: targetHash,
					totalTrackCount: target.tracks.length,
					confirmedPosition: 0,
					phase: 'ready',
					mode: 'updated',
					startedAt: this.now(),
					updatedAt: this.now()
				};
				await save();
			} else if (record.sync.targetFingerprint !== targetHash) {
				record.status = 'progress-changed';
				record.enabled = false;
				await save();
				return;
			}
			if (
				record.sync!.confirmedPosition === 0 &&
				!previewFingerprint &&
				!['dispatching', 'uncertain', 'blocked'].includes(record.sync!.phase)
			) {
				// A pre-dispatch interruption can use a new preview only if the baseline is unchanged.
				const p = await guardedRequest({
					operation: 'preview',
					playlistId: record.playlistId,
					...target
				});
				if (
					!p.response.ok ||
					p.body.stateFingerprint !== (registry.value.baseline ?? record.baseline) ||
					!hash(p.body.previewFingerprint)
				) {
					record.status = 'external-change';
					record.enabled = false;
					await save();
					return;
				}
				previewFingerprint = p.body.previewFingerprint;
			}
			const result = await runPlaylistSyncBatches({
				record: record.sync!,
				target: record.target!,
				previewFingerprint,
				request: guardedRequest,
				signal,
				now: this.now,
				delay: this.delay,
				persist: async (sync) => {
					await this.store.renew(lease, this.now());
					record.sync = { ...sync, revision: sync.revision + 1 };
					record.status =
						sync.phase === 'dispatching' || sync.reason === 'uncertain'
							? 'uncertain'
							: sync.reason === 'settling'
								? 'settling'
								: sync.reason === 'rate-limit'
									? 'cooldown'
									: record.status;
					await save();
					return record.sync;
				}
			});
			record.sync = result.record;
			record.retryUntil =
				result.record.retryUntil ??
				(result.record.phase === 'uncertain' ? (result.record.quarantineUntil ?? 0) : 0);
			if (result.type === 'completed') {
				// Confirm the complete ordered target read-only before accepting a new baseline.
				const p = await guardedRequest({
					operation: 'preview',
					playlistId: record.playlistId,
					...target
				});
				if (!p.response.ok || p.body.synchronized !== true || !hash(p.body.stateFingerprint)) {
					record.status = 'external-change';
					record.enabled = false;
					await save();
					return;
				}
				record.baseline = p.body.stateFingerprint;
				record.targetHash = targetHash;
				record.lastUpdatedAt = this.now();
				record.added = record.pendingAdded ?? 0;
				record.status = 'updated';
				record.retryUntil = 0;
				delete record.sync;
				delete record.target;
				delete record.pendingAdded;
				await this.store.putAutomation(
					registryId(record.playlistId),
					{ ...registry.value, baseline: record.baseline },
					registry.version
				);
			} else
				record.status =
					result.record.reason === 'rate-limit'
						? 'cooldown'
						: result.record.reason === 'authentication'
							? 'authentication'
							: result.record.reason === 'settling'
								? 'settling'
								: result.record.reason === 'external-change'
									? 'external-change'
									: 'uncertain';
			if (record.status === 'external-change' || record.sync?.phase === 'blocked')
				record.enabled = false;
			await save();
		} catch (cause) {
			// Leave a saved dispatching record untouched after any failed acknowledgement save.
			const latest = await this.get(show);
			if (latest && latest.version === stored!.version) {
				record = latest.value;
				record.status =
					record.sync?.phase === 'dispatching'
						? 'uncertain'
						: cause instanceof BackgroundAuthorizationError
							? 'authentication'
							: cause instanceof CloudProgressError && cause.kind === 'conflict'
								? 'progress-changed'
								: 'unavailable';
				await save();
			}
		} finally {
			await this.store.release(lease);
		}
	}
}

// Hosted manual actions and the worker use one exclusive owner-scoped lease. Local
// installs without cloud automation retain their existing endpoint unchanged.
export async function coordinateManualPlaylistRequest(
	event: RequestEvent,
	signal: AbortSignal,
	perform: (guard?: () => Promise<void>) => Promise<Response>
) {
	if (!hostedConfiguration() || !schedulesEnabled()) return perform();
	if (!hasHostedSession(event)) return json({ error: 'not_authorized' }, { status: 401 });
	const store = new ScheduleStore(event.fetch);
	const claim = await store.acquire('playlist');
	if (!claim.lease)
		return json(
			{
				error: claim.cooldownUntil ? 'spotify_rate_limited' : 'playlist_busy',
				...(claim.cooldownUntil
					? { retryAfterSeconds: Math.ceil((claim.cooldownUntil - Date.now()) / 1000) }
					: {})
			},
			{ status: claim.cooldownUntil ? 429 : 409 }
		);
	const cloned = event.request.clone();
	let result: Response | undefined;
	try {
		const body = await _parseRequest(cloned, signal);
		const old =
			'playlistId' in body
				? await store.getAutomation(registryId(body.playlistId), isRegistry)
				: null;
		if (old && ['apply-batch', 'append'].includes(body.operation)) {
			const automation = old.value.automaticShow
				? await store.getAutomation(id(old.value.automaticShow), isAutomaticPlaylistRecord)
				: null;
			if (
				old.value.uncertain ||
				(automation?.value.sync && automation.value.sync.phase !== 'completed')
			)
				return json({ error: 'playlist_sync_ambiguous' }, { status: 409 });
		}
		// Persist uncertainty before dispatch. A crash or failed acknowledgement save
		// can never release an automatic writer into an unknown manual mutation.
		if (old && ['apply-batch', 'append'].includes(body.operation)) {
			await store.putAutomation(
				registryId((body as { playlistId: string }).playlistId),
				{
					...old.value,
					manualUntil: Date.now() + 5 * 60_000,
					uncertain: true,
					...(body.operation === 'apply-batch'
						? {
								target: {
									name: body.name,
									description: body.description,
									public: body.public,
									tracks: body.tracks
								}
							}
						: {})
				},
				old.version
			);
		}
		const response = (result = await perform(() => store.renew(claim.lease!.id)));
		// The core validated/bounded request before any dispatch; never log its contents.
		if (signal.aborted || response.status === 400) return response;
		const reply = await response
			.clone()
			.json()
			.catch(() => null);
		if (response.status === 429 && isSafeRetryAfterSeconds(reply?.retryAfterSeconds))
			await store.cooldown(reply.retryAfterSeconds, 'rate-limited');
		const playlistId = reply?.playlistId ?? ('playlistId' in body ? body.playlistId : undefined);
		if (!isSpotifyPlaylistId(playlistId)) return response;
		const registry = await store.getAutomation(registryId(playlistId), isRegistry);
		if (body?.operation === 'create' && response.ok) {
			await store.putAutomation(
				registryId(playlistId),
				{ appCreated: true, manualUntil: Date.now() + 5 * 60_000, uncertain: false },
				registry?.version ?? null
			);
		} else if (registry && ['apply-batch', 'append'].includes(body?.operation)) {
			const final = response.ok && reply.confirmedPosition === reply.totalTrackCount;
			const target = registry.value.target;
			await store.putAutomation(
				registryId(playlistId),
				{
					...registry.value,
					manualUntil: Date.now() + 5 * 60_000,
					uncertain: response.status >= 500,
					...(final && target
						? {
								baseline: fingerprintSpotifyPlaylist({
									playlistId,
									snapshotId: reply.snapshotId,
									name: target.name,
									description: target.description,
									public: target.public,
									items: target.tracks
								}),
								target: undefined
							}
						: {})
				},
				registry.version
			);
		}
		return response;
	} catch {
		// Acknowledged creation must still return its ID even if registry persistence fails.
		return result ?? json({ error: 'playlist_coordination_unavailable' }, { status: 503 });
	} finally {
		await store.release(claim.lease.id).catch(() => undefined);
	}
}
