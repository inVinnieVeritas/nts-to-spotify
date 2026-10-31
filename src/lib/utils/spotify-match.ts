import type { BasicTrack, Match } from '$lib/types';

const REMASTER_YEAR = String.raw`(?:1[89]\d{2}|20\d{2}|21\d{2})`;
const REMASTER_QUALIFIER = String.raw`(?:(?:${REMASTER_YEAR})\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+(?:version|${REMASTER_YEAR}))?`;
const TRAILING_REMASTER_PATTERNS = [
	new RegExp(String.raw`\s*\(\s*${REMASTER_QUALIFIER}\s*\)\s*$`, 'iu'),
	new RegExp(String.raw`\s*\[\s*${REMASTER_QUALIFIER}\s*\]\s*$`, 'iu'),
	new RegExp(String.raw`\s*[\-\u2010-\u2015\u2212:]\s*${REMASTER_QUALIFIER}\s*$`, 'iu')
];

const normalizeMatchText = (value: string) =>
	value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/&/g, 'and')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

export const stripTrailingRemasterQualifier = (value: string) => {
	const normalized = value.normalize('NFKC');
	for (const pattern of TRAILING_REMASTER_PATTERNS) {
		const stripped = normalized.replace(pattern, '').trim();
		if (stripped !== normalized.trim() && normalizeMatchText(stripped)) return stripped;
	}
	return normalized;
};

export const normalizeSpotifyMatchTitle = (value: string) =>
	normalizeMatchText(stripTrailingRemasterQualifier(value));

const isRemasterTitle = (value: string) =>
	stripTrailingRemasterQualifier(value) !== value.normalize('NFKC');

const titlesDifferOnlyByLeadingThe = (left: string, right: string) => {
	const withoutArticle = (value: string) => value.replace(/^the /, '');
	const root = withoutArticle(left);
	return root === withoutArticle(right) && root.split(' ').length >= 2;
};

export const isConfidentSpotifyMatch = (track: BasicTrack, match: Match) => {
	const requestedTitle = normalizeSpotifyMatchTitle(track.title);
	const candidateTitle = normalizeSpotifyMatchTitle(match.title);
	if (
		requestedTitle !== candidateTitle &&
		!(
			(isRemasterTitle(track.title) || isRemasterTitle(match.title)) &&
			titlesDifferOnlyByLeadingThe(requestedTitle, candidateTitle)
		)
	) {
		return false;
	}
	const requestedArtist = normalizeMatchText(track.artist);
	return match.artist
		.split(',')
		.map(normalizeMatchText)
		.some(
			(artist) =>
				artist === requestedArtist ||
				(requestedArtist.length >= 5 &&
					(artist.includes(requestedArtist) || requestedArtist.includes(artist)))
		);
};

// Keep Spotify's relative order within each group, but never put a different
// edition ahead of a title/artist-equivalent candidate from the same search.
export const prioritizeConfidentSpotifyMatches = (track: BasicTrack, matches: Match[]) => {
	const confident: Match[] = [];
	const review: Match[] = [];
	for (const match of matches) {
		(isConfidentSpotifyMatch(track, match) ? confident : review).push(match);
	}
	return [...confident, ...review];
};
