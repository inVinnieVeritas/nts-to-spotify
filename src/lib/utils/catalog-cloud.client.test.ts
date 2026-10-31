import { describe, expect, it } from 'vitest';
import type { CatalogProgress } from './catalog-scan';
import { cloudProgressExtendsLocal, progressSignature } from './catalog-cloud.client';
import { createGeneratedPlaylistText, type EpisodeState } from './catalog-scan';

const episode = (index: number, done = true): EpisodeState => ({
	episodeAlias: `episode-${index}`,
	name: `Episode ${index}`,
	broadcast: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
	cover: '',
	genres: [],
	status: done ? 'done' : 'pending',
	tracks: done
		? [
				{
					artist: 'Artist',
					title: 'Track',
					confident: true,
					fallback: false,
					checked: true,
					selectedMatch: `spotify:track:${String(index).padStart(22, '0')}`,
					matches: [
						{
							artist: 'Artist',
							title: 'Track',
							uri: `spotify:track:${String(index).padStart(22, '0')}`,
							href: `https://open.spotify.com/track/${String(index).padStart(22, '0')}`
						}
					]
				}
			]
		: []
});
const saved = (count: number): CatalogProgress => {
	const episodes = Array.from({ length: count }, (_, i) => episode(i));
	const text = createGeneratedPlaylistText('Wes Baggaley', episodes, 'latest-first');
	return {
		schemaVersion: 2,
		matcherVersion: 1,
		showAlias: 'wes-baggaley',
		updatedAt: Date.now(),
		episodes: Object.fromEntries(episodes.map((e) => [e.episodeAlias, e])),
		playlist: {
			title: text.title,
			description: text.description,
			public: true,
			linkedPlaylistId: '6h1vuQ06Gy4m7P9K4lGzmB',
			order: 'latest-first'
		},
		display: { showName: 'Wes Baggaley' }
	};
};

describe('safe adoption of background scan results', () => {
	it('accepts cloud 10/10 over browser 9/10 and updates generated dates without a sync marker', () => {
		const local = saved(9);
		local.episodes['episode-9'] = episode(9, false);
		expect(cloudProgressExtendsLocal(local, saved(10))).toBe(true);
	});
	it('accepts additional completed episodes, episode map reordering and identical custom text', () => {
		const local = saved(9);
		const remote = saved(10);
		remote.episodes = Object.fromEntries(Object.entries(remote.episodes).reverse());
		local.playlist.title = remote.playlist.title = 'My archive';
		local.playlist.description = remote.playlist.description = 'My description';
		expect(cloudProgressExtendsLocal(local, remote)).toBe(true);
	});
	it.each([
		'checked',
		'selectedMatch',
		'dismissed',
		'title',
		'description',
		'public',
		'order',
		'linkedPlaylistId',
		'creationPending',
		'missing',
		'unfinished-with-review',
		'schema',
		'matcher',
		'alias',
		'cooldown'
	])('preserves meaningful browser state (%s)', (change) => {
		const local = saved(9);
		const remote = saved(10);
		const track = local.episodes['episode-0'].tracks[0];
		if (change === 'checked') track.checked = false;
		if (change === 'selectedMatch') track.selectedMatch = `spotify:track:${'9'.repeat(22)}`;
		if (change === 'dismissed') track.dismissed = true;
		if (change === 'title') local.playlist.title = 'My new custom title';
		if (change === 'description') local.playlist.description = 'My new description';
		if (change === 'public') local.playlist.public = false;
		if (change === 'order') local.playlist.order = 'oldest-first';
		if (change === 'linkedPlaylistId') local.playlist.linkedPlaylistId = 'ABCDEFGHIJKLMNOPQRSTUV';
		if (change === 'creationPending') {
			delete local.playlist.linkedPlaylistId;
			local.playlist.creationPending = true;
		}
		if (change === 'missing') delete remote.episodes['episode-0'];
		if (change === 'unfinished-with-review') local.episodes['episode-0'].status = 'pending';
		if (change === 'schema') remote.schemaVersion = 99;
		if (change === 'matcher') remote.matcherVersion = 99;
		if (change === 'alias') remote.showAlias = 'another-show';
		if (change === 'cooldown')
			local.retry = { cooldownUntil: Date.now() + 60_000, pausedByRateLimit: true };
		expect(cloudProgressExtendsLocal(local, remote)).toBe(false);
	});
});

describe('cloud sync change detection', () => {
	it('ignores local scan timers but notices an episode review change', async () => {
		const progress: CatalogProgress = {
			schemaVersion: 2,
			matcherVersion: 1,
			showAlias: 'channeling',
			updatedAt: Date.now(),
			episodes: {
				episode: {
					episodeAlias: 'episode',
					name: 'Episode',
					broadcast: '2026-09-22T17:00:00.000Z',
					cover: '',
					genres: [],
					status: 'pending',
					tracks: []
				}
			},
			playlist: { title: 'Channeling', description: '', public: false }
		};
		const initial = await progressSignature(progress);
		expect(await progressSignature({ ...progress, updatedAt: progress.updatedAt + 1_000 })).toBe(
			initial
		);
		expect(
			await progressSignature({
				...progress,
				episodes: {
					episode: { ...progress.episodes.episode, status: 'done' }
				}
			})
		).not.toBe(initial);
	});
});
