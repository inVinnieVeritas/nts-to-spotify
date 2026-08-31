export const CATALOG_SCAN_SESSION_HISTORY_LIMIT = 10;
export const CATALOG_SCAN_SESSION_CHECKPOINT_INTERVAL_MS = 15_000;

const EARLIEST_SESSION_TIMESTAMP = Date.UTC(2000, 0, 1);
const LATEST_SESSION_TIMESTAMP = Date.UTC(3000, 0, 1);
const MAX_SESSION_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_SESSION_EPISODES = 100_000;
const MAX_SESSION_ID_LENGTH = 80;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export type CatalogScanSessionOutcome =
	'completed' | 'cancelled' | 'spotify-cooldown' | 'failed' | 'interrupted';

export type CatalogScanSessionCounts = {
	processedEpisodes: number;
	successfulEpisodes: number;
	failedEpisodes: number;
	longestMatchingRequestMs: number;
};

export type ActiveCatalogScanSession = CatalogScanSessionCounts & {
	id: string;
	startedAt: number;
	checkpointAt: number;
	activeDurationMs: number;
};

export type FinalizedCatalogScanSession = CatalogScanSessionCounts & {
	id: string;
	startedAt: number;
	endedAt: number;
	activeDurationMs: number;
	outcome: CatalogScanSessionOutcome;
};

export type CatalogScanTiming = {
	active?: ActiveCatalogScanSession;
	history: FinalizedCatalogScanSession[];
};

type RestoreCatalogScanTimingResult = {
	timing: CatalogScanTiming;
	interrupted: boolean;
	changed: boolean;
};

const OUTCOMES = new Set<CatalogScanSessionOutcome>([
	'completed',
	'cancelled',
	'spotify-cooldown',
	'failed',
	'interrupted'
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) => {
	const keys = Object.keys(value);
	return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
};

const isTimestamp = (value: unknown): value is number =>
	Number.isSafeInteger(value) &&
	(value as number) >= EARLIEST_SESSION_TIMESTAMP &&
	(value as number) <= LATEST_SESSION_TIMESTAMP;

const isBoundedCount = (value: unknown): value is number =>
	Number.isSafeInteger(value) &&
	(value as number) >= 0 &&
	(value as number) <= MAX_SESSION_EPISODES;

const isBoundedDuration = (value: unknown): value is number =>
	Number.isSafeInteger(value) &&
	(value as number) >= 0 &&
	(value as number) <= MAX_SESSION_DURATION_MS;

const isSessionId = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= MAX_SESSION_ID_LENGTH &&
	SESSION_ID.test(value);

const parseCounts = (value: Record<string, unknown>): CatalogScanSessionCounts | null => {
	if (
		!isBoundedCount(value.processedEpisodes) ||
		!isBoundedCount(value.successfulEpisodes) ||
		!isBoundedCount(value.failedEpisodes) ||
		!isBoundedDuration(value.longestMatchingRequestMs) ||
		!Number.isSafeInteger(value.successfulEpisodes + value.failedEpisodes) ||
		value.processedEpisodes !== value.successfulEpisodes + value.failedEpisodes
	) {
		return null;
	}
	return {
		processedEpisodes: value.processedEpisodes,
		successfulEpisodes: value.successfulEpisodes,
		failedEpisodes: value.failedEpisodes,
		longestMatchingRequestMs: value.longestMatchingRequestMs
	};
};

const ACTIVE_KEYS = [
	'id',
	'startedAt',
	'checkpointAt',
	'activeDurationMs',
	'processedEpisodes',
	'successfulEpisodes',
	'failedEpisodes',
	'longestMatchingRequestMs'
];

const FINAL_KEYS = [
	'id',
	'startedAt',
	'endedAt',
	'activeDurationMs',
	'outcome',
	'processedEpisodes',
	'successfulEpisodes',
	'failedEpisodes',
	'longestMatchingRequestMs'
];

const parseActiveSession = (value: unknown): ActiveCatalogScanSession | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, ACTIVE_KEYS)) return null;
	const counts = parseCounts(value);
	if (
		!counts ||
		!isSessionId(value.id) ||
		!isTimestamp(value.startedAt) ||
		!isTimestamp(value.checkpointAt) ||
		value.checkpointAt < value.startedAt ||
		!isBoundedDuration(value.activeDurationMs)
	) {
		return null;
	}
	return {
		id: value.id,
		startedAt: value.startedAt,
		checkpointAt: value.checkpointAt,
		activeDurationMs: value.activeDurationMs,
		...counts
	};
};

const parseFinalizedSession = (value: unknown): FinalizedCatalogScanSession | null => {
	if (!isRecord(value) || !hasOnlyKeys(value, FINAL_KEYS)) return null;
	const counts = parseCounts(value);
	if (
		!counts ||
		!isSessionId(value.id) ||
		!isTimestamp(value.startedAt) ||
		!isTimestamp(value.endedAt) ||
		value.endedAt < value.startedAt ||
		!isBoundedDuration(value.activeDurationMs) ||
		!OUTCOMES.has(value.outcome as CatalogScanSessionOutcome)
	) {
		return null;
	}
	return {
		id: value.id,
		startedAt: value.startedAt,
		endedAt: value.endedAt,
		activeDurationMs: value.activeDurationMs,
		outcome: value.outcome as CatalogScanSessionOutcome,
		...counts
	};
};

const normalizedHistory = (value: unknown) => {
	if (!Array.isArray(value)) return [];
	const sessions = value
		.slice(0, CATALOG_SCAN_SESSION_HISTORY_LIMIT * 4)
		.map(parseFinalizedSession)
		.filter((session): session is FinalizedCatalogScanSession => session !== null)
		.sort((left, right) => right.endedAt - left.endedAt || right.startedAt - left.startedAt);
	const seen = new Set<string>();
	return sessions
		.filter(({ id }) => {
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		})
		.slice(0, CATALOG_SCAN_SESSION_HISTORY_LIMIT);
};

const copyTiming = (timing?: CatalogScanTiming | null): CatalogScanTiming => ({
	...(timing?.active ? { active: { ...timing.active } } : {}),
	history: timing?.history.map((session) => ({ ...session })) ?? []
});

export const emptyCatalogScanTiming = (): CatalogScanTiming => ({ history: [] });

const generatedSessionId = (now: number) => {
	try {
		const id = globalThis.crypto?.randomUUID?.();
		if (id && isSessionId(id)) return id;
	} catch {
		// Fall back to a bounded, non-sensitive local identifier.
	}
	return `${now}-${Math.random().toString(36).slice(2, 14)}`;
};

export const checkpointCatalogScanSession = (
	timing: CatalogScanTiming,
	wallNow: number,
	activeDurationMs: number
): CatalogScanTiming => {
	if (!timing.active) return copyTiming(timing);
	const active = timing.active;
	const checkpointAt = isTimestamp(wallNow)
		? Math.max(active.checkpointAt, wallNow)
		: active.checkpointAt;
	const duration = isBoundedDuration(activeDurationMs)
		? Math.max(active.activeDurationMs, activeDurationMs)
		: active.activeDurationMs;
	return {
		active: { ...active, checkpointAt, activeDurationMs: duration },
		history: timing.history.map((session) => ({ ...session }))
	};
};

export const finalizeCatalogScanSession = (
	timing: CatalogScanTiming,
	outcome: CatalogScanSessionOutcome,
	wallNow: number,
	activeDurationMs: number
): { timing: CatalogScanTiming; session?: FinalizedCatalogScanSession } => {
	if (!timing.active || !OUTCOMES.has(outcome)) return { timing: copyTiming(timing) };
	const checkpointed = checkpointCatalogScanSession(timing, wallNow, activeDurationMs);
	const active = checkpointed.active as ActiveCatalogScanSession;
	const existing = checkpointed.history.find(({ id }) => id === active.id);
	if (existing) return { timing: { history: checkpointed.history }, session: existing };
	const session: FinalizedCatalogScanSession = {
		id: active.id,
		startedAt: active.startedAt,
		endedAt: Math.max(active.startedAt, active.checkpointAt),
		activeDurationMs: active.activeDurationMs,
		outcome,
		processedEpisodes: active.processedEpisodes,
		successfulEpisodes: active.successfulEpisodes,
		failedEpisodes: active.failedEpisodes,
		longestMatchingRequestMs: active.longestMatchingRequestMs
	};
	return {
		timing: {
			history: [session, ...checkpointed.history]
				.filter(
					(candidate, index, sessions) =>
						sessions.findIndex(({ id }) => id === candidate.id) === index
				)
				.slice(0, CATALOG_SCAN_SESSION_HISTORY_LIMIT)
		},
		session
	};
};

export const restoreCatalogScanTiming = (
	value: unknown,
	finalizeInterrupted = false
): RestoreCatalogScanTimingResult => {
	if (!isRecord(value) || !hasOnlyKeys(value, ['active', 'history'])) {
		return {
			timing: emptyCatalogScanTiming(),
			interrupted: false,
			changed: value !== undefined
		};
	}
	const active = value.active === undefined ? null : parseActiveSession(value.active);
	const timing: CatalogScanTiming = {
		...(active ? { active } : {}),
		history: normalizedHistory(value.history)
	};
	let changed: boolean;
	try {
		changed = JSON.stringify(value) !== JSON.stringify(timing);
	} catch {
		changed = true;
	}
	if (!active || !finalizeInterrupted) return { timing, interrupted: false, changed };
	const finalized = finalizeCatalogScanSession(
		timing,
		'interrupted',
		active.checkpointAt,
		active.activeDurationMs
	);
	return { timing: finalized.timing, interrupted: true, changed: true };
};

export const startCatalogScanSession = (
	timing: CatalogScanTiming,
	wallNow: number,
	id = generatedSessionId(wallNow)
): CatalogScanTiming => {
	if (!isTimestamp(wallNow) || !isSessionId(id)) return copyTiming(timing);
	const restored = timing.active
		? finalizeCatalogScanSession(
				timing,
				'interrupted',
				timing.active.checkpointAt,
				timing.active.activeDurationMs
			).timing
		: copyTiming(timing);
	return {
		active: {
			id,
			startedAt: wallNow,
			checkpointAt: wallNow,
			activeDurationMs: 0,
			processedEpisodes: 0,
			successfulEpisodes: 0,
			failedEpisodes: 0,
			longestMatchingRequestMs: 0
		},
		history: restored.history
	};
};

export const recordCatalogScanEpisodeOutcome = (
	timing: CatalogScanTiming,
	outcome: 'successful' | 'failed'
): CatalogScanTiming => {
	if (!timing.active) return copyTiming(timing);
	const processedEpisodes = timing.active.processedEpisodes + 1;
	const successfulEpisodes = timing.active.successfulEpisodes + (outcome === 'successful' ? 1 : 0);
	const failedEpisodes = timing.active.failedEpisodes + (outcome === 'failed' ? 1 : 0);
	if (
		!isBoundedCount(processedEpisodes) ||
		!isBoundedCount(successfulEpisodes) ||
		!isBoundedCount(failedEpisodes)
	) {
		return copyTiming(timing);
	}
	return {
		active: { ...timing.active, processedEpisodes, successfulEpisodes, failedEpisodes },
		history: timing.history.map((session) => ({ ...session }))
	};
};

export const recordCatalogMatchingRequestDuration = (
	timing: CatalogScanTiming,
	durationMs: number
): CatalogScanTiming => {
	if (!timing.active || !isBoundedDuration(durationMs)) return copyTiming(timing);
	return {
		active: {
			...timing.active,
			longestMatchingRequestMs: Math.max(timing.active.longestMatchingRequestMs, durationMs)
		},
		history: timing.history.map((session) => ({ ...session }))
	};
};

export const liveCatalogScanDuration = (monotonicStartedAt: number, monotonicNow: number) => {
	if (!Number.isFinite(monotonicStartedAt) || !Number.isFinite(monotonicNow)) return 0;
	return Math.min(
		MAX_SESSION_DURATION_MS,
		Math.max(0, Math.floor(monotonicNow - monotonicStartedAt))
	);
};

export const getLatestCatalogScanSession = (value: unknown) =>
	restoreCatalogScanTiming(value, true).timing.history[0];

export const formatCatalogScanClock = (durationMs: number) => {
	const totalSeconds = isBoundedDuration(durationMs) ? Math.floor(durationMs / 1000) : 0;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((part) => part.toString().padStart(2, '0')).join(':');
};

export const formatCatalogScanDuration = (durationMs: number) => {
	const totalSeconds = isBoundedDuration(durationMs) ? Math.floor(durationMs / 1000) : 0;
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (days || hours) parts.push(`${hours}h`);
	if (days || hours || minutes) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(' ');
};

export const catalogScanOutcomeLabel = (outcome: CatalogScanSessionOutcome) =>
	({
		completed: 'completed',
		cancelled: 'cancelled',
		'spotify-cooldown': 'paused by Spotify',
		failed: 'failed',
		interrupted: 'interrupted'
	})[outcome];

export const formatCatalogScanSessionSummary = (session: FinalizedCatalogScanSession) =>
	`${formatCatalogScanDuration(session.activeDurationMs)} · ${session.processedEpisodes} ${
		session.processedEpisodes === 1 ? 'episode' : 'episodes'
	} · ${catalogScanOutcomeLabel(session.outcome)}`;
