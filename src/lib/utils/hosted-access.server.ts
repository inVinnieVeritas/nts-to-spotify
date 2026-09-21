import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { error, type RequestEvent } from '@sveltejs/kit';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { STAGING_ORIGIN, validateCloudRunEnvironment } from '../../../scripts/start-cloud-run.mjs';

export const HOSTED_SESSION_COOKIE = '__Host-nts-staging';
const SESSION_SECONDS = 8 * 60 * 60;
const cookieOptions = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax' as const
};

export function hostedConfiguration() {
	if (!env.NTS_HOSTED_STAGING && !env.K_SERVICE) return null;
	try {
		validateCloudRunEnvironment(env);
	} catch {
		throw error(503, 'Hosted staging is not configured');
	}
	return {
		userId: env.STAGING_SPOTIFY_USER_ID as string,
		key: env.STAGING_SESSION_SECRET as string,
		origin: STAGING_ORIGIN
	};
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const sign = (value: string, configuration: NonNullable<ReturnType<typeof hostedConfiguration>>) =>
	createHmac('sha256', configuration.key)
		.update(JSON.stringify([configuration.origin, configuration.userId, value]))
		.digest('hex');

// Signed token hashes bind this proof to both Spotify cookies, not just a browser-provided ID.
// Access may have expired/been removed; renewal still requires the bound refresh cookie.
export function hasHostedSession(event: RequestEvent, now = Date.now()) {
	const configuration = hostedConfiguration();
	if (!configuration) return true;
	const proof = event.cookies.get(HOSTED_SESSION_COOKIE);
	const refresh = event.cookies.get(REFRESH_TOKEN_KEY);
	if (!proof || proof.length > 250 || !refresh) return false;
	const parts = proof.split('.');
	if (parts.length !== 4) return false;
	const [expires, accessHash, refreshHash, signature] = parts;
	if (
		!/^\d{13}$/.test(expires) ||
		![accessHash, refreshHash, signature].every((value) => /^[a-f0-9]{64}$/.test(value))
	)
		return false;
	const deadline = Number(expires);
	if (
		!Number.isSafeInteger(deadline) ||
		deadline <= now ||
		deadline > now + SESSION_SECONDS * 1000 ||
		refreshHash !== digest(refresh)
	)
		return false;
	const access = event.cookies.get(ACCESS_TOKEN_KEY);
	if (access && accessHash !== digest(access)) return false;
	const expected = sign(parts.slice(0, 3).join('.'), configuration);
	return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export function setHostedSession(
	event: RequestEvent,
	access: string,
	refresh: string,
	now = Date.now()
) {
	const configuration = hostedConfiguration();
	if (!configuration) return;
	const value = [now + SESSION_SECONDS * 1000, digest(access), digest(refresh)].join('.');
	event.cookies.set(HOSTED_SESSION_COOKIE, value + '.' + sign(value, configuration), {
		...cookieOptions,
		maxAge: SESSION_SECONDS
	});
}

export function clearHostedSession(event: RequestEvent) {
	if (!hostedConfiguration()) return;
	event.cookies.set(HOSTED_SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
}
