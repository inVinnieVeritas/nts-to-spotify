import { describe, expect, it, vi } from 'vitest';
import type { Match } from '$lib/types';
import type { EpisodeState, ReviewTrack } from './catalog-scan';
import {
	catalogReviewCsvFilename,
	downloadCatalogReviewCsv,
	getCatalogReviewCsvRows,
	getCatalogReviewTrackCount,
	serializeCatalogReviewCsv,
	type CatalogReviewCsvDownloadDependencies
} from './catalog-review-csv.client';

const match = (id: string, artist = `Spotify ${id}`, title = `Title ${id}`): Match => ({
	uri: `spotify:track:${id.padEnd(22, 'A').slice(0, 22)}`,
	artist,
	title,
	href: `https://open.spotify.com/track/${id.padEnd(22, 'A').slice(0, 22)}`
});

const track = (overrides: Partial<ReviewTrack> = {}): ReviewTrack => ({
	artist: 'NTS Artist',
	title: 'NTS Title',
	matches: [match('primary')],
	confident: false,
	fallback: false,
	selectedMatch: match('primary').uri,
	checked: true,
	...overrides
});

const episode = (
	name: string,
	broadcast: string,
	tracks: ReviewTrack[],
	status: EpisodeState['status'] = 'done'
): EpisodeState => ({
	episodeAlias: name.toLowerCase().replace(/\s+/g, '-'),
	name,
	broadcast,
	cover: '',
	genres: [],
	status,
	tracks
});

describe('catalogue review CSV rows', () => {
	it('uses the visible review classifier and preserves episode, track, and duplicate occurrence order', () => {
		const primary = match('primary');
		const alternative = match('alternative', 'Chosen Artist', 'Chosen Title');
		const repeated = track({ matches: [primary], selectedMatch: primary.uri });
		const episodes = [
			episode('Old episode', '2026-01-02T12:00:00.000Z', [
				repeated,
				track({
					artist: 'Fallback Artist',
					matches: [primary, alternative],
					fallback: true,
					selectedMatch: alternative.uri,
					checked: false
				}),
				track({ artist: 'Missing Artist', matches: [], selectedMatch: null, checked: false }),
				track({ confident: true })
			]),
			episode('New episode', '2026-02-03T12:00:00.000Z', [repeated]),
			episode('Pending episode', '2026-03-04T12:00:00.000Z', [track()], 'pending')
		];

		const rows = getCatalogReviewCsvRows('Shōw, Name', episodes);

		expect(rows).toHaveLength(4);
		expect(getCatalogReviewTrackCount(episodes)).toBe(rows.length);
		expect(rows.map(({ episode, trackNumber }) => [episode, trackNumber])).toEqual([
			['Old episode', 1],
			['Old episode', 2],
			['Old episode', 3],
			['New episode', 1]
		]);
		expect(rows.map(({ reviewStatus, searchMethod }) => [reviewStatus, searchMethod])).toEqual([
			['primary-review', 'primary'],
			['fallback-review', 'fallback'],
			['no-candidates', 'none'],
			['primary-review', 'primary']
		]);
		expect(rows[1]).toMatchObject({
			suggestedSpotifyArtist: 'Chosen Artist',
			suggestedSpotifyTitle: 'Chosen Title',
			selected: 'no',
			candidateCount: 2,
			spotifyUrl: alternative.href
		});
		expect(rows[2]).toMatchObject({
			suggestedSpotifyArtist: '',
			suggestedSpotifyTitle: '',
			selected: 'no',
			candidateCount: 0,
			spotifyUrl: ''
		});
		expect(rows[0].selected).toBe('yes');
	});

	it('writes an Excel-compatible BOM, CRLF rows, Unicode, quoting, and formula protection', () => {
		const [row] = getCatalogReviewCsvRows('Björk, "Live"\nShow', [
			episode('=SUM(A1:A2)', '2026-01-02T12:00:00.000Z', [
				track({ artist: '+danger', title: '@formula\r\nline' })
			])
		]);
		const dangerousValues = ['=equals', '+plus', '-minus', '@at', '\ttab', '\rcarriage'];
		const csv = serializeCatalogReviewCsv([
			row,
			...dangerousValues.map((ntsArtist) => ({ ...row, ntsArtist }))
		]);

		expect(csv.startsWith('\uFEFF')).toBe(true);
		expect(csv).toContain('"Björk, ""Live""\r\nShow"');
		expect(csv).toContain('"\'=SUM(A1:A2)"');
		expect(csv).toContain('"\'+danger"');
		expect(csv).toContain('"\'@formula\r\nline"');
		for (const value of dangerousValues.slice(0, 5)) {
			expect(csv).toContain(`"'${value}"`);
		}
		expect(csv).toContain('"\'\r\ncarriage"');
		expect(csv.endsWith('\r\n')).toBe(true);
		expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
	});
});

describe('catalogue review CSV download', () => {
	const dependencies = () => {
		let blob: Blob | undefined;
		let cleanup: (() => void) | undefined;
		const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
		const revokeObjectUrl = vi.fn();
		const value: CatalogReviewCsvDownloadDependencies = {
			createObjectUrl: vi.fn((createdBlob) => {
				blob = createdBlob;
				return 'blob:review';
			}),
			revokeObjectUrl,
			createAnchor: vi.fn(() => anchor),
			schedule: (callback) => {
				cleanup = callback;
			}
		};
		return { value, anchor, revokeObjectUrl, getBlob: () => blob, runCleanup: () => cleanup?.() };
	};

	it('does not create an empty download or perform network or persistence work', () => {
		const local = dependencies();
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect(
			downloadCatalogReviewCsv(
				'Show',
				'show',
				[episode('Episode', '2026-01-02T12:00:00.000Z', [track({ confident: true })])],
				new Date('2026-08-21T00:00:00.000Z'),
				local.value
			)
		).toBe(false);
		expect(local.value.createObjectUrl).not.toHaveBeenCalled();
		expect(local.anchor.click).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('downloads the current local rows with a deterministic filename and revokes its URL', async () => {
		const local = dependencies();
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const episodes = [episode('Episode', '2026-01-02T12:00:00.000Z', [track()])];

		expect(
			downloadCatalogReviewCsv(
				'Show',
				'unsafe/show',
				episodes,
				new Date('2026-08-21T12:00:00.000Z'),
				local.value
			)
		).toBe(true);
		expect(local.anchor.download).toBe('unsafe-show-review-2026-08-21.csv');
		expect(local.anchor.click).toHaveBeenCalledOnce();
		expect(local.anchor.remove).toHaveBeenCalledOnce();
		expect(await local.getBlob()?.text()).toContain('"primary-review"');
		expect(fetchSpy).not.toHaveBeenCalled();
		local.runCleanup();
		expect(local.revokeObjectUrl).toHaveBeenCalledWith('blob:review');
		expect(catalogReviewCsvFilename('', new Date('2026-08-21T00:00:00.000Z'))).toBe(
			'nts-show-review-2026-08-21.csv'
		);
	});

	it('removes temporary resources when the browser download click fails', () => {
		const local = dependencies();
		local.anchor.click.mockImplementation(() => {
			throw new Error('download blocked');
		});

		expect(() =>
			downloadCatalogReviewCsv(
				'Show',
				'show',
				[episode('Episode', '2026-01-02T12:00:00.000Z', [track()])],
				new Date('2026-08-21T00:00:00.000Z'),
				local.value
			)
		).toThrow('download blocked');
		expect(local.anchor.remove).toHaveBeenCalledOnce();
		expect(local.revokeObjectUrl).toHaveBeenCalledWith('blob:review');
	});
});
