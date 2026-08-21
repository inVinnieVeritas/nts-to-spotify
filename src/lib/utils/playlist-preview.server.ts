import { createHash } from 'node:crypto';

const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const canonicalSpotifyTrackUri = (value: unknown): string | null =>
	typeof value === 'string' && SPOTIFY_TRACK_URI.test(value) ? value : null;

export const spotifyPlaylistItemTrackUri = (value: unknown): string | null => {
	if (!isRecord(value) || value.is_local === true) return null;
	const candidate = isRecord(value.item) ? value.item : isRecord(value.track) ? value.track : null;
	if (!candidate || candidate.type !== 'track' || candidate.is_local === true) return null;
	return canonicalSpotifyTrackUri(candidate.uri);
};

export type SpotifyPlaylistState = {
	playlistId: string;
	snapshotId: string;
	name: string;
	description: string;
	public: boolean;
	items: (string | null)[];
};

export type SpotifyPlaylistTarget = {
	name: string;
	description: string;
	public: boolean;
	tracks: string[];
};

export type SpotifyPlaylistPreview = {
	addedCount: number;
	removedCount: number;
	retainedCount: number;
	orderChanged: boolean;
	titleChanged: boolean;
	descriptionChanged: boolean;
	visibilityChanged: boolean;
	synchronized: boolean;
};

const countUris = (uris: readonly (string | null)[]) => {
	const counts = new Map<string, number>();
	for (const uri of uris) {
		if (uri !== null) counts.set(uri, (counts.get(uri) ?? 0) + 1);
	}
	return counts;
};

const retainedSequence = (
	uris: readonly (string | null)[],
	sharedCounts: ReadonlyMap<string, number>
) => {
	const remaining = new Map(sharedCounts);
	const retained: string[] = [];
	for (const uri of uris) {
		if (uri === null) continue;
		const count = remaining.get(uri) ?? 0;
		if (count === 0) continue;
		retained.push(uri);
		remaining.set(uri, count - 1);
	}
	return retained;
};

const arraysEqual = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length && left.every((value, index) => value === right[index]);

export const compareSpotifyPlaylist = (
	current: SpotifyPlaylistState,
	target: SpotifyPlaylistTarget
): SpotifyPlaylistPreview => {
	const currentCounts = countUris(current.items);
	const targetCounts = countUris(target.tracks);
	const sharedCounts = new Map<string, number>();
	let retainedCount = 0;
	for (const [uri, targetCount] of targetCounts) {
		const shared = Math.min(targetCount, currentCounts.get(uri) ?? 0);
		if (shared > 0) {
			sharedCounts.set(uri, shared);
			retainedCount += shared;
		}
	}
	const addedCount = target.tracks.length - retainedCount;
	const removedCount = current.items.length - retainedCount;
	const orderChanged = !arraysEqual(
		retainedSequence(current.items, sharedCounts),
		retainedSequence(target.tracks, sharedCounts)
	);
	const titleChanged = current.name !== target.name;
	const descriptionChanged = current.description !== target.description;
	const visibilityChanged = current.public !== target.public;

	return {
		addedCount,
		removedCount,
		retainedCount,
		orderChanged,
		titleChanged,
		descriptionChanged,
		visibilityChanged,
		synchronized:
			addedCount === 0 &&
			removedCount === 0 &&
			!orderChanged &&
			!titleChanged &&
			!descriptionChanged &&
			!visibilityChanged
	};
};

export const fingerprintSpotifyPlaylist = (state: SpotifyPlaylistState) =>
	createHash('sha256')
		.update(
			JSON.stringify([
				state.playlistId,
				state.snapshotId,
				state.name,
				state.description,
				state.public,
				state.items
			])
		)
		.digest('hex');

export const fingerprintSpotifyPlaylistPreview = (
	state: SpotifyPlaylistState,
	target: SpotifyPlaylistTarget
) =>
	createHash('sha256')
		.update(
			JSON.stringify([
				fingerprintSpotifyPlaylist(state),
				target.name,
				target.description,
				target.public,
				target.tracks
			])
		)
		.digest('hex');

export const isSpotifyPlaylistFingerprint = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
