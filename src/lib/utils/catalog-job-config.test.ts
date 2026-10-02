import { describe, expect, it } from 'vitest';
import { validateCloudRunEnvironment } from '../../../scripts/cloud-run-config.mjs';

const configuration = {
	NTS_HOSTED_STAGING: '1',
	ORIGIN: 'https://nts2spotify.vincentvanderveken.com',
	SPOTIFY_CLIENT_ID: 'test-client',
	SPOTIFY_CLIENT_SECRET: 'test-secret',
	STAGING_SPOTIFY_USER_ID: 'owner',
	STAGING_SESSION_SECRET: '0'.repeat(64)
};
describe('Cloud Run job configuration', () => {
	it('accepts a job without PORT while retaining the HTTP launcher requirement', () => {
		expect(() => validateCloudRunEnvironment(configuration, { job: true })).not.toThrow();
		expect(() => validateCloudRunEnvironment(configuration)).toThrow(
			'Invalid Cloud Run staging configuration'
		);
	});
	it('retains owner, origin, and runtime injection checks for jobs', () => {
		for (const override of [
			{ ORIGIN: 'https://other.test' },
			{ STAGING_SPOTIFY_USER_ID: '' },
			{ NODE_OPTIONS: '--require=untrusted.js' },
			{ SPOTIFY_CLIENT_SECRET: '' }
		]) {
			expect(() =>
				validateCloudRunEnvironment({ ...configuration, ...override }, { job: true })
			).toThrow('Invalid Cloud Run staging configuration');
		}
	});
});
