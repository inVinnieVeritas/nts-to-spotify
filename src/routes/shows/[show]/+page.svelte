<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Badge,
		Button,
		Divider,
		ImportToSpotify,
		LoginWithSpotify,
		Panel,
		Track
	} from '$components';
	import type { MatchedTrack } from '$lib/types';
	import { abortableDelay, createAbortScope, isAbortError } from '$lib/utils/abort';
	import {
		catalogBackupFilename,
		downloadCatalogProgressFile,
		downloadLatestCatalogProgress,
		readCatalogBackupFile,
		takeSelectedCatalogBackupFile
	} from '$lib/utils/catalog-backup.client';
	import {
		CatalogBackupValidationError,
		prepareCatalogBackupRestore,
		restoreCatalogProgressIfConfirmed
	} from '$lib/utils/catalog-backup';
	import {
		captureCatalogProgress,
		createCatalogResetState,
		createGeneratedPlaylistText,
		formatCooldownDuration,
		formatSpotifyCooldownMessage,
		getCatalogExportUris,
		getCatalogSummaryCounts,
		getResumableEpisodeIndexes,
		isCatalogProgressCompatible,
		isSystemicSpotifyResponseFailure,
		parseCatalogRetryAfter,
		parseCatalogSpotifyRateLimitReason,
		parseSpotifySessionMetrics,
		reconcileEpisodes,
		restoreCatalogPlaylistOrder,
		restoreCatalogRetryState,
		runCatalogWorkers,
		shouldApplyCatalogRestoration,
		shouldReturnEpisodeToPending,
		updateGeneratedPlaylistText,
		type CatalogScanOutcome,
		type CatalogSpotifyRateLimitReason,
		type EpisodeState,
		type PlaylistOrder,
		type SpotifySessionMetrics
	} from '$lib/utils/catalog-scan';
	import {
		createLatestSnapshotWriter,
		deleteCatalogProgress,
		loadCatalogProgress,
		saveCatalogProgress
	} from '$lib/utils/catalog-progress.client';
	import type { PageData } from './$types';

	export let data: PageData;

	const BROWSER_EPISODE_TIMEOUT_MS = 3 * 60 * 1000 + 15_000;
	const MAX_AUTOMATIC_RATE_LIMITS = 3;
	const LONG_RETRY_AFTER_SECONDS = 60 * 60;

	const shortDate = (date: string) => {
		const [year, month, day] = date.slice(0, 10).split('-');
		return `${day}.${month}.${year.slice(2)}`;
	};

	const showDefaults = (pageData: PageData, order: PlaylistOrder = 'latest-first') => {
		const first = pageData.episodes[0];
		const last = pageData.episodes[pageData.episodes.length - 1];
		const generated = createGeneratedPlaylistText(pageData.name, pageData.episodes, order);
		return {
			first,
			last,
			stamp: generated.dateStamp,
			title: generated.title,
			description: generated.description
		};
	};

	const initialDefaults = showDefaults(data);
	let firstEpisode = initialDefaults.first;
	let lastEpisode = initialDefaults.last;
	let dateStamp = initialDefaults.stamp;
	let playlistTitle = initialDefaults.title;
	let playlistDescription = initialDefaults.description;
	let publicPlaylist = false;
	let playlistOrder: PlaylistOrder = 'latest-first';
	let scanning = false;
	let scanMessage = '';
	let restored = false;
	let persistenceAvailable = true;
	let cooldownUntil = 0;
	let cooldownRemaining = 0;
	let cooldownReason: CatalogSpotifyRateLimitReason = 'rate-limited';
	let pausedByRateLimit = false;
	let spotifySessionMetrics: SpotifySessionMetrics | null = null;
	let cancelRequested = false;
	let automaticRateLimitCount = 0;
	let scanController: AbortController | undefined;
	let cooldownTimer: ReturnType<typeof setInterval> | undefined;
	let mounted = false;
	let destroyed = false;
	let skipDestroyPersistence = false;
	let progressTransferBusy = false;
	let progressReplacementAlias: string | undefined;
	let progressTransferMessage = '';
	let progressTransferError = '';
	let progressFileInput: HTMLInputElement;
	let activeShowAlias = data.showAlias;
	let showGeneration = 0;
	const activeEpisodeControllers = new Map<number, AbortController>();

	let episodes: EpisodeState[] = reconcileEpisodes(data.episodes);

	const snapshotWriter = createLatestSnapshotWriter(
		saveCatalogProgress,
		(_cause, failedSnapshot) => {
			if (failedSnapshot.showAlias !== activeShowAlias) return;
			persistenceAvailable = false;
			scanMessage = 'Progress could not be saved in this browser.';
		}
	);

	const currentProgressSnapshot = () =>
		captureCatalogProgress(
			activeShowAlias,
			episodes,
			{
				title: playlistTitle,
				description: playlistDescription,
				public: publicPlaylist,
				order: playlistOrder
			},
			{ cooldownUntil, pausedByRateLimit }
		);

	const persistProgress = (waitForSave = false) => {
		if (!restored || !persistenceAvailable || progressReplacementAlias === activeShowAlias) {
			return Promise.resolve();
		}
		skipDestroyPersistence = false;
		const snapshot = currentProgressSnapshot();
		snapshotWriter.enqueue(snapshot);
		return waitForSave ? snapshotWriter.flush() : Promise.resolve();
	};

	const captureAndPersistReview = () => void persistProgress();
	const changePlaylistOrder = (event: Event) => {
		const nextOrder: PlaylistOrder =
			(event.currentTarget as HTMLSelectElement).value === 'oldest-first'
				? 'oldest-first'
				: 'latest-first';
		const previousGenerated = createGeneratedPlaylistText(data.name, data.episodes, playlistOrder);
		const nextGenerated = createGeneratedPlaylistText(data.name, data.episodes, nextOrder);
		const updatedText = updateGeneratedPlaylistText(
			{ title: playlistTitle, description: playlistDescription },
			previousGenerated,
			nextGenerated
		);
		playlistOrder = nextOrder;
		dateStamp = nextGenerated.dateStamp;
		playlistTitle = updatedText.title;
		playlistDescription = updatedText.description;
		captureAndPersistReview();
	};

	const updateSpotifySessionMetrics = (payload: unknown) => {
		const parsed = parseSpotifySessionMetrics(payload);
		if (parsed) spotifySessionMetrics = parsed;
	};

	const scanEpisode = async (
		index: number,
		parentSignal: AbortSignal,
		generation: number,
		showAlias: string
	): Promise<CatalogScanOutcome> => {
		if (generation !== showGeneration || showAlias !== activeShowAlias) {
			return { type: 'cancelled' };
		}

		const scope = createAbortScope(parentSignal, BROWSER_EPISODE_TIMEOUT_MS);
		activeEpisodeControllers.set(index, scope.controller);
		const episodeAlias = episodes[index].episodeAlias;
		episodes[index].status = 'scanning';
		episodes[index].error = undefined;
		episodes = episodes;
		void persistProgress();

		try {
			const response = await fetch('/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					show: showAlias,
					episode: episodeAlias
				}),
				signal: scope.signal
			});
			if (generation !== showGeneration || showAlias !== activeShowAlias) {
				return { type: 'cancelled' };
			}
			if (response.status === 429) {
				const payload = await response.json().catch(() => null);
				updateSpotifySessionMetrics(payload);
				const retryNow = Date.now();
				const retryAfterSeconds = parseCatalogRetryAfter(
					payload,
					response.headers.get('Retry-After'),
					retryNow
				);
				const reason = parseCatalogSpotifyRateLimitReason(
					payload && typeof payload === 'object' && 'reason' in payload
						? (payload as { reason: unknown }).reason
						: undefined
				);
				cooldownUntil = Math.max(cooldownUntil, retryNow + retryAfterSeconds * 1000);
				cooldownReason = reason;
				cooldownRemaining = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
				episodes[index].status = 'rate-limited';
				episodes[index].error = 'Waiting for Spotify';
				episodes = episodes;
				void persistProgress();
				return {
					type: 'rate-limited',
					retryAfterSeconds,
					requiresManualResume: retryAfterSeconds > LONG_RETRY_AFTER_SECONDS,
					reason
				};
			}
			if (response.status === 502 || response.status === 503) {
				const payload = await response.json().catch(() => null);
				updateSpotifySessionMetrics(payload);
				if (isSystemicSpotifyResponseFailure(payload)) {
					episodes[index].status = 'pending';
					episodes[index].error = undefined;
					episodes = episodes;
					void persistProgress();
					return { type: 'systemic-spotify-failure' };
				}
			}
			if (!response.ok) throw new Error(`Request failed (${response.status})`);

			const result = (await response.json()) as {
				tracks: MatchedTrack[];
				spotifySessionMetrics?: unknown;
			};
			updateSpotifySessionMetrics(result);
			if (generation !== showGeneration || showAlias !== activeShowAlias) {
				return { type: 'cancelled' };
			}
			episodes[index].tracks = result.tracks.map((track) => ({
				...track,
				selectedMatch: track.matches[0]?.uri || null,
				checked: track.confident
			}));
			episodes[index].status = 'done';
			episodes[index].error = undefined;
			episodes = episodes;
			await persistProgress(true);
			return { type: 'done' };
		} catch (cause) {
			if (generation !== showGeneration || showAlias !== activeShowAlias) {
				return { type: 'cancelled' };
			}
			if (isAbortError(cause) && !scope.didTimeout()) {
				episodes[index].status = 'pending';
				episodes[index].error = undefined;
				episodes = episodes;
				void persistProgress();
				return { type: 'cancelled' };
			}
			episodes[index].status = 'error';
			episodes[index].error = scope.didTimeout()
				? 'Episode scan timed out.'
				: 'Could not scan this episode.';
			episodes = episodes;
			void persistProgress();
			return { type: 'failed' };
		} finally {
			scope.cleanup();
			if (activeEpisodeControllers.get(index) === scope.controller) {
				activeEpisodeControllers.delete(index);
			}
		}
	};

	const abortActiveEpisodes = () => {
		for (const controller of activeEpisodeControllers.values()) controller.abort();
	};

	const waitForCooldown = async (signal: AbortSignal) => {
		while (cooldownUntil > Date.now()) {
			cooldownRemaining = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
			await abortableDelay(Math.min(1000, cooldownUntil - Date.now()), signal);
		}
		cooldownRemaining = 0;
	};

	const updateCooldownRemaining = () => {
		const cooldownWasActive = cooldownRemaining > 0;
		cooldownRemaining =
			cooldownUntil > Date.now() ? Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000)) : 0;
		if (cooldownWasActive && cooldownRemaining === 0 && pausedByRateLimit) {
			scanMessage = 'Scan paused. Resume is now available.';
		}
	};

	const scanCatalog = async (requestedIndexes?: number[]) => {
		if (scanning || !restored || progressTransferBusy) return;
		updateCooldownRemaining();
		if (cooldownRemaining > 0) {
			scanMessage = formatSpotifyCooldownMessage(cooldownReason, cooldownRemaining);
			return;
		}
		const queue = (requestedIndexes || getResumableEpisodeIndexes(episodes)).filter(
			(index) => episodes[index]?.status !== 'done'
		);
		if (queue.length === 0) return;

		scanning = true;
		cancelRequested = false;
		pausedByRateLimit = false;
		automaticRateLimitCount = 0;
		scanMessage = '';
		const currentScanController = new AbortController();
		scanController = currentScanController;
		const currentGeneration = showGeneration;
		const currentShowAlias = activeShowAlias;
		let systemicSpotifyFailure = false;
		const systemicallyAffectedIndexes = new Set<number>();
		await runCatalogWorkers({
			indexes: queue,
			concurrency: 2,
			signal: currentScanController.signal,
			waitUntilReady: waitForCooldown,
			scanEpisode: (index, signal) =>
				scanEpisode(index, signal, currentGeneration, currentShowAlias),
			onRateLimit: (_index, outcome) => {
				automaticRateLimitCount += 1;
				abortActiveEpisodes();

				if (outcome.requiresManualResume || automaticRateLimitCount >= MAX_AUTOMATIC_RATE_LIMITS) {
					pausedByRateLimit = true;
					void persistProgress();
					currentScanController.abort();
				}
			},
			onSystemicSpotifyFailure: (index) => {
				systemicSpotifyFailure = true;
				systemicallyAffectedIndexes.add(index);
				for (const activeIndex of activeEpisodeControllers.keys()) {
					systemicallyAffectedIndexes.add(activeIndex);
				}
				abortActiveEpisodes();
				currentScanController.abort();
			}
		}).catch(() => undefined);
		if (currentGeneration !== showGeneration || currentShowAlias !== activeShowAlias) return;
		for (const [index, episode] of episodes.entries()) {
			if (
				shouldReturnEpisodeToPending(
					episode.status,
					systemicSpotifyFailure && systemicallyAffectedIndexes.has(index)
				)
			) {
				episode.status = 'pending';
				episode.error = undefined;
			}
		}
		episodes = episodes;
		scanning = false;
		updateCooldownRemaining();
		if (cancelRequested) scanMessage = 'Scan cancelled. Completed episodes were saved.';
		else if (systemicSpotifyFailure)
			scanMessage = 'Spotify search is unavailable. Scan paused; pending episodes can be retried.';
		else if (pausedByRateLimit)
			scanMessage =
				cooldownRemaining > 0
					? 'Scan paused. Resume will become available when the cooldown ends.'
					: 'Scan paused. Resume is now available.';
		else if (episodes.some(({ status }) => status === 'error'))
			scanMessage = 'Scan finished with some errors. Retry failed episodes when ready.';
		else
			scanMessage =
				'Catalogue scan complete. Review unchecked and unmatched tracks before importing.';
		await persistProgress(true);
	};

	const cancelScan = () => {
		if (!scanning) return;
		cancelRequested = true;
		scanController?.abort();
		abortActiveEpisodes();
	};

	const clearProgressTransferMessage = () => {
		progressTransferMessage = '';
		progressTransferError = '';
	};

	const downloadProgress = async () => {
		if (!restored || progressTransferBusy) return;
		clearProgressTransferMessage();
		progressTransferBusy = true;
		try {
			await downloadLatestCatalogProgress({
				flush: snapshotWriter.flush,
				capture: currentProgressSnapshot,
				enqueue: (snapshot) => {
					if (persistenceAvailable) snapshotWriter.enqueue(snapshot);
				},
				download: (snapshot) =>
					downloadCatalogProgressFile(snapshot, catalogBackupFilename(snapshot.showAlias))
			});
			progressTransferMessage = 'Progress backup downloaded.';
		} catch {
			progressTransferError = 'The progress backup could not be downloaded.';
		} finally {
			progressTransferBusy = false;
		}
	};

	const chooseProgressBackup = () => {
		if (progressTransferBusy || scanning) return;
		progressFileInput?.click();
	};

	const restoreProgress = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = takeSelectedCatalogBackupFile(input);
		if (!file || progressTransferBusy || scanning) return;
		clearProgressTransferMessage();

		progressTransferBusy = true;
		const importAlias = activeShowAlias;
		const importGeneration = showGeneration;
		const importCatalog = data.episodes;
		let replacementStarted = false;
		let replacementSucceeded = false;
		try {
			const prepared = prepareCatalogBackupRestore(
				await readCatalogBackupFile(file),
				importAlias,
				importCatalog
			);
			if (
				destroyed ||
				!shouldApplyCatalogRestoration(
					importAlias,
					importGeneration,
					activeShowAlias,
					showGeneration
				)
			) {
				return;
			}
			replacementSucceeded = await restoreCatalogProgressIfConfirmed(prepared, {
				confirm: () =>
					window.confirm(
						'Restore this backup and replace the saved progress for the current show?'
					),
				beforePersist: () => {
					progressReplacementAlias = importAlias;
					replacementStarted = true;
					snapshotWriter.discardPending();
				},
				persist: saveCatalogProgress,
				apply: (restoredProgress) => {
					if (
						destroyed ||
						!shouldApplyCatalogRestoration(
							importAlias,
							importGeneration,
							activeShowAlias,
							showGeneration
						)
					) {
						return;
					}
					episodes = restoredProgress.episodes;
					playlistOrder = restoredProgress.playlistOrder;
					playlistTitle = restoredProgress.progress.playlist.title;
					playlistDescription = restoredProgress.progress.playlist.description;
					publicPlaylist = restoredProgress.progress.playlist.public;
					dateStamp = createGeneratedPlaylistText(
						data.name,
						data.episodes,
						playlistOrder
					).dateStamp;
					cooldownUntil = restoredProgress.retry.cooldownUntil;
					pausedByRateLimit = restoredProgress.retry.pausedByRateLimit;
					updateCooldownRemaining();
					persistenceAvailable = true;
					skipDestroyPersistence = false;
					scanMessage =
						pausedByRateLimit && cooldownRemaining > 0
							? 'Scan paused. Resume will become available when the cooldown ends.'
							: '';
					progressTransferMessage = 'Progress restored from backup.';
				}
			});
		} catch (cause) {
			if (
				shouldApplyCatalogRestoration(
					importAlias,
					importGeneration,
					activeShowAlias,
					showGeneration
				)
			) {
				progressTransferError =
					cause instanceof CatalogBackupValidationError
						? cause.message
						: 'The backup could not be saved. Existing progress was not changed.';
			}
		} finally {
			if (progressReplacementAlias === importAlias) progressReplacementAlias = undefined;
			progressTransferBusy = false;
			if (
				replacementStarted &&
				!replacementSucceeded &&
				shouldApplyCatalogRestoration(
					importAlias,
					importGeneration,
					activeShowAlias,
					showGeneration
				)
			) {
				void persistProgress();
			}
		}
	};

	const resetSavedProgress = async () => {
		if (!restored || progressTransferBusy || scanning) return;
		clearProgressTransferMessage();
		if (!window.confirm('Reset all saved catalogue progress for this show?')) return;
		progressTransferBusy = true;
		const resetAlias = activeShowAlias;
		progressReplacementAlias = resetAlias;
		snapshotWriter.discardPending();
		const resetGeneration = showGeneration;
		let resetSucceeded = false;
		try {
			await deleteCatalogProgress(resetAlias);
			resetSucceeded = true;
			if (
				destroyed ||
				!shouldApplyCatalogRestoration(resetAlias, resetGeneration, activeShowAlias, showGeneration)
			) {
				return;
			}
			const defaults = showDefaults(data);
			const resetState = createCatalogResetState(data.episodes, {
				title: defaults.title,
				description: defaults.description
			});
			episodes = resetState.episodes;
			playlistOrder = resetState.playlistOrder;
			playlistTitle = resetState.playlist.title;
			playlistDescription = resetState.playlist.description;
			publicPlaylist = resetState.playlist.public;
			dateStamp = defaults.stamp;
			cooldownUntil = resetState.retry.cooldownUntil;
			cooldownRemaining = 0;
			cooldownReason = 'rate-limited';
			pausedByRateLimit = resetState.retry.pausedByRateLimit;
			automaticRateLimitCount = 0;
			scanMessage = '';
			persistenceAvailable = true;
			skipDestroyPersistence = true;
			progressTransferMessage = 'Saved progress reset for this show.';
		} catch {
			if (
				shouldApplyCatalogRestoration(resetAlias, resetGeneration, activeShowAlias, showGeneration)
			) {
				progressTransferError =
					'Saved progress could not be reset. Existing progress was not changed.';
			}
		} finally {
			if (progressReplacementAlias === resetAlias) progressReplacementAlias = undefined;
			progressTransferBusy = false;
			if (
				!resetSucceeded &&
				shouldApplyCatalogRestoration(resetAlias, resetGeneration, activeShowAlias, showGeneration)
			) {
				void persistProgress();
			}
		}
	};

	let rawSelectedTracks: string[] = [];
	let selectedTracks: string[] = [];
	let duplicateCount = 0;
	let summaryCounts = { scanned: 0, pending: 0, failed: 0 };
	let completedCount = 0;
	let failedCount = 0;
	let pendingCount = 0;
	let uncertainCount = 0;
	let progressLabel = '';
	$: rawSelectedTracks = episodes.flatMap((episode) =>
		episode.tracks
			.filter((track) => track.checked && track.selectedMatch)
			.map((track) => track.selectedMatch as string)
	);
	$: selectedTracks = getCatalogExportUris(episodes, playlistOrder);
	$: duplicateCount = rawSelectedTracks.length - selectedTracks.length;
	$: summaryCounts = getCatalogSummaryCounts(episodes);
	$: completedCount = summaryCounts.scanned;
	$: failedCount = summaryCounts.failed;
	$: pendingCount = summaryCounts.pending;
	$: uncertainCount = episodes.reduce(
		(total, episode) => total + episode.tracks.filter(({ confident }) => !confident).length,
		0
	);
	$: scanComplete = completedCount === episodes.length;
	$: progressLabel = `${completedCount} scanned · ${pendingCount} pending · ${failedCount} failed`;

	const episodeStatus = (episode: EpisodeState) => {
		if (episode.status === 'pending') return 'Waiting';
		if (episode.status === 'scanning') return 'Scanning…';
		if (episode.status === 'done') return `${episode.tracks.length} tracks`;
		if (episode.status === 'rate-limited')
			return cooldownRemaining > 0
				? `Spotify cooldown: ${formatCooldownDuration(cooldownRemaining)} remaining`
				: 'Spotify rate limited';
		return episode.error || 'Could not scan this episode.';
	};

	const initializeShow = async (pageData: PageData) => {
		scanController?.abort();
		abortActiveEpisodes();
		activeEpisodeControllers.clear();
		showGeneration += 1;
		const generation = showGeneration;
		const showAlias = pageData.showAlias;
		activeShowAlias = showAlias;
		skipDestroyPersistence = false;
		clearProgressTransferMessage();
		const defaults = showDefaults(pageData);
		firstEpisode = defaults.first;
		lastEpisode = defaults.last;
		dateStamp = defaults.stamp;
		playlistTitle = defaults.title;
		playlistDescription = defaults.description;
		publicPlaylist = false;
		playlistOrder = 'latest-first';
		episodes = reconcileEpisodes(pageData.episodes);
		scanning = false;
		scanController = undefined;
		scanMessage = '';
		restored = false;
		persistenceAvailable = true;
		cooldownUntil = 0;
		cooldownRemaining = 0;
		cooldownReason = 'rate-limited';
		pausedByRateLimit = false;
		cancelRequested = false;
		automaticRateLimitCount = 0;

		try {
			const saved = await loadCatalogProgress(showAlias);
			if (
				destroyed ||
				!shouldApplyCatalogRestoration(showAlias, generation, activeShowAlias, showGeneration)
			) {
				return;
			}
			episodes = reconcileEpisodes(pageData.episodes, saved);
			if (isCatalogProgressCompatible(saved)) {
				playlistOrder = restoreCatalogPlaylistOrder(saved);
				dateStamp = createGeneratedPlaylistText(
					pageData.name,
					pageData.episodes,
					playlistOrder
				).dateStamp;
				playlistTitle = saved.playlist.title;
				playlistDescription = saved.playlist.description;
				publicPlaylist = saved.playlist.public;
			}
			const retry = restoreCatalogRetryState(saved);
			cooldownUntil = retry.cooldownUntil;
			cooldownReason = 'rate-limited';
			pausedByRateLimit = retry.pausedByRateLimit;
			updateCooldownRemaining();
			if (pausedByRateLimit && cooldownRemaining > 0) {
				scanMessage = 'Scan paused. Resume will become available when the cooldown ends.';
			} else if (
				episodes.some(({ status }) => status === 'done') &&
				episodes.some(({ status }) => status !== 'done')
			) {
				scanMessage = 'Saved progress restored. Click Resume scan to continue.';
			}
		} catch {
			if (
				destroyed ||
				!shouldApplyCatalogRestoration(showAlias, generation, activeShowAlias, showGeneration)
			) {
				return;
			}
			persistenceAvailable = false;
			scanMessage = 'Progress cannot be saved in this browser.';
		} finally {
			if (
				!destroyed &&
				shouldApplyCatalogRestoration(showAlias, generation, activeShowAlias, showGeneration)
			) {
				restored = true;
			}
		}
	};

	onMount(() => {
		mounted = true;
		void initializeShow(data);
		cooldownTimer = setInterval(updateCooldownRemaining, 1000);
	});

	$: if (mounted && data.showAlias !== activeShowAlias) void initializeShow(data);

	onDestroy(() => {
		destroyed = true;
		showGeneration += 1;
		if (cooldownTimer) clearInterval(cooldownTimer);
		for (const episode of episodes) {
			if (episode.status === 'scanning' || episode.status === 'rate-limited') {
				episode.status = 'pending';
				episode.error = undefined;
			}
		}
		scanController?.abort();
		abortActiveEpisodes();
		if (!skipDestroyPersistence) void persistProgress();
	});
</script>

<Panel padded={false}>
	<article>
		<header>
			<h1 class="font-title">{data.name}: full catalogue</h1>
			<p class="font-base">{data.description}</p>
			<div class="summary font-small-beast">
				<Badge>{episodes.length} episodes</Badge>
				{#if firstEpisode && lastEpisode}
					<Badge>{shortDate(firstEpisode.broadcast)} → {shortDate(lastEpisode.broadcast)}</Badge>
				{/if}
			</div>
			<Divider />

			{#if !data.user}
				<div class="login-note">
					<p class="font-base">Log in first so your review is not lost in a page reload later.</p>
					<LoginWithSpotify label="Login with Spotify" />
				</div>
			{:else}
				<div class="scan-controls">
					<Button
						on:click={() => scanCatalog()}
						loading={scanning}
						disabled={!restored ||
							scanning ||
							progressTransferBusy ||
							scanComplete ||
							cooldownRemaining > 0}
					>
						{completedCount === 0 ? 'Scan full catalogue' : 'Resume scan'}
					</Button>
					{#if scanning}
						<Button variant="outline" on:click={cancelScan}>Cancel scan</Button>
					{/if}
					<p class="font-small-beast">{progressLabel}</p>
				</div>
				{#if spotifySessionMetrics}
					<p class="font-small-beast">
						This server session: {spotifySessionMetrics.searchRequests} Spotify searches · {spotifySessionMetrics.cacheHits}
						cached/coalesced results · {spotifySessionMetrics.transientRetries} transient retries
					</p>
					<p class="font-tiny">This is usage observed by this app, not Spotify quota remaining.</p>
				{/if}
				{#if cooldownRemaining > 0}
					<p class="font-base">
						{formatSpotifyCooldownMessage(cooldownReason, cooldownRemaining)}
					</p>
					{#if cooldownReason === 'quota-exceeded'}
						<p class="font-small-beast">
							Spotify does not expose the remaining quota or its numerical limit.
						</p>
					{/if}
				{/if}
			{/if}
			{#if scanMessage}<p class="font-base">{scanMessage}</p>{/if}
			{#if !persistenceAvailable}
				<p class="font-small-beast">Progress persistence is unavailable.</p>
			{/if}
		</header>

		{#if restored}
			<section class="settings">
				<label class="font-small-beast">
					Playlist name
					<input bind:value={playlistTitle} on:input={captureAndPersistReview} maxlength="100" />
				</label>
				<label class="font-small-beast">
					Description
					<textarea
						bind:value={playlistDescription}
						on:input={captureAndPersistReview}
						maxlength="300"
						rows="4"
					/>
				</label>
				<label class="font-small-beast">
					PLAYLIST ORDER
					<select
						value={playlistOrder}
						on:change={changePlaylistOrder}
						aria-describedby="playlist-order-help"
					>
						<option value="latest-first">Latest episodes first</option>
						<option value="oldest-first">Oldest episodes first</option>
					</select>
					<span id="playlist-order-help" class="playlist-order-help font-tiny">
						<strong>This choice controls the track order in the Spotify playlist.</strong> Tracks within
						each episode keep their original order. The catalogue below remains oldest to newest for
						review.
					</span>
				</label>
				<label class="visibility font-base">
					<input
						type="checkbox"
						bind:checked={publicPlaylist}
						on:change={captureAndPersistReview}
					/>
					Make playlist public
				</label>
				<div class="progress-actions" aria-label="Catalogue progress backup controls">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={progressTransferBusy}
						on:click={downloadProgress}>Download progress</Button
					>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={progressTransferBusy || scanning}
						on:click={chooseProgressBackup}>Restore progress</Button
					>
					<input
						bind:this={progressFileInput}
						type="file"
						accept=".json,application/json"
						aria-label="Choose catalogue progress backup JSON file"
						on:change={restoreProgress}
						hidden
					/>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={progressTransferBusy || scanning}
						on:click={resetSavedProgress}>Reset saved progress</Button
					>
				</div>
				{#if progressTransferMessage}
					<p class="progress-transfer-message font-small-beast" role="status">
						{progressTransferMessage}
					</p>
				{/if}
				{#if progressTransferError}
					<p class="progress-transfer-message font-small-beast" role="alert">
						{progressTransferError}
					</p>
				{/if}
				<p class="font-small-beast">
					{uncertainCount} tracks need review · {duplicateCount} exact duplicate{duplicateCount ===
					1
						? ''
						: 's'} removed
				</p>
			</section>
		{/if}

		<div class="episodes">
			{#each episodes as episode, episodeIndex}
				<section class="episode">
					<div class="episode-heading">
						<div>
							<p class="font-tiny">Episode {episodeIndex + 1} · {shortDate(episode.broadcast)}</p>
							<h2 class="font-base">{episode.name}</h2>
						</div>
						<p class="font-small-beast">{episodeStatus(episode)}</p>
					</div>

					{#if episode.status === 'error' && !scanning}
						<div class="retry">
							<Button size="sm" variant="outline" on:click={() => scanCatalog([episodeIndex])}
								>Retry</Button
							>
						</div>
					{/if}

					{#if episode.status === 'done' && episode.tracks.length === 0}
						<p class="empty font-small-beast">No published NTS tracklist.</p>
					{:else if episode.tracks.length > 0}
						<div class="tracks">
							{#each episode.tracks as track}
								<Track
									bind:checked={track.checked}
									bind:selectedMatch={track.selectedMatch}
									on:reviewchange={captureAndPersistReview}
									original={{ artist: track.artist, title: track.title }}
									matches={track.matches}
								/>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	</article>

	<ImportToSpotify
		disabled={!scanComplete || scanning}
		data={{
			title: playlistTitle,
			description: playlistDescription,
			date: dateStamp,
			cover: data.cover,
			tracks: selectedTracks,
			public: publicPlaylist
		}}
	/>
</Panel>

<style lang="postcss">
	header,
	.settings {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;

		@media (--md) {
			padding: 40px;
			padding-bottom: 24px;
		}
	}

	.summary,
	.scan-controls,
	.login-note,
	.visibility,
	.progress-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.settings {
		border-top: 1px solid var(--color-foreground);
		border-bottom: 1px solid var(--color-foreground);
		background: lightgoldenrodyellow;
	}

	.settings label:not(.visibility) {
		display: flex;
		flex-direction: column;
		gap: 6px;
		text-transform: uppercase;
	}

	.settings textarea,
	.settings label:not(.visibility) input,
	.settings select {
		font: inherit;
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-foreground);
		padding: 10px;
		resize: vertical;
	}

	.settings select {
		text-transform: none;
	}

	.playlist-order-help {
		color: var(--color-foreground);
		line-height: 1.5;
		margin-top: 4px;
		text-transform: none;
	}

	.progress-transfer-message {
		margin: 0;
	}

	.episodes {
		display: flex;
		flex-direction: column;
	}

	.episode {
		border-bottom: 1px solid var(--color-foreground);
	}

	.episode-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		padding: 16px 24px;
		background: hsla(var(--color-foreground-hsl) / 0.04);

		@media (--md) {
			padding-inline: 40px;
		}
	}

	.episode-heading p:first-child {
		opacity: 0.55;
		margin-bottom: 4px;
	}

	.tracks {
		counter-reset: track;
	}

	.retry,
	.empty {
		padding: 12px 24px;

		@media (--md) {
			padding-inline: 40px;
		}
	}

	article {
		padding-bottom: calc(44px + 40px);
	}
</style>
