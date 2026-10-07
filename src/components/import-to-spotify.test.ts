import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as sync from '$lib/utils/playlist-sync.client';
import * as preview from '$lib/utils/playlist-preview.client';
import * as scan from '$lib/utils/catalog-scan';

// Execute the component's actual action and derived state without a browser DOM.
// Recompute the real reactive expressions after setting props, as a reload does.
const source = readFileSync(new URL('./import-to-spotify.svelte', import.meta.url), 'utf8')
	.split('<script lang="ts">')[1]
	.split('</script>')[0]
	.replace(/^\s*import[\s\S]*?;\n/gm, '')
	.replace(/\bexport\s+let\b/g, 'let');
const derived: string[] = [];
const derivedNames: string[] = [];
const printer = ts.createPrinter();
const code = ts.transpileModule(source, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	transformers: {
		before: [
			(context) => (file) => {
				const visit = (node: ts.Node): ts.VisitResult<ts.Node | undefined> => {
					if (ts.isLabeledStatement(node) && node.label.text === '$') {
						derived.push(printer.printNode(ts.EmitHint.Unspecified, node.statement, file));
						if (
							ts.isExpressionStatement(node.statement) &&
							ts.isBinaryExpression(node.statement.expression) &&
							ts.isIdentifier(node.statement.expression.left)
						)
							derivedNames.push(node.statement.expression.left.text);
						return undefined;
					}
					return ts.visitEachChild(node, visit, context);
				};
				return ts.visitNode(file, visit) as ts.SourceFile;
			}
		]
	}
}).outputText;

const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV';
const tracks = Array.from(
	{ length: 1559 },
	(_, i) => `spotify:track:${String(i).padStart(22, '0')}`
);
const old: sync.CatalogPlaylistSyncRecord = {
	version: 1,
	revision: 7,
	catalogueAlias: 'amanda',
	operationId: 'previous_operation_12345',
	playlistId,
	targetFingerprint: 'a'.repeat(64),
	totalTrackCount: 1538,
	confirmedPosition: 100,
	phase: 'blocked',
	mode: 'created',
	startedAt: 1,
	updatedAt: 1,
	snapshotId: 'snapshot-old',
	reason: 'external-change'
};

const setup = (record = old) => {
	const confirm = vi.fn(() => true);
	const request = vi.fn(async (_fetch: typeof fetch, _body: unknown) => ({
		response: new Response(null),
		body: {
			playlistId,
			mode: 'preview',
			previewFingerprint: 'b'.repeat(64),
			stateFingerprint: 'c'.repeat(64),
			snapshotId: 'snapshot-live',
			addedCount: 1459,
			retainedCount: 100,
			removedCount: 0,
			orderChanged: false,
			titleChanged: true,
			descriptionChanged: true,
			visibilityChanged: false,
			synchronized: false
		}
	}));
	const claim = vi.fn(async (candidate: sync.CatalogPlaylistSyncRecord) => ({
		acquired: true,
		record: { ...candidate, revision: candidate.revision + 1 }
	}));
	const run = vi.fn(async (input: Parameters<typeof sync.runPlaylistSyncBatches>[0]) => ({
		type: 'completed',
		record: { ...input.record, phase: 'completed', confirmedPosition: 1559 }
	}));
	const context = vm.createContext({
		...sync,
		...preview,
		...scan,
		...Object.fromEntries(derivedNames.map((name) => [name, undefined])),
		$page: { data: { user: { id: 'owner' } } },
		onMount: () => {},
		onDestroy: () => {},
		AbortController,
		Response,
		Date,
		setInterval,
		clearInterval,
		window: { confirm },
		fetch: vi.fn(),
		isLocalCloudBridge: () => false,
		localCloudConnected: () => false,
		requestPlaylistJson: request,
		claimCatalogPlaylistSyncLease: claim,
		runPlaylistSyncBatches: run
	});
	vm.runInContext(
		code +
			`
		const refreshDerivedState = () => { ${derived.join('\n')} };
		globalThis.driver = {
			configure(record) {
				data = { title: 'New title', description: 'New dates', public: true, tracks: globalThis.targetTracks, linkedPlaylistId: globalThis.targetId };
				localSyncRecord = syncRecord = record;
				catalogueMode = true; showAlias = 'amanda'; tabOwner = 'document_owner_12345';
				refreshDerivedState();
			},
			changeTitle() { data = { ...data, title: 'Changed during preview' }; refreshDerivedState(); },
			action: synchronizePlaylist,
			snapshot() { return { record: localSyncRecord, failure, working, resumableSync, preview }; }
		};`,
		context
	);
	context.targetTracks = tracks;
	context.targetId = playlistId;
	context.driver.configure(record);
	return { context, confirm, request, claim, run };
};

describe('fresh synchronization from a reloaded catalogue', () => {
	it('fetches a fresh preview with no pre-existing preview or resumable operation', async () => {
		const { context, request, confirm, claim, run } = setup();
		expect(context.driver.snapshot()).toMatchObject({ resumableSync: false, preview: undefined });
		await context.driver.action(true);
		expect(request).toHaveBeenCalledOnce();
		expect(request.mock.calls[0][1]).toMatchObject({ operation: 'preview', tracks });
		expect(confirm).toHaveBeenCalledOnce();
		expect(claim).toHaveBeenCalledOnce();
		expect(claim.mock.calls[0][0]).toMatchObject({
			confirmedPosition: 0,
			restartRequired: true,
			playlistId
		});
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0][0]).toMatchObject({
			previewFingerprint: 'b'.repeat(64),
			recoverAcknowledgedPrefix: false
		});
		expect(context.driver.snapshot().working).toBe(false);
	});

	it('cancels after the fresh comparison without replacing the old record', async () => {
		const { context, request, confirm, claim, run } = setup();
		confirm.mockReturnValue(false);
		await context.driver.action(true);
		expect(request).toHaveBeenCalledOnce();
		expect(claim).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(context.driver.snapshot().record).toEqual(old);
	});

	it('displays a fresh-preview failure without claiming a new operation', async () => {
		const { context, request, confirm, claim } = setup();
		request.mockResolvedValue({
			response: new Response(null, { status: 429 }),
			body: { error: 'spotify_rate_limited', retryAfterSeconds: 3600 }
		} as never);
		await context.driver.action(true);
		expect(context.driver.snapshot().failure).toContain('rate limited');
		expect(confirm).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	it('discards the result if catalogue settings change during the preview', async () => {
		const { context, request, confirm, claim } = setup();
		const reply = await request(fetch, {});
		request.mockImplementation(async () => {
			context.driver.changeTitle();
			return reply;
		});
		await context.driver.action(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
		expect(context.driver.snapshot().record).toEqual(old);
	});

	it.each([
		{ ...old, reason: 'uncertain' as const },
		{ ...old, leaseOwner: 'another_document_12345', leaseUntil: Date.now() + 60000 }
	])('keeps uncertain outcomes and foreign leases blocked', async (record) => {
		const { context, request, claim } = setup(record);
		await context.driver.action(true);
		expect(request).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});
});
