<script lang="ts">
	import { page } from '$app/stores';
	import CatalogNotifications from '../components/catalog-notifications.svelte';
	import { Button, Divider, LoginWithSpotify, Logo, Panel } from '$components';
	import { onDestroy, onMount } from 'svelte';
	import {
		applySavedCatalogUpdateOutcome,
		checkSavedCatalogWithFeedback,
		createSavedCatalogCards,
		createSavedCatalogUpdateChecker,
		deleteSavedCatalogProgressIfConfirmed,
		downloadSavedCatalogProgress,
		formatSavedCatalogCheckFeedback,
		isSavedCatalogCheckActive,
		setSavedCatalogCheckFeedback,
		type SavedCatalogCheckFeedbackMap,
		type SavedCatalogCard
	} from '$lib/utils/catalog-dashboard.client';
	import { deleteCatalogProgress, listCatalogProgress } from '$lib/utils/catalog-progress.client';
	import {
		cloudSyncAvailable,
		listCloudCopies,
		type CloudCatalogueSummary
	} from '$lib/utils/catalog-cloud.client';
	import {
		connectLocalCloud,
		isLocalCloudBridge,
		localCloudConnected
	} from '$lib/utils/catalog-cloud-bridge.client';
	import { formatCatalogScanSessionSummary } from '$lib/utils/catalog-scan-session';
	import {
		formatSpotifySearchCooldownDashboardNotice,
		SpotifySearchCooldownController,
		spotifySearchCooldownRemainingSeconds,
		type SpotifySearchCooldownState
	} from '$lib/utils/spotify-search-cooldown.client';

	const me = $page.data.user;
	let savedCatalogues: SavedCatalogCard[] = [];
	let savedCataloguesLoading = true;
	let savedCataloguesWarning = '';
	let savedCataloguesError = '';
	let cloudCatalogues: CloudCatalogueSummary[] = [];
	let cloudCataloguesLoading = false;
	let cloudCataloguesError = '';
	let bridgeConnected = false;
	$: cloudOnlyCatalogues = cloudCatalogues.filter(
		(cloud) => !savedCatalogues.some((local) => local.showAlias === cloud.showAlias)
	);
	let deletingAlias: string | undefined;
	let globalCooldown: SpotifySearchCooldownState | null = null;
	let globalCooldownRemaining = 0;
	$: globalCooldownNotice = formatSpotifySearchCooldownDashboardNotice(globalCooldown);
	let cooldownTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeGlobalCooldown: (() => void) | undefined;
	const globalCooldownController = new SpotifySearchCooldownController();
	let catalogueCheckStates: SavedCatalogCheckFeedbackMap = {};
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
			await globalCooldownController.initialize(result.records);
			savedCatalogues = createSavedCatalogCards(result.records);
			if (result.skippedCount > 0) {
				savedCataloguesWarning = 'Some saved catalogue records could not be displayed.';
			}
		} catch {
			await globalCooldownController.initialize([]);
			savedCatalogues = [];
			savedCataloguesError = 'Saved catalogues are unavailable in this browser.';
		} finally {
			savedCataloguesLoading = false;
		}
	};

	const loadCloudCatalogues = async () => {
		if (!me || !cloudSyncAvailable(me.id)) return;
		cloudCataloguesLoading = true;
		try {
			cloudCatalogues = await listCloudCopies();
		} catch {
			cloudCataloguesError = 'Cloud catalogues are unavailable right now. Local copies still work.';
		} finally {
			cloudCataloguesLoading = false;
		}
	};

	const updateGlobalCooldown = (state = globalCooldownController.clearExpired()) => {
		globalCooldown = state;
		globalCooldownRemaining = spotifySearchCooldownRemainingSeconds(state);
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
		const outcome = await checkSavedCatalogWithFeedback(
			card.showAlias,
			catalogueUpdateChecker,
			(showAlias, feedback) => {
				catalogueCheckStates = setSavedCatalogCheckFeedback(
					catalogueCheckStates,
					showAlias,
					feedback
				);
			}
		);
		if (outcome.type === 'already-checking') return;
		savedCatalogues = applySavedCatalogUpdateOutcome(savedCatalogues, outcome);
	};

	onMount(() => {
		bridgeConnected = localCloudConnected();
		const handleBridgeConnected = () => {
			bridgeConnected = true;
			void loadCloudCatalogues();
		};
		window.addEventListener('nts-cloud-connected', handleBridgeConnected);
		unsubscribeGlobalCooldown = globalCooldownController.subscribe(updateGlobalCooldown);
		void loadSavedCatalogues();
		void loadCloudCatalogues();
		cooldownTimer = setInterval(() => {
			updateGlobalCooldown();
			if (isLocalCloudBridge() && bridgeConnected && !localCloudConnected())
				bridgeConnected = false;
		}, 1000);
		return () => window.removeEventListener('nts-cloud-connected', handleBridgeConnected);
	});

	onDestroy(() => {
		if (cooldownTimer) clearInterval(cooldownTimer);
		unsubscribeGlobalCooldown?.();
		globalCooldownController.destroy();
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

		<section class="quick-guide" aria-labelledby="quick-guide-heading">
			<h2 id="quick-guide-heading" class="font-title">Quick guide</h2>
			<ol class="font-base">
				<li>Paste an NTS show or episode URL into the top bar.</li>
				<li>For a full show, scan the catalogue and resume later if Spotify pauses it.</li>
				<li>
					Review suggested matches. Checked tracks are included; the dash means excluded; the arrows
					show alternatives.
				</li>
				<li>
					Create a Spotify playlist once, then compare and apply changes to that same linked
					playlist.
				</li>
				<li>
					On the private hosted site, save progress to cloud to continue on PC or phone. Automatic
					scans, playlist updates, and notifications are separate opt-ins.
				</li>
				<li>Download a progress backup after important reviews or updates.</li>
			</ol>
		</section>

		<section class="faq" aria-labelledby="faq-heading">
			<h2 id="faq-heading" class="font-title">FAQ</h2>
			<div class="faq-group">
				<h3 class="font-base">Progress and review</h3>
				<details>
					<summary class="font-base">Where is my progress saved?</summary>
					<p class="font-base">
						Catalogue progress saves in this browser. On the private hosted site, upload it to cloud
						from the show page. Once cloud progress is connected, changes save to both places. Check
						the cloud status before switching devices; download a JSON progress backup after
						important reviews as an independent copy.
					</p>
				</details>
				<details>
					<summary class="font-base">Can I continue on my PC and phone?</summary>
					<p class="font-base">
						Sign in with the same permitted Spotify account on the hosted site and open the cloud
						catalogue. Load the latest cloud copy before reviewing. If both copies changed, the app
						asks you to choose which to keep rather than silently merging your choices. Download
						backups before using “Use cloud copy here” or “Replace cloud with this browser”.
					</p>
				</details>
				<details>
					<summary class="font-base">What does a progress backup restore?</summary>
					<p class="font-base">
						“Download progress” saves a JSON copy of scanned episodes, reviewed choices, playlist
						settings, and the saved playlist link. “Restore progress” replaces the saved progress
						for that show after confirmation; it does not update Spotify by itself. Backups do not
						include background Spotify authorization, automatic-update settings, or registered
						notification devices. Review those settings separately after restoring.
					</p>
				</details>
				<details>
					<summary class="font-base">Why are some matches missing or wrong?</summary>
					<p class="font-base">
						Some NTS tracklists are incomplete, some releases are unavailable on Spotify, and
						title-only searches can be inaccurate. Use the review filters to find uncertain matches,
						fallback results, tracks with no candidates, and part mismatches. Checked tracks are
						included; excluded tracks stay out. Choose an alternative where needed. You can also
						download a CSV of the review results.
					</p>
				</details>
			</div>
			<div class="faq-group">
				<h3 class="font-base">Spotify playlists</h3>
				<details>
					<summary class="font-base">Do updates create a new playlist each time?</summary>
					<p class="font-base">
						A full-show catalogue keeps its linked Spotify playlist. Compare with Spotify, review
						the preview, then apply the update to that same playlist. Updating replaces its contents
						with your selected tracks. “Nothing to sync” means the latest comparison already
						matches; “Compare again” refreshes that comparison. Forgetting a link does not delete
						the playlist from Spotify.
					</p>
				</details>
				<details>
					<summary class="font-base">How are tracks ordered and duplicates handled?</summary>
					<p class="font-base">
						Choose latest or oldest episodes first on the show page. Tracks within each episode keep
						their original order. Repeated selections of the same Spotify track are included once;
						different Spotify versions of a recording can still appear separately. Changing the
						order or reviewed selections takes effect in Spotify when you apply an update.
					</p>
				</details>
				<details>
					<summary class="font-base"
						>What if I edit the playlist in Spotify or an update stops?</summary
					>
					<p class="font-base">
						Automatic updates pause when Spotify differs from the app's expected playlist. Review it
						and manually synchronize before enabling updates again. If a manual update stops partway
						through, keep the link and follow the displayed recovery instructions; verified partial
						work may offer “Verify and resume Spotify synchronization”. An uncertain write needs
						inspection rather than repeated Apply clicks or a duplicate playlist.
					</p>
				</details>
			</div>
			<div class="faq-group">
				<h3 class="font-base">Automatic scans and updates</h3>
				<details>
					<summary class="font-base">What happens when a new episode appears?</summary>
					<p class="font-base">
						With automatic scans off, check for new episodes from Saved Catalogues or reopen the
						show, then scan and review pending episodes. On the private hosted site, you can enable
						“Automatic catalogue scans” after saving progress to cloud. Background runs discover and
						scan episodes while your browser is closed and save results to cloud for review. This
						does not enable automatic Spotify playlist updates.
					</p>
				</details>
				<details>
					<summary class="font-base">How often do automatic scans run?</summary>
					<p class="font-base">
						Choose every day, every week, every two weeks, or every 30 days for new-episode checks.
						“Next eligible run” is the earliest due time, not a guaranteed start time. The scheduler
						picks up due work in bounded runs; pending and failed episodes continue in small
						batches. Spotify cooldowns and other active work can delay a run. Check the last-run
						status and results on the show page.
					</p>
				</details>
				<details>
					<summary class="font-base"
						>Can my Spotify playlist update while my browser is closed?</summary
					>
					<p class="font-base">
						Yes, on the private hosted site. Save progress to cloud, manually synchronize your
						linked app-created playlist, authorize background Spotify, then enable “Automatic
						playlist updates” for that show. Enable automatic catalogue scans separately to find and
						match new episodes. Confident new matches are selected; uncertain matches stay available
						for review, and saved manual choices are preserved. Automatic updates replace the linked
						playlist contents with your selected tracks. Both automation controls are off by
						default.
					</p>
				</details>
				<details>
					<summary class="font-base">How do I pause automation or disconnect Spotify?</summary>
					<p class="font-base">
						“Pause scans” and “Pause playlist updates” affect that show separately. An already
						accepted request may finish. Under “Playlist safeguards and Spotify access”, “Disconnect
						background Spotify” removes the server's saved authorization for all catalogues without
						deleting playlists. Reauthorize if Spotify expires or revokes access. To revoke the app
						itself, use Spotify's account apps page. Pause both automation controls before working
						through a standalone local installation without cloud coordination.
					</p>
				</details>
			</div>
			<div class="faq-group">
				<h3 class="font-base">Notifications</h3>
				<details>
					<summary class="font-base">How do I get catalogue alerts on my phone or PC?</summary>
					<p class="font-base">
						On the hosted homepage, open “Catalogue notifications” in each browser you want to
						register. Select “Enable on this device”, allow notifications, and name the device. The
						Enabled badge confirms the current browser's registration. Scheduled scans can produce
						alerts for newly discovered episodes and matching results ready for review. Registration
						does not turn on scans or playlist updates. This uses free browser push, including Pixel
						Chrome, with no email or paid notification service. “Remove” followed by “Confirm
						removal” stops alerts to that device and keeps the history.
					</p>
				</details>
				<details>
					<summary class="font-base"
						>Can I test notifications without waiting for a new episode?</summary
					>
					<p class="font-base">
						Yes. Select “Send test notification” on a registered device, then check that device's
						notifications. The test sends only to the current device and changes no scan or playlist
						settings. Wait at least 30 seconds between tests, including when switching devices.
						Tests do not appear in catalogue activity. “Test sent” confirms the push service
						accepted it; seeing it on your phone or PC confirms delivery.
					</p>
				</details>
				<details>
					<summary class="font-base">Why are there no alerts, or why did a push not arrive?</summary
					>
					<p class="font-base">
						A quiet catalogue may have no new episodes for weeks. Real alerts need a scheduled scan
						to discover new episodes or save new matching results. Browser permissions, offline
						devices, and phone battery settings can delay or prevent delivery. If permission is
						blocked, allow notifications in the site's browser settings and refresh. Check “Recent
						activity”: the last 100 catalogue alerts remain there independently of push delivery.
						Browser push is best effort, so keep checking your saved catalogue status too.
					</p>
				</details>
			</div>
			<div class="faq-group">
				<h3 class="font-base">Spotify limits</h3>
				<details>
					<summary class="font-base">What happens if Spotify limits requests?</summary>
					<p class="font-base">
						The scan pauses and saves completed work. Resume after the displayed cooldown instead of
						restarting the catalogue. Manual and background work share the account's saved cooldown;
						changing devices or scanning another show does not bypass it. Automatic work waits for a
						later eligible run.
					</p>
				</details>
				<details>
					<summary class="font-base"
						>Does opening Saved Catalogues use Spotify search quota?</summary
					>
					<p class="font-base">
						The dashboard reads saved browser data and cloud catalogue summaries without Spotify
						Search requests. The signed-in header may verify your Spotify profile. “Check for new
						episodes” contacts NTS; matching tracks uses Spotify Search. Enabled background scans
						can also use the shared search allowance while your browser is closed.
					</p>
				</details>
			</div>
		</section>

		{#if !me}
			<LoginWithSpotify />
		{/if}

		<Divider />

		<section class="saved-catalogues" aria-labelledby="saved-catalogues-heading">
			<h2 id="saved-catalogues-heading" class="font-title">SAVED CATALOGUES</h2>
			{#if me && isLocalCloudBridge() && !bridgeConnected}
				<p class="font-base">Connect this local Vite browser to your private cloud progress.</p>
				<Button size="sm" variant="outline" on:click={connectLocalCloud}>Connect to cloud</Button>
			{/if}
			{#if me && bridgeConnected && !cloudSyncAvailable(me.id)}
				<p role="alert" class="font-base">
					The local Spotify account differs from the hosted account. Sign in to the same account
					before syncing.
				</p>
			{/if}
			{#if globalCooldownNotice && globalCooldownRemaining > 0}
				<div class="catalogue-warning font-base" role="status">
					<p>{globalCooldownNotice}</p>
				</div>
			{/if}
			{#if savedCataloguesLoading}
				<p class="font-base" role="status">Loading saved catalogues…</p>
			{:else}
				{#if savedCataloguesWarning}
					<p class="catalogue-warning font-base" role="status">{savedCataloguesWarning}</p>
				{/if}
				{#if savedCataloguesError}
					<p class="catalogue-warning font-base" role="alert">{savedCataloguesError}</p>
				{/if}
				{#if cloudCataloguesLoading}
					<p class="font-base" role="status">Checking cloud catalogues…</p>
				{/if}
				{#if cloudCataloguesError}<p class="catalogue-warning font-base" role="status">
						{cloudCataloguesError}
					</p>{/if}
				{#if savedCatalogues.length === 0 && cloudOnlyCatalogues.length === 0 && !savedCataloguesError && !cloudCataloguesLoading}
					<p class="font-base">
						No full-catalogue progress is saved here yet. Open an NTS show and start a catalogue
						scan to create one.
					</p>
				{/if}
				{#if savedCatalogues.length > 0}
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
								{#if catalogue.lastScanSession}
									<p class="font-small-beast">
										Last scan: {formatCatalogScanSessionSummary(catalogue.lastScanSession)}
									</p>
								{/if}
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
										role="status"
										aria-live="polite"
										aria-atomic="true"
									>
										{formatSavedCatalogCheckFeedback(catalogueCheckStates[catalogue.showAlias])}
									</p>
								{/if}
								<div class="catalogue-actions">
									<Button
										type="button"
										variant="outline"
										disabled={isSavedCatalogCheckActive(
											catalogueCheckStates[catalogue.showAlias]
										) || deletingAlias === catalogue.showAlias}
										on:click={() => checkForNewEpisodes(catalogue)}
										>{isSavedCatalogCheckActive(catalogueCheckStates[catalogue.showAlias])
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
				{#if cloudOnlyCatalogues.length > 0}
					<h3 class="font-base">Saved in cloud</h3>
					<div class="catalogue-grid">
						{#each cloudOnlyCatalogues as catalogue (catalogue.showAlias)}
							<article class="catalogue-card">
								<h3 class="font-title">{catalogue.showName}</h3>
								<p class="font-base">
									{catalogue.scanned} scanned · {catalogue.pending} pending · {catalogue.failed} failed
								</p>
								<p class="font-small-beast">Last saved {formatSavedAt(catalogue.updatedAt)}</p>
								<a class="font-base" href={`/shows/${catalogue.showAlias}`}
									>Open and load cloud progress</a
								>
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
					href="https://ko-fi.com/invinnieveritas"
					target="_blank"
					rel="noopener noreferrer"
				>
					<span class="coffee">Buy me a beer</span>
				</Button>
				<Button
					as="a"
					variant="outline"
					icon="github"
					href="https://github.com/inVinnieVeritas/nts-to-spotify"
					target="_blank"
					rel="noopener noreferrer"
				>
					<span>View on GitHub</span>
				</Button>
			</div>
			<p class="attribution font-base">
				Built on the original NTS to Spotify project by
				<a
					href="https://github.com/pdrbrnd/nts-to-spotify"
					target="_blank"
					rel="noopener noreferrer">pdrbrnd</a
				>.
			</p>
		</div>
	</div>
	<CatalogNotifications />
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

	.quick-guide,
	.faq {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
	}

	.quick-guide ol {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.faq-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.faq-group h3 {
		margin-top: 8px;
		font-weight: 700;
		letter-spacing: 0;
	}

	.faq details {
		border: 1px solid #d8d8cc;
		border-radius: 8px;
		padding: 12px 14px;
		background-color: var(--color-background);
	}

	.faq details[open] {
		background-color: lightgoldenrodyellow;
	}

	.faq summary {
		cursor: pointer;
		font-weight: var(--font-weight-medium);
		min-height: 24px;
		line-height: 1.5;
		letter-spacing: 0;
	}

	.faq summary:focus {
		outline: 2px solid var(--color-foreground);
		outline-offset: 3px;
	}

	.faq p {
		margin-top: 10px;
		line-height: 1.6;
		letter-spacing: 0;
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

	.attribution {
		margin-top: 8px;
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
