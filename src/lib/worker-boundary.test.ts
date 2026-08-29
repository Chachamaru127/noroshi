import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const root = new URL('../../', import.meta.url);

function source(path: string): string {
	return readFileSync(new URL(path, root), 'utf8');
}

describe('generated SvelteKit worker type boundary', () => {
	test('source worker imports the declared runtime shim', () => {
		assert.match(source('src/worker.ts'), /from '\.\/sveltekit-worker\.js'/);
		assert.match(source('src/sveltekit-worker.d.ts'), /fetch\(request: Request/);
	});

	test('only the runtime shim imports generated build output', () => {
		assert.doesNotMatch(source('src/worker.ts'), /\.svelte-kit\/cloudflare/);
		assert.match(
			source('src/sveltekit-worker.js'),
			/from '\.\.\/\.svelte-kit\/cloudflare\/_sveltekit\.js'/
		);
	});

	test('the source formatter gate includes runtime JavaScript shims', () => {
		const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
		assert.match(pkg.scripts.format, /src\/\*\*\/\*\.\{ts,js,svelte\}/);
		assert.match(pkg.scripts['format:check'], /src\/\*\*\/\*\.\{ts,js,svelte\}/);
	});

	test('forwards the Resend send allowlist to immediate and scheduled forwarding', () => {
		assert.equal(
			(source('src/worker.ts').match(/RESEND_SEND_DOMAINS: env\.RESEND_SEND_DOMAINS/gu) ?? [])
				.length,
			2
		);
	});
});
