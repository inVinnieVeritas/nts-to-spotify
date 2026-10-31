import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as scan from '$lib/utils/catalog-scan';
import * as timing from '$lib/utils/catalog-scan-session';
import * as cloud from '$lib/utils/catalog-cloud.client';
import { createLatestSnapshotWriter } from '$lib/utils/catalog-progress.client';

// Execute the actual page restoration/actions, including the real local writer.
const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8')
	.split('<script lang="ts">')[1]
	.split('</script>')[0]
	.replace(/^\s*import\s[\s\S]*?;\n/gm, '')
	.replace('export let data: PageData;', 'let data: PageData = globalThis.pageData;');
const code = ts.transpileModule(source, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	transformers: {
		before: [
			() => (file) =>
				ts.factory.updateSourceFile(
					file,
					file.statements.filter((statement) => !ts.isLabeledStatement(statement))
				)
		]
	}
}).outputText;

function fixture() {
	const episodes: scan.EpisodeState[] = Array.from({ length: 10 }, (_, index) => ({
		episodeAlias: `episode-${index}`,
		name: `Episode ${index}`,
		broadcast: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
		cover: '',
		genres: [],
		status: 'done',
		tracks: []
	}));
	const text = scan.createGeneratedPlaylistText('Wes Baggaley', episodes, 'latest-first');
	const remote: scan.CatalogProgress = {
		schemaVersion: 2,
		matcherVersion: 1,
		showAlias: 'wes-baggaley',
		updatedAt: Date.now(),
		episodes: Object.fromEntries(episodes.map((e) => [e.episodeAlias, e])),
		playlist: {
			title: text.title,
			description: text.description,
			public: true,
			linkedPlaylistId: '6h1vuQ06Gy4m7P9K4lGzmB',
			order: 'latest-first'
		},
		display: { showName: 'Wes Baggaley' }
	};
	const local = structuredClone(remote);
	local.episodes['episode-9'] = { ...local.episodes['episode-9'], status: 'pending' };
	return {
		local,
		remote,
		pageData: {
			showAlias: local.showAlias,
			name: 'Wes Baggaley',
			cover: '',
			episodes,
			user: { id: 'owner' }
		}
	};
}

function setup(
	options: {
		local?: scan.CatalogProgress;
		remote?: scan.CatalogProgress;
		marker?: { signature: string; version: string };
	} = {}
) {
	const f = fixture();
	let stored = structuredClone(options.local ?? f.local);
	let remote = structuredClone(options.remote ?? f.remote);
	let version = 'cloud-new';
	let mount: (() => (() => void) | undefined) | undefined;
	const load = vi.fn(async () => ({ version, progress: structuredClone(remote) }));
	const saveCloud = vi.fn(async () => version);
	const saveLocal = vi.fn(async (progress: scan.CatalogProgress) => {
		stored = structuredClone(progress);
	});
	const deletes = vi.fn(async () => {});
	const windowEvents = new Map<string, () => void>();
	const documentEvents = new Map<string, () => void>();
	const intervals = new Map<number, () => void>();
	const context = vm.createContext({
		...scan,
		...timing,
		...cloud,
		createLatestSnapshotWriter,
		pageData: f.pageData,
		Date,
		performance,
		AbortController,
		onMount: (callback: typeof mount) => {
			mount = callback;
		},
		onDestroy: () => {},
		setInterval: (callback: () => void, ms: number) => {
			intervals.set(ms, callback);
			return ms;
		},
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
		window: {
			addEventListener: (event: string, callback: () => void) => windowEvents.set(event, callback),
			removeEventListener: vi.fn(),
			confirm: vi.fn(() => true)
		},
		document: {
			visibilityState: 'visible',
			addEventListener: (event: string, callback: () => void) =>
				documentEvents.set(event, callback),
			removeEventListener: vi.fn()
		},
		cloudSyncAvailable: () => true,
		localCloudConnected: () => false,
		isLocalCloudBridge: () => false,
		loadCloudCopy: load,
		saveCloudCopy: saveCloud,
		rememberCloudCopy: vi.fn(async () => {}),
		readCloudMarker: () => options.marker ?? null,
		loadCatalogProgress: vi.fn(async () => structuredClone(stored)),
		saveCatalogProgress: saveLocal,
		loadCatalogPlaylistSync: async () => undefined,
		deleteCatalogPlaylistSync: deletes,
		SpotifySearchCooldownController: class {
			initialize = async () => {};
			clearExpired = () => null;
			subscribe = () => () => {};
			destroy = () => {};
		}
	});
	vm.runInContext(
		code +
			`
		globalThis.driver = {
			open: () => initializeShow(data), refresh: refreshCloudProgress,
			editTitle() { playlistTitle = 'My local edit'; captureAndPersistReview(); },
			switchShow() { showGeneration += 1; activeShowAlias = 'another-show'; },
			allowRefresh() { lastCloudCheckAt = 0; },
			setSync(record) { playlistSyncRecord = record; },
			setScanning(value) { scanning = value; },
			snapshot() { return {state: cloudState, title: playlistTitle, counts: getCatalogSummaryCounts(episodes), message: scanMessage, alias: activeShowAlias}; }
			,
			version() { return cloudVersion; }
		};`,
		context
	);
	return {
		context,
		load,
		saveCloud,
		saveLocal,
		deletes,
		windowEvents,
		documentEvents,
		intervals,
		mount: () => mount?.(),
		setRemote: (p: scan.CatalogProgress) => {
			remote = structuredClone(p);
			version = 'cloud-newer';
		},
		stored: () => stored
	};
}

describe('catalogue page cloud refresh', () => {
	it('automatically restores 10 completed episodes over the stale browser copy, with no Spotify or cloud write', async () => {
		const f = setup();
		await f.context.driver.open();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('active'));
		expect(f.context.driver.snapshot().counts).toMatchObject({ scanned: 10, pending: 0 });
		expect(f.context.driver.snapshot().message).not.toContain('Resume scan');
		expect(f.stored().episodes['episode-9'].status).toBe('done');
		expect(f.saveCloud).not.toHaveBeenCalled();
		expect(f.load).toHaveBeenCalledTimes(1);
	});
	it('keeps genuinely edited browser settings as a conflict', async () => {
		const local = fixture().local;
		local.playlist.title = 'My local edit';
		const f = setup({ local });
		await f.context.driver.open();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('conflict'));
		expect(f.context.driver.snapshot().title).toBe('My local edit');
		expect(f.saveLocal).not.toHaveBeenCalled();
	});
	it('refreshes an already open tab after the worker finishes its pending episode', async () => {
		const f = setup({ remote: fixture().local });
		await f.context.driver.open();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('active'));
		expect(f.context.driver.snapshot().counts.pending).toBe(1);
		f.setRemote(fixture().remote);
		f.context.driver.allowRefresh();
		await f.context.driver.refresh();
		expect(f.context.driver.snapshot().counts).toMatchObject({ scanned: 10, pending: 0 });
	});
	it('discards a late cloud response when a local edit happens during the request', async () => {
		const f = setup();
		let reply: ((copy: { version: string; progress: scan.CatalogProgress }) => void) | undefined;
		f.load.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					reply = resolve;
				})
		);
		await f.context.driver.open();
		await vi.waitFor(() => expect(reply).toBeDefined());
		f.context.driver.editTitle();
		reply!({ version: 'cloud-new', progress: fixture().remote });
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).not.toBe('checking'));
		expect(f.context.driver.snapshot().title).toBe('My local edit');
		expect(f.context.driver.snapshot().counts.pending).toBe(1);
		expect(f.deletes).not.toHaveBeenCalled();
	});
	it('retains the old write version if a browser edit cancels the asynchronous comparison', async () => {
		const f = setup({ remote: fixture().local });
		await f.context.driver.open();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('active'));
		const oldVersion = f.context.driver.version();
		f.setRemote(fixture().remote);
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const signature = vi.fn(async (progress: scan.CatalogProgress) => {
			await barrier;
			return cloud.progressSignature(progress);
		});
		f.context.progressSignature = signature;
		f.context.driver.allowRefresh();
		const refresh = f.context.driver.refresh();
		await vi.waitFor(() => expect(signature).toHaveBeenCalledTimes(3));
		f.context.driver.editTitle();
		release!();
		await refresh;
		expect(f.context.driver.version()).toBe(oldVersion);
		expect(f.context.driver.snapshot().title).toBe('My local edit');
		expect(f.context.driver.snapshot().counts.pending).toBe(1);
		expect(f.saveCloud).not.toHaveBeenCalled();
		expect(f.deletes).not.toHaveBeenCalled();
	});
	it('ignores a cloud response after navigation to another catalogue', async () => {
		const f = setup();
		let reply: ((copy: { version: string; progress: scan.CatalogProgress }) => void) | undefined;
		f.load.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					reply = resolve;
				})
		);
		await f.context.driver.open();
		await vi.waitFor(() => expect(reply).toBeDefined());
		f.context.driver.switchShow();
		reply!({ version: 'cloud-new', progress: fixture().remote });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(f.context.driver.snapshot().alias).toBe('another-show');
		expect(f.saveLocal).not.toHaveBeenCalled();
		expect(f.deletes).not.toHaveBeenCalled();
	});
	it('does not refresh during scans, hidden tabs or unfinished playlist operations', async () => {
		const f = setup();
		await f.context.driver.open();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('active'));
		f.load.mockClear();
		f.context.driver.allowRefresh();
		f.context.driver.setScanning(true);
		await f.context.driver.refresh();
		f.context.driver.setScanning(false);
		f.context.document.visibilityState = 'hidden';
		await f.context.driver.refresh();
		f.context.document.visibilityState = 'visible';
		f.context.driver.setSync({ phase: 'settling' });
		await f.context.driver.refresh();
		expect(f.load).not.toHaveBeenCalled();
	});
	it('hooks focus, visibility and a bounded periodic check', async () => {
		const f = setup();
		f.mount();
		await vi.waitFor(() => expect(f.context.driver.snapshot().state).toBe('active'));
		expect(f.windowEvents.get('focus')).toBeDefined();
		expect(f.documentEvents.get('visibilitychange')).toBeDefined();
		expect(f.intervals.has(60_000)).toBe(true);
		const calls = f.load.mock.calls.length;
		await f.context.driver.refresh();
		expect(f.load).toHaveBeenCalledTimes(calls);
	});
});
