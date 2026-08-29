#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExternalFontReferences } from './release-supply-chain.mjs';
import { nativePackageFiles } from './generate-codex-native-adapter.mjs';

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
	const treeEntries = run('git', ['ls-tree', '-r', '-z', treeish], { cwd: repository })
		.stdout.split('\0')
		.filter(Boolean);
	for (const entry of treeEntries) {
		const separator = entry.indexOf('\t');
		const path = separator === -1 ? '' : entry.slice(separator + 1);
		if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
			throw new Error(`Release tree contains an unsafe path: ${path}`);
		}
		if (!/^(?:100644|100755) blob [0-9a-f]+\t/u.test(entry)) {
			throw new Error(`Release tree contains a symlink, gitlink, or special entry: ${entry}`);
		}
	}
	const adapters = [
		'.agents/skills/quickmail-ja-setup/SKILL.md',
		'.claude/skills/quickmail-ja-setup/SKILL.md'
	];
	const nativeFiles = nativePackageFiles();
	const allowedClientFiles = [...adapters, ...nativeFiles].sort();
	for (const path of allowedClientFiles) {
		if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
			throw new Error(`Release client allowlist contains an unsafe path: ${path}`);
		}
	}
	const trackedClientFiles = run(
		'git',
		['ls-tree', '-r', '--name-only', treeish, '--', '.agents', '.claude'],
		{ cwd: repository }
	)
		.stdout.trim()
		.split(/\r?\n/u)
		.filter(Boolean)
		.sort();
	if (JSON.stringify(trackedClientFiles) !== JSON.stringify(allowedClientFiles)) {
		throw new Error(
			`Release archive client-file allowlist mismatch: ${trackedClientFiles.join(', ')}`
		);
	}
	for (const adapter of allowedClientFiles) {
		const tracked = run('git', ['ls-tree', treeish, '--', adapter], { cwd: repository }).stdout;
		if (!/^100644 blob [0-9a-f]+\t/u.test(tracked)) {
			throw new Error(`Release adapter must be a tracked regular 100644 file: ${adapter}`);
		}
	}
	run(
		'git',
		['archive', '--format=tar', '--prefix=quickmail-ja-smoke/', `--output=${archive}`, treeish],
		{ cwd: repository }
	);
	run('tar', ['-xf', archive, '-C', temporary]);
	for (const required of [
		'skills/quickmail-ja-setup/SKILL.md',
		'.agents/skills/quickmail-ja-setup/SKILL.md',
		'.claude/skills/quickmail-ja-setup/SKILL.md'
	]) {
		const status = await lstat(join(extracted, required));
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error(`Release archive entry must be a regular file: ${required}`);
		}
	}
	const claudeEntries = await readdir(join(extracted, '.claude'));
	if (claudeEntries.some((entry) => entry !== 'skills')) {
		throw new Error(
			`Release archive contains unexpected .claude content: ${claudeEntries.join(', ')}`
		);
	}
	const externalFonts = findExternalFontReferences(extracted);
	if (externalFonts.length > 0) {
		throw new Error(`Release archive contains external font requests: ${externalFonts.join(', ')}`);
	}
	run(process.execPath, ['run', 'check:clean'], { cwd: extracted });
	console.log('✓ Extracted release archive passed check:clean.');
} finally {
	await rm(temporary, { recursive: true, force: true });
}
