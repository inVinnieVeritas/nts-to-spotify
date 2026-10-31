export type NotificationDeviceState = {
	status: 'registered' | 'unregistered' | 'blocked' | 'unsupported' | 'unknown';
	id: string | null;
};
export async function notificationDeviceState(
	permission: NotificationPermission,
	endpoint: string | null,
	devices: { id: string }[]
): Promise<NotificationDeviceState> {
	if (permission === 'denied') return { status: 'blocked', id: null };
	if (permission !== 'granted' || !endpoint) return { status: 'unregistered', id: null };
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
	const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
	return devices.some((device) => device.id === id)
		? { status: 'registered', id }
		: { status: 'unregistered', id: null };
}
// This worker never caches application pages, so its update can activate immediately.
export async function prepareNotificationWorker(): Promise<ServiceWorkerRegistration> {
	const registration = await navigator.serviceWorker.register('/notifications-worker.js', {
		scope: '/',
		updateViaCache: 'none'
	});
	const worker = registration.installing ?? registration.waiting ?? registration.active;
	if (!worker) throw new Error('Notification worker unavailable');
	if (worker.state !== 'activated') {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				worker.removeEventListener('statechange', check);
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				if (worker.state === 'activated') finish();
				else if (worker.state === 'redundant') finish(new Error('Notification worker failed'));
			};
			const timer = setTimeout(() => finish(new Error('Notification worker timed out')), 10000);
			worker.addEventListener('statechange', check);
			check();
		});
	}
	return registration;
}
