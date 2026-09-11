import type { CatalogProgress } from './catalog-scan';
import {
	CATALOG_BACKUP_FORMAT,
	CATALOG_BACKUP_VERSION,
	parseCatalogBackup
} from './catalog-backup';
import { restoreCatalogScanTiming } from './catalog-scan-session';
import {
	isCatalogPlaylistSyncRecord,
	PLAYLIST_SYNC_LEASE_MS,
	restoreCatalogPlaylistSyncRecord,
	type CatalogPlaylistSyncRecord
} from './playlist-sync.client';

const DATABASE_NAME = 'nts-to-spotify';
const DATABASE_VERSION = 1;
const STORE_NAME = 'catalog-progress';
const PLAYLIST_SYNC_KEY_PREFIX = '\u0000playlist-sync:';
export const INDEXED_DB_TIMEOUT_MS = 5_000;

type DatabaseOptions = {
	factory?: IDBFactory;
	timeoutMs?: number;
};

export type CatalogProgressListResult = {
	records: CatalogProgress[];
	skippedCount: number;
};

const operationQueues = new Map<string, Promise<void>>();

const playlistSyncKey = (showAlias: string) => `${PLAYLIST_SYNC_KEY_PREFIX}${showAlias}`;
const storedPlaylistSyncRecord = (record: CatalogPlaylistSyncRecord) => ({
	...record,
	showAlias: playlistSyncKey(record.catalogueAlias)
});
const catalogPlaylistSyncRecordFromStored = (
	value: unknown,
	showAlias: string,
	now = Date.now(),
	recover = true
) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const { showAlias: storageAlias, ...record } = value as Record<string, unknown>;
	if (storageAlias !== playlistSyncKey(showAlias)) return undefined;
	if (!recover && isCatalogPlaylistSyncRecord(record, showAlias, now))
		return structuredClone(record);
	return restoreCatalogPlaylistSyncRecord(record, showAlias, now);
};

export const coordinateCatalogProgressOperation = <T>(
	showAlias: string,
	operation: () => Promise<T>
) => {
	const previous = operationQueues.get(showAlias) || Promise.resolve();
	const result = previous.catch(() => undefined).then(operation);
	const settled = result.then(
		() => undefined,
		() => undefined
	);
	operationQueues.set(showAlias, settled);
	void settled.finally(() => {
		if (operationQueues.get(showAlias) === settled) operationQueues.delete(showAlias);
	});
	return result;
};

export class CatalogPersistenceTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CatalogPersistenceTimeoutError';
	}
}

const openDatabase = ({
	factory = indexedDB,
	timeoutMs = INDEXED_DB_TIMEOUT_MS
}: DatabaseOptions) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new CatalogPersistenceTimeoutError('Opening catalogue progress timed out'));
		}, timeoutMs);
		request.onerror = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(request.error);
		};
		request.onsuccess = () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolve(request.result);
		};
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: 'showAlias' });
			}
		};
	});

const loadCatalogProgressUncoordinated = async (
	showAlias: string,
	options: DatabaseOptions = {}
) => {
	const database = await openDatabase(options);
	try {
		return await new Promise<CatalogProgress | null>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readonly');
			const request = transaction.objectStore(STORE_NAME).get(showAlias);
			let result: CatalogProgress | null = null;
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Loading catalogue progress timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error || request.error);
			};
			request.onerror = fail;
			request.onsuccess = () => {
				result = (request.result as CatalogProgress | undefined) || null;
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
		});
	} finally {
		database.close();
	}
};

export const loadCatalogProgress = (showAlias: string, options: DatabaseOptions = {}) =>
	coordinateCatalogProgressOperation(showAlias, () =>
		loadCatalogProgressUncoordinated(showAlias, options)
	);

const waitForQueuedCatalogProgressOperations = async (timeoutMs = INDEXED_DB_TIMEOUT_MS) => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() =>
				reject(
					new CatalogPersistenceTimeoutError('Waiting for catalogue progress operations timed out')
				),
			timeoutMs
		);
	});
	try {
		for (;;) {
			const queued = [...operationQueues.values()];
			if (queued.length === 0) {
				await Promise.resolve();
				if (operationQueues.size === 0) return;
				continue;
			}
			await Promise.race([Promise.all(queued), deadline]);
			await Promise.resolve();
		}
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

const validateStoredCatalogProgress = (value: unknown, now: number) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const showAlias = record.showAlias;
	if (typeof showAlias !== 'string' || showAlias.length === 0) return undefined;
	try {
		const { scanTiming: storedScanTiming, ...backupCompatibleProgress } = record;
		const progress = parseCatalogBackup(
			JSON.stringify({
				format: CATALOG_BACKUP_FORMAT,
				version: CATALOG_BACKUP_VERSION,
				exportedAt: new Date(now).toISOString(),
				showAlias,
				progress: backupCompatibleProgress
			}),
			showAlias,
			now
		).progress;
		const scanTiming = restoreCatalogScanTiming(storedScanTiming).timing;
		if (scanTiming.active || scanTiming.history.length > 0) progress.scanTiming = scanTiming;
		return progress;
	} catch {
		return undefined;
	}
};

const listCatalogProgressUncoordinated = async (
	options: DatabaseOptions = {}
): Promise<CatalogProgressListResult> => {
	const database = await openDatabase(options);
	try {
		const values = await new Promise<unknown[]>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readonly');
			const request = transaction.objectStore(STORE_NAME).getAll();
			let result: unknown[] = [];
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Listing catalogue progress timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error || request.error);
			};
			request.onerror = fail;
			request.onsuccess = () => {
				result = Array.isArray(request.result) ? request.result : [];
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
		});

		const now = Date.now();
		const records: CatalogProgress[] = [];
		let skippedCount = 0;
		for (const value of values) {
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				typeof (value as Record<string, unknown>).showAlias === 'string' &&
				((value as Record<string, unknown>).showAlias as string).startsWith(
					PLAYLIST_SYNC_KEY_PREFIX
				)
			) {
				continue;
			}
			const validated = validateStoredCatalogProgress(value, now);
			if (validated) records.push(validated);
			else skippedCount += 1;
		}
		records.sort((left, right) => right.updatedAt - left.updatedAt);
		return { records, skippedCount };
	} finally {
		database.close();
	}
};

export const listCatalogProgress = async (options: DatabaseOptions = {}) => {
	await waitForQueuedCatalogProgressOperations(options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
	return listCatalogProgressUncoordinated(options);
};

const saveCatalogProgressUncoordinated = async (
	progress: CatalogProgress,
	options: DatabaseOptions = {}
) => {
	const database = await openDatabase(options);
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Saving catalogue progress timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error);
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			transaction.objectStore(STORE_NAME).put(progress);
		});
	} finally {
		database.close();
	}
};

export const saveCatalogProgress = (progress: CatalogProgress, options: DatabaseOptions = {}) =>
	coordinateCatalogProgressOperation(progress.showAlias, () =>
		saveCatalogProgressUncoordinated(progress, options)
	);

const loadCatalogPlaylistSyncUncoordinated = async (
	showAlias: string,
	options: DatabaseOptions = {}
) => {
	const database = await openDatabase(options);
	try {
		return await new Promise<CatalogPlaylistSyncRecord | undefined>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readonly');
			const request = transaction.objectStore(STORE_NAME).get(playlistSyncKey(showAlias));
			let result: CatalogPlaylistSyncRecord | undefined;
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Loading playlist synchronization timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error || request.error);
			};
			request.onerror = fail;
			request.onsuccess = () => {
				result = catalogPlaylistSyncRecordFromStored(request.result, showAlias);
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result ? structuredClone(result) : undefined);
			};
		});
	} finally {
		database.close();
	}
};

export const loadCatalogPlaylistSync = (showAlias: string, options: DatabaseOptions = {}) =>
	coordinateCatalogProgressOperation(showAlias, () =>
		loadCatalogPlaylistSyncUncoordinated(showAlias, options)
	);

const writeCatalogPlaylistSyncUncoordinated = async (
	record: CatalogPlaylistSyncRecord,
	options: DatabaseOptions = {}
) => {
	if (!isCatalogPlaylistSyncRecord(record, record.catalogueAlias)) {
		throw new Error('Invalid catalogue playlist synchronization record');
	}
	const database = await openDatabase(options);
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Saving playlist synchronization timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error);
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			transaction.objectStore(STORE_NAME).put(storedPlaylistSyncRecord(record));
		});
	} finally {
		database.close();
	}
};

export const saveCatalogPlaylistSync = (
	record: CatalogPlaylistSyncRecord,
	options: DatabaseOptions = {}
) =>
	coordinateCatalogProgressOperation(record.catalogueAlias, () =>
		writeCatalogPlaylistSyncUncoordinated(record, options)
	);

export type CatalogPlaylistSyncLeaseResult = {
	acquired: boolean;
	record?: CatalogPlaylistSyncRecord;
};

const claimCatalogPlaylistSyncLeaseUncoordinated = async (
	candidate: CatalogPlaylistSyncRecord,
	leaseOwner: string,
	now: number,
	leaseMs: number,
	options: DatabaseOptions,
	release = false
): Promise<CatalogPlaylistSyncLeaseResult> => {
	if (
		!isCatalogPlaylistSyncRecord(candidate, candidate.catalogueAlias, now) ||
		!Number.isSafeInteger(now) ||
		now < 0 ||
		!Number.isSafeInteger(leaseMs) ||
		leaseMs <= 0 ||
		leaseMs > PLAYLIST_SYNC_LEASE_MS ||
		!Number.isSafeInteger(now + leaseMs)
	) {
		throw new Error('Invalid playlist synchronization lease');
	}
	const database = await openDatabase(options);
	try {
		return await new Promise<CatalogPlaylistSyncLeaseResult>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get(playlistSyncKey(candidate.catalogueAlias));
			let result: CatalogPlaylistSyncLeaseResult | undefined;
			let operationError: unknown;
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Claiming playlist synchronization timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(operationError || transaction.error || request.error);
			};
			request.onerror = fail;
			request.onsuccess = () => {
				try {
					const current = catalogPlaylistSyncRecordFromStored(
						request.result,
						candidate.catalogueAlias,
						now,
						false
					);
					const startsNewOperation = Boolean(
						current &&
						current.operationId !== candidate.operationId &&
						(current.phase === 'completed' ||
							(current.phase === 'blocked' && current.reason === 'external-change')) &&
						candidate.phase === 'interrupted' &&
						candidate.confirmedPosition === 0 &&
						candidate.restartRequired === true &&
						candidate.playlistId === current.playlistId
					);
					// Never replace unreadable existing coordination state, nor accept an
					// old revision or operation even after its lease has been released.
					if (
						(request.result !== undefined && !current) ||
						(current &&
							((current.operationId !== candidate.operationId && !startsNewOperation) ||
								current.revision !== candidate.revision)) ||
						(current &&
							['uncertain', 'blocked'].includes(current.phase) &&
							current.reason === 'uncertain' &&
							!['uncertain', 'blocked'].includes(candidate.phase)) ||
						(current && current.playlistId && candidate.playlistId !== current.playlistId) ||
						(current &&
							current.targetFingerprint !== candidate.targetFingerprint &&
							current.phase !== 'creating' &&
							current.phase !== 'completed' &&
							!(current.phase === 'blocked' && current.reason === 'external-change')) ||
						(!current && (candidate.revision !== 0 || release)) ||
						(release && current?.leaseOwner !== leaseOwner)
					) {
						result = { acquired: false, record: current };
						return;
					}
					if (
						current?.leaseOwner &&
						current.leaseOwner !== leaseOwner &&
						(current.leaseUntil ?? 0) > now
					) {
						result = { acquired: false, record: current };
						return;
					}
					const next = {
						...candidate,
						revision: candidate.revision + 1,
						...(release
							? { leaseOwner: undefined, leaseUntil: undefined }
							: { leaseOwner, leaseUntil: now + leaseMs }),
						updatedAt: now
					};
					if (!isCatalogPlaylistSyncRecord(next, candidate.catalogueAlias, now)) {
						throw new Error('Invalid claimed playlist synchronization record');
					}
					store.put(storedPlaylistSyncRecord(next));
					result = { acquired: true, record: next };
				} catch (cause) {
					operationError = cause;
					transaction.abort();
				}
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result ?? { acquired: false });
			};
		});
	} finally {
		database.close();
	}
};

export const claimCatalogPlaylistSyncLease = (
	candidate: CatalogPlaylistSyncRecord,
	leaseOwner: string,
	now: number,
	leaseMs: number,
	options: DatabaseOptions = {},
	release = false
) =>
	coordinateCatalogProgressOperation(candidate.catalogueAlias, () =>
		claimCatalogPlaylistSyncLeaseUncoordinated(
			candidate,
			leaseOwner,
			now,
			leaseMs,
			options,
			release
		)
	);

export const deleteCatalogPlaylistSync = (showAlias: string, options: DatabaseOptions = {}) =>
	coordinateCatalogProgressOperation(showAlias, async () => {
		const database = await openDatabase(options);
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(STORE_NAME, 'readwrite');
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					try {
						transaction.abort();
					} catch {
						// The transaction may already be inactive.
					}
					reject(new CatalogPersistenceTimeoutError('Deleting playlist synchronization timed out'));
				}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
				const fail = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					reject(transaction.error);
				};
				transaction.onerror = fail;
				transaction.onabort = fail;
				transaction.oncomplete = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					resolve();
				};
				transaction.objectStore(STORE_NAME).delete(playlistSyncKey(showAlias));
			});
		} finally {
			database.close();
		}
	});

const updateCatalogProgressUncoordinated = async (
	showAlias: string,
	update: (current: CatalogProgress) => CatalogProgress,
	options: DatabaseOptions = {}
) => {
	const database = await openDatabase(options);
	try {
		return await new Promise<CatalogProgress>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get(showAlias);
			let next: CatalogProgress | undefined;
			let operationError: unknown;
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Updating catalogue progress timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(operationError || transaction.error || request.error);
			};
			request.onerror = fail;
			request.onsuccess = () => {
				const current = request.result as CatalogProgress | undefined;
				try {
					if (!current) throw new Error('Catalogue progress is no longer available');
					next = update(current);
					if (next.showAlias !== showAlias) throw new Error('Catalogue progress alias changed');
					if (next !== current) store.put(next);
				} catch (cause) {
					operationError = cause;
					try {
						transaction.abort();
					} catch {
						fail();
					}
				}
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (next) resolve(next);
				else reject(new Error('Catalogue progress update did not complete'));
			};
		});
	} finally {
		database.close();
	}
};

export const updateCatalogProgress = (
	showAlias: string,
	update: (current: CatalogProgress) => CatalogProgress,
	options: DatabaseOptions = {}
) =>
	coordinateCatalogProgressOperation(showAlias, () =>
		updateCatalogProgressUncoordinated(showAlias, update, options)
	);

const deleteCatalogProgressUncoordinated = async (
	showAlias: string,
	options: DatabaseOptions = {}
) => {
	const database = await openDatabase(options);
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					transaction.abort();
				} catch {
					// The transaction may already be inactive.
				}
				reject(new CatalogPersistenceTimeoutError('Deleting catalogue progress timed out'));
			}, options.timeoutMs ?? INDEXED_DB_TIMEOUT_MS);
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(transaction.error);
			};
			transaction.onerror = fail;
			transaction.onabort = fail;
			transaction.oncomplete = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			const store = transaction.objectStore(STORE_NAME);
			store.delete(showAlias);
			store.delete(playlistSyncKey(showAlias));
		});
	} finally {
		database.close();
	}
};

export const deleteCatalogProgress = (showAlias: string, options: DatabaseOptions = {}) =>
	coordinateCatalogProgressOperation(showAlias, () =>
		deleteCatalogProgressUncoordinated(showAlias, options)
	);

export const createLatestSnapshotWriter = <T>(
	write: (snapshot: T) => Promise<void>,
	onError: (cause: unknown, snapshot: T) => void
) => {
	let pending: T | undefined;
	let running: Promise<void> | undefined;

	const drain = async () => {
		while (pending !== undefined) {
			const snapshot = pending;
			pending = undefined;
			try {
				await write(snapshot);
			} catch (cause) {
				onError(cause, snapshot);
			}
		}
	};

	return {
		enqueue(snapshot: T) {
			pending = snapshot;
			if (!running) {
				running = drain().finally(() => {
					running = undefined;
					if (pending !== undefined) this.enqueue(pending);
				});
			}
		},
		discardPending() {
			pending = undefined;
		},
		flush: () => running || Promise.resolve()
	};
};
