import { randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const OAUTH_RETURN_PATH_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS;
const OAUTH_STATE = /^[A-Za-z0-9_-]{43}$/;
const MAX_RETURN_PATH_LENGTH = 2_048;

const hasControlCharacter = (value: string) =>
	Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});

export const createOAuthState = () => randomBytes(32).toString('base64url');

export const isValidOAuthState = (value: unknown): value is string =>
	typeof value === 'string' && OAUTH_STATE.test(value);

export const oauthStatesMatch = (actual: unknown, expected: unknown) => {
	if (!isValidOAuthState(actual) || !isValidOAuthState(expected)) return false;
	return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};

const isSafePathShape = (value: string) =>
	value.length > 0 &&
	value.length <= MAX_RETURN_PATH_LENGTH &&
	value[0] === '/' &&
	value[1] !== '/' &&
	!value.includes('\\') &&
	!hasControlCharacter(value);

export const normalizeSafeReturnPath = (value: unknown, fallback = '/') => {
	if (typeof value !== 'string' || !isSafePathShape(value)) return fallback;

	let decoded = value;
	for (let depth = 0; depth < 8; depth += 1) {
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			return fallback;
		}
		if (!isSafePathShape(next)) return fallback;
		if (next === decoded) break;
		if (depth === 7) return fallback;
		decoded = next;
	}

	try {
		const parsed = new URL(decoded, 'https://safe.invalid');
		if (parsed.origin !== 'https://safe.invalid') return fallback;
	} catch {
		return fallback;
	}

	return decoded;
};

export const getSafeReturnPathFromReferer = (referer: string | null, origin: string) => {
	if (!referer) return '/';
	try {
		const parsed = new URL(referer);
		if (parsed.origin !== origin || parsed.username || parsed.password) return '/';
		return normalizeSafeReturnPath(`${parsed.pathname}${parsed.search}`);
	} catch {
		return '/';
	}
};

export const secureCookieForUrl = (url: URL) => url.protocol === 'https:';
