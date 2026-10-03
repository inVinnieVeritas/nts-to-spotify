import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import webpush, { type PushSubscription } from 'web-push';
import { ScheduleStore } from './catalog-schedule-store.server';
import { CloudProgressError } from './catalog-cloud.server';
import {
	encryptPlaylistAuthorization,
	decryptPlaylistAuthorization
} from './playlist-authorization.server';
import { isValidNTSSlug } from './nts';

const PURPOSE = 'nts-browser-push-v1';
export type CatalogueNotification = {
	id: string;
	showAlias: string;
	kind: 'new-episodes' | 'matches-ready';
	createdAt: number;
	delivered: string[];
};
type Device = { id: string; label: string; encrypted: string };
type History = { events: CatalogueNotification[]; devices: Device[]; seen: string[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const safeText = (v: unknown, max: number): v is string =>
	typeof v === 'string' &&
	v.length > 0 &&
	v.length <= max &&
	Array.from(v).every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127);
export function isPushSubscription(v: unknown): v is PushSubscription {
	if (!v || typeof v !== 'object') return false;
	const s = v as PushSubscription;
	try {
		const url = new URL(s.endpoint);
		return (
			safeText(s.endpoint, 2048) &&
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			!url.port &&
			['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname) &&
			url.pathname.length > 1 &&
			!!s.keys &&
			/^[A-Za-z0-9_-]{87,88}={0,2}$/.test(s.keys.p256dh) &&
			/^[A-Za-z0-9_-]{22,24}={0,2}$/.test(s.keys.auth)
		);
	} catch {
		return false;
	}
}
const isHistory = (v: unknown): v is History => {
	if (!v || typeof v !== 'object') return false;
	const h = v as History;
	return (
		Array.isArray(h.seen) &&
		h.seen.length <= 10000 &&
		h.seen.every(isHash) &&
		Array.isArray(h.events) &&
		h.events.length <= 100 &&
		h.events.every(
			(e) =>
				isHash(e.id) &&
				isValidNTSSlug(e.showAlias) &&
				['new-episodes', 'matches-ready'].includes(e.kind) &&
				Number.isSafeInteger(e.createdAt) &&
				e.createdAt >= 0 &&
				Array.isArray(e.delivered) &&
				e.delivered.length <= 10 &&
				e.delivered.every(isHash)
		) &&
		Array.isArray(h.devices) &&
		h.devices.length <= 10 &&
		h.devices.every((d) => isHash(d.id) && safeText(d.label, 60) && safeText(d.encrypted, 24000))
	);
};
export const notificationEventId = (
	kind: CatalogueNotification['kind'],
	show: string,
	episode: string
) => hash(JSON.stringify([kind, show, episode]));
export class CatalogueNotifications {
	constructor(
		private store = new ScheduleStore(),
		private send = webpush.sendNotification,
		private now = Date.now
	) {}
	private async change(change: (history: History) => void) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const stored = await this.store.getAutomation('notification-history', isHistory);
			const history = structuredClone(stored?.value ?? { events: [], devices: [], seen: [] });
			change(history);
			try {
				await this.store.putAutomation('notification-history', history, stored?.version ?? null);
				return history;
			} catch (cause) {
				if (!(cause instanceof CloudProgressError) || cause.kind !== 'conflict' || attempt === 3)
					throw cause;
			}
		}
		throw new Error('Notifications unavailable');
	}
	async publicHistory() {
		const h = await this.store.getAutomation('notification-history', isHistory);
		return {
			capacityRemaining: 10000 - (h?.value.seen.length ?? 0),
			events: (h?.value.events ?? []).map(({ id, showAlias, kind, createdAt }) => ({
				id,
				showAlias,
				kind,
				createdAt
			})),
			devices: (h?.value.devices ?? []).map(({ id, label }) => ({ id, label })),
			publicKey: /^[A-Za-z0-9_-]{87,88}$/.test(env.NTS_PUSH_PUBLIC_KEY ?? '')
				? env.NTS_PUSH_PUBLIC_KEY
				: null
		};
	}
	async subscribe(subscription: unknown, label: unknown) {
		if (!isPushSubscription(subscription) || !safeText(label, 60))
			throw new Error('Invalid push subscription');
		const id = hash(subscription.endpoint);
		await this.change((h) => {
			if (!h.devices.some((d) => d.id === id) && h.devices.length >= 10)
				throw new Error('Device limit reached');
			h.devices = h.devices.filter((d) => d.id !== id);
			h.devices.push({
				id,
				label,
				encrypted: encryptPlaylistAuthorization(
					JSON.stringify({
						endpoint: subscription.endpoint,
						keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
					}),
					PURPOSE
				)
			});
		});
	}
	async remove(id: unknown) {
		if (!isHash(id)) throw new Error('Invalid device');
		await this.change((h) => {
			h.devices = h.devices.filter((d) => d.id !== id);
		});
	}
	async publish(kind: CatalogueNotification['kind'], show: string, episodes: string[]) {
		if (!isValidNTSSlug(show) || episodes.length > 5000 || !episodes.every(isValidNTSSlug))
			throw new Error('Invalid notification');
		await this.change((h) => {
			for (const episode of episodes) {
				const id = notificationEventId(kind, show, episode);
				if (!h.seen.includes(id)) {
					if (h.seen.length >= 10000) throw new Error('Notification history capacity reached');
					h.seen.push(id);
					h.events.push({ id, showAlias: show, kind, createdAt: this.now(), delivered: [] });
				}
			}
			h.events = h.events.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
		});
	}
	async deliver(signal: AbortSignal) {
		if (!env.NTS_PUSH_PRIVATE_KEY || !env.NTS_PUSH_PUBLIC_KEY) return;
		const h = (await this.store.getAutomation('notification-history', isHistory))?.value;
		if (!h) return;
		let attempts = 0;
		for (const event of [...h.events].reverse())
			for (const device of h.devices) {
				if (signal.aborted || attempts >= 10) return;
				if (event.delivered.includes(device.id)) continue;
				// At-most-once dispatch claims survive job retries. Delivery is best effort;
				// a crash/network ambiguity may lose a push, never the durable history.
				let claimed = false;
				await this.change((current) => {
					claimed = false;
					const e = current.events.find((e) => e.id === event.id);
					if (
						!e ||
						!current.devices.some((d) => d.id === device.id) ||
						e.delivered.includes(device.id)
					)
						return;
					e.delivered.push(device.id);
					claimed = true;
				});
				if (!claimed) continue;
				attempts++;
				try {
					const subscription: unknown = JSON.parse(
						decryptPlaylistAuthorization(device.encrypted, PURPOSE)
					);
					if (!isPushSubscription(subscription)) throw new Error('Invalid device');
					await this.send(
						subscription,
						JSON.stringify({ id: event.id, showAlias: event.showAlias, kind: event.kind }),
						{
							timeout: 10000,
							TTL: 86400,
							urgency: 'normal',
							vapidDetails: {
								subject: 'https://nts2spotify.vincentvanderveken.com',
								publicKey: env.NTS_PUSH_PUBLIC_KEY!,
								privateKey: env.NTS_PUSH_PRIVATE_KEY!
							}
						}
					);
				} catch (cause) {
					const status =
						cause && typeof cause === 'object'
							? (cause as { statusCode?: unknown }).statusCode
							: undefined;
					if (status === 404 || status === 410) await this.remove(device.id);
					// Never log the web-push error: it includes the subscription endpoint.
				}
			}
	}
}
