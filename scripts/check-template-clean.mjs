#!/usr/bin/env bun
/** Refuse to ship a template containing secrets, customer data, or live infrastructure. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativePackageFiles } from './generate-codex-native-adapter.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const FORBIDDEN = [
	{ label: 'Resend API key', pattern: /\bre_[A-Za-z0-9_-]{20,}/ },
	{ label: 'Webhook signing secret', pattern: /whsec_[A-Za-z0-9+/=_-]{16,}/ },
	{
		label: 'GitHub token',
		pattern: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|gho_[A-Za-z0-9]{30,})\b/
	},
	{
		label: 'Cloudflare API token',
		pattern: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/
	},
	{ label: 'Private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
	{ label: 'Live Cloudflare account id', pattern: /^\s*"account_id"\s*:\s*"[0-9a-f]{32}"/m },
	{
		label: 'Live D1 database id',
		pattern: /^\s*"database_id"\s*:\s*"(?!REPLACE_WITH_)[0-9a-f]{8}-[0-9a-f-]{27}"/im
	},
	{ label: 'Local absolute path', pattern: /\/Users\// },
	{ label: 'Source deployment name', pattern: new RegExp(['j', 'cf'].join(''), 'i') },
	{
		label: 'Source deployment domain',
		pattern: new RegExp(['japan', 'cannabinoid'].join('[-.]?'), 'i')
	},
	{
		label: 'Source organization name',
		pattern: new RegExp(['日本カン', 'ナビノイド'].join(''), 'i')
	},
	{ label: 'Source vendor name', pattern: new RegExp(['can', 'ai'].join(''), 'i') },
	{
		label: 'Unpublished upstream installer endpoint',
		pattern: new RegExp(
			['raw\\.githubusercontent\\.com', 'DivinPrince', 'quickmail'].join('\\/'),
			'i'
		)
	}
];

const SKIP_FILES = new Set(['scripts/check-template-clean.mjs']);
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip)$/i;
const FALLBACK_SKIP_DIRECTORIES = new Set([
	'.git',
	'.wrangler',
	'backup',
	'node_modules',
	'out',
	'.svelte-kit'
]);

const isPlaceholder = (value) =>
	/x{4,}/i.test(value) || /REPLACE_WITH|your[-_]?/i.test(value) || /example\.com/i.test(value);

export function findForbiddenFindings(contents, rules = FORBIDDEN) {
	const findings = [];
	for (const { label, pattern } of rules) {
		const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
		const matcher = new RegExp(pattern.source, flags);
		for (const match of contents.matchAll(matcher)) {
			if (isPlaceholder(match[0])) continue;
			findings.push({ label, line: contents.slice(0, match.index).split('\n').length });
		}
	}
	return findings;
}

function listArchiveFiles(directory, base = directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (FALLBACK_SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.harness')) continue;
			files.push(...listArchiveFiles(join(directory, entry.name), base));
		} else if (entry.isFile()) {
			files.push(relative(base, join(directory, entry.name)));
		}
	}
	return files.sort();
}

export function listFilesToScan(directory = root) {
	try {
		const tracked = execFileSync('git', ['ls-files'], {
			cwd: directory,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.split('\n')
			.filter(Boolean);
		if (tracked.length > 0) return tracked;
	} catch {
		// Release archives deliberately have no .git directory.
	}
	return listArchiveFiles(directory);
}

export function checkTemplate(directory = root) {
	const failures = [];
	const fail = (message) => failures.push(message);
	const tracked = listFilesToScan(directory);

	if (tracked.length === 0) fail('No files were found to scan');

	const trackedAdapterPaths = new Set([
		'.agents/skills/noroshi-setup/SKILL.md',
		'.claude/skills/noroshi-setup/SKILL.md',
		...nativePackageFiles()
	]);
	const localOnlyPaths = [
		/^backup(?:\/|$)/,
		/^out(?:\/|$)/,
		/^\.wrangler(?:\/|$)/,
		/^\.agents(?:\/|$)/,
		/^\.claude(?:\/|$)/,
		/^\.harness(?:[-/]|$)/
	];
	for (const file of tracked) {
		if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
			fail(`${file} is an unsafe tracked path`);
			continue;
		}
		if (!trackedAdapterPaths.has(file) && localOnlyPaths.some((pattern) => pattern.test(file))) {
			fail(`${file} is local or operational state and must not be tracked`);
		}
	}

	for (const file of tracked) {
		if (SKIP_FILES.has(file) || SKIP_EXTENSIONS.test(file)) continue;
		let contents;
		try {
			contents = readFileSync(join(directory, file), 'utf8');
		} catch {
			continue;
		}
		for (const finding of findForbiddenFindings(contents)) {
			fail(`${finding.label} in ${file}:${finding.line}`);
		}
	}

	for (const secretFile of ['.dev.vars', '.env', '.env.local']) {
		if (tracked.includes(secretFile)) fail(`${secretFile} is tracked by git — it must stay ignored`);
	}

	const wranglerPath = join(directory, 'wrangler.jsonc');
	if (!existsSync(wranglerPath)) {
		fail('wrangler.jsonc is missing');
	} else {
		const wrangler = readFileSync(wranglerPath, 'utf8');
		if (!wrangler.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID')) {
			fail('wrangler.jsonc no longer has the database_id placeholder — a real D1 id was committed');
		}
		if (/^\s*"routes"\s*:/m.test(wrangler)) {
			fail('wrangler.jsonc has active custom routes — keep the example route commented out');
		}
		const route = wrangler.match(/^\s*"pattern"\s*:\s*"([^"]+)"/m);
		if (route && !route[1].includes('example.com')) {
			fail('wrangler.jsonc has a live route pattern — it should stay commented out');
		}
		if (!/^\s*"name"\s*:\s*"noroshi"\s*,/m.test(wrangler)) {
			fail('wrangler.jsonc Worker name must remain the generic noroshi template name');
		}
		if (!/^\s*"database_name"\s*:\s*"noroshi"\s*,/m.test(wrangler)) {
			fail('wrangler.jsonc D1 name must remain the generic noroshi template name');
		}
		if (!/^\s*"bucket_name"\s*:\s*"noroshi-attachments"/m.test(wrangler)) {
			fail('wrangler.jsonc R2 name must remain the generic noroshi template name');
		}
	}

	const packagePath = join(directory, 'package.json');
	if (!existsSync(packagePath)) {
		fail('package.json is missing');
	} else {
		const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
		if (pkg.scripts?.['db:migrate:local'] !== 'wrangler d1 migrations apply noroshi --local') {
			fail('package.json local D1 migration target must remain noroshi');
		}
		if (pkg.scripts?.['db:migrate:remote'] !== 'wrangler d1 migrations apply noroshi --remote') {
			fail('package.json remote D1 migration target must remain noroshi');
		}
	}

	for (const required of [
		'LICENSE.md',
		'README.md',
		'.dev.vars.example',
		'skills/noroshi-setup/SKILL.md',
		'.agents/skills/noroshi-setup/SKILL.md',
		'.claude/skills/noroshi-setup/SKILL.md'
	]) {
		if (!tracked.includes(required)) fail(`${required} is missing from the repository`);
	}

	return { failures, scanned: tracked.length };
}

if (import.meta.main) {
	const result = checkTemplate();
	if (result.failures.length > 0) {
		console.error(`\n✗ Template is not clean — ${result.failures.length} problem(s):\n`);
		for (const failure of result.failures) console.error(`  • ${failure}`);
		console.error('\nFix these before releasing. Anyone can read this repository.\n');
		process.exit(1);
	}
	console.log(`✓ Template is clean — scanned ${result.scanned} files.`);
}
