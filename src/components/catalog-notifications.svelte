<script lang="ts">
	import { onMount } from 'svelte';
	import {
		notificationDeviceState,
		prepareNotificationWorker,
		type NotificationDeviceState
	} from '$lib/utils/catalog-notifications.client';
	import Button from './button.svelte';
	let deviceState: NotificationDeviceState = { status: 'unknown', id: null };
	let checking = true;
	let testRetryUntil = 0;
	let visible = false;
	let busy = false;
	let message = '';
	let publicKey: string | null = null;
	let capacityRemaining = 10000;
	let events: { id: string; showAlias: string; kind: string; createdAt: number }[] = [];
	let devices: { id: string; label: string }[] = [];
	async function checkDevice() {
		deviceState = { status: 'unknown', id: null };
		if (
			!('serviceWorker' in navigator) ||
			!('PushManager' in window) ||
			!('Notification' in window)
		) {
			deviceState = { status: 'unsupported', id: null };
			return;
		}
		// Page loads inspect permission; only the explicit enable button requests it.
		let endpoint: string | null = null;
		if (Notification.permission === 'granted') {
			const registration = await navigator.serviceWorker.getRegistration('/');
			endpoint = (await registration?.pushManager.getSubscription())?.endpoint ?? null;
		}
		deviceState = await notificationDeviceState(Notification.permission, endpoint, devices);
	}
	async function load() {
		if (checking && visible) return;
		checking = true;
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
			await checkDevice();
		} catch {
			deviceState = { status: 'unknown', id: null };
			message = 'Could not check notification history or this device. Try refreshing.';
		} finally {
			checking = false;
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
		if (busy || checking || !publicKey || deviceState.status !== 'unregistered') return;
		busy = true;
		message = '';
		try {
			if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error();
			if ((await Notification.requestPermission()) !== 'granted') {
				await checkDevice();
				message = 'Notifications were not allowed. You can still use the history below.';
				return;
			}
			const label = prompt(
				'Name this notification device (for example Pixel Chrome):',
				'Chrome device'
			);
			if (!label) return;
			const registration = await prepareNotificationWorker();
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
	async function testNotification() {
		if (busy || checking || deviceState.status !== 'registered' || !publicKey) return;
		if (testRetryUntil > Date.now()) {
			message = `Wait ${Math.ceil((testRetryUntil - Date.now()) / 1000)} seconds before another test.`;
			return;
		}
		busy = true;
		message = 'Sending test notification…';
		try {
			await prepareNotificationWorker();
			await checkDevice();
			if (!deviceState.id) {
				message = 'This device is no longer registered. Enable notifications again.';
				return;
			}
			const response = await fetch('/api/catalog-notifications', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'test', id: deviceState.id })
			});
			if (!response.ok) throw new Error();
			const result = await response.json();
			if (result.status === 'accepted') {
				testRetryUntil = Date.now() + 30000;
				message =
					'Test accepted by the push service. Check notifications on this device; delivery may be delayed. The test does not add a catalogue event.';
			} else if (
				result.status === 'rate-limited' &&
				Number.isSafeInteger(result.retryAfterSeconds) &&
				result.retryAfterSeconds > 0 &&
				result.retryAfterSeconds <= 30
			) {
				testRetryUntil = Date.now() + result.retryAfterSeconds * 1000;
				message = `Wait ${result.retryAfterSeconds} seconds before another test.`;
			} else if (result.status === 'expired' || result.status === 'not-registered') {
				if (result.status === 'expired') {
					const registration = await navigator.serviceWorker.getRegistration('/');
					await (await registration?.pushManager.getSubscription())?.unsubscribe();
				}
				await load();
				message =
					'This device registration has expired or was removed. Enable notifications again.';
			} else {
				message =
					'Test could not be confirmed. Check browser permissions and try again in 30 seconds.';
			}
		} catch {
			message = 'Test could not be confirmed. Refresh this page and try again in 30 seconds.';
		} finally {
			busy = false;
		}
	}

	async function remove(id: string) {
		if (
			busy ||
			checking ||
			!confirm('Stop notifications to this device? Notification history will remain.')
		)
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
		<Button
			size="sm"
			variant="outline"
			disabled={busy ||
				checking ||
				!publicKey ||
				['registered', 'blocked', 'unsupported', 'unknown'].includes(deviceState.status)}
			on:click={subscribe}
			>{checking
				? 'Checking this device…'
				: deviceState.status === 'registered'
					? 'Notifications enabled on this device'
					: deviceState.status === 'blocked'
						? 'Notifications blocked on this device'
						: deviceState.status === 'unsupported'
							? 'Browser notifications unavailable'
							: deviceState.status === 'unknown'
								? 'Device status unavailable'
								: 'Enable notifications on this device'}</Button
		>
		<Button size="sm" variant="outline" disabled={busy || checking} on:click={load}
			>Refresh notification history</Button
		>
		{#if deviceState.status === 'registered'}
			<Button
				size="sm"
				variant="outline"
				disabled={busy || checking || !publicKey}
				on:click={testNotification}>Send test notification</Button
			>
			<p>Notifications are enabled on this device. Use the test button to check delivery.</p>
		{:else if deviceState.status === 'blocked'}
			<p>Allow notifications in this site's browser settings, then refresh this page.</p>
		{/if}
		{#if !publicKey}<p>Browser push has not been configured on the server.</p>{/if}
		{#if capacityRemaining === 0}<p role="status">
				Notification event capacity reached. New alerts are paused; contact the installation
				operator before changing history.
			</p>{/if}
		<ul>
			{#each devices as device (device.id)}<li>
					{device.label}
					<button type="button" disabled={busy || checking} on:click={() => remove(device.id)}
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
