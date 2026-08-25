import type { Match, URI } from '$lib/types';

export type PartMismatchWarningKind = 'missing-marker' | 'conflicting-marker';

export type PartMismatchWarning = {
	kind: PartMismatchWarningKind;
	reason: string;
};

export const PART_MISMATCH_WARNING_PREFIX = 'Possible part mismatch: ';

type MarkerCategory =
	'part' | 'movement' | 'act' | 'scene' | 'section' | 'medley' | 'excerpt' | 'compound';

type StructuralMarker = {
	category: MarkerCategory;
	value: number;
};

type TrackWithSelectedCandidate = {
	title: string;
	matches: Match[];
	selectedMatch: URI | null;
};

const CATEGORY_LABELS: Record<MarkerCategory, string> = {
	part: 'Part',
	movement: 'Movement',
	act: 'Act',
	scene: 'Scene',
	section: 'numbered section',
	medley: 'medley wording',
	excerpt: 'excerpt wording',
	compound: 'multiple works'
};

const CATEGORY_ORDER: MarkerCategory[] = [
	'part',
	'movement',
	'act',
	'scene',
	'section',
	'medley',
	'excerpt',
	'compound'
];

const normalizeTitle = (title: string) =>
	title
		.normalize('NFKC')
		.replace(/[‐‑‒–—―−]/g, '-')
		.replace(/[⁄∕]/g, '/')
		.replace(/\s+/gu, ' ')
		.trim()
		.toLocaleLowerCase('en-US');

const normalizeComparableText = (title: string) =>
	normalizeTitle(title)
		.replace(/\b(?:op(?:us)?|bwv|k|kv|catalog(?:ue)?|cat)\.?\s*[a-z]?\d+(?:[.-]\d+)*\b/giu, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();

const extractCompoundComponents = (title: string) => {
	const pieces = normalizeTitle(title).split(/\s+\/\s+/u);
	if (pieces.length < 2 || pieces.length > 10) return [];
	const components = pieces.map(normalizeComparableText);
	return components.every((component) => component.length > 0 && /\p{L}/u.test(component))
		? components
		: [];
};

const componentsAppearInOrder = (components: string[], title: string) => {
	if (components.length === 0) return false;
	const target = ` ${normalizeComparableText(title)} `;
	let offset = 0;
	for (const component of components) {
		const index = target.indexOf(` ${component} `, offset);
		if (index < 0) return false;
		offset = index + component.length + 1;
	}
	return true;
};

const romanToNumber = (value: string) => {
	const upper = value.toUpperCase();
	if (!/^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(upper)) {
		return undefined;
	}
	const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
	let total = 0;
	for (let index = 0; index < upper.length; index += 1) {
		const current = values[upper[index]];
		const next = values[upper[index + 1]] ?? 0;
		total += current < next ? -current : current;
	}
	return total || undefined;
};

const parseMarkerNumber = (value: string) => {
	if (/^\d{1,4}$/.test(value)) {
		const number = Number(value);
		return Number.isSafeInteger(number) && number > 0 ? number : undefined;
	}
	return romanToNumber(value);
};

const isStandaloneRomanTitle = (title: string) => {
	const wrappers = new Map([
		['(', ')'],
		['[', ']'],
		['{', '}'],
		['"', '"'],
		["'", "'"],
		['“', '”'],
		['‘', '’'],
		['«', '»'],
		['「', '」']
	]);
	let value = title.trim();
	while (value.length >= 2 && wrappers.get(value[0]) === value[value.length - 1]) {
		value = value.slice(1, -1).trim();
	}
	return romanToNumber(value) !== undefined;
};

const toRoman = (number: number) => {
	const numerals: Array<[number, string]> = [
		[1000, 'M'],
		[900, 'CM'],
		[500, 'D'],
		[400, 'CD'],
		[100, 'C'],
		[90, 'XC'],
		[50, 'L'],
		[40, 'XL'],
		[10, 'X'],
		[9, 'IX'],
		[5, 'V'],
		[4, 'IV'],
		[1, 'I']
	];
	let remaining = number;
	let result = '';
	for (const [value, numeral] of numerals) {
		while (remaining >= value) {
			result += numeral;
			remaining -= value;
		}
	}
	return result;
};

const extractStructure = (title: string) => {
	const normalized = normalizeTitle(title);
	if (isStandaloneRomanTitle(normalized)) return [];
	const markers: StructuralMarker[] = [];
	const explicitPattern =
		/\b(part|pt|movement|mvt|act|scene)\.?\s*(?:no\.?\s*)?(\d{1,4}|[ivxlcdm]+)\b/giu;
	for (const match of normalized.matchAll(explicitPattern)) {
		const value = parseMarkerNumber(match[2]);
		if (!value) continue;
		const category =
			match[1] === 'part' || match[1] === 'pt'
				? 'part'
				: match[1] === 'movement' || match[1] === 'mvt'
					? 'movement'
					: (match[1] as 'act' | 'scene');
		markers.push({ category, value });
		if (markers.length >= 8) break;
	}

	const sectionPattern = /(^|[,;:[\]-])\s*(\d{1,2}|[ivxlcdm]+)(?=\s*(?:[.):-]|$))/giu;
	for (const match of normalized.matchAll(sectionPattern)) {
		const rawValue = match[2];
		if (/^0\d/u.test(rawValue)) continue;
		const afterMarker = normalized.slice((match.index ?? 0) + match[0].length).trimStart();
		if (/^\d/u.test(rawValue) && afterMarker.startsWith('-')) continue;
		const value = parseMarkerNumber(rawValue);
		if (!value || value > 50) continue;
		markers.push({ category: 'section', value });
		if (markers.length >= 8) break;
	}

	if (/\bmedley\b/u.test(normalized)) markers.push({ category: 'medley', value: 1 });
	if (/\bexcerpts?\b/u.test(normalized)) markers.push({ category: 'excerpt', value: 1 });
	return markers.slice(0, 10);
};

const groupStructure = (markers: StructuralMarker[]) => {
	const grouped = new Map<MarkerCategory, number[]>();
	for (const marker of markers) {
		const values = grouped.get(marker.category) ?? [];
		values.push(marker.value);
		grouped.set(marker.category, values);
	}
	return grouped;
};

const valuesEqual = (left: number[] | undefined, right: number[] | undefined) =>
	left !== undefined &&
	right !== undefined &&
	left.length === right.length &&
	left.every((value, index) => value === right[index]);

const describeStructure = (markers: StructuralMarker[]) => {
	const descriptions = markers.slice(0, 3).map(({ category, value }) => {
		if (category === 'medley' || category === 'excerpt') return CATEGORY_LABELS[category];
		if (category === 'compound') return `${value} works separated by slashes`;
		return `${CATEGORY_LABELS[category]} ${toRoman(value)}`;
	});
	return descriptions.join(' and ');
};

export const detectPartMismatch = (
	ntsTitle: string,
	spotifyTitle: string
): PartMismatchWarning | null => {
	const ntsMarkers = extractStructure(ntsTitle);
	const spotifyMarkers = extractStructure(spotifyTitle);
	const ntsComponents = extractCompoundComponents(ntsTitle);
	const spotifyComponents = extractCompoundComponents(spotifyTitle);
	const ntsCompoundMatched = componentsAppearInOrder(ntsComponents, spotifyTitle);
	const spotifyCompoundMatched = componentsAppearInOrder(spotifyComponents, ntsTitle);
	const compoundConflict =
		ntsComponents.length > 0 &&
		spotifyComponents.length > 0 &&
		(!ntsCompoundMatched || !spotifyCompoundMatched);
	if (ntsComponents.length > 0 && !ntsCompoundMatched) {
		ntsMarkers.push({ category: 'compound', value: ntsComponents.length });
	}
	if (spotifyComponents.length > 0 && !spotifyCompoundMatched) {
		spotifyMarkers.push({ category: 'compound', value: spotifyComponents.length });
	}
	const ntsGroups = groupStructure(ntsMarkers);
	const spotifyGroups = groupStructure(spotifyMarkers);
	const categories = CATEGORY_ORDER.filter(
		(category) => ntsGroups.has(category) || spotifyGroups.has(category)
	);
	if (
		!compoundConflict &&
		categories.every((category) =>
			valuesEqual(ntsGroups.get(category), spotifyGroups.get(category))
		)
	) {
		return null;
	}

	const ntsDescription = describeStructure(ntsMarkers);
	const spotifyDescription = describeStructure(spotifyMarkers);
	const sharedCategories = categories.filter(
		(category) => ntsGroups.has(category) && spotifyGroups.has(category)
	);
	const conflictingSharedMarker = sharedCategories.some(
		(category) => !valuesEqual(ntsGroups.get(category), spotifyGroups.get(category))
	);
	const kind: PartMismatchWarningKind =
		compoundConflict ||
		conflictingSharedMarker ||
		(ntsMarkers.length > 0 && spotifyMarkers.length > 0 && sharedCategories.length === 0)
			? 'conflicting-marker'
			: 'missing-marker';

	if (!ntsDescription) {
		return {
			kind,
			reason: `Spotify suggestion specifies ${spotifyDescription}; NTS does not.`
		};
	}
	if (!spotifyDescription) {
		return { kind, reason: `NTS specifies ${ntsDescription}; Spotify suggestion does not.` };
	}
	return {
		kind,
		reason: `NTS specifies ${ntsDescription}; Spotify suggestion specifies ${spotifyDescription}.`
	};
};

export const getSelectedSpotifyCandidate = (track: TrackWithSelectedCandidate) =>
	track.matches.find(({ uri }) => uri === track.selectedMatch);

export const getTrackPartMismatchWarning = (track: TrackWithSelectedCandidate) => {
	if (track.matches.length === 0) return null;
	const selectedCandidate = getSelectedSpotifyCandidate(track);
	return selectedCandidate ? detectPartMismatch(track.title, selectedCandidate.title) : null;
};
