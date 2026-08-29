#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const nativeRoot = join(repositoryRoot, '.agents/plugins/quickmail-ja-setup');
const nativePackagePrefix = '.agents/plugins/quickmail-ja-setup';
const nativeStaticFiles = Object.freeze(['.codex-plugin/plugin.json', '.mcp.json']);

const mirrorFiles = Object.freeze([
	['skills/quickmail-ja-operations/SKILL.md', 'skills/quickmail-ja-operations/SKILL.md'],
	['skills/quickmail-ja-setup/SKILL.md', 'skills/quickmail-ja-setup/SKILL.md'],
	['skills/quickmail-ja-setup/agents/openai.yaml', 'skills/quickmail-ja-setup/agents/openai.yaml'],
	[
		'skills/quickmail-ja-setup/references/browser-and-byok.md',
		'skills/quickmail-ja-setup/references/browser-and-byok.md'
	],
	[
		'skills/quickmail-ja-setup/references/cloudflare-resend.md',
		'skills/quickmail-ja-setup/references/cloudflare-resend.md'
	],
	[
		'skills/quickmail-ja-setup/references/gmail-byok.md',
		'skills/quickmail-ja-setup/references/gmail-byok.md'
	],
	[
		'skills/quickmail-ja-setup/references/setup-patterns.json',
		'skills/quickmail-ja-setup/references/setup-patterns.json'
	],
	['scripts/setup-engine.mjs', 'scripts/setup-engine.mjs'],
	['scripts/setup-plugin-mcp.mjs', 'scripts/setup-plugin-mcp.mjs'],
	['LICENSE.md', 'LICENSE.md']
]);

export function nativeAdapterFiles() {
	return mirrorFiles.map(([source, destination]) => ({ source, destination }));
}

export function nativePackageFiles() {
	return [
		'.agents/plugins/marketplace.json',
		...nativeStaticFiles.map((path) => `${nativePackagePrefix}/${path}`),
		...mirrorFiles.map(([, destination]) => `${nativePackagePrefix}/${destination}`)
	].sort();
}

export function syncNativeAdapter({ check = false } = {}) {
	for (const [source, destination] of mirrorFiles) {
		const sourcePath = join(repositoryRoot, source);
		const destinationPath = join(nativeRoot, destination);
		const contents = readFileSync(sourcePath);
		if (check) {
			let actual;
			try {
				actual = readFileSync(destinationPath);
			} catch {
				throw new Error(`Codex native adapter file is missing: ${destination}`);
			}
			if (!actual.equals(contents)) {
				throw new Error(`Codex native adapter is stale: ${destination}`);
			}
			continue;
		}
		mkdirSync(dirname(destinationPath), { recursive: true });
		writeFileSync(destinationPath, contents);
	}
}

if (import.meta.main) {
	const check = process.argv.includes('--check');
	syncNativeAdapter({ check });
	console.log(
		check
			? '✓ Codex native adapter mirrors the canonical portable Skill and setup runtime.'
			: `✓ Codex native adapter generated (${mirrorFiles.length} mirrored files).`
	);
}
