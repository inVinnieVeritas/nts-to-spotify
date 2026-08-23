import { describe, expect, it, vi } from 'vitest';
import type { Match } from '$lib/types';
import {
	PART_MISMATCH_WARNING_PREFIX,
	detectPartMismatch,
	getTrackPartMismatchWarning
} from './part-mismatch';

const warning = (ntsTitle: string, spotifyTitle: string) =>
	detectPartMismatch(ntsTitle, spotifyTitle);

describe('multi-part title mismatch detection', () => {
	it.each([
		['Work Part 1', 'Work Part I'],
		['Work, Pt. 2', 'Work Part II'],
		['Suite Movement 4', 'Suite Mvt. IV'],
		['Opera Act II, Scene 3', 'Opera Act 2 Scene III'],
		['Symphony: Ⅱ. Andante', 'Symphony - II. Andante'],
		['Work—Part Ⅱ', 'work - pt. 2']
	])('treats equivalent structural markers alike: %s / %s', (nts, spotify) => {
		expect(warning(nts, spotify)).toBeNull();
	});

	it('detects a missing part marker with a fixed sanitized reason', () => {
		expect(warning('Ascension, Part II', 'Ascension')).toEqual({
			kind: 'missing-marker',
			reason: 'NTS specifies Part II; Spotify suggestion does not.'
		});
	});

	it.each([
		['Symphony No. 5: II. Andante', 'Symphony No. 5: III. Allegro', 'numbered section'],
		['Suite Movement II', 'Suite Movement III', 'Movement'],
		['Opera Act II Scene I', 'Opera Act III Scene I', 'Act']
	])('detects conflicting markers: %s / %s', (nts, spotify, label) => {
		const result = warning(nts, spotify);
		expect(result?.kind).toBe('conflicting-marker');
		expect(result?.reason).toContain(label);
	});

	it.each([
		['Songs: Alpha / Beta', 'Songs: Alpha', 'works separated by slashes'],
		['Song Medley', 'Song', 'medley wording'],
		['Work (Excerpt)', 'Work', 'excerpt wording']
	])('detects compound or excerpt structure: %s / %s', (nts, spotify, label) => {
		const result = warning(nts, spotify);
		expect(result?.kind).toBe('missing-marker');
		expect(result?.reason).toContain(label);
	});

	it.each([
		['Ghost Town', '12 Kyle Gann - 04 - Ghost Town'],
		['Ghost Town', '01 - Ghost Town'],
		['Ghost Town', 'Track 04 Ghost Town'],
		['Ghost Town', 'CD1 04 Ghost Town'],
		['Lionel Marchetti - Un', 'Untitled (4)']
	])(
		'ignores embedded track-number metadata and bare parenthetical numbers: %s / %s',
		(nts, spotify) => {
			expect(warning(nts, spotify)).toBeNull();
		}
	);

	it('keeps explicitly labelled and genuine punctuation markers', () => {
		expect(warning('Work', 'Work Pt. 4')?.kind).toBe('missing-marker');
		expect(warning('Symphony: II. Allegro', 'Symphony: IV. Allegro')?.kind).toBe(
			'conflicting-marker'
		);
	});

	it.each(['I', 'II', 'IV', 'V', 'X', '  V  ', '(V)', '[IV]', '“II”', "'X'"])(
		'does not treat a standalone Roman numeral as a numbered section: %s',
		(title) => {
			expect(warning(title, 'Vive La Monnaie')).toBeNull();
		}
	);

	it.each([
		['Symphony: IV. Allegro', 'Symphony: V. Allegro'],
		['Work - II. Andante', 'Work - III. Andante'],
		['Part V', 'Part IV'],
		['Movement IV', 'Movement V'],
		['Act II', 'Act III'],
		['Scene III', 'Scene II']
	])('retains structural Roman marker detection: %s / %s', (nts, spotify) => {
		expect(warning(nts, spotify)?.kind).toBe('conflicting-marker');
	});

	it('matches meaningful slash components across alternative separators', () => {
		expect(
			warning('Inner Time / Outer Time, Op.42', 'Inner Time, Op. 42.2 - Outer Time, Op. 42')
		).toBeNull();
		expect(warning('Inner Time / Outer Time, Op.42', 'Inner Time, Op. 42')).toEqual({
			kind: 'missing-marker',
			reason: 'NTS specifies 2 works separated by slashes; Spotify suggestion does not.'
		});
		expect(warning('Inner Time / Outer Time', 'Inner Time / Other Time')?.kind).toBe(
			'conflicting-marker'
		);
		expect(warning('Archive 2020 / 2021', 'Archive 2020')).toBeNull();
	});

	it('includes visible spacing after the rendered warning label', () => {
		expect(
			`${PART_MISMATCH_WARNING_PREFIX}Spotify suggestion specifies Part IV; NTS does not.`
		).toBe('Possible part mismatch: Spotify suggestion specifies Part IV; NTS does not.');
	});

	it.each([
		['Live in 2013', 'Live in 2014'],
		['Symphony No. 5, Op. 67', 'Symphony No. 6, Op. 68'],
		['1999', '2000'],
		['Studio 54', 'Studio 55'],
		['Track 2 Remastered 2020', 'Track 3 Remastered 2021'],
		['AC/DC', 'AC DC']
	])(
		'does not infer structural markers from ordinary numbers or catalogue data: %s',
		(nts, spotify) => {
			expect(warning(nts, spotify)).toBeNull();
		}
	);

	it('uses only the currently selected candidate and leaves the track unchanged', () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const candidates: Match[] = [
			{
				uri: 'spotify:track:first',
				artist: 'Artist',
				title: 'Work Part II',
				href: 'https://open.spotify.com/track/first'
			},
			{
				uri: 'spotify:track:second',
				artist: 'Artist',
				title: 'Work Part III',
				href: 'https://open.spotify.com/track/second'
			}
		];
		const track = {
			title: 'Work Part II',
			matches: candidates,
			selectedMatch: candidates[0].uri,
			checked: true
		};
		const before = structuredClone(track);

		expect(getTrackPartMismatchWarning(track)).toBeNull();
		track.selectedMatch = candidates[1].uri;
		expect(getTrackPartMismatchWarning(track)?.kind).toBe('conflicting-marker');
		expect(track.checked).toBe(true);
		expect({ ...track, selectedMatch: before.selectedMatch }).toEqual(before);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('does not warn without candidates or a valid selected candidate', () => {
		expect(
			getTrackPartMismatchWarning({ title: 'Work Part II', matches: [], selectedMatch: null })
		).toBeNull();
		expect(
			getTrackPartMismatchWarning({
				title: 'Work Part II',
				matches: [],
				selectedMatch: 'spotify:track:missing'
			})
		).toBeNull();
	});
});
