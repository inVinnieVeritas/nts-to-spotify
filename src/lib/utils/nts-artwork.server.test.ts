import { describe, expect, it, vi } from 'vitest';
import { createNTSArtworkLoader } from './nts-artwork.server';

const cover = 'https://media2.ntslive.co.uk/resize/800x800/dimension-door.jpeg';
const metadata = (url = cover) =>
	new Response(JSON.stringify({ media: { picture_medium_large: url } }));

describe('saved catalogue artwork lookup', () => {
	it('fetches only NTS show metadata and reuses the artwork without loading episode pages', async () => {
		let now = 0;
		const request = vi.fn(async () => metadata());
		const load = createNTSArtworkLoader(request as typeof fetch, () => now);
		expect(await load('dimension-door')).toBe(cover);
		now = 60_000;
		expect(await load('dimension-door')).toBe(cover);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			'https://www.nts.live/api/v2/shows/dimension-door',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		now = 6 * 60 * 60 * 1_000;
		expect(await load('dimension-door')).toBe(cover);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('shares a pending metadata lookup between simultaneous image requests', async () => {
		let resolve!: (response: Response) => void;
		const request = vi.fn(() => new Promise<Response>((done) => (resolve = done)));
		const load = createNTSArtworkLoader(request as typeof fetch);
		const first = load('dimension-door');
		const second = load('dimension-door');
		resolve(metadata());
		expect(await Promise.all([first, second])).toEqual([cover, cover]);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('keeps unapproved URLs out and retries transient failures after a short cooldown', async () => {
		let now = 0;
		const request = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('NTS unavailable'))
			.mockResolvedValueOnce(metadata('https://127.0.0.1/private.jpg'))
			.mockImplementation(async () => metadata());
		const load = createNTSArtworkLoader(request as typeof fetch, () => now);
		expect(await load('dimension-door')).toBeUndefined();
		expect(await load('dimension-door')).toBeUndefined();
		expect(request).toHaveBeenCalledTimes(1);
		now = 60_000;
		expect(await load('dimension-door')).toBeUndefined();
		now = 120_000;
		expect(await load('dimension-door')).toBe(cover);
	});

	it('rejects invalid aliases before network access and bounds the process cache', async () => {
		const request = vi.fn(async () => metadata());
		const load = createNTSArtworkLoader(request as typeof fetch);
		for (const alias of ['../private', 'show?limit=100', 'a'.repeat(201)]) {
			expect(await load(alias)).toBeUndefined();
		}
		expect(request).not.toHaveBeenCalled();
		for (let index = 0; index < 201; index++) await load(`show-${index}`);
		await load('show-200');
		expect(request).toHaveBeenCalledTimes(201);
		await load('show-0');
		expect(request).toHaveBeenCalledTimes(202);
	});
});
