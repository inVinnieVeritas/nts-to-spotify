import { describe, expect, it, vi } from 'vitest';
import {
	CATALOG_PLAYLIST_SYNC_VERSION,
	PLAYLIST_SYNC_LEASE_MS,
	PLAYLIST_SYNC_QUARANTINE_MS,
	fingerprintPlaylistSyncTarget,
	isCatalogPlaylistSyncRecord,
	parsePlaylistBatchSuccess,
	persistCreatedPlaylistBeforeSync,
	playlistSyncBatches,
	playlistSyncStatusText,
	playlistSyncEligibility,
	requestPlaylistJson,
	restoreCatalogPlaylistSyncRecord,
	runPlaylistSyncBatches,
	safePlaylistRetryDeadline,
	createPlaylistSyncOperationId,
	createPlaylistSyncPreviewGuard,
	latestPlaylistSyncRecord,
	playlistSyncRecordStamp,
	playlistSyncFeedback,
	type CatalogPlaylistSyncRecord,
	type PlaylistSyncTarget
} from './playlist-sync.client';
import { parseSpotifyPlaylistPreview } from './playlist-preview.client';

const ID = 'ABCDEFGHIJKLMNOPQRSTUV';
const uri = (i: number) => 'spotify:track:' + String(i).padStart(22, '0');
const NOW = 1_000_000;
const target = (n: number): PlaylistSyncTarget => ({
	name: 'Amanda',
	description: 'Archive',
	public: false,
	tracks: Array.from({ length: n }, (_, i) => uri(i))
});
const state = async (
	n = 181,
	extra: Partial<CatalogPlaylistSyncRecord> = {}
): Promise<CatalogPlaylistSyncRecord> => ({
	version: CATALOG_PLAYLIST_SYNC_VERSION,
	revision: 0,
	catalogueAlias: 'amanda',
	operationId: 'operation_1234567890',
	playlistId: ID,
	targetFingerprint: await fingerprintPlaylistSyncTarget(ID, target(n)),
	totalTrackCount: n,
	confirmedPosition: 0,
	phase: 'interrupted',
	mode: 'created',
	startedAt: NOW,
	updatedAt: NOW,
	restartRequired: true,
	...extra
});
const result = (body: unknown, status = 200) => ({
	response: new Response(JSON.stringify(body), { status }),
	body
});
const prefix = {
	confirmedPosition: 100,
	snapshotId: 's1',
	restartRequired: false,
	phase: 'ready' as const
};
type Body = Record<string, unknown>;

// Stateful HTTP fixture. Reads and writes are counted separately; settlement
// cannot accidentally be counted as another successful mutation.
const upstream = (n: number, initial: string[] = []) => {
	let items = [...initial],
		snapshot = initial.length ? 1 : 0;
	const requests: Body[] = [];
	const request = vi.fn(async (raw: unknown) => {
		const body = raw as Body;
		requests.push(body);
		if (body.operation === 'settle')
			return result({ mode: 'settled', playlistId: ID, snapshotId: 's' + snapshot });
		if (body.operation === 'preview') return result({ mode: 'preview' });
		if (body.operation === 'apply-batch') items = (body.tracks as string[]).slice(0, 100);
		else items.push(...(body.tracks as string[]));
		snapshot++;
		return result({
			mode: 'batch',
			playlistId: ID,
			totalTrackCount: n,
			confirmedPosition: items.length,
			snapshotId: 's' + snapshot
		});
	});
	return { request, requests, items: () => items };
};
const run = async (
	record: CatalogPlaylistSyncRecord,
	request: (body: unknown) => Promise<ReturnType<typeof result>>,
	extra: Partial<Parameters<typeof runPlaylistSyncBatches>[0]> = {}
) =>
	runPlaylistSyncBatches({
		record,
		target: target(record.totalTrackCount),
		previewFingerprint: 'b'.repeat(64),
		request,
		persist: async () => undefined,
		now: () => NOW,
		delay: async () => undefined,
		...extra
	});

describe('resumable playlist synchronization', () => {
	it.each(['settling', 'external-change', 'unavailable', 'uncertain'] as const)(
		'lets an exact preview supersede the older %s warning without changing durable safety state',
		async (reason) => {
			const record = await state(181, {
				...prefix,
				revision: 8,
				phase: reason === 'settling' ? 'settling' : 'blocked',
				reason,
				settleUntil: NOW + 30000
			});
			const before = structuredClone(record);
			const signature = 'current-selected-tracks-and-settings';
			const exact = parseSpotifyPlaylistPreview(
				{
					mode: 'preview',
					playlistId: ID,
					previewFingerprint: 'b'.repeat(64),
					addedCount: 0,
					removedCount: 0,
					retainedCount: 181,
					orderChanged: false,
					titleChanged: false,
					descriptionChanged: false,
					visibilityChanged: false,
					synchronized: true
				},
				ID,
				signature
			)!;
			expect(
				playlistSyncFeedback(record, undefined, signature, undefined, 'owner', NOW).historicalStatus
			).not.toBe('');
			const after = playlistSyncFeedback(
				record,
				exact,
				signature,
				playlistSyncRecordStamp(record),
				'owner',
				NOW
			);
			expect(after.historicalStatus).toBe('');
			expect(after.synchronizedStatus).not.toContain('changed externally');
			expect(after.synchronizedStatus).not.toContain('Check a fresh preview');
			expect(record).toEqual(before);
			if (reason === 'uncertain') {
				expect(after.synchronizedStatus).toContain('Further writes remain blocked');
				expect(playlistSyncEligibility(record, 'owner', NOW).disabled).toBe(true);
			} else expect(after.synchronizedStatus).toBe('Spotify playlist is already synchronized.');
			// A changed target or genuinely newer operation invalidates the observation.
			expect(
				playlistSyncFeedback(
					record,
					exact,
					'changed-target',
					playlistSyncRecordStamp(record),
					'owner',
					NOW
				).synchronizedStatus
			).toBe('');
			expect(
				playlistSyncFeedback(
					{ ...record, revision: 9 },
					exact,
					signature,
					playlistSyncRecordStamp(record),
					'owner',
					NOW
				).synchronizedStatus
			).toBe('');
		}
	);
	it('rejects stale preview success and failure callbacks after a newer preview, input change or destruction', async () => {
		const record = await state(181, { ...prefix, revision: 8 });
		const guard = createPlaylistSyncPreviewGuard();
		const first = guard.begin('target', record);
		const second = guard.begin('target', record);
		let displayed = '';
		const publish = (ticket: typeof first, value: string) => {
			if (guard.isCurrent(ticket, 'target', record)) displayed = value;
		};
		publish(second, 'Spotify playlist is already synchronized.');
		await Promise.resolve();
		publish(first, 'Preview failed. Try again.');
		expect(displayed).toBe('Spotify playlist is already synchronized.');
		expect(guard.isCurrent(second, 'changed-target', record)).toBe(false);
		expect(guard.isCurrent(second, 'target', { ...record, revision: 9 })).toBe(false);
		guard.invalidate();
		expect(guard.isCurrent(second, 'target', record)).toBe(false);
	});
	it('presents an exact read-only ambiguous-outcome reconciliation without releasing the write block or creating a playlist', async () => {
		const record = await state(181, {
			...prefix,
			phase: 'uncertain',
			reason: 'uncertain',
			dispatchStartedAt: NOW,
			quarantineUntil: NOW + PLAYLIST_SYNC_QUARANTINE_MS
		});
		const request = vi.fn(async () =>
			result({
				mode: 'preview',
				playlistId: ID,
				previewFingerprint: 'b'.repeat(64),
				addedCount: 0,
				removedCount: 0,
				retainedCount: 181,
				synchronized: true,
				orderChanged: false,
				titleChanged: false,
				descriptionChanged: false,
				visibilityChanged: false
			})
		);
		const outcome = await run(record, request, {
			now: () => NOW + PLAYLIST_SYNC_QUARANTINE_MS + 1,
			previewInputSignature: 'target'
		});
		expect(outcome.type).toBe('interrupted');
		if (outcome.type !== 'interrupted') throw new Error('Expected read-only reconciliation');
		expect(request).toHaveBeenCalledExactlyOnceWith(
			{ operation: 'preview', playlistId: ID, ...target(181) },
			undefined
		);
		expect(outcome.record).toMatchObject({
			playlistId: ID,
			phase: 'blocked',
			reason: 'uncertain',
			confirmedPosition: 100
		});
		expect(outcome.readOnlyPreview?.synchronized).toBe(true);
		const feedback = playlistSyncFeedback(
			outcome.record,
			outcome.readOnlyPreview,
			'target',
			playlistSyncRecordStamp(outcome.record),
			'owner',
			NOW + PLAYLIST_SYNC_QUARANTINE_MS + 1
		);
		expect(feedback.historicalStatus).toBe('');
		expect(feedback.synchronizedStatus).toContain('Further writes remain blocked');
		expect(
			playlistSyncEligibility(outcome.record, 'owner', NOW + PLAYLIST_SYNC_QUARANTINE_MS + 1)
				.disabled
		).toBe(true);
	});
	it('does not let an older record callback invalidate a newer exact preview', async () => {
		const current = await state(181, { ...prefix, revision: 8 });
		const guard = createPlaylistSyncPreviewGuard();
		const ticket = guard.begin('target', current);
		const late = {
			...current,
			revision: 7,
			phase: 'blocked' as const,
			reason: 'external-change' as const
		};
		const adopted = latestPlaylistSyncRecord(current, late);
		expect(adopted).toBe(current);
		expect(guard.isCurrent(ticket, 'target', adopted)).toBe(true);
		expect(latestPlaylistSyncRecord(current, { ...late, revision: 9 })).not.toBe(current);
	});
	it.each([0, 1, 99, 100, 101, 200, 201, 1508])(
		'preserves exact order and bounded batch sizes for %i tracks',
		async (n) => {
			const api = upstream(n);
			const outcome = await run(await state(n), api.request);
			expect(outcome.type).toBe('completed');
			expect(api.items()).toEqual(target(n).tracks);
			const writes = api.requests.filter((b) => b.operation !== 'settle');
			expect(writes).toHaveLength(Math.max(1, Math.ceil(n / 100)));
			const batches = playlistSyncBatches(target(n).tracks);
			if (n === 1508) expect(batches.map((b) => b.length)).toEqual([...Array(15).fill(100), 8]);
			expect(batches.flat()).toEqual(target(n).tracks);
			expect(api.requests.filter((b) => b.operation === 'settle')).toHaveLength(writes.length);
		}
	);
	it('fingerprints order and metadata independently', async () => {
		const t = target(2),
			original = await fingerprintPlaylistSyncTarget(ID, t);
		expect(
			await fingerprintPlaylistSyncTarget(ID, { ...t, tracks: [...t.tracks].reverse() })
		).not.toBe(original);
		expect(await fingerprintPlaylistSyncTarget(ID, { ...t, name: 'Changed' })).not.toBe(original);
	});
	it('waits for durable ID persistence and stops when it fails', async () => {
		let finish!: (value: boolean) => void;
		const pending = persistCreatedPlaylistBeforeSync(
			{
				mode: 'created',
				playlistId: ID,
				url: 'https://open.spotify.com/playlist/' + ID,
				trackCount: 0
			},
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		let continued = false;
		void pending.then(() => {
			continued = true;
		});
		await Promise.resolve();
		expect(continued).toBe(false);
		finish(false);
		expect(await pending).toBeUndefined();
		expect(
			await persistCreatedPlaylistBeforeSync(
				{ mode: 'created', playlistId: ID, url: 'https://evil.test', trackCount: 0 },
				async () => true
			)
		).toBeUndefined();
	});
	it('settles stale reads at 100/181 without replacing or duplicating any tracks', async () => {
		const api = upstream(181);
		let stale = 2;
		let delays = 0;
		const outcome = await run(
			await state(),
			async (raw) => {
				if ((raw as Body).operation === 'settle' && stale-- > 0)
					return result({ error: 'playlist_settling' }, 409);
				return api.request(raw);
			},
			{
				delay: async () => {
					delays++;
				}
			}
		);
		expect(outcome.type).toBe('completed');
		expect(delays).toBe(2);
		expect(api.items()).toEqual(target(181).tracks);
		expect(api.requests.filter((b) => b.operation === 'apply-batch')).toHaveLength(1);
		expect(api.requests.filter((b) => b.operation === 'append')).toHaveLength(1);
	});
	it('offers a bounded countdown after three stale reads, then immediate Resume makes no request', async () => {
		const api = upstream(181);
		let clock = NOW;
		const stale = async (raw: unknown) =>
			(raw as Body).operation === 'settle'
				? result({ error: 'playlist_settling' }, 409)
				: api.request(raw);
		const stopped = await run(await state(), stale, {
			now: () => clock,
			delay: async (ms) => {
				clock += ms;
			}
		});
		expect(stopped.record).toMatchObject({
			phase: 'settling',
			confirmedPosition: 100,
			reason: 'settling'
		});
		expect(playlistSyncEligibility(stopped.record, 'document_123456789', clock)).toMatchObject({
			disabled: true,
			seconds: 5
		});
		const noWrite = vi.fn(async (body: unknown) => api.request(body));
		await run(stopped.record, noWrite, { now: () => clock });
		expect(noWrite).not.toHaveBeenCalled();
		clock += 5000;
		expect(playlistSyncEligibility(stopped.record, 'document_123456789', clock).disabled).toBe(
			false
		);
		expect((await run(stopped.record, api.request, { now: () => clock })).type).toBe('completed');
		expect(api.items()).toEqual(target(181).tracks);
	});
	it('blocks unverified state after the settlement deadline without claiming an external edit', async () => {
		const record = await state(181, {
			...prefix,
			phase: 'settling',
			reason: 'settling',
			settleUntil: NOW
		});
		const request = vi.fn(async () => result({ error: 'playlist_settling' }, 409));
		const stopped = await run(record, request);
		expect(stopped.record).toMatchObject({
			phase: 'blocked',
			reason: 'external-change',
			confirmedPosition: 100
		});
		expect(request).toHaveBeenCalledOnce();
		expect(playlistSyncStatusText(stopped.record)).not.toContain('changed externally');
	});
	it('treats an append HTTP 409 as a pre-mutation conflict and only settles on Resume', async () => {
		const api = upstream(181, target(181).tracks.slice(0, 100));
		let conflict = true;
		const request = async (raw: unknown) =>
			(raw as Body).operation === 'append' && conflict
				? result({ error: 'playlist_changed_since_sync' }, 409)
				: api.request(raw);
		const first = await run(await state(181, prefix), request);
		expect(first.record).toMatchObject({
			phase: 'settling',
			confirmedPosition: 100,
			reason: 'settling'
		});
		expect(first.record.reason).not.toBe('uncertain');
		conflict = false;
		expect((await run(first.record, request, { now: () => NOW + 5000 })).type).toBe('completed');
		expect(api.requests.some((b) => b.operation === 'apply-batch')).toBe(false);
	});
	it.each([1, 8, 16])('quarantines an ambiguous failure at batch %i', async (failAt) => {
		const api = upstream(1508);
		let writes = 0;
		const outcome = await run(await state(1508), async (raw) => {
			if ((raw as Body).operation !== 'settle' && ++writes === failAt)
				return result({ error: 'playlist_sync_incomplete' }, 503);
			return api.request(raw);
		});
		expect(writes).toBe(failAt);
		expect(outcome.record.phase).toBe('uncertain');
		expect(outcome.record.confirmedPosition).toBe((failAt - 1) * 100);
		expect(outcome.record.quarantineUntil).toBe(NOW + PLAYLIST_SYNC_QUARANTINE_MS);
	});
	it('never races a delayed old append with recovery and stays read-only after quarantine', async () => {
		const api = upstream(181, target(181).tracks.slice(0, 100));
		let delayed: unknown;
		const interrupted = await run(await state(181, prefix), async (raw) => {
			if ((raw as Body).operation === 'settle') return api.request(raw);
			delayed = raw;
			throw new Error('PRIVATE_NETWORK');
		});
		expect(interrupted.record.phase).toBe('uncertain');
		const before = api.requests.length;
		await run(interrupted.record, api.request);
		expect(api.requests).toHaveLength(before);
		await api.request(delayed);
		const checked = await run(interrupted.record, api.request, {
			now: () => NOW + PLAYLIST_SYNC_QUARANTINE_MS + 1
		});
		expect(checked.record).toMatchObject({ phase: 'blocked', reason: 'uncertain' });
		expect(api.items()).toEqual(target(181).tracks);
		expect(api.requests.at(-1)?.operation).toBe('preview');
		expect(api.requests.filter((b) => b.operation === 'append')).toHaveLength(1);
		expect(JSON.stringify(checked)).not.toContain('PRIVATE');
	});
	it('treats post-ack persistence failure as uncertain instead of repeating the append', async () => {
		const api = upstream(181, target(181).tracks.slice(0, 100));
		let failed = false;
		const outcome = await run(await state(181, prefix), api.request, {
			persist: async (next) => {
				if (next.confirmedPosition === 181 && !failed) {
					failed = true;
					throw new Error('IDB failure');
				}
			}
		});
		expect(outcome.record).toMatchObject({ phase: 'uncertain', confirmedPosition: 100 });
		expect(api.items()).toHaveLength(181);
	});
	it('restores dispatching as uncertain before lease expiry and does not dispatch again', async () => {
		const original = await state(181, {
			...prefix,
			phase: 'dispatching',
			dispatchStartedAt: NOW,
			quarantineUntil: NOW + PLAYLIST_SYNC_QUARANTINE_MS,
			leaseOwner: 'document_123456789',
			leaseUntil: NOW + PLAYLIST_SYNC_LEASE_MS
		});
		const restored = restoreCatalogPlaylistSyncRecord(original, 'amanda', NOW + 1)!;
		expect(restored.phase).toBe('uncertain');
		const request = vi.fn(async () => result({}));
		await run(restored, request, { now: () => NOW + 1 });
		expect(request).not.toHaveBeenCalled();
	});
	it('keeps legacy ambiguous records blocked and preserves unknown creation without an ID', async () => {
		const linked: Record<string, unknown> = await state();
		delete linked.revision;
		expect(restoreCatalogPlaylistSyncRecord(linked, 'amanda', NOW)).toMatchObject({
			phase: 'blocked',
			reason: 'uncertain',
			playlistId: ID
		});
		const creating = { ...linked, phase: 'creating', playlistId: undefined };
		expect(restoreCatalogPlaylistSyncRecord(creating, 'amanda', NOW)).toMatchObject({
			phase: 'creating'
		});
		expect(restoreCatalogPlaylistSyncRecord(creating, 'amanda', NOW)).not.toHaveProperty(
			'playlistId'
		);
	});
	it('persists multi-hour Spotify cooldowns and resumes only after the deadline', async () => {
		const api = upstream(181, target(181).tracks.slice(0, 100));
		let limited = true;
		const request = async (raw: unknown) =>
			(raw as Body).operation === 'append' && limited
				? result({ error: 'spotify_rate_limited', retryAfterSeconds: 30785 }, 429)
				: api.request(raw);
		const paused = await run(await state(181, prefix), request);
		expect(paused.record.retryUntil).toBe(NOW + 30785000);
		expect(playlistSyncEligibility(paused.record, 'document_123456789', NOW).disabled).toBe(true);
		limited = false;
		expect((await run(paused.record, request, { now: () => NOW + 30785001 })).type).toBe(
			'completed'
		);
		expect(api.items()).toEqual(target(181).tracks);
	});
	it('authentication failures do not retry or erase the confirmed prefix', async () => {
		const api = upstream(181, target(181).tracks.slice(0, 100));
		const stopped = await run(await state(181, prefix), (raw) =>
			(raw as Body).operation === 'settle'
				? api.request(raw)
				: Promise.resolve(result({ error: 'spotify_authentication' }, 401))
		);
		expect(stopped.record).toMatchObject({
			phase: 'interrupted',
			reason: 'authentication',
			confirmedPosition: 100
		});
		expect(playlistSyncStatusText(stopped.record)).toContain('login expired');
	});
	it('rejects malformed, future-dated and inconsistent records', async () => {
		const base = await state();
		expect(isCatalogPlaylistSyncRecord(base, 'amanda', NOW)).toBe(true);
		for (const extra of [
			{ revision: -1 },
			{ updatedAt: NaN },
			{ updatedAt: Number.MAX_SAFE_INTEGER },
			{ updatedAt: NOW - 1 },
			{ phase: 'dispatching' },
			{ phase: 'settling' },
			{ phase: 'completed' },
			{ snapshotId: 123 },
			{ leaseOwner: 123, leaseUntil: NOW + 1 },
			{ leaseOwner: 'document_123456789', leaseUntil: NOW + PLAYLIST_SYNC_LEASE_MS + 1 },
			{ phase: 'paused', retryUntil: Number.MAX_SAFE_INTEGER },
			{ constructor: {} },
			{ dispatchStartedAt: NOW + 1, quarantineUntil: NOW + PLAYLIST_SYNC_QUARANTINE_MS }
		])
			expect(isCatalogPlaylistSyncRecord({ ...base, ...extra }, 'amanda', NOW)).toBe(false);
		expect(safePlaylistRetryDeadline(8 * 3600, NOW)).toBe(NOW + 8 * 3600000);
		expect(safePlaylistRetryDeadline(3 * 86400, NOW)).toBe(NOW + 3 * 86400000);
		expect(safePlaylistRetryDeadline(Number.MAX_SAFE_INTEGER, NOW)).toBeUndefined();
	});
	it('uses fresh identities and exposes independent lock/countdown/action state', async () => {
		expect(createPlaylistSyncOperationId()).not.toBe(createPlaylistSyncOperationId());
		const locked = await state(181, {
			...prefix,
			leaseOwner: 'other_document_123',
			leaseUntil: NOW + 10000
		});
		expect(playlistSyncEligibility(locked, 'this_document_123', NOW)).toMatchObject({
			disabled: true,
			seconds: 10,
			label: 'Synchronization active elsewhere'
		});
		expect(playlistSyncEligibility(locked, 'this_document_123', NOW + 10001).disabled).toBe(false);
		expect(
			playlistSyncStatusText(
				await state(181, {
					phase: 'uncertain',
					reason: 'uncertain',
					dispatchStartedAt: NOW,
					quarantineUntil: NOW + PLAYLIST_SYNC_QUARANTINE_MS
				}),
				NOW
			)
		).toContain('No further writes');
	});
	it('bounds browser body parsing and cancels a stalled response', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					new Response(
						new ReadableStream({
							start(c) {
								init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
							}
						})
					)
			);
			const pending = requestPlaylistJson(fetcher, {}, undefined, 20);
			const rejected = expect(pending).rejects.toMatchObject({ name: 'RequestTimeoutError' });
			await vi.advanceTimersByTimeAsync(20);
			await rejected;
		} finally {
			vi.useRealTimers();
		}
	});
	it('rejects malformed acknowledgements and target drift', async () => {
		expect(parsePlaylistBatchSuccess({}, ID, 100, 100)).toBeUndefined();
		await expect(
			run(await state(), upstream(181).request, { target: { ...target(181), name: 'Changed' } })
		).rejects.toThrow('target changed');
	});
});
