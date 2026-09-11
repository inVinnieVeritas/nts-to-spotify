import { isSpotifyPlaylistId, isSafeRetryAfterSeconds } from './catalog-scan';
import { fetchWithTimeout, type Fetcher } from './request';
import { abortableDelay, throwIfAborted } from './abort';
import {
	parseSpotifyPlaylistPreview,
	type ClientSpotifyPlaylistPreview
} from './playlist-preview.client';

export const CATALOG_PLAYLIST_SYNC_VERSION = 1;
export const PLAYLIST_SYNC_BATCH_SIZE = 100;
export const PLAYLIST_SYNC_MAX_TRACKS = 10_000;
export const PLAYLIST_SYNC_REQUEST_TIMEOUT_MS = 5 * 60 * 1000 + 15_000;
export const PLAYLIST_SYNC_LEASE_MS = 6 * 60 * 1000;
// Local-clock skew is tolerated; leases are short and Spotify cooldowns may span days.
export const PLAYLIST_SYNC_CLOCK_SKEW_MS = 60_000;
export const PLAYLIST_SYNC_MAX_RETRY_MS = 30 * 86_400_000;
export const PLAYLIST_SYNC_SETTLE_MS = 30_000;
export const PLAYLIST_SYNC_QUARANTINE_MS = PLAYLIST_SYNC_REQUEST_TIMEOUT_MS;

const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_SNAPSHOT = /^[\x21-\x7e]{1,500}$/;
const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
const SPOTIFY_FINGERPRINT = /^[a-f0-9]{64}$/;

export type CatalogPlaylistSyncPhase =
	| 'creating'
	| 'ready'
	| 'dispatching'
	| 'settling'
	| 'uncertain'
	| 'blocked'
	| 'paused'
	| 'interrupted'
	| 'completed'
	| 'failed';

export type CatalogPlaylistSyncMode = 'created' | 'updated';

export type CatalogPlaylistSyncRecord = {
	version: typeof CATALOG_PLAYLIST_SYNC_VERSION;
	revision: number;
	catalogueAlias: string;
	operationId: string;
	playlistId?: string;
	targetFingerprint: string;
	totalTrackCount: number;
	confirmedPosition: number;
	phase: CatalogPlaylistSyncPhase;
	mode: CatalogPlaylistSyncMode;
	startedAt: number;
	updatedAt: number;
	snapshotId?: string;
	retryUntil?: number;
	restartRequired?: boolean;
	leaseOwner?: string;
	leaseUntil?: number;
	dispatchStartedAt?: number;
	quarantineUntil?: number;
	settleUntil?: number;
	reason?:
		| 'settling'
		| 'uncertain'
		| 'external-change'
		| 'authentication'
		| 'rate-limit'
		| 'unavailable'
		| 'storage';
};

export type PlaylistSyncTarget = {
	name: string;
	description: string;
	public: boolean;
	tracks: string[];
};

// A preview is an observation, not a mutation acknowledgement. Keep its display
// authority in memory without changing the durable recovery record or its lease.
export const playlistSyncRecordStamp = (record: CatalogPlaylistSyncRecord | undefined) =>
	JSON.stringify(
		record ? [record.catalogueAlias, record.playlistId, record.operationId, record.revision] : null
	);

export const latestPlaylistSyncRecord = (
	current: CatalogPlaylistSyncRecord | undefined,
	incoming: CatalogPlaylistSyncRecord | undefined
) =>
	current &&
	incoming &&
	current.catalogueAlias === incoming.catalogueAlias &&
	incoming.revision <= current.revision
		? current
		: incoming;

export const createPlaylistSyncPreviewGuard = () => {
	let generation = 0;
	return {
		begin: (signature: string, record: CatalogPlaylistSyncRecord | undefined) => ({
			generation: ++generation,
			signature,
			stamp: playlistSyncRecordStamp(record)
		}),
		invalidate: () => {
			generation++;
		},
		isCurrent: (
			ticket: { generation: number; signature: string; stamp: string },
			signature: string,
			record: CatalogPlaylistSyncRecord | undefined
		) =>
			ticket.generation === generation &&
			ticket.signature === signature &&
			ticket.stamp === playlistSyncRecordStamp(record)
	};
};

export const playlistSyncFeedback = (
	record: CatalogPlaylistSyncRecord | undefined,
	preview: ClientSpotifyPlaylistPreview | undefined,
	inputSignature: string,
	observedStamp: string | undefined,
	owner: string,
	now = Date.now()
) => {
	const exact = Boolean(
		preview &&
		preview.inputSignature === inputSignature &&
		observedStamp === playlistSyncRecordStamp(record) &&
		preview.synchronized &&
		preview.addedCount === 0 &&
		preview.removedCount === 0 &&
		!preview.orderChanged &&
		!preview.titleChanged &&
		!preview.descriptionChanged &&
		!preview.visibilityChanged
	);
	const eligibility = playlistSyncEligibility(record, owner, now);
	if (exact) {
		const unresolved =
			record &&
			(record.phase === 'uncertain' ||
				record.phase === 'dispatching' ||
				(record.phase === 'blocked' && record.reason === 'uncertain'));
		return {
			historicalStatus: '',
			synchronizedStatus: unresolved
				? 'Spotify currently matches the selected tracks and settings. Further writes remain blocked because an earlier write outcome is unresolved.'
				: eligibility.disabled
					? 'Spotify playlist is already synchronized. The existing synchronization wait still applies.'
					: 'Spotify playlist is already synchronized.'
		};
	}
	return {
		historicalStatus:
			eligibility.label === 'Synchronization active elsewhere'
				? `Synchronization is active elsewhere. Check again in ${eligibility.seconds}s.`
				: record && record.phase !== 'completed'
					? playlistSyncStatusText(record, now)
					: '',
		synchronizedStatus: ''
	};
};

export type PlaylistSyncApiFailure = {
	error: string;
	retryAfterSeconds?: number;
	status: number;
	ambiguous: boolean;
};

const isSafeTimestamp = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const isCatalogPlaylistSyncRecord = (
	value: unknown,
	expectedAlias?: string,
	now = Date.now()
): value is CatalogPlaylistSyncRecord => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const allowed = new Set([
		'version',
		'revision',
		'catalogueAlias',
		'operationId',
		'playlistId',
		'targetFingerprint',
		'totalTrackCount',
		'confirmedPosition',
		'phase',
		'mode',
		'startedAt',
		'updatedAt',
		'snapshotId',
		'retryUntil',
		'restartRequired',
		'leaseOwner',
		'leaseUntil',
		'dispatchStartedAt',
		'quarantineUntil',
		'settleUntil',
		'reason'
	]);
	if (Object.keys(record).some((key) => !allowed.has(key))) return false;
	if (
		record.version !== CATALOG_PLAYLIST_SYNC_VERSION ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision as number) < 0 ||
		typeof record.catalogueAlias !== 'string' ||
		record.catalogueAlias.length === 0 ||
		record.catalogueAlias.length > 200 ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(record.catalogueAlias) ||
		(expectedAlias !== undefined && record.catalogueAlias !== expectedAlias) ||
		typeof record.operationId !== 'string' ||
		!SAFE_ID.test(record.operationId) ||
		typeof record.targetFingerprint !== 'string' ||
		!SPOTIFY_FINGERPRINT.test(record.targetFingerprint) ||
		!Number.isSafeInteger(record.totalTrackCount) ||
		(record.totalTrackCount as number) < 0 ||
		(record.totalTrackCount as number) > PLAYLIST_SYNC_MAX_TRACKS ||
		!Number.isSafeInteger(record.confirmedPosition) ||
		(record.confirmedPosition as number) < 0 ||
		(record.confirmedPosition as number) > (record.totalTrackCount as number) ||
		typeof record.phase !== 'string' ||
		typeof record.mode !== 'string' ||
		![
			'creating',
			'ready',
			'dispatching',
			'settling',
			'uncertain',
			'blocked',
			'paused',
			'interrupted',
			'completed',
			'failed'
		].includes(String(record.phase)) ||
		!['created', 'updated'].includes(String(record.mode)) ||
		!isSafeTimestamp(record.startedAt) ||
		!isSafeTimestamp(record.updatedAt)
	) {
		return false;
	}
	if (
		(record.startedAt as number) > (record.updatedAt as number) ||
		(record.updatedAt as number) > now + PLAYLIST_SYNC_CLOCK_SKEW_MS
	)
		return false;
	if (record.playlistId !== undefined && !isSpotifyPlaylistId(record.playlistId)) return false;
	if (record.phase !== 'creating' && !isSpotifyPlaylistId(record.playlistId)) return false;
	if (
		record.snapshotId !== undefined &&
		(typeof record.snapshotId !== 'string' || !SAFE_SNAPSHOT.test(record.snapshotId))
	)
		return false;
	if (record.retryUntil !== undefined && !isSafeTimestamp(record.retryUntil)) return false;
	if (record.restartRequired !== undefined && typeof record.restartRequired !== 'boolean')
		return false;
	if (
		record.leaseOwner !== undefined &&
		(typeof record.leaseOwner !== 'string' || !SAFE_ID.test(record.leaseOwner))
	)
		return false;
	if (record.leaseUntil !== undefined && !isSafeTimestamp(record.leaseUntil)) return false;
	if ((record.leaseOwner === undefined) !== (record.leaseUntil === undefined)) return false;
	if (
		record.leaseUntil !== undefined &&
		((record.leaseUntil as number) > (record.updatedAt as number) + PLAYLIST_SYNC_LEASE_MS ||
			(record.leaseUntil as number) < (record.updatedAt as number))
	)
		return false;
	if (
		record.retryUntil !== undefined &&
		(record.retryUntil as number) > (record.updatedAt as number) + PLAYLIST_SYNC_MAX_RETRY_MS
	)
		return false;
	if (
		record.reason !== undefined &&
		(typeof record.reason !== 'string' ||
			![
				'settling',
				'uncertain',
				'external-change',
				'authentication',
				'rate-limit',
				'unavailable',
				'storage'
			].includes(record.reason))
	)
		return false;
	for (const key of ['dispatchStartedAt', 'quarantineUntil', 'settleUntil'] as const) {
		if (record[key] !== undefined && !isSafeTimestamp(record[key])) return false;
	}
	if (
		record.dispatchStartedAt !== undefined &&
		((record.dispatchStartedAt as number) < (record.startedAt as number) ||
			(record.dispatchStartedAt as number) > (record.updatedAt as number))
	)
		return false;
	if (
		record.quarantineUntil !== undefined &&
		(record.dispatchStartedAt === undefined ||
			record.quarantineUntil !== (record.dispatchStartedAt as number) + PLAYLIST_SYNC_QUARANTINE_MS)
	)
		return false;
	if (
		['dispatching', 'uncertain'].includes(String(record.phase)) &&
		(record.dispatchStartedAt === undefined || record.quarantineUntil === undefined)
	)
		return false;
	if (
		record.phase === 'settling' &&
		(typeof record.snapshotId !== 'string' || record.settleUntil === undefined)
	)
		return false;
	if (
		record.settleUntil !== undefined &&
		(record.settleUntil as number) > (record.updatedAt as number) + PLAYLIST_SYNC_SETTLE_MS
	)
		return false;
	if (
		record.phase === 'completed' &&
		(record.leaseOwner !== undefined ||
			record.retryUntil !== undefined ||
			record.reason !== undefined)
	)
		return false;
	if (record.phase === 'dispatching' && record.reason !== undefined) return false;
	if (record.phase === 'uncertain' && record.reason !== 'uncertain') return false;
	if (record.phase === 'settling' && record.reason !== 'settling') return false;
	if (
		record.phase === 'paused' &&
		(record.reason !== 'rate-limit' || record.retryUntil === undefined)
	)
		return false;
	if (
		record.phase === 'blocked' &&
		!['uncertain', 'external-change', 'unavailable'].includes(String(record.reason))
	)
		return false;
	if (['creating', 'ready'].includes(String(record.phase)) && record.reason !== undefined)
		return false;
	if (
		record.phase === 'creating' &&
		(record.playlistId !== undefined || record.confirmedPosition !== 0)
	) {
		return false;
	}
	if (record.phase === 'completed' && record.confirmedPosition !== record.totalTrackCount)
		return false;
	if (
		(record.confirmedPosition as number) > 0 &&
		record.phase !== 'creating' &&
		record.snapshotId === undefined &&
		record.restartRequired !== true
	) {
		return false;
	}
	if (record.restartRequired === true && record.confirmedPosition !== 0) return false;
	if (
		record.retryUntil !== undefined &&
		!['paused', 'settling', 'uncertain'].includes(String(record.phase))
	)
		return false;
	return true;
};

export const restoreCatalogPlaylistSyncRecord = (
	value: unknown,
	catalogueAlias: string,
	now = Date.now()
): CatalogPlaylistSyncRecord | undefined => {
	// The earlier local-only record had no revision/dispatch timing. Keep creation
	// ambiguity and linkage, but never turn an unproven legacy prefix into a write.
	if (value && typeof value === 'object' && !Array.isArray(value) && !('revision' in value)) {
		const legacy = value as CatalogPlaylistSyncRecord;
		value = {
			...legacy,
			revision: 0,
			leaseOwner: undefined,
			leaseUntil: undefined,
			...(legacy.phase !== 'creating' && legacy.phase !== 'completed'
				? { phase: 'blocked', reason: 'uncertain', retryUntil: undefined }
				: {})
		};
	}
	if (!isCatalogPlaylistSyncRecord(value, catalogueAlias, now) || !isSafeTimestamp(now))
		return undefined;
	const restored = structuredClone(value);
	for (const key of [
		'playlistId',
		'snapshotId',
		'retryUntil',
		'restartRequired',
		'leaseOwner',
		'leaseUntil',
		'dispatchStartedAt',
		'quarantineUntil',
		'settleUntil',
		'reason'
	] as const) {
		if (restored[key] === undefined) delete restored[key];
	}
	if (restored.retryUntil !== undefined && restored.retryUntil <= now) {
		delete restored.retryUntil;
		if (restored.phase === 'paused') restored.phase = 'ready';
	}
	if (restored.phase === 'dispatching') {
		restored.phase = 'uncertain';
		restored.reason = 'uncertain';
	}
	if ((restored.leaseUntil ?? 0) <= now) {
		delete restored.leaseOwner;
		delete restored.leaseUntil;
	}
	return restored;
};

export const createPlaylistSyncOperationId = (cryptoValue: Crypto = crypto) => {
	if (typeof cryptoValue.randomUUID === 'function') {
		return cryptoValue.randomUUID().replaceAll('-', '_');
	}
	const bytes = new Uint8Array(24);
	cryptoValue.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const fingerprintPlaylistSyncTarget = async (
	playlistId: string,
	target: PlaylistSyncTarget,
	cryptoValue: Crypto = crypto
) => {
	if (
		!isSpotifyPlaylistId(playlistId) ||
		target.name.length === 0 ||
		target.name.length > 100 ||
		target.description.length > 300 ||
		target.tracks.length > PLAYLIST_SYNC_MAX_TRACKS ||
		!target.tracks.every((track) => SPOTIFY_TRACK_URI.test(track))
	) {
		throw new Error('Invalid playlist synchronization target');
	}
	const bytes = new TextEncoder().encode(
		JSON.stringify([playlistId, target.name, target.description, target.public, target.tracks])
	);
	const digest = await cryptoValue.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const playlistSyncBatches = (tracks: readonly string[]) => {
	if (
		tracks.length > PLAYLIST_SYNC_MAX_TRACKS ||
		!tracks.every((track) => SPOTIFY_TRACK_URI.test(track))
	) {
		throw new Error('Invalid playlist synchronization tracks');
	}
	const batches: string[][] = [];
	for (let index = 0; index < tracks.length; index += PLAYLIST_SYNC_BATCH_SIZE) {
		batches.push(tracks.slice(index, index + PLAYLIST_SYNC_BATCH_SIZE));
	}
	return batches;
};

export const safePlaylistRetryDeadline = (seconds: unknown, now = Date.now()) => {
	if (!isSafeRetryAfterSeconds(seconds) || !isSafeTimestamp(now)) return undefined;
	const milliseconds = seconds * 1000;
	if (!Number.isSafeInteger(milliseconds) || milliseconds > PLAYLIST_SYNC_MAX_RETRY_MS)
		return undefined;
	const deadline = now + milliseconds;
	return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
};

export const parsePlaylistSyncApiFailure = async (
	response: Response,
	now = Date.now()
): Promise<PlaylistSyncApiFailure> => {
	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	const error =
		typeof body?.error === 'string' &&
		[
			'spotify_rate_limited',
			'spotify_authentication',
			'spotify_unavailable',
			'playlist_sync_incomplete',
			'playlist_sync_ambiguous',
			'playlist_changed_since_sync',
			'playlist_changed_since_preview',
			'playlist_settling',
			'playlist_not_found',
			'playlist_not_owned',
			'playlist_inaccessible',
			'invalid_request'
		].includes(body.error)
			? body.error
			: 'spotify_unavailable';
	const retryAfterSeconds =
		response.status === 429 &&
		error === 'spotify_rate_limited' &&
		safePlaylistRetryDeadline(body?.retryAfterSeconds, now) !== undefined
			? (body?.retryAfterSeconds as number)
			: undefined;
	return {
		error,
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
		status: response.status,
		ambiguous: error === 'playlist_sync_incomplete' || error === 'playlist_sync_ambiguous'
	};
};

export const requestPlaylistJson = <T>(
	request: Fetcher,
	body: unknown,
	signal?: AbortSignal,
	timeoutMs = PLAYLIST_SYNC_REQUEST_TIMEOUT_MS
) =>
	fetchWithTimeout(
		request,
		'/api/spotify/playlist',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		},
		timeoutMs,
		async (response) => ({ response, body: (await response.json().catch(() => null)) as T | null }),
		signal
	);

export const playlistSyncStatusText = (record: CatalogPlaylistSyncRecord, now = Date.now()) => {
	const count = (value: number) => value.toLocaleString('en-US');
	const remaining = Math.max(
		0,
		Math.ceil((Math.max(record.retryUntil ?? 0, record.quarantineUntil ?? 0) - now) / 1000)
	);
	if (record.phase === 'uncertain' || record.phase === 'dispatching')
		return remaining > 0
			? `Spotify write outcome is uncertain. Read-only verification available in ${remaining}s. No further writes will start.`
			: 'Spotify write outcome is uncertain. Check its state without changing the playlist.';
	if (record.phase === 'blocked' && record.reason === 'uncertain')
		return 'Spotify may still complete an earlier write. Automatic synchronization is blocked; verify the playlist manually. A timeout does not prove cancellation.';
	if (record.phase === 'blocked')
		return 'Spotify has not confirmed the playlist state. Check a fresh preview before continuing.';
	if (record.phase === 'settling')
		return `Waiting for Spotify to confirm the acknowledged state (${count(record.confirmedPosition)} / ${count(record.totalTrackCount)} tracks).${(record.retryUntil ?? 0) > now ? ` Check again in ${Math.ceil((record.retryUntil! - now) / 1000)}s.` : ''}`;
	if (record.reason === 'authentication')
		return 'Spotify login expired. Log in again before resuming synchronization.';
	if (record.phase === 'creating') return 'Creating Spotify playlist…';
	if (record.phase === 'paused' && record.retryUntil && record.retryUntil > now) {
		const seconds = Math.max(0, Math.ceil((record.retryUntil - now) / 1000));
		const days = Math.floor(seconds / 86_400);
		const hours = Math.floor((seconds % 86_400) / 3_600);
		const minutes = Math.floor((seconds % 3_600) / 60);
		const remainder = seconds % 60;
		const duration = [
			days ? `${days}d` : '',
			hours ? `${hours}h` : '',
			minutes ? `${minutes}m` : '',
			`${remainder}s`
		]
			.filter(Boolean)
			.join(' ');
		return `Synchronization paused by Spotify: ${duration} remaining.`;
	}
	if (record.phase === 'ready') {
		return `Synchronizing playlist: ${count(record.confirmedPosition)} / ${count(record.totalTrackCount)} tracks`;
	}
	if (record.phase === 'completed') {
		return `Playlist synchronized with ${count(record.totalTrackCount)} tracks.`;
	}
	if (record.phase === 'interrupted')
		return 'Playlist synchronization was interrupted and can be resumed.';
	return 'Playlist synchronization failed. Retry when ready.';
};

type PlaylistBatchSuccess = {
	playlistId: string;
	confirmedPosition: number;
	totalTrackCount: number;
	snapshotId: string;
};

export const parsePlaylistBatchSuccess = (
	value: unknown,
	playlistId: string,
	totalTrackCount: number,
	expectedPosition: number
): PlaylistBatchSuccess | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const result = value as Record<string, unknown>;
	if (
		result.mode !== 'batch' ||
		result.playlistId !== playlistId ||
		result.totalTrackCount !== totalTrackCount ||
		!Number.isSafeInteger(result.confirmedPosition) ||
		result.confirmedPosition !== expectedPosition ||
		expectedPosition > totalTrackCount ||
		typeof result.snapshotId !== 'string' ||
		!SAFE_SNAPSHOT.test(result.snapshotId)
	) {
		return undefined;
	}
	return {
		playlistId,
		confirmedPosition: result.confirmedPosition as number,
		totalTrackCount,
		snapshotId: result.snapshotId
	};
};

export const persistCreatedPlaylistBeforeSync = async (
	value: unknown,
	persist: (playlistId: string) => Promise<boolean>
) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const result = value as Record<string, unknown>;
	if (
		result.mode !== 'created' ||
		!isSpotifyPlaylistId(result.playlistId) ||
		result.trackCount !== 0 ||
		result.url !== `https://open.spotify.com/playlist/${result.playlistId}`
	) {
		return undefined;
	}
	return (await persist(result.playlistId)) ? result.playlistId : undefined;
};

export type PlaylistSyncRunResult =
	| { type: 'completed'; record: CatalogPlaylistSyncRecord }
	| { type: 'paused'; record: CatalogPlaylistSyncRecord; retryAfterSeconds: number }
	| {
			type: 'interrupted';
			record: CatalogPlaylistSyncRecord;
			error: string;
			readOnlyPreview?: ClientSpotifyPlaylistPreview;
	  };

export const playlistSyncEligibility = (
	record: CatalogPlaylistSyncRecord | undefined,
	owner: string,
	now = Date.now()
) => {
	if (!record) return { disabled: false, seconds: 0, label: 'Preview Spotify update' };
	const foreign = Boolean(
		record.leaseOwner && record.leaseOwner !== owner && (record.leaseUntil ?? 0) > now
	);
	const deadline = foreign
		? record.leaseUntil!
		: Math.max(
				record.retryUntil ?? 0,
				record.phase === 'uncertain' || record.phase === 'dispatching'
					? (record.quarantineUntil ?? 0)
					: 0
			);
	const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
	if (foreign) return { disabled: true, seconds, label: 'Synchronization active elsewhere' };
	if (record.phase === 'blocked' && record.reason === 'uncertain')
		return { disabled: true, seconds: 0, label: 'Manual verification required' };
	if (seconds > 0)
		return {
			disabled: true,
			seconds,
			label: record.phase === 'paused' ? 'Synchronization paused' : 'Waiting to check Spotify'
		};
	return {
		disabled: false,
		seconds: 0,
		label:
			record.phase === 'uncertain' || record.phase === 'dispatching'
				? 'Check uncertain Spotify outcome'
				: record.phase === 'blocked'
					? 'Preview Spotify update'
					: 'Resume Spotify synchronization'
	};
};

export const runPlaylistSyncBatches = async (input: {
	record: CatalogPlaylistSyncRecord;
	target: PlaylistSyncTarget;
	previewFingerprint?: string;
	previewInputSignature?: string;
	request: (body: unknown, signal?: AbortSignal) => Promise<{ response: Response; body: unknown }>;
	persist: (record: CatalogPlaylistSyncRecord) => Promise<CatalogPlaylistSyncRecord | void>;
	now?: () => number;
	delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}): Promise<PlaylistSyncRunResult> => {
	const now = input.now ?? Date.now;
	const delay = input.delay ?? abortableDelay;
	let record = structuredClone(input.record);
	if (!isCatalogPlaylistSyncRecord(record, record.catalogueAlias, now()) || !record.playlistId)
		throw new Error('Invalid playlist synchronization state');
	const playlistId = record.playlistId;
	if (
		input.target.tracks.length !== record.totalTrackCount ||
		(await fingerprintPlaylistSyncTarget(playlistId, input.target)) !== record.targetFingerprint
	)
		throw new Error('Playlist synchronization target changed');

	// Persistence is a CAS boundary; use the returned revision for every later write.
	const save = async (next: CatalogPlaylistSyncRecord) => {
		const persisted = await input.persist(next);
		record = structuredClone(persisted ?? next);
	};
	const stop = async (
		phase: CatalogPlaylistSyncPhase,
		reason: CatalogPlaylistSyncRecord['reason'],
		error: string,
		retryUntil?: number
	): Promise<PlaylistSyncRunResult> => {
		await save({
			...record,
			phase,
			reason,
			updatedAt: now(),
			retryUntil,
			leaseOwner: undefined,
			leaseUntil: undefined
		});
		return retryUntil && reason === 'rate-limit'
			? { type: 'paused', record, retryAfterSeconds: Math.ceil((retryUntil - now()) / 1000) }
			: { type: 'interrupted', record, error };
	};
	const unavailable = async (response: Response, body: unknown, mutation: boolean) => {
		const failure = await parsePlaylistSyncApiFailure(
			new Response(JSON.stringify(body), { status: response.status }),
			now()
		);
		if (failure.retryAfterSeconds)
			return stop(
				'paused',
				'rate-limit',
				failure.error,
				safePlaylistRetryDeadline(failure.retryAfterSeconds, now())
			);
		if (mutation && (failure.ambiguous || response.status >= 500))
			return stop('uncertain', 'uncertain', 'playlist_outcome_uncertain');
		if (response.status === 409) {
			// This response proves the attempted mutation was rejected before dispatch.
			if (record.snapshotId) return stop('settling', 'settling', failure.error, now() + 5_000);
			return stop('blocked', 'external-change', failure.error);
		}
		return stop(
			'interrupted',
			failure.error === 'spotify_authentication' ? 'authentication' : 'unavailable',
			failure.error
		);
	};

	if (record.phase === 'dispatching') {
		await save({ ...record, phase: 'uncertain', reason: 'uncertain', updatedAt: now() });
	}
	if (record.phase === 'blocked')
		return {
			type: 'interrupted',
			record,
			error:
				record.reason === 'uncertain' ? 'playlist_outcome_uncertain' : 'playlist_changed_since_sync'
		};
	if (
		Math.max(
			record.retryUntil ?? 0,
			record.phase === 'uncertain' ? (record.quarantineUntil ?? 0) : 0
		) > now()
	)
		return { type: 'interrupted', record, error: 'playlist_wait_required' };
	if (record.phase === 'uncertain') {
		// No finite local timeout proves that Spotify cancelled a request. Reconcile
		// read-only, then require manual verification; never auto-replace or re-append.
		try {
			const { response, body } = await input.request(
				{ operation: 'preview', playlistId, ...input.target },
				input.signal
			);
			if (!response.ok) {
				const failure = await parsePlaylistSyncApiFailure(
					new Response(JSON.stringify(body), { status: response.status }),
					now()
				);
				return await stop(
					'uncertain',
					'uncertain',
					'playlist_outcome_uncertain',
					failure.retryAfterSeconds
						? safePlaylistRetryDeadline(failure.retryAfterSeconds, now())
						: undefined
				);
			}
			const stopped = await stop('blocked', 'uncertain', 'playlist_outcome_uncertain');
			// Publish a validated read-only observation without treating it as an
			// acknowledgement of the earlier write or releasing its safety block.
			const readOnlyPreview =
				input.previewInputSignature === undefined
					? undefined
					: parseSpotifyPlaylistPreview(body, playlistId, input.previewInputSignature);
			return stopped.type === 'interrupted' ? { ...stopped, readOnlyPreview } : stopped;
		} catch {
			return await stop('uncertain', 'uncertain', 'playlist_outcome_uncertain');
		}
	}
	if (record.retryUntil) {
		const settling = Boolean(record.snapshotId);
		await save({
			...record,
			phase: settling ? 'settling' : 'interrupted',
			reason: settling ? 'settling' : undefined,
			retryUntil: undefined,
			settleUntil: settling
				? record.phase === 'settling'
					? record.settleUntil
					: now() + PLAYLIST_SYNC_SETTLE_MS
				: undefined,
			updatedAt: now()
		});
	}

	// Three read-only probes per action. Further attempts require a user click
	// after a persisted deadline; no unbounded poll or replacement loop.
	const settle = async (): Promise<PlaylistSyncRunResult | undefined> => {
		if (!record.snapshotId) return;
		if (!record.settleUntil)
			await save({
				...record,
				phase: 'settling',
				reason: 'settling',
				settleUntil: now() + PLAYLIST_SYNC_SETTLE_MS,
				updatedAt: now()
			});
		for (let attempt = 0; attempt < 3; attempt++) {
			throwIfAborted(input.signal);
			const { response, body } = await input.request(
				{
					operation: 'settle',
					playlistId,
					expectedSnapshotId: record.snapshotId,
					name: input.target.name,
					description: input.target.description,
					public: input.target.public
				},
				input.signal
			);
			if (response.ok) {
				const value = body as Record<string, unknown> | null;
				if (
					value?.mode !== 'settled' ||
					value.playlistId !== playlistId ||
					value.snapshotId !== record.snapshotId
				)
					return stop('blocked', 'unavailable', 'invalid_response');
				await save({
					...record,
					phase: 'ready',
					reason: undefined,
					retryUntil: undefined,
					updatedAt: now()
				});
				return;
			}
			if (
				response.status !== 409 ||
				(body as Record<string, unknown> | null)?.error !== 'playlist_settling'
			)
				return unavailable(response, body, false);
			if (now() >= record.settleUntil!)
				// Preserve the existing conflict gate. Exhausted settlement reads are
				// unverified state, not proof of an edit; the UI reports that distinction.
				return stop('blocked', 'external-change', 'playlist_state_unverified');
			if (attempt < 2) await delay(1000, input.signal);
		}
		return stop('settling', 'settling', 'playlist_settling', now() + 5_000);
	};

	let mutationOutstanding = false;
	try {
		if (record.snapshotId && !record.restartRequired) {
			const waiting = await settle();
			if (waiting) return waiting;
		}
		let first = record.confirmedPosition === 0 || record.restartRequired === true;
		while (first || record.confirmedPosition < record.totalTrackCount) {
			throwIfAborted(input.signal);
			if (
				first &&
				(!input.previewFingerprint || !SPOTIFY_FINGERPRINT.test(input.previewFingerprint))
			)
				return stop('blocked', 'external-change', 'playlist_preview_required');
			const position = first ? 0 : record.confirmedPosition;
			const tracks = input.target.tracks.slice(position, position + PLAYLIST_SYNC_BATCH_SIZE);
			const dispatched = now();
			await save({
				...record,
				phase: 'dispatching',
				reason: undefined,
				retryUntil: undefined,
				updatedAt: dispatched,
				dispatchStartedAt: dispatched,
				quarantineUntil: dispatched + PLAYLIST_SYNC_QUARANTINE_MS
			});
			mutationOutstanding = true;
			const { response, body } = await input.request(
				first
					? {
							operation: 'apply-batch',
							playlistId,
							previewFingerprint: input.previewFingerprint,
							...input.target
						}
					: {
							operation: 'append',
							playlistId,
							operationId: record.operationId,
							targetFingerprint: record.targetFingerprint,
							expectedSnapshotId: record.snapshotId,
							position,
							totalTrackCount: record.totalTrackCount,
							tracks,
							name: input.target.name,
							description: input.target.description,
							public: input.target.public
						},
				input.signal
			);
			if (!response.ok) {
				if (response.status < 500) mutationOutstanding = false;
				// Allow settlement of an acknowledged prefix after a pre-mutation 409.
				if (response.status === 409 && record.snapshotId && !record.settleUntil)
					record.settleUntil = now() + PLAYLIST_SYNC_SETTLE_MS;
				return await unavailable(response, body, true);
			}
			const success = parsePlaylistBatchSuccess(
				body,
				playlistId,
				record.totalTrackCount,
				position + tracks.length
			);
			if (!success) return await stop('uncertain', 'uncertain', 'playlist_outcome_uncertain');
			// Leave the durable dispatching record intact if this acknowledgement save fails.
			await save({
				...record,
				confirmedPosition: success.confirmedPosition,
				snapshotId: success.snapshotId,
				phase: 'settling',
				reason: 'settling',
				updatedAt: now(),
				settleUntil: now() + PLAYLIST_SYNC_SETTLE_MS,
				restartRequired: false
			});
			mutationOutstanding = false;
			first = false;
			const waiting = await settle();
			if (waiting) return waiting;
		}
		await save({
			...record,
			phase: 'completed',
			reason: undefined,
			updatedAt: now(),
			leaseOwner: undefined,
			leaseUntil: undefined,
			retryUntil: undefined
		});
		return { type: 'completed', record };
	} catch {
		if (mutationOutstanding) return stop('uncertain', 'uncertain', 'playlist_outcome_uncertain');
		return stop(
			record.snapshotId ? 'settling' : 'interrupted',
			record.snapshotId ? 'settling' : 'unavailable',
			'playlist_read_interrupted',
			record.snapshotId ? now() + 5_000 : undefined
		);
	}
};
