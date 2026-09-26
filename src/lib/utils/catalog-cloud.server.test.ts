import { describe, expect, it, vi } from 'vitest';
import type { CatalogProgress } from './catalog-scan';

vi.mock('$env/dynamic/private', () => ({
	env: { NTS_FIRESTORE_PROJECT: 'test-project-123' }
}));
vi.mock('./hosted-access.server', () => ({
	hostedConfiguration: () => ({ userId: 'owner', origin: 'https://example.test' })
}));

import {
	CloudProgressError,
	listCloudCatalogues,
	loadCloudProgress,
	saveCloudProgress,
	validateCloudProgress
} from './catalog-cloud.server';

const episode = {
	episodeAlias: 'episode-one',
	name: 'Episode One',
	broadcast: '2026-09-22T17:00:00.000Z',
	cover: '',
	genres: [],
	status: 'done' as const,
	tracks: []
};
const progress = (): CatalogProgress => ({
	schemaVersion: 2,
	matcherVersion: 1,
	showAlias: 'channeling',
	updatedAt: Date.now(),
	episodes: {
		[episode.episodeAlias]: episode,
		'episode-two': {
			...episode,
			episodeAlias: 'episode-two',
			status: 'pending'
		}
	},
	playlist: { title: 'Channeling', description: '', public: false },
	retry: { cooldownUntil: 0, pausedByRateLimit: false }
});

type TestWrite = {
	update?: { name: string; fields: Record<string, { stringValue: string }> };
	delete?: string;
	currentDocument?: { exists?: boolean; updateTime?: string };
};

describe('cloud progress', () => {
	it('saves separate episodes, reads them back, and rejects stale device writes', async () => {
		const documents = new Map<string, { name: string; updateTime: string; fields: object }>();
		let sequence = 0;
		const commits: Array<{ writes: TestWrite[] }> = [];
		const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/computeMetadata/')) return Response.json({ access_token: 'test-token' });
			if (url.endsWith('/documents:commit')) {
				const body = JSON.parse(String(init?.body)) as { writes: TestWrite[] };
				commits.push(body);
				const manifestWrite = body.writes.at(-1)!;
				const manifest = documents.get(manifestWrite.update!.name);
				const precondition = manifestWrite.currentDocument!;
				if (
					(precondition.exists === false && manifest) ||
					(precondition.updateTime && precondition.updateTime !== manifest?.updateTime)
				)
					return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
				const results = body.writes.map((write) => {
					const timestamp = new Date(Date.UTC(2026, 8, 25, 12, 0, ++sequence)).toISOString();
					if (write.delete) documents.delete(write.delete);
					else documents.set(write.update!.name, { ...write.update!, updateTime: timestamp });
					return { updateTime: timestamp };
				});
				return Response.json({ writeResults: results });
			}
			const name = url.replace(/^https:\/\/firestore.googleapis.com\/v1\//, '').split('?')[0];
			if (name.endsWith('/episodes') || name.endsWith('/catalogues')) {
				return Response.json({
					documents: [...documents.values()].filter((document) =>
						document.name.startsWith(`${name}/`)
					)
				});
			}
			return documents.has(name)
				? Response.json(documents.get(name))
				: Response.json({ error: 'not found' }, { status: 404 });
		}) as unknown as typeof fetch;

		const original = progress();
		const firstVersion = await saveCloudProgress('channeling', original, null, request);
		expect(commits[0].writes).toHaveLength(3);
		expect(commits[0].writes[0].update?.fields.payload.stringValue).toMatch(/^gz:/);
		expect((await loadCloudProgress('channeling', request))?.progress.episodes).toEqual(
			original.episodes
		);
		expect(await listCloudCatalogues(request)).toMatchObject([
			{ showAlias: 'channeling', scanned: 1, pending: 1, failed: 0 }
		]);
		const secondVersion = await saveCloudProgress('channeling', original, firstVersion, request);
		expect(commits[1].writes).toHaveLength(1);
		await expect(
			saveCloudProgress('channeling', original, firstVersion, request)
		).rejects.toMatchObject({
			kind: 'conflict'
		});
		expect(secondVersion).not.toBe(firstVersion);
	});

	it('validates browser snapshots and ignores local-only scan timers', () => {
		const input = { ...progress(), scanTiming: { active: { invalid: true } } };
		expect(validateCloudProgress(input, 'channeling')).not.toHaveProperty('scanTiming');
		expect(() => validateCloudProgress(input, 'another-show')).toThrow(CloudProgressError);
	});
});
