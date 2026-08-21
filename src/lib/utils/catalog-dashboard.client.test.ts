import { describe, expect, it, vi } from 'vitest';
import {
	catalogDisplayName,
	createSavedCatalogCard,
	createSavedCatalogCards,
	deleteSavedCatalogProgressIfConfirmed,
	downloadSavedCatalogProgress
} from './catalog-dashboard.client';
import type { CatalogProgress, EpisodeState, ReviewTrack } from './catalog-scan';

const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';
const TRACK_A = 'spotify:track:0123456789ABCDEFGHIJKL';
const TRACK_B = 'spotify:track:ZYXWVUTSRQPONMLKJIHGFE';

const track = (uri: string, checked = true): ReviewTrack => ({
	artist: 'Artist',
	title: 'Title',
	matches: [
		{
			artist: 'Artist',
			title: 'Title',
			uri,
			href: `https://open.spotify.com/track/${uri.slice('spotify:track:'.length)}`
		}
	],
	confident: true,
	fallback: false,
	selectedMatch: checked ? uri : null,
	checked
});

const episode = (
	episodeAlias: string,
	status: EpisodeState['status'],
	tracks: ReviewTrack[] = []
): EpisodeState => ({
	episodeAlias,
	name: episodeAlias,
	broadcast: '2026-01-01T00:00:00.000Z',
	cover: '',
	genres: [],
	status,
	tracks
});

const savedProgress = (overrides: Partial<CatalogProgress> = {}): CatalogProgress => ({
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias: 'jim-o-rourke',
	updatedAt: Date.UTC(2026, 7, 20, 12, 30),
	episodes: {
		done: episode('done', 'done', [track(TRACK_A), track(TRACK_A), track(TRACK_B)]),
		pending: episode('pending', 'pending'),
		failed: episode('failed', 'error')
	},
	playlist: {
		title: 'Playlist',
		description: 'Description',
		public: false
	},
	retry: { cooldownUntil: 0, pausedByRateLimit: false },
	display: { showName: "Jim O'Rourke", showCover: 'https://images.example.test/show.jpg' },
	...overrides
});

describe('saved catalogue dashboard summaries', () => {
	it('counts mutually exclusive episode states and exact selected URI duplicates', () => {
		const card = createSavedCatalogCard(savedProgress());

		expect(card).toMatchObject({
			showName: "Jim O'Rourke",
			showCover: 'https://images.example.test/show.jpg',
			scanned: 1,
			pending: 1,
			failed: 1,
			uniqueSelectedTracks: 2,
			duplicateTracks: 1
		});
	});

	it('sorts cards by descending last-saved time', () => {
		const older = savedProgress({ showAlias: 'older', updatedAt: Date.UTC(2026, 0, 1) });
		const newer = savedProgress({ showAlias: 'newer', updatedAt: Date.UTC(2026, 1, 1) });

		expect(createSavedCatalogCards([older, newer]).map(({ showAlias }) => showAlias)).toEqual([
			'newer',
			'older'
		]);
	});

	it('derives only canonical linked-playlist URLs and reports pending creation', () => {
		const linked = createSavedCatalogCard(
			savedProgress({
				playlist: {
					title: 'Playlist',
					description: 'Description',
					public: false,
					linkedPlaylistId: PLAYLIST_ID
				}
			})
		);
		const pending = createSavedCatalogCard(
			savedProgress({
				playlist: {
					title: 'Playlist',
					description: 'Description',
					public: false,
					creationPending: true
				}
			})
		);
		const invalid = createSavedCatalogCard(
			savedProgress({
				playlist: {
					title: 'Playlist',
					description: 'Description',
					public: false,
					linkedPlaylistId: 'invalid'
				}
			})
		);

		expect(linked.linkedPlaylistUrl).toBe(`https://open.spotify.com/playlist/${PLAYLIST_ID}`);
		expect(linked.creationPending).toBe(false);
		expect(pending.creationPending).toBe(true);
		expect(invalid.linkedPlaylistUrl).toBeUndefined();
	});

	it('uses readable local fallbacks for legacy records without display metadata', () => {
		const legacy = savedProgress({ showAlias: 'the-breakfast_show', display: undefined });
		expect(catalogDisplayName(legacy)).toBe('The Breakfast Show');
		expect(createSavedCatalogCard(legacy).showCover).toBeUndefined();
	});
});

describe('saved catalogue dashboard actions', () => {
	it('downloads the exact selected record using existing filename conventions', () => {
		const record = savedProgress();
		const download = vi.fn();

		downloadSavedCatalogProgress(record, download);
		expect(download).toHaveBeenCalledOnce();
		expect(download.mock.calls[0][0]).toBe(record);
		expect(download.mock.calls[0][1]).toMatch(
			/^jim-o-rourke-catalogue-progress-\d{4}-\d{2}-\d{2}\.json$/
		);
	});

	it('deletes only after named confirmation succeeds', async () => {
		const card = createSavedCatalogCard(savedProgress());
		const confirm = vi.fn((_message: string) => true);
		const remove = vi.fn(async () => undefined);

		await expect(deleteSavedCatalogProgressIfConfirmed(card, { confirm, remove })).resolves.toBe(
			true
		);
		expect(confirm.mock.calls[0][0]).toContain("Jim O'Rourke");
		expect(confirm.mock.calls[0][0]).toContain('does not delete the Spotify playlist');
		expect(remove).toHaveBeenCalledWith('jim-o-rourke');
	});

	it('does nothing when deletion confirmation is cancelled', async () => {
		const card = createSavedCatalogCard(savedProgress());
		const remove = vi.fn(async () => undefined);

		await expect(
			deleteSavedCatalogProgressIfConfirmed(card, { confirm: () => false, remove })
		).resolves.toBe(false);
		expect(remove).not.toHaveBeenCalled();
	});

	it('propagates failed deletion so the caller can keep the visible card', async () => {
		const card = createSavedCatalogCard(savedProgress());
		const visibleCards = [card];

		await expect(
			deleteSavedCatalogProgressIfConfirmed(card, {
				confirm: () => true,
				remove: async () => {
					throw new Error('database unavailable');
				}
			})
		).rejects.toThrow('database unavailable');
		expect(visibleCards).toEqual([card]);
	});
});
