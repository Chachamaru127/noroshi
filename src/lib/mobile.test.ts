import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	hasInAppHistory,
	isMailboxPath,
	isMorePath,
	isPrimaryTab,
	isStackedPath,
	isUtilityPath,
	navDirection,
	noteInAppNavigation
} from './app-chrome';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('treats mailbox roots as list screens', () => {
	assert.equal(isMailboxPath('/inbox'), true);
	assert.equal(isMailboxPath('/drafts'), true);
	assert.equal(isMailboxPath('/folders/customer-support'), true);
	assert.equal(isMailboxPath('/mail/abc'), false);
});

test('treats only thread and compose as stacked screens', () => {
	assert.equal(isStackedPath('/mail/abc'), true);
	assert.equal(isStackedPath('/compose'), true);
	assert.equal(isStackedPath('/inbox'), false);
	assert.equal(isStackedPath('/settings'), false);
	assert.equal(isStackedPath('/admin'), false);
});

test('keeps compose full-width on desktop while retaining the stacked phone screen', () => {
	const layout = readFileSync(join(root, 'src/routes/+layout.svelte'), 'utf8');
	const compose = readFileSync(join(root, 'src/routes/compose/+page.svelte'), 'utf8');
	const editor = readFileSync(join(root, 'src/lib/components/RichTextEditor.svelte'), 'utf8');
	const swipeBack = readFileSync(join(root, 'src/lib/components/SwipeBack.svelte'), 'utf8');

	assert.match(layout, /const NARROW = \['\/mail', '\/settings'\]/);
	assert.doesNotMatch(layout, /const NARROW = \[[^\]]*'\/compose'/);
	assert.match(compose, /\.compose-page\s*\{[\s\S]*?width:\s*100%/);
	assert.match(compose, /<RichTextEditor[\s\S]*?minHeight=\{320\}/);
	assert.match(
		compose,
		/@media \(max-width: 900px\)[\s\S]*?\.compose-page\s*\{[\s\S]*?height:\s*100%/
	);
	const desktopEditorCss = (editor.split('<style>')[1] ?? '').split('@media (max-width: 900px)')[0];
	assert.doesNotMatch(desktopEditorCss, /\.editor-shell-fill\s*\{/);
	assert.match(editor, /@media \(max-width: 900px\)[\s\S]*?\.editor-shell-fill\s*\{/);
	assert.match(swipeBack, /@media \(min-width: 901px\)[\s\S]*?display:\s*contents/);
});

test('offers an accessible Japanese logout action in the mobile More sheet', () => {
	const layout = readFileSync(join(root, 'src/routes/+layout.svelte'), 'utf8');
	const mobile = readFileSync(join(root, 'src/lib/components/MobileChrome.svelte'), 'utf8');

	assert.match(layout, /<MobileChrome[\s\S]*?onLogout=\{logout\}/);
	assert.match(mobile, /onLogout:\s*\(\) => void/);
	assert.match(
		mobile,
		/<button[^>]*class="sheet-link sheet-logout"[^>]*onclick=\{onLogout\}[\s\S]*?<span>ログアウト<\/span>/
	);
	assert.match(mobile, /max-height:/);
	assert.match(mobile, /overflow-y:\s*auto/);
});

test('preserves stored address display names in compose, reply, and mailbox rows', () => {
	const compose = readFileSync(join(root, 'src/routes/compose/+page.svelte'), 'utf8');
	const mail = readFileSync(join(root, 'src/routes/mail/[id]/+page.svelte'), 'utf8');
	const mailbox = readFileSync(join(root, 'src/lib/components/MailboxView.svelte'), 'utf8');

	assert.match(compose, /address\.label \? `\$\{address\.label\} · \$\{address\.address\}`/);
	assert.match(compose, /addresses\[0\]\?\.label/);
	assert.match(mail, /\{#if data\.replyFromName\}\{data\.replyFromName\} ·/);
	assert.match(mailbox, /mailboxPeople\(thread, view\)/);
	assert.match(mailbox, /mailboxInitial\(thread\)/);
});

test('marks inbox, starred, and sent as primary tabs', () => {
	assert.equal(isPrimaryTab('/inbox'), true);
	assert.equal(isPrimaryTab('/sent'), true);
	assert.equal(isPrimaryTab('/drafts'), false);
});

test('treats settings and admin as utility screens', () => {
	assert.equal(isUtilityPath('/settings'), true);
	assert.equal(isUtilityPath('/admin'), true);
	assert.equal(isUtilityPath('/inbox'), false);
	assert.equal(isUtilityPath('/drafts'), false);
});

test('puts secondary destinations under More', () => {
	assert.equal(isMorePath('/drafts'), true);
	assert.equal(isMorePath('/trash'), true);
	assert.equal(isMorePath('/settings'), true);
	assert.equal(isMorePath('/admin'), true);
	assert.equal(isMorePath('/folders/customer-support'), true);
	assert.equal(isMorePath('/inbox'), false);
	assert.equal(isMorePath('/sent'), false);
});

test('counts only in-app link and goto navigations as back history', () => {
	while (hasInAppHistory()) noteInAppNavigation('popstate');
	noteInAppNavigation('enter');
	assert.equal(hasInAppHistory(), false);
	noteInAppNavigation('link');
	assert.equal(hasInAppHistory(), true);
	noteInAppNavigation('popstate');
	assert.equal(hasInAppHistory(), false);
	noteInAppNavigation('goto');
	assert.equal(hasInAppHistory(), true);
	noteInAppNavigation('popstate');
	assert.equal(hasInAppHistory(), false);
});

test('stacked back controls do not trust the tab session history length', () => {
	for (const file of [
		'src/lib/components/SwipeBack.svelte',
		'src/lib/components/StackHeader.svelte',
		'src/routes/mail/[id]/+page.svelte'
	]) {
		const source = readFileSync(join(root, file), 'utf8');
		assert.match(source, /hasInAppHistory/, file);
		assert.doesNotMatch(source, /history\.length/, file);
	}
});

test('mail detail toolbar and edge swipe share the server-resolved fallback', () => {
	const layout = readFileSync(join(root, 'src/routes/+layout.svelte'), 'utf8');
	const mail = readFileSync(join(root, 'src/routes/mail/[id]/+page.svelte'), 'utf8');
	const swipeBack = readFileSync(join(root, 'src/lib/components/SwipeBack.svelte'), 'utf8');
	assert.match(
		layout,
		/SwipeBack href=\{stackedBackHref\} useHistoryBack=\{stackedUseHistoryBack\}/
	);
	assert.match(layout, /typeof \$page\.data\.useHistoryBack === 'boolean'/);
	assert.match(swipeBack, /useHistoryBack = true/);
	assert.match(swipeBack, /if \(useHistoryBack && hasInAppHistory\(\)\)/);
	assert.match(mail, /const backHref = \$derived\(data\.backHref\)/);
});

test('slides forward into a stacked screen and back out of one', () => {
	assert.equal(navDirection('/inbox', '/mail/1', 'link'), 'forward');
	assert.equal(navDirection('/mail/1', '/inbox', 'link'), 'back');
	assert.equal(navDirection('/inbox', '/starred', 'link'), 'tab');
	assert.equal(navDirection('/mail/1', '/inbox', 'popstate'), 'back');
});

test('document head asks for a standalone home-screen app', () => {
	const html = readFileSync(join(root, 'src/app.html'), 'utf8');
	assert.match(html, /viewport-fit=cover/);
	assert.match(html, /apple-mobile-web-app-capable/);
	assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
	assert.match(html, /manifest\.webmanifest/);
	assert.match(html, /apple-touch-startup-image/);
});

test('phone gestures follow the 900px shell, not desktop pointer type', () => {
	for (const file of [
		'src/lib/components/SwipeBack.svelte',
		'src/lib/components/SwipeRow.svelte',
		'src/lib/components/PullToRefresh.svelte'
	]) {
		const source = readFileSync(join(root, file), 'utf8');
		assert.doesNotMatch(source, /pointer:\s*fine/, file);
		assert.match(source, /min-width:\s*901px|isMobileViewport/, file);
	}
});

test('service worker is a classic worker, not a Vite module', () => {
	const source = readFileSync(join(root, 'src/service-worker.ts'), 'utf8');
	assert.match(source, /addEventListener\('install'/);
	assert.match(source, /addEventListener\('push'/);
	assert.doesNotMatch(source, /import\s+['"]\/@fs/);
	assert.match(source, /'新着メール'/);
	assert.match(source, /'新着メールが届きました。'/);
	assert.doesNotMatch(source, /New message|You received a new email/);
});

test('PWA manifest is standalone and points at real icons', () => {
	const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.webmanifest'), 'utf8')) as {
		display: string;
		start_url: string;
		icons: { src: string }[];
		shortcuts?: { url: string }[];
	};
	assert.equal(manifest.display, 'standalone');
	assert.equal(manifest.start_url, '/inbox');
	assert.ok(manifest.icons.length >= 2);
	for (const icon of manifest.icons) {
		assert.equal(existsSync(join(root, 'static', icon.src)), true, icon.src);
	}
	assert.ok(manifest.shortcuts?.some((shortcut) => shortcut.url === '/compose'));
	for (const splash of [
		'splash-1170x2532.png',
		'splash-1170x2532-dark.png',
		'splash-1179x2556.png',
		'splash-1179x2556-dark.png',
		'splash-1290x2796.png',
		'splash-1290x2796-dark.png'
	]) {
		assert.equal(existsSync(join(root, 'static/icons', splash)), true, splash);
	}
});
