import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	CATALOG_SCAN_SESSION_HISTORY_LIMIT,
	catalogScanOutcomeLabel,
	checkpointCatalogScanSession,
	emptyCatalogScanTiming,
	finalizeCatalogScanSession,
	formatCatalogScanClock,
	formatCatalogScanSessionSummary,
	getLatestCatalogScanSession,
	liveCatalogScanDuration,
	recordCatalogMatchingRequestDuration,
	recordCatalogScanEpisodeOutcome,
	restoreCatalogScanTiming,
	startCatalogScanSession,
	type CatalogScanSessionOutcome,
	type CatalogScanTiming,
	type FinalizedCatalogScanSession
} from './catalog-scan-session';

const START = Date.UTC(2026, 7, 30, 12);

const finalizedSession = (
	id: string,
	endedAt: number,
	overrides: Partial<FinalizedCatalogScanSession> = {}
): FinalizedCatalogScanSession => ({
	id,
	startedAt: endedAt - 10_000,
	endedAt,
	activeDurationMs: 10_000,
	outcome: 'completed',
	processedEpisodes: 1,
	successfulEpisodes: 1,
	failedEpisodes: 0,
	longestMatchingRequestMs: 4_000,
	...overrides
});

const started = (history: FinalizedCatalogScanSession[] = []) =>
	startCatalogScanSession({ history }, START, 'session-current');

describe('catalogue scan-session lifecycle', () => {
	it('starts a stable session and calculates live elapsed time with a monotonic clock', () => {
		const timing = started();
		expect(timing.active).toMatchObject({
			id: 'session-current',
			startedAt: START,
			checkpointAt: START,
			activeDurationMs: 0,
			processedEpisodes: 0
		});
		expect(liveCatalogScanDuration(1_000.25, 6_678.75)).toBe(5_678);
		expect(formatCatalogScanClock(3_661_999)).toBe('01:01:01');
	});

	it.each<[CatalogScanSessionOutcome, string]>([
		['completed', 'completed'],
		['cancelled', 'cancelled'],
		['spotify-cooldown', 'paused by Spotify'],
		['failed', 'failed']
	])('finalizes one %s session', (outcome, label) => {
		const result = finalizeCatalogScanSession(started(), outcome, START + 12_000, 12_000);
		expect(result.timing.active).toBeUndefined();
		expect(result.timing.history).toHaveLength(1);
		expect(result.session).toMatchObject({ outcome, activeDurationMs: 12_000 });
		expect(catalogScanOutcomeLabel(outcome)).toBe(label);
	});

	it('restores an unfinished session as interrupted at its last reliable checkpoint', () => {
		const checkpointed = checkpointCatalogScanSession(started(), START + 8_000, 7_500);
		const restored = restoreCatalogScanTiming(checkpointed, true);
		expect(restored.interrupted).toBe(true);
		expect(restored.changed).toBe(true);
		expect(restored.timing.active).toBeUndefined();
		expect(restored.timing.history[0]).toMatchObject({
			id: 'session-current',
			endedAt: START + 8_000,
			activeDurationMs: 7_500,
			outcome: 'interrupted'
		});
	});

	it('resuming creates a new session and safely interrupts any unfinished predecessor', () => {
		const resumed = startCatalogScanSession(started(), START + 60_000, 'session-resumed');
		expect(resumed.active?.id).toBe('session-resumed');
		expect(resumed.history).toHaveLength(1);
		expect(resumed.history[0]).toMatchObject({
			id: 'session-current',
			outcome: 'interrupted'
		});
	});

	it('excludes Spotify cooldown waiting from active duration by ending before resume', () => {
		const paused = finalizeCatalogScanSession(
			started(),
			'spotify-cooldown',
			START + 5_000,
			5_000
		).timing;
		const resumed = startCatalogScanSession(paused, START + 3_605_000, 'after-cooldown');
		const completed = finalizeCatalogScanSession(
			resumed,
			'completed',
			START + 3_607_000,
			2_000
		).timing;
		expect(completed.history.map(({ activeDurationMs }) => activeDurationMs)).toEqual([
			2_000, 5_000
		]);
	});

	it('records per-episode failure without prematurely finalizing the session', () => {
		const timing = recordCatalogScanEpisodeOutcome(started(), 'failed');
		expect(timing.active).toMatchObject({
			processedEpisodes: 1,
			successfulEpisodes: 0,
			failedEpisodes: 1
		});
		expect(timing.history).toHaveLength(0);
	});

	it('finalization is idempotent and cannot duplicate history', () => {
		const first = finalizeCatalogScanSession(started(), 'completed', START + 1_000, 1_000);
		const second = finalizeCatalogScanSession(first.timing, 'cancelled', START + 2_000, 2_000);
		expect(second.timing.history).toEqual(first.timing.history);
		expect(second.timing.history).toHaveLength(1);
	});

	it('tracks processed, successful and failed episode deltas', () => {
		let timing = started();
		timing = recordCatalogScanEpisodeOutcome(timing, 'successful');
		timing = recordCatalogScanEpisodeOutcome(timing, 'failed');
		timing = recordCatalogScanEpisodeOutcome(timing, 'successful');
		expect(timing.active).toMatchObject({
			processedEpisodes: 3,
			successfulEpisodes: 2,
			failedEpisodes: 1
		});
	});

	it('keeps the longest client-observed matching request', () => {
		let timing = recordCatalogMatchingRequestDuration(started(), 4_200);
		timing = recordCatalogMatchingRequestDuration(timing, 900);
		timing = recordCatalogMatchingRequestDuration(timing, 8_500);
		expect(timing.active?.longestMatchingRequestMs).toBe(8_500);
	});

	it('keeps at most ten finalized sessions newest first', () => {
		const history = Array.from({ length: 15 }, (_, index) =>
			finalizedSession(`session-${index}`, START + index * 1_000)
		).reverse();
		const restored = restoreCatalogScanTiming({ history });
		expect(restored.timing.history).toHaveLength(CATALOG_SCAN_SESSION_HISTORY_LIMIT);
		expect(restored.timing.history.map(({ id }) => id)).toEqual(
			Array.from({ length: 10 }, (_, index) => `session-${14 - index}`)
		);
	});

	it('treats missing timing fields as backward-compatible empty history', () => {
		expect(restoreCatalogScanTiming(undefined)).toEqual({
			timing: { history: [] },
			interrupted: false,
			changed: false
		});
		expect(getLatestCatalogScanSession(undefined)).toBeUndefined();
	});

	it('discards malformed entries individually without losing valid history', () => {
		const valid = finalizedSession('valid-session', START + 10_000);
		const restored = restoreCatalogScanTiming({
			history: [
				valid,
				{ ...valid, id: '../unsafe' },
				{ ...valid, id: 'unsafe-count', processedEpisodes: 3 },
				{ ...valid, id: 'unsafe-time', endedAt: Number.MAX_SAFE_INTEGER },
				{ ...valid, id: 'unsafe-duration', activeDurationMs: Number.POSITIVE_INFINITY },
				{ ...valid, id: 'extra-fields', token: 'must-not-survive' }
			],
			active: { id: 'malformed-active' }
		});
		expect(restored.timing).toEqual({ history: [valid] });
		expect(restored.changed).toBe(true);
	});

	it('handles wall-clock and monotonic rollback without negative time', () => {
		const initial = checkpointCatalogScanSession(started(), START + 10_000, 9_000);
		const rolledBack = checkpointCatalogScanSession(initial, START - 5_000, 1_000);
		expect(rolledBack.active).toMatchObject({
			checkpointAt: START + 10_000,
			activeDurationMs: 9_000
		});
		expect(liveCatalogScanDuration(10_000, 5_000)).toBe(0);
	});

	it('rejects unsafe starts and duration measurements', () => {
		const noStart = startCatalogScanSession(
			emptyCatalogScanTiming(),
			Number.MAX_SAFE_INTEGER,
			'safe'
		);
		expect(noStart.active).toBeUndefined();
		const timing = recordCatalogMatchingRequestDuration(started(), Number.MAX_SAFE_INTEGER);
		expect(timing.active?.longestMatchingRequestMs).toBe(0);
	});

	it('formats a compact truthful last-session summary', () => {
		const session = finalizedSession('summary', START + 47 * 60_000 + 12_000, {
			activeDurationMs: 47 * 60_000 + 12_000,
			processedEpisodes: 13,
			successfulEpisodes: 13
		});
		expect(formatCatalogScanSessionSummary(session)).toBe('47m 12s · 13 episodes · completed');
	});

	it('has no network behavior or process-wide metric attribution', () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const timing: CatalogScanTiming = recordCatalogScanEpisodeOutcome(started(), 'successful');
		expect(timing.active).not.toHaveProperty('searchRequests');
		expect(timing.active).not.toHaveProperty('persistentCacheHits');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('renders accessible scan-session controls and careful request terminology', () => {
		const component = readFileSync(
			fileURLToPath(new URL('../../routes/shows/[show]/+page.svelte', import.meta.url)),
			'utf8'
		);
		expect(component).toContain('Current scan:');
		expect(component).toContain('<details class="scan-history">');
		expect(component).toContain('Scan history ({scanTiming.history.length})');
		expect(component).toContain('client-observed');
		expect(component).toContain('not guaranteed server');
	});
});
