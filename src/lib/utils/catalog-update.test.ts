import { describe, expect, it } from 'vitest';
import type { NTSShowCatalog, NTSEpisodeSummary } from '$lib/types';
import {
	createGeneratedPlaylistText,
	type CatalogProgress,
	type EpisodeState
} from './catalog-scan';
import { parseNTSShowCatalog, reconcileSavedCatalogWithNTS } from './catalog-update';

const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';

const episode = (episodeAlias: string, broadcast: string): NTSEpisodeSummary => ({
	episodeAlias,
	name: episodeAlias,
	broadcast,
	cover: '',
	genres: []
});

const savedEpisode = (
	summary: NTSEpisodeSummary,
	status: EpisodeState['status'] = 'done'
): EpisodeState => ({
	...summary,
	status,
	tracks:
		status === 'done'
			? [
					{
						artist: 'Reviewed artist',
						title: 'Reviewed title',
						matches: [
							{
								artist: 'Alternative',
								title: 'Alternative title',
								uri: 'spotify:track:0123456789ABCDEFGHIJKL',
								href: 'https://open.spotify.com/track/0123456789ABCDEFGHIJKL'
							}
						],
						confident: false,
						fallback: true,
						selectedMatch: 'spotify:track:0123456789ABCDEFGHIJKL',
						checked: false
					}
				]
			: [],
	...(status === 'error' ? { error: 'Could not scan this episode' } : {})
});

const catalog = (episodes: NTSEpisodeSummary[]): NTSShowCatalog => ({
	showAlias: 'test-show',
	name: 'Test Show',
	description: 'Description',
	cover: '',
	episodes
});

const progress = (
	episodes: EpisodeState[],
	playlist: CatalogProgress['playlist'] = {
		title: 'Custom playlist',
		description: 'Custom description',
		public: true,
		order: 'latest-first',
		linkedPlaylistId: PLAYLIST_ID
	}
): CatalogProgress => ({
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias: 'test-show',
	updatedAt: 10,
	episodes: Object.fromEntries(episodes.map((item) => [item.episodeAlias, item])),
	playlist,
	retry: { cooldownUntil: 123_456, pausedByRateLimit: true },
	display: { showName: 'Test Show', showCover: 'https://images.example.test/show.jpg' }
});

describe('saved catalogue update reconciliation', () => {
	it('returns the saved record unchanged when the catalogue is up to date', () => {
		const existing = episode('existing', '2026-01-01T00:00:00.000Z');
		const saved = progress([savedEpisode(existing)]);
		const result = reconcileSavedCatalogWithNTS(saved, catalog([existing]), 20);

		expect(result).toEqual({ progress: saved, addedCount: 0 });
		expect(result.progress).toBe(saved);
	});

	it('adds one or multiple genuinely new aliases as pending without changing reviewed state', () => {
		const existing = savedEpisode(episode('existing', '2026-01-01T00:00:00.000Z'));
		const failed = savedEpisode(episode('failed', '2026-02-01T00:00:00.000Z'), 'error');
		const saved = progress([existing, failed]);
		const result = reconcileSavedCatalogWithNTS(
			saved,
			catalog([
				episode('existing', '2026-01-01T00:00:00.000Z'),
				episode('new-one', '2026-03-01T00:00:00.000Z'),
				episode('new-two', '2026-04-01T00:00:00.000Z')
			]),
			20
		);

		expect(result.addedCount).toBe(2);
		expect(result.progress.updatedAt).toBe(20);
		expect(result.progress.episodes.existing).toMatchObject({
			status: 'done',
			tracks: existing.tracks
		});
		expect(result.progress.episodes.failed).toEqual(failed);
		expect(result.progress.episodes['new-one']).toMatchObject({ status: 'pending', tracks: [] });
		expect(result.progress.episodes['new-two']).toMatchObject({ status: 'pending', tracks: [] });
	});

	it('preserves playlist linkage, creation state, retry state, ordering and customized fields', () => {
		const old = episode('old', '2026-01-01T00:00:00.000Z');
		const saved = progress([savedEpisode(old)]);
		const result = reconcileSavedCatalogWithNTS(
			saved,
			catalog([old, episode('new', '2026-02-01T00:00:00.000Z')]),
			20
		).progress;

		expect(result.playlist).toEqual(saved.playlist);
		expect(result.retry).toEqual(saved.retry);
		expect(result.schemaVersion).toBe(saved.schemaVersion);
		expect(result.matcherVersion).toBe(saved.matcherVersion);

		const pendingCreation = progress([savedEpisode(old)], {
			title: 'Custom playlist',
			description: 'Custom description',
			public: false,
			creationPending: true
		});
		expect(
			reconcileSavedCatalogWithNTS(
				pendingCreation,
				catalog([old, episode('another-new', '2026-03-01T00:00:00.000Z')])
			).progress.playlist.creationPending
		).toBe(true);
	});

	it('extends generated metadata dates while preserving title and description independently', () => {
		const old = episode('old', '2022-01-20T00:00:00.000Z');
		const current = episode('current', '2026-08-06T00:00:00.000Z');
		const future = episode('future', '2026-09-03T00:00:00.000Z');
		const generated = createGeneratedPlaylistText('Test Show', [old, current], 'latest-first');
		const nextGenerated = createGeneratedPlaylistText(
			'Test Show',
			[old, current, future],
			'latest-first'
		);

		const generatedUpdate = reconcileSavedCatalogWithNTS(
			progress([savedEpisode(old), savedEpisode(current)], {
				title: generated.title,
				description: generated.description,
				public: false
			}),
			catalog([old, current, future])
		);
		expect(generatedUpdate.addedCount).toBe(1);
		const generatedResult = generatedUpdate.progress;
		expect(generatedResult.playlist).toMatchObject({
			title: nextGenerated.title,
			description: nextGenerated.description
		});

		const customTitleResult = reconcileSavedCatalogWithNTS(
			progress([savedEpisode(old), savedEpisode(current)], {
				title: 'Custom title',
				description: generated.description,
				public: false
			}),
			catalog([old, current, future])
		).progress;
		expect(customTitleResult.playlist.title).toBe('Custom title');
		expect(customTitleResult.playlist.description).toBe(nextGenerated.description);

		const customDescriptionResult = reconcileSavedCatalogWithNTS(
			progress([savedEpisode(old), savedEpisode(current)], {
				title: generated.title,
				description: 'Custom description',
				public: false
			}),
			catalog([old, current, future])
		).progress;
		expect(customDescriptionResult.playlist.title).toBe(nextGenerated.title);
		expect(customDescriptionResult.playlist.description).toBe('Custom description');
	});

	it('deduplicates reordered upstream aliases and never removes temporarily missing saved episodes', () => {
		const old = savedEpisode(episode('old', '2025-01-01T00:00:00.000Z'));
		const missing = savedEpisode(episode('missing', '2025-02-01T00:00:00.000Z'), 'pending');
		const newEpisode = episode('new', '2026-01-01T00:00:00.000Z');
		const result = reconcileSavedCatalogWithNTS(
			progress([old, missing]),
			catalog([newEpisode, { ...old, name: 'Renamed upstream' }, newEpisode])
		);

		expect(result.addedCount).toBe(1);
		expect(Object.keys(result.progress.episodes).sort()).toEqual(['missing', 'new', 'old']);
		expect(result.progress.episodes.old.status).toBe('done');
		expect(result.progress.episodes.missing).toEqual(missing);
	});
});

describe('NTS catalogue response validation', () => {
	it('rejects malformed catalogues and an unexpected show alias', () => {
		expect(() => parseNTSShowCatalog({ episodes: [] }, 'test-show')).toThrow();
		expect(() => parseNTSShowCatalog(catalog([]), 'another-show')).toThrow();
	});
});
