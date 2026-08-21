import { describe, expect, it, vi } from 'vitest';
import { abortableDelay, isAbortError, RequestTimeoutError } from './abort';
import { fetchWithTimeout, type Fetcher } from './request';
import { mapWithConcurrency } from './spotify.server';

const pendingFetch: Fetcher = vi.fn(
	(_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				const error = new Error('aborted');
				error.name = 'AbortError';
				reject(error);
				return;
			}
			signal?.addEventListener(
				'abort',
				() => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				},
				{ once: true }
			);
		})
) as Fetcher;

describe('bounded requests and cancellation', () => {
	it('turns an exceeded fetch deadline into RequestTimeoutError', async () => {
		await expect(
			fetchWithTimeout(pendingFetch, 'https://example.test', {}, 10, (response) => response.json())
		).rejects.toBeInstanceOf(RequestTimeoutError);
	});

	it('propagates parent cancellation without reporting a timeout', async () => {
		const controller = new AbortController();
		const request = fetchWithTimeout(
			pendingFetch,
			'https://example.test',
			{},
			1_000,
			(response) => response.json(),
			controller.signal
		);
		controller.abort();

		await expect(request).rejects.toSatisfy(isAbortError);
	});

	it('keeps the deadline active while a response body is stalled', async () => {
		vi.useFakeTimers();
		try {
			const stalledBodyFetch = vi.fn(
				async () => new Response(new ReadableStream({ start: () => undefined }))
			) as unknown as Fetcher;
			const request = fetchWithTimeout(
				stalledBodyFetch,
				'https://example.test',
				{},
				25,
				(response) => response.json()
			);
			const expectation = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);

			await vi.advanceTimersByTimeAsync(25);
			await expectation;
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts and settles sibling workers after the first failure', async () => {
		let siblingAborted = false;
		const startedAt = Date.now();

		await expect(
			mapWithConcurrency([0, 1], 2, async (value, _index, signal) => {
				if (value === 0) throw new Error('first worker failed');
				try {
					await abortableDelay(5_000, signal);
				} catch (cause) {
					siblingAborted = isAbortError(cause);
					throw cause;
				}
				return value;
			})
		).rejects.toThrow('first worker failed');

		expect(siblingAborted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});
