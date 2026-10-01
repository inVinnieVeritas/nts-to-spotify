import { env } from '$env/dynamic/private';
import { validateCloudRunEnvironment } from '../../scripts/cloud-run-config.mjs';
import { loadCloudProgress, saveCloudProgress } from '../lib/utils/catalog-cloud.server';
import { ScheduleStore, schedulesEnabled } from '../lib/utils/catalog-schedule-store.server';
import { runScheduledScan } from '../lib/utils/catalog-schedule-worker.server';
import { getNTSShowCatalog, getNTSEpisodeTracklist } from '../lib/utils/nts.server';
import { parseNTSShowCatalog } from '../lib/utils/catalog-update';
import {
	getClientCredentials,
	getSpotifySessionMetrics,
	mapWithConcurrency,
	searchSpotifyTrack
} from '../lib/utils/spotify.server';

async function main() {
	validateCloudRunEnvironment(env, { job: true });
	if (!schedulesEnabled()) throw new Error('Scheduled scans are disabled');
	const controller = new AbortController();
	process.once('SIGTERM', () => controller.abort());
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(18 * 60_000)]);
	const result = await runScheduledScan({
		store: new ScheduleStore(),
		load: (show) => loadCloudProgress(show),
		save: (show, progress, version) => saveCloudProgress(show, progress, version),
		catalog: async (show, signal) =>
			parseNTSShowCatalog(await getNTSShowCatalog(show, fetch, signal), show),
		match: async (show, episode, signal) => {
			const token = await getClientCredentials(fetch, signal);
			if (!token) throw new Error('Spotify application is not configured');
			const tracks = await getNTSEpisodeTracklist(show, episode, fetch, signal);
			return mapWithConcurrency(
				tracks,
				4,
				(track, _index, signal) => searchSpotifyTrack(track, token, fetch, signal),
				signal
			);
		},
		searchCount: () => getSpotifySessionMetrics().searchRequests,
		now: Date.now,
		signal
	});
	console.info('Scheduled catalogue scan', JSON.stringify(result));
}
main().catch(() => {
	console.error('Scheduled catalogue scan failed. Check job configuration and cloud access.');
	process.exitCode = 1;
});
