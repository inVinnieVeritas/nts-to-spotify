import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';
import { listCloudCatalogues } from '$lib/utils/catalog-cloud.server';

export const GET: RequestHandler = async (event) => {
	try {
		if (!hostedConfiguration()) return json({ error: 'hosted_only' }, { status: 404 });
		if (!hasHostedSession(event)) return json({ error: 'not_authorized' }, { status: 401 });
		return json(
			{ catalogues: await listCloudCatalogues() },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json({ error: 'cloud_unavailable' }, { status: 503 });
	}
};
