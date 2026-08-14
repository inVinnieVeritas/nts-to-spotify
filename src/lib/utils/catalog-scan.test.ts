import { describe, expect, it, vi } from 'vitest';
import type { NTSEpisodeSummary } from '$lib/types';
import { abortableDelay } from './abort';
import {
	CATALOG_PROGRESS_SCHEMA_VERSION,
	SPOTIFY_MATCHER_VERSION,
	captureCatalogProgress,
	formatCooldownDuration,
	getCatalogSummaryCounts,
	getResumableEpisodeIndexes,
	reconcileEpisodes,
	restoreCatalogRetryState,
	runCatalogWorkers,
	shouldApplyCatalogRestoration,
	uniqueSpotifyUris,
	type CatalogProgress,
	type EpisodeState
} from './catalog-scan';

const episode = (episodeAlias: string, broadcast: string): NTSEpisodeSummary => ({
	episodeAlias,
	name: episodeAlias,
	broadcast,
	cover: '',
	genres: []
});

const reviewTrack = {
	artist: 'Original artist',
	title: 'Original title',
	matches: [
		{
			uri: 'spotify:track:manual',
			artist: 'Selected artist',
			title: 'Selected title',
			href: 'https://example.test/track'
		}
	],
	confident: false,
	fallback: true,
	selectedMatch: 'spotify:track:manual',
	checked: true
};

const savedProgress = (episodes: EpisodeState[]): CatalogProgress => ({
	schemaVersion: CATALOG_PROGRESS_SCHEMA_VERSION,
	matcherVersion: SPOTIFY_MATCHER_VERSION,
	showAlias: 'show',
	updatedAt: 1,
	episodes: Object.fromEntries(episodes.map((item) => [item.episodeAlias, item])),
	playlist: { title: 'Saved title', description: 'Saved description', public: true }
});

describe('catalogue progress restoration', () => {
	it('restores completed review choices and recovers interrupted scans as pending', () => {
		const catalog = [episode('older', '2026-01-01'), episode('newer', '2026-02-01')];
		const progress = savedProgress([
			{ ...catalog[0], status: 'done', tracks: [reviewTrack] },
			{ ...catalog[1], status: 'scanning', tracks: [] }
		]);

		const restored = reconcileEpisodes(catalog, progress);

		expect(restored.map(({ episodeAlias }) => episodeAlias)).toEqual(['older', 'newer']);
		expect(restored[0]).toMatchObject({
			status: 'done',
			tracks: [{ checked: true, selectedMatch: 'spotify:track:manual' }]
		});
		expect(restored[1]).toMatchObject({ status: 'pending', tracks: [] });
	});

	it('rejects a stale restoration after the active show alias changes', () => {
		expect(shouldApplyCatalogRestoration('show-a', 1, 'show-b', 2)).toBe(false);
		expect(shouldApplyCatalogRestoration('show-b', 2, 'show-b', 2)).toBe(true);
	});

	it('restores a future cooldown and paused retry state', () => {
		const now = 1_000;
		const progress = {
			...savedProgress([]),
			retry: { cooldownUntil: now + 30_000, pausedByRateLimit: true }
		};

		expect(restoreCatalogRetryState(progress, now)).toEqual({
			cooldownUntil: now + 30_000,
			pausedByRateLimit: true
		});
		expect(restoreCatalogRetryState(progress, now + 30_000)).toEqual({
			cooldownUntil: 0,
			pausedByRateLimit: false
		});
	});

	it('captures the latest review state without retaining mutable references', () => {
		const catalogEpisode: EpisodeState = {
			...episode('episode', '2026-01-01'),
			status: 'done',
			tracks: [{ ...reviewTrack }]
		};
		const snapshot = captureCatalogProgress(
			'show',
			[catalogEpisode],
			{ title: 'Title', description: 'Description', public: false },
			{ cooldownUntil: 0, pausedByRateLimit: false }
		);

		catalogEpisode.tracks[0].checked = false;
		expect(snapshot.episodes.episode.tracks[0].checked).toBe(true);
	});

	it('resumes only episodes that are not completed', () => {
		const catalog: EpisodeState[] = [
			{ ...episode('done', '2026-01-01'), status: 'done', tracks: [] },
			{ ...episode('pending', '2026-02-01'), status: 'pending', tracks: [] },
			{ ...episode('failed', '2026-03-01'), status: 'error', tracks: [], error: 'failed' }
		];

		expect(getResumableEpisodeIndexes(catalog)).toEqual([1, 2]);
	});
});

describe('catalogue cooldown display', () => {
	it('formats countdowns as non-negative days, hours, minutes, and seconds', () => {
		expect(formatCooldownDuration(28_215)).toBe('7h 50m 15s');
		expect(formatCooldownDuration(114_615)).toBe('1d 7h 50m 15s');
		expect(formatCooldownDuration(65)).toBe('1m 5s');
		expect(formatCooldownDuration(-10)).toBe('0s');
	});

	it('counts every episode in exactly one summary bucket', () => {
		const counts = getCatalogSummaryCounts([
			{ status: 'done' },
			{ status: 'pending' },
			{ status: 'scanning' },
			{ status: 'rate-limited' },
			{ status: 'error' }
		]);

		expect(counts).toEqual({ scanned: 1, pending: 3, failed: 1 });
		expect(counts.scanned + counts.pending + counts.failed).toBe(5);
	});
});

describe('catalogue scan workers', () => {
	it('pauses both workers after one 429 without starting later episodes', async () => {
		const controller = new AbortController();
		const started: number[] = [];
		let cooldownActive = false;
		let cancelSibling: (() => void) | undefined;
		const running = runCatalogWorkers({
			indexes: [0, 1, 2, 3],
			concurrency: 2,
			signal: controller.signal,
			waitUntilReady: (signal) =>
				cooldownActive ? abortableDelay(60_000, signal) : Promise.resolve(),
			scanEpisode: (index) => {
				started.push(index);
				if (index === 0) {
					return Promise.resolve({
						type: 'rate-limited' as const,
						retryAfterSeconds: 30,
						requiresManualResume: false
					});
				}
				return new Promise((resolve) => {
					cancelSibling = () => resolve({ type: 'cancelled' });
				});
			},
			onRateLimit: () => {
				cooldownActive = true;
				cancelSibling?.();
			}
		});

		await vi.waitFor(() => expect(started).toEqual([0, 1]));
		await Promise.resolve();
		expect(started).toEqual([0, 1]);
		controller.abort();
		await running;
		expect(started).toEqual([0, 1]);
	});

	it('settles all active workers on cancellation without starting queued episodes', async () => {
		const controller = new AbortController();
		const started: number[] = [];
		const settled: number[] = [];
		const running = runCatalogWorkers({
			indexes: [0, 1, 2],
			concurrency: 2,
			signal: controller.signal,
			waitUntilReady: () => Promise.resolve(),
			scanEpisode: (index, signal) =>
				new Promise((resolve) => {
					started.push(index);
					signal.addEventListener(
						'abort',
						() => {
							settled.push(index);
							resolve({ type: 'cancelled' });
						},
						{ once: true }
					);
				}),
			onRateLimit: () => undefined
		});

		await vi.waitFor(() => expect(started).toEqual([0, 1]));
		controller.abort();
		await running;
		expect(settled).toEqual([0, 1]);
		expect(started).toEqual([0, 1]);
	});
});

describe('exact Spotify URI deduplication', () => {
	it('preserves first-occurrence order without fuzzy matching', () => {
		expect(
			uniqueSpotifyUris([
				'spotify:track:B',
				'spotify:track:A',
				'spotify:track:B',
				'spotify:track:a'
			])
		).toEqual(['spotify:track:B', 'spotify:track:A', 'spotify:track:a']);
	});
});
