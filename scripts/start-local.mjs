import { constants as fsConstants } from 'node:fs';
import { access, stat, readFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import * as tls from 'node:tls';

export const DEFAULT_LOCAL_HOST = '127.0.0.1';
export const DEFAULT_LOCAL_PORT = 5173;
export const REQUIRED_SPOTIFY_VARIABLES = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'];

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '..');

export class LocalLauncherError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [exitCode]
	 */
	constructor(message, exitCode = 1) {
		super(message);
		this.name = 'LocalLauncherError';
		this.exitCode = exitCode;
	}
}

/** @param {string} version */
export const isSupportedNodeVersion = (version) => {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24;
};

/** @param {string[]} argv */
export const parseLocalArguments = (argv) => {
	let mode = 'start';
	let host = DEFAULT_LOCAL_HOST;
	let port = DEFAULT_LOCAL_PORT;
	let origin;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check-node' || argument === '--setup-env') {
			mode = argument.slice(2);
			continue;
		}

		const [inlineName, inlineValue] = argument.includes('=')
			? argument.split(/=(.*)/s, 2)
			: [argument, undefined];
		const value =
			inlineValue ??
			(index + 1 < argv.length && ['--host', '--port', '--origin'].includes(argument)
				? argv[++index]
				: undefined);

		if (inlineName === '--host' && value) {
			host = value;
			continue;
		}
		if (inlineName === '--port' && value) {
			if (!/^\d+$/.test(value)) {
				throw new LocalLauncherError('Local port must be an integer from 1 through 65535.');
			}
			port = Number(value);
			continue;
		}
		if (inlineName === '--origin' && value) {
			origin = value;
			continue;
		}
		throw new LocalLauncherError('Unknown local launcher option.');
	}

	if (host !== DEFAULT_LOCAL_HOST) {
		throw new LocalLauncherError('Local mode may bind only to 127.0.0.1.');
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new LocalLauncherError('Local port must be an integer from 1 through 65535.');
	}

	const expectedOrigin = `http://${host}:${port}`;
	const selectedOrigin = origin ?? expectedOrigin;
	let parsedOrigin;
	try {
		parsedOrigin = new URL(selectedOrigin);
	} catch {
		throw new LocalLauncherError('Local origin must be a valid loopback HTTP origin.');
	}
	if (
		parsedOrigin.protocol !== 'http:' ||
		parsedOrigin.hostname !== host ||
		Number(parsedOrigin.port || 80) !== port ||
		parsedOrigin.pathname !== '/' ||
		parsedOrigin.search ||
		parsedOrigin.hash ||
		parsedOrigin.username ||
		parsedOrigin.password
	) {
		throw new LocalLauncherError(
			`Local origin must exactly match ${expectedOrigin} and contain no path or credentials.`
		);
	}

	return { mode, host, port, origin: expectedOrigin };
};

// Adapter controls are never taken from local configuration or inherited shells.
const ADAPTER_CONTROLS = new Set([
	'SOCKET_PATH',
	'LISTEN_PID',
	'LISTEN_FDS',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'SHUTDOWN_TIMEOUT',
	'IDLE_TIMEOUT',
	'KEEP_ALIVE_TIMEOUT',
	'HEADERS_TIMEOUT'
]);

/** @param {NodeJS.ProcessEnv} environment @param {boolean} [fromFile] */
export const validateRuntimeControls = (environment, fromFile = false) => {
	for (const [key, value] of Object.entries(environment)) {
		const name = key.toUpperCase();
		if (!value) continue;
		if (name === 'NODE_TLS_REJECT_UNAUTHORIZED' && value.trim() === '0') {
			throw new LocalLauncherError(
				'TLS certificate verification is disabled. Remove NODE_TLS_REJECT_UNAUTHORIZED=0 before starting.',
				78
			);
		}
		// The one safe inherited option supports npm commands on managed Windows networks.
		if (!fromFile && name === 'NODE_OPTIONS' && value.trim() === '--use-system-ca') continue;
		if (ADAPTER_CONTROLS.has(name) || (name.startsWith('NODE_') && name !== 'NODE_ENV')) {
			throw new LocalLauncherError(
				'Unsupported runtime or listener configuration. Remove local runtime overrides.',
				78
			);
		}
	}
};

/** @param {NodeJS.ProcessEnv} environment */
export const validateRuntimeEnvironment = (environment) => {
	validateRuntimeControls(environment);
	const missing = REQUIRED_SPOTIFY_VARIABLES.filter(
		(name) => typeof environment[name] !== 'string' || environment[name]?.trim().length === 0
	);
	if (missing.length > 0) {
		throw new LocalLauncherError(
			'Configuration is incomplete. Add non-empty SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET entries to .env.',
			78
		);
	}
};

/** Parse as data: never pass an environment file to Node's command-line loader.
 * @param {string} text
 */
export const parseLocalConfiguration = (text) => {
	if (Buffer.byteLength(text, 'utf8') > 65_536)
		throw new LocalLauncherError('Local configuration is too large.', 78);
	let parsed;
	try {
		parsed = parseEnv(text);
	} catch {
		throw new LocalLauncherError('Local configuration could not be parsed.', 78);
	}
	validateRuntimeControls(parsed, true);
	/** @type {NodeJS.ProcessEnv} */
	const credentials = {};
	for (const name of REQUIRED_SPOTIFY_VARIABLES) {
		const entries = Object.entries(parsed).filter(([key]) => key.toUpperCase() === name);
		if (entries.length !== 1)
			throw new LocalLauncherError(
				'Configuration requires one entry for each Spotify credential.',
				78
			);
		credentials[name] = entries[0][1];
	}
	validateRuntimeEnvironment(credentials);
	return credentials;
};

/** Existing files are never opened or overwritten, including concurrent setup.
 * @param {string} projectRoot
 */
export const createLocalEnvironment = async (projectRoot) => {
	try {
		await copyFile(
			join(projectRoot, '.env.example'),
			join(projectRoot, '.env'),
			fsConstants.COPYFILE_EXCL
		);
		return true;
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST')
			return false;
		throw new LocalLauncherError(
			'Could not create local configuration. Check the template and directory permissions.',
			78
		);
	}
};

/**
 * @param {string} projectRoot
 * @param {(path: string, mode?: number) => Promise<void>} accessFile
 */
export const verifyLocalFiles = async (projectRoot, accessFile = access) => {
	try {
		await accessFile(join(projectRoot, '.env'), fsConstants.R_OK);
	} catch {
		throw new LocalLauncherError(
			'Missing .env. Copy .env.example to .env and add your Spotify credentials.',
			78
		);
	}
	try {
		await accessFile(join(projectRoot, 'build', 'index.js'), fsConstants.R_OK);
	} catch {
		throw new LocalLauncherError(
			'Production build is missing. Run npm ci and npm run build before starting local mode.',
			78
		);
	}
};

/**
 * @param {string} projectRoot
 * @param {(path: string) => Promise<import('node:fs').Stats>} statPath
 * @param {(path: string, mode?: number) => Promise<void>} accessFile
 */
export const verifyCacheLocation = async (projectRoot, statPath = stat, accessFile = access) => {
	const candidates = [
		join(projectRoot, '.data', 'spotify-match-cache'),
		join(projectRoot, '.data'),
		projectRoot
	];
	for (const candidate of candidates) {
		try {
			const details = await statPath(candidate);
			if (!details.isDirectory()) {
				throw new LocalLauncherError('The local Spotify cache path exists but is not a directory.');
			}
			try {
				await accessFile(candidate, fsConstants.R_OK | fsConstants.W_OK);
			} catch {
				throw new LocalLauncherError(
					'The local Spotify cache location is not writable by this user.'
				);
			}
			return;
		} catch (cause) {
			if (cause instanceof LocalLauncherError) throw cause;
			if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
				continue;
			}
			throw new LocalLauncherError('The local Spotify cache location could not be checked.');
		}
	}
	throw new LocalLauncherError('The local Spotify cache location could not be checked.');
};

/** @param {string} host @param {number} port */
export const assertPortAvailable = (host, port) =>
	new Promise((resolvePromise, rejectPromise) => {
		const probe = createServer();
		probe.unref();
		probe.once('error', (cause) => {
			const occupied =
				cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EADDRINUSE';
			rejectPromise(
				new LocalLauncherError(
					occupied
						? `Port ${port} is already in use on ${host}. Stop that application or use --port with another loopback port.`
						: `Port ${port} could not be opened on ${host}.`,
					occupied ? 75 : 1
				)
			);
		});
		probe.listen({ host, port, exclusive: true }, () => {
			probe.close((cause) => {
				if (cause) {
					rejectPromise(new LocalLauncherError('The local port check could not finish.'));
					return;
				}
				resolvePromise(undefined);
			});
		});
	});

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {{ host: string; port: number; origin: string }} local
 */
export const applyLocalEnvironment = (environment, local) => {
	// Delete case variants too: Windows environment keys are case-insensitive.
	for (const key of Object.keys(environment)) {
		const name = key.toUpperCase();
		if (
			ADAPTER_CONTROLS.has(name) ||
			name.startsWith('NODE_') ||
			['HOST', 'PORT', 'ORIGIN', ...REQUIRED_SPOTIFY_VARIABLES].includes(name)
		)
			delete environment[key];
	}
	Object.assign(environment, {
		HOST: local.host,
		PORT: String(local.port),
		ORIGIN: local.origin,
		NODE_ENV: 'production',
		SHUTDOWN_TIMEOUT: '30'
	});
};

/** Enable system roots before any HTTPS connection, without respawning Node.
 * Older supported Node versions safely retain their default trust store.
 */
export const enableSystemCertificates = () => {
	const api =
		/** @type {{ getCACertificates?: (type: string) => string[], setDefaultCACertificates?: (certificates: string[]) => void }} */ (
			tls
		);
	if (!api.getCACertificates || !api.setDefaultCACertificates) return false;
	api.setDefaultCACertificates([
		...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system')])
	]);
	return true;
};

/** The adapter handles native console SIGINT / POSIX signals in this same process.
 * Its 30-second connection drain is followed by a 35-second last-resort process bound.
 * No child.kill is used. A hard deadline can leave upstream operations ambiguous.
 * @param {NodeJS.Process} [runtime]
 * @param {number} [deadlineMs]
 */
export const installShutdownDeadline = (runtime = process, deadlineMs = 35_000) => {
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	const shutdown = () => {
		if (timer) return;
		timer = setTimeout(() => {
			console.error(
				'Local shutdown deadline reached; interrupted operations may require reconciliation.'
			);
			runtime.exit(1);
		}, deadlineMs);
		timer.unref();
	};
	runtime.on('SIGINT', shutdown);
	runtime.on('SIGTERM', shutdown);
	return () => {
		if (timer) clearTimeout(timer);
		runtime.off('SIGINT', shutdown);
		runtime.off('SIGTERM', shutdown);
	};
};

/** @param {unknown} cause */
export const renderLauncherError = (cause) =>
	cause instanceof LocalLauncherError
		? `NTS to Spotify could not start: ${cause.message}`
		: 'NTS to Spotify could not start because of an unexpected local launcher error.';

/** @param {string[]} [argv] */
export const runLocalLauncher = async (argv = process.argv.slice(2)) => {
	const projectRoot = DEFAULT_PROJECT_ROOT;
	const local = parseLocalArguments(argv);
	if (!isSupportedNodeVersion(process.versions.node))
		throw new LocalLauncherError('Unsupported Node version. Install current Node 24 LTS.', 64);
	validateRuntimeControls(process.env);
	process.chdir(projectRoot);
	if (local.mode === 'check-node') {
		console.log('Node is compatible. Current Node 24 LTS is recommended.');
		return 0;
	}
	if (local.mode === 'setup-env') {
		console.log(
			(await createLocalEnvironment(projectRoot))
				? 'Created .env. Add personal Spotify credentials before startup.'
				: 'Existing .env preserved.'
		);
		return 0;
	}
	await verifyLocalFiles(projectRoot);
	let configuration;
	try {
		const envPath = join(projectRoot, '.env');
		if ((await stat(envPath)).size > 65_536) throw new Error();
		configuration = parseLocalConfiguration(await readFile(envPath, 'utf8'));
	} catch (cause) {
		if (cause instanceof LocalLauncherError) throw cause;
		throw new LocalLauncherError('Local configuration could not be read.', 78);
	}
	await verifyCacheLocation(projectRoot);
	await assertPortAvailable(local.host, local.port);
	if (!enableSystemCertificates())
		console.warn(
			'Runtime system-CA support is unavailable. Update to current Node 24 LTS; default TLS verification remains enabled.'
		);
	applyLocalEnvironment(process.env, local);
	Object.assign(process.env, configuration);
	// Import only after all settings have been enforced; adapter owns the HTTP server.
	const { server } = await import(pathToFileURL(join(projectRoot, 'build', 'index.js')).href);
	await new Promise((resolvePromise, rejectPromise) => {
		const failed = () =>
			rejectPromise(
				new LocalLauncherError('Local server could not listen on the selected loopback port.')
			);
		server.server.once('error', failed);
		const ready = () => {
			server.server.off('error', failed);
			resolvePromise(undefined);
		};
		if (server.server.listening) ready();
		else server.server.once('listening', ready);
	});
	installShutdownDeadline();
	console.log(`Local URL: ${local.origin}/`);
	console.log(`Spotify redirect URI: ${local.origin}/login`);
	return 0;
};

const isEntryPoint =
	process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
	try {
		process.exitCode = await runLocalLauncher();
	} catch (cause) {
		console.error(renderLauncherError(cause));
		process.exitCode = cause instanceof LocalLauncherError ? cause.exitCode : 1;
	}
}
