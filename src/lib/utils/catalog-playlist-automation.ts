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

export const AUTOMATIC_PLAYLIST_SAVE_ERRORS = {
	playlist_busy:
		'Another scan or playlist action is active. Wait for it to finish, then try again.',
	playlist_manual_wait:
		'A temporary hold after a manual playlist action is still active. Wait before enabling automatic updates.',
	spotify_rate_limited: 'Spotify playlist access is waiting for the saved cooldown.',
	playlist_sync_incomplete:
		'An earlier automatic playlist operation is unfinished. Pause automatic updates and finish manual synchronization before enabling again.',
	playlist_sync_uncertain:
		'An earlier Spotify write has an uncertain outcome. Inspect the linked playlist and review its synchronization status before enabling automatic updates.',
	save_cloud_progress_first:
		'Save this catalogue to cloud progress before enabling automatic updates.',
	linked_playlist_required:
		'The saved cloud progress needs a linked app-created Spotify playlist with creation completed. Finish linking the playlist and save cloud progress.',
	playlist_managed_elsewhere:
		'This Spotify playlist is already managed by another catalogue. Pause that catalogue before enabling updates here.',
	app_created_confirmation_required:
		'Confirm that the linked Spotify playlist was created by this app.',
	playlist_sync_required:
		'The linked Spotify playlist does not match the saved cloud tracks or playlist settings. Use Compare with Spotify, finish manual synchronization, and save cloud progress before enabling.',
	playlist_not_owned: 'The linked playlist is not owned by the configured Spotify account.',
	playlist_not_found: 'Spotify could not find the linked playlist. Check its link before enabling.',
	playlist_inaccessible:
		'Spotify denied access to the linked playlist. Check playlist access and Spotify permissions.',
	playlist_settings_invalid:
		'The saved cloud playlist settings or selected tracks are invalid. Review them and save cloud progress.',
	spotify_authentication:
		'Background Spotify authorization is missing, expired, or revoked. Reauthorize background Spotify, then try again.',
	spotify_unavailable: 'Spotify could not verify the linked playlist. Try again later.',
	cloud_progress_conflict:
		'Cloud progress or playlist settings changed during this check. Refresh the catalogue and resolve any cloud conflict before trying again.',
	cloud_progress_unavailable: 'Cloud progress could not be read or saved. Try again later.',
	not_authorized: 'Your app session has expired. Sign in with Spotify again.',
	invalid_origin: 'This action must be made from the signed-in app. Reload the page and try again.',
	invalid_request: 'The settings request was invalid. Reload the page and try again.',
	authorization_unavailable:
		'Background Spotify authorization could not be saved. Try again later.',
	automation_disabled: 'Automatic playlist updates are unavailable on this installation.',
	automation_unavailable: 'Automatic playlist settings could not be saved. Try again later.'
} as const;

export type AutomaticPlaylistSaveErrorCode = keyof typeof AUTOMATIC_PLAYLIST_SAVE_ERRORS;

export const automaticPlaylistSaveFeedback = (value: unknown, now = Date.now()) => {
	const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	const code = body?.error;
	const known = typeof code === 'string' && Object.hasOwn(AUTOMATIC_PLAYLIST_SAVE_ERRORS, code);
	const deadline = body?.retryUntil;
	return {
		message: known
			? AUTOMATIC_PLAYLIST_SAVE_ERRORS[code as AutomaticPlaylistSaveErrorCode]
			: AUTOMATIC_PLAYLIST_SAVE_ERRORS.automation_unavailable,
		retryUntil:
			known &&
			['spotify_rate_limited', 'playlist_manual_wait'].includes(code) &&
			typeof deadline === 'number' &&
			Number.isSafeInteger(deadline) &&
			deadline > now
				? deadline
				: 0
	};
};

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
