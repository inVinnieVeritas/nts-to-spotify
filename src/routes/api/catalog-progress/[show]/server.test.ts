import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/hosted-access.server', () => ({
	hostedConfiguration: vi.fn(() => ({ origin: 'https://nts2spotify.vincentvanderveken.com' })),
	hasHostedSession: vi.fn(() => false)
}));
vi.mock('$lib/utils/catalog-cloud.server', () => ({
	loadCloudProgress: vi.fn(),
	saveCloudProgress: vi.fn()
}));

import { hasHostedSession } from '$lib/utils/hosted-access.server';
import { loadCloudProgress, saveCloudProgress } from '$lib/utils/catalog-cloud.server';
import { GET, PUT } from './+server';

const eventFor = (method: 'GET' | 'PUT', origin?: string) =>
	({
		params: { show: 'channeling' },
		request: new Request(
			'https://nts2spotify.vincentvanderveken.com/api/catalog-progress/channeling',
			{
				method,
				...(method === 'PUT'
					? {
							headers: {
								'Content-Type': 'application/json',
								...(origin ? { Origin: origin } : {})
							},
							body: JSON.stringify({ progress: {}, version: null })
						}
					: {})
			}
		)
	}) as Parameters<typeof GET>[0];

describe('cloud progress route boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('never reads Firestore without a signed owner session', async () => {
		const response = await GET(eventFor('GET'));
		expect(response.status).toBe(401);
		expect(loadCloudProgress).not.toHaveBeenCalled();
	});

	it('blocks cross-origin writes even with a signed owner session', async () => {
		vi.mocked(hasHostedSession).mockReturnValue(true);
		const response = await PUT(eventFor('PUT', 'https://attacker.example'));
		expect(response.status).toBe(403);
		expect(saveCloudProgress).not.toHaveBeenCalled();
	});
});
