const parseOfficialArtworkUrl = (
	value: unknown,
	hostname: string,
	validPath: (pathname: string) => boolean
) => {
	if (typeof value !== 'string' || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.hostname !== hostname ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!validPath(url.pathname)
		) {
			return undefined;
		}
		return url.toString();
	} catch {
		return undefined;
	}
};

export const parseOfficialNTSArtworkUrl = (value: unknown) =>
	parseOfficialArtworkUrl(value, 'media.ntslive.co.uk', (pathname) =>
		/^\/(?:crop|resize)\/[^/]+\/.+/u.test(pathname)
	);

export const parseOfficialSpotifyArtworkUrl = (value: unknown) =>
	parseOfficialArtworkUrl(value, 'i.scdn.co', (pathname) =>
		/^\/image\/[A-Za-z0-9]+$/u.test(pathname)
	);
