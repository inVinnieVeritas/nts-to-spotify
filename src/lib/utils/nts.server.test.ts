import { describe, expect, it, vi } from 'vitest';
import { getNTSShowCatalog } from './nts.server';

const response = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('NTS catalogue artwork boundary', () => {
	it('keeps official artwork and omits unapproved artwork before returning the catalogue', async () => {
		const request = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/episodes?')) {
				return response({
					metadata: { resultset: { count: 2 } },
					results: [
						{
							episode_alias: 'official',
							name: 'Official',
							broadcast: '2026-01-01T00:00:00.000Z',
							media: {
								picture_medium_large: 'https://media.ntslive.co.uk/crop/770x770/official.jpg'
							},
							genres: []
						},
						{
							episode_alias: 'unapproved',
							name: 'Unapproved',
							broadcast: '2026-02-01T00:00:00.000Z',
							media: { picture_medium_large: 'https://images.example.test/show.jpg' },
							genres: []
						}
					]
				});
			}
			return response({
				name: 'Show',
				description: 'Description',
				media: { picture_large: 'https://127.0.0.1/crop/770x770/private.jpg' }
			});
		}) as typeof fetch;

		const catalog = await getNTSShowCatalog('show', request);
		expect(catalog.cover).toBe('');
		expect(catalog.episodes.map(({ cover }) => cover)).toEqual([
			'https://media.ntslive.co.uk/crop/770x770/official.jpg',
			''
		]);
	});
});
