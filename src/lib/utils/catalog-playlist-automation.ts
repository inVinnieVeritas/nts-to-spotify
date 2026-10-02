import {
	getCatalogExportUris,
	getCatalogReviewFilterCounts,
	isSpotifyPlaylistId,
	type CatalogProgress
} from './catalog-scan';
import type { PlaylistSyncTarget } from './playlist-sync.client';

export const automaticPlaylistTarget = (progress: CatalogProgress): PlaylistSyncTarget => ({
	name: progress.playlist.title,
	description: progress.playlist.description,
	public: progress.playlist.public,
	tracks: getCatalogExportUris(Object.values(progress.episodes), progress.playlist.order)
});

export const automaticReviewCount = (progress: CatalogProgress) =>
	getCatalogReviewFilterCounts(Object.values(progress.episodes))['primary-review'] +
	getCatalogReviewFilterCounts(Object.values(progress.episodes))['fallback-review'] +
	getCatalogReviewFilterCounts(Object.values(progress.episodes))['no-candidates'];

export const AUTOMATION_STATUSES = [
	'off',
	'ready',
	'updated',
	'unchanged',
	'busy',
	'authentication',
	'cooldown',
	'settling',
	'uncertain',
	'external-change',
	'unavailable',
	'progress-changed'
] as const;
export type AutomaticPlaylistStatus = (typeof AUTOMATION_STATUSES)[number];
export type AutomaticPlaylistPublicState = {
	enabled: boolean;
	playlistId: string;
	status: AutomaticPlaylistStatus;
	lastUpdatedAt: number;
	added: number;
	awaitingReview: number;
	retryUntil: number;
};
export const isAutomaticPlaylistPublicState = (
	value: unknown
): value is AutomaticPlaylistPublicState => {
	if (!value || typeof value !== 'object') return false;
	const s = value as AutomaticPlaylistPublicState;
	return (
		typeof s.enabled === 'boolean' &&
		isSpotifyPlaylistId(s.playlistId) &&
		AUTOMATION_STATUSES.includes(s.status) &&
		[s.lastUpdatedAt, s.added, s.awaitingReview, s.retryUntil].every(
			(v) => Number.isSafeInteger(v) && v >= 0
		)
	);
};
export const automaticPlaylistStatusText = (s: AutomaticPlaylistPublicState) =>
	({
		off: 'Automatic playlist updates are off.',
		ready: 'Automatic playlist updates are enabled.',
		updated: 'The linked playlist was updated automatically.',
		unchanged: 'The selected playlist contents have not changed.',
		busy: 'Another scan or playlist action is active. A later scheduled run can try again.',
		authentication: 'Reconnect background Spotify authorization. Saved progress is safe.',
		cooldown: 'Spotify updates are waiting for the saved cooldown.',
		settling: 'Waiting for Spotify to show the acknowledged update.',
		uncertain:
			'An earlier Spotify write outcome is uncertain. Automatic writes are blocked; inspect the playlist manually.',
		'external-change':
			'Spotify changed outside the expected update. Review and manually synchronize before enabling again.',
		unavailable: 'Playlist updating stopped safely. Check authorization and try again later.',
		'progress-changed':
			'Catalogue selections changed. The saved operation must be reviewed before another automatic update.'
	})[s.status];
