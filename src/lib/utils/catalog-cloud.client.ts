import { createCatalogBackup } from './catalog-backup';
import type { CatalogProgress } from './catalog-scan';
export type CloudCatalogueSummary = {
	showAlias: string;
	showName: string;
	updatedAt: number;
	scanned: number;
	pending: number;
	failed: number;
};

export type CloudCopy = { version: string; progress: CatalogProgress };
export class CloudSyncError extends Error {
	constructor(public readonly reason: 'conflict' | 'unavailable' | 'unauthorized') {
		super(`Cloud sync ${reason}`);
	}
}

const endpoint = (showAlias: string) => `/api/catalog-progress/${encodeURIComponent(showAlias)}`;
const markerKey = (showAlias: string) => `nts-cloud-sync:${showAlias}`;

export const cloudSyncAvailable = () =>
	location.origin === 'https://nts2spotify.vincentvanderveken.com';

export async function progressSignature(progress: CatalogProgress) {
	const portable = createCatalogBackup(progress).progress;
	const source = JSON.stringify({ ...portable, updatedAt: 0 });
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const readCloudMarker = (showAlias: string) => {
	try {
		const marker = JSON.parse(localStorage.getItem(markerKey(showAlias)) ?? 'null') as {
			version?: unknown;
			signature?: unknown;
		} | null;
		return typeof marker?.version === 'string' && typeof marker.signature === 'string'
			? { version: marker.version, signature: marker.signature }
			: null;
	} catch {
		return null;
	}
};

export const rememberCloudCopy = async (progress: CatalogProgress, version: string) => {
	try {
		localStorage.setItem(
			markerKey(progress.showAlias),
			JSON.stringify({ version, signature: await progressSignature(progress) })
		);
	} catch {
		// The cloud copy remains usable if browser storage is disabled.
	}
};

export const forgetCloudCopy = (showAlias: string) => {
	try {
		localStorage.removeItem(markerKey(showAlias));
	} catch {
		// The next open will compare the copies again.
	}
};

export async function loadCloudCopy(showAlias: string): Promise<CloudCopy | null> {
	let response: Response;
	try {
		response = await fetch(endpoint(showAlias), { credentials: 'same-origin', cache: 'no-store' });
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (response.status === 404) return null;
	if (response.status === 401) throw new CloudSyncError('unauthorized');
	if (!response.ok) throw new CloudSyncError('unavailable');
	return (await response.json()) as CloudCopy;
}

export async function listCloudCopies(): Promise<CloudCatalogueSummary[]> {
	let response: Response;
	try {
		response = await fetch('/api/catalog-progress', {
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (!response.ok) throw new CloudSyncError('unavailable');
	return ((await response.json()) as { catalogues: CloudCatalogueSummary[] }).catalogues;
}

export async function saveCloudCopy(progress: CatalogProgress, version: string | null) {
	let response: Response;
	try {
		response = await fetch(endpoint(progress.showAlias), {
			method: 'PUT',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ version, progress: createCatalogBackup(progress).progress })
		});
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (response.status === 409) throw new CloudSyncError('conflict');
	if (response.status === 401) throw new CloudSyncError('unauthorized');
	if (!response.ok) throw new CloudSyncError('unavailable');
	const result = (await response.json()) as { version?: unknown };
	if (typeof result.version !== 'string') throw new CloudSyncError('unavailable');
	return result.version;
}
