import { json, type RequestEvent } from '@sveltejs/kit';
import { _authorize } from '../../playlist-authorization/+server';
import { isValidNTSSlug } from '$lib/utils/nts';
import {
	AutomaticPlaylistService,
	AutomaticPlaylistConfigurationError,
	publicAutomaticPlaylistState
} from '$lib/utils/catalog-playlist-automation.server';
import { BackgroundAuthorizationError } from '$lib/utils/playlist-authorization.server';
import { CloudProgressError } from '$lib/utils/catalog-cloud.server';

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
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return json({ error: 'invalid_request' }, { status: 400 });
		}
		if (!body || typeof body.enabled !== 'boolean' || typeof body.confirmAppCreated !== 'boolean')
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
	} catch (cause) {
		if (cause instanceof AutomaticPlaylistConfigurationError)
			return json(
				{ error: cause.code, ...(cause.retryUntil ? { retryUntil: cause.retryUntil } : {}) },
				{ status: cause.status }
			);
		if (cause instanceof BackgroundAuthorizationError)
			return json({ error: 'spotify_authentication' }, { status: 401 });
		if (cause instanceof CloudProgressError)
			return json(
				{
					error:
						cause.kind === 'conflict' ? 'cloud_progress_conflict' : 'cloud_progress_unavailable'
				},
				{ status: cause.kind === 'conflict' ? 409 : 503 }
			);
		return json({ error: 'automation_unavailable' }, { status: 503 });
	}
}
