import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { folderNameLength, folderUiError, mailDetailDestinations } from './folder-ui';

const root = new URL('../../', import.meta.url).pathname;
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('folder UI contract', () => {
	test('never exposes raw folder API details', () => {
		assert.equal(folderUiError('Folder name is required.'), 'フォルダ名を入力してください。');
		assert.equal(
			folderUiError('A folder with that name already exists.'),
			'同じ名前のフォルダがあります。'
		);
		assert.equal(folderUiError('database secret detail'), 'フォルダを更新できませんでした。');
		assert.equal(folderUiError(undefined, 'move'), 'メールを移動できませんでした。');
	});

	test('counts folder names by Unicode code point instead of UTF-16 units', () => {
		assert.equal(folderNameLength(`  ${'📁'.repeat(80)}  `), 80);
		assert.equal(folderNameLength('📁'.repeat(80)), 80);
		assert.equal(folderNameLength('📁'.repeat(81)), 81);

		const navigation = source('src/lib/components/FolderNavigation.svelte');
		assert.doesNotMatch(navigation, /maxlength="80"/);
		assert.match(navigation, /folderNameLength\(name\)/);
		assert.match(navigation, /nameLength > 80/);
	});

	test('keeps mailbox origin separate from the retained restore folder', () => {
		assert.deepEqual(
			mailDetailDestinations({
				trashed: true,
				direction: 'inbound',
				requestedFolderId: null,
				assignedFolderId: 'important/client'
			}),
			{
				backHref: '/trash',
				restoreHref: '/folders/important%2Fclient',
				unfiledHref: '/inbox',
				currentFolderId: null
			}
		);
		assert.equal(
			mailDetailDestinations({
				trashed: false,
				direction: 'inbound',
				requestedFolderId: 'folder-1',
				assignedFolderId: 'folder-1'
			}).backHref,
			'/folders/folder-1'
		);
		assert.deepEqual(
			mailDetailDestinations({
				trashed: false,
				direction: 'inbound',
				requestedFolderId: null,
				assignedFolderId: 'folder-1'
			}),
			{
				backHref: '/folders/folder-1',
				restoreHref: '/folders/folder-1',
				unfiledHref: '/inbox',
				currentFolderId: 'folder-1'
			}
		);
		assert.deepEqual(
			mailDetailDestinations({
				trashed: false,
				direction: 'outbound',
				requestedFolderId: null,
				assignedFolderId: null
			}),
			{ backHref: '/sent', restoreHref: '/sent', unfiledHref: '/sent', currentFolderId: null }
		);
	});

	test('provides Japanese folder CRUD and a non-destructive delete confirmation', () => {
		const folders = source('src/lib/components/FolderNavigation.svelte');
		for (const label of [
			'フォルダを追加',
			'名前を変更',
			'フォルダを削除',
			'メールは削除されません'
		]) {
			assert.match(folders, new RegExp(label));
		}
		assert.match(folders, /conversation_count/);
		assert.match(folders, /rule_count/);
		assert.doesNotMatch(folders, /error\s*=\s*body\.error/);
	});

	test('supports moving one or many conversations to a folder or Inbox', () => {
		const move = source('src/lib/components/FolderMoveMenu.svelte');
		assert.match(move, /\/api\/folders\/assign/);
		assert.match(move, /フォルダ分けを解除/);
		assert.doesNotMatch(move, /受信トレイへ戻す/);
		assert.match(move, /folderId:\s*destinationId/);

		const mailbox = source('src/lib/components/MailboxView.svelte');
		assert.match(mailbox, /FolderMoveMenu/);
		assert.match(mailbox, /ids=\{selected\}/);

		const detail = source('src/routes/mail\/\[id\]\/\+page.svelte');
		assert.match(detail, /FolderMoveMenu/);
		assert.match(detail, /ids=\{\[latest\.id\]\}/);
		assert.match(
			detail,
			/destinationId\s*\?\s*`\/folders\/\$\{destinationId\}`\s*:\s*data\.unfiledHref/
		);
	});

	test('portals row move menus above later swipe rows and provides complete menu keyboard behavior', () => {
		const move = source('src/lib/components/FolderMoveMenu.svelte');
		assert.match(move, /use:portal/);
		assert.match(move, /document\.body\.appendChild/);
		assert.match(move, /role="menuitem"/);
		assert.match(move, /ArrowDown/);
		assert.match(move, /ArrowUp/);
		assert.match(move, /event\.key === 'Home'/);
		assert.match(move, /event\.key === 'End'/);
		assert.match(move, /visibleFocusTarget\(trigger\)/);
	});

	test('keeps folder search, read-all, deletion and mobile back behavior scoped correctly', () => {
		assert.match(
			source('src/lib/components/Topbar.svelte'),
			/pathname\.startsWith\('\/folders\/'\)/
		);
		assert.match(source('src/lib/components/MailboxView.svelte'), /view !== 'folder'/);
		assert.match(
			source('src/lib/components/FolderNavigation.svelte'),
			/goto\('\/inbox'\)[\s\S]*invalidateAll/
		);
		assert.match(source('src/routes/+layout.svelte'), /SwipeBack href=\{stackedBackHref\}/);

		const detailServer = source('src/routes/mail/[id]/+page.server.ts');
		assert.match(detailServer, /mail_thread_folders/);
		assert.match(detailServer, /mtf\.user_id = \?/);
		assert.match(detailServer, /useHistoryBack:\s*!assignedFolder\?\.id/);
		assert.match(detailServer, /\.\.\.navigation/);
		assert.match(
			source('src/routes/mail/[id]/+page.svelte'),
			/data\.useHistoryBack && hasInAppHistory\(\)/
		);
	});

	test('lets the topmost create, rename, or delete dialog own Escape inside Mobile More', () => {
		const navigation = source('src/lib/components/FolderNavigation.svelte');
		const mobile = source('src/lib/components/MobileChrome.svelte');
		assert.match(navigation, /dialogOpen = \$bindable/);
		assert.match(navigation, /dialogBusy = \$bindable/);
		assert.match(navigation, /Boolean\(editor \|\| deleting\)/);
		assert.match(navigation, /event\.key === 'Escape' && !busy/);
		assert.match(mobile, /bind:dialogOpen=\{folderDialogOpen\}/);
		assert.match(mobile, /bind:dialogBusy=\{folderDialogBusy\}/);
		assert.match(mobile, /folderDialogOpen \|\| folderDialogBusy/);
	});

	test('traps focus in folder dialogs, inerts the background and restores the opener', () => {
		const navigation = source('src/lib/components/FolderNavigation.svelte');
		assert.match(navigation, /use:modalLayer/g);
		assert.match(navigation, /document\.body\.appendChild/);
		assert.match(navigation, /element\.inert = true/);
		assert.match(navigation, /event\.key !== 'Tab'/);
		assert.match(navigation, /returnFocusTarget\.focus/);
	});

	test('renders custom folders as mailbox routes on desktop and mobile', () => {
		const folderPage = source('src/routes/folders/[id]/+page.svelte');
		assert.match(folderPage, /<MailboxView/);
		assert.match(folderPage, /folderName=\{data\.folder\.name\}/);

		const sidebar = source('src/lib/components/Sidebar.svelte');
		const mobile = source('src/lib/components/MobileChrome.svelte');
		assert.match(sidebar, /FolderNavigation/);
		assert.match(mobile, /FolderNavigation/);
		assert.match(mobile, /variant="mobile"/);
	});
});
