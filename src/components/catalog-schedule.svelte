<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isCatalogSchedule,
		isScheduleFrequency,
		type CatalogSchedule,
		type ScheduleFrequency
	} from '$lib/utils/catalog-schedule';
	export let showAlias: string;
	export let cloudConnected = false;
	export let scanning = false;
	let visible = false;
	let schedule: CatalogSchedule | null = null;
	let version: string | null = null;
	let frequency: ScheduleFrequency = 'weekly';
	let busy = false;
	let message = '';
	let loadedShow = '';
	let mounted = false;
	const date = (timestamp: number) => new Date(timestamp).toLocaleString();
	const statuses = {
		waiting: 'More episodes will be scanned on a later run.',
		complete: 'All discovered episodes are scanned.',
		cooldown: 'Waiting for the Spotify cooldown to end.',
		busy: 'A manual or background scan was active. This schedule will retry later.',
		conflict:
			'Progress changed during the run. Saved reviews were preserved; this schedule will retry later.',
		unavailable: 'The last run stopped because a service was unavailable. It will retry later.',
		'missing-progress':
			'No cloud progress was found. Save this catalogue to cloud before continuing.'
	};
	async function load(show: string) {
		loadedShow = show;
		message = '';
		visible = false;
		schedule = null;
		version = null;
		// Schedule controls belong to the hosted site; the local bridge only transfers progress.
		if (location.origin !== 'https://nts2spotify.vincentvanderveken.com') return;
		try {
			const response = await fetch(`/api/catalog-schedules/${encodeURIComponent(show)}`, {
				cache: 'no-store'
			});
			if (show !== showAlias) return;
			if (response.status === 404 || response.status === 401) return;
			visible = true;
			if (!response.ok) throw new Error();
			const body = await response.json();
			if (body.schedule !== null && !isCatalogSchedule(body.schedule)) throw new Error();
			schedule = body.schedule;
			version = body.version;
			frequency = schedule?.frequency ?? 'weekly';
		} catch {
			if (show === showAlias) {
				visible = true;
				message = 'Could not load schedule settings. Try refreshing their status.';
			}
		}
	}
	async function save(enabled: boolean) {
		if (busy || scanning) return;
		busy = true;
		message = '';
		const show = showAlias;
		try {
			const response = await fetch(`/api/catalog-schedules/${encodeURIComponent(show)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled, frequency, version })
			});
			if (show !== showAlias) return;
			const body = await response.json();
			if (!response.ok) {
				message =
					body.error === 'schedule_conflict'
						? 'Schedule settings changed. Refresh their status before trying again.'
						: body.error === 'save_cloud_progress_first'
							? 'Save this catalogue to cloud first.'
							: 'Could not save schedule settings. Try again.';
				return;
			}
			if (!isCatalogSchedule(body.schedule)) throw new Error();
			schedule = body.schedule;
			version = body.version;
			message = enabled
				? 'Automatic scans enabled. The next scheduled run will pick up this catalogue.'
				: 'Automatic scans paused. An episode already in progress may finish, then the worker will stop.';
		} catch {
			message = 'Could not save schedule settings. Try refreshing their status.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		mounted = true;
	});
	$: if (mounted && loadedShow !== showAlias) void load(showAlias);
</script>

{#if visible}
	<section class="settings-card" aria-labelledby="catalogue-schedule-heading">
		<div class="settings-heading">
			<h3 id="catalogue-schedule-heading">Automatic catalogue scans</h3>
			<span class="status-badge" class:active={schedule?.enabled}
				>{schedule?.enabled ? 'On' : 'Off'}</span
			>
		</div>
		<p class="settings-description">
			Check for new episodes while your browser is closed. Matching results save to cloud for
			review.
		</p>
		<div class="settings-field">
			<label for="catalogue-schedule-frequency">Check for new episodes</label>
			<select id="catalogue-schedule-frequency" bind:value={frequency} disabled={busy || scanning}>
				<option value="daily">Every day</option><option value="weekly">Every week</option><option
					value="fortnightly">Every two weeks</option
				><option value="monthly">Every 30 days</option>
			</select>
		</div>
		{#if schedule?.enabled}
			<dl class="settings-summary">
				<div>
					<dt>Next eligible run</dt>
					<dd>{date(schedule.nextRunAt)}</dd>
				</div>
			</dl>
			<p class="settings-muted settings-note">Runs on a scheduler check after this time.</p>
		{:else}<p class="settings-note">Automatic scans are off for this catalogue.</p>{/if}
		<div class="settings-actions">
			{#if schedule?.enabled}
				<button
					type="button"
					class="control-button primary"
					disabled={busy || scanning || !cloudConnected}
					on:click={() => save(true)}>Save frequency</button
				>
				<button type="button" class="control-button" disabled={busy} on:click={() => save(false)}
					>Pause scans</button
				>
			{:else}
				<button
					type="button"
					class="control-button primary"
					disabled={busy || scanning || !cloudConnected || !isScheduleFrequency(frequency)}
					on:click={() => save(true)}>Enable automatic scans</button
				>
			{/if}
			<button type="button" class="control-button" disabled={busy} on:click={() => load(showAlias)}
				>Refresh status</button
			>
		</div>
		{#if schedule?.lastRunAt}
			<dl class="settings-summary two-column">
				<div>
					<dt>Last run</dt>
					<dd>{date(schedule.lastRunAt)}</dd>
				</div>
				<div>
					<dt>Last run results</dt>
					<dd>{schedule.lastScanned} episodes saved · {schedule.lastSearches} searches</dd>
				</div>
			</dl>
			<p class="settings-note">{statuses[schedule.lastStatus]}</p>
		{/if}
		{#if message}<p class="settings-feedback" role="status">{message}</p>{/if}
		<details class="settings-details">
			<summary>How automatic scans work</summary>
			<p>
				Scans use your shared Spotify search allowance. Pending and failed episodes continue in
				batches of up to five, with at least an hour between scheduled runs. Spotify cooldowns take
				priority.
			</p>
			<p>
				Playlist updates stay manual unless you enable automatic playlist updates separately below.
			</p>
		</details>
	</section>
{/if}
