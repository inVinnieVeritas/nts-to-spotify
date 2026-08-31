import { catalogBackupFilename, downloadCatalogProgressFile } from './catalog-backup.client';
import type { NTSShowCatalog } from '$lib/types';
import {
	getCatalogSummaryCounts,
	restoreCatalogCreationPending,
	restoreCatalogLinkedPlaylistId,
	spotifyPlaylistUrl,
	uniqueSpotifyUris,
	type CatalogProgress
} from './catalog-scan';
import { parseNTSShowCatalog, reconcileSavedCatalogWithNTS } from './catalog-update';
import { updateCatalogProgress } from './catalog-progress.client';
import { fetchWithTimeout, type Fetcher } from './request';
import { parseOfficialNTSArtworkUrl } from './artwork';
import {
	getLatestCatalogScanSession,
	type FinalizedCatalogScanSession
} from './catalog-scan-session';

const CATALOGUE_CHECK_TIMEOUT_MS = 35_000;

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
	lastScanSession?: FinalizedCatalogScanSession;
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
	parseOfficialNTSArtworkUrl(progress.display?.showCover) ||
	Object.values(progress.episodes)
		.map(({ cover }) => parseOfficialNTSArtworkUrl(cover))
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
	const lastScanSession = getLatestCatalogScanSession(progress.scanTiming);
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
		creationPending: restoreCatalogCreationPending(progress),
		...(lastScanSession ? { lastScanSession } : {})
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

export type SavedCatalogUpdateCheckOutcome =
	| { type: 'up-to-date'; progress: CatalogProgress }
	| { type: 'updated'; progress: CatalogProgress; addedCount: number }
	| { type: 'check-failed' }
	| { type: 'save-failed' }
	| { type: 'already-checking' };

export const applySavedCatalogUpdateOutcome = (
	cards: SavedCatalogCard[],
	outcome: SavedCatalogUpdateCheckOutcome
) => {
	if (outcome.type !== 'updated') return cards;
	const updatedCard = createSavedCatalogCard(outcome.progress);
	return [
		...cards.filter(({ showAlias }) => showAlias !== updatedCard.showAlias),
		updatedCard
	].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const fetchSavedCatalogCurrentNTS = async (
	showAlias: string,
	request: Fetcher = fetch
): Promise<NTSShowCatalog> =>
	fetchWithTimeout(
		request,
		'/api/nts/catalogue',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ showAlias })
		},
		CATALOGUE_CHECK_TIMEOUT_MS,
		async (response) => {
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error('NTS catalogue check failed');
			}
			const body = (await response.json()) as { catalog?: unknown };
			return parseNTSShowCatalog(body.catalog, showAlias);
		}
	);

type CatalogUpdateCheckerDependencies = {
	loadCurrentCatalog?: (showAlias: string) => Promise<NTSShowCatalog>;
	updateProgress?: (
		showAlias: string,
		update: (current: CatalogProgress) => CatalogProgress
	) => Promise<CatalogProgress>;
};

export const createSavedCatalogUpdateChecker = ({
	loadCurrentCatalog = fetchSavedCatalogCurrentNTS,
	updateProgress = updateCatalogProgress
}: CatalogUpdateCheckerDependencies = {}) => {
	const activeChecks = new Set<string>();

	return {
		isChecking: (showAlias: string) => activeChecks.has(showAlias),
		check: async (showAlias: string): Promise<SavedCatalogUpdateCheckOutcome> => {
			if (activeChecks.has(showAlias)) return { type: 'already-checking' };
			activeChecks.add(showAlias);
			try {
				let catalog: NTSShowCatalog;
				try {
					catalog = await loadCurrentCatalog(showAlias);
				} catch {
					return { type: 'check-failed' };
				}

				let addedCount = 0;
				let preparedAddition = false;
				try {
					const progress = await updateProgress(showAlias, (current) => {
						const reconciled = reconcileSavedCatalogWithNTS(current, catalog);
						addedCount = reconciled.addedCount;
						preparedAddition = addedCount > 0;
						return reconciled.progress;
					});
					return addedCount > 0
						? { type: 'updated', progress, addedCount }
						: { type: 'up-to-date', progress };
				} catch {
					return { type: preparedAddition ? 'save-failed' : 'check-failed' };
				}
			} finally {
				activeChecks.delete(showAlias);
			}
		}
	};
};
