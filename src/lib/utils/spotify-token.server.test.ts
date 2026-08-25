import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSpotifyTokenResponse, requestSpotifyToken } from './spotify-token.server';

const configuration = { clientId: 'configured-client', clientSecret: 'configured-secret' };
const body = new URLSearchParams({ grant_type: 'client_credentials' });
const valid = (extra: Record<string, unknown> = {}) => ({
	access_token: 'validated-access-token',
	expires_in: 3_600,
	token_type: 'Bearer',
	...extra
});

describe('Spotify token response boundary', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([401, 403])(
		'classifies configured HTTP %s without exposing the response',
		async (status) => {
			await expect(
				requestSpotifyToken(
					vi.fn(async () => new Response('private token response', { status })) as typeof fetch,
					configuration,
					body,
					{ requireRefreshToken: false }
				)
			).rejects.toMatchObject({
				name: 'SpotifyTokenAcquisitionError',
				reason: 'authentication',
				message: 'Spotify token acquisition failed'
			});
		}
	);

	it('classifies upstream, network, request timeout and invalid JSON failures', async () => {
		await expect(
			requestSpotifyToken(
				vi.fn(async () => new Response('', { status: 503 })) as typeof fetch,
				configuration,
				body,
				{ requireRefreshToken: false }
			)
		).rejects.toMatchObject({ reason: 'upstream' });
		await expect(
			requestSpotifyToken(
				vi.fn(async () => {
					throw new Error('private network diagnostics');
				}) as typeof fetch,
				configuration,
				body,
				{ requireRefreshToken: false }
			)
		).rejects.toMatchObject({ reason: 'network' });
		await expect(
			requestSpotifyToken(
				vi.fn(async () => new Response('not-json')) as typeof fetch,
				configuration,
				body,
				{ requireRefreshToken: false }
			)
		).rejects.toMatchObject({ reason: 'invalid-response' });

		vi.useFakeTimers();
		const request = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener(
						'abort',
						() => reject(Object.assign(new Error('private timeout'), { name: 'AbortError' })),
						{ once: true }
					)
				)
		) as typeof fetch;
		const pending = requestSpotifyToken(request, configuration, body, {
			requireRefreshToken: false
		});
		const expectation = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
		await vi.advanceTimersByTimeAsync(15_000);
		await expectation;
	});

	it.each([
		['missing access token', valid({ access_token: undefined })],
		['blank access token', valid({ access_token: '   ' })],
		['zero expiry', valid({ expires_in: 0 })],
		['negative expiry', valid({ expires_in: -1 })],
		['fractional expiry', valid({ expires_in: 1.5 })],
		['unsafe expiry', valid({ expires_in: Number.MAX_SAFE_INTEGER + 1 })],
		[
			'overflowing deadline',
			valid({ expires_in: Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1_000) + 1 })
		],
		['wrong token type', valid({ token_type: 'MAC' })]
	])('rejects a successful payload with %s', (_label, payload) => {
		expect(() => parseSpotifyTokenResponse(payload, { requireRefreshToken: false })).toThrowError(
			expect.objectContaining({ reason: 'invalid-response' })
		);
	});

	it('requires an initial refresh token but permits a refresh response without a replacement', () => {
		expect(() => parseSpotifyTokenResponse(valid(), { requireRefreshToken: true })).toThrowError(
			expect.objectContaining({ reason: 'invalid-response' })
		);
		expect(parseSpotifyTokenResponse(valid(), { requireRefreshToken: false })).toEqual({
			accessToken: 'validated-access-token',
			expiresIn: 3_600,
			tokenType: 'Bearer'
		});
	});

	it('never returns or logs raw token response properties', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let failure: unknown;
		try {
			await requestSpotifyToken(
				vi.fn(
					async () =>
						new Response(JSON.stringify({ access_token: 'private-token', private: 'secret' }))
				) as typeof fetch,
				configuration,
				body,
				{ requireRefreshToken: false }
			);
		} catch (cause) {
			failure = cause;
		}
		expect(JSON.stringify(failure)).not.toContain('private-token');
		expect(JSON.stringify(failure)).not.toContain('secret');
		expect(consoleError).not.toHaveBeenCalled();
	});
});
