import { json, type RequestEvent } from '@sveltejs/kit';
import { _authorize } from '../../playlist-authorization/+server';
import { isValidNTSSlug } from '$lib/utils/nts';
import {
	AutomaticPlaylistService,
	publicAutomaticPlaylistState
} from '$lib/utils/catalog-playlist-automation.server';

function authorize(event: RequestEvent) {
	return (
		_authorize(event) ??
		(!isValidNTSSlug(event.params.show ?? '')
			? json({ error: 'invalid_show' }, { status: 400 })
			: undefined)
	);
}
export async function GET(event: RequestEvent) {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		const stored = await new AutomaticPlaylistService().get(event.params.show!);
		return json(
			{ automation: stored ? publicAutomaticPlaylistState(stored.value) : null },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json({ error: 'automation_unavailable' }, { status: 503 });
	}
}
export async function PUT(event: RequestEvent) {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		const text = await event.request.text();
		if (text.length > 512) return json({ error: 'invalid_request' }, { status: 400 });
		const body = JSON.parse(text);
		if (typeof body.enabled !== 'boolean' || typeof body.confirmAppCreated !== 'boolean')
			return json({ error: 'invalid_request' }, { status: 400 });
		const service = new AutomaticPlaylistService();
		await service.configure(
			event.params.show!,
			body.enabled,
			body.confirmAppCreated,
			AbortSignal.any([event.request.signal, AbortSignal.timeout(3 * 60_000)])
		);
		const stored = await service.get(event.params.show!);
		return json({ automation: stored ? publicAutomaticPlaylistState(stored.value) : null });
	} catch {
		return json({ error: 'automation_requires_review' }, { status: 409 });
	}
}
