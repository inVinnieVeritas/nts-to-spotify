import { json, type RequestEvent } from '@sveltejs/kit';
import { _authorize } from '../playlist-authorization/+server';
import { CatalogueNotifications } from '$lib/utils/catalog-notifications.server';
export async function GET(event: RequestEvent) {
	try {
		const denied = _authorize(event);
		if (denied) return denied;
		return json(await new CatalogueNotifications().publicHistory(), {
			headers: { 'Cache-Control': 'no-store' }
		});
	} catch {
		return json({ error: 'notifications_unavailable' }, { status: 503 });
	}
}
export async function POST(event: RequestEvent) {
	try {
		const denied = _authorize(event);
		if (denied) return denied;
		const text = await event.request.text();
		if (text.length > 4096) return json({ error: 'invalid_request' }, { status: 400 });
		const b = JSON.parse(text);
		const service = new CatalogueNotifications();
		if (b.operation === 'subscribe') await service.subscribe(b.subscription, b.label);
		else if (b.operation === 'remove') await service.remove(b.id);
		else return json({ error: 'invalid_request' }, { status: 400 });
		return json({ saved: true });
	} catch {
		return json({ error: 'notifications_unavailable' }, { status: 503 });
	}
}
