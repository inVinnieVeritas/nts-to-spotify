<script lang="ts">
	import { onMount } from 'svelte';
	import {
		notificationDeviceState,
		prepareNotificationWorker,
		type NotificationDeviceState
	} from '$lib/utils/catalog-notifications.client';
	let pendingRemoval: string | null = null;
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
			message = 'Device registered. You can now send a test notification.';
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
					'Test sent to the push service. Check notifications on this device; delivery may be delayed.';
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
		if (busy || checking || pendingRemoval !== id) return;
		busy = true;
		try {
			await save({ operation: 'remove', id });
			devices = devices.filter((device) => device.id !== id);
			pendingRemoval = null;
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
	<section class="settings-card notifications-card" aria-labelledby="notifications-heading">
		<div class="settings-heading">
			<h2 id="notifications-heading">Catalogue notifications</h2>
			<span
				class="status-badge"
				class:active={deviceState.status === 'registered'}
				class:warning={deviceState.status === 'blocked'}
			>
				{checking
					? 'Checking…'
					: deviceState.status === 'registered'
						? 'Enabled'
						: deviceState.status === 'blocked'
							? 'Blocked'
							: 'Not enabled'}
			</span>
		</div>
		<p class="settings-description">Get alerts when new episodes or matching results are ready.</p>
		{#if deviceState.status === 'registered'}
			<p class="settings-note">Notifications are enabled on this device.</p>
		{:else if deviceState.status === 'blocked'}
			<p class="settings-note">
				Allow notifications in this site's browser settings, then refresh this page.
			</p>
		{:else if deviceState.status === 'unsupported'}
			<p class="settings-note">This browser does not support notifications.</p>
		{:else if !checking && deviceState.status === 'unknown'}
			<p class="settings-note">Device status is unavailable. Refresh to check again.</p>
		{/if}
		<div class="settings-actions">
			{#if deviceState.status === 'registered'}
				<button
					type="button"
					class="control-button primary"
					disabled={busy || checking || !publicKey}
					on:click={testNotification}>Send test notification</button
				>
			{:else if deviceState.status === 'unregistered'}
				<button
					type="button"
					class="control-button primary"
					disabled={busy || checking || !publicKey}
					on:click={subscribe}>Enable on this device</button
				>
			{/if}
			<button type="button" class="control-button" disabled={busy || checking} on:click={load}
				>Refresh status</button
			>
		</div>
		{#if !publicKey}<p class="settings-feedback">
				Browser push has not been configured on the server.
			</p>{/if}
		{#if capacityRemaining === 0}<p class="settings-feedback" role="status">
				Notification history capacity reached. New alerts are paused.
			</p>{/if}
		{#if message}<p class="settings-feedback" role="status" aria-live="polite">{message}</p>{/if}
		<div class="notification-group">
			<h3>Registered devices <span class="count">{devices.length}</span></h3>
			<ul class="device-list">
				{#each devices as device (device.id)}
					<li class="device-row">
						<div class="device-info">
							<strong>{device.label}</strong>{#if device.id === deviceState.id}<span
									class="device-caption">This device</span
								>{/if}
						</div>
						{#if pendingRemoval !== device.id}
							<button
								type="button"
								class="control-button danger"
								aria-label={`Remove ${device.label}`}
								disabled={busy || checking}
								on:click={() => {
									pendingRemoval = device.id;
									message = '';
								}}>Remove</button
							>
						{:else}
							<div
								class="remove-confirmation"
								role="group"
								aria-label={`Confirm removal of ${device.label}`}
							>
								<p>Stop alerts to {device.label}?</p>
								<div class="confirmation-actions">
									<button
										type="button"
										class="control-button danger"
										disabled={busy || checking}
										on:click={() => remove(device.id)}
										>{busy ? 'Removing…' : 'Confirm removal'}</button
									>
									<button
										type="button"
										class="control-button"
										disabled={busy}
										on:click={() => (pendingRemoval = null)}>Cancel</button
									>
								</div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if devices.length === 0}<p class="settings-muted">No devices registered yet.</p>{/if}
		</div>
		<div class="notification-group">
			<h3>Recent activity</h3>
			{#if events.length === 0}
				<div class="empty-activity">
					<strong>No catalogue alerts yet</strong>
					<p>New episode and matching alerts will appear here. Test notifications are separate.</p>
				</div>
			{:else}
				<ul class="event-list">
					{#each events as event (event.id)}
						<li>
							<a href={`/shows/${encodeURIComponent(event.showAlias)}`}
								>{event.showAlias.replaceAll('-', ' ')}</a
							>
							<p>
								{event.kind === 'new-episodes'
									? 'New episode detected'
									: 'Matches ready for review'}
							</p>
							<time datetime={new Date(event.createdAt).toISOString()}
								>{new Date(event.createdAt).toLocaleString()}</time
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<details class="settings-details">
			<summary>About notifications</summary>
			<p>
				Free browser push, including Pixel Chrome. Delivery can be delayed. The last 100 catalogue
				alerts stay in this history independently of browser delivery. Removing a device stops its
				alerts and keeps the history.
			</p>
		</details>
	</section>
{/if}

<style lang="postcss">
	.notification-group {
		margin-top: 22px;
	}
	.notification-group h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		margin-bottom: 10px;
	}
	.count {
		color: #646b61;
		font-size: 12px;
		background: #f0f1ed;
		padding: 2px 7px;
		border-radius: 12px;
	}
	.device-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 0;
		border-top: 1px solid #e7e9e1;
	}
	.device-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 140px;
		overflow-wrap: anywhere;
	}
	.device-caption {
		font-size: 12px;
		color: #687163;
	}
	.remove-confirmation {
		flex: 1 1 100%;
		padding: 12px;
		border-radius: 8px;
		background: #fbf2ee;
	}
	.confirmation-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.empty-activity {
		padding: 14px;
		border: 1px dashed #d7dbd0;
		border-radius: 8px;
	}
	.empty-activity p {
		color: #646b61;
		margin-top: 4px;
	}
	.event-list li {
		padding: 12px 0;
		border-top: 1px solid #e7e9e1;
	}
	.event-list a {
		font-weight: 700;
	}
	time {
		color: #687163;
		font-size: 12px;
	}
</style>
