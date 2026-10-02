import { json, type RequestEvent } from '@sveltejs/kit';
import { getAccessToken } from '$lib/utils/auth.server';
import { REFRESH_TOKEN_KEY } from '$lib/constants';
import { hostedConfiguration, hasHostedSession } from '$lib/utils/hosted-access.server';
import { schedulesEnabled } from '$lib/utils/catalog-schedule-store.server';
import { PlaylistAuthorization } from '$lib/utils/playlist-authorization.server';

export function _authorize(event: RequestEvent) {
	const config = hostedConfiguration();
	if (!config || !schedulesEnabled())
		return json({ error: 'automation_disabled' }, { status: 404 });
	if (!hasHostedSession(event)) return json({ error: 'not_authorized' }, { status: 401 });
	if (
		event.request.method !== 'GET' &&
		(event.request.headers.get('origin') !== config.origin ||
			event.request.headers.get('content-type')?.split(';')[0] !== 'application/json')
	)
		return json({ error: 'invalid_origin' }, { status: 403 });
}
export async function GET(event: RequestEvent) {
	try {
		const denied = _authorize(event);
		if (denied) return denied;
		return json(
			{ connected: await new PlaylistAuthorization().connected() },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json({ error: 'authorization_unavailable' }, { status: 503 });
	}
}
export async function POST(event: RequestEvent) {
	try {
		const denied = _authorize(event);
		if (denied) return denied;
		const text = await event.request.text();
		if (text.length > 512) return json({ error: 'invalid_request' }, { status: 400 });
		const body = JSON.parse(text);
		const auth = new PlaylistAuthorization();
		if (body.operation === 'disconnect') await auth.disconnect();
		else if (body.operation === 'connect') {
			const access = await getAccessToken(event);
			const refresh = event.cookies.get(REFRESH_TOKEN_KEY);
			if (!access || !refresh) return json({ error: 'spotify_authentication' }, { status: 401 });
			await auth.connect(access, refresh, event.request.signal);
		} else return json({ error: 'invalid_request' }, { status: 400 });
		return json({ connected: body.operation === 'connect' });
	} catch {
		return json({ error: 'authorization_unavailable' }, { status: 503 });
	}
}
