import { catalogBackupFilename, downloadCatalogProgressFile } from './catalog-backup.client';
import {
	getCatalogSummaryCounts,
	restoreCatalogCreationPending,
	restoreCatalogLinkedPlaylistId,
	spotifyPlaylistUrl,
	uniqueSpotifyUris,
	type CatalogProgress
} from './catalog-scan';

export type SavedCatalogCard = {
	record: CatalogProgress;
	showAlias: string;
	showName: string;
	showCover?: string;
	scanned: number;
	pending: number;
	failed: number;
	uniqueSelectedTracks: number;
	duplicateTracks: number;
	updatedAt: number;
	linkedPlaylistUrl?: string;
	creationPending: boolean;
};

const safeHttpsUrl = (value: unknown) => {
	if (typeof value !== 'string' || value.length > 2_048) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password
			? value
			: undefined;
	} catch {
		return undefined;
	}
};

export const catalogDisplayName = (progress: CatalogProgress) => {
	const storedName = progress.display?.showName.trim();
	if (storedName) return storedName;
	const fallback = progress.showAlias
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
	return fallback || 'Saved NTS catalogue';
};

const catalogDisplayCover = (progress: CatalogProgress) =>
	safeHttpsUrl(progress.display?.showCover) ||
	Object.values(progress.episodes)
		.map(({ cover }) => safeHttpsUrl(cover))
		.find((cover): cover is string => Boolean(cover));

export const createSavedCatalogCard = (progress: CatalogProgress): SavedCatalogCard => {
	const episodes = Object.values(progress.episodes);
	const counts = getCatalogSummaryCounts(episodes);
	const selectedOccurrences = episodes.flatMap(({ tracks }) =>
		tracks
			.filter(({ checked, selectedMatch }) => checked && selectedMatch !== null)
			.map(({ selectedMatch }) => selectedMatch as string)
	);
	const uniqueSelected = uniqueSpotifyUris(selectedOccurrences);
	const linkedPlaylistId = restoreCatalogLinkedPlaylistId(progress);
	const showCover = catalogDisplayCover(progress);
	return {
		record: progress,
		showAlias: progress.showAlias,
		showName: catalogDisplayName(progress),
		...(showCover ? { showCover } : {}),
		scanned: counts.scanned,
		pending: counts.pending,
		failed: counts.failed,
		uniqueSelectedTracks: uniqueSelected.length,
		duplicateTracks: selectedOccurrences.length - uniqueSelected.length,
		updatedAt: progress.updatedAt,
		...(linkedPlaylistId ? { linkedPlaylistUrl: spotifyPlaylistUrl(linkedPlaylistId) } : {}),
		creationPending: restoreCatalogCreationPending(progress)
	};
};

export const createSavedCatalogCards = (records: CatalogProgress[]) =>
	records.map(createSavedCatalogCard).sort((left, right) => right.updatedAt - left.updatedAt);

export const downloadSavedCatalogProgress = (
	record: CatalogProgress,
	download: (progress: CatalogProgress, filename: string) => void = downloadCatalogProgressFile
) => download(record, catalogBackupFilename(record.showAlias));

export const deleteSavedCatalogProgressIfConfirmed = async (
	card: Pick<SavedCatalogCard, 'showAlias' | 'showName'>,
	{
		confirm,
		remove
	}: {
		confirm: (message: string) => boolean;
		remove: (showAlias: string) => Promise<void>;
	}
) => {
	if (
		!confirm(
			`Delete local progress for “${card.showName}”? This deletes only browser progress and does not delete the Spotify playlist.`
		)
	) {
		return false;
	}
	await remove(card.showAlias);
	return true;
};
