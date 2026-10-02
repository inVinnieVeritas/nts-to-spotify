import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({
	env: {
		NTS_FIRESTORE_PROJECT: 'test-project-123',
		NTS_CATALOG_SCHEDULES: '1',
		NTS_PLAYLIST_AUTH_KEY: 'a'.repeat(64),
		SPOTIFY_CLIENT_ID: 'dummy',
		SPOTIFY_CLIENT_SECRET: 'dummy'
	}
}));
vi.mock('./hosted-access.server', () => ({
	hostedConfiguration: () => ({
		userId: 'owner',
		origin: 'https://nts2spotify.vincentvanderveken.com'
	}),
	hasHostedSession: () => true
}));
vi.mock('./auth.server', () => ({
	getAccessToken: async () => 'dummy-access',
	rotateAccessToken: vi.fn(async () => ({ accessToken: 'dummy-access', expiresIn: 3600 }))
}));
import { fakeFirestore } from '../test-helpers/firestore';
import { ScheduleStore } from './catalog-schedule-store.server';
import {
	AutomaticPlaylistService,
	publicAutomaticPlaylistState
} from './catalog-playlist-automation.server';
import {
	PlaylistAuthorization,
	BackgroundAuthorizationError
} from './playlist-authorization.server';
import { automaticPlaylistTarget } from './catalog-playlist-automation';
import { POST } from '../../routes/api/spotify/playlist/+server';
import { getSpotifySessionMetrics } from './spotify.server';
import { loadCloudProgress, saveCloudProgress } from './catalog-cloud.server';
import { runScheduledScan } from './catalog-schedule-worker.server';
import { runPlaylistSyncBatches, fingerprintPlaylistSyncTarget } from './playlist-sync.client';
import type { CatalogProgress, EpisodeState, ReviewTrack } from './catalog-scan';

const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV';
const uri = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;
const track = (n: number, checked = true, confident = true): ReviewTrack => ({
	artist: 'Fixture',
	title: `Track ${n}`,
	matches: [
		{
			artist: 'Fixture',
			title: `Track ${n}`,
			uri: uri(n),
			href: `https://open.spotify.com/track/${String(n).padStart(22, '0')}`
		}
	],
	checked,
	confident,
	fallback: false,
	selectedMatch: uri(n)
});
const episode = (n: number, tracks: ReviewTrack[]): EpisodeState => ({
	episodeAlias: `episode-${n}`,
	name: `Episode ${n}`,
	broadcast: new Date(Date.UTC(2026, 0, n)).toISOString(),
	cover: '',
	genres: [],
	status: 'done',
	tracks
});
async function fixture() {
	const fs = fakeFirestore();
	let clock = Date.now();
	const now = () => clock;
	let version = 'v1';
	let progress: CatalogProgress = {
		schemaVersion: 2,
		matcherVersion: 1,
		showAlias: 'dimension-door',
		updatedAt: clock,
		episodes: { 'episode-1': episode(1, [track(1)]) },
		playlist: {
			title: 'Fixture playlist',
			description: 'Fixture',
			public: false,
			order: 'latest-first',
			linkedPlaylistId: playlistId
		}
	};
	let items = [uri(1)];
	let snapshot = 'initial';
	let sequence = 0;
	let stale = 0;
	let override: ((url: string, init?: RequestInit) => Response | undefined) | undefined;
	const requests: { url: string; method: string; body?: unknown }[] = [];
	const request: typeof fetch = async (input, init) => {
		const url = String(input);
		if (!url.startsWith('https://api.spotify.com')) return fs.request(input, init);
		requests.push({
			url,
			method: init?.method ?? 'GET',
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
		});
		const injected = override?.(url, init);
		if (injected) return injected;
		if (url.endsWith('/me')) return Response.json({ id: 'owner' });
		if (url.includes('/items?')) {
			const offset = Number(new URL(url).searchParams.get('offset'));
			return Response.json({
				total: items.length,
				items: items.slice(offset, offset + 100).map((uri) => ({ item: { type: 'track', uri } }))
			});
		}
		if (url.endsWith('/items')) {
			const body = JSON.parse(String(init?.body));
			items = init?.method === 'PUT' ? body.uris : [...items, ...body.uris];
			snapshot = `snapshot-${++sequence}`;
			return Response.json({ snapshot_id: snapshot });
		}
		if (init?.method === 'PUT') return new Response(null, { status: 200 });
		const observed = stale > 0 ? (stale--, 'old-snapshot') : snapshot;
		return Response.json({
			id: playlistId,
			owner: { id: 'owner' },
			snapshot_id: observed,
			name: progress.playlist.title,
			description: progress.playlist.description,
			public: progress.playlist.public
		});
	};
	const store = new ScheduleStore(request);
	const auth = new PlaylistAuthorization(store, request);
	await auth.connect('dummy-access', 'dummy-refresh');
	const load = async () => ({ progress: structuredClone(progress), version });
	const service = new AutomaticPlaylistService(
		store,
		request,
		auth,
		now,
		load,
		async () => {},
		async () => version
	);
	const signal = new AbortController().signal;
	return {
		fs,
		request,
		requests,
		store,
		auth,
		service,
		signal,
		get progress() {
			return progress;
		},
		async enable() {
			await service.configure('dimension-door', true, true, signal);
			requests.length = 0;
		},
		change(tracks: ReviewTrack[] = [track(2), track(1), track(3, false, false)]) {
			progress = {
				...progress,
				episodes: { ...progress.episodes, 'episode-2': episode(2, tracks) }
			};
			version += 'x';
		},
		advance(ms: number) {
			clock += ms;
			vi.spyOn(Date, 'now').mockImplementation(now);
		},
		setStale(n: number) {
			stale = n;
		},
		setOverride(fn: typeof override) {
			override = fn;
		},
		external() {
			items.push(uri(99));
			snapshot = 'external';
		},
		get items() {
			return items;
		},
		state: async () => (await service.get('dimension-door'))!.value,
		writes: () => requests.filter((r) => r.method !== 'GET')
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe('opt-in automatic linked playlist updates', () => {
	it('spans scheduled matching, real cloud persistence and the shared Spotify endpoint', async () => {
		const f = await fixture();
		await f.enable();
		f.change([]);
		f.progress.episodes['episode-2'].status = 'pending';
		await saveCloudProgress('dimension-door', f.progress, null, f.request);
		await f.store.putSchedule(
			{
				showAlias: 'dimension-door',
				enabled: true,
				frequency: 'fortnightly',
				nextRunAt: Date.now(),
				nextCheckAt: Date.now() + 86400_000,
				updatedAt: Date.now(),
				lastRunAt: 0,
				lastStatus: 'waiting',
				lastScanned: 0,
				lastSearches: 0
			},
			null
		);
		const playlists = new AutomaticPlaylistService(
			f.store,
			f.request,
			f.auth,
			Date.now,
			(show) => loadCloudProgress(show, f.request),
			async () => {}
		);
		const result = await runScheduledScan({
			store: f.store,
			load: (show) => loadCloudProgress(show, f.request),
			save: (show, p, v) => saveCloudProgress(show, p, v, f.request),
			catalog: async () => {
				throw new Error('Discovery not due');
			},
			match: async () => [track(2), track(3, false, false)],
			searchCount: () => 0,
			now: Date.now,
			signal: f.signal,
			afterBatch: async (show, signal) => {
				await playlists.run(show, signal);
				return undefined;
			}
		});
		expect(result).toEqual({ status: 'complete', scanned: 1 });
		expect(f.items).toEqual([uri(2), uri(1)]);
		const saved = (await loadCloudProgress('dimension-door', f.request))!.progress;
		expect(saved.episodes['episode-1']).toEqual(f.progress.episodes['episode-1']);
		expect(saved.episodes['episode-2'].tracks.map((t) => t.checked)).toEqual([true, false]);
		expect(saved.playlist.linkedPlaylistId).toBe(playlistId);
		expect(f.requests.some((r) => r.url.endsWith('/me/playlists'))).toBe(false);
	});
	it('a coordination rejection is busy, not an ambiguous mutation or external change', async () => {
		const f = await fixture();
		await f.enable();
		f.requests.length = 0;
		const claim = await f.store.acquire('scheduled');
		const response = await POST({
			fetch: f.request,
			request: new Request('https://nts2spotify.vincentvanderveken.com/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'preview',
					playlistId,
					...automaticPlaylistTarget(f.progress)
				})
			})
		} as Parameters<typeof POST>[0]);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'playlist_busy' });
		expect(f.requests).toEqual([]);
		await f.store.release(claim.lease!.id);
		const target = automaticPlaylistTarget(f.progress);
		const result = await runPlaylistSyncBatches({
			target,
			record: {
				version: 1,
				revision: 0,
				catalogueAlias: 'dimension-door',
				operationId: 'operation_1234567890',
				playlistId,
				targetFingerprint: await fingerprintPlaylistSyncTarget(playlistId, target),
				totalTrackCount: 1,
				confirmedPosition: 0,
				phase: 'ready',
				mode: 'updated',
				startedAt: Date.now(),
				updatedAt: Date.now()
			},
			previewFingerprint: 'a'.repeat(64),
			persist: async () => {},
			request: async () => ({
				response: new Response(null, { status: 409 }),
				body: { error: 'playlist_busy' }
			})
		});
		expect(result.record.phase).toBe('interrupted');
		expect(result.record.reason).toBe('unavailable');
	});
	it('defaults off and makes no Spotify calls for disabled or unchanged targets', async () => {
		const f = await fixture();
		f.requests.length = 0;
		await f.service.run('dimension-door', f.signal);
		expect(f.requests).toEqual([]);
		await f.enable();
		await f.service.run('dimension-door', f.signal);
		expect(f.requests).toEqual([]);
	});
	it('requires linkage and explicit app-created confirmation; enabling is read-only', async () => {
		const f = await fixture();
		await expect(f.service.configure('dimension-door', true, false, f.signal)).rejects.toThrow();
		await f.enable();
		expect(f.writes()).toEqual([]);
		delete f.progress.playlist.linkedPlaylistId;
		await expect(f.service.configure('dimension-door', true, true, f.signal)).rejects.toThrow();
	});
	it('uses the same playlist, newest first, deduplication, and preserves uncertain/manual choices', async () => {
		const f = await fixture();
		await f.enable();
		f.change([
			track(2),
			track(1),
			track(3, false, false),
			track(4, true, false),
			track(5, false, true)
		]);
		const before = structuredClone(f.progress);
		const metrics = getSpotifySessionMetrics();
		await f.service.run('dimension-door', f.signal);
		expect(f.items).toEqual([uri(2), uri(1), uri(4)]);
		expect(f.progress).toEqual(before);
		expect(f.requests.some((r) => r.url.endsWith('/me/playlists'))).toBe(false);
		expect(f.writes().map((r) => r.method)).toEqual(['PUT', 'PUT']);
		expect((await f.state()).status).toBe('updated');
		expect((await f.state()).added).toBe(2);
		expect(getSpotifySessionMetrics()).toEqual(metrics);
		f.requests.length = 0;
		await f.service.run('dimension-door', f.signal);
		expect(f.requests).toEqual([]);
	});
	it('keeps oldest-first and within-episode ordering', async () => {
		const f = await fixture();
		f.progress.playlist.order = 'oldest-first';
		await f.enable();
		f.change([track(3), track(2), track(1)]);
		await f.service.run('dimension-door', f.signal);
		expect(f.items).toEqual([uri(1), uri(3), uri(2)]);
	});
	it('settles an acknowledged 100/181 prefix and resumes append without replacement', async () => {
		const f = await fixture();
		await f.enable();
		f.change(Array.from({ length: 181 }, (_, i) => track(i + 1)));
		let writes = 0;
		f.setOverride((_url, init) => {
			if (init?.method === 'PUT' && _url.endsWith('/items') && ++writes === 1) f.setStale(3);
			return undefined;
		});
		await f.service.run('dimension-door', f.signal);
		expect(f.items).toHaveLength(100);
		expect((await f.state()).status).toBe('settling');
		// Pending work must not be reported as the last completed update.
		expect((await f.state()).added).toBe(0);
		expect((await f.state()).lastUpdatedAt).toBe(0);
		f.advance(6000);
		f.setStale(0);
		f.setOverride(undefined);
		await f.service.run('dimension-door', f.signal);
		expect(f.items).toEqual(Array.from({ length: 181 }, (_, i) => uri(i + 1)));
		expect((await f.state()).added).toBe(180);
		expect((await f.state()).lastUpdatedAt).toBeGreaterThan(0);
		expect(
			f
				.writes()
				.filter((r) => r.url.endsWith('/items'))
				.map((r) => r.method)
		).toEqual(['PUT', 'POST']);
	});
	it('completes 1,508 tracks in 100-item batches with exact order', async () => {
		const f = await fixture();
		await f.enable();
		f.change(Array.from({ length: 1508 }, (_, i) => track(i + 1)));
		await f.service.run('dimension-door', f.signal);
		expect(f.items).toEqual(Array.from({ length: 1508 }, (_, i) => uri(i + 1)));
		const batches = f.writes().filter((r) => r.url.endsWith('/items'));
		expect(batches).toHaveLength(16);
		expect(batches.map((r) => (r.body as { uris: string[] }).uris.length)).toEqual([
			...Array(15).fill(100),
			8
		]);
	});
	it('pauses for revoked authorization and does not damage progress', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		await f.auth.disconnect();
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).status).toBe('authentication');
		expect(f.writes()).toEqual([]);
		expect(f.progress.episodes['episode-1'].status).toBe('done');
	});
	it('honors durable cooldown without refreshing or reading Spotify', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		await f.store.cooldown(30785, 'quota-exceeded');
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).status).toBe('cooldown');
		expect(f.requests).toEqual([]);
	});
	it('persists a new 429 cooldown and leaves the target retryable without mutation', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		f.setOverride(() => new Response(null, { status: 429, headers: { 'Retry-After': '30785' } }));
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).status).toBe('cooldown');
		expect(f.writes()).toEqual([]);
		expect((await f.store.acquire('scheduled')).cooldownUntil).toBeGreaterThan(Date.now());
	});
	it('detects external edits and disables automatic writes', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		f.external();
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).status).toBe('external-change');
		expect(f.writes()).toEqual([]);
	});
	it('quarantines an ambiguous mutation across a new service instance and never re-appends', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		f.setOverride((url, init) =>
			url.endsWith('/items') && init?.method === 'PUT'
				? new Response(null, { status: 503 })
				: undefined
		);
		await f.service.run('dimension-door', f.signal);
		const state = await f.state();
		expect(state.sync?.phase).toBe('uncertain');
		expect(state.status).toBe('uncertain');
		f.requests.length = 0;
		await f.service.run('dimension-door', f.signal);
		expect(f.requests).toEqual([]);
		f.advance(6 * 60_000);
		f.setOverride(undefined);
		await f.service.run('dimension-door', f.signal);
		expect(f.writes()).toEqual([]);
		expect((await f.state()).sync?.reason).toBe('uncertain');
	});
	it('excludes simultaneous manual scans/writes and honors a disabled setting', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		const lease = await f.store.acquire('manual');
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).status).toBe('busy');
		expect(f.requests).toEqual([]);
		await f.store.release(lease.lease!.id);
		await f.service.configure('dimension-door', false, false, f.signal);
		await f.service.run('dimension-door', f.signal);
		expect(f.requests).toEqual([]);
	});
	it('later manual additions update the same playlist and advance the automatic baseline', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		await f.service.run('dimension-door', f.signal);
		f.progress.episodes['episode-2'].tracks[2].checked = true;
		const target = automaticPlaylistTarget(f.progress);
		const preview = await f.service.execute(
			{ operation: 'preview', playlistId, ...target },
			'dummy-access',
			f.signal
		);
		const event = {
			fetch: f.request,
			request: new Request('https://nts2spotify.vincentvanderveken.com/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'apply-batch',
					playlistId,
					previewFingerprint: preview.body.previewFingerprint,
					...target
				})
			})
		} as Parameters<typeof POST>[0];
		expect((await POST(event)).status).toBe(200);
		expect(f.items).toEqual([uri(2), uri(1), uri(3)]);
		f.advance(6 * 60_000);
		const count = f.writes().length;
		await f.service.run('dimension-door', f.signal);
		expect(f.writes()).toHaveLength(count);
		expect((await f.state()).status).toBe('unchanged');
	});
	it('public status omits tokens, targets, lease data and recovery diagnostics', async () => {
		const f = await fixture();
		await f.enable();
		const publicState = publicAutomaticPlaylistState(await f.state());
		expect(Object.keys(publicState).sort()).toEqual([
			'added',
			'awaitingReview',
			'enabled',
			'lastUpdatedAt',
			'playlistId',
			'retryUntil',
			'status'
		]);
		expect(JSON.stringify([...f.fs.documents.values()])).not.toContain('dummy-refresh');
	});
	it('rejects mismatched owner even with a valid token', async () => {
		const f = await fixture();
		f.setOverride((url) =>
			url.endsWith('/me') ? Response.json({ id: 'other-owner' }) : undefined
		);
		await expect(f.auth.connect('dummy-access', 'dummy-refresh')).rejects.toBeInstanceOf(
			BackgroundAuthorizationError
		);
		const response = await f.service.execute(
			{ operation: 'verify', playlistId },
			'dummy-access',
			f.signal
		);
		expect(response.response.status).toBe(403);
		expect(f.writes()).toEqual([]);
	});
	it('never creates a playlist during read-only preview', async () => {
		const f = await fixture();
		f.requests.length = 0;
		await f.service.execute(
			{ operation: 'preview', playlistId, ...automaticPlaylistTarget(f.progress) },
			'dummy-access',
			f.signal
		);
		expect(f.writes()).toEqual([]);
	});
	it('preserves a dispatch fence when acknowledgement persistence fails', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		const original = f.store.putAutomation.bind(f.store);
		let failures = 0;
		vi.spyOn(f.store, 'putAutomation').mockImplementation(async (id, value, version) => {
			const sync = (value as { sync?: { phase: string } }).sync;
			if (
				id === 'playlist-dimension-door' &&
				(sync?.phase === 'settling' || sync?.phase === 'uncertain') &&
				failures++ < 2
			)
				throw new Error('fixture storage unavailable');
			return original(id, value, version);
		});
		await f.service.run('dimension-door', f.signal);
		expect((await f.state()).sync?.phase).toBe('dispatching');
		f.requests.length = 0;
		f.advance(6 * 60_000);
		await f.service.run('dimension-door', f.signal);
		expect(f.writes()).toEqual([]);
		expect((await f.state()).sync?.reason).toBe('uncertain');
	});
	it('pause never removes an ambiguous operation fence or permits another manual write', async () => {
		const f = await fixture();
		await f.enable();
		f.change();
		f.setOverride((url, init) =>
			url.endsWith('/items') && init?.method === 'PUT'
				? new Response(null, { status: 503 })
				: undefined
		);
		await f.service.run('dimension-door', f.signal);
		await f.service.configure('dimension-door', false, false, f.signal);
		expect((await f.state()).sync?.phase).toBe('uncertain');
		f.setOverride(undefined);
		f.requests.length = 0;
		await expect(f.service.configure('dimension-door', true, true, f.signal)).rejects.toThrow();
		expect(f.writes()).toEqual([]);
	});
});
