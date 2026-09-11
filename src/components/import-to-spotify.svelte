<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button } from '$components';
	import {
		formatCooldownDuration,
		isSpotifyPlaylistId,
		parseSpotifyPlaylistId,
		spotifyPlaylistUrl,
		uniqueSpotifyUris
	} from '$lib/utils/catalog-scan';
	import {
		createPlaylistPreviewInputSignature,
		dismissPlaylistPreview,
		parseSpotifyPlaylistPreview,
		runExclusivePlaylistAction,
		type ClientSpotifyPlaylistPreview
	} from '$lib/utils/playlist-preview.client';
	import {
		CATALOG_PLAYLIST_SYNC_VERSION,
		PLAYLIST_SYNC_LEASE_MS,
		createPlaylistSyncOperationId,
		fingerprintPlaylistSyncTarget,
		persistCreatedPlaylistBeforeSync,
		playlistSyncFeedback,
		playlistSyncRecordStamp,
		latestPlaylistSyncRecord,
		createPlaylistSyncPreviewGuard,
		playlistSyncEligibility,
		parsePlaylistSyncApiFailure,
		safePlaylistRetryDeadline,
		requestPlaylistJson,
		runPlaylistSyncBatches,
		type CatalogPlaylistSyncRecord,
		type PlaylistSyncTarget
	} from '$lib/utils/playlist-sync.client';
	import {
		claimCatalogPlaylistSyncLease,
		deleteCatalogPlaylistSync
	} from '$lib/utils/catalog-progress.client';
	import LoginWithSpotify from './login-with-spotify.svelte';

	export let disabled = false;
	export let catalogueMode = false;
	export let showAlias = '';
	export let creationPending = false;
	export let syncRecord: CatalogPlaylistSyncRecord | undefined = undefined;
	export let onSyncRecordChange:
		((record: CatalogPlaylistSyncRecord | undefined) => void) | undefined = undefined;
	export let prepareCatalogueCreation: (() => Promise<boolean>) | undefined = undefined;
	export let persistCatalogueLink: ((playlistId: string) => Promise<boolean>) | undefined =
		undefined;
	export let clearCatalogueCreationPending: (() => Promise<boolean>) | undefined = undefined;
	export let forgetCatalogueLink: (() => Promise<boolean>) | undefined = undefined;
	export let data: {
		title: string;
		description: string;
		date: string;
		cover: string;
		tracks: string[];
		public?: boolean;
		linkedPlaylistId?: string;
		previewKey?: string;
	};

	const me = $page.data.user;
	let working = false;
	let message = '';
	let failure = '';
	let responsePlaylistId: string | undefined;
	let recoveryValue = '';
	let preview: ClientSpotifyPlaylistPreview | undefined;
	let previewSyncStamp: string | undefined;
	const previewGuard = createPlaylistSyncPreviewGuard();
	let localSyncRecord: CatalogPlaylistSyncRecord | undefined;
	let syncNow = Date.now();
	let syncTimer: ReturnType<typeof setInterval> | undefined;
	let playlistController: AbortController | undefined;
	let disposed = false;
	const primaryActionGate = { active: false };
	let tabOwner = '';
	onMount(() => {
		// Fresh in-memory identity: duplicated tabs cannot inherit ownership.
		tabOwner = createPlaylistSyncOperationId();
		syncTimer = setInterval(() => (syncNow = Date.now()), 1000);
	});
	onDestroy(() => {
		disposed = true;
		previewGuard.invalidate();
		if (syncTimer) clearInterval(syncTimer);
		playlistController?.abort();
	});
	$: localSyncRecord = latestPlaylistSyncRecord(localSyncRecord, syncRecord);
	$: syncEligibility = playlistSyncEligibility(localSyncRecord, tabOwner, syncNow);
	$: linkedPlaylistId = isSpotifyPlaylistId(data.linkedPlaylistId)
		? data.linkedPlaylistId
		: catalogueMode
			? undefined
			: responsePlaylistId;
	$: playlistUrl = linkedPlaylistId ? spotifyPlaylistUrl(linkedPlaylistId) : '';
	$: syncPaused = Boolean(
		localSyncRecord?.phase === 'paused' &&
		localSyncRecord.retryUntil &&
		localSyncRecord.retryUntil > syncNow
	);
	$: resumableSync = Boolean(
		catalogueMode &&
		linkedPlaylistId &&
		localSyncRecord &&
		localSyncRecord.playlistId === linkedPlaylistId &&
		localSyncRecord.phase !== 'completed' &&
		!(localSyncRecord.phase === 'blocked' && localSyncRecord.reason !== 'uncertain')
	);
	$: inputSignature = createPlaylistPreviewInputSignature({
		playlistId: linkedPlaylistId,
		title: data.title,
		description: data.description,
		public: data.public ?? true,
		tracks: data.tracks,
		previewKey: data.previewKey
	});
	$: if (
		preview &&
		(preview.inputSignature !== inputSignature ||
			previewSyncStamp !== playlistSyncRecordStamp(localSyncRecord))
	) {
		preview = undefined;
		previewSyncStamp = undefined;
		message = '';
		failure = '';
	}
	$: syncFeedback = playlistSyncFeedback(
		localSyncRecord,
		preview,
		inputSignature,
		previewSyncStamp,
		tabOwner,
		syncNow
	);
	$: buttonLabel = catalogueMode
		? linkedPlaylistId
			? resumableSync
				? syncEligibility.label
				: preview && !preview.synchronized
					? 'Apply Spotify update'
					: 'Preview Spotify update'
			: creationPending
				? 'Creation outcome pending'
				: 'Create Spotify playlist'
		: 'Import to Spotify';

	const failureMessage = (payload: unknown) => {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return 'Spotify playlist synchronization failed. Please try again.';
		}
		const error = (payload as Record<string, unknown>).error;
		if (error === 'playlist_not_owned') return 'This Spotify playlist is owned by another user.';
		if (error === 'playlist_not_found') {
			return 'The linked Spotify playlist no longer exists. Forget the link before creating another.';
		}
		if (error === 'playlist_inaccessible') {
			return 'The linked Spotify playlist is inaccessible. Check your Spotify account or forget the link.';
		}
		if (error === 'playlist_changed_since_preview') {
			return 'Spotify playlist changed. Preview it again.';
		}
		if (error === 'spotify_authentication') {
			return (payload as Record<string, unknown>).incomplete === true
				? 'Spotify login expired during synchronization. The linked playlist was retained; log in again and retry.'
				: 'Spotify login expired. Log in again and retry.';
		}
		if (error === 'spotify_rate_limited') {
			const retryAfter = (payload as Record<string, unknown>).retryAfterSeconds;
			const prefix =
				(payload as Record<string, unknown>).incomplete === true
					? 'Spotify rate limited synchronization. The linked playlist was retained.'
					: 'Spotify rate limited this request.';
			return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
				? `${prefix} Retry in ${formatCooldownDuration(retryAfter)}.`
				: 'Spotify rate limited this request. Please retry later.';
		}
		if (error === 'playlist_sync_incomplete') {
			return 'Playlist synchronization was incomplete. The linked playlist was retained and can be safely retried.';
		}
		if (error === 'playlist_creation_unknown') {
			return 'Spotify may have created the playlist, but the result could not be confirmed. Check Spotify before continuing.';
		}
		if (error === 'invalid_request') return 'The playlist settings or selected tracks are invalid.';
		return 'Spotify playlist synchronization failed. Please try again.';
	};

	const persistReturnedLink = async (playlistId: string) => {
		if (disposed) return false;
		responsePlaylistId = playlistId;
		if (!catalogueMode) return true;
		if (data.linkedPlaylistId === playlistId) return true;
		return (await persistCatalogueLink?.(playlistId)) === true;
	};

	const clearKnownCreation = async (creatingNew: boolean) => {
		if (!catalogueMode || !creatingNew) return true;
		return (await clearCatalogueCreationPending?.()) === true;
	};

	const playlistTarget = (): PlaylistSyncTarget => ({
		name: data.title.trim(),
		description: data.description,
		tracks: uniqueSpotifyUris(data.tracks),
		public: data.public ?? true
	});
	const persistSyncRecord = async (record: CatalogPlaylistSyncRecord) => {
		const controller = playlistController;
		if (disposed || record.catalogueAlias !== (showAlias || 'single-episode'))
			throw new Error('Synchronization component changed');
		let persisted = record;
		if (catalogueMode && showAlias) {
			const releaseLease =
				['paused', 'interrupted', 'uncertain', 'blocked', 'completed', 'failed'].includes(
					record.phase
				) ||
				(record.phase === 'settling' && Boolean(record.retryUntil));
			const claimed = await claimCatalogPlaylistSyncLease(
				record,
				tabOwner,
				Date.now(),
				PLAYLIST_SYNC_LEASE_MS,
				{},
				releaseLease
			);
			if (!claimed.acquired || !claimed.record) {
				throw new Error('Playlist synchronization lease was lost');
			}
			persisted = claimed.record;
		}
		if (disposed || controller !== playlistController)
			throw new Error('Synchronization component changed');
		localSyncRecord = latestPlaylistSyncRecord(localSyncRecord, persisted);
		onSyncRecordChange?.(localSyncRecord);
		return persisted;
	};
	const removeSyncRecord = async () => {
		if (catalogueMode && showAlias) await deleteCatalogPlaylistSync(showAlias);
		localSyncRecord = undefined;
		onSyncRecordChange?.(undefined);
	};
	const requestApi = (body: unknown, signal?: AbortSignal) => {
		if (disposed) throw new Error('Synchronization component changed');
		return requestPlaylistJson<Record<string, unknown>>(fetch, body, signal);
	};
	const requestPreview = async (
		playlistId: string,
		target: PlaylistSyncTarget,
		signal?: AbortSignal
	) => {
		const requestedSignature = createPlaylistPreviewInputSignature({
			playlistId,
			title: target.name,
			description: target.description,
			public: target.public,
			tracks: target.tracks,
			previewKey: data.previewKey
		});
		const { response, body } = await requestApi(
			{
				operation: 'preview',
				playlistId,
				name: target.name,
				description: target.description,
				public: target.public,
				tracks: target.tracks
			},
			signal
		);
		if (!response.ok) return { response, body, parsed: undefined };
		return {
			response,
			body,
			parsed: parseSpotifyPlaylistPreview(body, playlistId, requestedSignature)
		};
	};

	const previewPlaylist = async () => {
		if (!me || working || !linkedPlaylistId) return;
		const requestedSignature = inputSignature;
		const ticket = previewGuard.begin(requestedSignature, localSyncRecord);
		working = true;
		preview = undefined;
		previewSyncStamp = undefined;
		failure = '';
		message = 'Previewing Spotify update…';
		const controller = new AbortController();
		playlistController = controller;
		const current = () =>
			!disposed &&
			playlistController === controller &&
			previewGuard.isCurrent(ticket, inputSignature, localSyncRecord);
		try {
			const {
				response,
				body: result,
				parsed
			} = await requestPreview(linkedPlaylistId, playlistTarget(), controller.signal);
			if (!current()) return;
			if (!response.ok) {
				failure =
					result?.error === 'spotify_unavailable'
						? 'Preview failed. Try again.'
						: failureMessage(result);
				message = '';
				return;
			}
			if (!parsed || inputSignature !== requestedSignature) {
				failure = parsed ? '' : 'Spotify returned an invalid preview. Try again.';
				message = '';
				return;
			}
			preview = parsed;
			previewSyncStamp = ticket.stamp;
			failure = '';
			message = '';
		} catch {
			if (!current()) return;
			failure = 'Preview failed. Try again.';
			message = '';
		} finally {
			if (!disposed && playlistController === controller) {
				if (!current()) message = '';
				playlistController = undefined;
				working = false;
			}
		}
	};

	const synchronizePlaylist = async () => {
		if (!me || working || !tabOwner || syncEligibility.disabled) return;
		const creatingNew = !linkedPlaylistId;
		if (catalogueMode && creatingNew && creationPending) return;
		if (linkedPlaylistId && !resumableSync && (!preview || preview.synchronized)) return;
		const requestedSignature = inputSignature;

		working = true;
		previewGuard.invalidate();
		const controller = new AbortController();
		playlistController = controller;
		failure = '';
		message = linkedPlaylistId ? 'Applying Spotify update…' : 'Creating Spotify playlist…';
		if (
			catalogueMode &&
			creatingNew &&
			(await prepareCatalogueCreation?.().catch(() => false)) !== true
		) {
			failure = 'Progress could not be saved, so no Spotify playlist was created.';
			controller.abort();
			if (playlistController === controller) playlistController = undefined;
			working = false;
			return;
		}

		try {
			const target = playlistTarget();
			const initialPlaylistId = linkedPlaylistId ?? '0000000000000000000000';
			let targetFingerprint = await fingerprintPlaylistSyncTarget(initialPlaylistId, target);
			const timestamp = Date.now();
			const previous =
				linkedPlaylistId &&
				localSyncRecord?.playlistId === linkedPlaylistId &&
				localSyncRecord.targetFingerprint === targetFingerprint &&
				localSyncRecord.phase !== 'completed'
					? localSyncRecord
					: undefined;
			if (
				localSyncRecord &&
				localSyncRecord.targetFingerprint !== targetFingerprint &&
				localSyncRecord.phase !== 'completed' &&
				!(localSyncRecord.phase === 'blocked' && localSyncRecord.reason === 'external-change')
			) {
				failure =
					'Restore the synchronization target before continuing. An unfinished operation cannot be replaced with different selections or settings.';
				return;
			}
			let record: CatalogPlaylistSyncRecord =
				previous && previous.phase !== 'blocked'
					? previous
					: {
							version: CATALOG_PLAYLIST_SYNC_VERSION,
							revision: localSyncRecord?.revision ?? 0,
							catalogueAlias: showAlias || 'single-episode',
							operationId: previous?.operationId ?? createPlaylistSyncOperationId(),
							...(linkedPlaylistId ? { playlistId: linkedPlaylistId } : {}),
							targetFingerprint,
							totalTrackCount: target.tracks.length,
							confirmedPosition: 0,
							phase: creatingNew ? 'creating' : 'interrupted',
							mode: creatingNew ? 'created' : 'updated',
							startedAt: previous?.startedAt ?? timestamp,
							updatedAt: timestamp,
							...(creatingNew ? {} : { restartRequired: true })
						};
			if (catalogueMode && showAlias) {
				const claimed = await claimCatalogPlaylistSyncLease(
					record,
					tabOwner,
					Date.now(),
					PLAYLIST_SYNC_LEASE_MS
				);
				if (!claimed.acquired || !claimed.record) {
					if (claimed.record) {
						localSyncRecord = claimed.record;
						onSyncRecordChange?.(claimed.record);
					}
					failure =
						'Synchronization state changed or is active elsewhere. Reopen this catalogue to read its current state.';
					return;
				}
				record = claimed.record;
				localSyncRecord = record;
				onSyncRecordChange?.(record);
			}

			let activePlaylistId = linkedPlaylistId;
			if (!activePlaylistId) {
				const { response, body } = await requestApi(
					{
						operation: 'create',
						name: target.name,
						description: target.description,
						public: target.public
					},
					controller.signal
				);
				if (!response.ok) {
					const errorName = typeof body?.error === 'string' ? body.error : undefined;
					const knownFailure =
						!response.ok &&
						errorName !== undefined &&
						['invalid_request', 'spotify_authentication', 'spotify_rate_limited'].includes(
							errorName
						);
					if (knownFailure) {
						await removeSyncRecord();
						await clearKnownCreation(catalogueMode);
					}
					failure =
						response.ok || !knownFailure
							? 'Spotify may have created the playlist, but returned an invalid response. Check Spotify before continuing.'
							: failureMessage(body);
					return;
				}
				activePlaylistId = await persistCreatedPlaylistBeforeSync(body, persistReturnedLink);
				if (!activePlaylistId) {
					failure =
						'Spotify returned an invalid playlist response or the link could not be saved. No tracks were added; check Spotify before continuing.';
					return;
				}
				targetFingerprint = await fingerprintPlaylistSyncTarget(activePlaylistId, target);
				record = {
					...record,
					playlistId: activePlaylistId,
					targetFingerprint,
					phase: 'interrupted',
					restartRequired: true,
					updatedAt: Date.now()
				};
				record = await persistSyncRecord(record);
			}

			let previewFingerprint: string | undefined;
			if (
				(record.confirmedPosition === 0 || record.restartRequired) &&
				!['uncertain', 'dispatching'].includes(record.phase)
			) {
				message = 'Previewing Spotify state before synchronization…';
				const previewResult =
					preview && preview.inputSignature === inputSignature
						? { response: new Response(null), body: null, parsed: preview }
						: await requestPreview(activePlaylistId, target, controller.signal);
				if (!previewResult.response.ok || !previewResult.parsed) {
					const failed = await parsePlaylistSyncApiFailure(
						new Response(JSON.stringify(previewResult.body), {
							status: previewResult.response.status
						})
					);
					record = {
						...record,
						phase: failed.retryAfterSeconds ? 'paused' : 'interrupted',
						reason: failed.retryAfterSeconds
							? 'rate-limit'
							: failed.error === 'spotify_authentication'
								? 'authentication'
								: 'unavailable',
						retryUntil: failed.retryAfterSeconds
							? safePlaylistRetryDeadline(failed.retryAfterSeconds)
							: undefined,
						updatedAt: Date.now()
					};
					await persistSyncRecord(record);
					message = '';
					return;
				}
				previewFingerprint = previewResult.parsed.previewFingerprint;
			}
			message = '';
			const outcome = await runPlaylistSyncBatches({
				record,
				target,
				previewFingerprint,
				previewInputSignature: requestedSignature,
				request: requestApi,
				persist: async (next) => {
					const saved = await persistSyncRecord(next);
					message = '';
					return saved;
				},
				signal: controller.signal
			});
			if (disposed || playlistController !== controller) return;
			if (outcome.type === 'completed') {
				message = `Spotify playlist ${outcome.record.mode === 'created' ? 'created' : 'updated'} with ${outcome.record.totalTrackCount.toLocaleString('en-US')} unique tracks.`;
				preview = undefined;
			} else {
				preview =
					outcome.type === 'interrupted' && inputSignature === requestedSignature
						? outcome.readOnlyPreview
						: undefined;
				previewSyncStamp = preview ? playlistSyncRecordStamp(localSyncRecord) : undefined;
				failure =
					outcome.type === 'interrupted' &&
					['playlist_not_owned', 'playlist_not_found', 'playlist_inaccessible'].includes(
						outcome.error
					)
						? failureMessage({ error: outcome.error, incomplete: true })
						: '';
				message = '';
			}
		} catch {
			if (disposed || playlistController !== controller) return;
			failure = creatingNew
				? 'Spotify may have created the playlist, but the connection ended before it was confirmed. Check Spotify before continuing.'
				: 'Spotify playlist synchronization failed. Please try again.';
		} finally {
			if (!disposed && playlistController === controller) {
				if (failure) message = '';
				playlistController = undefined;
				working = false;
			}
		}
	};

	const handleClick = () =>
		runExclusivePlaylistAction(primaryActionGate, () =>
			linkedPlaylistId && !resumableSync && (!preview || preview.synchronized)
				? previewPlaylist()
				: synchronizePlaylist()
		);

	const dismissPreview = () => {
		previewGuard.invalidate();
		previewSyncStamp = undefined;
		const dismissed = dismissPlaylistPreview({ preview, message, failure });
		preview = dismissed.preview;
		message = dismissed.message;
		failure = dismissed.failure;
	};

	const recoverPlaylist = async () => {
		if (!catalogueMode || working || !creationPending || linkedPlaylistId) return;
		failure = '';
		message = '';
		const playlistId = parseSpotifyPlaylistId(recoveryValue);
		if (!playlistId) {
			failure = 'Enter a valid Spotify playlist URL or playlist ID.';
			return;
		}
		working = true;
		const controller = new AbortController();
		playlistController = controller;
		try {
			const { response, body: result } = await requestApi(
				{ operation: 'verify', playlistId },
				controller.signal
			);
			if (
				!response.ok ||
				result?.mode !== 'verified' ||
				!isSpotifyPlaylistId(result.playlistId) ||
				result.playlistId !== playlistId
			) {
				failure = failureMessage(result);
				return;
			}
			if (!(await persistReturnedLink(playlistId))) {
				failure =
					'The playlist was verified, but its link could not be saved. Keep this page open and use Open playlist.';
				return;
			}
			recoveryValue = '';
			message =
				'Spotify playlist linked. Press Update Spotify playlist when you are ready to synchronize it.';
		} catch {
			failure = 'The Spotify playlist could not be verified. Please try again.';
		} finally {
			if (playlistController === controller) playlistController = undefined;
			working = false;
		}
	};

	const confirmNoPlaylistCreated = async () => {
		if (
			working ||
			!creationPending ||
			!window.confirm('Confirm that you checked Spotify and no playlist was created?')
		) {
			return;
		}
		working = true;
		failure = '';
		message = '';
		if ((await clearCatalogueCreationPending?.()) === true) {
			await removeSyncRecord().catch(() => undefined);
			message = 'Pending creation cleared. You can create the playlist again.';
		} else {
			failure = 'The pending state could not be cleared, so playlist creation remains blocked.';
		}
		working = false;
	};

	const forgetPlaylist = async () => {
		if (
			!linkedPlaylistId ||
			working ||
			!window.confirm(
				'Forget the linked playlist? This only unlinks it from the app and does not delete the Spotify playlist.'
			)
		) {
			return;
		}
		working = true;
		message = '';
		failure = '';
		if (!catalogueMode || (await forgetCatalogueLink?.()) === true) {
			await removeSyncRecord().catch(() => undefined);
			responsePlaylistId = undefined;
			message = 'Spotify playlist link forgotten. The playlist was not deleted from Spotify.';
		} else {
			failure = 'The Spotify playlist link could not be removed from saved progress.';
		}
		working = false;
	};
</script>

<footer data-theme="dark">
	<p class="font-small-beast">
		{data.tracks.length}
		{catalogueMode ? 'unique selected tracks' : 'Selected tracks'}
	</p>
	<div class="playlist-actions">
		{#if message}<p class="font-small-beast" role="status">{message}</p>{/if}
		{#if failure}<p class="font-small-beast" role="alert">{failure}</p>{/if}
		{#if catalogueMode && syncFeedback.historicalStatus && !failure && !message}
			<p class="font-small-beast" role="status" aria-live="polite">
				{syncFeedback.historicalStatus}
			</p>
		{/if}
		{#if catalogueMode && creationPending && !linkedPlaylistId}
			<div class="creation-recovery">
				<p class="font-small-beast">
					Spotify may already have created this playlist. Check Spotify before continuing.
				</p>
				<label class="font-small-beast" for="playlist-recovery">Spotify playlist URL or ID</label>
				<input id="playlist-recovery" bind:value={recoveryValue} autocomplete="off" />
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={working}
					on:click={recoverPlaylist}>Recover existing playlist</Button
				>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={working}
					on:click={confirmNoPlaylistCreated}>I checked Spotify; no playlist was created</Button
				>
			</div>
		{/if}
		{#if linkedPlaylistId}
			<a class="font-small-beast" href={playlistUrl} target="_blank" rel="noreferrer"
				>Open playlist</a
			>
			{#if catalogueMode}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={working}
					on:click={forgetPlaylist}>Forget linked playlist</Button
				>
			{/if}
		{/if}
		{#if preview}
			<div class="update-preview" aria-label="Spotify playlist update preview">
				{#if preview.synchronized}
					<p class="font-small-beast" role="status" aria-live="polite">
						{syncFeedback.synchronizedStatus}
					</p>
				{:else}
					<p class="font-small-beast">
						<strong>{preview.addedCount}</strong> tracks will be added ·
						<strong>{preview.removedCount}</strong> tracks will be removed ·
						<strong>{preview.retainedCount}</strong> tracks will remain
					</p>
					<ul class="font-small-beast">
						<li>Playlist order {preview.orderChanged ? 'will change' : 'is unchanged'}</li>
						<li>Title {preview.titleChanged ? 'will change' : 'is unchanged'}</li>
						<li>Description {preview.descriptionChanged ? 'will change' : 'is unchanged'}</li>
						<li>
							Public/private visibility {preview.visibilityChanged ? 'will change' : 'is unchanged'}
						</li>
					</ul>
					<p class="font-small-beast update-warning">
						Updating replaces the linked Spotify playlist contents. Manual changes made directly in
						Spotify will be removed.
					</p>
				{/if}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={working}
					on:click={dismissPreview}>Dismiss preview</Button
				>
			</div>
		{/if}
		{#if me?.id}
			<Button
				as="button"
				type="button"
				icon="spotify"
				disabled={disabled ||
					working ||
					!tabOwner ||
					syncEligibility.disabled ||
					syncPaused ||
					(data.tracks.length === 0 && !linkedPlaylistId) ||
					(catalogueMode && creationPending && !linkedPlaylistId)}
				loading={working}
				on:click={handleClick}>{buttonLabel}</Button
			>
		{:else}
			<LoginWithSpotify label="Login to import" />
		{/if}
	</div>
</footer>

<style lang="postcss">
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 44px;
		border: 1px solid var(--color-background);
		box-sizing: border-box;
		position: fixed;
		bottom: 0;
		left: 0;
		width: 100%;
		max-height: 70vh;
		overflow-y: auto;
		background-color: var(--color-background);

		& > p {
			padding: 8px;
		}
	}

	.playlist-actions,
	.creation-recovery {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;

		& p {
			padding: 8px;
		}
	}

	.playlist-actions > a {
		padding: 8px;
	}

	.creation-recovery input {
		min-width: 220px;
	}

	.update-preview {
		max-width: 520px;
		border: 1px solid currentColor;
		padding: 8px;
		line-height: 1.4;

		& p {
			padding: 0;
		}

		& ul {
			margin: 4px 0;
			padding-left: 20px;
		}
	}

	.update-warning {
		margin-top: 6px;
	}

	@media (max-width: 700px) {
		footer {
			align-items: flex-start;
			flex-direction: column;
		}

		.playlist-actions {
			width: 100%;
			justify-content: flex-start;
		}
	}
</style>
