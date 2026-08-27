import { constants as fileConstants, type Dirent, type Stats } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { BasicTrack, Match, MatchedTrack } from '$lib/types';
import { parseOfficialSpotifyArtworkUrl } from './artwork';
import { abortableDelay } from './abort';

export const SPOTIFY_PERSISTENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SPOTIFY_PERSISTENT_CACHE_MAX_ENTRIES = 10_000;
export const SPOTIFY_PERSISTENT_CACHE_MAX_FILE_BYTES = 16 * 1024 * 1024;
// Touches are persisted at most once per debounce window; new results bypass the delay.
export const SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS = 250;
// Five minutes tolerates modest wall-clock rollback without accepting attacker-sized future times.
export const SPOTIFY_PERSISTENT_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'spotify-match-cache.json';
const CACHE_TEMP_FILE_PREFIX = `${CACHE_FILE_NAME}.tmp-`;
const CACHE_TEMP_FILE_PATTERN = /^spotify-match-cache\.json\.tmp-[A-Za-z0-9-]+$/;
const CACHE_LOCK_DIRECTORY_NAME = 'spotify-match-cache.lock';
const CACHE_LOCK_OWNER_FILE_NAME = 'owner.json';
const CACHE_LOCK_MAX_ATTEMPTS = 12;
const CACHE_LOCK_RETRY_MS = 20;
const CACHE_ARTIFACT_STALE_MS = 10 * 60 * 1000;
const SEARCH_METHOD = 'track-primary-then-title-v1' as const;
const MAX_TEXT_LENGTH = 4_096;
const MAX_URL_LENGTH = 4_096;
const MAX_MATCHES = 10;

export type SpotifyPersistentCacheIdentity = {
	matcherVersion: number;
	market: string;
	method: typeof SEARCH_METHOD;
	normalizedArtist: string;
	normalizedTitle: string;
	primaryQuery: string;
	fallbackQuery: string;
};

export interface SpotifyMatchCacheStorage {
	get(identity: SpotifyPersistentCacheIdentity): Promise<MatchedTrack | null>;
	set(identity: SpotifyPersistentCacheIdentity, value: MatchedTrack): Promise<void>;
	flush(): Promise<void>;
}

type PersistentRecord = {
	key: string;
	identity: SpotifyPersistentCacheIdentity;
	createdAt: number;
	accessedAt: number;
	expiresAt: number;
	eligible: true;
	value: MatchedTrack;
};

type PersistentFile = {
	schemaVersion: typeof CACHE_SCHEMA_VERSION;
	records: PersistentRecord[];
};

export type SpotifyMatchCacheFileSystem = {
	mkdir: typeof mkdir;
	realpath: typeof realpath;
	lstat: typeof lstat;
	open: typeof open;
	readdir: typeof readdir;
	readFile: typeof readFile;
	writeFile: typeof writeFile;
	rename: typeof rename;
	rmdir: typeof rmdir;
	unlink: typeof unlink;
};

const nodeFileSystem: SpotifyMatchCacheFileSystem = {
	mkdir,
	realpath,
	lstat,
	open,
	readdir,
	readFile,
	writeFile,
	rename,
	rmdir,
	unlink
};

export type FileSpotifyMatchCacheOptions = {
	directory: string;
	ttlMs?: number;
	maxEntries?: number;
	maxFileBytes?: number;
	now?: () => number;
	fileSystem?: SpotifyMatchCacheFileSystem;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

const hasExactKeys = (
	value: Record<string, unknown>,
	required: string[],
	optional: string[] = []
) => {
	const keys = Object.keys(value).sort();
	const expected = [...required, ...optional.filter((key) => key in value)].sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const isBoundedString = (value: unknown, maxLength = MAX_TEXT_LENGTH): value is string =>
	typeof value === 'string' && value.length <= maxLength;

export const normalizePersistentSpotifyKeyPart = (value: string) =>
	value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');

export const createSpotifyPersistentCacheIdentity = (
	track: BasicTrack,
	matcherVersion: number,
	market = ''
): SpotifyPersistentCacheIdentity => {
	const normalizedArtist = normalizePersistentSpotifyKeyPart(track.artist);
	const normalizedTitle = normalizePersistentSpotifyKeyPart(track.title);
	return {
		matcherVersion,
		market: normalizePersistentSpotifyKeyPart(market),
		method: SEARCH_METHOD,
		normalizedArtist,
		normalizedTitle,
		primaryQuery: `track:${normalizedTitle} artist:${normalizedArtist}`,
		fallbackQuery: `track:${normalizedTitle}`
	};
};

export const createSpotifyPersistentCacheKey = (identity: SpotifyPersistentCacheIdentity) =>
	JSON.stringify([
		identity.matcherVersion,
		identity.market,
		identity.method,
		identity.normalizedArtist,
		identity.normalizedTitle,
		identity.primaryQuery,
		identity.fallbackQuery
	]);

const normalizeMatchText = (value: string) =>
	value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/&/g, 'and')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

export const isConfidentSpotifyMatch = (track: BasicTrack, match: Match) => {
	if (normalizeMatchText(track.title) !== normalizeMatchText(match.title)) return false;
	const requestedArtist = normalizeMatchText(track.artist);
	return match.artist
		.split(',')
		.map(normalizeMatchText)
		.some(
			(artist) =>
				artist === requestedArtist ||
				(requestedArtist.length >= 5 &&
					(artist.includes(requestedArtist) || requestedArtist.includes(artist)))
		);
};

const parseSafeHttpsUrl = (value: unknown) => {
	if (!isBoundedString(value, MAX_URL_LENGTH)) return null;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? value : null;
	} catch {
		return null;
	}
};

const parseMatch = (value: unknown): Match | null => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['artist', 'href', 'title', 'uri'], ['cover', 'preview'])
	) {
		return null;
	}
	if (
		!isBoundedString(value.artist) ||
		!isBoundedString(value.title) ||
		!isBoundedString(value.uri, 36) ||
		!isBoundedString(value.href, MAX_URL_LENGTH)
	) {
		return null;
	}
	const uriMatch = /^spotify:track:([A-Za-z0-9]{22})$/.exec(value.uri);
	if (!uriMatch || value.href !== `https://open.spotify.com/track/${uriMatch[1]}`) return null;

	let cover: string | undefined;
	if ('cover' in value && value.cover !== undefined) {
		cover = parseOfficialSpotifyArtworkUrl(value.cover);
		if (!cover || cover !== value.cover) return null;
	}
	let preview: string | undefined;
	if ('preview' in value && value.preview !== undefined) {
		preview = parseSafeHttpsUrl(value.preview) ?? undefined;
		if (!preview || preview !== value.preview) return null;
	}
	return {
		artist: value.artist,
		title: value.title,
		uri: value.uri,
		href: value.href,
		...(cover ? { cover } : {}),
		...(preview ? { preview } : {})
	};
};

const parseMatchedTrack = (
	value: unknown,
	identity: SpotifyPersistentCacheIdentity
): MatchedTrack | null => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['artist', 'confident', 'fallback', 'matches', 'title']) ||
		!isBoundedString(value.artist) ||
		!isBoundedString(value.title) ||
		typeof value.confident !== 'boolean' ||
		typeof value.fallback !== 'boolean' ||
		!Array.isArray(value.matches) ||
		value.matches.length > MAX_MATCHES
	) {
		return null;
	}
	if (
		identity.normalizedArtist !== normalizePersistentSpotifyKeyPart(value.artist) ||
		identity.normalizedTitle !== normalizePersistentSpotifyKeyPart(value.title) ||
		identity.primaryQuery !==
			`track:${identity.normalizedTitle} artist:${identity.normalizedArtist}` ||
		identity.fallbackQuery !== `track:${identity.normalizedTitle}`
	) {
		return null;
	}
	const matches = value.matches.map(parseMatch);
	if (matches.some((match) => match === null)) return null;
	const validatedMatches = matches as Match[];
	if (!value.fallback && validatedMatches.length === 0) return null;
	const confident =
		!value.fallback &&
		validatedMatches.length > 0 &&
		isConfidentSpotifyMatch({ artist: value.artist, title: value.title }, validatedMatches[0]);
	if (value.confident !== confident) return null;
	return {
		artist: value.artist,
		title: value.title,
		matches: validatedMatches,
		fallback: value.fallback,
		confident
	};
};

const parseIdentity = (value: unknown): SpotifyPersistentCacheIdentity | null => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'fallbackQuery',
			'market',
			'matcherVersion',
			'method',
			'normalizedArtist',
			'normalizedTitle',
			'primaryQuery'
		]) ||
		!Number.isSafeInteger(value.matcherVersion) ||
		(value.matcherVersion as number) < 0 ||
		!isBoundedString(value.market, 64) ||
		value.market !== normalizePersistentSpotifyKeyPart(value.market) ||
		value.method !== SEARCH_METHOD ||
		!isBoundedString(value.normalizedArtist) ||
		!isBoundedString(value.normalizedTitle) ||
		!isBoundedString(value.primaryQuery, MAX_TEXT_LENGTH * 2) ||
		!isBoundedString(value.fallbackQuery)
	) {
		return null;
	}
	return {
		matcherVersion: value.matcherVersion as number,
		market: value.market,
		method: SEARCH_METHOD,
		normalizedArtist: value.normalizedArtist,
		normalizedTitle: value.normalizedTitle,
		primaryQuery: value.primaryQuery,
		fallbackQuery: value.fallbackQuery
	};
};

const parsePersistentRecord = (
	value: unknown,
	ttlMs: number,
	now: number
): PersistentRecord | null => {
	if (!Number.isSafeInteger(now) || now < 0) return null;
	const maximumAcceptedTime = Math.min(
		Number.MAX_SAFE_INTEGER,
		now + SPOTIFY_PERSISTENT_CACHE_CLOCK_SKEW_MS
	);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'accessedAt',
			'createdAt',
			'eligible',
			'expiresAt',
			'identity',
			'key',
			'value'
		]) ||
		!isBoundedString(value.key, MAX_TEXT_LENGTH * 5) ||
		!Number.isSafeInteger(value.createdAt) ||
		!Number.isSafeInteger(value.accessedAt) ||
		!Number.isSafeInteger(value.expiresAt) ||
		(value.createdAt as number) < 0 ||
		(value.createdAt as number) > maximumAcceptedTime ||
		(value.accessedAt as number) < (value.createdAt as number) ||
		(value.accessedAt as number) > maximumAcceptedTime ||
		(value.accessedAt as number) > (value.expiresAt as number) ||
		!Number.isSafeInteger((value.createdAt as number) + ttlMs) ||
		value.expiresAt !== (value.createdAt as number) + ttlMs ||
		value.eligible !== true
	) {
		return null;
	}
	const identity = parseIdentity(value.identity);
	if (!identity || value.key !== createSpotifyPersistentCacheKey(identity)) return null;
	const matchedTrack = parseMatchedTrack(value.value, identity);
	if (!matchedTrack) return null;
	return {
		key: value.key,
		identity,
		createdAt: value.createdAt as number,
		accessedAt: value.accessedAt as number,
		expiresAt: value.expiresAt as number,
		eligible: true,
		value: matchedTrack
	};
};

const cloneMatchedTrack = (value: MatchedTrack): MatchedTrack => ({
	...value,
	matches: value.matches.map((match) => ({ ...match }))
});

const normalizedPath = (value: string) =>
	process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value);

type ProcessWriteCoordinator = { active: Set<string> };
const PROCESS_COORDINATOR_KEY = Symbol.for('nts-to-spotify.spotify-match-cache-writers.v1');
const coordinatorHost = globalThis as unknown as {
	[key: symbol]: ProcessWriteCoordinator | undefined;
};
const processWriteCoordinator = (coordinatorHost[PROCESS_COORDINATOR_KEY] ??= {
	active: new Set<string>()
});

const runWithProcessWriteLock = async <T>(
	key: string,
	task: () => Promise<T>
): Promise<T | null> => {
	for (let attempt = 0; attempt < CACHE_LOCK_MAX_ATTEMPTS; attempt += 1) {
		if (!processWriteCoordinator.active.has(key)) {
			processWriteCoordinator.active.add(key);
			try {
				return await task();
			} finally {
				processWriteCoordinator.active.delete(key);
			}
		}
		await abortableDelay(CACHE_LOCK_RETRY_MS * Math.min(attempt + 1, 4)).catch(() => undefined);
	}
	return null;
};

const isSameFile = (left: Stats, right: Stats) =>
	left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile();

export class FileSpotifyMatchCache implements SpotifyMatchCacheStorage {
	private readonly directory: string;
	private readonly cacheFile: string;
	private readonly lockDirectory: string;
	private readonly lockOwnerFile: string;
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxFileBytes: number;
	private readonly now: () => number;
	private readonly fileSystem: SpotifyMatchCacheFileSystem;
	private readonly records = new Map<string, PersistentRecord>();
	private readonly pendingUpserts = new Map<string, PersistentRecord>();
	private readonly pendingTouches = new Map<string, number>();
	private initializePromise: Promise<void> | null = null;
	private writePromise: Promise<void> | null = null;
	private touchTimer: ReturnType<typeof setTimeout> | null = null;
	private writeRequested = false;
	private available = true;

	constructor(options: FileSpotifyMatchCacheOptions) {
		this.directory = resolve(options.directory);
		this.cacheFile = resolve(this.directory, CACHE_FILE_NAME);
		this.lockDirectory = resolve(this.directory, CACHE_LOCK_DIRECTORY_NAME);
		this.lockOwnerFile = resolve(this.lockDirectory, CACHE_LOCK_OWNER_FILE_NAME);
		this.ttlMs = options.ttlMs ?? SPOTIFY_PERSISTENT_CACHE_TTL_MS;
		this.maxEntries = options.maxEntries ?? SPOTIFY_PERSISTENT_CACHE_MAX_ENTRIES;
		this.maxFileBytes = options.maxFileBytes ?? SPOTIFY_PERSISTENT_CACHE_MAX_FILE_BYTES;
		this.now = options.now ?? Date.now;
		this.fileSystem = options.fileSystem ?? nodeFileSystem;
		if (
			!Number.isSafeInteger(this.ttlMs) ||
			this.ttlMs <= 0 ||
			!Number.isSafeInteger(this.maxEntries) ||
			this.maxEntries <= 0 ||
			!Number.isSafeInteger(this.maxFileBytes) ||
			this.maxFileBytes <= 0
		) {
			this.available = false;
		}
	}

	private async safeLstat(path: string): Promise<Stats | null> {
		try {
			return await this.fileSystem.lstat(path);
		} catch (cause) {
			if (isMissingFileError(cause)) return null;
			throw cause;
		}
	}

	private async prepareDirectory() {
		const missing: string[] = [];
		let current = this.directory;
		for (;;) {
			const currentStats = await this.safeLstat(current);
			if (currentStats) {
				await this.assertDirectoryBoundary(current, currentStats);
				break;
			}
			missing.unshift(current);
			const parent = dirname(current);
			if (parent === current) throw new Error();
			current = parent;
		}

		for (const path of missing) {
			await this.assertDirectoryBoundary(dirname(path));
			try {
				await this.fileSystem.mkdir(path, { mode: 0o700 });
			} catch (cause) {
				if (!isAlreadyExistsError(cause)) throw cause;
			}
			await this.assertDirectoryBoundary(path);
		}
		await this.assertDirectoryBoundary(this.directory);
	}

	private async assertDirectoryBoundary(path = this.directory, knownStats?: Stats) {
		const directoryStats = knownStats ?? (await this.fileSystem.lstat(path));
		if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new Error();
		const canonicalDirectory = await this.fileSystem.realpath(path);
		if (normalizedPath(canonicalDirectory) !== normalizedPath(path)) throw new Error();
	}

	private async readBoundedCacheFile(): Promise<string | null> {
		await this.assertDirectoryBoundary();
		const pathStats = await this.safeLstat(this.cacheFile);
		if (!pathStats) return null;
		if (!pathStats.isFile() || pathStats.isSymbolicLink()) throw new Error();
		if (pathStats.size > this.maxFileBytes) return null;

		const noFollow = typeof fileConstants.O_NOFOLLOW === 'number' ? fileConstants.O_NOFOLLOW : 0;
		const handle = await this.fileSystem.open(this.cacheFile, fileConstants.O_RDONLY | noFollow);
		try {
			const openedStats = await handle.stat();
			const confirmedPathStats = await this.fileSystem.lstat(this.cacheFile);
			if (
				!openedStats.isFile() ||
				!confirmedPathStats.isFile() ||
				confirmedPathStats.isSymbolicLink() ||
				!isSameFile(openedStats, pathStats) ||
				!isSameFile(openedStats, confirmedPathStats) ||
				openedStats.size > this.maxFileBytes
			) {
				throw new Error();
			}
			const buffer = Buffer.alloc(openedStats.size);
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const trailingByte = Buffer.alloc(1);
			const { bytesRead: trailingBytesRead } = await handle.read(trailingByte, 0, 1, null);
			if (trailingBytesRead > 0 || offset > this.maxFileBytes) return null;
			await this.assertDirectoryBoundary();
			return buffer.toString('utf8', 0, offset);
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	private parseCacheFile(serialized: string | null): Map<string, PersistentRecord> {
		const parsedRecords = new Map<string, PersistentRecord>();
		if (serialized === null) return parsedRecords;
		let parsed: unknown;
		try {
			parsed = JSON.parse(serialized);
		} catch {
			return parsedRecords;
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, ['records', 'schemaVersion']) ||
			parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
			!Array.isArray(parsed.records) ||
			parsed.records.length > this.maxEntries
		) {
			return parsedRecords;
		}
		const now = this.now();
		const loaded = parsed.records.map((record) => parsePersistentRecord(record, this.ttlMs, now));
		if (loaded.some((record) => record === null)) return new Map();
		for (const record of loaded as PersistentRecord[]) {
			if (parsedRecords.has(record.key)) return new Map();
			if (record.expiresAt > now) parsedRecords.set(record.key, record);
		}
		return parsedRecords;
	}

	private async loadLatestRecords() {
		return this.parseCacheFile(await this.readBoundedCacheFile());
	}

	private async initialize() {
		if (!this.available) return;
		try {
			await this.prepareDirectory();
			const loaded = await this.loadLatestRecords();
			for (const [key, record] of loaded) this.records.set(key, record);
		} catch {
			this.available = false;
			this.records.clear();
		}
	}

	private ensureInitialized() {
		this.initializePromise ??= this.initialize();
		return this.initializePromise;
	}

	private evictionOrder(records: Map<string, PersistentRecord>) {
		return [...records.values()].sort(
			(left, right) =>
				left.accessedAt - right.accessedAt ||
				left.createdAt - right.createdAt ||
				left.key.localeCompare(right.key, 'en-US')
		);
	}

	private pruneExpired(records = this.records) {
		const now = this.now();
		let changed = false;
		for (const [key, record] of records) {
			if (record.expiresAt <= now) {
				records.delete(key);
				changed = true;
			}
		}
		return changed;
	}

	private serialize(records: Map<string, PersistentRecord>) {
		const file: PersistentFile = {
			schemaVersion: CACHE_SCHEMA_VERSION,
			records: [...records.values()].sort((left, right) =>
				left.key.localeCompare(right.key, 'en-US')
			)
		};
		return JSON.stringify(file);
	}

	private enforceBounds(records: Map<string, PersistentRecord>) {
		this.pruneExpired(records);
		while (records.size > this.maxEntries) {
			const oldest = this.evictionOrder(records)[0];
			if (!oldest) break;
			records.delete(oldest.key);
		}
		let serialized = this.serialize(records);
		while (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes && records.size > 0) {
			const oldest = this.evictionOrder(records)[0];
			if (!oldest) break;
			records.delete(oldest.key);
			serialized = this.serialize(records);
		}
		return serialized;
	}

	private async removeOwnedFile(path: string) {
		const pathStats = await this.safeLstat(path);
		if (pathStats?.isFile() && !pathStats.isSymbolicLink()) {
			await this.fileSystem.unlink(path).catch(() => undefined);
		}
	}

	private async cleanupStaleTemporaryFiles() {
		const entries = (await this.fileSystem.readdir(this.directory, {
			withFileTypes: true
		})) as Dirent[];
		const now = this.now();
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink() || !CACHE_TEMP_FILE_PATTERN.test(entry.name)) {
				continue;
			}
			const path = resolve(this.directory, entry.name);
			const pathStats = await this.safeLstat(path);
			if (
				pathStats?.isFile() &&
				!pathStats.isSymbolicLink() &&
				now - pathStats.mtimeMs >= CACHE_ARTIFACT_STALE_MS
			) {
				await this.fileSystem.unlink(path).catch(() => undefined);
			}
		}
	}

	private async removeStaleLock() {
		const lockStats = await this.safeLstat(this.lockDirectory);
		if (!lockStats) return true;
		if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) throw new Error();
		if (this.now() - lockStats.mtimeMs < CACHE_ARTIFACT_STALE_MS) return false;
		const entries = await this.fileSystem.readdir(this.lockDirectory);
		if (entries.length === 0) {
			await this.fileSystem.rmdir(this.lockDirectory).catch(() => undefined);
			return (await this.safeLstat(this.lockDirectory)) === null;
		}
		if (entries.length !== 1 || entries[0] !== CACHE_LOCK_OWNER_FILE_NAME) return false;
		const ownerStats = await this.safeLstat(this.lockOwnerFile);
		if (
			!ownerStats?.isFile() ||
			ownerStats.isSymbolicLink() ||
			this.now() - ownerStats.mtimeMs < CACHE_ARTIFACT_STALE_MS
		) {
			return false;
		}
		await this.fileSystem.unlink(this.lockOwnerFile).catch(() => undefined);
		await this.fileSystem.rmdir(this.lockDirectory).catch(() => undefined);
		return (await this.safeLstat(this.lockDirectory)) === null;
	}

	private async acquireWriteLock(signal?: AbortSignal): Promise<string | null> {
		for (let attempt = 0; attempt < CACHE_LOCK_MAX_ATTEMPTS; attempt += 1) {
			if (signal?.aborted) return null;
			await this.assertDirectoryBoundary();
			try {
				await this.fileSystem.mkdir(this.lockDirectory, { mode: 0o700 });
				await this.assertDirectoryBoundary(this.lockDirectory);
				const token = `${process.pid}-${randomUUID()}`;
				try {
					await this.fileSystem.writeFile(
						this.lockOwnerFile,
						JSON.stringify({ token, createdAt: this.now() }),
						{ encoding: 'utf8', flag: 'wx', mode: 0o600 }
					);
					return token;
				} catch {
					await this.fileSystem.rmdir(this.lockDirectory).catch(() => undefined);
					return null;
				}
			} catch (cause) {
				if (!isAlreadyExistsError(cause)) return null;
				if (await this.removeStaleLock()) continue;
			}
			await abortableDelay(CACHE_LOCK_RETRY_MS * Math.min(attempt + 1, 4), signal).catch(
				() => undefined
			);
		}
		return null;
	}

	private async releaseWriteLock(token: string) {
		try {
			const lockStats = await this.safeLstat(this.lockDirectory);
			const ownerStats = await this.safeLstat(this.lockOwnerFile);
			if (
				!lockStats?.isDirectory() ||
				lockStats.isSymbolicLink() ||
				!ownerStats?.isFile() ||
				ownerStats.isSymbolicLink()
			) {
				return;
			}
			const owner = JSON.parse(
				await this.fileSystem.readFile(this.lockOwnerFile, 'utf8')
			) as unknown;
			if (!isRecord(owner) || owner.token !== token) return;
			await this.fileSystem.unlink(this.lockOwnerFile);
			await this.fileSystem.rmdir(this.lockDirectory);
		} catch {
			// A later writer can conservatively recover an abandoned lock after the stale threshold.
		}
	}

	private async writeSnapshot(serialized: string, token: string) {
		const temporaryFile = resolve(
			this.directory,
			`${CACHE_TEMP_FILE_PREFIX}${token}-${randomUUID()}`
		);
		try {
			if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) throw new Error();
			await this.assertDirectoryBoundary();
			const cacheStats = await this.safeLstat(this.cacheFile);
			if (cacheStats?.isSymbolicLink() || (cacheStats && !cacheStats.isFile())) throw new Error();
			await this.fileSystem.writeFile(temporaryFile, serialized, {
				encoding: 'utf8',
				flag: 'wx',
				mode: 0o600
			});
			await this.assertDirectoryBoundary();
			const temporaryStats = await this.fileSystem.lstat(temporaryFile);
			if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink()) throw new Error();
			const confirmedCacheStats = await this.safeLstat(this.cacheFile);
			if (
				confirmedCacheStats?.isSymbolicLink() ||
				(confirmedCacheStats && !confirmedCacheStats.isFile())
			) {
				throw new Error();
			}
			await this.fileSystem.rename(temporaryFile, this.cacheFile);
		} catch (cause) {
			await this.removeOwnedFile(temporaryFile);
			throw cause;
		}
	}

	private applyChanges(
		target: Map<string, PersistentRecord>,
		upserts: Map<string, PersistentRecord>,
		touches: Map<string, number>
	) {
		for (const [key, pending] of upserts) {
			const existing = target.get(key);
			const createdAt = existing?.createdAt ?? pending.createdAt;
			const expiresAt = createdAt + this.ttlMs;
			if (!Number.isSafeInteger(expiresAt)) continue;
			target.set(key, {
				...pending,
				createdAt,
				accessedAt: Math.max(existing?.accessedAt ?? createdAt, pending.accessedAt),
				expiresAt
			});
		}
		for (const [key, touchedAt] of touches) {
			const record = target.get(key);
			if (record && touchedAt >= record.createdAt && touchedAt <= record.expiresAt) {
				record.accessedAt = Math.max(record.accessedAt, touchedAt);
			}
		}
	}

	private async writePendingChanges() {
		if (this.pendingUpserts.size === 0 && this.pendingTouches.size === 0) return true;
		return runWithProcessWriteLock(normalizedPath(this.directory), async () => {
			const token = await this.acquireWriteLock();
			if (!token) return false;
			try {
				await this.cleanupStaleTemporaryFiles();
				const upserts = new Map(this.pendingUpserts);
				const touches = new Map(this.pendingTouches);
				const latest = await this.loadLatestRecords();
				this.applyChanges(latest, upserts, touches);
				const serialized = this.enforceBounds(latest);
				await this.writeSnapshot(serialized, token);

				for (const [key, record] of upserts) {
					if (this.pendingUpserts.get(key) === record) this.pendingUpserts.delete(key);
				}
				for (const [key, touchedAt] of touches) {
					if (this.pendingTouches.get(key) === touchedAt) this.pendingTouches.delete(key);
				}
				this.records.clear();
				for (const [key, record] of latest) this.records.set(key, record);
				this.applyChanges(this.records, this.pendingUpserts, this.pendingTouches);
				return true;
			} catch {
				return false;
			} finally {
				await this.releaseWriteLock(token);
			}
		});
	}

	private requestWrite() {
		this.writeRequested = true;
		if (!this.available) return Promise.resolve();
		this.writePromise ??= Promise.resolve()
			.then(async () => {
				while (this.writeRequested && this.available) {
					this.writeRequested = false;
					if (!(await this.writePendingChanges())) break;
				}
			})
			.catch(() => undefined)
			.finally(() => {
				this.writePromise = null;
			});
		return this.writePromise;
	}

	private scheduleTouchWrite() {
		if (this.touchTimer || !this.available) return;
		this.touchTimer = setTimeout(() => {
			this.touchTimer = null;
			void this.requestWrite().catch(() => undefined);
		}, SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS);
	}

	async get(identity: SpotifyPersistentCacheIdentity): Promise<MatchedTrack | null> {
		await this.ensureInitialized();
		if (!this.available) return null;
		this.pruneExpired();
		const key = createSpotifyPersistentCacheKey(identity);
		const record = this.records.get(key);
		if (!record) return null;
		const parsed = parseMatchedTrack(record.value, identity);
		if (!parsed) {
			this.records.delete(key);
			return null;
		}
		const touchedAt = Math.max(record.createdAt, this.now());
		if (!Number.isSafeInteger(touchedAt) || touchedAt > record.expiresAt) return null;
		record.accessedAt = Math.max(record.accessedAt, touchedAt);
		this.pendingTouches.set(key, record.accessedAt);
		this.scheduleTouchWrite();
		return cloneMatchedTrack(parsed);
	}

	async set(identity: SpotifyPersistentCacheIdentity, value: MatchedTrack): Promise<void> {
		await this.ensureInitialized();
		if (!this.available) return;
		const parsedIdentity = parseIdentity(identity);
		const parsedValue = parsedIdentity ? parseMatchedTrack(value, parsedIdentity) : null;
		if (!parsedIdentity || !parsedValue) return;
		const key = createSpotifyPersistentCacheKey(parsedIdentity);
		const timestamp = this.now();
		const expiresAt = timestamp + this.ttlMs;
		if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(expiresAt)) {
			return;
		}
		this.pruneExpired();
		const existing = this.records.get(key);
		const pending: PersistentRecord = {
			key,
			identity: parsedIdentity,
			createdAt: existing?.createdAt ?? timestamp,
			accessedAt: Math.max(existing?.accessedAt ?? timestamp, timestamp),
			expiresAt: existing?.expiresAt ?? expiresAt,
			eligible: true,
			value: cloneMatchedTrack(parsedValue)
		};
		this.records.set(key, pending);
		this.pendingUpserts.set(key, pending);
		this.pendingTouches.delete(key);
		if (this.touchTimer) {
			clearTimeout(this.touchTimer);
			this.touchTimer = null;
		}
		await this.requestWrite();
	}

	async flush(): Promise<void> {
		await this.ensureInitialized();
		if (this.touchTimer) {
			clearTimeout(this.touchTimer);
			this.touchTimer = null;
		}
		if (this.writePromise) await this.writePromise;
		if (this.pendingUpserts.size > 0 || this.pendingTouches.size > 0) {
			await this.requestWrite();
		}
	}
}

const isMissingFileError = (cause: unknown) =>
	isRecord(cause) && 'code' in cause && cause.code === 'ENOENT';

const isAlreadyExistsError = (cause: unknown) =>
	isRecord(cause) && 'code' in cause && cause.code === 'EEXIST';

export const createDefaultSpotifyMatchCache = () =>
	new FileSpotifyMatchCache({ directory: resolve('.data', 'spotify-match-cache') });
