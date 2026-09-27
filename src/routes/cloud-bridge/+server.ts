import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { hasHostedSession, hostedConfiguration } from '$lib/utils/hosted-access.server';

const LOCAL_ORIGIN = 'http://127.0.0.1:5173';

export const GET: RequestHandler = (event) => {
	const configuration = hostedConfiguration();
	if (!configuration) return new Response('Not found', { status: 404 });
	if (!hasHostedSession(event))
		return new Response('Sign in on the hosted site first', { status: 401 });
	const nonce = event.url.searchParams.get('nonce');
	if (!nonce || !/^[a-f0-9]{64}$/.test(nonce))
		return new Response('Invalid connection', { status: 400 });
	const scriptNonce = randomBytes(16).toString('base64');
	const script = `
const localOrigin = ${JSON.stringify(LOCAL_ORIGIN)};
const nonce = ${JSON.stringify(nonce)};
const ownerId = ${JSON.stringify(configuration.userId)};
let approved = false;
const button = document.getElementById('connect');
const status = document.getElementById('status');
button.addEventListener('click', () => {
  if (!window.opener) { status.textContent = 'Open this page from local Vite.'; return; }
  approved = true;
  window.opener.postMessage({ type: 'nts-cloud-bridge-ready', nonce, ownerId }, localOrigin);
  button.disabled = true;
  status.textContent = 'Connected. Keep this window open while using local Vite.';
});
window.addEventListener('message', async (event) => {
  if (!approved || event.origin !== localOrigin || event.source !== window.opener) return;
  const message = event.data;
  if (!message || message.type !== 'nts-cloud-bridge-request' || message.nonce !== nonce ||
      !Number.isSafeInteger(message.id) || message.id < 0) return;
  const allowed = message.method === 'GET'
    ? /^\\/api\\/catalog-progress(?:\\/[a-z0-9-]+)?$/.test(message.path)
    : message.method === 'PUT' && /^\\/api\\/catalog-progress\\/[a-z0-9-]+$/.test(message.path);
  if (!allowed) return;
  try {
    const response = await fetch(message.path, {
      method: message.method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(message.method === 'PUT' ? { headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.body) } : {})
    });
    const body = await response.json();
    event.source.postMessage({ type: 'nts-cloud-bridge-response', nonce, id: message.id,
      status: response.status, body }, localOrigin);
  } catch {
    event.source.postMessage({ type: 'nts-cloud-bridge-response', nonce, id: message.id,
      status: 503, body: null }, localOrigin);
  }
});`;
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect local cloud progress</title>
<h1>Connect local Vite to cloud progress?</h1><p>Allow the app at ${LOCAL_ORIGIN} to read and save your private catalogue progress. Keep this window open while syncing.</p>
<button id="connect">Connect local Vite</button><p id="status"></p><script nonce="${scriptNonce}">${script}</script></html>`;
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`
		}
	});
};
