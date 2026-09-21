import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGING_ORIGIN, validateCloudRunEnvironment } from '../../../scripts/start-cloud-run.mjs';

const settings = {
	NTS_HOSTED_STAGING: '1',
	ORIGIN: STAGING_ORIGIN,
	PORT: '8080',
	SPOTIFY_CLIENT_ID: 'dummy',
	SPOTIFY_CLIENT_SECRET: 'dummy',
	STAGING_SPOTIFY_USER_ID: 'dummy-user',
	STAGING_SESSION_SECRET: 'a'.repeat(64)
};
describe('Cloud Run startup boundary', () => {
	it('uses the supplied port with a fixed TLS origin and container listener', () => {
		expect(validateCloudRunEnvironment({ ...settings, PORT: '12345' })).toEqual({
			host: '0.0.0.0',
			port: '12345',
			origin: STAGING_ORIGIN
		});
	});
	it.each([
		{ PORT: '0' },
		{ PORT: '65536' },
		{ PORT: '80x' },
		{ ORIGIN: 'http://localhost' },
		{ HOST: '127.0.0.1' },
		{ SOCKET_PATH: '/tmp/socket' },
		{ HOST_HEADER: 'x-forwarded-host' },
		{ ENV_PREFIX: 'BYPASS_' },
		{ LISTEN_FDS: '1' },
		{ NODE_TLS_REJECT_UNAUTHORIZED: '0' },
		{ NODE_OPTIONS: '--require harmless-marker' },
		{ node_options: '--require harmless-marker' },
		{ STAGING_SESSION_SECRET: '' },
		{ STAGING_SPOTIFY_USER_ID: 'bad\nvalue' },
		{ NTS_HOSTED_STAGING: '' }
	])('rejects invalid configuration without reflecting its contents (%j)', (override) => {
		expect(() => validateCloudRunEnvironment({ ...settings, ...override })).toThrow(
			'Invalid Cloud Run staging configuration'
		);
	});
	it('permits system certificates without disabling TLS', () => {
		expect(() =>
			validateCloudRunEnvironment({ ...settings, NODE_OPTIONS: '--use-system-ca' })
		).not.toThrow();
	});
	it('actual entrypoint exits without starting a listener when secrets are absent', () => {
		const result = spawnSync(process.execPath, [resolve('scripts/start-cloud-run.mjs')], {
			encoding: 'utf8',
			timeout: 10_000,
			env: { NTS_HOSTED_STAGING: '1', PORT: '8080', ORIGIN: STAGING_ORIGIN }
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr.trim()).toBe(
			'Cloud Run staging startup failed. Check runtime configuration and build.'
		);
	});
	it('uses explicit container copies and deny-by-default upload rules', () => {
		const docker = readFileSync('Dockerfile', 'utf8');
		expect(docker).not.toMatch(/COPY\s+\.\s/);
		expect(docker).toContain('USER node');
		expect(docker).not.toContain('ARG SPOTIFY');
		expect(readFileSync('.dockerignore', 'utf8')).toContain('\n**\n');
		expect(readFileSync('.gcloudignore', 'utf8')).toContain('#!include:.dockerignore');
	});
});
