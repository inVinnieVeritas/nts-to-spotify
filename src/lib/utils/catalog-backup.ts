import type { Match, NTSEpisodeSummary } from '$lib/types';
import {
	CATALOG_PROGRESS_SCHEMA_VERSION,
	SPOTIFY_MATCHER_VERSION,
	isCatalogProgressCompatible,
	reconcileEpisodes,
	restoreCatalogCreationPending,
	restoreCatalogPlaylistOrder,
	restoreCatalogLinkedPlaylistId,
	restoreCatalogRetryState,
	type CatalogProgress,
	type CatalogDisplayMetadata,
	type EpisodeState,
	type PlaylistDraft,
	type PlaylistOrder,
	type ReviewTrack
} from './catalog-scan';

export const CATALOG_BACKUP_FORMAT = 'nts-to-spotify-catalog-progress';
export const CATALOG_BACKUP_VERSION = 1;
export const CATALOG_BACKUP_MAX_BYTES = 10 * 1024 * 1024;
// Spotify has returned multi-hour cooldowns in production; one year preserves extreme legitimate
// values while rejecting timestamps that would effectively disable scanning forever.
export const CATALOG_BACKUP_MAX_COOLDOWN_MS = 366 * 24 * 60 * 60 * 1000;

// Export and snapshot timestamps come from the same browser clock, with a small skew allowance.
const CATALOG_BACKUP_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CATALOG_BACKUP_EARLIEST_TIMESTAMP = Date.UTC(2020, 0, 1);
const SPOTIFY_TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const SPOTIFY_PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const STRICT_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EPISODE_STATUSES = new Set(['pending', 'scanning', 'done', 'error', 'rate-limited']);

export type CatalogBackupEnvelope = {
	format: typeof CATALOG_BACKUP_FORMAT;
	version: typeof CATALOG_BACKUP_VERSION;
	exportedAt: string;
	showAlias: string;
	progress: CatalogProgress;
};

export type PreparedCatalogRestore = {
	progress: CatalogProgress;
	episodes: EpisodeState[];
	playlistOrder: PlaylistOrder;
	retry: { cooldownUntil: number; pausedByRateLimit: boolean };
};

export class CatalogBackupValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CatalogBackupValidationError';
	}
}

const invalid = (message: string): never => {
	throw new CatalogBackupValidationError(message);
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return invalid(`${label} must be an object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return invalid(`${label} has an unsupported object shape.`);
	}
	return value as Record<string, unknown>;
};

const assertAllowedKeys = (
	record: Record<string, unknown>,
	allowed: readonly string[],
	label: string
) => {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (DANGEROUS_KEYS.has(key)) invalid(`${label} contains a dangerous key.`);
		if (!allowedKeys.has(key)) invalid(`${label} contains an unsupported field.`);
	}
};

const assertNoDangerousKeys = (value: unknown) => {
	const pending = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== 'object') continue;
		for (const key of Object.keys(current)) {
			if (DANGEROUS_KEYS.has(key)) invalid('The backup contains a dangerous object key.');
			pending.push((current as Record<string, unknown>)[key]);
		}
	}
};

const boundedString = (value: unknown, label: string, maxLength = 20_000) => {
	if (typeof value !== 'string' || value.length > maxLength) {
		return invalid(`${label} must be a valid string.`);
	}
	return value;
};

const requiredString = (value: unknown, label: string, maxLength = 20_000) => {
	const result = boundedString(value, label, maxLength);
	if (result.length === 0) return invalid(`${label} must be a valid string.`);
	return result;
};

const optionalString = (value: unknown, label: string, maxLength = 20_000) => {
	if (value === undefined) return undefined;
	return boundedString(value, label, maxLength);
};

const finiteNumber = (value: unknown, label: string) => {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		!Number.isSafeInteger(value) ||
		value < 0
	) {
		return invalid(`${label} must be a valid number.`);
	}
	return value;
};

const boundedTimestamp = (value: unknown, label: string, minimum: number, maximum: number) => {
	const timestamp = finiteNumber(value, label);
	if (timestamp < minimum || timestamp > maximum) {
		return invalid(`${label} is outside the supported range.`);
	}
	return timestamp;
};

const strictIsoTimestamp = (value: unknown, now: number) => {
	const timestamp = requiredString(value, 'backup.exportedAt', 30);
	if (!STRICT_ISO_TIMESTAMP.test(timestamp)) invalid('backup.exportedAt is invalid.');
	const milliseconds = Date.parse(timestamp);
	if (
		!Number.isSafeInteger(milliseconds) ||
		new Date(milliseconds).toISOString() !== timestamp ||
		milliseconds < CATALOG_BACKUP_EARLIEST_TIMESTAMP ||
		milliseconds > now + CATALOG_BACKUP_MAX_CLOCK_SKEW_MS
	) {
		invalid('backup.exportedAt is invalid.');
	}
	return { timestamp, milliseconds };
};

const spotifyTrackUri = (value: unknown, label: string) => {
	const uri = requiredString(value, label, 64);
	if (!SPOTIFY_TRACK_URI.test(uri)) invalid(`${label} is not a supported Spotify track URI.`);
	return uri;
};

const httpsUrl = (value: unknown, label: string, maxLength = 2_048) => {
	const source = requiredString(value, label, maxLength);
	let parsed: URL;
	try {
		parsed = new URL(source);
	} catch {
		return invalid(`${label} must be a valid HTTPS URL.`);
	}
	if (
		parsed.protocol !== 'https:' ||
		!parsed.hostname ||
		parsed.username.length > 0 ||
		parsed.password.length > 0
	) {
		return invalid(`${label} must be a valid HTTPS URL.`);
	}
	return source;
};

const optionalHttpsUrl = (value: unknown, label: string) => {
	if (value === undefined) return undefined;
	return httpsUrl(value, label);
};

const spotifyTrackLink = (value: unknown, label: string, uri: string) => {
	const source = httpsUrl(value, label);
	const parsed = new URL(source);
	const trackId = SPOTIFY_TRACK_URI.exec(uri)?.[1];
	if (
		parsed.hostname !== 'open.spotify.com' ||
		parsed.port !== '' ||
		parsed.search !== '' ||
		parsed.hash !== '' ||
		parsed.pathname !== `/track/${trackId}`
	) {
		return invalid(`${label} must be an official Spotify track URL.`);
	}
	return source;
};

const requiredBoolean = (value: unknown, label: string) => {
	if (typeof value !== 'boolean') return invalid(`${label} must be a boolean.`);
	return value;
};

const validateMatch = (value: unknown, label: string): Match => {
	const match = asRecord(value, label);
	assertAllowedKeys(match, ['artist', 'title', 'uri', 'preview', 'cover', 'href'], label);
	const uri = spotifyTrackUri(match.uri, `${label}.uri`);
	const validated: Match = {
		artist: boundedString(match.artist, `${label}.artist`),
		title: boundedString(match.title, `${label}.title`),
		uri,
		href: spotifyTrackLink(match.href, `${label}.href`, uri)
	};
	const preview = optionalHttpsUrl(match.preview, `${label}.preview`);
	const cover = optionalHttpsUrl(match.cover, `${label}.cover`);
	if (preview !== undefined) validated.preview = preview;
	if (cover !== undefined) validated.cover = cover;
	return validated;
};

const validateReviewTrack = (value: unknown, label: string): ReviewTrack => {
	const track = asRecord(value, label);
	assertAllowedKeys(
		track,
		['artist', 'title', 'matches', 'confident', 'fallback', 'selectedMatch', 'checked'],
		label
	);
	if (!Array.isArray(track.matches) || track.matches.length > 100) {
		return invalid(`${label}.matches must be a reasonable array.`);
	}
	const matches = track.matches.map((match, index) =>
		validateMatch(match, `${label}.matches[${index}]`)
	);
	const selectedMatch =
		track.selectedMatch === null
			? null
			: spotifyTrackUri(track.selectedMatch, `${label}.selectedMatch`);
	if (selectedMatch !== null && !matches.some((match) => match.uri === selectedMatch)) {
		invalid(`${label}.selectedMatch must reference one of the track matches.`);
	}
	return {
		artist: boundedString(track.artist, `${label}.artist`),
		title: boundedString(track.title, `${label}.title`),
		matches,
		confident: requiredBoolean(track.confident, `${label}.confident`),
		fallback: requiredBoolean(track.fallback, `${label}.fallback`),
		selectedMatch,
		checked: requiredBoolean(track.checked, `${label}.checked`)
	};
};

const validateEpisode = (value: unknown, label: string): EpisodeState => {
	const episode = asRecord(value, label);
	assertAllowedKeys(
		episode,
		['episodeAlias', 'name', 'broadcast', 'cover', 'genres', 'status', 'tracks', 'error'],
		label
	);
	if (!Array.isArray(episode.genres) || episode.genres.length > 100) {
		return invalid(`${label}.genres must be a reasonable array.`);
	}
	if (!Array.isArray(episode.tracks) || episode.tracks.length > 5_000) {
		return invalid(`${label}.tracks must be a reasonable array.`);
	}
	if (typeof episode.status !== 'string' || !EPISODE_STATUSES.has(episode.status)) {
		return invalid(`${label}.status is invalid.`);
	}
	const broadcast = requiredString(episode.broadcast, `${label}.broadcast`, 100);
	if (!Number.isFinite(Date.parse(broadcast))) invalid(`${label}.broadcast is invalid.`);
	const validated: EpisodeState = {
		episodeAlias: requiredString(episode.episodeAlias, `${label}.episodeAlias`, 500),
		name: boundedString(episode.name, `${label}.name`),
		broadcast,
		cover: episode.cover === '' ? '' : httpsUrl(episode.cover, `${label}.cover`),
		genres: episode.genres.map((genre, index) => boundedString(genre, `${label}.genres[${index}]`)),
		status: episode.status as EpisodeState['status'],
		tracks: episode.tracks.map((track, index) =>
			validateReviewTrack(track, `${label}.tracks[${index}]`)
		)
	};
	const error = optionalString(episode.error, `${label}.error`);
	if (error !== undefined) validated.error = error;
	return validated;
};

const validatePlaylist = (value: unknown): PlaylistDraft => {
	const playlist = asRecord(value, 'progress.playlist');
	assertAllowedKeys(
		playlist,
		['title', 'description', 'public', 'order', 'linkedPlaylistId', 'creationPending'],
		'progress.playlist'
	);
	if (
		playlist.order !== undefined &&
		playlist.order !== 'latest-first' &&
		playlist.order !== 'oldest-first'
	) {
		invalid('progress.playlist.order is invalid.');
	}
	const linkedPlaylistId = optionalString(
		playlist.linkedPlaylistId,
		'progress.playlist.linkedPlaylistId',
		22
	);
	if (linkedPlaylistId !== undefined && !SPOTIFY_PLAYLIST_ID.test(linkedPlaylistId)) {
		invalid('progress.playlist.linkedPlaylistId is invalid.');
	}
	if (playlist.creationPending !== undefined && typeof playlist.creationPending !== 'boolean') {
		invalid('progress.playlist.creationPending is invalid.');
	}
	if (linkedPlaylistId && playlist.creationPending === true) {
		invalid('progress.playlist creation state is inconsistent.');
	}
	return {
		title: boundedString(playlist.title, 'progress.playlist.title', 100),
		description:
			typeof playlist.description === 'string' && playlist.description.length <= 300
				? playlist.description
				: invalid('progress.playlist.description must be a valid string.'),
		public: requiredBoolean(playlist.public, 'progress.playlist.public'),
		...(playlist.order ? { order: playlist.order as PlaylistOrder } : {}),
		...(linkedPlaylistId ? { linkedPlaylistId } : {}),
		...(playlist.creationPending === true ? { creationPending: true } : {})
	};
};

const validateProgress = (value: unknown, exportedAt: number): CatalogProgress => {
	const progress = asRecord(value, 'progress');
	assertAllowedKeys(
		progress,
		[
			'schemaVersion',
			'matcherVersion',
			'showAlias',
			'updatedAt',
			'episodes',
			'playlist',
			'retry',
			'display'
		],
		'progress'
	);
	const episodeRecord = asRecord(progress.episodes, 'progress.episodes');
	const episodeEntries = Object.entries(episodeRecord);
	if (episodeEntries.length > 5_000) invalid('progress.episodes contains too many episodes.');
	const episodes: Record<string, EpisodeState> = {};
	for (const [index, [alias, episodeValue]] of episodeEntries.entries()) {
		const episode = validateEpisode(episodeValue, `progress.episodes[${index}]`);
		if (episode.episodeAlias !== alias) invalid('An episode key does not match its alias.');
		episodes[alias] = episode;
	}
	let retry: CatalogProgress['retry'];
	if (progress.retry !== undefined) {
		const retryRecord = asRecord(progress.retry, 'progress.retry');
		assertAllowedKeys(retryRecord, ['cooldownUntil', 'pausedByRateLimit'], 'progress.retry');
		retry = {
			cooldownUntil:
				retryRecord.cooldownUntil === 0
					? 0
					: boundedTimestamp(
							retryRecord.cooldownUntil,
							'progress.retry.cooldownUntil',
							CATALOG_BACKUP_EARLIEST_TIMESTAMP,
							exportedAt + CATALOG_BACKUP_MAX_COOLDOWN_MS
					  ),
			pausedByRateLimit: requiredBoolean(
				retryRecord.pausedByRateLimit,
				'progress.retry.pausedByRateLimit'
			)
		};
	}
	let display: CatalogDisplayMetadata | undefined;
	if (progress.display !== undefined) {
		const displayRecord = asRecord(progress.display, 'progress.display');
		assertAllowedKeys(displayRecord, ['showName', 'showCover'], 'progress.display');
		const showCover = optionalHttpsUrl(displayRecord.showCover, 'progress.display.showCover');
		display = {
			showName: requiredString(displayRecord.showName, 'progress.display.showName', 500),
			...(showCover ? { showCover } : {})
		};
	}
	const validated: CatalogProgress = {
		schemaVersion: finiteNumber(progress.schemaVersion, 'progress.schemaVersion'),
		matcherVersion: finiteNumber(progress.matcherVersion, 'progress.matcherVersion'),
		showAlias: requiredString(progress.showAlias, 'progress.showAlias', 500),
		updatedAt: boundedTimestamp(
			progress.updatedAt,
			'progress.updatedAt',
			CATALOG_BACKUP_EARLIEST_TIMESTAMP,
			exportedAt + CATALOG_BACKUP_MAX_CLOCK_SKEW_MS
		),
		episodes,
		playlist: validatePlaylist(progress.playlist)
	};
	if (retry) validated.retry = retry;
	if (display) validated.display = display;
	return validated;
};

const copyMatch = (match: Match): Match => ({
	artist: match.artist,
	title: match.title,
	uri: match.uri,
	href: match.href,
	...(match.preview !== undefined ? { preview: match.preview } : {}),
	...(match.cover !== undefined ? { cover: match.cover } : {})
});

const copyTrack = (track: ReviewTrack): ReviewTrack => ({
	artist: track.artist,
	title: track.title,
	matches: track.matches.map(copyMatch),
	confident: track.confident,
	fallback: track.fallback,
	selectedMatch: track.selectedMatch,
	checked: track.checked
});

const copyEpisode = (episode: EpisodeState): EpisodeState => ({
	episodeAlias: episode.episodeAlias,
	name: episode.name,
	broadcast: episode.broadcast,
	cover: episode.cover,
	genres: [...episode.genres],
	status: episode.status,
	tracks: episode.tracks.map(copyTrack),
	...(episode.error !== undefined ? { error: episode.error } : {})
});

const copyProgress = (progress: CatalogProgress): CatalogProgress => ({
	schemaVersion: progress.schemaVersion,
	matcherVersion: progress.matcherVersion,
	showAlias: progress.showAlias,
	updatedAt: progress.updatedAt,
	episodes: Object.fromEntries(
		Object.entries(progress.episodes).map(([alias, episode]) => [alias, copyEpisode(episode)])
	),
	playlist: {
		title: progress.playlist.title,
		description: progress.playlist.description,
		public: progress.playlist.public,
		...(progress.playlist.order ? { order: progress.playlist.order } : {}),
		...(restoreCatalogLinkedPlaylistId(progress)
			? { linkedPlaylistId: restoreCatalogLinkedPlaylistId(progress) }
			: {}),
		...(restoreCatalogCreationPending(progress) ? { creationPending: true } : {})
	},
	...(progress.retry
		? {
				retry: {
					cooldownUntil: progress.retry.cooldownUntil,
					pausedByRateLimit: progress.retry.pausedByRateLimit
				}
		  }
		: {}),
	...(progress.display
		? {
				display: {
					showName: progress.display.showName,
					...(progress.display.showCover ? { showCover: progress.display.showCover } : {})
				}
		  }
		: {})
});

export const createCatalogBackup = (
	progress: CatalogProgress,
	exportedAt = new Date()
): CatalogBackupEnvelope => ({
	format: CATALOG_BACKUP_FORMAT,
	version: CATALOG_BACKUP_VERSION,
	exportedAt: exportedAt.toISOString(),
	showAlias: progress.showAlias,
	progress: copyProgress(progress)
});

export const serializeCatalogBackup = (progress: CatalogProgress, exportedAt = new Date()) =>
	JSON.stringify(createCatalogBackup(progress, exportedAt), null, 2);

export const parseCatalogBackup = (
	text: string,
	expectedShowAlias: string,
	now = Date.now()
): CatalogBackupEnvelope => {
	if (new TextEncoder().encode(text).byteLength > CATALOG_BACKUP_MAX_BYTES) {
		return invalid('The backup file is too large.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return invalid('The selected file is not valid JSON.');
	}
	assertNoDangerousKeys(parsed);
	const envelope = asRecord(parsed, 'backup');
	assertAllowedKeys(
		envelope,
		['format', 'version', 'exportedAt', 'showAlias', 'progress'],
		'backup'
	);
	if (envelope.format !== CATALOG_BACKUP_FORMAT)
		invalid('This is not a supported catalogue backup.');
	if (envelope.version !== CATALOG_BACKUP_VERSION) {
		invalid('This catalogue backup version is not supported.');
	}
	const exported = strictIsoTimestamp(envelope.exportedAt, now);
	const showAlias = requiredString(envelope.showAlias, 'backup.showAlias', 500);
	if (showAlias !== expectedShowAlias) invalid('This backup belongs to a different NTS show.');
	const progress = validateProgress(envelope.progress, exported.milliseconds);
	if (progress.showAlias !== showAlias) invalid('The backup show aliases do not match.');
	if (!isCatalogProgressCompatible(progress)) {
		invalid('The catalogue schema or Spotify matcher version is incompatible.');
	}
	return {
		format: CATALOG_BACKUP_FORMAT,
		version: CATALOG_BACKUP_VERSION,
		exportedAt: exported.timestamp,
		showAlias,
		progress
	};
};

export const prepareCatalogBackupRestore = (
	text: string,
	expectedShowAlias: string,
	catalog: NTSEpisodeSummary[],
	now = Date.now()
): PreparedCatalogRestore => {
	const backup = parseCatalogBackup(text, expectedShowAlias, now);
	const episodes = reconcileEpisodes(catalog, backup.progress);
	const retry = restoreCatalogRetryState(backup.progress, now);
	const playlistOrder = restoreCatalogPlaylistOrder(backup.progress);
	const playlist = {
		...backup.progress.playlist,
		order: playlistOrder
	};
	const progress: CatalogProgress = {
		schemaVersion: CATALOG_PROGRESS_SCHEMA_VERSION,
		matcherVersion: SPOTIFY_MATCHER_VERSION,
		showAlias: expectedShowAlias,
		updatedAt: now,
		episodes: Object.fromEntries(episodes.map((episode) => [episode.episodeAlias, episode])),
		playlist,
		retry
	};
	return { progress, episodes, playlistOrder, retry };
};

export const persistAndApplyCatalogRestore = async (
	prepared: PreparedCatalogRestore,
	persist: (progress: CatalogProgress) => Promise<void>,
	apply: (prepared: PreparedCatalogRestore) => void
) => {
	await persist(prepared.progress);
	apply(prepared);
};

export const restoreCatalogProgressIfConfirmed = async (
	prepared: PreparedCatalogRestore,
	{
		confirm,
		beforePersist,
		persist,
		apply
	}: {
		confirm: () => boolean;
		beforePersist: () => void;
		persist: (progress: CatalogProgress) => Promise<void>;
		apply: (prepared: PreparedCatalogRestore) => void;
	}
) => {
	if (!confirm()) return false;
	beforePersist();
	await persistAndApplyCatalogRestore(prepared, persist, apply);
	return true;
};
