/* Notifications only: no fetch interception, offline page cache, or Spotify/NTS calls. */
let delivery = Promise.resolve();
self.addEventListener('push', (event) => {
	delivery = delivery
		.catch(() => {})
		.then(async () => {
			let data;
			try {
				data = event.data.json();
			} catch {
				return;
			}
			if (
				!data ||
				!/^[a-f0-9]{64}$/.test(data.id) ||
				!/^[a-z0-9-]{1,200}$/.test(data.showAlias) ||
				!['new-episodes', 'matches-ready'].includes(data.kind)
			)
				return;
			const cache = await caches.open('nts-notification-dedup-v1');
			const key = new Request(new URL('/notification-id/' + data.id, self.location.origin));
			if (await cache.match(key)) return;
			await self.registration.showNotification('NTS to Spotify', {
				body:
					data.kind === 'new-episodes'
						? 'New episodes detected. Open your catalogue for details.'
						: 'Matching results are ready. Review uncertain tracks in your catalogue.',
				tag: data.id,
				renotify: false,
				data: { showAlias: data.showAlias }
			});
			await cache.put(key, new Response('seen'));
			const keys = await cache.keys();
			for (const old of keys.slice(0, Math.max(0, keys.length - 200))) await cache.delete(old);
		});
	event.waitUntil(delivery);
});
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const alias = event.notification.data?.showAlias;
	if (typeof alias !== 'string' || !/^[a-z0-9-]{1,200}$/.test(alias)) return;
	event.waitUntil(clients.openWindow('/shows/' + encodeURIComponent(alias)));
});
