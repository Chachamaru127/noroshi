#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = join(root, 'skills/noroshi-operations/SKILL.md');
const outputPath = join(root, 'adapters/claude/skills/noroshi-operations/SKILL.md');
const source = readFileSync(sourcePath, 'utf8');
const digest = createHash('sha256').update(source).digest('hex');
const marker = `<!-- Generated from skills/noroshi-operations/SKILL.md; source-sha256: ${digest} -->`;
const sourceLines = source.split('\n');
const frontmatterEnd = sourceLines.findIndex((line, index) => index > 0 && line === '---');
if (frontmatterEnd < 0) throw new Error('portable operations Skill has no frontmatter boundary');
sourceLines.splice(frontmatterEnd + 1, 0, marker);
const output = sourceLines.join('\n');

if (process.argv.includes('--check')) {
	if (readFileSync(outputPath, 'utf8') !== output) {
		console.error('Claude adapter Skill is stale; run node scripts/generate-claude-adapter.mjs');
		process.exit(1);
	}
	console.log('✓ Claude adapter Skill matches portable operations Skill.');
} else {
	mkdirSync(join(root, 'adapters/claude/skills/noroshi-operations'), { recursive: true });
	writeFileSync(outputPath, output);
	console.log(`✓ Claude adapter Skill generated (${digest}).`);
}
