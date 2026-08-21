import { describe, expect, it, vi } from 'vitest';
import {
	applySavedCatalogUpdateOutcome,
	catalogDisplayName,
	createSavedCatalogCard,
	createSavedCatalogCards,
	createSavedCatalogUpdateChecker,
	deleteSavedCatalogProgressIfConfirmed,
	downloadSavedCatalogProgress,
	fetchSavedCatalogCurrentNTS
} from './catalog-dashboard.client';
import type { NTSShowCatalog } from '$lib/types';
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

describe('saved catalogue update checks', () => {
	const currentCatalog = (episodeAliases: string[]): NTSShowCatalog => ({
		showAlias: 'jim-o-rourke',
		name: "Jim O'Rourke",
		description: 'Description',
		cover: '',
		episodes: episodeAliases.map((episodeAlias, index) => ({
			episodeAlias,
			name: episodeAlias,
			broadcast: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
			cover: '',
			genres: []
		}))
	});

	it('does not contact NTS or Spotify before an explicit check', () => {
		const loadCurrentCatalog = vi.fn(async () => currentCatalog([]));
		const updateProgress = vi.fn(async () => savedProgress());

		createSavedCatalogUpdateChecker({ loadCurrentCatalog, updateProgress });
		expect(loadCurrentCatalog).not.toHaveBeenCalled();
		expect(updateProgress).not.toHaveBeenCalled();
	});

	it('reports up-to-date without changing the saved record', async () => {
		const saved = savedProgress({ episodes: { existing: episode('existing', 'done') } });
		const updateProgress = vi.fn(
			async (_showAlias: string, update: (current: CatalogProgress) => CatalogProgress) =>
				update(saved)
		);
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => currentCatalog(['existing']),
			updateProgress
		});

		await expect(checker.check('jim-o-rourke')).resolves.toEqual({
			type: 'up-to-date',
			progress: saved
		});
	});

	it('keeps the visible Last saved value unchanged for an up-to-date outcome', () => {
		const visible = [createSavedCatalogCard(savedProgress())];
		const reread = savedProgress({ updatedAt: visible[0].updatedAt + 60_000 });
		const result = applySavedCatalogUpdateOutcome(visible, {
			type: 'up-to-date',
			progress: reread
		});

		expect(result).toBe(visible);
		expect(result[0].updatedAt).toBe(visible[0].updatedAt);
	});

	it('waits for persistence before reporting added episodes and invokes no scan or Spotify work', async () => {
		const saved = savedProgress({ episodes: { existing: episode('existing', 'done') } });
		let releaseSave: (() => void) | undefined;
		const persisted = new Promise<void>((resolve) => (releaseSave = resolve));
		const loadCurrentCatalog = vi.fn(async () =>
			currentCatalog(['existing', 'new-one', 'new-two'])
		);
		const updateProgress = vi.fn(
			async (_showAlias: string, update: (current: CatalogProgress) => CatalogProgress) => {
				const next = update(saved);
				await persisted;
				return next;
			}
		);
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog,
			updateProgress
		});

		const checking = checker.check('jim-o-rourke');
		let settled = false;
		void checking.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseSave?.();
		await expect(checking).resolves.toMatchObject({ type: 'updated', addedCount: 2 });
		expect(loadCurrentCatalog).toHaveBeenCalledOnce();
		expect(updateProgress).toHaveBeenCalledOnce();
	});

	it('reports a specific save failure without returning updated progress', async () => {
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => currentCatalog(['existing', 'new']),
			updateProgress: async (_showAlias, update) => {
				update(savedProgress({ episodes: { existing: episode('existing', 'done') } }));
				throw new Error('IndexedDB write failed');
			}
		});

		await expect(checker.check('jim-o-rourke')).resolves.toEqual({ type: 'save-failed' });
	});

	it('blocks duplicate clicks for one show while allowing independent checks', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => (release = resolve));
		const loadCurrentCatalog = vi.fn(async (showAlias: string) => {
			if (showAlias === 'jim-o-rourke') await pending;
			return { ...currentCatalog([]), showAlias };
		});
		const updateProgress = vi.fn(async (showAlias: string) =>
			savedProgress({ showAlias, episodes: {} })
		);
		const checker = createSavedCatalogUpdateChecker({ loadCurrentCatalog, updateProgress });

		const first = checker.check('jim-o-rourke');
		await expect(checker.check('jim-o-rourke')).resolves.toEqual({ type: 'already-checking' });
		await expect(checker.check('another-show')).resolves.toMatchObject({ type: 'up-to-date' });
		release?.();
		await first;
		expect(loadCurrentCatalog).toHaveBeenCalledTimes(2);
	});

	it('rejects malformed success responses and sanitizes network failures', async () => {
		const malformedFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ catalog: { episodes: [] } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);
		await expect(
			fetchSavedCatalogCurrentNTS('jim-o-rourke', malformedFetch as typeof fetch)
		).rejects.toThrow('Invalid NTS catalogue response');

		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => {
				throw Object.assign(new TypeError('PRIVATE_NETWORK_DETAIL'), { token: 'PRIVATE_TOKEN' });
			}
		});
		await expect(checker.check('jim-o-rourke')).resolves.toEqual({ type: 'check-failed' });
	});

	it('uses only the dedicated NTS catalogue endpoint for a requested check', async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ catalog: currentCatalog(['existing']) }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			fetchSavedCatalogCurrentNTS('jim-o-rourke', fetcher as typeof fetch)
		).resolves.toEqual(currentCatalog(['existing']));
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe('/api/nts/catalogue');
		expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST' });
	});
});
