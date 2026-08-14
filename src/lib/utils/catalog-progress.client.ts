import type { CatalogProgress } from './catalog-scan';

const DATABASE_NAME = 'nts-to-spotify';
const DATABASE_VERSION = 1;
const STORE_NAME = 'catalog-progress';
export const INDEXED_DB_TIMEOUT_MS = 5_000;

type DatabaseOptions = {
	factory?: IDBFactory;
	timeoutMs?: number;
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

export const loadCatalogProgress = async (showAlias: string, options: DatabaseOptions = {}) => {
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

export const saveCatalogProgress = async (
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
		flush: () => running || Promise.resolve()
	};
};
