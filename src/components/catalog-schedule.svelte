<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isCatalogSchedule,
		isScheduleFrequency,
		type CatalogSchedule,
		type ScheduleFrequency
	} from '$lib/utils/catalog-schedule';
	import Button from './button.svelte';
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
	<div class="cloud-progress font-small-beast" aria-label="Automatic catalogue scans">
		<h3>Automatic catalogue scans</h3>
		<p>
			Runs while your browser is closed and uses your shared Spotify search allowance. Matches save
			to cloud for review. Spotify playlists are updated only when you choose to apply changes.
		</p>
		<label for="catalogue-schedule-frequency">Check for new episodes</label>
		<select id="catalogue-schedule-frequency" bind:value={frequency} disabled={busy || scanning}>
			<option value="daily">Every day</option><option value="weekly">Every week</option>
			<option value="fortnightly">Every two weeks</option><option value="monthly"
				>Every 30 days</option
			>
		</select>
		<p>
			Pending and failed episodes continue in batches of up to five, with at least an hour between
			scheduled runs. Spotify cooldowns take priority.
		</p>
		{#if schedule?.enabled}
			<p>
				Enabled · next eligible run: {date(schedule.nextRunAt)}. It will run on a scheduler check
				after this time.
			</p>
			<Button
				size="sm"
				variant="outline"
				disabled={busy || scanning || !cloudConnected}
				on:click={() => save(true)}>Save frequency</Button
			>
			<Button size="sm" variant="outline" disabled={busy} on:click={() => save(false)}
				>Pause automatic scans</Button
			>
		{:else}
			<p>Automatic scans are off for this catalogue.</p>
			<Button
				size="sm"
				variant="outline"
				disabled={busy || scanning || !cloudConnected || !isScheduleFrequency(frequency)}
				on:click={() => save(true)}>Enable automatic scans</Button
			>
		{/if}
		<Button size="sm" variant="outline" disabled={busy} on:click={() => load(showAlias)}
			>Refresh schedule status</Button
		>
		{#if schedule?.lastRunAt}
			<p>
				Last run: {date(schedule.lastRunAt)} · {schedule.lastScanned} episodes saved · {schedule.lastSearches}
				Spotify searches. {statuses[schedule.lastStatus]}
			</p>
		{/if}
		{#if message}<p role="status">{message}</p>{/if}
	</div>
{/if}
