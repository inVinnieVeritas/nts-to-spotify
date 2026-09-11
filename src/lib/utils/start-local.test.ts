import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertPortAvailable,
	createLocalEnvironment,
	installShutdownDeadline,
	isSupportedNodeVersion,
	parseLocalArguments,
	parseLocalConfiguration,
	renderLauncherError,
	validateRuntimeControls,
	verifyCacheLocation,
	verifyLocalFiles
} from '../../../scripts/start-local.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directories: string[] = [];
const children: ChildProcess[] = [];
const dummy = 'SPOTIFY_CLIENT_ID=dummy-client\nSPOTIFY_CLIENT_SECRET=dummy-secret\n';
const cleanEnvironment = (): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/^(NODE_|HOST$|PORT$|ORIGIN$|SOCKET_PATH$|LISTEN_|SPOTIFY_)/i.test(key)
		)
	);

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			// Failure cleanup targets only this test's process, never user processes.
			const stopped = new Promise<void>((done) => child.once('close', () => done()));
			child.kill();
			await stopped;
		}
	}
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

const temporaryProject = async (configuration: string | null = dummy) => {
	const root = await mkdtemp(join(tmpdir(), 'nts2s launcher ! space '));
	directories.push(root);
	await mkdir(join(root, 'scripts'));
	await mkdir(join(root, 'build'));
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await copyFile(
		join(sourceRoot, 'scripts/start-local.mjs'),
		join(root, 'scripts/start-local.mjs')
	);
	await writeFile(join(root, '.env.example'), dummy);
	if (configuration !== null) await writeFile(join(root, '.env'), configuration);
	// Controlled local HTTP fixture: no application imports or upstream requests.
	await writeFile(
		join(root, 'build/index.js'),
		`
import { createServer } from 'node:http';
const http = createServer((req, res) => res.end('local fixture'));
http.listen(Number(process.env.PORT), process.env.HOST, () => {
  process.send?.({ ready: true, address: http.address(), origin: process.env.ORIGIN, cwd: process.cwd() });
});
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) return;
  stopping = true;
  http.close(() => { process.disconnect?.(); });
});
process.on('message', () => process.emit('SIGINT'));
export const server = { server: http };
`
	);
	return root;
};

const launch = (root: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
	const child = spawn(process.execPath, [join(root, 'scripts/start-local.mjs'), ...args], {
		cwd: tmpdir(),
		env: { ...cleanEnvironment(), ...extra },
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		shell: false
	});
	children.push(child);
	let output = '';
	child.stdout!.on('data', (data) => {
		output += data.toString();
	});
	child.stderr!.on('data', (data) => {
		output += data.toString();
	});
	const closed = new Promise<{ code: number | null; output: string }>((done, reject) => {
		child.once('error', reject);
		child.once('close', (code) => done({ code, output }));
	});
	return { child, closed };
};

const unusedPort = async () => {
	const probe = createServer();
	await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
	const address = probe.address();
	if (!address || typeof address === 'string') throw new Error('Expected loopback address');
	await new Promise<void>((done) => probe.close(() => done()));
	return address.port;
};

describe('actual isolated launcher boundary', () => {
	it('rejects direct internal-entry arguments and never echoes secret-bearing options', async () => {
		const root = await temporaryProject();
		for (const arg of ['--child', '--unknown=dummy-private-value']) {
			const result = await launch(root, [arg]).closed;
			expect(result.code).toBe(1);
			expect(result.output).toContain('Unknown local launcher option.');
			expect(result.output).not.toContain(arg);
			expect(result.output).not.toContain('dummy-private-value');
		}
	});

	it.each([
		'NODE_OPTIONS=--conditions=harmless-marker',
		'node_options=--conditions=harmless-marker',
		'SOCKET_PATH=harmless-marker',
		'socket_path=harmless-marker',
		'LISTEN_FDS=1',
		'HOST_HEADER=harmless-marker',
		'BODY_SIZE_LIMIT=harmless-marker',
		'NODE_TLS_REJECT_UNAUTHORIZED=0',
		'node_tls_reject_unauthorized=0'
	])('rejects file runtime controls as data: %s', async (entry) => {
		const root = await temporaryProject(dummy + entry);
		const result = await launch(root).closed;
		expect(result.code).toBe(78);
		expect(result.output).not.toContain('harmless-marker');
		expect(result.output).not.toContain('dummy-secret');
		expect(result.output).not.toContain('Local URL:');
	});

	it.each(['SOCKET_PATH', 'socket_path', 'LISTEN_FDS', 'NODE_TLS_REJECT_UNAUTHORIZED'])(
		'rejects inherited %s before importing the server',
		async (name) => {
			const root = await temporaryProject();
			const result = await launch(root, [], { [name]: name.includes('TLS') ? '0' : '1' }).closed;
			expect(result.code).toBe(78);
			expect(result.output).not.toContain('Local URL:');
		}
	);

	it('rejects harmless inherited Node options rather than carrying them into startup', async () => {
		const root = await temporaryProject();
		const result = await launch(root, [], { NODE_OPTIONS: '--conditions=harmless-marker' }).closed;
		expect(result.code).toBe(78);
		expect(result.output).not.toContain('harmless-marker');
	});

	it('enforces installation cwd and loopback despite file and inherited host/origin variants; shuts down and releases port', async () => {
		const root = await temporaryProject(
			dummy + 'HOST=0.0.0.0\nPORT=1\nORIGIN=http://invalid.example\n'
		);
		const port = await unusedPort();
		const running = launch(root, ['--port', String(port)], {
			Host: '0.0.0.0',
			host: '0.0.0.0',
			PORT: '2',
			ORIGIN: 'http://invalid.example'
		});
		const ready = await new Promise<unknown>((done) => running.child.once('message', done));
		expect(ready).toEqual({
			ready: true,
			address: { address: '127.0.0.1', family: 'IPv4', port },
			origin: `http://127.0.0.1:${port}`,
			cwd: root
		});
		expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('local fixture');
		// Real process on this OS, cooperative signal-event delivery via fixture IPC.
		// This does not pretend to test a physical Windows console Ctrl+C.
		running.child.send('request-shutdown');
		expect((await running.closed).code).toBe(0);
		await expect(assertPortAvailable('127.0.0.1', port)).resolves.toBeUndefined();
	});

	it('reports missing configuration, build, empty credentials and invalid cache location without secrets', async () => {
		const root = await temporaryProject(null);
		expect((await launch(root).closed).output).toContain('Missing .env');
		await writeFile(
			join(root, '.env'),
			'SPOTIFY_CLIENT_ID=\nSPOTIFY_CLIENT_SECRET=dummy-private-value'
		);
		const empty = await launch(root).closed;
		expect(empty.output).toContain('Configuration is incomplete');
		expect(empty.output).not.toContain('dummy-private-value');
		await writeFile(join(root, '.env'), dummy);
		await writeFile(join(root, '.data'), 'not a directory');
		expect((await launch(root).closed).output).toContain('not a directory');
		await rm(join(root, 'build/index.js'));
		expect((await launch(root).closed).output).toContain('Production build is missing');
	});

	it('propagates port-in-use failure without switching ports', async () => {
		const root = await temporaryProject();
		const listener = createServer();
		await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
		const address = listener.address();
		if (!address || typeof address === 'string') throw new Error('Expected address');
		try {
			const result = await launch(root, ['--port', String(address.port)]).closed;
			expect(result.code).toBe(75);
			expect(result.output).toContain('already in use');
		} finally {
			await new Promise<void>((done) => listener.close(() => done()));
		}
	});

	it('exclusive setup survives concurrent processes and never overwrites an existing dummy configuration', async () => {
		const root = await temporaryProject(null);
		const results = await Promise.all(
			Array.from({ length: 4 }, () => launch(root, ['--setup-env']).closed)
		);
		expect(results.every((result) => result.code === 0)).toBe(true);
		expect(results.filter((result) => result.output.includes('Created .env.'))).toHaveLength(1);
		expect(await readFile(join(root, '.env'), 'utf8')).toBe(dummy);
		await writeFile(join(root, '.env'), 'existing dummy configuration');
		expect(await createLocalEnvironment(root)).toBe(false);
		expect(await readFile(join(root, '.env'), 'utf8')).toBe('existing dummy configuration');
	});
});

describe('validation and bounded shutdown', () => {
	it('validates loopback options, compatible versions, and fixed errors', () => {
		expect(parseLocalArguments([])).toMatchObject({
			host: '127.0.0.1',
			port: 5173,
			origin: 'http://127.0.0.1:5173'
		});
		expect(() => parseLocalArguments(['--host', '0.0.0.0'])).toThrow('only to 127.0.0.1');
		expect(() =>
			parseLocalArguments(['--port', '5174', '--origin', 'http://127.0.0.1:5173'])
		).toThrow('exactly match');
		for (const version of ['20.19.0', '22.13.0', '24.0.0'])
			expect(isSupportedNodeVersion(version)).toBe(true);
		expect(isSupportedNodeVersion('18.20.0')).toBe(false);
		expect(renderLauncherError({ private: 'dummy-private-value' })).not.toContain(
			'dummy-private-value'
		);
		expect(() => parseLocalConfiguration(dummy + 'spotify_client_secret=duplicate')).toThrow(
			'one entry'
		);
		expect(() => validateRuntimeControls({ node_options: '--conditions=harmless-marker' })).toThrow(
			'Unsupported runtime'
		);
	});

	it('reports permission failures using a fixed message', async () => {
		const root = await temporaryProject();
		await expect(
			verifyCacheLocation(root, undefined, async () => {
				throw new Error('dummy-private-value');
			})
		).rejects.toThrow('not writable');
		await expect(
			verifyLocalFiles(root, async () => {
				throw new Error('dummy-private-value');
			})
		).rejects.toThrow('Missing .env');
	});

	it('bounds cleanup without signal-forwarding or resetting the deadline (simulated clock)', () => {
		vi.useFakeTimers();
		const runtime = Object.assign(new EventEmitter(), { exit: vi.fn() });
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const cleanup = installShutdownDeadline(runtime as unknown as NodeJS.Process);
		runtime.emit('SIGINT');
		vi.advanceTimersByTime(30_000);
		runtime.emit('SIGTERM');
		expect(runtime.exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(5_000);
		expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('may require reconciliation'));
		cleanup();
		expect(runtime.listenerCount('SIGINT')).toBe(0);
	});
});

describe.skipIf(process.platform !== 'win32')('executed Windows command wrappers', () => {
	const wrapper = async (
		root: string,
		name: string,
		transform?: (text: string) => string,
		extra: NodeJS.ProcessEnv = {}
	) => {
		const original = await readFile(join(sourceRoot, name), 'utf8');
		await writeFile(join(root, name), transform ? transform(original) : original);
		const child = spawn('cmd.exe', ['/d', '/v:on', '/c', name], {
			cwd: tmpdir(),
			env: { ...cleanEnvironment(), PATH: `${root};${process.env.PATH}`, ...extra },
			shell: false
		});
		children.push(child);
		let output = '';
		child.stdout!.on('data', (data) => {
			output += data;
		});
		child.stderr!.on('data', (data) => {
			output += data;
		});
		return await new Promise<{ code: number | null; output: string }>((done, reject) => {
			child.on('error', reject);
			child.on('close', (code) => done({ code, output }));
		});
	};

	it.each(['start-local.cmd', 'setup-local.cmd'])(
		'handles spaces/! and its own directory: %s',
		async (name) => {
			const root = await temporaryProject(null);
			// npm stub makes setup a harmless real cmd/Node filesystem test, not an install/build.
			await writeFile(join(root, 'npm.cmd'), '@echo off\r\nexit /b 23\r\n');
			const result = await wrapper(root, name);
			expect(result.code).toBe(name === 'start-local.cmd' ? 78 : 23);
			expect(result.output).toContain(
				name === 'start-local.cmd' ? 'Missing .env' : 'Dependency installation failed'
			);
			if (name === 'setup-local.cmd')
				expect(await readFile(join(root, '.env'), 'utf8')).toBe(dummy);
		}
	);

	it.each(['start-local.cmd', 'setup-local.cmd'])(
		'fails before execution when directory selection fails: %s',
		async (name) => {
			const root = await temporaryProject(null);
			// Controlled fault injection changes only the copied wrapper's cd target.
			const result = await wrapper(root, name, (text) =>
				text.replace('cd /d "%~dp0"', `cd /d "${join(root, 'absent')}"`)
			);
			expect(result.code).toBe(1);
			expect(result.output).toContain('Could not select the installation directory');
			await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);

	it.each(['start-local.cmd', 'setup-local.cmd'])(
		'rejects UNC installation paths without contacting a share: %s',
		async (name) => {
			const root = await temporaryProject(null);
			const result = await wrapper(root, name, (text) =>
				text.replace(
					'set "NTS2S_DIR=%~dp0"',
					'set "NTS2S_DIR=\\\\unused-test-share\\installation\\"'
				)
			);
			expect(result.code).toBe(1);
			expect(result.output).toContain('UNC installations are not supported');
			await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);

	it.each(['start-local.cmd', 'setup-local.cmd'])(
		'rejects inherited runtime controls before invoking Node: %s',
		async (name) => {
			const root = await temporaryProject(null);
			for (const extra of [
				{ NODE_OPTIONS: '--conditions=harmless-marker' },
				{ node_tls_reject_unauthorized: '0' }
			]) {
				const result = await wrapper(root, name, undefined, extra);
				expect(result.code).toBe(78);
				expect(result.output).toContain('Remove inherited');
				expect(result.output).not.toContain('harmless-marker');
			}
			await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
		}
	);
});
