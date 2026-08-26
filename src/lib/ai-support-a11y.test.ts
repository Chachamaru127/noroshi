import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { compile } from 'svelte/compiler';

const root = new URL('../../', import.meta.url).pathname;
const component = readFileSync(join(root, 'src/lib/components/AiSupportDock.svelte'), 'utf8');
const setup = readFileSync(join(root, 'src/routes/setup/+page.svelte'), 'utf8');

describe('AI support dock accessibility and privacy boundary', () => {
	test('compiles without accessibility warnings', () => {
		const result = compile(component, {
			filename: 'AiSupportDock.svelte',
			generate: 'client'
		});
		assert.deepEqual(result.warnings, []);
	});

	test('keeps the generated prompt visible and the copy control always rendered', () => {
		assert.match(component, /AIへ渡す質問文/);
		assert.match(component, /class="prompt-preview"/);
		assert.match(component, /質問文をコピー/);
		assert.match(component, /aria-live="polite"/);
		assert.match(component, /min-height:\s*var\(--touch-target\)/);
	});

	test('uses safe external anchor attributes and never opens or calls a service itself', () => {
		assert.match(component, /target="_blank"/);
		assert.match(component, /rel="noopener noreferrer"/);
		assert.match(component, /referrerpolicy="no-referrer"/);
		assert.doesNotMatch(component, /window\.open|fetch\s*\(|XMLHttpRequest|sendBeacon/);
	});

	test('does not inspect page, form, provider, mailbox, or browser location context', () => {
		assert.doesNotMatch(
			component,
			/\$page|document\.|location\.|bootstrapSecret|bind:password|selected|chosen|providerKind|providerConfigured|mailbox|domainId/
		);
		assert.doesNotMatch(component, /<slot|\$\$restProps/);
	});

	test('setup passes only a closed stage expression to the component', () => {
		assert.match(setup, /<AiSupportDock\s+stage=\{step === 1 \? 'resend' : 'first-admin'\}\s*\/>/);
		assert.doesNotMatch(setup, /<AiSupportDock[^>]*(?:chosen|selected|error|data|bootstrapSecret)/);
	});
});
