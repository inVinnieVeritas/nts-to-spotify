import type { User } from '$lib/types';
import { fetchWithTimeout, type Fetcher } from './request';
import { parseOfficialSpotifyArtworkUrl } from './artwork';

export const SPOTIFY_PROFILE_TIMEOUT_MS = 15_000;
const MAX_PROFILE_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 500;

const hasControlCharacter = (value: string) =>
	Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});

export class SpotifyProfileError extends Error {
	constructor(public readonly reason: 'unavailable' | 'invalid-response') {
		super('Spotify profile unavailable');
		this.name = 'SpotifyProfileError';
	}
}

const isBoundedSafeText = (value: unknown, maximum: number): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.trim().length > 0 &&
	value.length <= maximum &&
	!hasControlCharacter(value);

export const parseSpotifyProfileImage = parseOfficialSpotifyArtworkUrl;

export const parseSpotifyProfile = (value: unknown): Exclude<User, null> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new SpotifyProfileError('invalid-response');
	}
	const profile = value as Record<string, unknown>;
	if (!isBoundedSafeText(profile.id, MAX_PROFILE_ID_LENGTH)) {
		throw new SpotifyProfileError('invalid-response');
	}
	const displayName = isBoundedSafeText(profile.display_name, MAX_DISPLAY_NAME_LENGTH)
		? profile.display_name
		: 'Spotify user';
	const images = Array.isArray(profile.images) ? profile.images : [];
	const image = images
		.map((candidate) =>
			candidate && typeof candidate === 'object' && !Array.isArray(candidate)
				? parseSpotifyProfileImage((candidate as Record<string, unknown>).url)
				: undefined
		)
		.find((candidate): candidate is string => Boolean(candidate));

	return { id: profile.id, display_name: displayName, ...(image ? { image } : {}) };
};

export const getSpotifyProfile = async (request: Fetcher, token: string, signal?: AbortSignal) =>
	fetchWithTimeout(
		request,
		'https://api.spotify.com/v1/me',
		{ headers: { Authorization: `Bearer ${token}` } },
		SPOTIFY_PROFILE_TIMEOUT_MS,
		async (response) => {
			if (!response.ok) {
				await response.body?.cancel();
				throw new SpotifyProfileError('unavailable');
			}
			let value: unknown;
			try {
				value = await response.json();
			} catch {
				throw new SpotifyProfileError('invalid-response');
			}
			return parseSpotifyProfile(value);
		},
		signal
	);
