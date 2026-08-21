<script lang="ts">
	import { page } from '$app/stores';
	import { Button, Divider, LoginWithSpotify, Logo, Panel } from '$components';
	import { onMount } from 'svelte';
	import {
		applySavedCatalogUpdateOutcome,
		createSavedCatalogCards,
		createSavedCatalogUpdateChecker,
		deleteSavedCatalogProgressIfConfirmed,
		downloadSavedCatalogProgress,
		type SavedCatalogCard
	} from '$lib/utils/catalog-dashboard.client';
	import { deleteCatalogProgress, listCatalogProgress } from '$lib/utils/catalog-progress.client';

	const me = $page.data.user;
	let savedCatalogues: SavedCatalogCard[] = [];
	let savedCataloguesLoading = true;
	let savedCataloguesWarning = '';
	let savedCataloguesError = '';
	let deletingAlias: string | undefined;
	let catalogueCheckStates: Record<
		string,
		{
			type: 'checking' | 'up-to-date' | 'updated' | 'check-failed' | 'save-failed';
			addedCount?: number;
		}
	> = {};
	const catalogueUpdateChecker = createSavedCatalogUpdateChecker();

	const formatSavedAt = (timestamp: number) =>
		new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(timestamp));

	const loadSavedCatalogues = async () => {
		savedCataloguesLoading = true;
		savedCataloguesError = '';
		savedCataloguesWarning = '';
		try {
			const result = await listCatalogProgress();
			savedCatalogues = createSavedCatalogCards(result.records);
			if (result.skippedCount > 0) {
				savedCataloguesWarning = 'Some saved catalogue records could not be displayed.';
			}
		} catch {
			savedCatalogues = [];
			savedCataloguesError = 'Saved catalogues are unavailable in this browser.';
		} finally {
			savedCataloguesLoading = false;
		}
	};

	const downloadBackup = (card: SavedCatalogCard) => {
		savedCataloguesError = '';
		try {
			downloadSavedCatalogProgress(card.record);
		} catch {
			savedCataloguesError = 'The catalogue backup could not be downloaded.';
		}
	};

	const deleteLocalProgress = async (card: SavedCatalogCard) => {
		if (deletingAlias) return;
		savedCataloguesError = '';
		deletingAlias = card.showAlias;
		try {
			const deleted = await deleteSavedCatalogProgressIfConfirmed(card, {
				confirm: (message) => window.confirm(message),
				remove: deleteCatalogProgress
			});
			if (deleted) {
				savedCatalogues = savedCatalogues.filter(({ showAlias }) => showAlias !== card.showAlias);
			}
		} catch {
			savedCataloguesError =
				'Local catalogue progress could not be deleted. The saved record was kept.';
		} finally {
			deletingAlias = undefined;
		}
	};

	const checkForNewEpisodes = async (card: SavedCatalogCard) => {
		if (deletingAlias === card.showAlias || catalogueUpdateChecker.isChecking(card.showAlias))
			return;
		catalogueCheckStates = {
			...catalogueCheckStates,
			[card.showAlias]: { type: 'checking' }
		};
		const outcome = await catalogueUpdateChecker.check(card.showAlias);
		if (outcome.type === 'already-checking') return;
		savedCatalogues = applySavedCatalogUpdateOutcome(savedCatalogues, outcome);
		catalogueCheckStates = {
			...catalogueCheckStates,
			[card.showAlias]:
				outcome.type === 'updated'
					? { type: 'updated', addedCount: outcome.addedCount }
					: { type: outcome.type }
		};
	};

	const catalogCheckMessage = (showAlias: string) => {
		const state = catalogueCheckStates[showAlias];
		if (!state) return '';
		if (state.type === 'checking') return 'Checking NTS…';
		if (state.type === 'up-to-date') return 'Up to date';
		if (state.type === 'check-failed') return 'Check failed. Try again.';
		if (state.type === 'save-failed') return 'New episodes found but could not be saved.';
		return state.addedCount === 1
			? '1 new episode added'
			: `${state.addedCount || 0} new episodes added`;
	};

	onMount(() => {
		void loadSavedCatalogues();
	});
</script>

<Panel>
	<div class="panel">
		<Logo />
		<h1 class="font-title">NTS to Spotify</h1>

		<p class="font-base">
			Create Spotify playlists from one NTS episode or a show's full catalogue.
		</p>

		<div class="disclaimer font-small-beast">
			<h4 class="font-base">Disclaimer</h4>
			<p class="font-base">
				This is a community-created app to create Spotify Playlists from NTS episodes. We're not
				affiliated with NTS in any way.
			</p>
			<p class="font-base">
				<a href="https://nts.live" target="_blank" rel="noopener noreferrer">
					Click here to go to NTS.live
				</a>
			</p>
		</div>

		<ol class="font-base">
			<li>Paste an NTS show or episode URL into the top bar</li>
			<li>Preview and manage your tracklist</li>
			<li>Login with Spotify to be able to import the playlist</li>
		</ol>

		<p class="font-base">
			<a href="/shows/the-breakfast-show-flo/episodes/the-breakfast-show-flo-30th-november-2022"
				>See example</a
			>
		</p>

		{#if !me}
			<LoginWithSpotify />
		{/if}

		<Divider />

		<section class="saved-catalogues" aria-labelledby="saved-catalogues-heading">
			<h2 id="saved-catalogues-heading" class="font-title">SAVED CATALOGUES</h2>
			{#if savedCataloguesLoading}
				<p class="font-base" role="status">Loading saved catalogues…</p>
			{:else}
				{#if savedCataloguesWarning}
					<p class="catalogue-warning font-base" role="status">{savedCataloguesWarning}</p>
				{/if}
				{#if savedCataloguesError}
					<p class="catalogue-warning font-base" role="alert">{savedCataloguesError}</p>
				{/if}
				{#if savedCatalogues.length === 0 && !savedCataloguesError}
					<p class="font-base">
						No full-catalogue progress is saved in this browser yet. Open an NTS show and start a
						catalogue scan to create one.
					</p>
				{:else if savedCatalogues.length > 0}
					<div class="catalogue-grid">
						{#each savedCatalogues as catalogue (catalogue.showAlias)}
							<article class="catalogue-card">
								<h3 class="font-title">{catalogue.showName}</h3>
								<p class="font-base">
									{catalogue.scanned} scanned · {catalogue.pending} pending · {catalogue.failed}
									failed
								</p>
								<p class="font-base">
									{catalogue.uniqueSelectedTracks} unique selected tracks · {catalogue.duplicateTracks}
									duplicates removed
								</p>
								<p class="font-small-beast">Last saved {formatSavedAt(catalogue.updatedAt)}</p>
								<p class="font-base">
									{catalogue.linkedPlaylistUrl
										? 'Spotify playlist linked'
										: 'No Spotify playlist linked'}
								</p>
								{#if catalogue.creationPending}
									<p class="catalogue-warning font-base" role="status">
										Playlist creation outcome pending. Check Spotify before creating another
										playlist.
									</p>
								{/if}
								{#if catalogueCheckStates[catalogue.showAlias]}
									<p
										class:catalogue-warning={catalogueCheckStates[catalogue.showAlias].type ===
											'check-failed' ||
											catalogueCheckStates[catalogue.showAlias].type === 'save-failed'}
										class="font-base"
										role={catalogueCheckStates[catalogue.showAlias].type === 'check-failed' ||
										catalogueCheckStates[catalogue.showAlias].type === 'save-failed'
											? 'alert'
											: 'status'}
									>
										{catalogCheckMessage(catalogue.showAlias)}
									</p>
								{/if}
								<div class="catalogue-actions">
									<Button
										type="button"
										variant="outline"
										disabled={catalogueCheckStates[catalogue.showAlias]?.type === 'checking' ||
											deletingAlias === catalogue.showAlias}
										on:click={() => checkForNewEpisodes(catalogue)}
										>{catalogueCheckStates[catalogue.showAlias]?.type === 'checking'
											? 'Checking NTS…'
											: 'Check for new episodes'}</Button
									>
									<Button
										as="a"
										variant="outline"
										href={`/shows/${encodeURIComponent(catalogue.showAlias)}`}
										>Open catalogue</Button
									>
									{#if catalogue.linkedPlaylistUrl}
										<Button
											as="a"
											variant="outline"
											href={catalogue.linkedPlaylistUrl}
											target="_blank"
											rel="noopener noreferrer">Open Spotify</Button
										>
									{/if}
									<Button type="button" variant="outline" on:click={() => downloadBackup(catalogue)}
										>Download backup</Button
									>
									<Button
										type="button"
										variant="outline"
										disabled={Boolean(deletingAlias) ||
											catalogueCheckStates[catalogue.showAlias]?.type === 'checking'}
										loading={deletingAlias === catalogue.showAlias}
										on:click={() => deleteLocalProgress(catalogue)}>Delete local progress</Button
									>
								</div>
							</article>
						{/each}
					</div>
				{/if}
			{/if}
		</section>

		<Divider />

		<div>
			<p class="support font-base">Support the project</p>
			<div class="buttons">
				<Button
					as="a"
					variant="outline"
					icon="coffee"
					href="https://ko-fi.com/pdrbrnd"
					target="_blank"
					rel="noopener noreferrer"
				>
					<span class="coffee">Buy me a coffee</span>
				</Button>
				<Button
					as="a"
					variant="outline"
					icon="github"
					href="https://github.com/pdrbrnd/nts-to-spotify"
					target="_blank"
					rel="noopener noreferrer"
				>
					<span>View on GitHub</span>
				</Button>
			</div>
		</div>
	</div>
</Panel>

<style lang="postcss">
	.panel {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 24px;
	}

	ol {
		list-style-type: decimal;

		margin-left: 16px;
	}

	.support {
		margin-bottom: 8px;
	}

	.disclaimer {
		background-color: lightgoldenrodyellow;
		border: 1px solid var(--color-foreground);
		padding: 8px;

		& h4,
		& a {
			font-weight: var(--font-weight-medium);
		}

		& h4,
		& p:not(:last-child) {
			margin-bottom: 8px;
		}
	}

	a {
		text-decoration: underline;
	}

	.buttons {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.saved-catalogues {
		display: flex;
		flex-direction: column;
		gap: 16px;
		width: 100%;
	}

	.catalogue-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
		gap: 16px;
	}

	.catalogue-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		border: 1px solid var(--color-foreground);
		padding: 16px;
		background: var(--color-background);
	}

	.catalogue-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 4px;
	}

	.catalogue-warning {
		border: 1px solid var(--color-foreground);
		padding: 8px;
		background-color: lightgoldenrodyellow;
	}
</style>
