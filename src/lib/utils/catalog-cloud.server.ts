import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { env } from '$env/dynamic/private';
import { hostedConfiguration } from './hosted-access.server';
import { isValidNTSSlug } from './nts';
import {
	CATALOG_BACKUP_FORMAT,
	CATALOG_BACKUP_VERSION,
	CATALOG_BACKUP_MAX_BYTES,
	parseCatalogBackup
} from './catalog-backup';
import type { CatalogProgress, EpisodeState } from './catalog-scan';

const FIRESTORE = 'https://firestore.googleapis.com/v1';
const TOKEN_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const EPISODE_MAX_BYTES = 900_000;
const MAX_EPISODES = 5_000;

type FirestoreDocument = {
	name: string;
	updateTime: string;
	fields?: Record<string, { stringValue?: string }>;
};
type Manifest = {
	version: string;
	progress: Omit<CatalogProgress, 'episodes'>;
	hashes: Record<string, string>;
};
export type CloudCatalogueSummary = {
	showAlias: string;
	showName: string;
	updatedAt: number;
	scanned: number;
	pending: number;
	failed: number;
};

export class CloudProgressError extends Error {
	constructor(public readonly kind: 'conflict' | 'unavailable' | 'invalid') {
		super(`Cloud progress ${kind}`);
	}
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export function validateCloudProgress(value: unknown, showAlias: string, now = Date.now()) {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new CloudProgressError('invalid');
	// Browser-only scan timers are not part of the portable backup format.
	const { scanTiming: _scanTiming, ...portable } = value as Record<string, unknown>;
	const serialized = JSON.stringify(portable);
	if (!serialized || bytes(serialized) > CATALOG_BACKUP_MAX_BYTES)
		throw new CloudProgressError('invalid');
	try {
		return parseCatalogBackup(
			JSON.stringify({
				format: CATALOG_BACKUP_FORMAT,
				version: CATALOG_BACKUP_VERSION,
				exportedAt: new Date(now).toISOString(),
				showAlias,
				progress: portable
			}),
			showAlias,
			now
		).progress;
	} catch {
		throw new CloudProgressError('invalid');
	}
}

const cloudConfig = () => {
	const hosted = hostedConfiguration();
	if (!hosted) throw new CloudProgressError('unavailable');
	const project = env.NTS_FIRESTORE_PROJECT;
	if (!project || !/^[a-z][a-z0-9-]{4,62}$/.test(project))
		throw new CloudProgressError('unavailable');
	return { project, userId: hosted.userId };
};

const documentBase = () => {
	const { project, userId } = cloudConfig();
	return `projects/${project}/databases/(default)/documents/ntsUsers/${encodeURIComponent(userId)}`;
};

const documentPaths = (showAlias: string) => {
	if (!isValidNTSSlug(showAlias)) throw new CloudProgressError('invalid');
	const name = `${documentBase()}/catalogues/${showAlias}`;
	return { name, url: `${FIRESTORE}/${name}`, episodes: `${name}/episodes` };
};

const accessToken = async (request: typeof fetch) => {
	try {
		const response = await request(TOKEN_URL, {
			headers: { 'Metadata-Flavor': 'Google' },
			signal: AbortSignal.timeout(5_000)
		});
		if (!response.ok) throw new Error('Metadata unavailable');
		const payload = (await response.json()) as { access_token?: unknown };
		if (typeof payload.access_token !== 'string' || !payload.access_token)
			throw new Error('Token unavailable');
		return payload.access_token;
	} catch {
		throw new CloudProgressError('unavailable');
	}
};

const firestoreRequest = async (
	request: typeof fetch,
	token: string,
	url: string,
	init: RequestInit = {}
) => {
	try {
		return await request(url, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...init.headers },
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		throw new CloudProgressError('unavailable');
	}
};

const readManifest = async (request: typeof fetch, token: string, url: string) => {
	const response = await firestoreRequest(request, token, url);
	if (response.status === 404) return null;
	if (!response.ok) throw new CloudProgressError('unavailable');
	try {
		const document = (await response.json()) as FirestoreDocument;
		const progress = JSON.parse(document.fields?.progress?.stringValue ?? 'null') as Omit<
			CatalogProgress,
			'episodes'
		>;
		const hashes = JSON.parse(document.fields?.hashes?.stringValue ?? 'null') as Record<
			string,
			string
		>;
		if (
			!document.updateTime ||
			!progress ||
			!hashes ||
			Array.isArray(hashes) ||
			Object.keys(hashes).length > MAX_EPISODES
		)
			throw new Error('Invalid manifest');
		return { version: document.updateTime, progress, hashes } satisfies Manifest;
	} catch {
		throw new CloudProgressError('unavailable');
	}
};

export async function listCloudCatalogues(request: typeof fetch = fetch) {
	const token = await accessToken(request);
	const summaries: CloudCatalogueSummary[] = [];
	let pageToken: string | undefined;
	do {
		const url = new URL(`${FIRESTORE}/${documentBase()}/catalogues`);
		url.searchParams.set('pageSize', '100');
		if (pageToken) url.searchParams.set('pageToken', pageToken);
		const response = await firestoreRequest(request, token, url.toString());
		if (!response.ok) throw new CloudProgressError('unavailable');
		let result: { documents?: FirestoreDocument[]; nextPageToken?: string };
		try {
			result = (await response.json()) as typeof result;
			for (const document of result.documents ?? []) {
				const progress = JSON.parse(document.fields?.progress?.stringValue ?? 'null') as Omit<
					CatalogProgress,
					'episodes'
				>;
				const counts = JSON.parse(document.fields?.counts?.stringValue ?? 'null') as {
					scanned: number;
					pending: number;
					failed: number;
				} | null;
				if (!progress || !isValidNTSSlug(progress.showAlias)) continue;
				summaries.push({
					showAlias: progress.showAlias,
					showName: progress.display?.showName || progress.showAlias,
					updatedAt: progress.updatedAt,
					scanned: counts?.scanned ?? 0,
					pending: counts?.pending ?? 0,
					failed: counts?.failed ?? 0
				});
			}
		} catch {
			throw new CloudProgressError('unavailable');
		}
		pageToken = result.nextPageToken;
		if (summaries.length > MAX_EPISODES) throw new CloudProgressError('unavailable');
	} while (pageToken);
	return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadCloudProgress(showAlias: string, request: typeof fetch = fetch) {
	const paths = documentPaths(showAlias);
	const token = await accessToken(request);
	const manifest = await readManifest(request, token, paths.url);
	if (!manifest) return null;
	const episodes: Record<string, EpisodeState> = {};
	let pageToken: string | undefined;
	do {
		const url = new URL(`${FIRESTORE}/${paths.episodes}`);
		url.searchParams.set('pageSize', '300');
		if (pageToken) url.searchParams.set('pageToken', pageToken);
		const response = await firestoreRequest(request, token, url.toString());
		if (!response.ok) throw new CloudProgressError('unavailable');
		let result: { documents?: FirestoreDocument[]; nextPageToken?: string };
		try {
			result = (await response.json()) as typeof result;
			for (const document of result.documents ?? []) {
				const alias = decodeURIComponent(document.name.slice(paths.episodes.length + 1));
				const encoded = document.fields?.payload?.stringValue;
				if (!encoded || !encoded.startsWith('gz:') || episodes[alias])
					throw new Error('Invalid episode');
				const payload = gunzipSync(Buffer.from(encoded.slice(3), 'base64'), {
					maxOutputLength: 1_000_000
				}).toString('utf8');
				if (manifest.hashes[alias] !== hash(payload)) throw new Error('Invalid episode');
				episodes[alias] = JSON.parse(payload) as EpisodeState;
			}
		} catch {
			throw new CloudProgressError('unavailable');
		}
		pageToken = result.nextPageToken;
		if (Object.keys(episodes).length > MAX_EPISODES) throw new CloudProgressError('unavailable');
	} while (pageToken);
	if (Object.keys(episodes).length !== Object.keys(manifest.hashes).length)
		throw new CloudProgressError('unavailable');
	const progress = validateCloudProgress({ ...manifest.progress, episodes }, showAlias);
	return { version: manifest.version, progress };
}

export async function saveCloudProgress(
	showAlias: string,
	progressInput: unknown,
	version: string | null,
	request: typeof fetch = fetch
) {
	if (version !== null && (typeof version !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(version)))
		throw new CloudProgressError('invalid');
	const progress = validateCloudProgress(progressInput, showAlias);
	const paths = documentPaths(showAlias);
	const token = await accessToken(request);
	const current = await readManifest(request, token, paths.url);
	if ((current?.version ?? null) !== version) throw new CloudProgressError('conflict');
	const { episodes, ...metadata } = progress;
	const counts = { scanned: 0, pending: 0, failed: 0 };
	for (const episode of Object.values(episodes)) {
		if (episode.status === 'done') counts.scanned += 1;
		else if (episode.status === 'error') counts.failed += 1;
		else counts.pending += 1;
	}
	const hashes: Record<string, string> = {};
	const writes: unknown[] = [];
	for (const [alias, episode] of Object.entries(episodes)) {
		if (!isValidNTSSlug(alias) || episode.status === 'pending') continue;
		const payload = JSON.stringify(episode);
		if (bytes(payload) > 1_000_000) throw new CloudProgressError('invalid');
		hashes[alias] = hash(payload);
		if (current?.hashes[alias] === hashes[alias]) continue;
		const encoded = `gz:${gzipSync(payload).toString('base64')}`;
		if (bytes(encoded) > EPISODE_MAX_BYTES) throw new CloudProgressError('invalid');
		writes.push({
			update: {
				name: `${paths.episodes}/${alias}`,
				fields: { payload: { stringValue: encoded } }
			}
		});
	}
	for (const alias of Object.keys(current?.hashes ?? {})) {
		if (!(alias in hashes)) writes.push({ delete: `${paths.episodes}/${alias}` });
	}
	writes.push({
		update: {
			name: paths.name,
			fields: {
				progress: { stringValue: JSON.stringify(metadata) },
				hashes: { stringValue: JSON.stringify(hashes) },
				counts: { stringValue: JSON.stringify(counts) }
			}
		},
		currentDocument: version ? { updateTime: version } : { exists: false }
	});
	if (writes.length > MAX_EPISODES + 1) throw new CloudProgressError('invalid');
	const { project } = cloudConfig();
	const response = await firestoreRequest(
		request,
		token,
		`${FIRESTORE}/projects/${project}/databases/(default)/documents:commit`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ writes })
		}
	);
	if (!response.ok) {
		if (response.status === 409 || response.status === 412)
			throw new CloudProgressError('conflict');
		if (response.status === 400) {
			const details = (await response.json().catch(() => null)) as {
				error?: { status?: unknown };
			} | null;
			if (details?.error?.status === 'FAILED_PRECONDITION')
				throw new CloudProgressError('conflict');
		}
		throw new CloudProgressError('unavailable');
	}
	const result = (await response.json()) as { writeResults?: Array<{ updateTime?: string }> };
	const nextVersion = result.writeResults?.at(-1)?.updateTime;
	if (!nextVersion) throw new CloudProgressError('unavailable');
	return nextVersion;
}
