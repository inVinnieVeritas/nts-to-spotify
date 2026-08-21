import { describe, expect, it, vi } from 'vitest';
import { CATALOG_BACKUP_MAX_BYTES, CatalogBackupValidationError } from './catalog-backup';
import {
	catalogBackupFilename,
	downloadCatalogProgressFile,
	downloadLatestCatalogProgress,
	readCatalogBackupFile,
	takeSelectedCatalogBackupFile,
	type CatalogBackupFile
} from './catalog-backup.client';
import type { CatalogProgress } from './catalog-scan';

const progress = (checked: boolean): CatalogProgress => ({
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias: 'show',
	updatedAt: Date.parse('2026-08-15T12:00:00.000Z'),
	episodes: {
		episode: {
			episodeAlias: 'episode',
			name: 'Episode',
			broadcast: '2026-08-15T10:00:00.000Z',
			cover: '',
			genres: [],
			status: 'done',
			tracks: [
				{
					artist: 'Artist',
					title: 'Track',
					matches: [],
					confident: false,
					fallback: false,
					selectedMatch: null,
					checked
				}
			]
		}
	},
	playlist: { title: 'Title', description: 'Description', public: false },
	retry: { cooldownUntil: 0, pausedByRateLimit: false }
});

describe('catalogue backup file selection', () => {
	it('rejects an oversized file before calling file.text', async () => {
		const text = vi.fn(async () => '{}');
		const file = {
			name: 'backup.json',
			size: CATALOG_BACKUP_MAX_BYTES + 1,
			text
		};

		await expect(readCatalogBackupFile(file)).rejects.toBeInstanceOf(CatalogBackupValidationError);
		expect(text).not.toHaveBeenCalled();
	});

	it('clears the input so the same file can be selected again', () => {
		const file: CatalogBackupFile = { name: 'backup.json', size: 2, text: async () => '{}' };
		const input = { files: [file], value: 'C:\\fakepath\\backup.json' };

		expect(takeSelectedCatalogBackupFile(input)).toBe(file);
		expect(input.value).toBe('');
		input.value = 'C:\\fakepath\\backup.json';
		expect(takeSelectedCatalogBackupFile(input)).toBe(file);
		expect(input.value).toBe('');
	});
});

describe('catalogue backup download', () => {
	it('captures changes made while an earlier persistence flush is pending', async () => {
		let releaseFlush: (() => void) | undefined;
		const flush = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		let checked = false;
		const downloaded: CatalogProgress[] = [];
		const enqueued: CatalogProgress[] = [];
		const running = downloadLatestCatalogProgress({
			flush: () => flush,
			capture: () => structuredClone(progress(checked)),
			enqueue: (snapshot) => enqueued.push(snapshot),
			download: (snapshot) => downloaded.push(snapshot)
		});

		checked = true;
		releaseFlush?.();
		await running;

		expect(downloaded[0].episodes.episode.tracks[0].checked).toBe(true);
		expect(enqueued[0]).toBe(downloaded[0]);
	});

	it('removes the anchor and revokes the object URL when clicking throws', () => {
		const remove = vi.fn();
		const revokeObjectUrl = vi.fn();
		const anchor = {
			href: '',
			download: '',
			click: vi.fn(() => {
				throw new Error('click failed');
			}),
			remove
		};

		expect(() =>
			downloadCatalogProgressFile(progress(false), 'backup.json', {
				createObjectUrl: () => 'blob:test',
				revokeObjectUrl,
				createAnchor: () => anchor,
				schedule: vi.fn()
			})
		).toThrow('click failed');
		expect(remove).toHaveBeenCalledOnce();
		expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
	});

	it('revokes the object URL when anchor setup throws', () => {
		const revokeObjectUrl = vi.fn();
		expect(() =>
			downloadCatalogProgressFile(progress(false), 'backup.json', {
				createObjectUrl: () => 'blob:test',
				revokeObjectUrl,
				createAnchor: () => {
					throw new Error('anchor failed');
				},
				schedule: vi.fn()
			})
		).toThrow('anchor failed');
		expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
	});

	it('schedules URL revocation and produces a safe bounded filename', () => {
		let cleanup: (() => void) | undefined;
		const revokeObjectUrl = vi.fn();
		const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
		downloadCatalogProgressFile(progress(false), 'backup.json', {
			createObjectUrl: () => 'blob:test',
			revokeObjectUrl,
			createAnchor: () => anchor,
			schedule: (callback) => {
				cleanup = callback;
			}
		});
		cleanup?.();

		expect(anchor.remove).toHaveBeenCalledOnce();
		expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
		expect(catalogBackupFilename('../unsafe/show', new Date('2026-08-15T00:00:00.000Z'))).toBe(
			'-unsafe-show-catalogue-progress-2026-08-15.json'
		);
		expect(catalogBackupFilename('x'.repeat(500)).length).toBeLessThan(180);
	});
});
