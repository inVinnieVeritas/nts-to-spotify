import { describe, expect, it, vi } from 'vitest';
import type { NTSEpisodeSummary } from '$lib/types';
import { abortableDelay } from './abort';
import {
	CATALOG_PROGRESS_SCHEMA_VERSION,
	SPOTIFY_MATCHER_VERSION,
	captureCatalogProgress,
	createGeneratedPlaylistText,
	formatCooldownDuration,
	getCatalogExportUris,
	getCatalogSummaryCounts,
	getResumableEpisodeIndexes,
	reconcileEpisodes,
	restoreCatalogPlaylistOrder,
	restoreCatalogRetryState,
	runCatalogWorkers,
	shouldApplyCatalogRestoration,
	uniqueSpotifyUris,
	updateGeneratedPlaylistText,
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

	it('restores a saved playlist order choice', () => {
		const progress = savedProgress([]);
		progress.playlist.order = 'oldest-first';

		expect(restoreCatalogPlaylistOrder(progress)).toBe('oldest-first');
	});

	it('defaults legacy saved records without an order to latest-first', () => {
		expect(restoreCatalogPlaylistOrder(savedProgress([]))).toBe('latest-first');
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
			{
				title: 'Title',
				description: 'Description',
				public: false,
				order: 'oldest-first'
			},
			{ cooldownUntil: 0, pausedByRateLimit: false }
		);

		catalogEpisode.tracks[0].checked = false;
		expect(snapshot.episodes.episode.tracks[0].checked).toBe(true);
		expect(snapshot.playlist.order).toBe('oldest-first');
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

describe('generated playlist text chronology', () => {
	const showEpisodes = [
		episode('middle', '2024-05-03'),
		episode('newest', '2026-08-06'),
		episode('oldest', '2022-01-20')
	];
	const latest = createGeneratedPlaylistText('Test Show', showEpisodes, 'latest-first');
	const oldest = createGeneratedPlaylistText('Test Show', showEpisodes, 'oldest-first');

	it('updates generated name and description immediately in both directions', () => {
		expect(latest.dateStamp).toBe('06.08.26→20.01.22');
		expect(latest.title).toBe('“test show” 06.08.26→20.01.22');
		expect(latest.description).toContain('“test show” 06.08.26→20.01.22');
		expect(latest.description).toContain(
			'covering broadcasts from 20 January 2022 through 6 August 2026'
		);
		expect(oldest.dateStamp).toBe('20.01.22→06.08.26');
		expect(oldest.title).toBe('“test show” 20.01.22→06.08.26');
		expect(oldest.description).toContain('“test show” 20.01.22→06.08.26');
		expect(oldest.description).toContain(
			'covering broadcasts from 20 January 2022 through 6 August 2026'
		);

		const switchedToOldest = updateGeneratedPlaylistText(latest, latest, oldest);
		expect(switchedToOldest).toEqual({ title: oldest.title, description: oldest.description });
		expect(updateGeneratedPlaylistText(switchedToOldest, oldest, latest)).toEqual({
			title: latest.title,
			description: latest.description
		});
	});

	it('preserves a custom name while updating a generated description', () => {
		expect(
			updateGeneratedPlaylistText(
				{ title: 'My custom playlist', description: latest.description },
				latest,
				oldest
			)
		).toEqual({ title: 'My custom playlist', description: oldest.description });
	});

	it('preserves a custom description while updating a generated name', () => {
		expect(
			updateGeneratedPlaylistText(
				{ title: latest.title, description: 'My custom description' },
				latest,
				oldest
			)
		).toEqual({ title: oldest.title, description: 'My custom description' });
	});

	it('captures the resulting order, name, and description for persistence', () => {
		const updated = updateGeneratedPlaylistText(latest, latest, oldest);
		const snapshot = captureCatalogProgress(
			'show',
			[],
			{ ...updated, public: false, order: 'oldest-first' },
			{ cooldownUntil: 0, pausedByRateLimit: false }
		);

		expect(snapshot.playlist).toEqual({
			title: oldest.title,
			description: oldest.description,
			public: false,
			order: 'oldest-first'
		});
	});
});

describe('catalogue export ordering', () => {
	const selectedTrack = (uri: string, title: string) => ({
		...reviewTrack,
		title,
		selectedMatch: uri,
		matches: [{ ...reviewTrack.matches[0], uri, title }]
	});
	const completedEpisode = (
		episodeAlias: string,
		broadcast: string,
		tracks: ReturnType<typeof selectedTrack>[]
	): EpisodeState => ({
		...episode(episodeAlias, broadcast),
		status: 'done',
		tracks
	});

	it('exports episodes newest to oldest even when supplied out of order', () => {
		const episodes = [
			completedEpisode('middle', '2026-02-01', [selectedTrack('spotify:track:middle', 'Middle')]),
			completedEpisode('oldest', '2026-01-01', [selectedTrack('spotify:track:oldest', 'Oldest')]),
			completedEpisode('newest', '2026-03-01', [selectedTrack('spotify:track:newest', 'Newest')])
		];

		expect(getCatalogExportUris(episodes)).toEqual([
			'spotify:track:newest',
			'spotify:track:middle',
			'spotify:track:oldest'
		]);
	});

	it('exports episodes oldest to newest when selected', () => {
		const episodes = [
			completedEpisode('middle', '2026-02-01', [selectedTrack('spotify:track:middle', 'Middle')]),
			completedEpisode('newest', '2026-03-01', [selectedTrack('spotify:track:newest', 'Newest')]),
			completedEpisode('oldest', '2026-01-01', [selectedTrack('spotify:track:oldest', 'Oldest')])
		];

		expect(getCatalogExportUris(episodes, 'oldest-first')).toEqual([
			'spotify:track:oldest',
			'spotify:track:middle',
			'spotify:track:newest'
		]);
	});

	it('preserves original track order within each episode', () => {
		const episodes = [
			completedEpisode('episode', '2026-03-01', [
				selectedTrack('spotify:track:first', 'First'),
				selectedTrack('spotify:track:second', 'Second'),
				selectedTrack('spotify:track:third', 'Third')
			])
		];

		expect(getCatalogExportUris(episodes)).toEqual([
			'spotify:track:first',
			'spotify:track:second',
			'spotify:track:third'
		]);
	});

	it('retains the newest episode occurrence of an exact duplicate URI', () => {
		const episodes = [
			completedEpisode('oldest', '2026-01-01', [
				selectedTrack('spotify:track:duplicate', 'Older duplicate'),
				selectedTrack('spotify:track:older-tail', 'Older tail')
			]),
			completedEpisode('newest', '2026-03-01', [
				selectedTrack('spotify:track:newer-head', 'Newer head'),
				selectedTrack('spotify:track:duplicate', 'Newer duplicate')
			])
		];

		expect(getCatalogExportUris(episodes)).toEqual([
			'spotify:track:newer-head',
			'spotify:track:duplicate',
			'spotify:track:older-tail'
		]);
	});

	it('retains the oldest episode occurrence of an exact duplicate URI', () => {
		const episodes = [
			completedEpisode('newest', '2026-03-01', [
				selectedTrack('spotify:track:duplicate', 'Newer duplicate'),
				selectedTrack('spotify:track:newer-tail', 'Newer tail')
			]),
			completedEpisode('oldest', '2026-01-01', [
				selectedTrack('spotify:track:older-head', 'Older head'),
				selectedTrack('spotify:track:duplicate', 'Older duplicate')
			])
		];

		expect(getCatalogExportUris(episodes, 'oldest-first')).toEqual([
			'spotify:track:older-head',
			'spotify:track:duplicate',
			'spotify:track:newer-tail'
		]);
	});
});
