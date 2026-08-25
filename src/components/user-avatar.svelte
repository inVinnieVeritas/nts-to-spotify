<script lang="ts">
	import LoginWithSpotify from './login-with-spotify.svelte';
	import Button from './button.svelte';
	import { clickOutside } from '$lib/actions/clickoutside';
	import { page } from '$app/stores';

	let isLoggingOut = false;

	const me = $page.data.user;
</script>

{#if me?.id}
	<div use:clickOutside={() => (isLoggingOut = false)}>
		{#if isLoggingOut}
			<form method="POST" action="/logout">
				<Button variant="ghost" type="submit">
					<p class="font-small-beast">Logout</p>
					<div
						class="avatar"
						style:background-image={me.image ? `url(${me.image})` : undefined}
					></div>
				</Button>
			</form>
		{:else}
			<Button variant="ghost" on:click={() => (isLoggingOut = true)}>
				<p class="font-small-beast">{me.display_name}</p>
				<div
					class="avatar"
					style:background-image={me.image ? `url(${me.image})` : undefined}
				></div>
			</Button>
		{/if}
	</div>
{:else}
	<LoginWithSpotify variant="ghost" />
{/if}

<style lang="postcss">
	.avatar {
		width: 28px;
		height: 28px;

		border-radius: 100%;

		background-color: hsla(var(--color-foreground-hsl) / 0.2);
		background-size: cover;
		background-repeat: no-repeat;
		background-position: center center;
	}
</style>
