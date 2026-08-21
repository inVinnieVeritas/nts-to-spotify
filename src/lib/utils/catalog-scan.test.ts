import { describe, expect, it, vi } from 'vitest';
import type { NTSEpisodeSummary } from '$lib/types';
import { abortableDelay } from './abort';
import {
	applyDurableCatalogPlaylistLinkTransition,
	canCreateCatalogSpotifyPlaylist,
	CATALOG_PROGRESS_SCHEMA_VERSION,
	SPOTIFY_MATCHER_VERSION,
	captureCatalogProgress,
	createCatalogResetState,
	createGeneratedPlaylistText,
	createLegacyGeneratedPlaylistText,
	formatCooldownDuration,
	formatSpotifyCooldownMessage,
	getCatalogEpisodeReviewTracks,
	getCatalogExportUris,
	getCatalogReviewFilterCounts,
	getCatalogSummaryCounts,
	getResumableEpisodeIndexes,
	isSystemicSpotifyResponseFailure,
	parseCatalogRetryAfter,
	parseCatalogSpotifyRateLimitReason,
	parseSpotifyPlaylistId,
	parseSpotifySessionMetrics,
	reconcileEpisodes,
	restoreCatalogCreationPending,
	restoreCatalogLinkedPlaylistId,
	restoreCatalogPlaylistOrder,
	restoreCatalogRetryState,
	runCatalogWorkers,
	shouldShowCatalogEpisodeForReview,
	shouldApplyCatalogRestoration,
	shouldReturnEpisodeToPending,
	uniqueSpotifyUris,
	updateGeneratedPlaylistText,
	updateGeneratedPlaylistTextForCatalog,
	type CatalogProgress,
	type CatalogPlaylistLinkState,
	type CatalogReviewFilter,
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
const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';

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

	it('preserves completed episodes while adding a newly published episode as pending', () => {
		const older = episode('older', '2026-01-01');
		const newer = episode('newer', '2026-02-01');
		const progress = savedProgress([{ ...older, status: 'done', tracks: [reviewTrack] }]);

		expect(reconcileEpisodes([older, newer], progress)).toEqual([
			expect.objectContaining({ episodeAlias: 'older', status: 'done', tracks: [reviewTrack] }),
			expect.objectContaining({ episodeAlias: 'newer', status: 'pending', tracks: [] })
		]);
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

	it('restores only canonical linked playlist IDs and isolates shows', () => {
		const first = savedProgress([]);
		first.showAlias = 'show-a';
		first.playlist.linkedPlaylistId = PLAYLIST_ID;
		const second = savedProgress([]);
		second.showAlias = 'show-b';
		second.playlist.linkedPlaylistId = 'invalid';

		expect(restoreCatalogLinkedPlaylistId(first)).toBe(PLAYLIST_ID);
		expect(restoreCatalogLinkedPlaylistId(second)).toBeUndefined();
		expect(restoreCatalogLinkedPlaylistId(null)).toBeUndefined();
	});

	it('accepts only canonical playlist IDs and canonical Spotify playlist URLs', () => {
		expect(parseSpotifyPlaylistId(PLAYLIST_ID)).toBe(PLAYLIST_ID);
		expect(parseSpotifyPlaylistId(`https://open.spotify.com/playlist/${PLAYLIST_ID}`)).toBe(
			PLAYLIST_ID
		);
		expect(parseSpotifyPlaylistId(`https://open.spotify.com/playlist/${PLAYLIST_ID}/`)).toBe(
			PLAYLIST_ID
		);
		for (const invalid of [
			`http://open.spotify.com/playlist/${PLAYLIST_ID}`,
			`https://example.test/playlist/${PLAYLIST_ID}`,
			`https://open.spotify.com/playlist/${PLAYLIST_ID}?si=tracking`,
			`https://user:password@open.spotify.com/playlist/${PLAYLIST_ID}`,
			'not-a-playlist'
		]) {
			expect(parseSpotifyPlaylistId(invalid)).toBeUndefined();
		}
	});

	it('restores pending creation only when no durable playlist link exists', () => {
		const pending = savedProgress([]);
		pending.playlist.creationPending = true;
		expect(restoreCatalogCreationPending(pending)).toBe(true);

		pending.playlist.linkedPlaylistId = PLAYLIST_ID;
		expect(restoreCatalogCreationPending(pending)).toBe(false);
		expect(restoreCatalogCreationPending(savedProgress([]))).toBe(false);
	});

	it('applies durable creation/link transitions and blocks creation after a failed link save', async () => {
		let state: CatalogPlaylistLinkState = { creationPending: false };
		const apply = (next: CatalogPlaylistLinkState) => (state = next);
		const saves: CatalogPlaylistLinkState[] = [];

		expect(
			await applyDurableCatalogPlaylistLinkTransition(
				{ creationPending: true },
				{ creationPending: false },
				apply,
				async () => {
					saves.push({ ...state });
					return true;
				}
			)
		).toBe(true);
		expect(saves).toEqual([{ creationPending: true }]);

		expect(
			await applyDurableCatalogPlaylistLinkTransition(
				{ linkedPlaylistId: PLAYLIST_ID, creationPending: false },
				{ linkedPlaylistId: PLAYLIST_ID, creationPending: true },
				apply,
				async () => false
			)
		).toBe(false);
		expect(state).toEqual({ linkedPlaylistId: PLAYLIST_ID, creationPending: true });
		expect(canCreateCatalogSpotifyPlaylist(state)).toBe(false);
		expect(canCreateCatalogSpotifyPlaylist({ creationPending: true })).toBe(false);
		expect(canCreateCatalogSpotifyPlaylist({ creationPending: false })).toBe(true);
	});

	it('does not visibly forget a link when durable removal fails', async () => {
		let state: CatalogPlaylistLinkState = {
			linkedPlaylistId: PLAYLIST_ID,
			creationPending: false
		};
		const persisted = await applyDurableCatalogPlaylistLinkTransition(
			{ creationPending: false },
			state,
			(next) => (state = next),
			async () => false
		);

		expect(persisted).toBe(false);
		expect(state).toEqual({ linkedPlaylistId: PLAYLIST_ID, creationPending: false });
	});

	it('does not let a stale durable transition roll back a replacement show', async () => {
		let active = true;
		let state: CatalogPlaylistLinkState = { creationPending: false };
		const pending = applyDurableCatalogPlaylistLinkTransition(
			{ creationPending: true },
			{ creationPending: false },
			(next) => (state = next),
			async () => {
				active = false;
				state = { linkedPlaylistId: PLAYLIST_ID, creationPending: false };
				return false;
			},
			() => active
		);

		expect(await pending).toBe(false);
		expect(state).toEqual({ linkedPlaylistId: PLAYLIST_ID, creationPending: false });
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
				order: 'oldest-first',
				linkedPlaylistId: PLAYLIST_ID
			},
			{ cooldownUntil: 0, pausedByRateLimit: false }
		);

		catalogEpisode.tracks[0].checked = false;
		expect(snapshot.episodes.episode.tracks[0].checked).toBe(true);
		expect(snapshot.playlist.order).toBe('oldest-first');
		expect(snapshot.playlist.linkedPlaylistId).toBe(PLAYLIST_ID);
	});

	it('resumes only episodes that are not completed', () => {
		const catalog: EpisodeState[] = [
			{ ...episode('done', '2026-01-01'), status: 'done', tracks: [] },
			{ ...episode('pending', '2026-02-01'), status: 'pending', tracks: [] },
			{ ...episode('failed', '2026-03-01'), status: 'error', tracks: [], error: 'failed' }
		];

		expect(getResumableEpisodeIndexes(catalog)).toEqual([1, 2]);
	});

	it('creates a fresh visible reset state without carrying review or cooldown data', () => {
		const state = createCatalogResetState(
			[episode('older', '2026-01-01'), episode('newer', '2026-02-01')],
			{ title: 'Fresh title', description: 'Fresh description' }
		);

		expect(state.episodes).toEqual([
			expect.objectContaining({ episodeAlias: 'older', status: 'pending', tracks: [] }),
			expect.objectContaining({ episodeAlias: 'newer', status: 'pending', tracks: [] })
		]);
		expect(state).toMatchObject({
			playlistOrder: 'latest-first',
			playlist: {
				title: 'Fresh title',
				description: 'Fresh description',
				public: false,
				order: 'latest-first'
			},
			retry: { cooldownUntil: 0, pausedByRateLimit: false }
		});
		expect(state.playlist).not.toHaveProperty('linkedPlaylistId');
		expect(state.playlist).not.toHaveProperty('creationPending');
	});
});

describe('catalogue review filters', () => {
	const candidate = reviewTrack.matches[0];
	const filteredTrack = (
		title: string,
		overrides: Partial<EpisodeState['tracks'][number]> = {}
	): EpisodeState['tracks'][number] => ({
		...reviewTrack,
		title,
		matches: [{ ...candidate }],
		selectedMatch: null,
		checked: false,
		...overrides
	});
	const completedEpisode = (tracks: EpisodeState['tracks']): EpisodeState => ({
		...episode('completed', '2026-01-01'),
		status: 'done',
		tracks
	});

	it('counts scanned track occurrences for every review category', () => {
		const selected = filteredTrack('Selected', {
			confident: true,
			checked: true,
			selectedMatch: candidate.uri
		});
		const primary = filteredTrack('Primary', { fallback: false, confident: false });
		const fallback = filteredTrack('Fallback', { fallback: true, confident: false });
		const noCandidates = filteredTrack('No candidates', {
			matches: [],
			fallback: true,
			confident: false
		});
		const invalidSelection = filteredTrack('Invalid selection', {
			confident: true,
			checked: true,
			selectedMatch: 'spotify:track:not-a-candidate'
		});
		const pending: EpisodeState = {
			...episode('pending', '2026-02-01'),
			status: 'pending',
			tracks: [filteredTrack('Not scanned', { matches: [] })]
		};

		expect(
			getCatalogReviewFilterCounts([
				completedEpisode([selected, primary, fallback, noCandidates, invalidSelection]),
				pending
			])
		).toEqual({
			all: 5,
			selected: 1,
			'primary-review': 1,
			'fallback-review': 1,
			'no-candidates': 1
		});
	});

	it('classifies primary and fallback review independently of checkbox choices', () => {
		const primary = filteredTrack('Primary', {
			fallback: false,
			confident: false,
			checked: true,
			selectedMatch: candidate.uri
		});
		const fallback = filteredTrack('Fallback', {
			fallback: true,
			confident: false,
			checked: true,
			selectedMatch: candidate.uri
		});
		const confident = filteredTrack('Confident', { fallback: false, confident: true });
		const completed = completedEpisode([primary, fallback, confident]);

		expect(getCatalogEpisodeReviewTracks(completed, 'primary-review')).toEqual([primary]);
		expect(getCatalogEpisodeReviewTracks(completed, 'fallback-review')).toEqual([fallback]);
		expect(getCatalogEpisodeReviewTracks(completed, 'selected')).toEqual([primary, fallback]);
	});

	it('preserves track order and keeps incomplete episode states visible', () => {
		const first = filteredTrack('First', { fallback: true });
		const second = filteredTrack('Second', { fallback: false });
		const third = filteredTrack('Third', { fallback: true });
		const completed = completedEpisode([first, second, third]);
		const pending: EpisodeState = {
			...episode('pending', '2026-02-01'),
			status: 'pending',
			tracks: []
		};

		expect(getCatalogEpisodeReviewTracks(completed, 'fallback-review')).toEqual([first, third]);
		expect(shouldShowCatalogEpisodeForReview(completed, 'no-candidates')).toBe(false);
		for (const filter of [
			'all',
			'selected',
			'primary-review',
			'fallback-review',
			'no-candidates'
		] as CatalogReviewFilter[]) {
			expect(shouldShowCatalogEpisodeForReview(pending, filter)).toBe(true);
		}
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

	it('returns interrupted and systemically affected episodes to pending without undoing completed work', () => {
		expect(shouldReturnEpisodeToPending('scanning')).toBe(true);
		expect(shouldReturnEpisodeToPending('rate-limited')).toBe(true);
		expect(shouldReturnEpisodeToPending('error', true)).toBe(true);
		expect(shouldReturnEpisodeToPending('pending', true)).toBe(true);
		expect(shouldReturnEpisodeToPending('done', true)).toBe(false);
		expect(shouldReturnEpisodeToPending('error', false)).toBe(false);
	});

	it('selects distinct sanitized messages for ordinary limits and quota exhaustion', () => {
		expect(formatSpotifyCooldownMessage('rate-limited', 750)).toBe(
			'Spotify rate limit: 12m 30s remaining.'
		);
		expect(formatSpotifyCooldownMessage('quota-exceeded', 30_600)).toBe(
			'Spotify Development Mode quota exhausted: 8h 30m 0s remaining.'
		);
		expect(parseCatalogSpotifyRateLimitReason('quota-exceeded')).toBe('quota-exceeded');
		expect(parseCatalogSpotifyRateLimitReason('QUOTA_EXCEEDED')).toBe('rate-limited');
		expect(isSystemicSpotifyResponseFailure({ error: 'spotify_response_invalid' })).toBe(true);
		expect(
			isSystemicSpotifyResponseFailure({ error: 'spotify_search_unavailable', reason: 'upstream' })
		).toBe(true);
		expect(
			isSystemicSpotifyResponseFailure({
				error: 'spotify_search_unavailable',
				reason: 'request-rejected',
				upstreamStatus: 400
			})
		).toBe(true);
		expect(isSystemicSpotifyResponseFailure({ error: 'other' })).toBe(false);
	});

	it('accepts only Retry-After values that produce safe client deadlines', () => {
		const now = Date.parse('2026-08-15T12:00:00Z');
		expect(parseCatalogRetryAfter({ retryAfterSeconds: 30_785 }, null, now)).toBe(30_785);
		expect(parseCatalogRetryAfter({}, '172800', now)).toBe(172_800);
		expect(parseCatalogRetryAfter({ retryAfterSeconds: 2.5 }, '3', now)).toBe(3);
		expect(parseCatalogRetryAfter({}, '1e3', now)).toBe(1);
		expect(parseCatalogRetryAfter({ retryAfterSeconds: Number.MAX_SAFE_INTEGER }, null, now)).toBe(
			1
		);
		expect(
			parseCatalogRetryAfter(
				{ retryAfterSeconds: Math.floor((Number.MAX_SAFE_INTEGER - now) / 1000) + 1 },
				null,
				now
			)
		).toBe(1);
	});

	it('accepts complete non-negative server metrics and ignores missing or malformed values', () => {
		expect(
			parseSpotifySessionMetrics({
				spotifySessionMetrics: {
					searchRequests: 123,
					cacheHits: 18,
					transientRetries: 4,
					rateLimitResponses: 2,
					quotaExceededResponses: 1
				}
			})
		).toEqual({
			searchRequests: 123,
			cacheHits: 18,
			transientRetries: 4,
			rateLimitResponses: 2,
			quotaExceededResponses: 1
		});
		expect(parseSpotifySessionMetrics({})).toBeNull();
		expect(
			parseSpotifySessionMetrics({
				spotifySessionMetrics: {
					searchRequests: 3,
					cacheHits: 1,
					rateLimitResponses: 0,
					quotaExceededResponses: 0
				}
			})
		).toMatchObject({ transientRetries: 0 });
		expect(
			parseSpotifySessionMetrics({
				spotifySessionMetrics: {
					searchRequests: -1,
					cacheHits: 18,
					rateLimitResponses: 2,
					quotaExceededResponses: 1
				}
			})
		).toBeNull();
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
						requiresManualResume: false,
						reason: 'rate-limited' as const
					});
				}
				return new Promise((resolve) => {
					cancelSibling = () => resolve({ type: 'cancelled' });
				});
			},
			onRateLimit: () => {
				cooldownActive = true;
				cancelSibling?.();
			},
			onSystemicSpotifyFailure: () => undefined
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
			onRateLimit: () => undefined,
			onSystemicSpotifyFailure: () => undefined
		});

		await vi.waitFor(() => expect(started).toEqual([0, 1]));
		controller.abort();
		await running;
		expect(settled).toEqual([0, 1]);
		expect(started).toEqual([0, 1]);
	});

	it('settles both workers and keeps affected and untouched episodes pending after final exhaustion', async () => {
		const controller = new AbortController();
		const started: number[] = [];
		const retried: number[] = [];
		const statuses = ['pending', 'pending', 'pending', 'pending'];
		let settleSibling: (() => void) | undefined;
		const running = runCatalogWorkers({
			indexes: [0, 1, 2, 3],
			concurrency: 2,
			signal: controller.signal,
			waitUntilReady: () => Promise.resolve(),
			scanEpisode: (index) => {
				started.push(index);
				statuses[index] = 'scanning';
				if (index === 0) {
					statuses[index] = 'pending';
					return Promise.resolve({ type: 'systemic-spotify-failure' });
				}
				return new Promise((resolve) => {
					settleSibling = () => {
						statuses[index] = 'pending';
						resolve({ type: 'cancelled' });
					};
				});
			},
			onRateLimit: () => undefined,
			onSystemicSpotifyFailure: (index) => {
				retried.push(index);
				settleSibling?.();
				controller.abort();
			}
		});

		await running;
		expect(started).toEqual([0, 1]);
		expect(retried).toEqual([0]);
		expect(statuses).toEqual(['pending', 'pending', 'pending', 'pending']);
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

	it('uses an uppercase archive title and latest-to-oldest dates for both track orders', () => {
		expect(latest.dateStamp).toBe('06.08.26→20.01.22');
		expect(latest.title).toBe('TEST SHOW — NTS FULL ARCHIVE · 06.08.26→20.01.22');
		expect(latest.description).toBe(
			'A comprehensive archive of tracks played on Test Show on NTS Radio, covering broadcasts from 20 January 2022 through 6 August 2026. Some tracks unavailable on Spotify may be missing.'
		);
		expect(oldest).toEqual(latest);

		const switchedToOldest = updateGeneratedPlaylistText(latest, latest, oldest);
		expect(switchedToOldest).toEqual({ title: oldest.title, description: oldest.description });
		expect(updateGeneratedPlaylistText(switchedToOldest, oldest, latest)).toEqual({
			title: latest.title,
			description: latest.description
		});
	});

	it('extends the exact generated Jim O’Rourke metadata for a future episode', () => {
		const previousEpisodes = [episode('oldest', '2022-01-20'), episode('newest', '2026-08-06')];
		const currentEpisodes = [...previousEpisodes, episode('future', '2026-09-03')];
		const previous = createGeneratedPlaylistText("Jim O'Rourke", previousEpisodes, 'oldest-first');
		const updated = updateGeneratedPlaylistTextForCatalog(
			previous,
			"Jim O'Rourke",
			previousEpisodes,
			currentEpisodes,
			'oldest-first'
		);

		expect(updated).toEqual({
			title: "JIM O'ROURKE — NTS FULL ARCHIVE · 03.09.26→20.01.22",
			description:
				"A comprehensive archive of tracks played on Jim O'Rourke on NTS Radio, covering broadcasts from 20 January 2022 through 3 September 2026. Some tracks unavailable on Spotify may be missing."
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

	it('extends generated date ranges without overwriting independently customized text', () => {
		const previousEpisodes = [episode('oldest', '2022-01-20'), episode('middle', '2024-05-03')];
		const currentEpisodes = [...previousEpisodes, episode('newest', '2026-08-06')];
		const previous = createGeneratedPlaylistText('Test Show', previousEpisodes, 'latest-first');
		const current = createGeneratedPlaylistText('Test Show', currentEpisodes, 'latest-first');

		expect(
			updateGeneratedPlaylistTextForCatalog(
				previous,
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'latest-first'
			)
		).toEqual({ title: current.title, description: current.description });
		expect(
			updateGeneratedPlaylistTextForCatalog(
				{ title: 'Custom title', description: previous.description },
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'latest-first'
			)
		).toEqual({ title: 'Custom title', description: current.description });
		expect(
			updateGeneratedPlaylistTextForCatalog(
				{ title: previous.title, description: 'Custom description' },
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'latest-first'
			)
		).toEqual({ title: current.title, description: 'Custom description' });
	});

	it('migrates exact legacy fields independently while preserving customized fields', () => {
		const previousEpisodes = [episode('oldest', '2022-01-20'), episode('middle', '2024-05-03')];
		const currentEpisodes = [...previousEpisodes, episode('newest', '2026-08-06')];
		const legacy = createLegacyGeneratedPlaylistText('Test Show', previousEpisodes, 'oldest-first');
		const current = createGeneratedPlaylistText('Test Show', currentEpisodes, 'oldest-first');

		expect(
			updateGeneratedPlaylistTextForCatalog(
				legacy,
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'oldest-first'
			)
		).toEqual({ title: current.title, description: current.description });
		expect(
			updateGeneratedPlaylistTextForCatalog(
				{ title: 'Custom title', description: legacy.description },
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'oldest-first'
			)
		).toEqual({ title: 'Custom title', description: current.description });
		expect(
			updateGeneratedPlaylistTextForCatalog(
				{ title: legacy.title, description: 'Custom description' },
				'Test Show',
				previousEpisodes,
				currentEpisodes,
				'oldest-first'
			)
		).toEqual({ title: current.title, description: 'Custom description' });
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
