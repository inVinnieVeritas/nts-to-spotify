import { createAbortError, createAbortScope, RequestTimeoutError } from './abort';

export type Fetcher = typeof fetch;

export const fetchWithTimeout = async <T>(
	request: Fetcher,
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number,
	consume: (response: Response) => Promise<T>,
	parentSignal?: AbortSignal
): Promise<T> => {
	const scope = createAbortScope(parentSignal, timeoutMs);
	let response: Response | undefined;
	let onAbort: (() => void) | undefined;

	try {
		response = await request(input, { ...init, signal: scope.signal });
		return await Promise.race([
			consume(response),
			new Promise<never>((_resolve, reject) => {
				onAbort = () => {
					void response?.body?.cancel().catch(() => undefined);
					reject(createAbortError());
				};
				if (scope.signal.aborted) onAbort();
				else scope.signal.addEventListener('abort', onAbort, { once: true });
			})
		]);
	} catch (cause) {
		if (scope.didTimeout()) throw new RequestTimeoutError();
		throw cause;
	} finally {
		if (onAbort) scope.signal.removeEventListener('abort', onAbort);
		scope.cleanup();
	}
};
