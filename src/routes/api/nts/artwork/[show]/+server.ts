import type { RequestHandler } from './$types';
import { getCachedNTSShowArtwork } from '$lib/utils/nts-artwork.server';
import { isValidNTSSlug } from '$lib/utils/nts';

export const GET: RequestHandler = async ({ params }) => {
	if (params.show.length > 200 || !isValidNTSSlug(params.show)) {
		return new Response(null, { status: 400 });
	}
	const cover = await getCachedNTSShowArtwork(params.show);
	if (!cover) return new Response(null, { status: 404 });
	// The global hosted-access hook requires the normal signed-in site session.
	// Redirect only to validated official NTS media hosts.
	return new Response(null, {
		status: 302,
		headers: { Location: cover, 'Cache-Control': 'private, max-age=21600' }
	});
};
