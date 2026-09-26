import { describe, expect, it } from 'vitest';
import type { CatalogProgress } from './catalog-scan';
import { progressSignature } from './catalog-cloud.client';

describe('cloud sync change detection', () => {
	it('ignores local scan timers but notices an episode review change', async () => {
		const progress: CatalogProgress = {
			schemaVersion: 2,
			matcherVersion: 1,
			showAlias: 'channeling',
			updatedAt: Date.now(),
			episodes: {
				episode: {
					episodeAlias: 'episode',
					name: 'Episode',
					broadcast: '2026-09-22T17:00:00.000Z',
					cover: '',
					genres: [],
					status: 'pending',
					tracks: []
				}
			},
			playlist: { title: 'Channeling', description: '', public: false }
		};
		const initial = await progressSignature(progress);
		expect(
			await progressSignature({ ...progress, updatedAt: progress.updatedAt + 1_000 })
		).toBe(initial);
		expect(
			await progressSignature({
				...progress,
				episodes: {
					episode: { ...progress.episodes.episode, status: 'done' }
				}
			})
		).not.toBe(initial);
	});
});
