import { describe, expect, it, vi } from 'vitest';
vi.mock('$lib/utils/auth.server', () => ({ getAccessToken: vi.fn(async () => 'fixture-token') }));
import { POST } from '../../routes/api/spotify/playlist/+server';
import { fingerprintSpotifyPlaylistPreview } from './playlist-preview.server';
import { getSpotifySessionMetrics } from './spotify.server';
import {
	claimCatalogPlaylistSyncLease,
	deleteCatalogProgress,
	listCatalogProgress,
	loadCatalogProgress,
	loadCatalogPlaylistSync,
	saveCatalogProgress,
	saveCatalogPlaylistSync
} from './catalog-progress.client';
import {
	CATALOG_PLAYLIST_SYNC_VERSION,
	PLAYLIST_SYNC_LEASE_MS,
	fingerprintPlaylistSyncTarget,
	runPlaylistSyncBatches,
	persistCreatedPlaylistBeforeSync,
	playlistSyncFeedback,
	playlistSyncRecordStamp,
	createPlaylistSyncPreviewGuard,
	requestPlaylistJson,
	type CatalogPlaylistSyncRecord
} from './playlist-sync.client';
import {
	parseSpotifyPlaylistPreview,
	createPlaylistPreviewInputSignature
} from './playlist-preview.client';
import {
	captureCatalogProgress,
	getCatalogExportUris,
	getResumableEpisodeIndexes,
	runCatalogWorkers,
	type EpisodeState,
	type ReviewTrack
} from './catalog-scan';
import { reconcileSavedCatalogWithNTS } from './catalog-update';

const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';
const syncRecord = (alias = 'show'): CatalogPlaylistSyncRecord => ({
	version: CATALOG_PLAYLIST_SYNC_VERSION,
	revision: 0,
	catalogueAlias: alias,
	operationId: 'operation_1234567890',
	playlistId: PLAYLIST_ID,
	targetFingerprint: 'a'.repeat(64),
	totalTrackCount: 1508,
	confirmedPosition: 100,
	phase: 'ready',
	mode: 'created',
	startedAt: 1,
	updatedAt: 1,
	snapshotId: 'snapshot-1'
});

// Transactional in-memory IDB double: writes commit at oncomplete, abort rolls
// back, and transactions serialize even across separate database connections.
const memoryFactory = () => {
	const values = new Map<string, unknown>();
	const control = { failNextWrite: false, closed: 0 };
	const queued: (() => void)[] = [];
	let busy = false;
	const schedule = () => {
		if (!busy && queued.length) {
			busy = true;
			queueMicrotask(queued.shift()!);
		}
	};
	const database = {
		objectStoreNames: { contains: () => true },
		close: () => {
			control.closed++;
		},
		transaction: (_store: string, mode: string) => {
			const jobs: (() => void)[] = [];
			let staged: Map<string, unknown>;
			let aborted = false;
			const request = (action: () => unknown) => {
				const req = {} as IDBRequest;
				jobs.push(() => {
					if (aborted) return;
					Object.defineProperty(req, 'result', { value: action() });
					if (!aborted) req.onsuccess?.(new Event('success'));
				});
				return req;
			};
			const transaction = {
				error: null,
				abort() {
					aborted = true;
				},
				objectStore: () => ({
					get: (key: string) => request(() => structuredClone(staged.get(key))),
					getAll: () => request(() => [...staged.values()].map((v) => structuredClone(v))),
					put: (value: { showAlias: string }) =>
						request(() => {
							if (control.failNextWrite) {
								control.failNextWrite = false;
								aborted = true;
								(transaction as { error: Error | null }).error = new Error('fixture write failed');
								return;
							}
							staged.set(value.showAlias, structuredClone(value));
						}),
					delete: (key: string) =>
						request(() => {
							staged.delete(key);
						})
				})
			} as unknown as IDBTransaction;
			queued.push(() => {
				staged = new Map(values);
				while (jobs.length && !aborted) jobs.shift()!();
				if (aborted) transaction.onabort?.(new Event('abort'));
				else {
					if (mode === 'readwrite') {
						values.clear();
						for (const [k, v] of staged) values.set(k, v);
					}
					transaction.oncomplete?.(new Event('complete'));
				}
				busy = false;
				schedule();
			});
			schedule();
			return transaction;
		}
	} as unknown as IDBDatabase;
	const factory = {
		open: () => {
			const request = { result: database } as IDBOpenDBRequest;
			queueMicrotask(() => request.onsuccess?.(new Event('success')));
			return request;
		}
	} as unknown as IDBFactory;
	return { factory, values, control };
};

describe('catalogue playlist synchronization persistence', () => {
	it('updates one linked playlist after scanning only newly reconciled episodes', async () => {
		const { factory } = memoryFactory();
		const options = { factory, timeoutMs: 100 };
		let clock = Date.now();
		const owner = 'existing_playlist_update_document';
		const uri = (index: number) => `spotify:track:${String(index).padStart(22, '0')}`;
		const reviewTrack = (index: number): ReviewTrack => ({
			artist: `NTS artist ${index}`,
			title: `NTS title ${index}`,
			matches: [
				{
					artist: `Spotify artist ${index}`,
					title: `Spotify title ${index}`,
					uri: uri(index),
					href: `https://open.spotify.com/track/${String(index).padStart(22, '0')}`
				}
			],
			confident: true,
			fallback: false,
			selectedMatch: uri(index),
			checked: true
		});
		const episode = (
			episodeAlias: string,
			broadcast: string,
			tracks: ReviewTrack[] = [],
			status: EpisodeState['status'] = 'done'
		): EpisodeState => ({
			episodeAlias,
			name: episodeAlias,
			broadcast,
			cover: '',
			genres: [],
			status,
			tracks
		});
		const oldest = episode(
			'oldest',
			'2025-01-01T00:00:00.000Z',
			Array.from({ length: 50 }, (_, index) => reviewTrack(index))
		);
		const recent = episode(
			'recent',
			'2025-06-01T00:00:00.000Z',
			Array.from({ length: 50 }, (_, index) => reviewTrack(index + 50))
		);
		const newSummary = episode('new-episode', '2026-01-01T00:00:00.000Z', [], 'pending');
		const playlist = {
			title: 'Existing linked archive',
			description: 'Reviewed catalogue',
			public: false,
			order: 'latest-first' as const,
			linkedPlaylistId: PLAYLIST_ID
		};
		const originalProgress = captureCatalogProgress('show', [oldest, recent], playlist);
		const originalReviews = structuredClone(
			Object.fromEntries(
				Object.values(originalProgress.episodes).map(({ episodeAlias, tracks }) => [
					episodeAlias,
					tracks
				])
			)
		);
		await saveCatalogProgress(originalProgress, options);

		const reconciled = reconcileSavedCatalogWithNTS(
			(await loadCatalogProgress('show', options))!,
			{
				showAlias: 'show',
				name: 'Show',
				description: '',
				cover: '',
				episodes: [newSummary, recent, oldest]
			},
			clock
		);
		expect(reconciled.addedCount).toBe(1);
		expect(reconciled.progress.playlist).toEqual(playlist);
		expect(reconciled.progress.episodes.oldest.tracks).toEqual(originalReviews.oldest);
		expect(reconciled.progress.episodes.recent.tracks).toEqual(originalReviews.recent);
		expect(reconciled.progress.episodes['new-episode']).toMatchObject({
			status: 'pending',
			tracks: []
		});
		await saveCatalogProgress(reconciled.progress, options);

		const episodes = Object.values((await loadCatalogProgress('show', options))!.episodes);
		const resumable = getResumableEpisodeIndexes(episodes);
		const scannedAliases: string[] = [];
		await runCatalogWorkers({
			indexes: resumable,
			concurrency: 2,
			signal: new AbortController().signal,
			waitUntilReady: async () => undefined,
			scanEpisode: async (index) => {
				scannedAliases.push(episodes[index].episodeAlias);
				episodes[index] = {
					...episodes[index],
					status: 'done',
					tracks: [reviewTrack(100), reviewTrack(20), reviewTrack(101), reviewTrack(102)]
				};
				return { type: 'done' };
			},
			onRateLimit: () => {
				throw new Error('Unexpected rate limit');
			},
			onSystemicSpotifyFailure: () => {
				throw new Error('Unexpected Spotify failure');
			}
		});
		expect(scannedAliases).toEqual(['new-episode']);
		expect(episodes.filter(({ status }) => status === 'done')).toHaveLength(3);
		await saveCatalogProgress(captureCatalogProgress('show', episodes, playlist), options);

		const restoredProgress = (await loadCatalogProgress('show', options))!;
		expect(restoredProgress.playlist.linkedPlaylistId).toBe(PLAYLIST_ID);
		expect(restoredProgress.episodes.oldest.tracks).toEqual(originalReviews.oldest);
		expect(restoredProgress.episodes.recent.tracks).toEqual(originalReviews.recent);
		const oldTargetTracks = getCatalogExportUris([oldest, recent], 'latest-first');
		const targetTracks = getCatalogExportUris(
			Object.values(restoredProgress.episodes),
			'latest-first'
		);
		expect(oldTargetTracks).toEqual([
			...Array.from({ length: 50 }, (_, index) => uri(index + 50)),
			...Array.from({ length: 50 }, (_, index) => uri(index))
		]);
		expect(targetTracks).toEqual([
			uri(100),
			uri(20),
			uri(101),
			uri(102),
			...oldTargetTracks.filter((value) => value !== uri(20))
		]);
		expect(new Set(targetTracks).size).toBe(targetTracks.length);

		let items = [...oldTargetTracks];
		let snapshotId = 'snapshot-0';
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' }
			});
		const spotify = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return json({ id: 'fixture-user' });
			if (url.endsWith('/v1/me/playlists')) throw new Error('Must not create another playlist');
			if (url.includes('/items?')) {
				const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
				return json({
					total: items.length,
					items: items
						.slice(offset, offset + 100)
						.map((trackUri) => ({ item: { type: 'track', uri: trackUri } }))
				});
			}
			if (url.includes('?fields=')) {
				return json({
					id: PLAYLIST_ID,
					owner: { id: 'fixture-user' },
					snapshot_id: snapshotId,
					name: playlist.title,
					description: playlist.description,
					public: playlist.public
				});
			}
			if (url.endsWith(`/v1/playlists/${PLAYLIST_ID}`) && init?.method === 'PUT') {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith(`/v1/playlists/${PLAYLIST_ID}/items`) && init?.method === 'PUT') {
				items = [...(JSON.parse(String(init.body)).uris as string[])];
				snapshotId = 'snapshot-1';
				return json({ snapshot_id: snapshotId });
			}
			if (url.endsWith(`/v1/playlists/${PLAYLIST_ID}/items`) && init?.method === 'POST') {
				items.push(...(JSON.parse(String(init.body)).uris as string[]));
				snapshotId = 'snapshot-2';
				return json({ snapshot_id: snapshotId });
			}
			throw new Error('Unexpected Spotify request');
		});
		const endpoint = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			POST({
				request: new Request('http://localhost/api/spotify/playlist', init),
				fetch: spotify
			} as never)
		);
		const request = (body: unknown, signal?: AbortSignal) =>
			requestPlaylistJson(endpoint, body, signal);
		const target = {
			name: playlist.title,
			description: playlist.description,
			public: playlist.public,
			tracks: targetTracks
		};
		const signature = createPlaylistPreviewInputSignature({
			playlistId: PLAYLIST_ID,
			title: target.name,
			...target
		});
		const mutationCount = () =>
			spotify.mock.calls.filter(([, init]) => ['POST', 'PUT'].includes(init?.method ?? '')).length;
		const firstPreviewResponse = await request({
			operation: 'preview',
			playlistId: PLAYLIST_ID,
			...target
		});
		const firstPreview = parseSpotifyPlaylistPreview(
			firstPreviewResponse.body,
			PLAYLIST_ID,
			signature
		)!;
		expect(firstPreviewResponse.response.status).toBe(200);
		expect(firstPreview).toMatchObject({
			addedCount: 3,
			removedCount: 0,
			retainedCount: 100,
			orderChanged: true,
			synchronized: false
		});
		expect(mutationCount()).toBe(0);

		const previousCompleted: CatalogPlaylistSyncRecord = {
			...syncRecord(),
			playlistId: PLAYLIST_ID,
			targetFingerprint: await fingerprintPlaylistSyncTarget(PLAYLIST_ID, {
				...target,
				tracks: oldTargetTracks
			}),
			totalTrackCount: oldTargetTracks.length,
			confirmedPosition: oldTargetTracks.length,
			phase: 'completed',
			mode: 'updated',
			startedAt: clock - 1,
			updatedAt: clock - 1,
			snapshotId
		};
		await saveCatalogPlaylistSync(previousCompleted, options);
		const nextOperation: CatalogPlaylistSyncRecord = {
			...previousCompleted,
			operationId: 'new_episode_update_operation',
			targetFingerprint: await fingerprintPlaylistSyncTarget(PLAYLIST_ID, target),
			totalTrackCount: targetTracks.length,
			confirmedPosition: 0,
			phase: 'interrupted',
			restartRequired: true,
			startedAt: clock,
			updatedAt: clock,
			snapshotId: undefined
		};
		const claimed = await claimCatalogPlaylistSyncLease(
			nextOperation,
			owner,
			clock,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		expect(claimed).toMatchObject({
			acquired: true,
			record: { playlistId: PLAYLIST_ID, mode: 'updated', confirmedPosition: 0 }
		});
		const confirmedPositions: number[] = [];
		const outcome = await runPlaylistSyncBatches({
			record: claimed.record!,
			target,
			previewFingerprint: firstPreview.previewFingerprint,
			request,
			now: () => clock,
			delay: async (milliseconds) => {
				clock += milliseconds;
			},
			persist: async (next) => {
				const release = ['completed', 'uncertain', 'blocked', 'interrupted', 'paused'].includes(
					next.phase
				);
				const saved = await claimCatalogPlaylistSyncLease(
					next,
					owner,
					clock,
					PLAYLIST_SYNC_LEASE_MS,
					options,
					release
				);
				expect(saved.acquired).toBe(true);
				confirmedPositions.push(saved.record!.confirmedPosition);
				return saved.record!;
			}
		});
		expect(outcome).toMatchObject({
			type: 'completed',
			record: {
				playlistId: PLAYLIST_ID,
				mode: 'updated',
				confirmedPosition: targetTracks.length
			}
		});
		expect(confirmedPositions).toContain(100);
		expect(items).toEqual(targetTracks);
		expect(new Set(items).size).toBe(items.length);
		expect(spotify.mock.calls.some(([url]) => String(url).endsWith('/v1/me/playlists'))).toBe(
			false
		);
		expect(
			spotify.mock.calls
				.filter(([, init]) => ['POST', 'PUT'].includes(init?.method ?? ''))
				.every(([url]) => String(url).includes(`/v1/playlists/${PLAYLIST_ID}`))
		).toBe(true);

		const restoredSync = await loadCatalogPlaylistSync('show', options);
		expect(restoredSync).toMatchObject({
			phase: 'completed',
			playlistId: PLAYLIST_ID,
			confirmedPosition: targetTracks.length,
			totalTrackCount: targetTracks.length
		});
		const restoredAfterSync = await loadCatalogProgress('show', options);
		expect(restoredAfterSync?.playlist.linkedPlaylistId).toBe(PLAYLIST_ID);
		expect(restoredAfterSync?.episodes.oldest.tracks).toEqual(originalReviews.oldest);
		expect(restoredAfterSync?.episodes.recent.tracks).toEqual(originalReviews.recent);

		const mutationsBeforeFinalPreview = mutationCount();
		const finalPreviewResponse = await request({
			operation: 'preview',
			playlistId: PLAYLIST_ID,
			...target
		});
		const finalPreview = parseSpotifyPlaylistPreview(
			finalPreviewResponse.body,
			PLAYLIST_ID,
			signature
		)!;
		expect(finalPreviewResponse.response.status).toBe(200);
		expect(finalPreview).toMatchObject({
			addedCount: 0,
			removedCount: 0,
			retainedCount: targetTracks.length,
			orderChanged: false,
			synchronized: true
		});
		expect(mutationCount()).toBe(mutationsBeforeFinalPreview);
	});

	it('shows one exact preview after 100/181 resume reaches 181 but settlement reads expire', async () => {
		const { factory, values } = memoryFactory();
		const options = { factory, timeoutMs: 100 };
		let clock = Date.now();
		const owner = 'current_document_123';
		const tracks = Array.from(
			{ length: 181 },
			(_, i) => 'spotify:track:' + String(i).padStart(22, '0')
		);
		const target = { name: 'Dimension Door', description: 'Full archive', public: false, tracks };
		const items = tracks.slice(0, 100);
		let snapshot = 's1';
		let stale = true;
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
		const spotify = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/v1/me')) return json({ id: 'fixture-user' });
			if (url.includes('/items?')) {
				const offset = Number(new URL(url).searchParams.get('offset'));
				return json({
					total: items.length,
					items: items.slice(offset, offset + 100).map((uri) => ({ item: { type: 'track', uri } }))
				});
			}
			if (url.includes('?fields='))
				return json({
					id: PLAYLIST_ID,
					owner: { id: 'fixture-user' },
					snapshot_id: stale ? 's1' : snapshot,
					name: target.name,
					description: target.description,
					public: false
				});
			if (url.endsWith('/items') && init?.method === 'POST') {
				items.push(...JSON.parse(String(init.body)).uris);
				snapshot = 's2';
				return json({ snapshot_id: snapshot });
			}
			throw new Error('Unexpected mutation or creation');
		});
		const endpoint = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			POST({
				request: new Request('http://localhost/api/spotify/playlist', init),
				fetch: spotify
			} as never)
		);
		const request = (body: unknown, signal?: AbortSignal) =>
			requestPlaylistJson(endpoint, body, signal);
		await saveCatalogProgress(
			captureCatalogProgress('show', [], {
				title: target.name,
				description: target.description,
				public: false,
				order: 'latest-first',
				linkedPlaylistId: PLAYLIST_ID
			}),
			options
		);
		const claimed = await claimCatalogPlaylistSyncLease(
			{
				...syncRecord(),
				totalTrackCount: 181,
				snapshotId: 's1',
				targetFingerprint: await fingerprintPlaylistSyncTarget(PLAYLIST_ID, target),
				startedAt: clock,
				updatedAt: clock
			},
			owner,
			clock,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		expect(claimed.record?.confirmedPosition).toBe(100);
		const persisted: CatalogPlaylistSyncRecord[] = [];
		const result = await runPlaylistSyncBatches({
			record: claimed.record!,
			target,
			request,
			now: () => clock,
			delay: async () => {
				clock += 31000;
			},
			persist: async (next) => {
				const saved = await claimCatalogPlaylistSyncLease(
					next,
					owner,
					clock,
					PLAYLIST_SYNC_LEASE_MS,
					options,
					next.phase === 'blocked'
				);
				expect(saved.acquired).toBe(true);
				persisted.push(saved.record!);
				return saved.record!;
			}
		});
		expect(
			persisted.some((record) => record.phase === 'settling' && record.confirmedPosition === 100)
		).toBe(true);
		expect(result.record).toMatchObject({
			phase: 'blocked',
			reason: 'external-change',
			confirmedPosition: 181,
			playlistId: PLAYLIST_ID
		});
		expect(items).toEqual(tracks);
		expect(spotify.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
		const storedBeforePreview = structuredClone([...values]);
		stale = false;
		const signature = createPlaylistPreviewInputSignature({
			playlistId: PLAYLIST_ID,
			title: target.name,
			...target
		});
		const guard = createPlaylistSyncPreviewGuard();
		for (let repeat = 0; repeat < 2; repeat++) {
			const ticket = guard.begin(signature, result.record);
			const callCount = spotify.mock.calls.length;
			const response = await request({ operation: 'preview', playlistId: PLAYLIST_ID, ...target });
			expect(response.response.status).toBe(200);
			const preview = parseSpotifyPlaylistPreview(response.body, PLAYLIST_ID, signature)!;
			expect(preview).toMatchObject({
				addedCount: 0,
				removedCount: 0,
				retainedCount: 181,
				synchronized: true
			});
			expect(guard.isCurrent(ticket, signature, result.record)).toBe(true);
			expect(
				playlistSyncFeedback(
					result.record,
					preview,
					signature,
					playlistSyncRecordStamp(result.record),
					owner,
					clock
				)
			).toEqual({
				historicalStatus: '',
				synchronizedStatus: 'Spotify playlist is already synchronized.'
			});
			expect(spotify.mock.calls.slice(callCount).every(([, init]) => !init?.method)).toBe(true);
			expect([...values]).toEqual(storedBeforePreview);
		}
		expect(spotify.mock.calls.some(([url]) => String(url).endsWith('/v1/me/playlists'))).toBe(
			false
		);
		expect(
			(values.get('show') as { playlist: { linkedPlaylistId: string } }).playlist.linkedPlaylistId
		).toBe(PLAYLIST_ID);
	});
	it.each([181, 1508])(
		'connects creation, durable ID, client, real endpoint and CAS for %i tracks with delayed settlement',
		async (count) => {
			const { factory, values } = memoryFactory(),
				options = { factory, timeoutMs: 100 };
			let clock = Date.now(),
				snapshot = 0,
				staleReads = 0,
				creates = 0;
			let items: string[] = [];
			const intended = {
				name: 'Dimension Door',
				description: 'Full archive',
				public: false,
				tracks: Array.from(
					{ length: count },
					(_, i) => 'spotify:track:' + String(i).padStart(22, '0')
				)
			};
			const writes: string[][] = [];
			const metricsBefore = getSpotifySessionMetrics();
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { 'Content-Type': 'application/json' }
				});
			const metadata = (s: number) => ({
				id: PLAYLIST_ID,
				owner: { id: 'fixture-user' },
				snapshot_id: 's' + s,
				name: intended.name,
				description: intended.description,
				public: false
			});
			const spotify = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith('/v1/me')) return json({ id: 'fixture-user' });
				if (url.endsWith('/v1/me/playlists')) {
					creates++;
					return json({ id: PLAYLIST_ID }, 201);
				}
				if (url.includes('/items?')) {
					const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
					return json({
						total: items.length,
						items: items
							.slice(offset, offset + 100)
							.map((uri) => ({ item: { type: 'track', uri, is_local: false }, is_local: false }))
					});
				}
				if (url.includes('?fields=')) return json(metadata(staleReads-- > 0 ? 0 : snapshot));
				if (url.endsWith('/items')) {
					expect(
						(values.get('show') as { playlist: { linkedPlaylistId: string } }).playlist
							.linkedPlaylistId
					).toBe(PLAYLIST_ID);
					const batch = JSON.parse(String(init?.body)).uris as string[];
					expect(batch.length).toBeLessThanOrEqual(100);
					writes.push(batch);
					if (init?.method === 'PUT') items = [...batch];
					else items.push(...batch);
					snapshot++;
					if (snapshot === 1) staleReads = 2;
					return json({ snapshot_id: 's' + snapshot });
				}
				return new Response(null);
			});
			const request = async (body: unknown) => {
				const response = await POST({
					request: new Request('http://localhost/api/spotify/playlist', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body)
					}),
					fetch: spotify
				} as never);
				return { response, body: await response.json() };
			};
			const created = await request({
				operation: 'create',
				name: intended.name,
				description: intended.description,
				public: false
			});
			await persistCreatedPlaylistBeforeSync(created.body, async (id) => {
				await saveCatalogProgress(
					captureCatalogProgress('show', [], {
						title: intended.name,
						description: intended.description,
						public: false,
						order: 'latest-first',
						linkedPlaylistId: id
					}),
					options
				);
				return true;
			});
			const candidate: CatalogPlaylistSyncRecord = {
				...syncRecord(),
				confirmedPosition: 0,
				snapshotId: undefined,
				totalTrackCount: count,
				targetFingerprint: await fingerprintPlaylistSyncTarget(PLAYLIST_ID, intended),
				phase: 'interrupted',
				restartRequired: true,
				startedAt: clock,
				updatedAt: clock
			};
			const owner = 'unique_document_12345';
			const claimed = await claimCatalogPlaylistSyncLease(
				candidate,
				owner,
				clock,
				PLAYLIST_SYNC_LEASE_MS,
				options
			);
			const previewFingerprint = fingerprintSpotifyPlaylistPreview(
				{
					playlistId: PLAYLIST_ID,
					snapshotId: 's0',
					name: intended.name,
					description: intended.description,
					public: false,
					items: []
				},
				intended
			);
			const outcome = await runPlaylistSyncBatches({
				record: claimed.record!,
				target: intended,
				previewFingerprint,
				request,
				now: () => clock,
				delay: async (ms) => {
					clock += ms;
				},
				persist: async (next) => {
					const release =
						['completed', 'uncertain', 'blocked', 'interrupted', 'paused'].includes(next.phase) ||
						(next.phase === 'settling' && Boolean(next.retryUntil));
					const saved = await claimCatalogPlaylistSyncLease(
						next,
						owner,
						clock,
						PLAYLIST_SYNC_LEASE_MS,
						options,
						release
					);
					if (!saved.acquired) throw new Error('CAS failed');
					return saved.record!;
				}
			});
			expect(outcome.type).toBe('completed');
			expect(creates).toBe(1);
			expect(writes).toHaveLength(Math.ceil(count / 100));
			expect(writes.flat()).toEqual(intended.tracks);
			expect(items).toEqual(intended.tracks);
			expect(await loadCatalogPlaylistSync('show', options)).toMatchObject({
				phase: 'completed',
				confirmedPosition: count
			});
			expect(getSpotifySessionMetrics()).toEqual(metricsBefore);
		}
	);
	it('rejects stale same-owner updates, stale releases and different operation identities', async () => {
		const { factory } = memoryFactory();
		const owner = 'document_owner_12345',
			options = { factory, timeoutMs: 100 };
		const first = await claimCatalogPlaylistSyncLease(
			syncRecord(),
			owner,
			100,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		const newer = await claimCatalogPlaylistSyncLease(
			first.record!,
			owner,
			101,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		expect(newer.record?.revision).toBe(2);
		for (const release of [false, true])
			expect(
				(
					await claimCatalogPlaylistSyncLease(
						first.record!,
						owner,
						102,
						PLAYLIST_SYNC_LEASE_MS,
						options,
						release
					)
				).acquired
			).toBe(false);
		expect(
			(
				await claimCatalogPlaylistSyncLease(
					{ ...newer.record!, operationId: 'different_operation_123' },
					owner,
					102,
					PLAYLIST_SYNC_LEASE_MS,
					options
				)
			).acquired
		).toBe(false);
		const released = await claimCatalogPlaylistSyncLease(
			{ ...newer.record!, phase: 'interrupted', leaseOwner: undefined, leaseUntil: undefined },
			owner,
			102,
			PLAYLIST_SYNC_LEASE_MS,
			options,
			true
		);
		expect(released.acquired).toBe(true);
		const replacement = await claimCatalogPlaylistSyncLease(
			released.record!,
			'replacement_owner_123',
			103,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		expect(replacement.acquired).toBe(true);
		expect(
			(
				await claimCatalogPlaylistSyncLease(
					released.record!,
					owner,
					104,
					PLAYLIST_SYNC_LEASE_MS,
					options,
					true
				)
			).acquired
		).toBe(false);
	});
	it('rotates identity only from a terminal operation and rejects the old operation afterward', async () => {
		const { factory } = memoryFactory();
		const options = { factory, timeoutMs: 100 };
		const owner = 'document_owner_12345';
		const first = await claimCatalogPlaylistSyncLease(
			syncRecord(),
			owner,
			100,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		const completed = await claimCatalogPlaylistSyncLease(
			{
				...first.record!,
				confirmedPosition: first.record!.totalTrackCount,
				phase: 'completed',
				leaseOwner: undefined,
				leaseUntil: undefined
			},
			owner,
			101,
			PLAYLIST_SYNC_LEASE_MS,
			options,
			true
		);
		const next = await claimCatalogPlaylistSyncLease(
			{
				...completed.record!,
				operationId: 'replacement_operation_123',
				confirmedPosition: 0,
				phase: 'interrupted',
				restartRequired: true,
				snapshotId: undefined,
				startedAt: 102,
				updatedAt: 102
			},
			'replacement_owner_123',
			102,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);

		expect(next.acquired).toBe(true);
		expect(next.record?.operationId).toBe('replacement_operation_123');
		expect(
			(
				await claimCatalogPlaylistSyncLease(
					completed.record!,
					owner,
					103,
					PLAYLIST_SYNC_LEASE_MS,
					options
				)
			).acquired
		).toBe(false);
	});
	it('rolls back a failed IDB write and permits the next correct CAS', async () => {
		const { factory, control } = memoryFactory(),
			options = { factory, timeoutMs: 100 },
			owner = 'document_owner_12345';
		const first = await claimCatalogPlaylistSyncLease(
			syncRecord(),
			owner,
			100,
			PLAYLIST_SYNC_LEASE_MS,
			options
		);
		control.failNextWrite = true;
		await expect(
			claimCatalogPlaylistSyncLease(first.record!, owner, 101, PLAYLIST_SYNC_LEASE_MS, options)
		).rejects.toBeDefined();
		expect((await loadCatalogPlaylistSync('show', options))?.revision).toBe(1);
		expect(
			(
				await claimCatalogPlaylistSyncLease(
					first.record!,
					owner,
					102,
					PLAYLIST_SYNC_LEASE_MS,
					options
				)
			).record?.revision
		).toBe(2);
		expect(control.closed).toBe(4);
	});
	it('does not overwrite an attacker-edited existing lock', async () => {
		const { factory, values } = memoryFactory();
		values.set('\u0000playlist-sync:show', {
			showAlias: '\u0000playlist-sync:show',
			leaseUntil: Number.MAX_VALUE
		});
		expect(
			(
				await claimCatalogPlaylistSyncLease(
					syncRecord(),
					'document_owner_12345',
					100,
					PLAYLIST_SYNC_LEASE_MS,
					{ factory, timeoutMs: 100 }
				)
			).acquired
		).toBe(false);
	});
	it('stores and loads a defensive validated copy in the existing database', async () => {
		const { factory } = memoryFactory();
		const source = syncRecord();
		await saveCatalogPlaylistSync(source, { factory, timeoutMs: 100 });
		source.confirmedPosition = 999;
		const loaded = await loadCatalogPlaylistSync('show', { factory, timeoutMs: 100 });
		expect(loaded?.confirmedPosition).toBe(100);
		if (loaded) loaded.confirmedPosition = 500;
		expect(
			(await loadCatalogPlaylistSync('show', { factory, timeoutMs: 100 }))?.confirmedPosition
		).toBe(100);
	});

	it('atomically fails closed when another tab owns the unexpired per-show lease', async () => {
		const { factory } = memoryFactory();
		const first = await claimCatalogPlaylistSyncLease(
			syncRecord(),
			'first_tab_123456789',
			100,
			PLAYLIST_SYNC_LEASE_MS,
			{ factory, timeoutMs: 100 }
		);
		const second = await claimCatalogPlaylistSyncLease(
			syncRecord(),
			'second_tab_12345678',
			101,
			PLAYLIST_SYNC_LEASE_MS,
			{ factory, timeoutMs: 100 }
		);
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(false);
		expect(second.record?.leaseOwner).toBe('first_tab_123456789');
	});

	it('keeps leases for different catalogues independent', async () => {
		const { factory } = memoryFactory();
		const [first, second] = await Promise.all([
			claimCatalogPlaylistSyncLease(
				syncRecord('one'),
				'first_tab_123456789',
				100,
				PLAYLIST_SYNC_LEASE_MS,
				{ factory, timeoutMs: 100 }
			),
			claimCatalogPlaylistSyncLease(
				syncRecord('two'),
				'second_tab_12345678',
				100,
				PLAYLIST_SYNC_LEASE_MS,
				{ factory, timeoutMs: 100 }
			)
		]);
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(true);
	});

	it('does not expose internal synchronization records as dashboard catalogues', async () => {
		const { factory } = memoryFactory();
		await saveCatalogPlaylistSync(syncRecord(), { factory, timeoutMs: 100 });
		expect(await listCatalogProgress({ factory, timeoutMs: 100 })).toEqual({
			records: [],
			skippedCount: 0
		});
	});

	it('reset deletes the catalogue and its local synchronization record together', async () => {
		const { factory, values } = memoryFactory();
		await saveCatalogPlaylistSync(syncRecord(), { factory, timeoutMs: 100 });
		values.set('show', { showAlias: 'show' });
		await deleteCatalogProgress('show', { factory, timeoutMs: 100 });
		expect(values.size).toBe(0);
	});
});
