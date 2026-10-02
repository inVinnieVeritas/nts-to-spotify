<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Button from './button.svelte';
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
	<section class="cloud-progress font-small-beast" aria-label="Automatic Spotify playlist updates">
		<h3>Automatically update Spotify playlist</h3>
		<p>
			Off by default. Only your existing app-created linked playlist can be updated. Confident new
			matches are selected; uncertain matches stay available for review. Your saved manual choices
			are preserved.
		</p>
		<p>Background Spotify authorization: {connected ? 'connected' : 'disconnected'}.</p>
		<Button
			size="sm"
			variant="outline"
			disabled={busy}
			on:click={() => action(connected ? 'disconnect' : 'connect')}
			>{connected ? 'Disconnect background Spotify' : 'Authorize background Spotify'}</Button
		>
		<Button
			size="sm"
			variant="outline"
			disabled={busy || scanning || (!state?.enabled && (!connected || !cloudConnected))}
			on:click={() => action(state?.enabled ? 'disable' : 'enable')}
			>{state?.enabled
				? 'Pause automatic playlist updates'
				: 'Enable automatic playlist updates'}</Button
		>
		<Button size="sm" variant="outline" disabled={busy} on:click={() => load(showAlias)}
			>Refresh playlist status</Button
		>
		<div aria-live="polite" role="status">
			{#if state}<p>{automaticPlaylistStatusText(state)}</p>
				{#if state.lastUpdatedAt}<p>
						Last automatic update: {new Date(state.lastUpdatedAt).toLocaleString()} · {state.added} tracks
						added.
					</p>{/if}
				<p>{state.awaitingReview} track occurrences awaiting review.</p>
				{#if state.retryUntil > now}<p>
						{formatCooldownDuration(Math.ceil((state.retryUntil - now) / 1000))} remaining.
					</p>{/if}
			{:else}<p>Automatic playlist updates are off for this catalogue.</p>{/if}
			{#if message}<p>{message}</p>{/if}
		</div>
		<p>
			Disconnect removes the server's saved authorization, not Spotify playlists. To revoke the app
			itself, use <a
				href="https://www.spotify.com/account/apps/"
				target="_blank"
				rel="noopener noreferrer">Spotify account apps</a
			>. Reauthorization is required when Spotify expires or revokes the refresh token.
		</p>
	</section>
{/if}
