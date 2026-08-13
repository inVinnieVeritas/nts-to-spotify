export const routeParamsToNtsUrl = (show: string, episode: string) => {
	return `https://nts.live/shows/${show}/episodes/${episode}`;
};

export const showParamToNtsUrl = (show: string) => `https://nts.live/shows/${show}`;

export const isValidNTSSlug = (value: string) => /^[a-z0-9-]+$/.test(value);

export const ntsUrlToParams = (url: string) => {
	if (
		!(url.startsWith('https://www.nts.live/shows/') || url.startsWith('https://nts.live/shows/'))
	) {
		throw new Error(`Expecting an NTS episode. Received: ${url}`);
	}

	const reg = /^.+\/shows\/(.+)\/episodes\/(.+)$/gim;
	const [_, show, episode] = reg.exec(url) || [];

	if (!show || !episode) throw new Error(`Invalid NTS url. Can't find the show and episode`);

	return { show, episode };
};

export const ntsUrlToRouteUrl = (url: string) => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'nts.live' && parsed.hostname !== 'www.nts.live') throw new Error();

		const parts = parsed.pathname.replace(/\/$/, '').split('/').filter(Boolean);
		if (parts[0] !== 'shows' || !parts[1] || !isValidNTSSlug(parts[1])) throw new Error();

		if (parts.length === 2) return `/shows/${parts[1]}`;
		if (parts.length === 4 && parts[2] === 'episodes' && parts[3] && isValidNTSSlug(parts[3])) {
			return `/shows/${parts[1]}/episodes/${parts[3]}`;
		}

		throw new Error();
	} catch (error) {
		return '/404';
	}
};
