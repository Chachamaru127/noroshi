import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { compile, parse } from 'svelte/compiler';

const root = new URL('../../', import.meta.url).pathname;
const component = (name: string) =>
	readFileSync(join(root, 'src/lib/components', `${name}.svelte`), 'utf8');

type AstNode = Record<string, unknown> & { type?: string; name?: string; attributes?: AstNode[] };

function descendants(value: unknown, found: AstNode[] = []): AstNode[] {
	if (!value || typeof value !== 'object') return found;
	const node = value as AstNode;
	if (typeof node.type === 'string') found.push(node);
	for (const [key, child] of Object.entries(node)) {
		if (key === 'metadata' || key === 'parent') continue;
		if (Array.isArray(child)) child.forEach((entry) => descendants(entry, found));
		else descendants(child, found);
	}
	return found;
}

function staticAttribute(node: AstNode, name: string): string | undefined {
	const attribute = node.attributes?.find(
		(entry) => entry.type === 'Attribute' && entry.name === name
	) as (AstNode & { value?: AstNode[] }) | undefined;
	const text = Array.isArray(attribute?.value) ? attribute.value[0] : undefined;
	return text?.type === 'Text' ? String((text as AstNode & { data?: string }).data) : undefined;
}

function elementWithAttribute(ast: unknown, name: string, attribute: string, value: string) {
	return descendants(ast).find(
		(node) =>
			node.type === 'RegularElement' &&
			node.name === name &&
			staticAttribute(node, attribute) === value
	);
}

describe('folder UI accessibility component contract', () => {
	test('all changed Svelte components compile without accessibility warnings', () => {
		for (const name of ['MobileChrome', 'FolderMoveMenu', 'FolderNavigation', 'MailboxView']) {
			const result = compile(component(name), { filename: `${name}.svelte`, generate: 'client' });
			assert.deepEqual(result.warnings, [], name);
		}
	});

	test('Mobile More is a real modal with a non-tabbable scrim', () => {
		const ast = parse(component('MobileChrome'), { modern: true });
		const dialog = elementWithAttribute(ast.fragment, 'div', 'id', 'more-sheet');
		assert.ok(dialog);
		assert.equal(staticAttribute(dialog, 'role'), 'dialog');
		assert.equal(staticAttribute(dialog, 'aria-modal'), 'true');
		assert.equal(staticAttribute(dialog, 'tabindex'), '-1');

		const scrim = elementWithAttribute(ast.fragment, 'div', 'class', 'sheet-scrim');
		assert.ok(scrim);
		assert.equal(staticAttribute(scrim, 'aria-hidden'), 'true');
		assert.equal(
			descendants(ast.fragment).some(
				(node) =>
					node.type === 'RegularElement' &&
					node.name === 'button' &&
					staticAttribute(node, 'class') === 'sheet-scrim'
			),
			false
		);

		const source = component('MobileChrome');
		assert.ok(source.includes('for (const element of background) element.inert = true'));
		assert.ok(source.includes("if (event.key !== 'Tab' || folderDialogOpen) return"));
		assert.ok(source.includes('trigger?.focus({ preventScroll: true })'));
	});

	test('move menu dismisses on Tab, reverse Tab, Escape, backdrop, and outside focus', () => {
		const source = component('FolderMoveMenu');
		assert.ok(source.includes("if (event.key === 'Tab')"));
		assert.ok(source.includes('tabAwayFromMenu(event.shiftKey)'));
		assert.ok(source.includes("if (event.key === 'Escape')"));
		assert.ok(source.includes("document.addEventListener('focusin', onFocusIn)"));
		assert.ok(source.includes('element.getClientRects().length > 0'));
		assert.ok(source.includes('onclick={() => close()}'));

		const ast = parse(source, { modern: true });
		const backdrop = elementWithAttribute(ast.fragment, 'div', 'class', 'move-backdrop');
		assert.ok(backdrop);
		assert.equal(staticAttribute(backdrop, 'aria-hidden'), 'true');
	});

	test('move menu restores a visible destination before closing its row actions', () => {
		const source = component('FolderMoveMenu');
		const closeBody = source.match(/function close\([\s\S]*?\n\t}/)?.[0] ?? '';
		const tabBody = source.match(/function tabAwayFromMenu\([\s\S]*?\n\t}/)?.[0] ?? '';

		assert.ok(closeBody.includes('visibleFocusTarget(trigger)'));
		assert.ok(closeBody.indexOf('.focus(') < closeBody.indexOf('open = false'));
		assert.ok(tabBody.includes('visibleFocusTarget(next)'));
		assert.ok(tabBody.indexOf('.focus(') < tabBody.indexOf('close(false)'));
		assert.ok(source.includes('getClientRects().length > 0'));
	});

	test('successful moves restore a surviving trigger or the explicit mailbox fallback', () => {
		const move = component('FolderMoveMenu');
		assert.ok(move.includes('await invalidateAll()'));
		assert.ok(move.includes('await tick()'));
		assert.ok(move.includes('if (visibleFocusTarget(trigger)) trigger.focus'));
		assert.ok(move.includes('else onFocusFallback?.()'));

		const mailbox = component('MailboxView');
		assert.equal(mailbox.split('onFocusFallback={focusToolbar}').length - 1, 2);
		assert.ok(mailbox.includes('bind:this={toolbar}'));
		assert.ok(mailbox.includes('tabindex="-1"'));
		assert.ok(mailbox.includes('toolbar?.focus({ preventScroll: true })'));
	});

	test('delete dialog exposes stable consequence copy and live loading state', () => {
		const source = component('FolderNavigation');
		const ast = parse(source, { modern: true });
		const dialog = elementWithAttribute(
			ast.fragment,
			'div',
			'aria-labelledby',
			'folder-delete-title'
		);
		assert.ok(dialog);
		assert.equal(
			staticAttribute(dialog, 'aria-describedby'),
			'folder-delete-description folder-delete-status'
		);
		assert.ok(dialog.attributes?.some((attribute) => attribute.name === 'aria-busy'));

		const status = elementWithAttribute(ast.fragment, 'p', 'id', 'folder-delete-status');
		assert.ok(status);
		assert.equal(staticAttribute(status, 'role'), 'status');
		assert.equal(staticAttribute(status, 'aria-live'), 'polite');
		assert.equal(staticAttribute(status, 'aria-atomic'), 'true');
		assert.ok(source.includes('メールは削除されません。'));
		assert.ok(source.includes('添付ファイルも保持されます。'));
		assert.ok(source.includes('フォルダ分けが解除されます。'));
		assert.ok(!source.includes('会話は受信トレイへ戻り'));
		assert.ok(source.includes('影響を確認しています…'));
	});

	test('folder dialogs restore focus to an always-visible link or add control', () => {
		const source = component('FolderNavigation');
		assert.ok(source.includes('bind:this={addButton}'));
		assert.ok(
			source.includes("closest('.folder-row')?.querySelector<HTMLAnchorElement>('a[href]')")
		);
		assert.ok(source.includes('returnFocusTarget = addButton'));
		assert.ok(source.includes('visibleFocusTarget(returnFocusTarget)'));
		assert.ok(source.includes('visibleFocusTarget(addButton)'));
		assert.doesNotMatch(source, /if \(opener\?\.isConnected\) opener\.focus/);
	});

	test('keyboard focus reveals row actions and mobile controls use the shared 44px target', () => {
		const mailbox = component('MailboxView');
		const navigation = component('FolderNavigation');
		const move = component('FolderMoveMenu');
		assert.ok(mailbox.includes('.row:focus-within .row-actions'));
		assert.ok(
			mailbox.includes(".row:has(:global(.move-trigger[aria-expanded='true'])) .row-actions")
		);
		assert.ok(navigation.includes('.folders.mobile .folder-actions button'));
		assert.ok(navigation.includes('width: var(--touch-target)'));
		assert.ok(move.includes('.move-trigger.compact'));
		assert.ok(move.includes('min-height: var(--touch-target)'));
	});

	test('folder navigation instances use distinct heading ids and mobile delete confirmation is 44px', () => {
		const navigation = component('FolderNavigation');
		assert.ok(navigation.includes('`folder-navigation-title-${variant}`'));
		assert.ok(navigation.includes('aria-labelledby={folderNavigationTitleId}'));
		assert.ok(navigation.includes('id={folderNavigationTitleId}'));
		assert.match(
			navigation,
			/@media \(max-width: 900px\)[\s\S]*?\.folder-dialog \.delete-button[\s\S]*?min-height: var\(--touch-target\)/
		);
	});
});
