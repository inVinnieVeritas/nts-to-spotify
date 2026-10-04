<script lang="ts">
	export let padded = true;
	export let wide = false;
	export let transparent = false;
</script>

<div>
	<section class:padded class:wide class:transparent data-theme="light">
		<slot />
	</section>
</div>

<style lang="postcss">
	div {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-end;

		flex: 1;
	}

	section {
		margin-top: 30vh;

		width: min(100%, 600px);
	}

	section.wide {
		width: min(100%, 1920px);
		margin-top: 24px;
		align-self: center;
		border-radius: 12px 12px 0 0;
	}

	section.transparent {
		background-color: transparent;
		padding: 16px;
		margin-top: 8px;
		margin-bottom: 24px;
		@media (--md) {
			padding: 24px 32px;
		}
	}

	.padded {
		padding: 24px;

		@media (--md) {
			padding: 40px;
			padding-bottom: 24px;
		}
	}
</style>
