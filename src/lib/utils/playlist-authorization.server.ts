import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { hostedConfiguration } from './hosted-access.server';
import { rotateAccessToken } from './auth.server';
import { getSpotifyProfile } from './spotify-profile.server';
import { isSpotifyTokenAcquisitionError } from './spotify-token.server';
import { ScheduleStore } from './catalog-schedule-store.server';

type AuthorizationRecord = {
	generation: string;
	connected: boolean;
	ciphertext?: string;
	connectedAt: number;
};
const isAuthorization = (v: unknown): v is AuthorizationRecord => {
	if (!v || typeof v !== 'object') return false;
	const a = v as AuthorizationRecord;
	return (
		typeof a.generation === 'string' &&
		/^[a-f0-9-]{36}$/.test(a.generation) &&
		typeof a.connected === 'boolean' &&
		Number.isSafeInteger(a.connectedAt) &&
		a.connectedAt >= 0 &&
		(!a.connected ||
			(typeof a.ciphertext === 'string' &&
				/^[A-Za-z0-9+/=.:]+$/.test(a.ciphertext) &&
				a.ciphertext.length <= 24000))
	);
};
const key = () => {
	if (!/^[a-fA-F0-9]{64}$/.test(env.NTS_PLAYLIST_AUTH_KEY ?? ''))
		throw new Error('Background authorization unavailable');
	return Buffer.from(env.NTS_PLAYLIST_AUTH_KEY!, 'hex');
};
const aad = (purpose: string) => {
	const c = hostedConfiguration();
	if (!c) throw new Error('Background authorization unavailable');
	return Buffer.from(JSON.stringify([purpose, c.origin, c.userId]));
};
export function encryptPlaylistAuthorization(
	refresh: string,
	purpose = 'nts-background-spotify-v1'
) {
	if (!refresh.trim() || refresh.length > 16384)
		throw new Error('Background authorization unavailable');
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(aad(purpose));
	const encrypted = Buffer.concat([cipher.update(refresh, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
}
export function decryptPlaylistAuthorization(
	ciphertext: string,
	purpose = 'nts-background-spotify-v1'
) {
	const [iv, tag, data] = ciphertext.split('.').map((p) => Buffer.from(p, 'base64'));
	const cipher = createDecipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(aad(purpose));
	cipher.setAuthTag(tag);
	return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export class BackgroundAuthorizationError extends Error {
	constructor() {
		super('Background Spotify authorization required');
		this.name = 'BackgroundAuthorizationError';
	}
}
class BackgroundAuthorizationUnavailableError extends Error {
	constructor() {
		super('Background authorization unavailable');
		this.name = 'BackgroundAuthorizationUnavailableError';
	}
}
export class PlaylistAuthorization {
	constructor(
		private store = new ScheduleStore(),
		private request: typeof fetch = fetch
	) {}
	async connected() {
		return (
			(await this.store.getAutomation('playlist-authorization', isAuthorization))?.value
				.connected ?? false
		);
	}
	async connect(access: string, refresh: string, signal?: AbortSignal) {
		const profile = await getSpotifyProfile(this.request, access, signal);
		if (profile.id !== hostedConfiguration()?.userId) throw new BackgroundAuthorizationError();
		const existing = await this.store.getAutomation('playlist-authorization', isAuthorization);
		await this.store.putAutomation(
			'playlist-authorization',
			{
				generation: randomUUID(),
				connected: true,
				ciphertext: encryptPlaylistAuthorization(refresh),
				connectedAt: Date.now()
			},
			existing?.version ?? null
		);
	}
	async disconnect() {
		const existing = await this.store.getAutomation('playlist-authorization', isAuthorization);
		await this.store.putAutomation(
			'playlist-authorization',
			{ generation: randomUUID(), connected: false, connectedAt: Date.now() },
			existing?.version ?? null
		);
	}
	async token(signal?: AbortSignal) {
		const existing = await this.store.getAutomation('playlist-authorization', isAuthorization);
		if (!existing?.value.connected || !existing.value.ciphertext)
			throw new BackgroundAuthorizationError();
		let data;
		try {
			data = await rotateAccessToken(
				decryptPlaylistAuthorization(existing.value.ciphertext),
				signal,
				this.request
			);
		} catch (cause) {
			if (isSpotifyTokenAcquisitionError(cause) && cause.reason === 'authentication') {
				// CAS prevents an old revoked token from disabling a newer reconnect.
				await this.store.putAutomation(
					'playlist-authorization',
					{
						generation: existing.value.generation,
						connected: false,
						connectedAt: existing.value.connectedAt
					},
					existing.version
				);
				throw new BackgroundAuthorizationError();
			}
			throw new BackgroundAuthorizationUnavailableError();
		}
		// The shared playlist executor verifies /me and ownership on every request.
		// The encrypted refresh token was owner-verified on connection and bound by AAD.
		if (data.refreshToken) {
			await this.store.putAutomation(
				'playlist-authorization',
				{ ...existing.value, ciphertext: encryptPlaylistAuthorization(data.refreshToken) },
				existing.version
			);
		}
		return { accessToken: data.accessToken, generation: existing.value.generation };
	}
	async assertGeneration(generation: string) {
		const a = await this.store.getAutomation('playlist-authorization', isAuthorization);
		if (!a?.value.connected || a.value.generation !== generation)
			throw new BackgroundAuthorizationError();
	}
}
