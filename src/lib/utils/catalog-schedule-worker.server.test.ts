import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: { NTS_FIRESTORE_PROJECT: 'test-project-123', NTS_CATALOG_SCHEDULES: '1' }
}));
vi.mock('./hosted-access.server', () => ({ hostedConfiguration: () => ({ userId: 'owner' }) }));
import { fakeFirestore } from '../test-helpers/firestore';
import { ScheduleStore } from './catalog-schedule-store.server';
import { loadCloudProgress, saveCloudProgress, CloudProgressError } from './catalog-cloud.server';
import {
	runScheduledScan,
	type ScheduleWorkerDependencies
} from './catalog-schedule-worker.server';
import { SpotifyRateLimitError } from './spotify.server';
import {
	createGeneratedPlaylistText,
	type CatalogProgress,
	type EpisodeState
} from './catalog-scan';
import type { CatalogSchedule } from './catalog-schedule';

const episode = (index: number): EpisodeState => ({
	episodeAlias: `episode-${index}`,
	name: `Episode ${index}`,
	broadcast: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
	cover: '',
	genres: [],
	status: 'pending',
	tracks: []
});
async function fixture(count = 2) {
	const f = fakeFirestore();
	const store = new ScheduleStore(f.request);
	let now = Date.now();
	let searches = 0;
	const progress: CatalogProgress = {
		schemaVersion: 2,
		matcherVersion: 1,
		showAlias: 'channeling',
		updatedAt: now,
		episodes: Object.fromEntries(
			Array.from({ length: count }, (_, i) => [episode(i).episodeAlias, episode(i)])
		),
		playlist: {
			title: 'My custom title',
			description: 'Keep this',
			public: false,
			order: 'latest-first'
		},
		display: { showName: 'Channeling' }
	};
	await saveCloudProgress('channeling', progress, null, f.request);
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
	const controller = new AbortController();
	const deps: ScheduleWorkerDependencies = {
		store,
		now: () => now,
		signal: controller.signal,
		load: (show) => loadCloudProgress(show, f.request),
		save: (show, p, v) => saveCloudProgress(show, p, v, f.request),
		catalog: vi.fn(async () => ({
			showAlias: 'channeling',
			name: 'Channeling',
			description: '',
			cover: '',
			episodes: Object.values(progress.episodes)
		})),
		match: vi.fn(async () => {
			searches += 2;
			return [];
		}),
		searchCount: () => searches
	};
	return {
		...f,
		store,
		deps,
		progress,
		controller,
		advance: (ms: number) => {
			now += ms;
			vi.spyOn(Date, 'now').mockReturnValue(now);
		},
		load: () => loadCloudProgress('channeling', f.request)
	};
}
describe('unattended catalogue batches', () => {
	it('saves repaired date metadata without discovering new episodes or issuing a new-episode notification', async () => {
		const f = await fixture(2);
		const copy = (await f.load())!;
		for (const item of Object.values(copy.progress.episodes)) item.status = 'done';
		const episodes = Object.values(copy.progress.episodes);
		const stale = createGeneratedPlaylistText('Channeling', [episodes[0]], 'latest-first');
		copy.progress.playlist.title = stale.title;
		copy.progress.playlist.description = stale.description;
		await f.deps.save('channeling', copy.progress, copy.version);
		f.deps.notify = vi.fn(async () => {});
		await runScheduledScan(f.deps);
		const repaired = (await f.load())!.progress;
		const expected = createGeneratedPlaylistText('Channeling', episodes, 'latest-first');
		expect(repaired.playlist.title).toBe(expected.title);
		expect(repaired.playlist.description).toBe(expected.description);
		expect(repaired.episodes).toEqual(copy.progress.episodes);
		expect(f.deps.match).not.toHaveBeenCalled();
		expect(f.deps.notify).not.toHaveBeenCalledWith(
			'new-episodes',
			expect.anything(),
			expect.anything()
		);
	});

	it('runs the playlist boundary only after saved matching releases the scan lease', async () => {
		const f = await fixture(1);
		const notifications = vi.fn(async () => {});
		f.deps.notify = notifications;
		f.deps.afterBatch = vi.fn(async (show) => {
			expect(show).toBe('channeling');
			expect((await f.load())!.progress.episodes['episode-0'].status).toBe('done');
			const claim = await f.store.acquire('playlist');
			expect(claim.lease).toBeDefined();
			await f.store.release(claim.lease!.id);
			return undefined;
		});
		await runScheduledScan(f.deps);
		expect(f.deps.afterBatch).toHaveBeenCalledTimes(1);
		expect(notifications).toHaveBeenCalledWith('matches-ready', 'channeling', ['episode-0']);
	});
	it('does not enter the playlist boundary after a matching failure or cooldown', async () => {
		const f = await fixture(1);
		f.deps.afterBatch = vi.fn();
		f.deps.match = async () => {
			throw new SpotifyRateLimitError(30785);
		};
		await runScheduledScan(f.deps);
		expect(f.deps.afterBatch).not.toHaveBeenCalled();
	});
	it('saves only confident new choices while leaving uncertain candidates for review', async () => {
		const f = await fixture(1);
		f.deps.match = async () =>
			[true, false].map((confident, i) => ({
				artist: 'Fixture',
				title: `Track ${i}`,
				confident,
				fallback: !confident,
				matches: [
					{
						artist: 'Fixture',
						title: `Track ${i}`,
						uri: `spotify:track:${String(i).padStart(22, '0')}`,
						href: `https://open.spotify.com/track/${String(i).padStart(22, '0')}`
					}
				]
			}));
		await runScheduledScan(f.deps);
		expect((await f.load())!.progress.episodes['episode-0'].tracks.map((t) => t.checked)).toEqual([
			true,
			false
		]);
	});
	afterEach(() => vi.restoreAllMocks());
	it('is opt-in and does no progress/NTS/Spotify work when disabled or not due', async () => {
		const f = await fixture();
		const record = (await f.store.getSchedule('channeling'))!;
		await f.store.putSchedule({ ...record.value, enabled: false }, record.version);
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'idle', scanned: 0 });
		expect(f.deps.match).not.toHaveBeenCalled();
		expect(f.deps.catalog).not.toHaveBeenCalled();
	});
	it('check frequency is independent of unfinished backlog; limits batches to five', async () => {
		const f = await fixture(7);
		const result = await runScheduledScan(f.deps);
		expect(result).toEqual({ status: 'waiting', scanned: 5 });
		let stored = (await f.store.getSchedule('channeling'))!.value;
		expect(stored.lastSearches).toBe(10);
		expect(stored.nextCheckAt).toBeGreaterThan(stored.nextRunAt);
		f.advance(60 * 60_000 + 1);
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'complete', scanned: 2 });
		expect(f.deps.catalog).toHaveBeenCalledTimes(1);
		stored = (await f.store.getSchedule('channeling'))!.value;
		expect(stored.nextRunAt).toBe(stored.nextCheckAt);
		expect((await f.load())!.progress.playlist).toEqual(f.progress.playlist);
	});
	it('discovers new episodes without deleting archived episodes or custom playlist text', async () => {
		const f = await fixture(1);
		f.deps.catalog = async () => ({
			showAlias: 'channeling',
			name: 'Channeling',
			description: '',
			cover: '',
			episodes: [episode(4)]
		});
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'complete', scanned: 2 });
		const progress = (await f.load())!.progress;
		expect(Object.keys(progress.episodes)).toEqual(['episode-0', 'episode-4']);
		expect(progress.playlist).toEqual(f.progress.playlist);
	});
	it('saves each success before a quota pause and shares cooldown across fresh instances', async () => {
		const f = await fixture(3);
		let calls = 0;
		f.deps.match = async () => {
			if (++calls === 2) throw new SpotifyRateLimitError(86400, 'quota-exceeded');
			return [];
		};
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'cooldown', scanned: 1 });
		const progress = (await f.load())!.progress;
		expect(progress.episodes['episode-0'].status).toBe('done');
		expect(progress.episodes['episode-1'].status).toBe('pending');
		expect(progress.retry!.cooldownUntil).toBe(f.deps.now() + 86400_000);
		expect((await new ScheduleStore(f.request).acquire('manual', f.deps.now())).cooldownUntil).toBe(
			progress.retry!.cooldownUntil
		);
	});
	it('imports a previously saved cooldown without querying NTS or Spotify', async () => {
		const f = await fixture();
		const copy = (await f.load())!;
		copy.progress.retry = { cooldownUntil: f.deps.now() + 10_000, pausedByRateLimit: true };
		await f.deps.save('channeling', copy.progress, copy.version);
		expect((await runScheduledScan(f.deps)).status).toBe('cooldown');
		expect(f.deps.match).not.toHaveBeenCalled();
		expect(f.deps.catalog).not.toHaveBeenCalled();
	});
	it('retries a failed episode and preserves the normal confidence-based review defaults', async () => {
		const f = await fixture(1);
		const copy = (await f.load())!;
		copy.progress.episodes['episode-0'].status = 'error';
		copy.progress.episodes['episode-0'].error = 'Previous transient failure';
		await f.deps.save('channeling', copy.progress, copy.version);
		const match = {
			uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
			artist: 'Artist',
			title: 'Title',
			href: 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA'
		};
		f.deps.match = async () => [
			{ artist: 'Artist', title: 'Title', matches: [match], confident: true, fallback: false },
			{ artist: 'Artist', title: 'Uncertain', matches: [match], confident: false, fallback: true }
		];
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'complete', scanned: 1 });
		const saved = (await f.load())!.progress.episodes['episode-0'];
		expect(saved.status).toBe('done');
		expect(saved.error).toBeUndefined();
		expect(saved.tracks.map((t) => t.checked)).toEqual([true, false]);
		expect(saved.tracks.map((t) => t.selectedMatch)).toEqual([match.uri, match.uri]);
	});
	it('leaves unfinished episodes retryable after a transient failure and releases the lease', async () => {
		const f = await fixture();
		f.deps.match = async () => {
			throw new Error('private upstream details');
		};
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'unavailable', scanned: 0 });
		expect((await f.load())!.progress.episodes['episode-0'].status).toBe('pending');
		expect((await f.store.acquire('manual', f.deps.now())).lease).toBeDefined();
	});
	it('does not spend searches while a manual scan holds the lease', async () => {
		const f = await fixture();
		await f.store.acquire('manual', f.deps.now());
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'busy', scanned: 0 });
		expect(f.deps.match).not.toHaveBeenCalled();
	});
	it('keeps edits to another episode and playlist settings made during matching', async () => {
		const f = await fixture(2);
		f.deps.match = async () => {
			const copy = (await f.load())!;
			copy.progress.episodes['episode-1'].status = 'done';
			copy.progress.playlist.title = 'Edited while scanning';
			await f.deps.save('channeling', copy.progress, copy.version);
			return [];
		};
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'complete', scanned: 1 });
		expect((await f.load())!.progress.playlist.title).toBe('Edited while scanning');
	});
	it('stops rather than overwrite an edit to the episode being matched', async () => {
		const f = await fixture();
		f.deps.match = async () => {
			const copy = (await f.load())!;
			copy.progress.episodes['episode-0'].status = 'done';
			await f.deps.save('channeling', copy.progress, copy.version);
			return [];
		};
		expect(await runScheduledScan(f.deps)).toEqual({ status: 'conflict', scanned: 0 });
		expect((await f.load())!.progress.episodes['episode-0'].status).toBe('done');
	});
	it('honors pause during a run and preserves the new schedule settings', async () => {
		const f = await fixture();
		f.deps.match = async () => {
			const r = (await f.store.getSchedule('channeling'))!;
			await f.store.putSchedule({ ...r.value, enabled: false }, r.version);
			return [];
		};
		expect((await runScheduledScan(f.deps)).status).toBe('conflict');
		expect((await f.store.getSchedule('channeling'))!.value.enabled).toBe(false);
		expect((await f.load())!.progress.episodes['episode-0'].status).toBe('pending');
	});
	it('fences an expired lease and a cancelled request before cloud writes', async () => {
		for (const cancel of [false, true]) {
			const f = await fixture();
			f.deps.match = async () => {
				if (cancel) f.controller.abort();
				else f.advance(5 * 60_000);
				return [];
			};
			expect((await runScheduledScan(f.deps)).status).toBe('conflict');
			expect((await f.load())!.progress.episodes['episode-0'].status).toBe('pending');
		}
	});
	it('does not overwrite a newer cloud version if compare-and-swap fails', async () => {
		const f = await fixture();
		f.deps.save = async () => {
			throw new CloudProgressError('conflict');
		};
		expect((await runScheduledScan(f.deps)).status).toBe('conflict');
		expect((await f.load())!.progress.episodes['episode-0'].status).toBe('pending');
	});
});
