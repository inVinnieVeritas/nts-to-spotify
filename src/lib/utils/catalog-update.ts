import type { NTSShowCatalog, NTSEpisodeSummary } from '$lib/types';
import {
	isCatalogProgressCompatible,
	reconcileEpisodes,
	restoreCatalogPlaylistOrder,
	updateGeneratedPlaylistTextForCatalog,
	type CatalogProgress,
	type EpisodeState
} from './catalog-scan';

const MAX_CATALOG_EPISODES = 5_000;
const MAX_NAME_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_URL_LENGTH = 2_048;
const MAX_GENRES_PER_EPISODE = 100;
const MAX_GENRE_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isBoundedString = (value: unknown, maximum: number, allowEmpty = false): value is string =>
	typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);

const isSafeHttpsUrl = (value: unknown) => {
	if (value === '') return true;
	if (!isBoundedString(value, MAX_URL_LENGTH)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
	} catch {
		return false;
	}
};

const isEpisodeSummary = (value: unknown): value is NTSEpisodeSummary => {
	if (!isRecord(value)) return false;
	return (
		isBoundedString(value.episodeAlias, MAX_NAME_LENGTH) &&
		/^[a-z0-9-]+$/.test(value.episodeAlias) &&
		isBoundedString(value.name, MAX_NAME_LENGTH) &&
		isBoundedString(value.broadcast, 100) &&
		Number.isFinite(Date.parse(value.broadcast)) &&
		isSafeHttpsUrl(value.cover) &&
		Array.isArray(value.genres) &&
		value.genres.length <= MAX_GENRES_PER_EPISODE &&
		value.genres.every((genre) => isBoundedString(genre, MAX_GENRE_LENGTH, true))
	);
};

export const isNTSShowCatalog = (value: unknown): value is NTSShowCatalog => {
	if (!isRecord(value)) return false;
	return (
		isBoundedString(value.showAlias, MAX_NAME_LENGTH) &&
		/^[a-z0-9-]+$/.test(value.showAlias) &&
		isBoundedString(value.name, MAX_NAME_LENGTH) &&
		isBoundedString(value.description, MAX_DESCRIPTION_LENGTH, true) &&
		isSafeHttpsUrl(value.cover) &&
		Array.isArray(value.episodes) &&
		value.episodes.length <= MAX_CATALOG_EPISODES &&
		value.episodes.every(isEpisodeSummary)
	);
};

export const parseNTSShowCatalog = (value: unknown, expectedShowAlias: string) => {
	if (!isNTSShowCatalog(value) || value.showAlias !== expectedShowAlias) {
		throw new Error('Invalid NTS catalogue response');
	}
	return value;
};

const uniqueEpisodes = (episodes: NTSEpisodeSummary[]) => {
	const seen = new Set<string>();
	return episodes.filter(({ episodeAlias }) => {
		if (seen.has(episodeAlias)) return false;
		seen.add(episodeAlias);
		return true;
	});
};

const chronologicalEpisodeSort = (left: EpisodeState, right: EpisodeState) =>
	Date.parse(left.broadcast) - Date.parse(right.broadcast);

export type CatalogUpdateReconciliation = {
	progress: CatalogProgress;
	addedCount: number;
};

export const reconcileSavedCatalogWithNTS = (
	progress: CatalogProgress,
	catalog: NTSShowCatalog,
	now = Date.now()
): CatalogUpdateReconciliation => {
	if (!isCatalogProgressCompatible(progress) || progress.showAlias !== catalog.showAlias) {
		throw new Error('Incompatible catalogue progress');
	}

	const currentEpisodes = uniqueEpisodes(catalog.episodes);
	const savedEpisodes = Object.values(progress.episodes);
	const savedAliases = new Set(savedEpisodes.map(({ episodeAlias }) => episodeAlias));
	const addedCount = currentEpisodes.filter(
		({ episodeAlias }) => !savedAliases.has(episodeAlias)
	).length;
	if (addedCount === 0) return { progress, addedCount };

	const restoredCurrent = reconcileEpisodes(currentEpisodes, progress).map((episode) => {
		const saved = progress.episodes[episode.episodeAlias];
		if (!saved) return episode;
		return {
			...episode,
			status: saved.status,
			tracks: saved.tracks,
			...(saved.error ? { error: saved.error } : {})
		};
	});
	const currentAliases = new Set(restoredCurrent.map(({ episodeAlias }) => episodeAlias));
	const mergedEpisodes = [
		...restoredCurrent,
		...savedEpisodes.filter(({ episodeAlias }) => !currentAliases.has(episodeAlias))
	].sort(chronologicalEpisodeSort);
	const generatedText = updateGeneratedPlaylistTextForCatalog(
		progress.playlist,
		progress.display?.showName || catalog.name,
		savedEpisodes,
		mergedEpisodes,
		restoreCatalogPlaylistOrder(progress)
	);

	return {
		addedCount,
		progress: JSON.parse(
			JSON.stringify({
				...progress,
				updatedAt: now,
				episodes: Object.fromEntries(
					mergedEpisodes.map((episode) => [episode.episodeAlias, episode])
				),
				playlist: { ...progress.playlist, ...generatedText }
			})
		) as CatalogProgress
	};
};
