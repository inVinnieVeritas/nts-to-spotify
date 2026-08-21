import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	createAbortError,
	createAbortScope,
	isAbortError,
	RequestTimeoutError
} from '$lib/utils/abort';
import { parseNTSShowCatalog } from '$lib/utils/catalog-update';
import { isValidNTSSlug } from '$lib/utils/nts';
import { getNTSShowCatalog } from '$lib/utils/nts.server';

const CATALOGUE_CHECK_TIMEOUT_MS = 30_000;

const parseRequestBody = async (request: Request, signal: AbortSignal) => {
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			request.json(),
			new Promise<never>((_resolve, reject) => {
				onAbort = () => {
					void request.body?.cancel().catch(() => undefined);
					reject(createAbortError());
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener('abort', onAbort, { once: true });
			})
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
};

export const POST: RequestHandler = async ({ request, fetch }) => {
	const scope = createAbortScope(request.signal, CATALOGUE_CHECK_TIMEOUT_MS);
	try {
		let showAlias: string | undefined;
		try {
			const body = (await parseRequestBody(request, scope.signal)) as { showAlias?: unknown };
			if (typeof body.showAlias === 'string') showAlias = body.showAlias;
		} catch (cause) {
			if (scope.didTimeout()) {
				console.error('Saved catalogue update check failed', 'nts_catalogue_timeout');
				return json({ error: 'nts_catalogue_timeout' }, { status: 504 });
			}
			if (isAbortError(cause) && request.signal.aborted) {
				return json({ error: 'request_cancelled' }, { status: 499 });
			}
			return json({ error: 'invalid_request' }, { status: 400 });
		}

		if (!showAlias || !isValidNTSSlug(showAlias)) {
			return json({ error: 'invalid_request' }, { status: 400 });
		}

		const catalog = parseNTSShowCatalog(
			await getNTSShowCatalog(showAlias, fetch as typeof globalThis.fetch, scope.signal),
			showAlias
		);
		return json({ catalog });
	} catch (cause) {
		if (cause instanceof RequestTimeoutError || scope.didTimeout()) {
			console.error('Saved catalogue update check failed', 'nts_catalogue_timeout');
			return json({ error: 'nts_catalogue_timeout' }, { status: 504 });
		}
		if (isAbortError(cause) && request.signal.aborted) {
			return json({ error: 'request_cancelled' }, { status: 499 });
		}
		console.error('Saved catalogue update check failed', 'nts_catalogue_unavailable');
		return json({ error: 'nts_catalogue_unavailable' }, { status: 502 });
	} finally {
		scope.cleanup();
	}
};
