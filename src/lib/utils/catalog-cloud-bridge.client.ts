const HOSTED_ORIGIN = 'https://nts2spotify.vincentvanderveken.com';
const LOCAL_ORIGIN = 'http://127.0.0.1:5173';
const REQUEST_TIMEOUT_MS = 30_000;

type BridgeReply = { status: number; body: unknown };
let bridgeWindow: Window | null = null;
let bridgeNonce = '';
let connected = false;
let bridgeOwnerId = '';
let nextId = 0;
const pending = new Map<
	number,
	{
		resolve: (reply: BridgeReply) => void;
		reject: () => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();

export const isLocalCloudBridge = () =>
	typeof location !== 'undefined' && location.origin === LOCAL_ORIGIN;
export const localCloudConnected = () =>
	isLocalCloudBridge() && connected && !!bridgeWindow && !bridgeWindow.closed;
export const localCloudOwnerMatches = (userId: string) =>
	localCloudConnected() && bridgeOwnerId === userId;

const receive = (event: MessageEvent) => {
	if (event.origin !== HOSTED_ORIGIN || event.source !== bridgeWindow || !bridgeNonce) return;
	const data = event.data;
	if (!data || data.nonce !== bridgeNonce) return;
	if (data.type === 'nts-cloud-bridge-ready') {
		if (typeof data.ownerId !== 'string' || !data.ownerId) return;
		bridgeOwnerId = data.ownerId;
		connected = true;
		window.dispatchEvent(new Event('nts-cloud-connected'));
	} else if (data.type === 'nts-cloud-bridge-response' && Number.isSafeInteger(data.id)) {
		const request = pending.get(data.id);
		if (!request) return;
		clearTimeout(request.timer);
		pending.delete(data.id);
		if (Number.isInteger(data.status) && data.status >= 100 && data.status <= 599)
			request.resolve({ status: data.status, body: data.body });
		else request.reject();
	}
};

export const connectLocalCloud = () => {
	if (!isLocalCloudBridge()) return false;
	if (localCloudConnected()) return true;
	if (bridgeWindow && !bridgeWindow.closed) bridgeWindow.close();
	bridgeNonce = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	connected = false;
	bridgeOwnerId = '';
	window.addEventListener('message', receive);
	bridgeWindow = window.open(
		`${HOSTED_ORIGIN}/cloud-bridge?nonce=${bridgeNonce}`,
		'nts-cloud-bridge',
		'popup,width=560,height=420'
	);
	return !!bridgeWindow;
};

export const bridgeRequest = (
	method: 'GET' | 'PUT',
	path: string,
	body?: unknown
): Promise<BridgeReply> => {
	if (!localCloudConnected()) return Promise.reject(new Error('Cloud bridge disconnected'));
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error('Cloud bridge timed out'));
		}, REQUEST_TIMEOUT_MS);
		pending.set(id, { resolve, reject: () => reject(new Error('Invalid bridge reply')), timer });
		bridgeWindow!.postMessage(
			{ type: 'nts-cloud-bridge-request', nonce: bridgeNonce, id, method, path, body },
			HOSTED_ORIGIN
		);
	});
};
