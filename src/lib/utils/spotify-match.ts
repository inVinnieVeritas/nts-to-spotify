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

export const isConfidentSpotifyMatch = (track: BasicTrack, match: Match) => {
	if (normalizeSpotifyMatchTitle(track.title) !== normalizeSpotifyMatchTitle(match.title)) {
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
