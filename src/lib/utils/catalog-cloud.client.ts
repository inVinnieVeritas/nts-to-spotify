import { createCatalogBackup } from './catalog-backup';
import type { CatalogProgress } from './catalog-scan';
import {
	bridgeRequest,
	isLocalCloudBridge,
	localCloudOwnerMatches
} from './catalog-cloud-bridge.client';
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

export const cloudSyncAvailable = (userId?: string) =>
	location.origin === 'https://nts2spotify.vincentvanderveken.com' ||
	(!!userId && localCloudOwnerMatches(userId));

async function cloudRequest(method: 'GET' | 'PUT', path: string, body?: unknown) {
	if (isLocalCloudBridge()) return bridgeRequest(method, path, body);
	const response = await fetch(path, {
		method,
		credentials: 'same-origin',
		cache: 'no-store',
		...(method === 'PUT'
			? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
			: {})
	});
	return { status: response.status, body: await response.json() };
}

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
	let response: { status: number; body: unknown };
	try {
		response = await cloudRequest('GET', endpoint(showAlias));
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (response.status === 404) return null;
	if (response.status === 401) throw new CloudSyncError('unauthorized');
	if (response.status !== 200) throw new CloudSyncError('unavailable');
	return response.body as CloudCopy;
}

export async function listCloudCopies(): Promise<CloudCatalogueSummary[]> {
	let response: { status: number; body: unknown };
	try {
		response = await cloudRequest('GET', '/api/catalog-progress');
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (response.status !== 200) throw new CloudSyncError('unavailable');
	return (response.body as { catalogues: CloudCatalogueSummary[] }).catalogues;
}

export async function saveCloudCopy(progress: CatalogProgress, version: string | null) {
	let response: { status: number; body: unknown };
	try {
		response = await cloudRequest('PUT', endpoint(progress.showAlias), {
			version,
			progress: createCatalogBackup(progress).progress
		});
	} catch {
		throw new CloudSyncError('unavailable');
	}
	if (response.status === 409) throw new CloudSyncError('conflict');
	if (response.status === 401) throw new CloudSyncError('unauthorized');
	if (response.status !== 200) throw new CloudSyncError('unavailable');
	const result = response.body as { version?: unknown };
	if (typeof result.version !== 'string') throw new CloudSyncError('unavailable');
	return result.version;
}
