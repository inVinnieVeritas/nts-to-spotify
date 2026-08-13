<script lang="ts">
	import {
		Badge,
		Button,
		Divider,
		ImportToSpotify,
		LoginWithSpotify,
		Panel,
		Track
	} from '$components';
	import type { MatchedTrack, NTSEpisodeSummary, URI } from '$lib/types';
	import type { PageData } from './$types';

	export let data: PageData;

	type ReviewTrack = MatchedTrack & {
		selectedMatch: URI | null;
		checked: boolean;
	};

	type EpisodeState = NTSEpisodeSummary & {
		status: 'pending' | 'scanning' | 'done' | 'error';
		tracks: ReviewTrack[];
		error?: string;
	};

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

	const firstEpisode = data.episodes[0];
	const lastEpisode = data.episodes[data.episodes.length - 1];
	const dateStamp =
		firstEpisode && lastEpisode
			? `${shortDate(lastEpisode.broadcast)}→${shortDate(firstEpisode.broadcast)}`
			: '';

	let playlistTitle = `“${data.name.toLowerCase()}” ${dateStamp}`;
	let playlistDescription =
		firstEpisode && lastEpisode
			? `“${data.name.toLowerCase()}” ${dateStamp} — A comprehensive archive of tracks played on ${
					data.name
			  } on NTS Radio, covering broadcasts from ${longDate(
					firstEpisode.broadcast
			  )} through ${longDate(
					lastEpisode.broadcast
			  )}. Some tracks unavailable on Spotify may be missing.`
			: `Tracks played on ${data.name} on NTS Radio. Some tracks unavailable on Spotify may be missing.`;
	let publicPlaylist = false;
	let scanning = false;
	let scanMessage = '';

	let episodes: EpisodeState[] = data.episodes.map((episode) => ({
		...episode,
		status: 'pending',
		tracks: []
	}));

	const scanEpisode = async (index: number) => {
		episodes[index].status = 'scanning';
		episodes[index].error = undefined;
		episodes = episodes;

		try {
			const response = await fetch('/api/nts/matches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					show: data.showAlias,
					episode: episodes[index].episodeAlias
				})
			});
			if (!response.ok) throw new Error(`Request failed (${response.status})`);

			const result = (await response.json()) as { tracks: MatchedTrack[] };
			episodes[index].tracks = result.tracks.map((track) => ({
				...track,
				selectedMatch: track.matches[0]?.uri || null,
				checked: track.confident
			}));
			episodes[index].status = 'done';
		} catch (cause) {
			console.error(cause);
			episodes[index].status = 'error';
			episodes[index].error = 'Could not scan this episode.';
		} finally {
			episodes = episodes;
		}
	};

	const scanCatalog = async () => {
		const queue = episodes
			.map((episode, index) => ({ episode, index }))
			.filter(({ episode }) => episode.status === 'pending' || episode.status === 'error')
			.map(({ index }) => index);
		if (queue.length === 0) return;

		scanning = true;
		scanMessage = '';
		let cursor = 0;
		const worker = async () => {
			while (cursor < queue.length) {
				const index = queue[cursor++];
				await scanEpisode(index);
			}
		};

		await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
		scanning = false;
		scanMessage = episodes.some(({ status }) => status === 'error')
			? 'Scan finished with some errors. Use Retry failed episodes.'
			: 'Catalogue scan complete. Review unchecked and unmatched tracks before importing.';
	};

	let rawSelectedTracks: string[] = [];
	let selectedTracks: string[] = [];
	let duplicateCount = 0;
	let completedCount = 0;
	let failedCount = 0;
	let uncertainCount = 0;
	let progressLabel = '';
	$: rawSelectedTracks = episodes.flatMap((episode) =>
		episode.tracks
			.filter((track) => track.checked && track.selectedMatch)
			.map((track) => track.selectedMatch as string)
	);
	$: selectedTracks = Array.from(new Set(rawSelectedTracks));
	$: duplicateCount = rawSelectedTracks.length - selectedTracks.length;
	$: completedCount = episodes.filter(({ status }) => status === 'done').length;
	$: failedCount = episodes.filter(({ status }) => status === 'error').length;
	$: uncertainCount = episodes.reduce(
		(total, episode) => total + episode.tracks.filter(({ confident }) => !confident).length,
		0
	);
	$: scanComplete = completedCount === episodes.length;
	$: progressLabel = `${completedCount}/${episodes.length} episodes scanned${
		failedCount ? ` · ${failedCount} failed` : ''
	}`;

	const episodeStatus = (episode: EpisodeState) => {
		if (episode.status === 'pending') return 'Waiting';
		if (episode.status === 'scanning') return 'Scanning…';
		if (episode.status === 'done') return `${episode.tracks.length} tracks`;
		return episode.error || 'Could not scan this episode.';
	};
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
					<Button on:click={scanCatalog} loading={scanning} disabled={scanning || scanComplete}>
						{completedCount === 0 ? 'Scan full catalogue' : 'Retry failed episodes'}
					</Button>
					<p class="font-small-beast">{progressLabel}</p>
				</div>
			{/if}
			{#if scanMessage}<p class="font-base">{scanMessage}</p>{/if}
		</header>

		{#if completedCount > 0}
			<section class="settings">
				<label class="font-small-beast">
					Playlist name
					<input bind:value={playlistTitle} maxlength="100" />
				</label>
				<label class="font-small-beast">
					Description
					<textarea bind:value={playlistDescription} maxlength="300" rows="4" />
				</label>
				<label class="visibility font-base">
					<input type="checkbox" bind:checked={publicPlaylist} />
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
							<Button size="sm" variant="outline" on:click={() => scanEpisode(episodeIndex)}
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
