import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '$lib/constants';
import { GET, POST } from './+server';

const event = () => {
	const writes: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
	return {
		writes,
		value: {
			url: new URL('http://127.0.0.1:5173/logout'),
			cookies: {
				set: (name: string, value: string, options: Record<string, unknown>) =>
					writes.push({ name, value, options })
			}
		}
	};
};

describe('logout', () => {
	it('does not clear authentication on GET', async () => {
		const request = event();
		const response = await GET(request.value as never);
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('POST');
		expect(request.writes).toEqual([]);
	});

	it('clears both authentication cookies only on POST', async () => {
		const request = event();
		await expect(POST(request.value as never)).rejects.toMatchObject({
			status: 303,
			location: '/'
		});
		expect(request.writes.map(({ name }) => name)).toEqual([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]);
		for (const write of request.writes) {
			expect(write.value).toBe('');
			expect(write.options).toMatchObject({
				httpOnly: true,
				sameSite: 'lax',
				secure: false,
				path: '/',
				maxAge: 0
			});
		}
	});
});
