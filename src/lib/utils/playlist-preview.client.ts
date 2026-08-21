import { isSpotifyPlaylistId } from './catalog-scan';

export type ClientSpotifyPlaylistPreview = {
	inputSignature: string;
	previewFingerprint: string;
	addedCount: number;
	removedCount: number;
	retainedCount: number;
	orderChanged: boolean;
	titleChanged: boolean;
	descriptionChanged: boolean;
	visibilityChanged: boolean;
	synchronized: boolean;
};

export const createPlaylistPreviewInputSignature = (input: {
	playlistId?: string;
	title: string;
	description: string;
	public: boolean;
	tracks: readonly string[];
	previewKey?: string;
}) =>
	JSON.stringify([
		input.playlistId ?? null,
		input.title,
		input.description,
		input.public,
		input.tracks,
		input.previewKey ?? null
	]);

const validCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const parseSpotifyPlaylistPreview = (
	value: unknown,
	playlistId: string,
	inputSignature: string
): ClientSpotifyPlaylistPreview | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const result = value as Record<string, unknown>;
	if (
		!isSpotifyPlaylistId(playlistId) ||
		result.mode !== 'preview' ||
		result.playlistId !== playlistId ||
		typeof result.previewFingerprint !== 'string' ||
		!/^[a-f0-9]{64}$/.test(result.previewFingerprint) ||
		!validCount(result.addedCount) ||
		!validCount(result.removedCount) ||
		!validCount(result.retainedCount) ||
		typeof result.orderChanged !== 'boolean' ||
		typeof result.titleChanged !== 'boolean' ||
		typeof result.descriptionChanged !== 'boolean' ||
		typeof result.visibilityChanged !== 'boolean' ||
		typeof result.synchronized !== 'boolean'
	) {
		return undefined;
	}
	return {
		inputSignature,
		previewFingerprint: result.previewFingerprint,
		addedCount: result.addedCount,
		removedCount: result.removedCount,
		retainedCount: result.retainedCount,
		orderChanged: result.orderChanged,
		titleChanged: result.titleChanged,
		descriptionChanged: result.descriptionChanged,
		visibilityChanged: result.visibilityChanged,
		synchronized: result.synchronized
	};
};

export const isPlaylistPreviewCurrent = (
	preview: ClientSpotifyPlaylistPreview | undefined,
	inputSignature: string
) => preview?.inputSignature === inputSignature;

export type PlaylistPreviewTransientState = {
	preview: ClientSpotifyPlaylistPreview | undefined;
	message: string;
	failure: string;
};

export const dismissPlaylistPreview = (
	state: PlaylistPreviewTransientState
): PlaylistPreviewTransientState => ({
	...state,
	preview: undefined,
	message: '',
	failure: ''
});

export type PlaylistActionGate = { active: boolean };

export const runExclusivePlaylistAction = async (
	gate: PlaylistActionGate,
	action: () => Promise<unknown>
) => {
	if (gate.active) return false;
	gate.active = true;
	try {
		await action();
		return true;
	} finally {
		gate.active = false;
	}
};
