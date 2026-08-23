import type { Match } from '$lib/types';
import { getTrackPartMismatchWarning } from './part-mismatch';
import {
	catalogTrackMatchesReviewFilter,
	getCatalogReviewFilterCounts,
	type EpisodeState,
	type ReviewTrack
} from './catalog-scan';

export const CATALOG_REVIEW_CSV_COLUMNS = [
	'Show',
	'Episode',
	'Episode date',
	'Track number',
	'NTS artist',
	'NTS title',
	'Review status',
	'Search method',
	'Suggested Spotify artist',
	'Suggested Spotify title',
	'Selected',
	'Candidate count',
	'Spotify URL',
	'Part mismatch',
	'Part mismatch reason'
] as const;

const reviewStatuses = ['primary-review', 'fallback-review', 'no-candidates'] as const;

export type CatalogReviewStatus = typeof reviewStatuses[number];
export type CatalogReviewSearchMethod = 'primary' | 'fallback' | 'none';

export type CatalogReviewCsvRow = {
	show: string;
	episode: string;
	episodeDate: string;
	trackNumber: number;
	ntsArtist: string;
	ntsTitle: string;
	reviewStatus: CatalogReviewStatus;
	searchMethod: CatalogReviewSearchMethod;
	suggestedSpotifyArtist: string;
	suggestedSpotifyTitle: string;
	selected: 'yes' | 'no';
	candidateCount: number;
	spotifyUrl: string;
	partMismatch: 'yes' | 'no';
	partMismatchReason: string;
};

type DownloadAnchor = {
	href: string;
	download: string;
	click: () => void;
	remove: () => void;
};

export type CatalogReviewCsvDownloadDependencies = {
	createObjectUrl: (blob: Blob) => string;
	revokeObjectUrl: (url: string) => void;
	createAnchor: () => DownloadAnchor;
	schedule: (cleanup: () => void) => void;
};

const defaultDownloadDependencies = (): CatalogReviewCsvDownloadDependencies => ({
	createObjectUrl: (blob) => URL.createObjectURL(blob),
	revokeObjectUrl: (url) => URL.revokeObjectURL(url),
	createAnchor: () => {
		const anchor = document.createElement('a');
		document.body.appendChild(anchor);
		return anchor;
	},
	schedule: (cleanup) => void setTimeout(cleanup, 0)
});

const getReviewStatus = (track: ReviewTrack): CatalogReviewStatus | undefined =>
	reviewStatuses.find((status) => catalogTrackMatchesReviewFilter(track, status));

const getSelectedCandidate = (track: ReviewTrack): Match | undefined =>
	track.matches.find((match) => match.uri === track.selectedMatch);

export const getCatalogReviewTrackCount = (episodes: EpisodeState[]) => {
	const counts = getCatalogReviewFilterCounts(episodes);
	return reviewStatuses.reduce((total, status) => total + counts[status], 0);
};

export const getCatalogReviewCsvRows = (
	showName: string,
	episodes: EpisodeState[]
): CatalogReviewCsvRow[] =>
	episodes.flatMap((episode) => {
		if (episode.status !== 'done') return [];
		return episode.tracks.flatMap((track, trackIndex) => {
			const reviewStatus = getReviewStatus(track);
			if (!reviewStatus) return [];
			const selectedCandidate = getSelectedCandidate(track);
			const partMismatch = getTrackPartMismatchWarning(track);
			return [
				{
					show: showName,
					episode: episode.name,
					episodeDate: episode.broadcast.slice(0, 10),
					trackNumber: trackIndex + 1,
					ntsArtist: track.artist,
					ntsTitle: track.title,
					reviewStatus,
					searchMethod:
						reviewStatus === 'no-candidates'
							? 'none'
							: reviewStatus === 'fallback-review'
							? 'fallback'
							: 'primary',
					suggestedSpotifyArtist: selectedCandidate?.artist ?? '',
					suggestedSpotifyTitle: selectedCandidate?.title ?? '',
					selected: catalogTrackMatchesReviewFilter(track, 'selected') ? 'yes' : 'no',
					candidateCount: track.matches.length,
					spotifyUrl: selectedCandidate?.href ?? '',
					partMismatch: partMismatch ? 'yes' : 'no',
					partMismatchReason: partMismatch?.reason ?? ''
				}
			];
		});
	});

const protectSpreadsheetCell = (value: string) =>
	/^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

const encodeCsvCell = (value: string | number) => {
	const normalized = String(value).replace(/\r\n|\r|\n/g, '\r\n');
	return `"${protectSpreadsheetCell(normalized).replace(/"/g, '""')}"`;
};

const rowValues = (row: CatalogReviewCsvRow) => [
	row.show,
	row.episode,
	row.episodeDate,
	row.trackNumber,
	row.ntsArtist,
	row.ntsTitle,
	row.reviewStatus,
	row.searchMethod,
	row.suggestedSpotifyArtist,
	row.suggestedSpotifyTitle,
	row.selected,
	row.candidateCount,
	row.spotifyUrl,
	row.partMismatch,
	row.partMismatchReason
];

export const serializeCatalogReviewCsv = (rows: CatalogReviewCsvRow[]) =>
	`\uFEFF${[CATALOG_REVIEW_CSV_COLUMNS, ...rows.map(rowValues)]
		.map((row) => row.map(encodeCsvCell).join(','))
		.join('\r\n')}\r\n`;

export const catalogReviewCsvFilename = (showAlias: string, date = new Date()) => {
	const safeAlias = showAlias.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 120) || 'nts-show';
	return `${safeAlias}-review-${date.toISOString().slice(0, 10)}.csv`;
};

export const downloadCatalogReviewCsv = (
	showName: string,
	showAlias: string,
	episodes: EpisodeState[],
	date = new Date(),
	dependencies: CatalogReviewCsvDownloadDependencies = defaultDownloadDependencies()
) => {
	const rows = getCatalogReviewCsvRows(showName, episodes);
	if (rows.length === 0) return false;

	const blob = new Blob([serializeCatalogReviewCsv(rows)], { type: 'text/csv;charset=utf-8' });
	let objectUrl: string | undefined;
	let anchor: DownloadAnchor | undefined;
	let clicked = false;
	try {
		objectUrl = dependencies.createObjectUrl(blob);
		anchor = dependencies.createAnchor();
		anchor.href = objectUrl;
		anchor.download = catalogReviewCsvFilename(showAlias, date);
		anchor.click();
		clicked = true;
		return true;
	} finally {
		anchor?.remove();
		if (objectUrl) {
			if (clicked) {
				const urlToRevoke = objectUrl;
				try {
					dependencies.schedule(() => dependencies.revokeObjectUrl(urlToRevoke));
				} catch {
					dependencies.revokeObjectUrl(urlToRevoke);
				}
			} else {
				dependencies.revokeObjectUrl(objectUrl);
			}
		}
	}
};
