import { isAbortError, RequestTimeoutError } from './abort';
import { fetchWithTimeout, type Fetcher } from './request';
import type { SpotifyConfiguration } from './spotify-config.server';

export const SPOTIFY_TOKEN_TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 16_384;

export type SpotifyTokenFailureReason =
	| 'authentication'
	| 'upstream'
	| 'network'
	| 'timeout'
	| 'invalid-response';

export class SpotifyTokenAcquisitionError extends Error {
	constructor(public readonly reason: SpotifyTokenFailureReason) {
		super('Spotify token acquisition failed');
		this.name = 'SpotifyTokenAcquisitionError';
	}
}

export const isSpotifyTokenAcquisitionError = (
	cause: unknown
): cause is SpotifyTokenAcquisitionError =>
	cause instanceof SpotifyTokenAcquisitionError ||
	Boolean(
		cause &&
			typeof cause === 'object' &&
			(cause as { name?: unknown }).name === 'SpotifyTokenAcquisitionError' &&
			typeof (cause as { reason?: unknown }).reason === 'string' &&
			['authentication', 'upstream', 'network', 'timeout', 'invalid-response'].includes(
				(cause as { reason: string }).reason
			)
	);

export type ValidatedSpotifyToken = {
	accessToken: string;
	expiresIn: number;
	tokenType: 'Bearer';
	refreshToken?: string;
};

const isBoundedToken = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TOKEN_LENGTH;

const isSafeExpiry = (value: unknown, now: number): value is number => {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) return false;
	const milliseconds = (value as number) * 1_000;
	return Number.isSafeInteger(milliseconds) && Number.isSafeInteger(now + milliseconds);
};

export const parseSpotifyTokenResponse = (
	value: unknown,
	options: { requireRefreshToken: boolean; now?: number }
): ValidatedSpotifyToken => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new SpotifyTokenAcquisitionError('invalid-response');
	}
	const token = value as Record<string, unknown>;
	const now = options.now ?? Date.now();
	if (
		!isBoundedToken(token.access_token) ||
		!isSafeExpiry(token.expires_in, now) ||
		typeof token.token_type !== 'string' ||
		token.token_type.toLowerCase() !== 'bearer' ||
		(options.requireRefreshToken && !isBoundedToken(token.refresh_token)) ||
		(token.refresh_token !== undefined && !isBoundedToken(token.refresh_token))
	) {
		throw new SpotifyTokenAcquisitionError('invalid-response');
	}

	return {
		accessToken: token.access_token,
		expiresIn: token.expires_in,
		tokenType: 'Bearer',
		...(isBoundedToken(token.refresh_token) ? { refreshToken: token.refresh_token } : {})
	};
};

export const requestSpotifyToken = async (
	request: Fetcher,
	configuration: SpotifyConfiguration,
	body: URLSearchParams,
	options: { requireRefreshToken: boolean; signal?: AbortSignal; now?: number }
) => {
	try {
		return await fetchWithTimeout(
			request,
			'https://accounts.spotify.com/api/token',
			{
				method: 'POST',
				body,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Authorization: `Basic ${Buffer.from(
						`${configuration.clientId}:${configuration.clientSecret}`
					).toString('base64')}`
				}
			},
			SPOTIFY_TOKEN_TIMEOUT_MS,
			async (response) => {
				if (!response.ok) {
					await response.body?.cancel();
					throw new SpotifyTokenAcquisitionError(
						response.status >= 400 && response.status < 500 ? 'authentication' : 'upstream'
					);
				}
				let value: unknown;
				try {
					value = await response.json();
				} catch {
					throw new SpotifyTokenAcquisitionError('invalid-response');
				}
				return parseSpotifyTokenResponse(value, options);
			},
			options.signal
		);
	} catch (cause) {
		if (isSpotifyTokenAcquisitionError(cause) || isAbortError(cause)) throw cause;
		if (cause instanceof RequestTimeoutError) {
			throw new SpotifyTokenAcquisitionError('timeout');
		}
		throw new SpotifyTokenAcquisitionError('network');
	}
};
