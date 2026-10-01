export const STAGING_ORIGIN = 'https://nts2spotify.vincentvanderveken.com';

/** Validate runtime configuration as data; never load an environment file.
 * @param {Record<string, string | undefined>} env
 * @param {{job?: boolean}} options
 */
export function validateCloudRunEnvironment(env, options = {}) {
	const invalid = () => {
		throw new Error('Invalid Cloud Run staging configuration');
	};
	if (
		env.NTS_HOSTED_STAGING !== '1' ||
		env.ORIGIN !== STAGING_ORIGIN ||
		(!options.job && (!env.PORT || !/^[1-9]\d{0,4}$/.test(env.PORT) || Number(env.PORT) > 65535)) ||
		!env.SPOTIFY_CLIENT_ID?.trim() ||
		!env.SPOTIFY_CLIENT_SECRET?.trim() ||
		!env.STAGING_SPOTIFY_USER_ID ||
		!/^[A-Za-z0-9._-]{1,256}$/.test(env.STAGING_SPOTIFY_USER_ID) ||
		!env.STAGING_SESSION_SECRET ||
		!/^[a-f0-9]{64}$/.test(env.STAGING_SESSION_SECRET)
	)
		invalid();
	// No inherited alternative socket, forwarded-host or runtime injection controls.
	for (const [key, value] of Object.entries(env)) {
		const name = key.toUpperCase();
		if (
			(value &&
				[
					'SOCKET_PATH',
					'PROTOCOL_HEADER',
					'HOST_HEADER',
					'PORT_HEADER',
					'ADDRESS_HEADER',
					'XFF_DEPTH',
					'ENV_PREFIX',
					'NODE_PATH',
					'LISTEN_PID',
					'LISTEN_FDS'
				].includes(name)) ||
			(name === 'NODE_OPTIONS' && value && value !== '--use-system-ca') ||
			(name === 'NODE_TLS_REJECT_UNAUTHORIZED' && value === '0') ||
			(name === 'HOST' && value && value !== '0.0.0.0')
		)
			invalid();
	}
	return { host: '0.0.0.0', port: env.PORT, origin: STAGING_ORIGIN };
}
