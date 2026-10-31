<script lang="ts">
	import Icon from './icon/icon.svelte';

	export let showAlias: string;
	export let showName: string;
	export let cover: string | undefined = undefined;
	export let scanned: number;
	export let pending: number;
	export let failed: number;
	export let tracks: number | undefined = undefined;
	export let playlistLinked: boolean | undefined = undefined;
	export let cloudOnly = false;
	export let view: 'grid' | 'list' = 'grid';
	let detailsOpen = false;
	$: catalogueUrl = `/shows/${encodeURIComponent(showAlias)}`;
	let failedCover: string | undefined;
	$: artworkSource =
		cover && cover !== failedCover ? cover : `/api/nts/artwork/${encodeURIComponent(showAlias)}`;
	let failedArtworkSource: string | undefined;
	$: total = scanned + pending + failed;
	$: scanStatus =
		failed > 0
			? 'Scan errors'
			: pending > 0
				? 'Scan pending'
				: total > 0
					? 'Scanned'
					: 'Not scanned';
</script>

<article class="catalogue-card" class:list-view={view === 'list'} aria-label={showName}>
	<a class="cover" href={catalogueUrl} aria-label={`Open catalogue: ${showName}`}>
		{#if artworkSource !== failedArtworkSource}
			<img
				src={artworkSource}
				alt=""
				width="480"
				height="140"
				loading="lazy"
				on:error={() => {
					failedArtworkSource = artworkSource;
					if (artworkSource === cover) failedCover = cover;
				}}
			/>
		{:else}
			<span aria-hidden="true">NTS</span>
		{/if}
	</a>
	<header class="card-heading">
		<div class="card-title">
			<h3><a href={catalogueUrl}>{showName}</a></h3>
			<p class="card-caption">{cloudOnly ? 'Saved in cloud' : 'Saved in this browser'}</p>
		</div>
	</header>
	<div class="card-progress">
		<div class="scan-overview">
			<span
				class="scan-status"
				class:attention={failed > 0 || pending > 0}
				class:complete={total > 0 && pending === 0 && failed === 0}>{scanStatus}</span
			>
			<span class="scan-fraction">{scanned} / {total} episodes scanned</span>
		</div>
		<progress value={scanned} max={total || 1} aria-label={`Episodes scanned for ${showName}`}
		></progress>
	</div>
	<dl class="card-counts">
		<div class="scanned-count">
			<dt>Scanned</dt>
			<dd>
				<span class="count-icon" aria-hidden="true"><Icon icon="check-circle" /></span>{scanned}
			</dd>
		</div>
		<div class:pending-count={pending > 0}>
			<dt>Pending</dt>
			<dd><span class="count-icon" aria-hidden="true"><Icon icon="clock" /></span>{pending}</dd>
		</div>
		<div class:failed-count={failed > 0}>
			<dt>Failed</dt>
			<dd><span class="count-icon" aria-hidden="true"><Icon icon="x-circle" /></span>{failed}</dd>
		</div>
	</dl>
	{#if tracks !== undefined || playlistLinked !== undefined}
		<div class="playlist-summary">
			{#if tracks !== undefined}<span class="track-total"
					><span class="count-icon" aria-hidden="true"><Icon icon="music" /></span><span
						><strong>{tracks.toLocaleString()}</strong> selected tracks</span
					></span
				>{/if}
			{#if playlistLinked !== undefined}<span class="playlist-state" class:linked={playlistLinked}
					><span class="count-icon" aria-hidden="true"
						><Icon icon={playlistLinked ? 'spotify' : 'link'} /></span
					>{playlistLinked ? 'Playlist linked' : 'No playlist linked'}</span
				>{/if}
		</div>
	{/if}
	<div class="card-feedback"><slot name="feedback" /></div>
	<div class="card-actions">
		<slot name="actions" />
		<details class="card-details" bind:open={detailsOpen}>
			<summary
				aria-label={`${detailsOpen ? 'Less' : 'More'}: ${cloudOnly ? 'saved details' : 'details and backup'} for ${showName}`}
				>{detailsOpen ? 'Less' : 'More'}</summary
			>
			<div class="details-content"><slot name="details" /></div>
		</details>
	</div>
</article>

<style lang="postcss">
	.catalogue-card {
		min-width: 0;
		padding: 16px;
		border: 1px solid #d8d8cc;
		border-radius: 12px;
		background: #fff;
		box-shadow: 0 6px 24px rgb(0 0 0 / 16%);
		color: #20211f;
		font-size: 14px;
		line-height: 1.5;
		letter-spacing: 0;
		text-transform: none;
	}
	.card-heading {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}
	.cover {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: calc(100% + 32px);
		height: 140px;
		margin: -16px -16px 14px;
		flex-shrink: 0;
		overflow: hidden;
		border-radius: 12px 12px 0 0;
		background: #eef0e8;
		color: #687163;
		font-size: 16px;
		font-weight: 800;
		text-decoration: none;
	}
	.cover:hover img {
		filter: brightness(0.9);
	}
	.cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.card-title {
		min-width: 0;
	}
	h3 {
		font-size: 19px;
		font-weight: 700;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	h3 a {
		text-decoration: none;
	}
	h3 a:hover {
		text-decoration: underline;
	}
	.card-caption {
		margin-top: 4px;
		color: #687163;
		font-size: 12px;
	}
	.scan-overview {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
	}
	.scan-status {
		padding: 3px 8px;
		border-radius: 20px;
		background: #f0f1ed;
		color: #50564e;
		font-size: 12px;
		font-weight: 600;
	}
	.scan-status.complete {
		background: #e8f2e9;
		color: #28603a;
	}
	.scan-status.attention {
		background: #fff0cf;
		color: #765012;
	}
	.scan-fraction {
		font-size: 12px;
		color: #687163;
	}
	progress {
		display: block;
		appearance: none;
		width: 100%;
		height: 6px;
		margin-top: 10px;
		overflow: hidden;
		border: 0;
		border-radius: 10px;
		background: #eef0e8;
		color: #588071;
	}
	progress::-webkit-progress-bar {
		background: #eef0e8;
	}
	progress::-webkit-progress-value {
		background: #588071;
		border-radius: 10px;
	}
	progress::-moz-progress-bar {
		background: #588071;
		border-radius: 10px;
	}
	.card-counts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin-top: 12px;
	}
	.card-counts > div {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.card-counts dd {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		order: -1;
		font-size: 16px;
		font-weight: 700;
		line-height: 1.25;
	}
	.card-counts dt {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: #687163;
	}
	.failed-count dd {
		color: #963f36;
	}
	.count-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}
	.count-icon :global(svg) {
		width: 100%;
		height: 100%;
	}
	.scanned-count .count-icon {
		color: #28603a;
	}
	.pending-count .count-icon {
		color: #996615;
	}
	.failed-count .count-icon {
		color: #963f36;
	}
	.track-total,
	.playlist-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.playlist-summary {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.playlist-state {
		color: #687163;
		font-size: 12px;
		align-self: center;
	}
	.playlist-state.linked {
		color: #28603a;
	}
	.card-feedback:empty {
		display: none;
	}
	.card-feedback :global(p) {
		margin-top: 12px;
		padding: 9px 11px;
		background: #f1f4ee;
		border-radius: 7px;
		overflow-wrap: anywhere;
	}
	.card-feedback :global(.catalogue-warning) {
		background: #fff0cf;
		border: 0;
	}
	.card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
	.catalogue-card :global(.catalogue-control) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		box-sizing: border-box;
		min-height: 44px;
		padding: 9px 12px;
		border: 1px solid #c6c9c0;
		border-radius: 7px;
		background: #fff;
		color: #20211f;
		font: inherit;
		font-weight: 600;
		text-decoration: none;
		text-align: center;
		cursor: pointer;
	}
	.catalogue-card :global(.control-icon),
	.catalogue-card :global(.detail-icon) {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		width: 16px;
		height: 16px;
	}
	.catalogue-card :global(.control-icon svg),
	.catalogue-card :global(.detail-icon svg) {
		width: 100%;
		height: 100%;
	}
	.catalogue-card :global(.catalogue-control:hover:not(:disabled)) {
		background: #f0f2ec;
	}
	.catalogue-card :global(.catalogue-control.primary) {
		background: #202b25;
		border-color: #202b25;
		color: #fff;
	}
	.catalogue-card :global(.catalogue-control.primary:hover) {
		background: #34473b;
	}
	.catalogue-card :global(.catalogue-control.danger) {
		color: #963f36;
		border-color: #ddc2bd;
	}
	.catalogue-card :global(.catalogue-control:disabled) {
		opacity: 0.5;
		cursor: default;
	}
	.catalogue-card :global(.catalogue-control:focus-visible),
	a:focus-visible,
	summary:focus-visible {
		outline: 3px solid #588071;
		outline-offset: 3px;
	}
	.card-details[open] {
		flex-basis: 100%;
	}
	.card-details summary {
		box-sizing: border-box;
		min-height: 44px;
		padding: 9px 12px;
		border: 1px solid #c6c9c0;
		border-radius: 7px;
		cursor: pointer;
		color: #555c51;
		font-size: 14px;
		font-weight: 600;
	}
	.card-details[open] summary {
		width: fit-content;
	}
	.card-details summary:hover {
		background: #f0f2ec;
	}

	.details-content {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 10px;
		color: #5c6059;
		font-size: 12px;
	}
	.details-content :global(.detail-actions) {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 4px;
	}
	.details-content :global(.catalogue-control) {
		font-size: 13px;
	}
	.details-content :global(.detail-line) {
		display: flex;
		align-items: flex-start;
		gap: 7px;
	}
	.catalogue-card.list-view {
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr);
		grid-template-areas:
			'cover heading'
			'cover progress'
			'counts counts'
			'playlist playlist'
			'feedback feedback'
			'actions actions';
		gap: 12px 16px;
	}
	.list-view .cover {
		grid-area: cover;
		width: 100%;
		height: 100%;
		min-height: 112px;
		margin: 0;
		border-radius: 8px;
	}
	.list-view .cover img {
		position: absolute;
		inset: 0;
	}
	.list-view .card-heading {
		grid-area: heading;
		margin: 0;
	}
	.list-view .card-progress {
		grid-area: progress;
	}
	.list-view .card-counts {
		grid-area: counts;
		margin: 0;
	}
	.list-view .playlist-summary {
		grid-area: playlist;
		margin: 0;
	}
	.list-view .card-feedback {
		grid-area: feedback;
	}
	.list-view .card-feedback :global(p) {
		margin: 0;
	}
	.list-view .card-actions {
		grid-area: actions;
		margin: 0;
		align-content: start;
		align-items: start;
	}
	@media (--lg) {
		.catalogue-card.list-view {
			grid-template-columns: 140px minmax(180px, 1.4fr) minmax(190px, 1fr) minmax(270px, 1.2fr);
			grid-template-areas:
				'cover heading counts actions'
				'cover progress playlist actions'
				'cover feedback feedback feedback';
			gap: 12px 24px;
		}
	}
	@media (max-width: 420px) {
		.catalogue-card {
			padding: 16px;
		}
		h3 {
			font-size: 17px;
		}
		.card-actions :global(.catalogue-control) {
			flex: 1 1 auto;
		}
	}
</style>
