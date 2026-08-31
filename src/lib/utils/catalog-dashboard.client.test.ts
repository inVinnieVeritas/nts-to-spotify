import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	applySavedCatalogUpdateOutcome,
	catalogDisplayName,
	checkSavedCatalogWithFeedback,
	createSavedCatalogCard,
	createSavedCatalogCards,
	createSavedCatalogUpdateChecker,
	deleteSavedCatalogProgressIfConfirmed,
	downloadSavedCatalogProgress,
	fetchSavedCatalogCurrentNTS,
	formatSavedCatalogCheckFeedback,
	isSavedCatalogCheckActive,
	setSavedCatalogCheckFeedback,
	type SavedCatalogCheckFeedback,
	type SavedCatalogCheckFeedbackMap
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
	display: {
		showName: "Jim O'Rourke",
		showCover: 'https://media.ntslive.co.uk/crop/770x770/show.jpg'
	},
	...overrides
});

describe('saved catalogue dashboard summaries', () => {
	it('counts mutually exclusive episode states and exact selected URI duplicates', () => {
		const card = createSavedCatalogCard(savedProgress());

		expect(card).toMatchObject({
			showName: "Jim O'Rourke",
			showCover: 'https://media.ntslive.co.uk/crop/770x770/show.jpg',
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

	it('shows only the most recent validated scan-session summary', () => {
		const recent = {
			id: 'recent-session',
			startedAt: Date.UTC(2026, 7, 20, 12),
			endedAt: Date.UTC(2026, 7, 20, 12, 5),
			activeDurationMs: 300_000,
			outcome: 'spotify-cooldown' as const,
			processedEpisodes: 3,
			successfulEpisodes: 3,
			failedEpisodes: 0,
			longestMatchingRequestMs: 90_000
		};
		const older = { ...recent, id: 'older-session', endedAt: recent.endedAt - 60_000 };
		const card = createSavedCatalogCard(
			savedProgress({ scanTiming: { history: [older, recent] } })
		);

		expect(card.lastScanSession).toEqual(recent);
		expect(card).not.toHaveProperty('scanHistory');
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

	it('publishes checking immediately, disables only that check state, and re-enables it after no changes', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => (release = resolve));
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => {
				await pending;
				return currentCatalog(['existing']);
			},
			updateProgress: async (_showAlias, update) =>
				update(savedProgress({ episodes: { existing: episode('existing', 'done') } }))
		});
		let feedback: SavedCatalogCheckFeedback | undefined;

		const checking = checkSavedCatalogWithFeedback(
			'jim-o-rourke',
			checker,
			(_showAlias, next) => (feedback = next)
		);

		expect(feedback).toEqual({ type: 'checking' });
		expect(isSavedCatalogCheckActive(feedback)).toBe(true);
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe('Checking NTS for new episodes…');
		release?.();
		await expect(checking).resolves.toMatchObject({ type: 'up-to-date' });
		expect(isSavedCatalogCheckActive(feedback)).toBe(false);
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe(
			'Checked NTS just now. No new episodes found.'
		);
	});

	it.each([
		{ aliases: ['existing', 'new-one'], count: 1, message: '1 new episode found.' },
		{
			aliases: ['existing', 'new-one', 'new-two'],
			count: 2,
			message: '2 new episodes found.'
		}
	])(
		'reports accurate singular and plural results for $count additions',
		async ({ aliases, message }) => {
			const current = savedProgress({ episodes: { existing: episode('existing', 'done') } });
			const checker = createSavedCatalogUpdateChecker({
				loadCurrentCatalog: async () => currentCatalog(aliases),
				updateProgress: async (_showAlias, update) => update(current)
			});
			let feedback: SavedCatalogCheckFeedback | undefined;

			await checkSavedCatalogWithFeedback(
				'jim-o-rourke',
				checker,
				(_showAlias, next) => (feedback = next)
			);

			expect(formatSavedCatalogCheckFeedback(feedback)).toBe(message);
		}
	);

	it('returns a fixed sanitized failure message and re-enables checking', async () => {
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => {
				throw Object.assign(new Error('PRIVATE_UPSTREAM_BODY'), {
					token: 'PRIVATE_TOKEN',
					url: 'https://nts.example/private'
				});
			}
		});
		let feedback: SavedCatalogCheckFeedback | undefined;

		await checkSavedCatalogWithFeedback(
			'jim-o-rourke',
			checker,
			(_showAlias, next) => (feedback = next)
		);

		expect(feedback).toEqual({ type: 'check-failed' });
		expect(isSavedCatalogCheckActive(feedback)).toBe(false);
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe(
			'Could not check NTS. Please try again.'
		);
		expect(formatSavedCatalogCheckFeedback({ type: 'save-failed' })).toBe(
			'Could not check NTS. Please try again.'
		);
		expect(formatSavedCatalogCheckFeedback(feedback)).not.toMatch(/PRIVATE|https:/);
	});

	it('keeps simultaneous feedback independent for different saved catalogue cards', async () => {
		let releaseFirst: (() => void) | undefined;
		const firstPending = new Promise<void>((resolve) => (releaseFirst = resolve));
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async (showAlias) => {
				if (showAlias === 'first-show') await firstPending;
				return { ...currentCatalog([]), showAlias };
			},
			updateProgress: async (showAlias) => savedProgress({ showAlias, episodes: {} })
		});
		let states: SavedCatalogCheckFeedbackMap = {};
		const setFeedback = (showAlias: string, feedback: SavedCatalogCheckFeedback) => {
			states = setSavedCatalogCheckFeedback(states, showAlias, feedback);
		};

		const first = checkSavedCatalogWithFeedback('first-show', checker, setFeedback);
		await checkSavedCatalogWithFeedback('second-show', checker, setFeedback);

		expect(states).toEqual({
			'first-show': { type: 'checking' },
			'second-show': { type: 'up-to-date' }
		});
		releaseFirst?.();
		await first;
		expect(states['first-show']).toEqual({ type: 'up-to-date' });
	});

	it('replaces prior feedback cleanly on a repeated check without dispatching Spotify Search', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		let releaseSecond: (() => void) | undefined;
		const secondPending = new Promise<void>((resolve) => (releaseSecond = resolve));
		let loadCount = 0;
		let current = savedProgress({ episodes: { existing: episode('existing', 'done') } });
		const checker = createSavedCatalogUpdateChecker({
			loadCurrentCatalog: async () => {
				loadCount += 1;
				if (loadCount === 2) await secondPending;
				return currentCatalog(loadCount === 1 ? ['existing', 'new'] : ['existing', 'new']);
			},
			updateProgress: async (_showAlias, update) => (current = update(current))
		});
		let feedback: SavedCatalogCheckFeedback | undefined;
		const setFeedback = (_showAlias: string, next: SavedCatalogCheckFeedback) => {
			feedback = next;
		};

		await checkSavedCatalogWithFeedback('jim-o-rourke', checker, setFeedback);
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe('1 new episode found.');
		const repeated = checkSavedCatalogWithFeedback('jim-o-rourke', checker, setFeedback);
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe('Checking NTS for new episodes…');
		releaseSecond?.();
		await repeated;
		expect(formatSavedCatalogCheckFeedback(feedback)).toBe(
			'Checked NTS just now. No new episodes found.'
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('renders each card result in an explicit polite live region', () => {
		const component = readFileSync(
			fileURLToPath(new URL('../../routes/+page.svelte', import.meta.url)),
			'utf8'
		);
		expect(component).toContain('role="status"');
		expect(component).toContain('aria-live="polite"');
		expect(component).toContain('aria-atomic="true"');
		expect(component).toContain('isSavedCatalogCheckActive(');
	});
});
