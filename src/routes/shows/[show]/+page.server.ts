import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getNTSShowCatalog } from '$lib/utils/nts.server';
import { isValidNTSSlug, showParamToNtsUrl } from '$lib/utils/nts';

export const load: PageServerLoad = async ({ params, fetch }) => {
	if (!isValidNTSSlug(params.show)) throw error(400, 'Invalid NTS show');

	try {
		return await getNTSShowCatalog(params.show, fetch as typeof globalThis.fetch);
	} catch {
		console.error('Catalogue load failed', 'nts_catalogue_unavailable');
		throw error(502, `Unable to load show from ${showParamToNtsUrl(params.show)}`);
	}
};
