import { describe, expect, it, vi } from 'vitest';
import {
	CatalogPersistenceTimeoutError,
	coordinateCatalogProgressOperation,
	createLatestSnapshotWriter,
	deleteCatalogProgress,
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

describe('catalogue progress reset', () => {
	it('deletes only the current show record', async () => {
		const records = new Map([
			['show-a', { ...progress, showAlias: 'show-a' }],
			['show-b', { ...progress, showAlias: 'show-b' }]
		]);
		const transaction = {
			error: null,
			abort: vi.fn(),
			objectStore: () => objectStore
		} as unknown as IDBTransaction;
		const objectStore = {
			delete: vi.fn((showAlias: string) => {
				records.delete(showAlias);
				queueMicrotask(() => transaction.oncomplete?.(new Event('complete')));
			})
		};
		const database = {
			transaction: vi.fn(() => transaction),
			close: vi.fn()
		} as unknown as IDBDatabase;
		const openRequest = { result: database } as IDBOpenDBRequest;
		const factory = {
			open: vi.fn(() => {
				queueMicrotask(() => openRequest.onsuccess?.(new Event('success')));
				return openRequest;
			})
		} as unknown as IDBFactory;

		await deleteCatalogProgress('show-a', { factory, timeoutMs: 20 });

		expect(objectStore.delete).toHaveBeenCalledWith('show-a');
		expect(records.has('show-a')).toBe(false);
		expect(records.has('show-b')).toBe(true);
	});
});

describe('catalogue progress operation coordination', () => {
	it('serializes save, restore, and delete operations for the same show', async () => {
		let releaseSave: (() => void) | undefined;
		const saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const order: string[] = [];
		const save = coordinateCatalogProgressOperation('serialized-show', async () => {
			order.push('save:start');
			await saveGate;
			order.push('save:end');
		});
		const restore = coordinateCatalogProgressOperation('serialized-show', async () => {
			order.push('restore');
		});
		const remove = coordinateCatalogProgressOperation('serialized-show', async () => {
			order.push('delete');
		});

		await vi.waitFor(() => expect(order).toEqual(['save:start']));
		releaseSave?.();
		await Promise.all([save, restore, remove]);
		expect(order).toEqual(['save:start', 'save:end', 'restore', 'delete']);
	});

	it('allows different shows to make progress independently', async () => {
		let releaseFirstShow: (() => void) | undefined;
		const firstShowGate = new Promise<void>((resolve) => {
			releaseFirstShow = resolve;
		});
		const started: string[] = [];
		const first = coordinateCatalogProgressOperation('independent-a', async () => {
			started.push('a');
			await firstShowGate;
		});
		const second = coordinateCatalogProgressOperation('independent-b', async () => {
			started.push('b');
		});

		await second;
		expect(started).toEqual(['a', 'b']);
		releaseFirstShow?.();
		await first;
	});

	it('makes a same-show read observe the latest settled write', async () => {
		let releaseWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let stored = 'before';
		const write = coordinateCatalogProgressOperation('read-after-write', async () => {
			await writeGate;
			stored = 'after';
		});
		const read = coordinateCatalogProgressOperation('read-after-write', async () => stored);

		releaseWrite?.();
		await write;
		await expect(read).resolves.toBe('after');
	});

	it('recovers the per-show queue after an operation fails', async () => {
		const recovered = vi.fn(async () => 'recovered');
		await expect(
			coordinateCatalogProgressOperation('failure-show', async () => {
				throw new Error('IndexedDB failed');
			})
		).rejects.toThrow('IndexedDB failed');
		await expect(coordinateCatalogProgressOperation('failure-show', recovered)).resolves.toBe(
			'recovered'
		);
		expect(recovered).toHaveBeenCalledOnce();
	});

	it('prevents an old pending writer from recreating a record after a queued reset', async () => {
		const records = new Map<string, string>();
		let releaseOldWriter: (() => void) | undefined;
		const oldWriterGate = new Promise<void>((resolve) => {
			releaseOldWriter = resolve;
		});
		const writer = createLatestSnapshotWriter(
			(snapshot: string) =>
				coordinateCatalogProgressOperation('replacement-show', async () => {
					if (snapshot === 'running') await oldWriterGate;
					records.set('replacement-show', snapshot);
				}),
			() => undefined
		);
		writer.enqueue('running');
		writer.enqueue('coalesced pending snapshot');
		writer.discardPending();
		const reset = coordinateCatalogProgressOperation('replacement-show', async () => {
			records.delete('replacement-show');
		});

		releaseOldWriter?.();
		await Promise.all([writer.flush(), reset]);
		expect(records.has('replacement-show')).toBe(false);
	});

	it('orders old and replacement component writers around a restore', async () => {
		let releaseOldWriter: (() => void) | undefined;
		const oldWriterGate = new Promise<void>((resolve) => {
			releaseOldWriter = resolve;
		});
		let stored = 'initial';
		let replacementObserved = '';
		const oldWriter = coordinateCatalogProgressOperation('hmr-show', async () => {
			await oldWriterGate;
			stored = 'old';
		});
		const restore = coordinateCatalogProgressOperation('hmr-show', async () => {
			stored = 'restored';
		});
		const replacementWriter = coordinateCatalogProgressOperation('hmr-show', async () => {
			replacementObserved = stored;
			stored = `${stored} + replacement edit`;
		});

		releaseOldWriter?.();
		await Promise.all([oldWriter, restore, replacementWriter]);
		expect(replacementObserved).toBe('restored');
		expect(stored).toBe('restored + replacement edit');
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
