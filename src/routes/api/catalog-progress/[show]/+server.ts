import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';
import {
	CloudProgressError,
	loadCloudProgress,
	saveCloudProgress
} from '$lib/utils/catalog-cloud.server';
import { isValidNTSSlug } from '$lib/utils/nts';

const failure = (cause: unknown) => {
	if (cause instanceof CloudProgressError) {
		if (cause.kind === 'conflict') return json({ error: 'cloud_conflict' }, { status: 409 });
		if (cause.kind === 'invalid') return json({ error: 'invalid_progress' }, { status: 400 });
	}
	return json({ error: 'cloud_unavailable' }, { status: 503 });
};

const authorize = (event: Parameters<RequestHandler>[0]) => {
	if (!hostedConfiguration()) return json({ error: 'hosted_only' }, { status: 404 });
	if (!hasHostedSession(event)) return json({ error: 'not_authorized' }, { status: 401 });
	if (!isValidNTSSlug(event.params.show)) return json({ error: 'invalid_show' }, { status: 400 });
	return null;
};

export const GET: RequestHandler = async (event) => {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		const result = await loadCloudProgress(event.params.show);
		return result
			? json(result, { headers: { 'Cache-Control': 'no-store' } })
			: json({ error: 'cloud_missing' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		return failure(cause);
	}
};

export const PUT: RequestHandler = async (event) => {
	try {
		const denied = authorize(event);
		if (denied) return denied;
		if (event.request.headers.get('origin') !== hostedConfiguration()?.origin)
			return json({ error: 'invalid_origin' }, { status: 403 });
		if (!event.request.headers.get('content-type')?.startsWith('application/json'))
			return json({ error: 'invalid_request' }, { status: 415 });
		let body: { progress?: unknown; version?: unknown };
		try {
			body = (await event.request.json()) as typeof body;
		} catch {
			return json({ error: 'invalid_request' }, { status: 400 });
		}
		if (
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body) ||
			!('version' in body) ||
			(body.version !== null && typeof body.version !== 'string')
		)
			return json({ error: 'invalid_request' }, { status: 400 });
		const version = await saveCloudProgress(
			event.params.show,
			body.progress,
			body.version as string | null
		);
		return json({ version }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		return failure(cause);
	}
};
