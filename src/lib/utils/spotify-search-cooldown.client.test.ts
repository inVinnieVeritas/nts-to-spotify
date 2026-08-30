import { describe, expect, it, vi } from 'vitest';
import type { CatalogProgress } from './catalog-scan';
import {
	canStartSpotifySearch,
	formatSpotifySearchCooldownDashboardNotice,
	isBlockedBySpotifySearchCooldown,
	migrateSpotifySearchCooldownFromCatalogues,
	parseSpotifySearchCooldownState,
	SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY,
	SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION,
	SpotifySearchCooldownController,
	spotifySearchCooldownRemainingSeconds,
	shouldInterruptForGlobalSpotifySearchCooldown,
	type SpotifySearchCooldownState
} from './spotify-search-cooldown.client';

const NOW = Date.UTC(2026, 7, 30, 12);

const progress = (
	showAlias: string,
	cooldownUntil: number,
	reason?: 'rate-limited' | 'quota-exceeded'
): CatalogProgress => ({
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias,
	updatedAt: NOW - 1_000,
	episodes: {},
	playlist: { title: 'Title', description: 'Description', public: false },
	retry: {
		cooldownUntil,
		pausedByRateLimit: cooldownUntil > NOW,
		...(reason ? { reason } : {})
	} as CatalogProgress['retry']
});

const createStorage = (initial?: string) => {
	let value = initial ?? null;
	return {
		getItem: vi.fn(() => value),
		setItem: vi.fn((_key: string, next: string) => {
			value = next;
		}),
		removeItem: vi.fn(() => {
			value = null;
		}),
		value: () => value
	};
};

const createEventSource = () => {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	return {
		addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
			listeners.add(listener);
		}),
		removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
			listeners.delete(listener);
		}),
		dispatch: (newValue: string | null) => {
			const event = { key: SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY, newValue } as StorageEvent;
			for (const listener of listeners) {
				if (typeof listener === 'function') listener(event);
				else listener.handleEvent(event);
			}
		}
	};
};

const state = (cooldownUntil: number, category: 'rate-limited' | 'quota-exceeded') =>
	({
		version: SPOTIFY_SEARCH_COOLDOWN_STORAGE_VERSION,
		cooldownUntil,
		category
	}) satisfies SpotifySearchCooldownState;

describe('global Spotify Search cooldown validation and migration', () => {
	it('migrates Amanda’s future cooldown so Jim cannot start Spotify Search', async () => {
		const amanda = progress('amanda', NOW + 8 * 60 * 60 * 1_000, 'quota-exceeded');
		const jimBefore = JSON.parse(JSON.stringify(progress('jim-o-rourke', 0))) as CatalogProgress;
		const storage = createStorage();
		const controller = new SpotifySearchCooldownController({
			storage,
			eventSource: null,
			now: () => NOW,
			listProgress: async () => ({ records: [amanda, jimBefore] })
		});

		const migrated = await controller.initialize();
		expect(migrated).toEqual(state(amanda.retry?.cooldownUntil as number, 'quota-exceeded'));
		expect(canStartSpotifySearch(migrated, NOW)).toBe(false);
		expect(jimBefore).toEqual(progress('jim-o-rourke', 0));
	});

	it('uses the maximum valid future deadline across records and preserves its category', () => {
		const migrated = migrateSpotifySearchCooldownFromCatalogues(
			[
				progress('short', NOW + 10_000, 'quota-exceeded'),
				progress('long', NOW + 3 * 24 * 60 * 60 * 1_000, 'rate-limited'),
				progress('expired', NOW - 1)
			],
			NOW
		);
		expect(migrated).toEqual(state(NOW + 3 * 24 * 60 * 60 * 1_000, 'rate-limited'));
	});

	it.each([
		null,
		{},
		state(NOW - 1, 'rate-limited'),
		{ ...state(NOW + 1_000, 'rate-limited'), version: 99 },
		{ ...state(NOW + 1_000, 'rate-limited'), category: 'private-upstream-reason' },
		{ ...state(NOW + 1_000, 'rate-limited'), upstreamBody: 'must not be retained' },
		JSON.parse(
			`{"version":1,"cooldownUntil":${NOW + 1_000},"category":"rate-limited","__proto__":{"polluted":true}}`
		),
		{ ...state(NOW + 1_000, 'rate-limited'), cooldownUntil: Number.NaN },
		{ ...state(NOW + 1_000, 'rate-limited'), cooldownUntil: Number.POSITIVE_INFINITY },
		{ ...state(NOW + 1_000, 'rate-limited'), cooldownUntil: Number.MAX_SAFE_INTEGER + 1 },
		{ ...state(NOW + 1_000, 'rate-limited'), cooldownUntil: 1.5 }
	])('rejects malformed, unsafe or expired state', (value) => {
		expect(parseSpotifySearchCooldownState(value, NOW)).toBeNull();
	});

	it('accepts legitimate multi-day deadlines without an arbitrary clamp', () => {
		const deadline = NOW + 30 * 24 * 60 * 60 * 1_000;
		expect(parseSpotifySearchCooldownState(state(deadline, 'quota-exceeded'), NOW)).toEqual(
			state(deadline, 'quota-exceeded')
		);
	});

	it('removes malformed and expired persisted values safely', async () => {
		for (const raw of ['not-json', JSON.stringify(state(NOW - 1, 'rate-limited'))]) {
			const storage = createStorage(raw);
			const controller = new SpotifySearchCooldownController({
				storage,
				eventSource: null,
				now: () => NOW,
				listProgress: async () => ({ records: [] })
			});
			await expect(controller.initialize()).resolves.toBeNull();
			expect(storage.removeItem).toHaveBeenCalledWith(SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY);
		}
	});
});

describe('global Spotify Search cooldown lifecycle', () => {
	it('formats one dashboard notice and leaves NTS/local actions available', () => {
		const active = state(NOW + 90_000, 'quota-exceeded');
		expect(formatSpotifySearchCooldownDashboardNotice(active, NOW)).toBe(
			'Spotify Development Mode quota exhausted: 1m 30s remaining. Spotify Search is paused across all saved catalogues in this browser. NTS and local actions remain available.'
		);
		expect(isBlockedBySpotifySearchCooldown('spotify-search', active, NOW)).toBe(true);
		for (const action of [
			'check-nts',
			'open-catalogue',
			'download-backup',
			'delete-local-progress'
		] as const) {
			expect(isBlockedBySpotifySearchCooldown(action, active, NOW)).toBe(false);
		}
	});

	it('interrupts another active catalogue but preserves the page handling its own cooldown', () => {
		const active = state(NOW + 90_000, 'rate-limited');
		expect(shouldInterruptForGlobalSpotifySearchCooldown(active, 0, true, NOW)).toBe(true);
		expect(
			shouldInterruptForGlobalSpotifySearchCooldown(active, active.cooldownUntil, true, NOW)
		).toBe(false);
		expect(shouldInterruptForGlobalSpotifySearchCooldown(active, 0, false, NOW)).toBe(false);
	});

	it('extends but never shortens an active deadline and supports both categories', async () => {
		const storage = createStorage();
		const controller = new SpotifySearchCooldownController({
			storage,
			eventSource: null,
			now: () => NOW,
			listProgress: async () => ({ records: [] })
		});
		await controller.initialize();
		expect(controller.extend(NOW + 20_000, 'rate-limited')).toEqual(
			state(NOW + 20_000, 'rate-limited')
		);
		expect(controller.extend(NOW + 10_000, 'quota-exceeded')).toEqual(
			state(NOW + 20_000, 'rate-limited')
		);
		expect(controller.extend(NOW + 30_000, 'quota-exceeded')).toEqual(
			state(NOW + 30_000, 'quota-exceeded')
		);
	});

	it('clears expired state, enables Search and removes browser storage', async () => {
		let now = NOW;
		const storage = createStorage();
		const controller = new SpotifySearchCooldownController({
			storage,
			eventSource: null,
			now: () => now,
			listProgress: async () => ({ records: [] })
		});
		await controller.initialize();
		controller.extend(NOW + 2_000, 'rate-limited');
		expect(spotifySearchCooldownRemainingSeconds(controller.current(), now)).toBe(2);
		now = NOW + 2_000;
		expect(controller.clearExpired()).toBeNull();
		expect(canStartSpotifySearch(controller.current(), now)).toBe(true);
		expect(storage.removeItem).toHaveBeenCalledWith(SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY);
	});

	it('propagates cross-tab updates and clears without allowing a stale tab to shorten state', async () => {
		let now = NOW;
		const storage = createStorage();
		const events = createEventSource();
		const controller = new SpotifySearchCooldownController({
			storage,
			eventSource: events,
			now: () => now,
			listProgress: async () => ({ records: [] })
		});
		await controller.initialize();
		const observed: unknown[] = [];
		const unsubscribe = controller.subscribe((value) => observed.push(value));
		const remote = state(NOW + 40_000, 'quota-exceeded');
		events.dispatch(JSON.stringify(remote));
		expect(controller.current()).toEqual(remote);
		events.dispatch(JSON.stringify(state(NOW + 20_000, 'rate-limited')));
		expect(controller.current()).toEqual(remote);
		expect(storage.setItem).toHaveBeenCalledWith(
			SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY,
			JSON.stringify(remote)
		);
		storage.setItem.mockClear();
		events.dispatch(null);
		expect(controller.current()).toEqual(remote);
		expect(storage.setItem).toHaveBeenCalledWith(
			SPOTIFY_SEARCH_COOLDOWN_STORAGE_KEY,
			JSON.stringify(remote)
		);
		now = remote.cooldownUntil;
		events.dispatch(null);
		expect(controller.current()).toBeNull();
		expect(observed).toEqual([null, remote, null]);
		unsubscribe();
		expect(events.removeEventListener).toHaveBeenCalledOnce();
	});

	it('fails safely with unavailable or throwing storage', async () => {
		const unavailable = new SpotifySearchCooldownController({
			storage: null,
			eventSource: null,
			now: () => NOW,
			listProgress: async () => ({ records: [progress('amanda', NOW + 10_000)] })
		});
		await expect(unavailable.initialize()).resolves.toEqual(state(NOW + 10_000, 'rate-limited'));

		const throwing = new SpotifySearchCooldownController({
			storage: {
				getItem: () => {
					throw new Error('unavailable');
				},
				setItem: () => {
					throw new Error('unavailable');
				},
				removeItem: () => {
					throw new Error('unavailable');
				}
			},
			eventSource: null,
			now: () => NOW,
			listProgress: async () => ({ records: [progress('jim', NOW + 20_000)] })
		});
		await expect(throwing.initialize()).resolves.toEqual(state(NOW + 20_000, 'rate-limited'));
	});

	it('blocks requests locally without invoking fetch and leaves progress untouched', async () => {
		const saved = progress('jim', 0);
		const before = JSON.stringify(saved);
		const request = vi.fn();
		const controller = new SpotifySearchCooldownController({
			storage: createStorage(),
			eventSource: null,
			now: () => NOW,
			listProgress: async () => ({ records: [progress('amanda', NOW + 60_000), saved] })
		});
		const global = await controller.initialize();
		if (canStartSpotifySearch(global, NOW)) await request();
		expect(request).not.toHaveBeenCalled();
		expect(JSON.stringify(saved)).toBe(before);
	});

	it('does not write catalogue records during no-op initialization', async () => {
		const stored = state(NOW + 60_000, 'rate-limited');
		const storage = createStorage(JSON.stringify(stored));
		const listProgress = vi.fn(async () => ({ records: [progress('amanda', NOW + 60_000)] }));
		const controller = new SpotifySearchCooldownController({
			storage,
			eventSource: null,
			now: () => NOW,
			listProgress
		});
		await expect(controller.initialize()).resolves.toEqual(stored);
		expect(listProgress).toHaveBeenCalledOnce();
		expect(storage.setItem).not.toHaveBeenCalled();
	});
});
