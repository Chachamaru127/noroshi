#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const treeish = process.env.SETUP_SKILL_TREEISH || 'HEAD';
const outputRoot = resolve(root, 'out');
const output = resolve(root, process.argv[2] || join('out', 'noroshi-setup.zip'));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim()
		);
	}
	return result;
}

const required = [
	'SKILL.md',
	'agents/openai.yaml',
	'references/browser-and-byok.md',
	'references/cloudflare-resend.md',
	'references/gmail-byok.md',
	'references/setup-patterns.json'
];

export function validateSkillTreeListing(listing) {
	const records = listing.split('\0').filter(Boolean);
	const sourceEntries = records.map((record) => {
		const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
		if (!match) throw new Error('Setup Skill tree contains an unreadable entry');
		const [, mode, type, , path] = match;
		if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
			throw new Error(`Setup Skill package contains a non-file entry: ${path}`);
		}
		return path;
	});
	for (const file of required) {
		if (!sourceEntries.includes(file)) throw new Error(`Setup Skill package is missing ${file}`);
	}
	for (const entry of sourceEntries) {
		if (
			entry.split('/').includes('..') ||
			entry.includes('.claude/') ||
			entry.includes('.agents/') ||
			/(?:^|\/)(?:\.env|\.dev\.vars|\.DS_Store)(?:$|\/)/.test(entry)
		) {
			throw new Error(`Setup Skill package contains a forbidden path: ${entry}`);
		}
	}
	return sourceEntries;
}

export function validatePackageOutput(outputPath) {
	if (
		dirname(outputPath) !== outputRoot ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/u.test(basename(outputPath))
	) {
		throw new Error(
			'Setup Skill output must be a direct .zip file under the repository out directory'
		);
	}
	if (existsSync(outputRoot)) {
		const rootStatus = lstatSync(outputRoot);
		if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
			throw new Error('Setup Skill output directory must be a regular repository directory');
		}
	}
	if (existsSync(outputPath)) {
		const outputStatus = lstatSync(outputPath);
		if (!outputStatus.isFile() || outputStatus.isSymbolicLink()) {
			throw new Error('Setup Skill output must be a regular file');
		}
	}
}

if (import.meta.main) {
	validatePackageOutput(output);
	mkdirSync(outputRoot, { recursive: true });
	rmSync(output, { force: true });
	const listing = run('git', ['ls-tree', '-r', '-z', `${treeish}:skills/noroshi-setup`]).stdout;
	const sourceEntries = validateSkillTreeListing(listing);
	run('git', [
		'archive',
		'--format=zip',
		'--prefix=noroshi-setup/',
		`--output=${output}`,
		`${treeish}:skills/noroshi-setup`
	]);
	const packaged = lstatSync(output);
	if (!packaged.isFile() || packaged.isSymbolicLink() || packaged.size === 0) {
		throw new Error('Setup Skill package is not a non-empty regular file');
	}

	console.log(`✓ Setup Skill package: ${output} (${sourceEntries.length} entries)`);
}
