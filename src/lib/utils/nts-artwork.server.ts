import { isValidNTSSlug } from './nts';
import { getNTSShowArtwork } from './nts.server';
import type { Fetcher } from './request';

const ARTWORK_TTL_MS = 6 * 60 * 60 * 1_000;
const UNAVAILABLE_TTL_MS = 60_000;
const MAX_ENTRIES = 200;

// Old backups and cloud summaries may have no cover. This read-only lookup
// repairs their presentation without writing catalogue progress or starting scans.
export const createNTSArtworkLoader = (request: Fetcher = fetch, now = Date.now) => {
	const cache = new Map<string, { expiresAt: number; result: Promise<string | undefined> }>();

	return (showAlias: string): Promise<string | undefined> => {
		if (showAlias.length > 200 || !isValidNTSSlug(showAlias)) return Promise.resolve(undefined);
		const cached = cache.get(showAlias);
		if (cached && cached.expiresAt > now()) return cached.result;
		cache.delete(showAlias);
		while (cache.size >= MAX_ENTRIES) {
			cache.delete(cache.keys().next().value!);
		}
		const entry = {
			expiresAt: Infinity,
			result: Promise.resolve<string | undefined>(undefined)
		};
		entry.result = getNTSShowArtwork(showAlias, request)
			.catch(() => undefined)
			.then((cover) => {
				entry.expiresAt = now() + (cover ? ARTWORK_TTL_MS : UNAVAILABLE_TTL_MS);
				return cover || undefined;
			});
		cache.set(showAlias, entry);
		return entry.result;
	};
};

export const getCachedNTSShowArtwork = createNTSArtworkLoader();
