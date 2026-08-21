import type { CatalogProgress } from './catalog-scan';
import {
	CATALOG_BACKUP_MAX_BYTES,
	CatalogBackupValidationError,
	serializeCatalogBackup
} from './catalog-backup';

export type CatalogBackupFile = {
	name: string;
	size: number;
	text: () => Promise<string>;
};

type FileInputLike = {
	files: ArrayLike<CatalogBackupFile> | null;
	value: string;
};

type DownloadAnchor = {
	href: string;
	download: string;
	click: () => void;
	remove: () => void;
};

type DownloadDependencies = {
	createObjectUrl: (blob: Blob) => string;
	revokeObjectUrl: (url: string) => void;
	createAnchor: () => DownloadAnchor;
	schedule: (cleanup: () => void) => void;
};

const defaultDownloadDependencies = (): DownloadDependencies => ({
	createObjectUrl: (blob) => URL.createObjectURL(blob),
	revokeObjectUrl: (url) => URL.revokeObjectURL(url),
	createAnchor: () => {
		const anchor = document.createElement('a');
		document.body.appendChild(anchor);
		return anchor;
	},
	schedule: (cleanup) => void setTimeout(cleanup, 0)
});

export const takeSelectedCatalogBackupFile = (input: FileInputLike) => {
	const file = input.files?.[0];
	input.value = '';
	return file;
};

export const readCatalogBackupFile = async (file: CatalogBackupFile) => {
	if (!file.name.toLowerCase().endsWith('.json')) {
		throw new CatalogBackupValidationError('Choose a JSON catalogue progress backup.');
	}
	if (file.size > CATALOG_BACKUP_MAX_BYTES) {
		throw new CatalogBackupValidationError('The selected backup file is too large.');
	}
	return file.text();
};

export const catalogBackupFilename = (showAlias: string, date = new Date()) => {
	const safeAlias = showAlias.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 120) || 'nts-show';
	return `${safeAlias}-catalogue-progress-${date.toISOString().slice(0, 10)}.json`;
};

export const downloadCatalogProgressFile = (
	progress: CatalogProgress,
	filename: string,
	dependencies: DownloadDependencies = defaultDownloadDependencies()
) => {
	const contents = serializeCatalogBackup(progress);
	const blob = new Blob([contents], { type: 'application/json' });
	let objectUrl: string | undefined;
	let anchor: DownloadAnchor | undefined;
	let clicked = false;
	let cleanupError: unknown;
	try {
		objectUrl = dependencies.createObjectUrl(blob);
		anchor = dependencies.createAnchor();
		anchor.href = objectUrl;
		anchor.download = filename;
		anchor.click();
		clicked = true;
	} finally {
		anchor?.remove();
		if (objectUrl) {
			if (clicked) {
				const urlToRevoke = objectUrl;
				try {
					dependencies.schedule(() => dependencies.revokeObjectUrl(urlToRevoke));
				} catch (cause) {
					dependencies.revokeObjectUrl(objectUrl);
					cleanupError = cause;
				}
			} else {
				dependencies.revokeObjectUrl(objectUrl);
			}
		}
	}
	if (cleanupError) throw cleanupError;
};

export const downloadLatestCatalogProgress = async ({
	flush,
	capture,
	enqueue,
	download
}: {
	flush: () => Promise<void>;
	capture: () => CatalogProgress;
	enqueue: (progress: CatalogProgress) => void;
	download: (progress: CatalogProgress) => void;
}) => {
	await flush();
	const progress = capture();
	enqueue(progress);
	download(progress);
};
