import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { getNTSData } from './utils.server';

describe('single-episode NTS artwork', () => {
	it('validates artwork before returning data that can reach the page background', () => {
		const official = getNTSData(
			load('<meta property="og:image" content="https://media.ntslive.co.uk/crop/770x770/show.jpg">')
		);
		const arbitrary = getNTSData(
			load('<meta property="og:image" content="https://images.example.test/show.jpg">')
		);

		expect(official.cover).toBe('https://media.ntslive.co.uk/crop/770x770/show.jpg');
		expect(arbitrary.cover).toBe('');
	});
});
