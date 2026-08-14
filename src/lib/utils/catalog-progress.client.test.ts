import { describe, expect, it, vi } from 'vitest';
import {
	CatalogPersistenceTimeoutError,
	createLatestSnapshotWriter,
	loadCatalogProgress,
	saveCatalogProgress
} from './catalog-progress.client';
import type { CatalogProgress } from './catalog-scan';

const progress: CatalogProgress = {
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias: 'show',
	updatedAt: 1,
	episodes: {},
	playlist: { title: 'Title', description: 'Description', public: false },
	retry: { cooldownUntil: 0, pausedByRateLimit: false }
};

describe('catalogue IndexedDB deadlines', () => {
	it('rejects an IndexedDB open that never settles', async () => {
		vi.useFakeTimers();
		try {
			const factory = { open: vi.fn(() => ({})) } as unknown as IDBFactory;
			const loading = loadCatalogProgress('show', { factory, timeoutMs: 20 });
			const expectation = expect(loading).rejects.toBeInstanceOf(CatalogPersistenceTimeoutError);

			await vi.advanceTimersByTimeAsync(20);
			await expectation;
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts and rejects a write transaction that never completes', async () => {
		vi.useFakeTimers();
		try {
			const transaction = {
				error: null,
				abort: vi.fn(),
				objectStore: () => ({ put: vi.fn() })
			} as unknown as IDBTransaction;
			const database = {
				transaction: () => transaction,
				close: vi.fn()
			} as unknown as IDBDatabase;
			const openRequest = { result: database } as IDBOpenDBRequest;
			const factory = {
				open: vi.fn(() => {
					queueMicrotask(() => openRequest.onsuccess?.(new Event('success')));
					return openRequest;
				})
			} as unknown as IDBFactory;

			const saving = saveCatalogProgress(progress, { factory, timeoutMs: 20 });
			const expectation = expect(saving).rejects.toBeInstanceOf(CatalogPersistenceTimeoutError);
			await vi.advanceTimersByTimeAsync(20);

			await expectation;
			expect(transaction.abort).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('latest review snapshot writer', () => {
	it('starts persistence immediately, coalesces redundant writes, and does not block cancellation', async () => {
		let releaseFirst: (() => void) | undefined;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const written: number[] = [];
		const writer = createLatestSnapshotWriter(
			async (snapshot: number) => {
				written.push(snapshot);
				if (snapshot === 1) await firstWrite;
			},
			() => undefined
		);
		const controller = new AbortController();

		writer.enqueue(1);
		writer.enqueue(2);
		writer.enqueue(3);
		controller.abort();

		expect(written).toEqual([1]);
		expect(controller.signal.aborted).toBe(true);
		releaseFirst?.();
		await writer.flush();
		expect(written).toEqual([1, 3]);
	});
});
