import { describe, expect, it, vi } from 'vitest';
import type { NTSEpisodeSummary } from '$lib/types';
import {
	CATALOG_BACKUP_FORMAT,
	CATALOG_BACKUP_MAX_COOLDOWN_MS,
	CATALOG_BACKUP_VERSION,
	CatalogBackupValidationError,
	createCatalogBackup,
	parseCatalogBackup,
	persistAndApplyCatalogRestore,
	prepareCatalogBackupRestore,
	restoreCatalogProgressIfConfirmed,
	serializeCatalogBackup
} from './catalog-backup';
import {
	CATALOG_PROGRESS_SCHEMA_VERSION,
	SPOTIFY_MATCHER_VERSION,
	captureCatalogProgress,
	type CatalogProgress,
	type EpisodeState
} from './catalog-scan';

const EXPORTED_AT = '2026-08-15T12:00:00.000Z';
const EXPORTED_AT_MS = Date.parse(EXPORTED_AT);
const TRACK_ID = '0123456789ABCDEFGHIJKL';
const OTHER_TRACK_ID = 'ZYXWVUTSRQPONMLKJIHGFE';
const TRACK_URI = `spotify:track:${TRACK_ID}`;
const OTHER_TRACK_URI = `spotify:track:${OTHER_TRACK_ID}`;
const PLAYLIST_ID = 'ABCDEFGHIJKLMNOPQRSTUV';

const catalog: NTSEpisodeSummary[] = [
	{
		episodeAlias: 'older',
		name: 'Older current name',
		broadcast: '2026-01-01T00:00:00.000Z',
		cover: '',
		genres: ['Ambient']
	},
	{
		episodeAlias: 'newer',
		name: 'Newer current name',
		broadcast: '2026-02-01T00:00:00.000Z',
		cover: 'https://images.example.test/newer.jpg',
		genres: ['Electronic']
	}
];

const reviewedEpisode = (status: EpisodeState['status'] = 'done'): EpisodeState => ({
	...catalog[0],
	name: 'Old saved name',
	status,
	tracks: [
		{
			artist: 'NTS artist',
			title: 'NTS title',
			matches: [
				{
					artist: 'Spotify artist',
					title: 'Spotify title',
					uri: TRACK_URI,
					href: `https://open.spotify.com/track/${TRACK_ID}`,
					cover: 'https://i.scdn.co/image/cover',
					preview: 'https://p.scdn.co/mp3-preview/preview'
				}
			],
			confident: false,
			fallback: true,
			selectedMatch: TRACK_URI,
			checked: true
		}
	]
});

const makeProgress = (): CatalogProgress =>
	captureCatalogProgress(
		'show',
		[reviewedEpisode(), { ...catalog[1], status: 'scanning', tracks: [] }],
		{
			title: 'Saved playlist',
			description: 'Saved description',
			public: true,
			order: 'oldest-first',
			linkedPlaylistId: PLAYLIST_ID
		},
		{ cooldownUntil: EXPORTED_AT_MS + 8 * 60 * 60 * 1000, pausedByRateLimit: true }
	);

const jsonEnvelope = (progress = makeProgress()) => {
	progress.updatedAt = EXPORTED_AT_MS;
	return JSON.stringify(createCatalogBackup(progress, new Date(EXPORTED_AT)));
};

describe('catalogue progress backup', () => {
	it('round trips every whitelisted persisted field', () => {
		const progress = makeProgress();
		progress.updatedAt = EXPORTED_AT_MS;
		const parsed = parseCatalogBackup(
			serializeCatalogBackup(progress, new Date(EXPORTED_AT)),
			'show'
		);

		expect(parsed).toEqual({
			format: CATALOG_BACKUP_FORMAT,
			version: CATALOG_BACKUP_VERSION,
			exportedAt: EXPORTED_AT,
			showAlias: 'show',
			progress
		});
	});

	it('accepts legacy backups without linkage state and rejects invalid linked IDs', () => {
		const legacy = JSON.parse(jsonEnvelope()) as {
			progress: { playlist: { linkedPlaylistId?: string; creationPending?: boolean } };
		};
		delete legacy.progress.playlist.linkedPlaylistId;
		delete legacy.progress.playlist.creationPending;
		expect(parseCatalogBackup(JSON.stringify(legacy), 'show').progress.playlist).not.toHaveProperty(
			'linkedPlaylistId'
		);

		const invalid = JSON.parse(jsonEnvelope()) as typeof legacy;
		invalid.progress.playlist.linkedPlaylistId = 'not-a-playlist-id';
		expect(() => parseCatalogBackup(JSON.stringify(invalid), 'show')).toThrow(
			'linkedPlaylistId is invalid'
		);
	});

	it('round trips a pending first-creation state without changing backup versions', () => {
		const progress = makeProgress();
		progress.updatedAt = EXPORTED_AT_MS;
		delete progress.playlist.linkedPlaylistId;
		progress.playlist.creationPending = true;

		const parsed = parseCatalogBackup(
			serializeCatalogBackup(progress, new Date(EXPORTED_AT)),
			'show'
		);
		expect(parsed.progress.playlist.creationPending).toBe(true);
		expect(parsed.version).toBe(CATALOG_BACKUP_VERSION);
		expect(parsed.progress.schemaVersion).toBe(CATALOG_PROGRESS_SCHEMA_VERSION);
	});

	it('rejects inconsistent linked and pending creation state', () => {
		const inconsistent = JSON.parse(jsonEnvelope()) as {
			progress: { playlist: { creationPending?: boolean } };
		};
		inconsistent.progress.playlist.creationPending = true;
		expect(() => parseCatalogBackup(JSON.stringify(inconsistent), 'show')).toThrow(
			'creation state is inconsistent'
		);
	});

	it('exports the latest manual choices rather than an older snapshot', () => {
		const progress = makeProgress();
		progress.updatedAt = EXPORTED_AT_MS;
		progress.episodes.older.tracks[0].checked = false;
		progress.episodes.older.tracks[0].selectedMatch = null;

		const parsed = parseCatalogBackup(
			serializeCatalogBackup(progress, new Date(EXPORTED_AT)),
			'show'
		);
		expect(parsed.progress.episodes.older.tracks[0]).toMatchObject({
			checked: false,
			selectedMatch: null
		});
	});

	it('whitelists fields and excludes credential, token, cookie, and header data', () => {
		const progress = makeProgress() as CatalogProgress & Record<string, unknown>;
		progress.updatedAt = EXPORTED_AT_MS;
		progress.clientSecret = 'secret-value';
		(progress.playlist as unknown as Record<string, unknown>).accessToken = 'token-value';
		(progress.retry as unknown as Record<string, unknown>).environment = 'environment-value';
		(progress.episodes.older as unknown as Record<string, unknown>).session = 'session-value';
		(progress.episodes.older.tracks[0] as unknown as Record<string, unknown>).cookie =
			'cookie-value';
		(
			progress.episodes.older.tracks[0].matches[0] as unknown as Record<string, unknown>
		).authorization = 'header-value';

		const serialized = serializeCatalogBackup(progress, new Date(EXPORTED_AT));
		expect(serialized).not.toContain('secret-value');
		expect(serialized).not.toContain('token-value');
		expect(serialized).not.toContain('cookie-value');
		expect(serialized).not.toContain('header-value');
		expect(serialized).not.toContain('environment-value');
		expect(serialized).not.toContain('session-value');
	});

	it('accepts the Spotify URI and HTTPS resource shapes produced by the application', () => {
		const parsed = parseCatalogBackup(jsonEnvelope(), 'show');
		expect(parsed.progress.episodes.older.tracks[0].matches[0]).toMatchObject({
			uri: TRACK_URI,
			href: `https://open.spotify.com/track/${TRACK_ID}`,
			cover: 'https://i.scdn.co/image/cover',
			preview: 'https://p.scdn.co/mp3-preview/preview'
		});
	});

	it.each([
		['malformed link', 'href', 'not a URL'],
		['javascript link', 'href', 'javascript:alert(1)'],
		['data link', 'href', 'data:text/html,unsafe'],
		['file link', 'href', 'file:///tmp/unsafe'],
		['protocol-relative link', 'href', '//open.spotify.com/track/' + TRACK_ID],
		['credential-bearing link', 'href', `https://user:password@open.spotify.com/track/${TRACK_ID}`],
		['unexpected link host', 'href', `https://example.test/track/${TRACK_ID}`],
		['unexpected link path', 'href', `https://open.spotify.com/artist/${TRACK_ID}`],
		['mismatched track link', 'href', `https://open.spotify.com/track/${OTHER_TRACK_ID}`],
		['non-HTTPS artwork', 'cover', 'http://i.scdn.co/image/cover'],
		['data artwork', 'cover', 'data:image/png;base64,AAAA'],
		['non-HTTPS preview', 'preview', 'http://p.scdn.co/mp3-preview/preview']
	])('rejects a malicious or malformed %s', (_name, field, value) => {
		const envelope = JSON.parse(jsonEnvelope()) as {
			progress: {
				episodes: { older: { tracks: Array<{ matches: Array<Record<string, unknown>> }> } };
			};
		};
		envelope.progress.episodes.older.tracks[0].matches[0][field] = value;
		expect(() => parseCatalogBackup(JSON.stringify(envelope), 'show')).toThrow();
	});

	it('rejects malformed Spotify URIs and a selected match outside the alternatives', () => {
		const malformed = JSON.parse(jsonEnvelope()) as {
			progress: { episodes: { older: { tracks: Array<Record<string, unknown>> } } };
		};
		const track = malformed.progress.episodes.older.tracks[0];
		track.selectedMatch = 'spotify:album:not-a-track';
		expect(() => parseCatalogBackup(JSON.stringify(malformed), 'show')).toThrow(
			'not a supported Spotify track URI'
		);

		const malformedAlternative = JSON.parse(jsonEnvelope()) as {
			progress: {
				episodes: { older: { tracks: Array<{ matches: Array<Record<string, unknown>> }> } };
			};
		};
		malformedAlternative.progress.episodes.older.tracks[0].matches[0].uri =
			'spotify:track:too-short';
		expect(() => parseCatalogBackup(JSON.stringify(malformedAlternative), 'show')).toThrow(
			'not a supported Spotify track URI'
		);

		const inconsistent = JSON.parse(jsonEnvelope()) as typeof malformed;
		inconsistent.progress.episodes.older.tracks[0].selectedMatch = OTHER_TRACK_URI;
		expect(() => parseCatalogBackup(JSON.stringify(inconsistent), 'show')).toThrow(
			'must reference one of the track matches'
		);
	});

	it('rejects malformed JSON and unsupported backup versions', () => {
		expect(() => parseCatalogBackup('{not json', 'show')).toThrow(CatalogBackupValidationError);
		const envelope = JSON.parse(jsonEnvelope()) as Record<string, unknown>;
		envelope.version = CATALOG_BACKUP_VERSION + 1;
		expect(() => parseCatalogBackup(JSON.stringify(envelope), 'show')).toThrow(
			'backup version is not supported'
		);
	});

	it('rejects backups for another show', () => {
		expect(() => parseCatalogBackup(jsonEnvelope(), 'different-show')).toThrow(
			'belongs to a different NTS show'
		);
	});

	it('rejects invalid fields, unsupported fields, and dangerous object keys', () => {
		const invalid = JSON.parse(jsonEnvelope()) as {
			progress: { playlist: Record<string, unknown> };
		};
		invalid.progress.playlist.public = 'yes';
		expect(() => parseCatalogBackup(JSON.stringify(invalid), 'show')).toThrow('must be a boolean');

		const unsupported = JSON.parse(jsonEnvelope()) as Record<string, unknown>;
		unsupported.credentials = 'not allowed';
		expect(() => parseCatalogBackup(JSON.stringify(unsupported), 'show')).toThrow(
			'unsupported field'
		);

		const invalidShape = JSON.parse(jsonEnvelope()) as Record<string, unknown>;
		invalidShape.progress = [];
		expect(() => parseCatalogBackup(JSON.stringify(invalidShape), 'show')).toThrow(
			'progress must be an object'
		);

		for (const key of ['__proto__', 'prototype', 'constructor']) {
			const dangerous = jsonEnvelope().replace(
				'"playlist":',
				`"${key}":{"polluted":true},"playlist":`
			);
			expect(() => parseCatalogBackup(dangerous, 'show')).toThrow('dangerous object key');
		}
	});

	it('does not include imported aliases in public validation messages', () => {
		const envelope = JSON.parse(jsonEnvelope()) as {
			progress: { episodes: Record<string, Record<string, unknown>> };
		};
		const importedAlias = 'private-imported-alias';
		envelope.progress.episodes[importedAlias] = {
			...envelope.progress.episodes.older,
			episodeAlias: importedAlias,
			status: 'invalid-status'
		};
		delete envelope.progress.episodes.older;

		try {
			parseCatalogBackup(JSON.stringify(envelope), 'show');
			throw new Error('Expected validation to fail');
		} catch (cause) {
			expect(cause).toBeInstanceOf(CatalogBackupValidationError);
			expect((cause as Error).message).not.toContain(importedAlias);
		}
	});

	it('rejects malformed, non-safe, and implausible timestamps', () => {
		const malformedDate = JSON.parse(jsonEnvelope()) as Record<string, unknown>;
		malformedDate.exportedAt = '2026-08-15 12:00:00';
		expect(() => parseCatalogBackup(JSON.stringify(malformedDate), 'show')).toThrow(
			'exportedAt is invalid'
		);

		const impossibleDate = JSON.parse(jsonEnvelope()) as Record<string, unknown>;
		impossibleDate.exportedAt = '2026-02-30T12:00:00.000Z';
		expect(() => parseCatalogBackup(JSON.stringify(impossibleDate), 'show')).toThrow(
			'exportedAt is invalid'
		);

		expect(() =>
			parseCatalogBackup(jsonEnvelope(), 'show', EXPORTED_AT_MS - 10 * 60 * 1000)
		).toThrow('exportedAt is invalid');

		const unsafeUpdatedAt = JSON.parse(jsonEnvelope()) as {
			progress: Record<string, unknown>;
		};
		unsafeUpdatedAt.progress.updatedAt = Number.MAX_SAFE_INTEGER + 1;
		expect(() => parseCatalogBackup(JSON.stringify(unsafeUpdatedAt), 'show')).toThrow(
			'must be a valid number'
		);

		const ancientUpdatedAt = JSON.parse(jsonEnvelope()) as typeof unsafeUpdatedAt;
		ancientUpdatedAt.progress.updatedAt = 1;
		expect(() => parseCatalogBackup(JSON.stringify(ancientUpdatedAt), 'show')).toThrow(
			'outside the supported range'
		);

		const hugeCooldown = JSON.parse(jsonEnvelope()) as {
			progress: { retry: Record<string, unknown> };
		};
		hugeCooldown.progress.retry.cooldownUntil = Number.MAX_VALUE;
		expect(() => parseCatalogBackup(JSON.stringify(hugeCooldown), 'show')).toThrow(
			'must be a valid number'
		);

		const implausibleCooldown = JSON.parse(jsonEnvelope()) as typeof hugeCooldown;
		implausibleCooldown.progress.retry.cooldownUntil =
			EXPORTED_AT_MS + CATALOG_BACKUP_MAX_COOLDOWN_MS + 1;
		expect(() => parseCatalogBackup(JSON.stringify(implausibleCooldown), 'show')).toThrow(
			'outside the supported range'
		);
	});

	it.each([
		['schemaVersion', CATALOG_PROGRESS_SCHEMA_VERSION + 100],
		['matcherVersion', SPOTIFY_MATCHER_VERSION + 100]
	])('rejects an incompatible %s', (field, value) => {
		const envelope = JSON.parse(jsonEnvelope()) as {
			progress: Record<string, unknown>;
		};
		envelope.progress[field] = value;
		expect(() => parseCatalogBackup(JSON.stringify(envelope), 'show')).toThrow(
			'schema or Spotify matcher version is incompatible'
		);
	});
});

describe('catalogue progress restoration', () => {
	it('reconciles by alias, preserves manual review, and recovers interrupted episodes', () => {
		const prepared = prepareCatalogBackupRestore(
			jsonEnvelope(),
			'show',
			catalog,
			EXPORTED_AT_MS + 1_000
		);

		expect(prepared.episodes.map(({ episodeAlias }) => episodeAlias)).toEqual(['older', 'newer']);
		expect(prepared.episodes[0]).toMatchObject({
			name: 'Older current name',
			status: 'done',
			tracks: [{ checked: true, selectedMatch: TRACK_URI }]
		});
		expect(prepared.episodes[1]).toMatchObject({ status: 'pending', tracks: [] });
		expect(prepared.progress.playlist).toMatchObject({
			title: 'Saved playlist',
			description: 'Saved description',
			public: true,
			order: 'oldest-first',
			linkedPlaylistId: PLAYLIST_ID
		});
	});

	it('restores a legitimate eight-hour cooldown and later treats it as expired', () => {
		const active = prepareCatalogBackupRestore(
			jsonEnvelope(),
			'show',
			catalog,
			EXPORTED_AT_MS + 1_000
		);
		expect(active.retry).toEqual({
			cooldownUntil: EXPORTED_AT_MS + 8 * 60 * 60 * 1000,
			pausedByRateLimit: true
		});

		const prepared = prepareCatalogBackupRestore(
			jsonEnvelope(),
			'show',
			catalog,
			EXPORTED_AT_MS + 8 * 60 * 60 * 1000
		);
		expect(prepared.retry).toEqual({ cooldownUntil: 0, pausedByRateLimit: false });
		expect(prepared.progress.retry).toEqual({ cooldownUntil: 0, pausedByRateLimit: false });
	});

	it('does not apply replacement state when persistence fails', async () => {
		const prepared = prepareCatalogBackupRestore(
			jsonEnvelope(),
			'show',
			catalog,
			EXPORTED_AT_MS + 1_000
		);
		let visibleTitle = 'Existing visible title';
		const stored = makeProgress();
		const originalStored = structuredClone(stored);
		const apply = vi.fn(() => {
			visibleTitle = 'Imported title';
		});
		await expect(
			persistAndApplyCatalogRestore(
				prepared,
				(nextProgress) =>
					Promise.reject(new Error(`write failed before ${nextProgress.playlist.title}`)),
				apply
			)
		).rejects.toThrow('write failed before Saved playlist');
		expect(apply).not.toHaveBeenCalled();
		expect(stored).toEqual(originalStored);
		expect(visibleTitle).toBe('Existing visible title');
	});

	it('does nothing when replacement confirmation is cancelled', async () => {
		const prepared = prepareCatalogBackupRestore(
			jsonEnvelope(),
			'show',
			catalog,
			EXPORTED_AT_MS + 1_000
		);
		const beforePersist = vi.fn(() => undefined);
		const persist = vi.fn(async () => undefined);
		const apply = vi.fn();

		await expect(
			restoreCatalogProgressIfConfirmed(prepared, {
				confirm: () => false,
				beforePersist,
				persist,
				apply
			})
		).resolves.toBe(false);
		expect(beforePersist).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});
});
