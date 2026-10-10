<script lang="ts">
	import type { BasicTrack, Match, URI } from '$lib/types';
	import { PART_MISMATCH_WARNING_PREFIX } from '$lib/utils/part-mismatch';
	import { createEventDispatcher } from 'svelte';
	import { slide } from 'svelte/transition';
	import Button from './button.svelte';
	import Checkbox from './checkbox.svelte';
	import Song from './song.svelte';

	export let original: BasicTrack;
	export let matches: undefined | Match[] = undefined;
	export let selectedMatch: URI | null = null;
	export let checked = false;
	export let dismissible = false;
	export let dismissed = false;
	export let partMismatchReason = '';
	const dispatch = createEventDispatcher<{ reviewchange: void }>();

	let expanded = false;

	$: match = matches?.find((match) => match.uri === selectedMatch);
	$: hasNoMatch = matches && matches.length === 0;

	const selectMatch = (uri: URI) => {
		if (dismissed) return;
		selectedMatch = uri;
		dispatch('reviewchange');
	};
	const toggleDismissed = () => {
		checked = false;
		dismissed = !dismissed;
		expanded = false;
		dispatch('reviewchange');
	};
</script>

<div class="root">
	<div class="original font-tiny">
		{original.artist} - {original.title}
	</div>
	<div class="row" class:no-action={matches === undefined || hasNoMatch}>
		<div>
			<Song
				artist={match?.artist || original.artist}
				title={match?.title || original.title}
				preview={match?.preview}
				cover={match ? { type: 'spotify', src: match.cover } : { type: 'nts' }}
				loading={matches === undefined}
				disabled={!!hasNoMatch}
				href={match?.href}
			/>
		</div>
		<div class="right">
			{#if matches && matches.length > 1}
				<Button
					size="sm"
					variant={expanded ? 'solid' : 'outline'}
					on:click={() => (expanded = !expanded)}
					icon="replace"
				/>
			{/if}
			<Checkbox
				bind:checked
				on:change={() => dispatch('reviewchange')}
				disabled={dismissed || matches === undefined || hasNoMatch}
			/>
		</div>
	</div>
	{#if partMismatchReason}
		<p class="part-mismatch font-small-beast">
			<strong>{PART_MISMATCH_WARNING_PREFIX}</strong>{partMismatchReason}
		</p>
	{/if}
	{#if dismissible && matches !== undefined}
		<div class="review-actions">
			<Button
				size="sm"
				variant="outline"
				icon={dismissed ? 'history' : 'x-circle'}
				aria-label={`${dismissed ? 'Restore' : 'Dismiss'} ${original.artist} - ${original.title}`}
				on:click={toggleDismissed}
			>
				{dismissed ? 'Restore to review' : 'Dismiss'}
			</Button>
			{#if dismissed}<span class="font-small-beast">Dismissed · excluded from playlist</span>{/if}
		</div>
	{/if}
	{#if expanded}
		<div class="matches" transition:slide={{ duration: 300 }} data-theme="dark">
			<p class="candidate-help font-small-beast">
				Choose a candidate here; use the track checkbox to include it in your playlist.
			</p>
			{#each matches || [] as match}
				<div class="row">
					<Song
						artist={match.artist}
						title={match.title}
						preview={match?.preview}
						cover={{ type: 'spotify', src: match.cover }}
						href={match.href}
					/>
					<div class="right">
						{#if selectedMatch === match.uri}
							<Button disabled>Current match</Button>
						{:else}
							<Button variant="outline" disabled={dismissed} on:click={() => selectMatch(match.uri)}
								>Choose match</Button
							>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style lang="postcss">
	.row,
	.original {
		padding: 12px 24px;

		@media (--md) {
			padding: 12px 40px;
		}
	}

	.original {
		padding-bottom: 8px;
		counter-increment: track;
		opacity: 0.5;

		&::before {
			content: counter(track) '. ';
		}
	}

	.row {
		display: flex;
		align-items: center;

		width: 100%;
		justify-content: space-between;
		gap: 16px;

		&.no-action {
			pointer-events: none;
		}
	}

	.right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.part-mismatch {
		margin: 0;
		padding: 0 24px 12px;
		font-weight: 500;

		@media (--md) {
			padding-inline: 40px;
		}
	}

	.matches {
		padding: 16px 0;
	}
	.review-actions,
	.candidate-help {
		padding: 0 24px 12px;
		@media (--md) {
			padding-inline: 40px;
		}
	}
	.review-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
