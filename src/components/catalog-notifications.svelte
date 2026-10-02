<script lang="ts">
	import { onMount } from 'svelte';
	import Button from './button.svelte';
	let visible = false;
	let busy = false;
	let message = '';
	let publicKey: string | null = null;
	let capacityRemaining = 10000;
	let events: { id: string; showAlias: string; kind: string; createdAt: number }[] = [];
	let devices: { id: string; label: string }[] = [];
	async function load() {
		if (location.origin !== 'https://nts2spotify.vincentvanderveken.com') return;
		try {
			const response = await fetch('/api/catalog-notifications', { cache: 'no-store' });
			if (response.status === 404 || response.status === 401) return;
			if (!response.ok) throw new Error();
			const body = await response.json();
			if (!Array.isArray(body.events) || !Array.isArray(body.devices)) throw new Error();
			events = body.events;
			devices = body.devices;
			publicKey = body.publicKey;
			capacityRemaining = Number.isSafeInteger(body.capacityRemaining) ? body.capacityRemaining : 0;
			visible = true;
		} catch {
			message = 'Could not load notification history.';
		}
	}
	async function save(body: unknown) {
		const response = await fetch('/api/catalog-notifications', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) throw new Error();
	}
	async function subscribe() {
		if (busy || !publicKey) return;
		busy = true;
		message = '';
		try {
			if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error();
			if ((await Notification.requestPermission()) !== 'granted') {
				message = 'Notifications were not allowed. You can still use the history below.';
				return;
			}
			const label = prompt(
				'Name this notification device (for example Pixel Chrome):',
				'Chrome device'
			);
			if (!label) return;
			await navigator.serviceWorker.register('/notifications-worker.js', { scope: '/' });
			const registration = await navigator.serviceWorker.ready;
			const key = Uint8Array.from(
				atob(
					publicKey.replace(/-/g, '+').replace(/_/g, '/') +
						'='.repeat((4 - (publicKey.length % 4)) % 4)
				),
				(c) => c.charCodeAt(0)
			);
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: key
				}));
			await save({ operation: 'subscribe', label, subscription: subscription.toJSON() });
			await load();
			message =
				'This device is registered. Push is best effort; history remains available even when browser delivery is delayed.';
		} catch {
			message =
				'Could not enable browser notifications. Check permission and server push configuration.';
		} finally {
			busy = false;
		}
	}
	async function remove(id: string) {
		if (busy || !confirm('Stop notifications to this device? Notification history will remain.'))
			return;
		busy = true;
		try {
			await save({ operation: 'remove', id });
			await load();
			message = 'Device removed.';
		} catch {
			message = 'Could not remove this device. Try again.';
		} finally {
			busy = false;
		}
	}
	onMount(() => void load());
</script>

{#if visible}
	<section class="cloud-progress font-small-beast" aria-label="Catalogue notifications">
		<h2>Catalogue notifications</h2>
		<p>
			Browser push works on registered devices, including Pixel Chrome. No email or paid
			notification service. The last 100 events are kept here independently of delivery.
		</p>
		<Button size="sm" variant="outline" disabled={busy || !publicKey} on:click={subscribe}
			>Enable notifications on this device</Button
		>
		<Button size="sm" variant="outline" disabled={busy} on:click={load}
			>Refresh notification history</Button
		>
		{#if !publicKey}<p>Browser push has not been configured on the server.</p>{/if}
		{#if capacityRemaining === 0}<p role="status">
				Notification event capacity reached. New alerts are paused; contact the installation
				operator before changing history.
			</p>{/if}
		<ul>
			{#each devices as device (device.id)}<li>
					{device.label}
					<button type="button" disabled={busy} on:click={() => remove(device.id)}
						>Remove device</button
					>
				</li>{/each}
		</ul>
		<ul>
			{#each events as event (event.id)}<li>
					<a href={`/shows/${encodeURIComponent(event.showAlias)}`}
						>{event.showAlias.replaceAll('-', ' ')}</a
					>: {event.kind === 'new-episodes' ? 'New episode detected' : 'Matches ready for review'} · {new Date(
						event.createdAt
					).toLocaleString()}
				</li>{/each}
		</ul>
		{#if events.length === 0}<p>No recorded events yet.</p>{/if}
		<p role="status" aria-live="polite">{message}</p>
	</section>
{/if}
