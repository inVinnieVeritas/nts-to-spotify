<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		isAutomaticPlaylistPublicState,
		automaticPlaylistStatusText,
		type AutomaticPlaylistPublicState
	} from '$lib/utils/catalog-playlist-automation';
	import { formatCooldownDuration } from '$lib/utils/catalog-scan';
	export let showAlias: string;
	export let cloudConnected = false;
	export let scanning = false;
	let visible = false;
	let mounted = false;
	let loadedShow = '';
	let busy = false;
	let connected = false;
	let state: AutomaticPlaylistPublicState | null = null;
	let message = '';
	let now = Date.now();
	let timer: ReturnType<typeof setInterval>;
	let generation = 0;
	async function load(show: string) {
		const ticket = ++generation;
		loadedShow = show;
		state = null;
		message = '';
		visible = false;
		if (location.origin !== 'https://nts2spotify.vincentvanderveken.com') return;
		try {
			const responses = await Promise.all([
				fetch('/api/playlist-authorization', { cache: 'no-store' }),
				fetch(`/api/catalog-playlist-automation/${encodeURIComponent(show)}`, { cache: 'no-store' })
			]);
			if (responses[0].status === 404) return;
			const [auth, settings] = await Promise.all(
				responses.map(async (r) => {
					if (!r.ok) throw new Error();
					return r.json();
				})
			);
			if (!mounted || ticket !== generation || show !== showAlias) return;
			connected = auth.connected === true;
			if (settings.automation !== null && !isAutomaticPlaylistPublicState(settings.automation))
				throw new Error();
			state = settings.automation;
			visible = true;
		} catch {
			if (mounted && ticket === generation && show === showAlias) {
				visible = true;
				message = 'Could not load automatic playlist settings.';
			}
		}
	}
	async function action(operation: 'connect' | 'disconnect' | 'enable' | 'disable') {
		if (busy) return;
		if (
			operation === 'connect' &&
			!confirm(
				'Authorize this private server to update opted-in linked playlists while your browser is closed?'
			)
		)
			return;
		if (
			operation === 'disconnect' &&
			!confirm(
				'Disconnect background authorization for all catalogues? Existing playlists and saved progress will not be deleted.'
			)
		)
			return;
		if (
			operation === 'enable' &&
			!confirm(
				'Confirm this linked playlist was created by this app. Automatic updates replace its contents with your selected tracks. Manually synchronize it first; external changes will pause automation.'
			)
		)
			return;
		busy = true;
		const show = showAlias;
		message = '';
		try {
			const authorization = operation === 'connect' || operation === 'disconnect';
			const response = await fetch(
				authorization
					? '/api/playlist-authorization'
					: `/api/catalog-playlist-automation/${encodeURIComponent(show)}`,
				{
					method: authorization ? 'POST' : 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(
						authorization
							? { operation }
							: { enabled: operation === 'enable', confirmAppCreated: operation === 'enable' }
					)
				}
			);
			if (!response.ok) throw new Error();
			if (show === showAlias) {
				await load(show);
				message = 'Settings saved.';
			}
		} catch {
			if (show === showAlias)
				message =
					'Could not save. Reconnect Spotify if needed, save cloud progress, and manually synchronize the app-created linked playlist before enabling.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		mounted = true;
		timer = setInterval(() => (now = Date.now()), 1000);
	});
	onDestroy(() => {
		mounted = false;
		generation++;
		clearInterval(timer);
	});
	$: if (mounted && loadedShow !== showAlias) void load(showAlias);
</script>

{#if visible}
	<section class="settings-card" aria-labelledby="playlist-automation-heading">
		<div class="settings-heading">
			<h3 id="playlist-automation-heading">Automatic playlist updates</h3>
			<span class="status-badge" class:active={state?.enabled}>{state?.enabled ? 'On' : 'Off'}</span
			>
		</div>
		<p class="settings-description">
			Keep your linked Spotify playlist up to date with confident matches. Uncertain matches stay
			available for review.
		</p>
		<dl class="settings-summary">
			<div>
				<dt>Background Spotify authorization</dt>
				<dd>
					<span class="status-badge" class:active={connected}
						>{connected ? 'Connected' : 'Disconnected'}</span
					>
				</dd>
			</div>
		</dl>
		<div class="settings-actions">
			<button
				type="button"
				class="control-button primary"
				disabled={busy || scanning || (!state?.enabled && (!connected || !cloudConnected))}
				on:click={() => action(state?.enabled ? 'disable' : 'enable')}
				>{state?.enabled ? 'Pause playlist updates' : 'Enable playlist updates'}</button
			>
			{#if !connected}<button
					type="button"
					class="control-button"
					disabled={busy}
					on:click={() => action('connect')}>Authorize background Spotify</button
				>{/if}
			<button type="button" class="control-button" disabled={busy} on:click={() => load(showAlias)}
				>Refresh status</button
			>
		</div>
		<div aria-live="polite" role="status">
			{#if state}
				<p class="settings-note">{automaticPlaylistStatusText(state)}</p>
				<dl class="settings-summary two-column">
					{#if state.lastUpdatedAt}<div>
							<dt>Last automatic update</dt>
							<dd>{new Date(state.lastUpdatedAt).toLocaleString()}</dd>
						</div>
						<div>
							<dt>Tracks added in last update</dt>
							<dd>{state.added}</dd>
						</div>{/if}
					<div>
						<dt>Track occurrences awaiting review</dt>
						<dd>{state.awaitingReview}</dd>
					</div>
				</dl>
				{#if state.retryUntil > now}<p class="settings-feedback">
						Waiting: {formatCooldownDuration(Math.ceil((state.retryUntil - now) / 1000))} remaining.
					</p>{/if}
			{:else}<p class="settings-note">
					Automatic playlist updates are off for this catalogue.
				</p>{/if}
			{#if message}<p class="settings-feedback">{message}</p>{/if}
		</div>
		<details class="settings-details">
			<summary>Playlist safeguards and Spotify access</summary>
			<p>
				Off by default. Only your existing app-created linked playlist can be updated. Automatic
				updates replace its contents with your selected tracks; external edits pause automation.
				Your saved manual choices are preserved.
			</p>
			<p>
				Disconnect removes the server's saved authorization for all catalogues, not Spotify
				playlists. To revoke the app itself, use <a
					href="https://www.spotify.com/account/apps/"
					target="_blank"
					rel="noopener noreferrer">Spotify account apps</a
				>. Reauthorization is required when Spotify expires or revokes the refresh token.
			</p>
			{#if connected}<div class="settings-actions">
					<button
						type="button"
						class="control-button danger"
						disabled={busy}
						on:click={() => action('disconnect')}>Disconnect background Spotify</button
					>
				</div>{/if}
		</details>
	</section>
{/if}
