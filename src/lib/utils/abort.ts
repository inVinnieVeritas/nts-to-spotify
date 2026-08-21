export class RequestTimeoutError extends Error {
	constructor(message = 'Request timed out') {
		super(message);
		this.name = 'RequestTimeoutError';
	}
}

export const createAbortError = () => {
	const error = new Error('Request cancelled');
	error.name = 'AbortError';
	return error;
};

export const isAbortError = (cause: unknown) =>
	cause instanceof Error && cause.name === 'AbortError';

export const throwIfAborted = (signal?: AbortSignal) => {
	if (signal?.aborted) throw createAbortError();
};

export const abortableDelay = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		throwIfAborted(signal);

		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, Math.max(0, ms));
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(createAbortError());
		};
		const cleanup = () => signal?.removeEventListener('abort', onAbort);

		signal?.addEventListener('abort', onAbort, { once: true });
	});

export const createAbortScope = (parentSignal?: AbortSignal, timeoutMs?: number) => {
	const controller = new AbortController();
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	const onParentAbort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

	if (timeoutMs !== undefined) {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
	}

	return {
		controller,
		signal: controller.signal,
		didTimeout: () => timedOut,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			parentSignal?.removeEventListener('abort', onParentAbort);
		}
	};
};
