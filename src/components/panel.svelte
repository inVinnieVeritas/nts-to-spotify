<script lang="ts">
	export let padded = true;
	export let wide = false;
</script>

<div>
	<section class:padded class:wide data-theme="light">
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

	.padded {
		padding: 24px;

		@media (--md) {
			padding: 40px;
			padding-bottom: 24px;
		}
	}
</style>
