import type { CatalogProgress } from './catalog-scan';
import { formatSpotifyCooldownMessage, isCatalogProgressCompatible } from './catalog-scan';
import { listCatalogProgress } from './catalog-progress.client';

export const SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY = 'nts-to-spotify:spotify-search-cooldown';
export const SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION = 1;

export type SpotifySearchCooldownCategory = 'rate-limited' | 'quota-exceeded';

export type SpotifySearchCooldownState = {
	version: typeof SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION;
	cooldownUntil: number;
	category: SpotifySearchCooldownCategory;
};

export type SpotifySearchCooldownAction =
	'spotify-search' | 'check-nts' | 'open-catalogue' | 'download-backup' | 'delete-local-progress';

type CooldownStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StorageEventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type ControllerOptions = {
	storage?: CooldownStorage | null;
	eventSource?: StorageEventSource | null;
	now?: () => number;
	listProgress?: () => Promise<{ records: CatalogProgress[] }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

const hasOnlyCooldownStateKeys = (value: Record<string, unknown>) => {
	const keys = Object.keys(value);
	return (
		keys.length === 3 &&
		keys.includes('version') &&
		keys.includes('cooldownUntil') &&
		keys.includes('category')
	);
};

export const isSafeSpotifyCooldownDeadline = (value: unknown, now = Date.now()) =>
	Number.isSafeInteger(value) &&
	(value as number) > 0 &&
	Number.isSafeInteger(now) &&
	now >= 0 &&
	Number.isSafeInteger((value as number) - now);

export const parseSpotifySearchCooldownCategory = (
	value: unknown
): SpotifySearchCooldownCategory | undefined =>
	value === 'quota-exceeded' || value === 'rate-limited' ? value : undefined;

export const parseSpotifySearchCooldownState = (
	value: unknown,
	now = Date.now()
): SpotifySearchCooldownState | null => {
	if (!isRecord(value) || !hasOnlyCooldownStateKeys(value)) return null;
	const category = parseSpotifySearchCooldownCategory(value.category);
	if (
		value.version !== SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION ||
		!category ||
		!isSafeSpotifyCooldownDeadline(value.cooldownUntil, now) ||
		(value.cooldownUntil as number) <= now
	) {
		return null;
	}
	return {
		version: SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION,
		cooldownUntil: value.cooldownUntil as number,
		category
	};
};

const parseStoredState = (value: string | null, now: number) => {
	if (value === null) return null;
	try {
		return parseSpotifySearchCooldownState(JSON.parse(value), now);
	} catch {
		return null;
	}
};

const sameState = (
	left: SpotifySearchCooldownState | null,
	right: SpotifySearchCooldownState | null
) => left?.cooldownUntil === right?.cooldownUntil && left?.category === right?.category;

const laterState = (
	left: SpotifySearchCooldownState | null,
	right: SpotifySearchCooldownState | null
) => {
	if (!left) return right;
	if (!right) return left;
	if (right.cooldownUntil > left.cooldownUntil) return right;
	if (right.cooldownUntil < left.cooldownUntil) return left;
	return left.category === 'quota-exceeded' || right.category === 'rate-limited' ? left : right;
};

export const migrateSpotifySearchCooldownFromCatalogues = (
	records: CatalogProgress[],
	now = Date.now()
) => {
	let migrated: SpotifySearchCooldownState | null = null;
	for (const progress of records) {
		if (!isCatalogProgressCompatible(progress)) continue;
		const cooldownUntil = progress.retry?.cooldownUntil;
		if (!isSafeSpotifyCooldownDeadline(cooldownUntil, now) || (cooldownUntil as number) <= now) {
			continue;
		}
		const legacyReason = parseSpotifySearchCooldownCategory(
			(progress.retry as Record<string, unknown> | undefined)?.reason
		);
		migrated = laterState(migrated, {
			version: SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION,
			cooldownUntil: cooldownUntil as number,
			category: legacyReason ?? 'rate-limited'
		});
	}
	return migrated;
};

const defaultStorage = () => {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
};

const defaultEventSource = () => (typeof window === 'undefined' ? null : window);

export const spotifySearchCooldownRemainingSeconds = (
	state: SpotifySearchCooldownState | null,
	now = Date.now()
) =>
	state && state.cooldownUntil > now
		? Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000))
		: 0;

export const canStartSpotifySearch = (state: SpotifySearchCooldownState | null, now = Date.now()) =>
	spotifySearchCooldownRemainingSeconds(state, now) === 0;

export const isBlockedBySpotifySearchCooldown = (
	action: SpotifySearchCooldownAction,
	state: SpotifySearchCooldownState | null,
	now = Date.now()
) => action === 'spotify-search' && !canStartSpotifySearch(state, now);

export const shouldInterruptForGlobalSpotifySearchCooldown = (
	state: SpotifySearchCooldownState | null,
	localCooldownUntil: number,
	scanning: boolean,
	now = Date.now()
) =>
	Boolean(
		scanning && state && state.cooldownUntil > now && state.cooldownUntil > localCooldownUntil
	);

export const formatSpotifySearchCooldownDashboardNotice = (
	state: SpotifySearchCooldownState | null,
	now = Date.now()
) => {
	const remainingSeconds = spotifySearchCooldownRemainingSeconds(state, now);
	if (!state || remainingSeconds === 0) return null;
	return `${formatSpotifyCooldownMessage(state.category, remainingSeconds)} Spotify Search is paused across all saved catalogues in this browser. NTS and local actions remain available.`;
};

export class SpotifySearchCooldownController {
	private readonly storage: CooldownStorage | null;
	private readonly eventSource: StorageEventSource | null;
	private readonly now: () => number;
	private readonly listProgress: () => Promise<{ records: CatalogProgress[] }>;
	private state: SpotifySearchCooldownState | null = null;
	private initialized = false;
	private initialization?: Promise<SpotifySearchCooldownState | null>;
	private listeners = new Set<(state: SpotifySearchCooldownState | null) => void>();
	private listening = false;

	constructor(options: ControllerOptions = {}) {
		this.storage = options.storage === undefined ? defaultStorage() : options.storage;
		this.eventSource =
			options.eventSource === undefined ? defaultEventSource() : options.eventSource;
		this.now = options.now ?? Date.now;
		this.listProgress = options.listProgress ?? (() => listCatalogProgress());
	}

	private notify(next: SpotifySearchCooldownState | null) {
		if (sameState(this.state, next)) return;
		this.state = next;
		for (const listener of this.listeners) listener(this.snapshot());
	}

	private removeStoredState() {
		try {
			this.storage?.removeItem(SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY);
		} catch {
			// In-memory and legacy per-catalogue cooldowns remain available.
		}
	}

	private readStoredState() {
		if (!this.storage) return null;
		try {
			const raw = this.storage.getItem(SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY);
			const parsed = parseStoredState(raw, this.now());
			if (raw !== null && !parsed) this.removeStoredState();
			return parsed;
		} catch {
			return null;
		}
	}

	private persist(next: SpotifySearchCooldownState | null) {
		if (!next) {
			this.removeStoredState();
			return;
		}
		try {
			this.storage?.setItem(SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Keep the sanitized state in memory when browser storage is unavailable.
		}
	}

	private readonly onStorage = (event: Event) => {
		const storageEvent = event as StorageEvent;
		if (storageEvent.key !== SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY) return;
		const next = parseStoredState(storageEvent.newValue, this.now());
		const current = this.snapshot();
		if (!next) {
			if (current && current.cooldownUntil > this.now()) {
				this.persist(current);
				return;
			}
			if (storageEvent.newValue !== null) this.removeStoredState();
			this.notify(null);
			return;
		}
		const combined = laterState(current, next);
		if (!sameState(combined, next)) this.persist(combined);
		this.notify(combined);
	};

	async initialize(records?: CatalogProgress[]) {
		if (this.initialized) return this.current();
		if (this.initialization) return this.initialization;
		this.initialization = (async () => {
			const stored = this.readStoredState();
			let catalogues = records;
			if (!catalogues) {
				try {
					catalogues = (await this.listProgress()).records;
				} catch {
					catalogues = [];
				}
			}
			const migrated = migrateSpotifySearchCooldownFromCatalogues(catalogues, this.now());
			const next = laterState(laterState(this.snapshot(), stored), migrated);
			if (!sameState(stored, next)) this.persist(next);
			this.notify(next);
			this.initialized = true;
			return this.snapshot();
		})();
		try {
			return await this.initialization;
		} finally {
			this.initialization = undefined;
		}
	}

	extend(cooldownUntil: number, category: SpotifySearchCooldownCategory) {
		const now = this.now();
		const next = parseSpotifySearchCooldownState(
			{ version: SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION, cooldownUntil, category },
			now
		);
		if (!next) return this.current();
		const current = this.current();
		const extended = laterState(laterState(current, this.readStoredState()), next);
		if (!sameState(current, extended)) {
			this.persist(extended);
			this.notify(extended);
		}
		return this.snapshot();
	}

	clearExpired() {
		if (this.state && this.state.cooldownUntil <= this.now()) {
			const stored = this.readStoredState();
			if (stored) {
				this.notify(stored);
				return this.snapshot();
			}
			this.persist(null);
			this.notify(null);
		}
		return this.snapshot();
	}

	current() {
		return this.clearExpired();
	}

	snapshot() {
		return this.state ? { ...this.state } : null;
	}

	subscribe(listener: (state: SpotifySearchCooldownState | null) => void) {
		this.listeners.add(listener);
		if (!this.listening && this.eventSource) {
			this.eventSource.addEventListener('storage', this.onStorage);
			this.listening = true;
		}
		listener(this.current());
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0 && this.listening && this.eventSource) {
				this.eventSource.removeEventListener('storage', this.onStorage);
				this.listening = false;
			}
		};
	}

	destroy() {
		this.listeners.clear();
		if (this.listening && this.eventSource) {
			this.eventSource.removeEventListener('storage', this.onStorage);
		}
		this.listening = false;
	}
}
