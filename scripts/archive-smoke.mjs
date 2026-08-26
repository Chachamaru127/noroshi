#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'quickmail-ja-archive-smoke-'));
const archive = join(temporary, 'quickmail-ja.tar');
const extracted = join(temporary, 'quickmail-ja-smoke');
const treeish = process.env.ARCHIVE_TREEISH || 'HEAD';

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim()
		);
	}
	return result;
}

try {
	run(
		'git',
		['archive', '--format=tar', '--prefix=quickmail-ja-smoke/', `--output=${archive}`, treeish],
		{ cwd: repository }
	);
	run('tar', ['-xf', archive, '-C', temporary]);
	run(process.execPath, ['run', 'check:clean'], { cwd: extracted });
	console.log('✓ Extracted release archive passed check:clean.');
} finally {
	await rm(temporary, { recursive: true, force: true });
}
