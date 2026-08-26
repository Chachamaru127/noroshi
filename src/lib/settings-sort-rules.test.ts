import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
	deletedRuleFocusOrder,
	canStartSortRuleEditor,
	loadCurrentSortRules,
	moveSortRule,
	sortRuleAccessibleLabel,
	sortRuleConditionLength,
	sortRuleUiError,
	survivingFocusCandidate
} from './settings-sort-rules';

const root = new URL('../../', import.meta.url).pathname;
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('sorting rule settings UI', () => {
	test('maps only known API errors to safe Japanese copy', () => {
		assert.equal(
			sortRuleUiError('At least one sorting condition is required.'),
			'差出人または件名の条件を1つ以上入力してください。'
		);
		assert.equal(
			sortRuleUiError('Sorting conditions must be 256 characters or fewer.'),
			'条件はそれぞれ256文字以内で入力してください。'
		);
		assert.equal(
			sortRuleUiError('database secret detail'),
			'自動振り分けルールを更新できませんでした。'
		);
	});

	test('counts Unicode conditions by code point', () => {
		assert.equal(sortRuleConditionLength(`  ${'📨'.repeat(256)}  `), 256);
		assert.equal(sortRuleConditionLength('📨'.repeat(257)), 257);
	});

	test('moves rules without mutating the original order', () => {
		const rules = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		assert.deepEqual(
			moveSortRule(rules, 1, -1).map((rule) => rule.id),
			['b', 'a', 'c']
		);
		assert.deepEqual(
			rules.map((rule) => rule.id),
			['a', 'b', 'c']
		);
		assert.deepEqual(moveSortRule(rules, 0, -1), rules);
	});

	test('restores focus to the next rule, previous rule, then a surviving fallback', () => {
		assert.deepEqual(deletedRuleFocusOrder(['a', 'b', 'c'], 'b'), ['c', 'a']);
		assert.deepEqual(deletedRuleFocusOrder(['a', 'b'], 'b'), ['a']);
		assert.deepEqual(deletedRuleFocusOrder(['a'], 'a'), []);

		const removed = { isConnected: false, name: 'removed' };
		const next = { isConnected: true, name: 'next' };
		const create = { isConnected: true, name: 'create' };
		assert.equal(survivingFocusCandidate([removed, next, create]), next);
		assert.equal(survivingFocusCandidate([removed, null, create]), create);
	});

	test('gives rules with the same destination distinct accessible identities', () => {
		const senderRule = sortRuleAccessibleLabel(
			{
				folder_name: '重要',
				sender_contains: 'partner.example',
				subject_contains: null,
				enabled: true
			},
			0
		);
		const subjectRule = sortRuleAccessibleLabel(
			{
				folder_name: '重要',
				sender_contains: null,
				subject_contains: '請求書',
				enabled: false
			},
			1
		);
		assert.match(senderRule, /評価順1。有効。移動先「重要」。差出人に「partner\.example」/);
		assert.match(subjectRule, /評価順2。無効。移動先「重要」。件名に「請求書」/);
		assert.notEqual(senderRule, subjectRule);
	});

	test('reconciles an uncertain create result with a server GET', async () => {
		const calls: string[] = [];
		const rules = [{ id: 'server-rule' }];
		const refreshed = await loadCurrentSortRules(async (input) => {
			calls.push(String(input));
			return Response.json({ rules });
		});
		assert.deepEqual(calls, ['/api/sort-rules']);
		assert.deepEqual(refreshed, rules);
		assert.equal(
			await loadCurrentSortRules(async () => new Response('unavailable', { status: 503 })),
			null
		);
	});

	test('prevents create from racing a pending reorder response', () => {
		assert.equal(
			canStartSortRuleEditor({ busy: false, actionId: 'rule-1', editorOpen: false }),
			false
		);
		assert.equal(canStartSortRuleEditor({ busy: false, actionId: '', editorOpen: false }), true);
	});

	test('provides the complete Japanese and accessible rule workflow', () => {
		const component = source('src/lib/components/SortRuleSettings.svelte');
		for (const label of [
			'自動振り分け',
			'差出人に含む',
			'件名に含む',
			'移動先フォルダ',
			'有効',
			'上へ移動',
			'下へ移動',
			'ルールを削除'
		])
			assert.match(component, new RegExp(label));
		assert.match(component, /両方を入力した場合は、両方に一致/);
		assert.match(component, /新しく受信したメールだけ/);
		assert.match(component, /既存メール、取込済みメール、送信済みメール、下書きは移動しません/);
		assert.match(component, /role="alertdialog"/);
		assert.match(component, /aria-live="polite"/);
		assert.doesNotMatch(component, /error\s*=\s*body\.error/);
	});

	test('locks every editor control during a slow save and restores editor focus', () => {
		const component = source('src/lib/components/SortRuleSettings.svelte');
		assert.match(component, /bind:value=\{senderContains\}[\s\S]*?disabled=\{busy\}/);
		assert.match(component, /bind:value=\{subjectContains\}[\s\S]*?disabled=\{busy\}/);
		assert.match(component, /<select bind:value=\{folderId\}[^>]*disabled=\{busy\}/);
		assert.match(component, /bind:checked=\{enabled\}[^>]*disabled=\{busy\}/);
		assert.match(component, /editorOpener/);
		assert.match(component, /restoreEditorFocus/);
		assert.match(component, /deleteFocusCandidates/);
		assert.match(component, /data-rule-action/);
		assert.match(component, /restoreRuleActionFocus/);
		assert.match(component, /await refreshSortRules\(\)/);
		assert.match(component, /canStartSortRuleEditor/);
	});

	test('keeps rule groups distinguishable and preserves focus while delete is pending', () => {
		const component = source('src/lib/components/SortRuleSettings.svelte');
		assert.match(component, /role="group"/);
		assert.match(component, /sortRuleAccessibleLabel\(rule, index\)/);
		assert.match(component, /if \(!first \|\| !last\)[\s\S]*?dialog\.focus/);
		assert.match(component, /bind:this=\{deleteDialog\}/);
		assert.match(component, /bind:this=\{deleteProgress\}/);
		assert.match(component, /tabindex="-1"/);
		assert.match(component, /restoreDeleteDialogFocus/);
	});

	test('announces the shared condition requirement and invalid fields, with a 44px mobile delete target', () => {
		const component = source('src/lib/components/SortRuleSettings.svelte');
		assert.match(
			component,
			/aria-describedby="sender-condition-help sort-rule-condition-requirement"/
		);
		assert.match(
			component,
			/aria-describedby="subject-condition-help sort-rule-condition-requirement"/
		);
		assert.equal(component.split('aria-invalid={conditionsMissing ||').length - 1, 2);
		assert.match(component, /id="sort-rule-condition-requirement"/);
		assert.match(component, /差出人または件名のどちらか1つ以上を入力してください/);
		assert.match(
			component,
			/@media \(max-width: 700px\)[\s\S]*?\.confirm-dialog \.btn-danger[\s\S]*?min-height: var\(--touch-target\)/
		);
	});

	test('natively disables reorder controls at the list boundaries', () => {
		const component = source('src/lib/components/SortRuleSettings.svelte');
		assert.match(
			component,
			/disabled=\{index === 0 \|\| Boolean\(actionId\) \|\| busy \|\| Boolean\(editor\)\}/
		);
		assert.match(
			component,
			/disabled=\{index === rules\.length - 1 \|\|\s*Boolean\(actionId\) \|\|\s*busy \|\|\s*Boolean\(editor\)\}/
		);
		assert.doesNotMatch(component, /aria-disabled=\{index ===/);
	});

	test('loads rules through the authenticated settings page', () => {
		const server = source('src/routes/settings/+page.server.ts');
		assert.match(server, /listSortRules/);
		assert.match(server, /sortRules/);
	});

	test('is included in the explicit project test command', () => {
		const pkg = JSON.parse(source('package.json')) as { scripts: { test: string } };
		assert.match(pkg.scripts.test, /src\/lib\/settings-sort-rules\.test\.ts/);
	});
});
