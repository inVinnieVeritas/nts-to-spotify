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
		captureCatalogProgress,
		formatCooldownDuration,
		getCatalogSummaryCounts,
		getResumableEpisodeIndexes,
		isCatalogProgressCompatible,
		reconcileEpisodes,
		restoreCatalogRetryState,
		runCatalogWorkers,
		shouldApplyCatalogRestoration,
		uniqueSpotifyUris,
		type CatalogScanOutcome,
		type EpisodeState
	} from '$lib/utils/catalog-scan';
	import {
		createLatestSnapshotWriter,
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

	const longDate = (date: string) =>
		new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(date));

	const showDefaults = (pageData: PageData) => {
		const first = pageData.episodes[0];
		const last = pageData.episodes[pageData.episodes.length - 1];
		const stamp = first && last ? `${shortDate(last.broadcast)}→${shortDate(first.broadcast)}` : '';
		return {
			first,
			last,
			stamp,
			title: `“${pageData.name.toLowerCase()}” ${stamp}`,
			description:
				first && last
					? `“${pageData.name.toLowerCase()}” ${stamp} — A comprehensive archive of tracks played on ${
							pageData.name
					  } on NTS Radio, covering broadcasts from ${longDate(
							first.broadcast
					  )} through ${longDate(
							last.broadcast
					  )}. Some tracks unavailable on Spotify may be missing.`
					: `Tracks played on ${pageData.name} on NTS Radio. Some tracks unavailable on Spotify may be missing.`
		};
	};

	const initialDefaults = showDefaults(data);
	let firstEpisode = initialDefaults.first;
	let lastEpisode = initialDefaults.last;
	let dateStamp = initialDefaults.stamp;
	let playlistTitle = initialDefaults.title;
	let playlistDescription = initialDefaults.description;
	let publicPlaylist = false;
	let scanning = false;
	let scanMessage = '';
	let restored = false;
	let persistenceAvailable = true;
	let cooldownUntil = 0;
	let cooldownRemaining = 0;
	let pausedByRateLimit = false;
	let cancelRequested = false;
	let automaticRateLimitCount = 0;
	let scanController: AbortController | undefined;
	let cooldownTimer: ReturnType<typeof setInterval> | undefined;
	let mounted = false;
	let destroyed = false;
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

	const persistProgress = (waitForSave = false) => {
		if (!restored || !persistenceAvailable) return Promise.resolve();
		const snapshot = captureCatalogProgress(
			activeShowAlias,
			episodes,
			{
				title: playlistTitle,
				description: playlistDescription,
				public: publicPlaylist
			},
			{ cooldownUntil, pausedByRateLimit }
		);
		snapshotWriter.enqueue(snapshot);
		return waitForSave ? snapshotWriter.flush() : Promise.resolve();
	};

	const captureAndPersistReview = () => void persistProgress();

	const parseClientRetryAfter = (response: Response, payload: unknown) => {
		const fromPayload =
			payload && typeof payload === 'object' && 'retryAfterSeconds' in payload
				? Number((payload as { retryAfterSeconds: unknown }).retryAfterSeconds)
				: Number.NaN;
		const fromHeader = Number(response.headers.get('Retry-After'));
		const seconds = Number.isFinite(fromPayload) ? fromPayload : fromHeader;
		return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds)) : 1;
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
				const retryAfterSeconds = parseClientRetryAfter(response, payload);
				cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterSeconds * 1000);
				cooldownRemaining = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
				episodes[index].status = 'rate-limited';
				episodes[index].error = 'Waiting for Spotify';
				episodes = episodes;
				void persistProgress();
				return {
					type: 'rate-limited',
					retryAfterSeconds,
					requiresManualResume: retryAfterSeconds > LONG_RETRY_AFTER_SECONDS
				};
			}
			if (!response.ok) throw new Error(`Request failed (${response.status})`);

			const result = (await response.json()) as { tracks: MatchedTrack[] };
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
		if (scanning || !restored) return;
		updateCooldownRemaining();
		if (cooldownRemaining > 0) {
			scanMessage = `Spotify rate limit: ${formatCooldownDuration(cooldownRemaining)} remaining.`;
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
			}
		}).catch(() => undefined);
		if (currentGeneration !== showGeneration || currentShowAlias !== activeShowAlias) return;
		for (const episode of episodes) {
			if (episode.status === 'scanning' || episode.status === 'rate-limited') {
				episode.status = 'pending';
				episode.error = undefined;
			}
		}
		episodes = episodes;
		scanning = false;
		updateCooldownRemaining();
		if (cancelRequested) scanMessage = 'Scan cancelled. Completed episodes were saved.';
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
	$: selectedTracks = uniqueSpotifyUris(rawSelectedTracks);
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
		const defaults = showDefaults(pageData);
		firstEpisode = defaults.first;
		lastEpisode = defaults.last;
		dateStamp = defaults.stamp;
		playlistTitle = defaults.title;
		playlistDescription = defaults.description;
		publicPlaylist = false;
		episodes = reconcileEpisodes(pageData.episodes);
		scanning = false;
		scanController = undefined;
		scanMessage = '';
		restored = false;
		persistenceAvailable = true;
		cooldownUntil = 0;
		cooldownRemaining = 0;
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
				playlistTitle = saved.playlist.title;
				playlistDescription = saved.playlist.description;
				publicPlaylist = saved.playlist.public;
			}
			const retry = restoreCatalogRetryState(saved);
			cooldownUntil = retry.cooldownUntil;
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
		void persistProgress();
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
						disabled={!restored || scanning || scanComplete || cooldownRemaining > 0}
					>
						{completedCount === 0 ? 'Scan full catalogue' : 'Resume scan'}
					</Button>
					{#if scanning}
						<Button variant="outline" on:click={cancelScan}>Cancel scan</Button>
					{/if}
					<p class="font-small-beast">{progressLabel}</p>
				</div>
				{#if cooldownRemaining > 0}
					<p class="font-base">
						Spotify rate limit: {formatCooldownDuration(cooldownRemaining)} remaining.
					</p>
				{/if}
			{/if}
			{#if scanMessage}<p class="font-base">{scanMessage}</p>{/if}
			{#if !persistenceAvailable}
				<p class="font-small-beast">Progress persistence is unavailable.</p>
			{/if}
		</header>

		{#if completedCount > 0}
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
				<label class="visibility font-base">
					<input
						type="checkbox"
						bind:checked={publicPlaylist}
						on:change={captureAndPersistReview}
					/>
					Make playlist public
				</label>
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
	.visibility {
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
	.settings label:not(.visibility) input {
		font: inherit;
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-foreground);
		padding: 10px;
		resize: vertical;
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
