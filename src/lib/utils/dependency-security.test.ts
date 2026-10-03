import { describe, expect, it } from 'vitest';
import { parse as parseCookie, serialize } from 'cookie';
import { parse, stringify, uneval } from 'devalue';
import { braceExpand } from 'minimatch';

describe('patched build-time dependencies used by the production bundle', () => {
	it('rejects cookie-name attribute injection', () => {
		expect(() => serialize('session; Secure', 'dummy')).toThrow(TypeError);
	});
	it.each([{ path: '/; Secure' }, { domain: 'example.com; Secure' }])(
		'rejects cookie attribute injection in %j',
		(options) => {
			expect(() => serialize('session', 'dummy', options)).toThrow(TypeError);
		}
	);
	it('preserves normal secure OAuth cookie serialization and parsing', () => {
		const header = serialize('nts_session', 'dummy value', {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 3600
		});
		expect(header).toBe(
			'nts_session=dummy%20value; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax'
		);
		expect(parseCookie(header).nts_session).toBe('dummy value');
	});
	it('does not serialize unrelated bytes from a Node Buffer backing store', () => {
		// An entirely initialized dummy backing store: never inspect a real process pool.
		const backing = new Uint8Array(32).fill(126);
		backing.set([1, 2], 4);
		const view = Buffer.from(backing.buffer, 4, 2);
		const restored = parse(stringify(view)) as Uint8Array;
		expect(Array.from(restored)).toEqual([1, 2]);
		expect(restored.buffer.byteLength).toBe(2);
		expect(uneval(view)).toBe('new Uint8Array([1,2])');
	});
	it('preserves ordinary minimatch brace expansion used by lint tooling', () => {
		expect(braceExpand('src/{components,lib}/file.{js,ts}')).toEqual([
			'src/components/file.js',
			'src/components/file.ts',
			'src/lib/file.js',
			'src/lib/file.ts'
		]);
	});
});
