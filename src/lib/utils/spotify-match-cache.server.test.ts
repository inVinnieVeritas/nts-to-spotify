import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchedTrack } from '$lib/types';
import {
	lstat,
	mkdtemp,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	unlink,
	utimes,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createSpotifyPersistentCacheIdentity,
	createSpotifyPersistentCacheKey,
	FileSpotifyMatchCache,
	SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS,
	type SpotifyMatchCacheFileSystem
} from './spotify-match-cache.server';

const TRACK_ID = '0123456789ABCDEFGHIJKL';
const CACHE_FILE = 'spotify-match-cache.json';
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nts-spotify-match-cache-'));
	temporaryDirectories.push(directory);
	return directory;
};

const matchedTrack = (title = 'Track', fallback = false): MatchedTrack => ({
	artist: 'Artist',
	title,
	matches: [
		{
			artist: 'Artist',
			title,
			uri: `spotify:track:${TRACK_ID}`,
			href: `https://open.spotify.com/track/${TRACK_ID}`
		}
	],
	confident: !fallback,
	fallback
});

const emptyTrack = (): MatchedTrack => ({
	artist: 'Artist',
	title: 'Missing',
	matches: [],
	confident: false,
	fallback: true
});

const identityFor = (value: MatchedTrack, matcherVersion = 1, market = '') =>
	createSpotifyPersistentCacheIdentity(value, matcherVersion, market);

const realFileSystem: SpotifyMatchCacheFileSystem = {
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

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
			)
	);
});

describe('filesystem Spotify match cache', () => {
	it('survives a fresh cache instance and clones matched and legitimate empty results', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const matched = matchedTrack();
		const empty = emptyTrack();
		const writer = new FileSpotifyMatchCache({ directory });
		await writer.set(identityFor(matched), matched);
		await writer.set(identityFor(empty), empty);
		await writer.flush();

		matched.matches[0].title = 'Mutated source';
		const reader = new FileSpotifyMatchCache({ directory });
		const loaded = await reader.get(identityFor(matchedTrack()));
		expect(loaded?.matches[0].title).toBe('Track');
		expect(await reader.get(identityFor(empty))).toEqual(empty);
		if (loaded) loaded.matches[0].title = 'Mutated consumer';
		expect((await reader.get(identityFor(matchedTrack())))?.matches[0].title).toBe('Track');
	});

	it('separates matcher version, market, and labelled primary/fallback queries', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const value = matchedTrack();
		const storedIdentity = identityFor(value, 1, 'BE');
		const cache = new FileSpotifyMatchCache({ directory });
		await cache.set(storedIdentity, value);
		expect(storedIdentity).toMatchObject({
			method: 'track-primary-then-title-v1',
			primaryQuery: 'track:track artist:artist',
			fallbackQuery: 'track:track'
		});
		expect(storedIdentity.primaryQuery).not.toBe(storedIdentity.fallbackQuery);
		expect(
			createSpotifyPersistentCacheKey(
				createSpotifyPersistentCacheIdentity(
					{ artist: '\u212bRTIST', title: '\uff34rack' },
					1,
					'BE'
				)
			)
		).toBe(
			createSpotifyPersistentCacheKey(
				createSpotifyPersistentCacheIdentity({ artist: '\u00c5rtist', title: 'Track' }, 1, 'be')
			)
		);

		expect(await cache.get(identityFor(value, 2, 'BE'))).toBeNull();
		expect(await cache.get(identityFor(value, 1, 'US'))).toBeNull();
		expect(
			await cache.get({ ...storedIdentity, primaryQuery: `${storedIdentity.primaryQuery} remix` })
		).toBeNull();
		expect(
			await cache.get({ ...storedIdentity, fallbackQuery: `${storedIdentity.fallbackQuery} remix` })
		).toBeNull();
		expect(await cache.get(storedIdentity)).toEqual(value);
	});

	it('expires records at the TTL and evicts least-recently-accessed records deterministically', async () => {
		let now = 1_000;
		const directory = join(await createTemporaryDirectory(), 'cache');
		const cache = new FileSpotifyMatchCache({
			directory,
			ttlMs: 100,
			maxEntries: 2,
			now: () => now
		});
		const first = matchedTrack('First');
		const second = matchedTrack('Second');
		const third = matchedTrack('Third');
		await cache.set(identityFor(first), first);
		now += 1;
		await cache.set(identityFor(second), second);
		now += 1;
		await cache.get(identityFor(first));
		now += 1;
		await cache.set(identityFor(third), third);

		expect(await cache.get(identityFor(first))).toEqual(first);
		expect(await cache.get(identityFor(second))).toBeNull();
		expect(await cache.get(identityFor(third))).toEqual(third);
		now = 1_101;
		expect(await cache.get(identityFor(first))).toBeNull();
	});

	it('enforces the maximum serialized size without writing an oversized file', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const cache = new FileSpotifyMatchCache({ directory, maxFileBytes: 128 });
		const value = matchedTrack();
		await cache.set(identityFor(value), value);
		await cache.flush();

		const serialized = await readFile(join(directory, CACHE_FILE), 'utf8');
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(128);
		expect(await cache.get(identityFor(value))).toBeNull();
	});

	it('coalesces concurrent writes and atomically renames cache-owned temporary files', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const writeCalls: string[] = [];
		const renameCalls: Array<[string, string]> = [];
		const fileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			writeFile: vi.fn(async (...args: Parameters<typeof writeFile>) => {
				writeCalls.push(String(args[0]));
				return writeFile(...args);
			}) as typeof writeFile,
			rename: vi.fn(async (...args: Parameters<typeof rename>) => {
				const [from, to] = args;
				renameCalls.push([String(from), String(to)]);
				return rename(from, to);
			}) as typeof rename
		};
		const cache = new FileSpotifyMatchCache({ directory, fileSystem });
		const values = ['One', 'Two', 'Three'].map((title) => matchedTrack(title));
		await Promise.all(values.map((value) => cache.set(identityFor(value), value)));
		await cache.flush();

		const temporaryWriteCalls = writeCalls.filter((path) => path.includes(`${CACHE_FILE}.tmp-`));
		expect(temporaryWriteCalls.length).toBeGreaterThan(0);
		expect(renameCalls).toHaveLength(temporaryWriteCalls.length);
		for (let index = 0; index < temporaryWriteCalls.length; index += 1) {
			expect(renameCalls[index]).toEqual([temporaryWriteCalls[index], join(directory, CACHE_FILE)]);
		}
		expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([]);
		const reader = new FileSpotifyMatchCache({ directory });
		for (const value of values) expect(await reader.get(identityFor(value))).toEqual(value);
	});

	it('merges concurrent updates from independent cache instances', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const firstCache = new FileSpotifyMatchCache({ directory });
		const secondCache = new FileSpotifyMatchCache({ directory });
		await Promise.all([firstCache.flush(), secondCache.flush()]);
		const first = matchedTrack('Independent one');
		const second = matchedTrack('Independent two');

		await Promise.all([
			firstCache.set(identityFor(first), first),
			secondCache.set(identityFor(second), second)
		]);
		const reader = new FileSpotifyMatchCache({ directory });
		expect(await reader.get(identityFor(first))).toEqual(first);
		expect(await reader.get(identityFor(second))).toEqual(second);
	});

	it('preserves deterministic entry bounds after merging independent writers', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const options = { directory, maxEntries: 2, now: () => 1_000 };
		const caches = [
			new FileSpotifyMatchCache(options),
			new FileSpotifyMatchCache(options),
			new FileSpotifyMatchCache(options)
		];
		await Promise.all(caches.map((cache) => cache.flush()));
		const values = ['Bound A', 'Bound B', 'Bound C'].map((title) => matchedTrack(title));
		await Promise.all(values.map((value, index) => caches[index].set(identityFor(value), value)));

		const reader = new FileSpotifyMatchCache(options);
		const retained = await Promise.all(values.map((value) => reader.get(identityFor(value))));
		const expectedEvictedKey = values
			.map((value) => createSpotifyPersistentCacheKey(identityFor(value)))
			.sort((left, right) => left.localeCompare(right, 'en-US'))[0];
		for (let index = 0; index < values.length; index += 1) {
			const identity = identityFor(values[index]);
			const key = createSpotifyPersistentCacheKey(identity);
			expect(retained[index] === null).toBe(key === expectedEvictedKey);
		}
	});

	it('does not clean an active writer temporary file when another instance initializes', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		let releaseWrite: (() => void) | undefined;
		let announceTemporaryFile: ((path: string) => void) | undefined;
		const temporaryFileReady = new Promise<string>((resolve) => {
			announceTemporaryFile = resolve;
		});
		const pause = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const pausedFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			writeFile: vi.fn(async (...args: Parameters<typeof writeFile>) => {
				const result = await writeFile(...args);
				if (String(args[0]).includes(`${CACHE_FILE}.tmp-`)) {
					announceTemporaryFile?.(String(args[0]));
					await pause;
				}
				return result;
			}) as typeof writeFile
		};
		const first = matchedTrack('Paused writer');
		const second = matchedTrack('Waiting writer');
		const firstCache = new FileSpotifyMatchCache({ directory, fileSystem: pausedFileSystem });
		const firstWrite = firstCache.set(identityFor(first), first);
		const activeTemporaryFile = await temporaryFileReady;
		const secondCache = new FileSpotifyMatchCache({ directory });
		await secondCache.flush();
		expect((await lstat(activeTemporaryFile)).isFile()).toBe(true);
		const secondWrite = secondCache.set(identityFor(second), second);
		releaseWrite?.();
		await Promise.all([firstWrite, secondWrite]);

		const reader = new FileSpotifyMatchCache({ directory });
		expect(await reader.get(identityFor(first))).toEqual(first);
		expect(await reader.get(identityFor(second))).toEqual(second);
	});

	it('retains dirty updates after a failed write and recovers on a later flush', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		let failRename = true;
		const recoveringFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			rename: vi.fn(async (...args: Parameters<typeof rename>) => {
				if (failRename) {
					failRename = false;
					throw Object.assign(new Error('private transient write failure'), { code: 'EIO' });
				}
				return rename(...args);
			}) as typeof rename
		};
		const cache = new FileSpotifyMatchCache({ directory, fileSystem: recoveringFileSystem });
		const value = matchedTrack('Recovered');
		await cache.set(identityFor(value), value);
		expect(await new FileSpotifyMatchCache({ directory }).get(identityFor(value))).toBeNull();
		await cache.flush();
		expect(await new FileSpotifyMatchCache({ directory }).get(identityFor(value))).toEqual(value);
	});

	it('batches access touches, flushes final LRU order, and persists new results promptly', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const first = matchedTrack('Touch first');
		const second = matchedTrack('Touch second');
		const writer = new FileSpotifyMatchCache({ directory, maxEntries: 2 });
		await Promise.all([
			writer.set(identityFor(first), first),
			writer.set(identityFor(second), second)
		]);
		const renameCalls: string[] = [];
		const observingFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			rename: vi.fn(async (...args: Parameters<typeof rename>) => {
				renameCalls.push(String(args[1]));
				return rename(...args);
			}) as typeof rename
		};
		const cache = new FileSpotifyMatchCache({
			directory,
			maxEntries: 2,
			fileSystem: observingFileSystem
		});
		await cache.flush();
		for (let index = 0; index < 30; index += 1) await cache.get(identityFor(first));
		await new Promise((resolve) =>
			setTimeout(resolve, Math.ceil(SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS / 2))
		);
		for (let index = 0; index < 30; index += 1) await cache.get(identityFor(first));
		await cache.flush();
		expect(renameCalls).toHaveLength(1);

		for (let batch = 0; batch < 3; batch += 1) {
			for (let index = 0; index < 10; index += 1) await cache.get(identityFor(first));
			await new Promise((resolve) =>
				setTimeout(resolve, SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS + 20)
			);
		}
		await cache.flush();
		expect(renameCalls.length).toBeLessThanOrEqual(4);

		const third = matchedTrack('Prompt new result');
		await cache.get(identityFor(first));
		await cache.set(identityFor(third), third);
		const reader = new FileSpotifyMatchCache({ directory, maxEntries: 2 });
		expect(await reader.get(identityFor(first))).toEqual(first);
		expect(await reader.get(identityFor(second))).toBeNull();
		expect(await reader.get(identityFor(third))).toEqual(third);
	});

	it('contains debounced touch-write failures without an unhandled rejection', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const value = matchedTrack('Contained touch failure');
		await new FileSpotifyMatchCache({ directory }).set(identityFor(value), value);
		const failingFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			rename: vi.fn(async () => {
				throw Object.assign(new Error('private background write failure'), { code: 'EIO' });
			}) as typeof rename
		};
		const cache = new FileSpotifyMatchCache({ directory, fileSystem: failingFileSystem });
		const unhandled: unknown[] = [];
		const onUnhandled = (cause: unknown) => unhandled.push(cause);
		process.on('unhandledRejection', onUnhandled);
		try {
			expect(await cache.get(identityFor(value))).toEqual(value);
			await new Promise((resolve) =>
				setTimeout(resolve, SPOTIFY_PERSISTENT_CACHE_TOUCH_DEBOUNCE_MS + 20)
			);
			await cache.flush();
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('fails closed for malformed JSON, structurally invalid records, and invalid candidates', async () => {
		const cases: Array<(parsed: Record<string, unknown>) => void> = [
			(parsed) => {
				(parsed.records as Array<Record<string, unknown>>)[0].eligible = false;
			},
			(parsed) => {
				const record = (parsed.records as Array<Record<string, unknown>>)[0];
				const value = record.value as Record<string, unknown>;
				(value.matches as Array<Record<string, unknown>>)[0].uri = 'spotify:track:not-valid';
			},
			(parsed) => {
				const record = (parsed.records as Array<Record<string, unknown>>)[0];
				const value = record.value as Record<string, unknown>;
				(value.matches as Array<Record<string, unknown>>)[0].href = 'https://example.test/private';
			},
			(parsed) => {
				const record = (parsed.records as Array<Record<string, unknown>>)[0];
				(record.value as Record<string, unknown>).confident = false;
			}
		];

		for (const corrupt of cases) {
			const root = await createTemporaryDirectory();
			const directory = join(root, 'cache');
			const value = matchedTrack();
			const writer = new FileSpotifyMatchCache({ directory });
			await writer.set(identityFor(value), value);
			const file = join(directory, CACHE_FILE);
			const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
			corrupt(parsed);
			await writeFile(file, JSON.stringify(parsed));
			expect(await new FileSpotifyMatchCache({ directory }).get(identityFor(value))).toBeNull();
		}

		const malformedDirectory = join(await createTemporaryDirectory(), 'cache');
		await mkdir(malformedDirectory);
		await writeFile(join(malformedDirectory, CACHE_FILE), '{truncated');
		expect(
			await new FileSpotifyMatchCache({ directory: malformedDirectory }).get(
				identityFor(matchedTrack())
			)
		).toBeNull();
	});

	it('rejects attacker-edited future and inconsistent timestamps but tolerates modest rollback', async () => {
		const futureDirectory = join(await createTemporaryDirectory(), 'future-cache');
		const value = matchedTrack('Future timestamp');
		const writer = new FileSpotifyMatchCache({ directory: futureDirectory });
		await writer.set(identityFor(value), value);
		const file = join(futureDirectory, CACHE_FILE);
		const parsed = JSON.parse(await readFile(file, 'utf8')) as {
			records: Array<Record<string, unknown>>;
		};
		parsed.records[0].accessedAt = Number.MAX_SAFE_INTEGER;
		await writeFile(file, JSON.stringify(parsed));
		expect(
			await new FileSpotifyMatchCache({ directory: futureDirectory }).get(identityFor(value))
		).toBeNull();

		const inconsistentDirectory = join(await createTemporaryDirectory(), 'inconsistent-cache');
		const inconsistentWriter = new FileSpotifyMatchCache({ directory: inconsistentDirectory });
		await inconsistentWriter.set(identityFor(value), value);
		const inconsistentFile = join(inconsistentDirectory, CACHE_FILE);
		const inconsistent = JSON.parse(await readFile(inconsistentFile, 'utf8')) as {
			records: Array<Record<string, unknown>>;
		};
		inconsistent.records[0].expiresAt = Number.MAX_SAFE_INTEGER;
		await writeFile(inconsistentFile, JSON.stringify(inconsistent));
		expect(
			await new FileSpotifyMatchCache({ directory: inconsistentDirectory }).get(identityFor(value))
		).toBeNull();

		const rollbackDirectory = join(await createTemporaryDirectory(), 'rollback-cache');
		const rollbackValue = matchedTrack('Clock rollback');
		const rollbackWriter = new FileSpotifyMatchCache({
			directory: rollbackDirectory,
			now: () => 10_000
		});
		await rollbackWriter.set(identityFor(rollbackValue), rollbackValue);
		const rollbackReader = new FileSpotifyMatchCache({
			directory: rollbackDirectory,
			now: () => 9_000
		});
		expect(await rollbackReader.get(identityFor(rollbackValue))).toEqual(rollbackValue);
		await rollbackReader.flush();
		expect(
			await new FileSpotifyMatchCache({
				directory: rollbackDirectory,
				now: () => 9_000
			}).get(identityFor(rollbackValue))
		).toEqual(rollbackValue);
	});

	it('cleans only regular stale cache temporary files and ignores truncated temporary content', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		await mkdir(directory);
		const staleTemporaryFile = join(directory, `${CACHE_FILE}.tmp-stale`);
		const unrelatedFile = join(directory, 'unrelated.tmp-stale');
		await writeFile(staleTemporaryFile, '{truncated');
		await writeFile(unrelatedFile, 'keep');
		const staleTime = new Date(Date.now() - 15 * 60 * 1000);
		await utimes(staleTemporaryFile, staleTime, staleTime);

		const cache = new FileSpotifyMatchCache({ directory });
		await cache.set(identityFor(matchedTrack()), matchedTrack());
		await expect(lstat(staleTemporaryFile)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(unrelatedFile, 'utf8')).toBe('keep');
	});

	it('falls back without rejection when storage is unavailable or read-only', async () => {
		const root = await createTemporaryDirectory();
		const unavailablePath = join(root, 'not-a-directory');
		await writeFile(unavailablePath, 'occupied');
		const unavailable = new FileSpotifyMatchCache({ directory: unavailablePath });
		await expect(unavailable.get(identityFor(matchedTrack()))).resolves.toBeNull();
		await expect(
			unavailable.set(identityFor(matchedTrack()), matchedTrack())
		).resolves.toBeUndefined();

		const readOnlyFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			writeFile: vi.fn(async () => {
				throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' });
			}) as typeof writeFile
		};
		const readOnly = new FileSpotifyMatchCache({
			directory: join(root, 'read-only'),
			fileSystem: readOnlyFileSystem
		});
		await expect(
			readOnly.set(identityFor(matchedTrack()), matchedTrack())
		).resolves.toBeUndefined();
		await expect(readOnly.flush()).resolves.toBeUndefined();
		expect(await readOnly.get(identityFor(matchedTrack()))).toEqual(matchedTrack());
		expect(
			await new FileSpotifyMatchCache({ directory: join(root, 'read-only') }).get(
				identityFor(matchedTrack())
			)
		).toBeNull();
	});

	it('refuses a cache directory symlink instead of following it outside the intended path', async () => {
		const root = await createTemporaryDirectory();
		const outside = join(root, 'outside');
		const cacheDirectory = join(root, 'cache-link');
		await mkdir(outside);
		await symlink(outside, cacheDirectory, process.platform === 'win32' ? 'junction' : 'dir');
		const cache = new FileSpotifyMatchCache({ directory: cacheDirectory });

		await expect(cache.set(identityFor(matchedTrack()), matchedTrack())).resolves.toBeUndefined();
		expect(await cache.get(identityFor(matchedTrack()))).toBeNull();
		expect(await readdir(outside)).toEqual([]);
	});

	it('rejects an existing parent link before creating any external cache directory', async () => {
		const root = await createTemporaryDirectory();
		const outside = join(root, 'outside-parent');
		const linkedParent = join(root, 'linked-data');
		await mkdir(outside);
		await symlink(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
		const cache = new FileSpotifyMatchCache({ directory: join(linkedParent, 'cache') });

		await expect(cache.set(identityFor(matchedTrack()), matchedTrack())).resolves.toBeUndefined();
		expect(await cache.get(identityFor(matchedTrack()))).toBeNull();
		expect(await readdir(outside)).toEqual([]);
	});

	it('rejects a cache-file symlink without reading or replacing its external target', async () => {
		const root = await createTemporaryDirectory();
		const directory = join(root, 'cache');
		const externalFile = join(root, 'external-cache.json');
		await mkdir(directory);
		await writeFile(externalFile, 'external sentinel');
		const cacheFile = join(directory, CACHE_FILE);
		let fileSystem = realFileSystem;
		try {
			await symlink(externalFile, cacheFile, 'file');
		} catch (cause) {
			if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EPERM')) {
				throw cause;
			}
			await writeFile(cacheFile, 'simulated link path');
			fileSystem = {
				...realFileSystem,
				lstat: vi.fn(async (...args: Parameters<typeof lstat>) => {
					const stats = await lstat(...args);
					if (String(args[0]) === cacheFile) stats.isSymbolicLink = () => true;
					return stats;
				}) as typeof lstat
			};
		}
		const cache = new FileSpotifyMatchCache({ directory, fileSystem });

		expect(await cache.get(identityFor(matchedTrack()))).toBeNull();
		await cache.set(identityFor(matchedTrack()), matchedTrack());
		expect(await readFile(externalFile, 'utf8')).toBe('external sentinel');
	});

	it('rejects oversized and replaced cache files before parsing or reuse', async () => {
		const root = await createTemporaryDirectory();
		const oversizedDirectory = join(root, 'oversized');
		await mkdir(oversizedDirectory);
		await writeFile(join(oversizedDirectory, CACHE_FILE), 'x'.repeat(129));
		expect(
			await new FileSpotifyMatchCache({
				directory: oversizedDirectory,
				maxFileBytes: 128
			}).get(identityFor(matchedTrack()))
		).toBeNull();

		const replacedDirectory = join(root, 'replaced');
		const value = matchedTrack('Original inode');
		const writer = new FileSpotifyMatchCache({ directory: replacedDirectory });
		await writer.set(identityFor(value), value);
		const replacement = join(root, 'replacement.json');
		await writeFile(replacement, await readFile(join(replacedDirectory, CACHE_FILE)));
		let replaceBeforeOpen = true;
		const replacingFileSystem: SpotifyMatchCacheFileSystem = {
			...realFileSystem,
			open: vi.fn(async (...args: Parameters<typeof open>) => {
				if (replaceBeforeOpen && String(args[0]) === join(replacedDirectory, CACHE_FILE)) {
					replaceBeforeOpen = false;
					await unlink(join(replacedDirectory, CACHE_FILE));
					await rename(replacement, join(replacedDirectory, CACHE_FILE));
				}
				return open(...args);
			}) as typeof open
		};
		const replaced = new FileSpotifyMatchCache({
			directory: replacedDirectory,
			fileSystem: replacingFileSystem
		});
		expect(await replaced.get(identityFor(value))).toBeNull();
	});

	it('recovers only stale cache-owned locks', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const lockDirectory = join(directory, 'spotify-match-cache.lock');
		const ownerFile = join(lockDirectory, 'owner.json');
		await mkdir(directory);
		await mkdir(lockDirectory);
		await writeFile(ownerFile, JSON.stringify({ token: 'stale-owner', createdAt: 0 }));
		const staleTime = new Date(Date.now() - 15 * 60 * 1000);
		await utimes(ownerFile, staleTime, staleTime);
		await utimes(lockDirectory, staleTime, staleTime);
		const value = matchedTrack('After stale lock');
		const cache = new FileSpotifyMatchCache({ directory });

		await cache.set(identityFor(value), value);
		expect(await new FileSpotifyMatchCache({ directory }).get(identityFor(value))).toEqual(value);
	});

	it('bounds acquisition without deleting a fresh lock owned by another writer', async () => {
		const directory = join(await createTemporaryDirectory(), 'cache');
		const cache = new FileSpotifyMatchCache({ directory });
		await cache.flush();
		const lockDirectory = join(directory, 'spotify-match-cache.lock');
		const ownerFile = join(lockDirectory, 'owner.json');
		await mkdir(lockDirectory);
		await writeFile(ownerFile, JSON.stringify({ token: 'active-owner', createdAt: Date.now() }));
		await cache.set(identityFor(matchedTrack('Blocked')), matchedTrack('Blocked'));

		expect(JSON.parse(await readFile(ownerFile, 'utf8'))).toMatchObject({ token: 'active-owner' });
		expect((await lstat(lockDirectory)).isDirectory()).toBe(true);
		await expect(lstat(join(directory, CACHE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
