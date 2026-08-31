#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = fileURLToPath(new URL('../support/knowledge/patterns.json', import.meta.url));
const outputPath = fileURLToPath(
	new URL('../skills/quickmail-ja-setup/references/setup-patterns.json', import.meta.url)
);
const setupCategories = new Set([
	'deployment',
	'cloudflare',
	'dns',
	'storage',
	'resend',
	'onboarding',
	'delivery'
]);

export function renderSetupKnowledge(source) {
	const parsed = JSON.parse(source);
	const patterns = parsed.patterns.filter((pattern) => setupCategories.has(pattern.category));
	if (patterns.length === 0) throw new Error('Setup Knowledge Pack projection is empty');
	return `${JSON.stringify(
		{
			schema_version: 1,
			generated_from: 'support/knowledge/patterns.json',
			version: parsed.version,
			verified_at: parsed.verified_at,
			review_by: parsed.review_by,
			setup_runbook: parsed.setup_runbook,
			patterns
		},
		null,
		'\t'
	)}\n`;
}

if (import.meta.main) {
	const expected = renderSetupKnowledge(readFileSync(sourcePath, 'utf8'));
	if (process.argv.includes('--check')) {
		const actual = readFileSync(outputPath, 'utf8');
		if (actual !== expected) {
			throw new Error(
				'Packaged setup knowledge is stale; run bun run generate:setup-skill-knowledge'
			);
		}
		console.log('✓ Packaged setup knowledge matches the reviewed source Pack.');
	} else {
		writeFileSync(outputPath, expected);
		console.log(`✓ Generated ${relative(root, outputPath)}`);
	}
}
