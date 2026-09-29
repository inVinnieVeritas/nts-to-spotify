<script lang="ts">
	import '$styles/index.pcss';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/stores';
	import { tick } from 'svelte';
	import { Header } from '$components';
	import type { LayoutData } from './$types';

	export let data: LayoutData;
	$: title = $page.data.title ? `${$page.data.title} | NTS to Spotify` : 'NTS to Spotify';
	let mainElement: HTMLElement;

	afterNavigate(async ({ from, to }) => {
		if (from?.url.pathname === to?.url.pathname) return;
		await tick();
		mainElement?.scrollTo(0, 0);
	});
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content="Convert NTS Episodes into Spotify Playlists" />
	<meta name="og:title" content={title} />
	<meta name="og:image" content="/og.jpg" />
</svelte:head>

<div class="holder" style={`background-image: url(${$page.data?.cover || data.bgImage})`}>
	<Header />
	<main bind:this={mainElement}>
		<slot />
	</main>
</div>

<style lang="postcss">
	.holder {
		background-position: center center;
		background-repeat: no-repeat;
		background-size: cover;

		display: flex;
		flex-direction: column;

		height: 100vh;
	}

	main {
		flex: 1;

		display: flex;
		flex-direction: column;

		overflow-y: auto;
	}
</style>
