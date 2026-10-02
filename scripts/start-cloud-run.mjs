import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STAGING_ORIGIN, validateCloudRunEnvironment } from './cloud-run-config.mjs';
export { STAGING_ORIGIN, validateCloudRunEnvironment };

export async function startCloudRun() {
	const configuration = validateCloudRunEnvironment(process.env);
	process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
	process.env.HOST = configuration.host;
	process.env.PORT = configuration.port;
	process.env.ORIGIN = configuration.origin;
	// Catalogue backups may contain thousands of reviewed tracks (maximum 10 MiB).
	process.env.BODY_SIZE_LIMIT = '11534336';
	process.env.SHUTDOWN_TIMEOUT = '8';
	// adapter-node owns the foreground listener and SIGTERM drain. Cloud Run terminates TLS.
	await import(pathToFileURL(resolve('build/index.js')).href);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	startCloudRun().catch(() => {
		console.error('Cloud Run staging startup failed. Check runtime configuration and build.');
		process.exitCode = 1;
	});
}
