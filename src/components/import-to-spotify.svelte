<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$components';
	import { onDestroy } from 'svelte';
	import LoginWithSpotify from './login-with-spotify.svelte';

	export let disabled = false;
	export let data: {
		title: string;
		description: string;
		date: string;
		cover: string;
		tracks: string[];
		public?: boolean;
	};

	const me = $page.data.user;

	let creating: boolean;
	let success: boolean;
	let playlistUrl: string;
	let failure: string;
	let successTimeout: ReturnType<typeof setTimeout>;

	const handleClick = async () => {
		if (!me) return;

		creating = true;
		failure = '';

		try {
			const response = await fetch('/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: data.title,
					description: data.description,
					tracks: data.tracks,
					public: data.public ?? true
				})
			});
			if (!response.ok) throw new Error(await response.text());
			const result = (await response.json()) as { url: string };
			playlistUrl = result.url;
			success = true;
			successTimeout = setTimeout(() => (success = false), 5000);
		} catch (error) {
			console.error(error);
			failure = 'Import failed. Please try again.';
		} finally {
			creating = false;
		}
	};

	onDestroy(() => {
		if (successTimeout) clearTimeout(successTimeout);
	});
</script>

<footer data-theme="dark">
	<p class="font-small-beast">{data.tracks.length} Selected tracks</p>
	<div>
		{#if success}
			<p class="font-small-beast">
				<a href={playlistUrl} target="_blank" rel="noreferrer">Open playlist</a>
			</p>
		{:else if failure}
			<p class="font-small-beast">{failure}</p>
		{/if}
		{#if me?.id}
			<Button
				as="button"
				icon="spotify"
				disabled={disabled || creating || data.tracks.length === 0}
				loading={creating}
				on:click={handleClick}>Import to Spotify</Button
			>
		{:else}
			<LoginWithSpotify label="Login to import" />
		{/if}
	</div>
</footer>

<style lang="postcss">
	footer {
		position: relative;

		display: flex;
		align-items: center;
		justify-content: space-between;

		height: 44px;

		border: 1px solid var(--color-background);
		box-sizing: content-box;

		position: fixed;
		bottom: 0;
		left: 0;
		width: 100%;

		background-color: var(--color-background);

		& p {
			padding: 8px;
		}

		& div {
			display: flex;
			align-items: center;
			gap: 8px;
		}
	}
</style>
