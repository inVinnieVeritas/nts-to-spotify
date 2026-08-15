import type { MatchedTrack, NTSEpisodeSummary, URI } from '$lib/types';
import { isAbortError } from './abort';

export const CATALOG_PROGRESS_SCHEMA_VERSION = 2;
export const SPOTIFY_MATCHER_VERSION = 1;
const LEGACY_CATALOG_PROGRESS_SCHEMA_VERSION = 1;

export type ReviewTrack = MatchedTrack & {
	selectedMatch: URI | null;
	checked: boolean;
};

export type EpisodeStatus = 'pending' | 'scanning' | 'done' | 'error' | 'rate-limited';

export type CatalogScanOutcome =
	| { type: 'done' }
	| { type: 'failed' }
	| { type: 'cancelled' }
	| { type: 'rate-limited'; retryAfterSeconds: number; requiresManualResume: boolean };

export type EpisodeState = NTSEpisodeSummary & {
	status: EpisodeStatus;
	tracks: ReviewTrack[];
	error?: string;
};

export type PlaylistOrder = 'latest-first' | 'oldest-first';

export type GeneratedPlaylistText = {
	title: string;
	description: string;
	dateStamp: string;
};

export type PlaylistDraft = {
	title: string;
	description: string;
	public: boolean;
	order?: PlaylistOrder;
};

export type CatalogRetryState = {
	cooldownUntil: number;
	pausedByRateLimit: boolean;
};

export type CatalogProgress = {
	schemaVersion: number;
	matcherVersion: number;
	showAlias: string;
	updatedAt: number;
	episodes: Record<string, EpisodeState>;
	playlist: PlaylistDraft;
	retry?: CatalogRetryState;
};

const freshEpisode = (episode: NTSEpisodeSummary): EpisodeState => ({
	...episode,
	status: 'pending',
	tracks: []
});

export const reconcileEpisodes = (
	catalog: NTSEpisodeSummary[],
	progress?: CatalogProgress | null
): EpisodeState[] => {
	const compatible = isCatalogProgressCompatible(progress);

	return catalog.map((episode) => {
		const saved = compatible ? progress?.episodes[episode.episodeAlias] : undefined;
		if (!saved) return freshEpisode(episode);

		return {
			...episode,
			status:
				saved.status === 'scanning' || saved.status === 'rate-limited' ? 'pending' : saved.status,
			tracks: saved.tracks,
			error: saved.status === 'error' ? saved.error : undefined
		};
	});
};

export const isCatalogProgressCompatible = (
	progress?: CatalogProgress | null
): progress is CatalogProgress =>
	Boolean(
		progress &&
			(progress.schemaVersion === CATALOG_PROGRESS_SCHEMA_VERSION ||
				progress.schemaVersion === LEGACY_CATALOG_PROGRESS_SCHEMA_VERSION) &&
			progress.matcherVersion === SPOTIFY_MATCHER_VERSION
	);

export const restoreCatalogRetryState = (
	progress?: CatalogProgress | null,
	now = Date.now()
): CatalogRetryState => {
	if (!isCatalogProgressCompatible(progress)) {
		return { cooldownUntil: 0, pausedByRateLimit: false };
	}

	const cooldownUntil = progress?.retry?.cooldownUntil;
	if (!Number.isFinite(cooldownUntil) || (cooldownUntil as number) <= now) {
		return { cooldownUntil: 0, pausedByRateLimit: false };
	}

	return {
		cooldownUntil: cooldownUntil as number,
		pausedByRateLimit: Boolean(progress?.retry?.pausedByRateLimit)
	};
};

export const restoreCatalogPlaylistOrder = (progress?: CatalogProgress | null): PlaylistOrder =>
	isCatalogProgressCompatible(progress) && progress.playlist.order === 'oldest-first'
		? 'oldest-first'
		: 'latest-first';

export const createCatalogResetState = (
	catalog: NTSEpisodeSummary[],
	playlist: Pick<PlaylistDraft, 'title' | 'description'>
) => ({
	episodes: reconcileEpisodes(catalog),
	playlistOrder: 'latest-first' as const,
	retry: { cooldownUntil: 0, pausedByRateLimit: false },
	playlist: { ...playlist, public: false, order: 'latest-first' as const }
});

const shortPlaylistDate = (date: string) => {
	const [year, month, day] = date.slice(0, 10).split('-');
	return `${day}.${month}.${year.slice(2)}`;
};

const longPlaylistDate = (date: string) =>
	new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(new Date(date));

export const createGeneratedPlaylistText = (
	showName: string,
	episodes: Array<Pick<NTSEpisodeSummary, 'broadcast'>>,
	order: PlaylistOrder
): GeneratedPlaylistText => {
	const orderedEpisodes = [...episodes].sort((left, right) =>
		order === 'oldest-first'
			? Date.parse(left.broadcast) - Date.parse(right.broadcast)
			: Date.parse(right.broadcast) - Date.parse(left.broadcast)
	);
	const first = orderedEpisodes[0];
	const last = orderedEpisodes[orderedEpisodes.length - 1];
	const chronologicalEpisodes = [...episodes].sort(
		(left, right) => Date.parse(left.broadcast) - Date.parse(right.broadcast)
	);
	const oldest = chronologicalEpisodes[0];
	const newest = chronologicalEpisodes[chronologicalEpisodes.length - 1];
	const dateStamp =
		first && last
			? `${shortPlaylistDate(first.broadcast)}→${shortPlaylistDate(last.broadcast)}`
			: '';
	const normalizedName = showName.toLowerCase();

	return {
		title: `“${normalizedName}” ${dateStamp}`,
		description:
			first && last && oldest && newest
				? `“${normalizedName}” ${dateStamp} — A comprehensive archive of tracks played on ${showName} on NTS Radio, covering broadcasts from ${longPlaylistDate(
						oldest.broadcast
				  )} through ${longPlaylistDate(
						newest.broadcast
				  )}. Some tracks unavailable on Spotify may be missing.`
				: `Tracks played on ${showName} on NTS Radio. Some tracks unavailable on Spotify may be missing.`,
		dateStamp
	};
};

export const updateGeneratedPlaylistText = (
	current: Pick<GeneratedPlaylistText, 'title' | 'description'>,
	previousGenerated: GeneratedPlaylistText,
	nextGenerated: GeneratedPlaylistText
) => ({
	title: current.title === previousGenerated.title ? nextGenerated.title : current.title,
	description:
		current.description === previousGenerated.description
			? nextGenerated.description
			: current.description
});

export const shouldApplyCatalogRestoration = (
	requestedAlias: string,
	requestedGeneration: number,
	activeAlias: string,
	activeGeneration: number
) => requestedAlias === activeAlias && requestedGeneration === activeGeneration;

export const createCatalogProgress = (
	showAlias: string,
	episodes: EpisodeState[],
	playlist: PlaylistDraft,
	retry: CatalogRetryState = { cooldownUntil: 0, pausedByRateLimit: false }
): CatalogProgress => ({
	schemaVersion: CATALOG_PROGRESS_SCHEMA_VERSION,
	matcherVersion: SPOTIFY_MATCHER_VERSION,
	showAlias,
	updatedAt: Date.now(),
	episodes: Object.fromEntries(episodes.map((episode) => [episode.episodeAlias, episode])),
	playlist,
	retry
});

export const captureCatalogProgress = (
	showAlias: string,
	episodes: EpisodeState[],
	playlist: PlaylistDraft,
	retry?: CatalogRetryState
): CatalogProgress =>
	JSON.parse(
		JSON.stringify(createCatalogProgress(showAlias, episodes, playlist, retry))
	) as CatalogProgress;

export const getResumableEpisodeIndexes = (episodes: EpisodeState[]) =>
	episodes
		.map((episode, index) => ({ episode, index }))
		.filter(({ episode }) => episode.status !== 'done')
		.map(({ index }) => index);

export const getCatalogSummaryCounts = (episodes: Array<Pick<EpisodeState, 'status'>>) =>
	episodes.reduce(
		(counts, episode) => {
			if (episode.status === 'done') counts.scanned += 1;
			else if (episode.status === 'error') counts.failed += 1;
			else counts.pending += 1;
			return counts;
		},
		{ scanned: 0, pending: 0, failed: 0 }
	);

export const formatCooldownDuration = (seconds: number) => {
	const totalSeconds = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const remainingSeconds = totalSeconds % 60;
	const parts: string[] = [];

	if (days > 0) parts.push(`${days}d`);
	if (days > 0 || hours > 0) parts.push(`${hours}h`);
	if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${remainingSeconds}s`);
	return parts.join(' ');
};

export const getCatalogExportUris = (
	episodes: EpisodeState[],
	order: PlaylistOrder = 'latest-first'
) =>
	uniqueSpotifyUris(
		[...episodes]
			.sort((left, right) =>
				order === 'oldest-first'
					? Date.parse(left.broadcast) - Date.parse(right.broadcast)
					: Date.parse(right.broadcast) - Date.parse(left.broadcast)
			)
			.flatMap((episode) =>
				episode.tracks
					.filter((track) => track.checked && track.selectedMatch)
					.map((track) => track.selectedMatch as string)
			)
	);

export const runCatalogWorkers = async ({
	indexes,
	concurrency,
	signal,
	waitUntilReady,
	scanEpisode,
	onRateLimit
}: {
	indexes: number[];
	concurrency: number;
	signal: AbortSignal;
	waitUntilReady: (signal: AbortSignal) => Promise<void>;
	scanEpisode: (index: number, signal: AbortSignal) => Promise<CatalogScanOutcome>;
	onRateLimit: (
		index: number,
		outcome: Extract<CatalogScanOutcome, { type: 'rate-limited' }>
	) => void;
}) => {
	const queue = [...indexes];
	const queued = new Set(queue);
	const active = new Set<number>();
	const enqueue = (index: number) => {
		if (!queued.has(index) && !active.has(index)) {
			queue.push(index);
			queued.add(index);
		}
	};
	const dequeue = () => {
		const index = queue.shift();
		if (index !== undefined) {
			queued.delete(index);
			active.add(index);
		}
		return index;
	};

	const worker = async () => {
		while (!signal.aborted) {
			await waitUntilReady(signal);
			if (signal.aborted) return;
			const index = dequeue();
			if (index === undefined) return;
			const outcome = await scanEpisode(index, signal);
			active.delete(index);

			if (outcome.type === 'rate-limited') {
				enqueue(index);
				onRateLimit(index, outcome);
			} else if (outcome.type === 'cancelled' && !signal.aborted) {
				enqueue(index);
			}
		}
	};

	const settled = await Promise.allSettled(
		Array.from({ length: Math.min(concurrency, queue.length) }, worker)
	);
	const failure = settled.find(
		(result): result is PromiseRejectedResult =>
			result.status === 'rejected' && !isAbortError(result.reason)
	);
	if (failure) throw failure.reason;
};

export const uniqueSpotifyUris = (uris: string[]) => Array.from(new Set(uris));
