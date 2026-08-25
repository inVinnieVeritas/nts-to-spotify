<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$components';
	import {
		formatCooldownDuration,
		isSpotifyPlaylistId,
		parseSpotifyPlaylistId,
		spotifyPlaylistUrl
	} from '$lib/utils/catalog-scan';
	import {
		createPlaylistPreviewInputSignature,
		dismissPlaylistPreview,
		parseSpotifyPlaylistPreview,
		runExclusivePlaylistAction,
		type ClientSpotifyPlaylistPreview
	} from '$lib/utils/playlist-preview.client';
	import LoginWithSpotify from './login-with-spotify.svelte';

	export let disabled = false;
	export let catalogueMode = false;
	export let creationPending = false;
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
	const primaryActionGate = { active: false };
	$: linkedPlaylistId = isSpotifyPlaylistId(data.linkedPlaylistId)
		? data.linkedPlaylistId
		: catalogueMode
			? undefined
			: responsePlaylistId;
	$: playlistUrl = linkedPlaylistId ? spotifyPlaylistUrl(linkedPlaylistId) : '';
	$: inputSignature = createPlaylistPreviewInputSignature({
		playlistId: linkedPlaylistId,
		title: data.title,
		description: data.description,
		public: data.public ?? true,
		tracks: data.tracks,
		previewKey: data.previewKey
	});
	$: if (preview && preview.inputSignature !== inputSignature) {
		preview = undefined;
		message = '';
		failure = '';
	}
	$: buttonLabel = catalogueMode
		? linkedPlaylistId
			? preview && !preview.synchronized
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
		responsePlaylistId = playlistId;
		if (!catalogueMode) return true;
		if (data.linkedPlaylistId === playlistId) return true;
		return (await persistCatalogueLink?.(playlistId)) === true;
	};

	const clearKnownCreation = async (creatingNew: boolean) => {
		if (!catalogueMode || !creatingNew) return true;
		return (await clearCatalogueCreationPending?.()) === true;
	};

	const playlistPayload = () => ({
		name: data.title,
		description: data.description,
		tracks: data.tracks,
		public: data.public ?? true
	});

	const previewPlaylist = async () => {
		if (!me || working || !linkedPlaylistId) return;
		const requestedSignature = inputSignature;
		working = true;
		failure = '';
		message = 'Previewing Spotify update…';
		try {
			const response = await fetch('/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'preview',
					playlistId: linkedPlaylistId,
					...playlistPayload()
				})
			});
			const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
			if (!response.ok) {
				failure =
					result?.error === 'spotify_unavailable'
						? 'Preview failed. Try again.'
						: failureMessage(result);
				message = '';
				return;
			}
			const parsed = parseSpotifyPlaylistPreview(result, linkedPlaylistId, requestedSignature);
			if (!parsed || inputSignature !== requestedSignature) {
				failure = parsed ? '' : 'Spotify returned an invalid preview. Try again.';
				message = '';
				return;
			}
			preview = parsed;
			message = '';
		} catch {
			failure = 'Preview failed. Try again.';
			message = '';
		} finally {
			working = false;
		}
	};

	const synchronizePlaylist = async () => {
		if (!me || working) return;
		const creatingNew = catalogueMode && !linkedPlaylistId;
		if (creatingNew && creationPending) return;
		if (linkedPlaylistId && (!preview || preview.synchronized)) return;

		working = true;
		failure = '';
		message = linkedPlaylistId ? 'Applying Spotify update…' : '';
		if (creatingNew && (await prepareCatalogueCreation?.()) !== true) {
			failure = 'Progress could not be saved, so no Spotify playlist was created.';
			working = false;
			return;
		}

		try {
			const response = await fetch('/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...playlistPayload(),
					...(linkedPlaylistId && preview
						? {
								operation: 'apply',
								playlistId: linkedPlaylistId,
								previewFingerprint: preview.previewFingerprint
							}
						: {})
				})
			});
			const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
			if (!response.ok) {
				if (result?.error === 'playlist_changed_since_preview') preview = undefined;
				if (result?.incomplete === true) preview = undefined;
				if (result?.incomplete === true && isSpotifyPlaylistId(result.playlistId)) {
					const saved = await persistReturnedLink(result.playlistId);
					failure = saved
						? failureMessage(result)
						: 'The Spotify playlist link could not be saved. Keep this page open and use Open playlist; another playlist will not be created.';
					return;
				}
				const errorName = typeof result?.error === 'string' ? result.error : undefined;
				const knownCreationFailure =
					errorName !== undefined &&
					[
						'invalid_request',
						'spotify_authentication',
						'spotify_rate_limited',
						'spotify_unavailable',
						'playlist_not_owned',
						'playlist_not_found',
						'playlist_inaccessible'
					].includes(errorName);
				const unknownCreation =
					creatingNew && (errorName === 'playlist_creation_unknown' || !knownCreationFailure);
				if (!unknownCreation && !(await clearKnownCreation(creatingNew))) {
					failure =
						'The request failed, but its pending state could not be cleared. Creation remains blocked to prevent a duplicate.';
					return;
				}
				failure = unknownCreation
					? 'Spotify may have created the playlist, but the result could not be confirmed. Check Spotify before continuing.'
					: failureMessage(result);
				return;
			}
			if (
				!result ||
				!isSpotifyPlaylistId(result.playlistId) ||
				(result.mode !== 'created' && result.mode !== 'updated') ||
				typeof result.trackCount !== 'number' ||
				!Number.isSafeInteger(result.trackCount) ||
				result.trackCount < 0
			) {
				failure = creatingNew
					? 'Spotify may have created the playlist, but returned an invalid response. Check Spotify before continuing.'
					: 'Spotify returned an invalid playlist response. Please retry.';
				return;
			}
			const saved = await persistReturnedLink(result.playlistId);
			if (!saved) {
				failure =
					'The Spotify playlist exists, but its link could not be saved. Keep this page open and use Open playlist; another playlist will not be created.';
				return;
			}
			message =
				result.mode === 'created'
					? `Spotify playlist created with ${result.trackCount} unique tracks.`
					: `Spotify playlist updated with ${result.trackCount} unique tracks.`;
			preview = undefined;
		} catch {
			failure = creatingNew
				? 'Spotify may have created the playlist, but the connection ended before it was confirmed. Check Spotify before continuing.'
				: 'Spotify playlist synchronization failed. Please try again.';
		} finally {
			if (failure) message = '';
			working = false;
		}
	};

	const handleClick = () =>
		runExclusivePlaylistAction(primaryActionGate, () =>
			linkedPlaylistId && (!preview || preview.synchronized)
				? previewPlaylist()
				: synchronizePlaylist()
		);

	const dismissPreview = () => {
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
		try {
			const response = await fetch('/api/spotify/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'verify', playlistId })
			});
			const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
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
					<p class="font-small-beast">Spotify playlist is already synchronized.</p>
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
