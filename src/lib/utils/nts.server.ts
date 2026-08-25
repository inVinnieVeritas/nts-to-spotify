import type { BasicTrack, NTSShowCatalog, NTSEpisodeSummary } from '$lib/types';
import { fetchWithTimeout, type Fetcher } from './request';
import { parseOfficialNTSArtworkUrl } from './artwork';

const NTS_TIMEOUT_MS = 20_000;

type NTSMedia = {
	picture_medium_large?: string;
	picture_large?: string;
	background_medium_large?: string;
};

type NTSEpisode = {
	episode_alias: string;
	name: string;
	broadcast: string;
	media?: NTSMedia;
	genres?: { value: string }[];
};

type EpisodesResponse = {
	metadata: { resultset: { count: number } };
	results: NTSEpisode[];
};

type ShowResponse = {
	name: string;
	description: string;
	media?: NTSMedia;
};

type TracklistResponse = {
	results: BasicTrack[];
};

const PAGE_SIZE = 12;
const apiBase = 'https://www.nts.live/api/v2/shows';

const consumeJson =
	<T>(message: string) =>
	async (response: Response): Promise<T> => {
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`${message} (${response.status})`);
		}
		return (await response.json()) as T;
	};

const getCover = (media?: NTSMedia) =>
	[media?.picture_medium_large, media?.picture_large, media?.background_medium_large]
		.map(parseOfficialNTSArtworkUrl)
		.find((cover): cover is string => Boolean(cover)) || '';

const mapEpisode = (episode: NTSEpisode): NTSEpisodeSummary => ({
	episodeAlias: episode.episode_alias,
	name: episode.name,
	broadcast: episode.broadcast,
	cover: getCover(episode.media),
	genres: (episode.genres || []).map(({ value }) => value)
});

export const getNTSShowCatalog = async (
	showAlias: string,
	request: Fetcher = fetch,
	signal?: AbortSignal
): Promise<NTSShowCatalog> => {
	const [show, firstPage] = await Promise.all([
		fetchWithTimeout(
			request,
			`${apiBase}/${showAlias}`,
			{},
			NTS_TIMEOUT_MS,
			consumeJson<ShowResponse>('Unable to load NTS show'),
			signal
		),
		fetchWithTimeout(
			request,
			`${apiBase}/${showAlias}/episodes?offset=0&limit=${PAGE_SIZE}`,
			{},
			NTS_TIMEOUT_MS,
			consumeJson<EpisodesResponse>('Unable to load NTS episodes'),
			signal
		)
	]);

	const remainingOffsets: number[] = [];
	for (let offset = PAGE_SIZE; offset < firstPage.metadata.resultset.count; offset += PAGE_SIZE) {
		remainingOffsets.push(offset);
	}

	const remainingPages = await Promise.all(
		remainingOffsets.map(async (offset) =>
			fetchWithTimeout(
				request,
				`${apiBase}/${showAlias}/episodes?offset=${offset}&limit=${PAGE_SIZE}`,
				{},
				NTS_TIMEOUT_MS,
				consumeJson<EpisodesResponse>('Unable to load NTS episodes'),
				signal
			)
		)
	);

	const episodes = [firstPage, ...remainingPages]
		.flatMap(({ results }) => results)
		.map(mapEpisode)
		.sort((a, b) => Date.parse(a.broadcast) - Date.parse(b.broadcast));

	return {
		showAlias,
		name: show.name,
		description: show.description,
		cover: getCover(show.media),
		episodes
	};
};

export const getNTSEpisodeTracklist = async (
	showAlias: string,
	episodeAlias: string,
	request: Fetcher = fetch,
	signal?: AbortSignal
): Promise<BasicTrack[]> => {
	const data = await fetchWithTimeout(
		request,
		`${apiBase}/${showAlias}/episodes/${episodeAlias}/tracklist`,
		{},
		NTS_TIMEOUT_MS,
		consumeJson<TracklistResponse>('Unable to load NTS tracklist'),
		signal
	);

	return (data.results || [])
		.map(({ artist, title }) => ({ artist: artist.trim(), title: title.trim() }))
		.filter(({ artist, title }) => artist.length > 0 && title.length > 0);
};
