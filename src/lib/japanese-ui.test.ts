import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

const root = new URL('../../', import.meta.url);
const rootPath = root.pathname.endsWith('/') ? root.pathname.slice(0, -1) : root.pathname;

function source(path: string): string {
	return readFileSync(join(rootPath, path), 'utf8');
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

function userFacingSources(): Array<{ path: string; content: string }> {
	const candidates = [
		...walk(join(rootPath, 'src/routes')).filter((path) => path.endsWith('.svelte')),
		...walk(join(rootPath, 'src/lib/components')).filter((path) => path.endsWith('.svelte')),
		join(rootPath, 'src/app.html'),
		join(rootPath, 'static/manifest.webmanifest')
	];

	return candidates.map((path) => ({
		path: relative(rootPath, path),
		content: readFileSync(path, 'utf8')
	}));
}

describe('QuickMail-ja Japanese UI contract', () => {
	test('uses Japanese app metadata and QuickMail-ja branding', () => {
		const appHtml = source('src/app.html');
		const manifest = JSON.parse(source('static/manifest.webmanifest')) as {
			lang?: string;
			name?: string;
			short_name?: string;
		};

		assert.match(appHtml, /<html\s+lang="ja"/);
		assert.match(appHtml, /application-name"\s+content="QuickMail-ja"/);
		assert.equal(manifest.lang, 'ja');
		assert.equal(manifest.name, 'QuickMail-ja');
		assert.equal(manifest.short_name, 'QuickMail-ja');
	});

	test('does not expose deployment-specific context in user-facing source', () => {
		for (const { path, content } of userFacingSources()) {
			assert.doesNotMatch(content, /(?:corp|tenant)-specific\.example/i, path);
		}
	});

	test('keeps representative QuickMail-ja labels in Japanese', () => {
		const labels = [
			['src/routes/login/+page.svelte', ['ログイン', 'メールアドレス', 'パスワード']],
			['src/lib/components/Sidebar.svelte', ['QuickMail-ja', '受信トレイ', '新規メール', '設定']],
			['src/routes/compose/+page.svelte', ['宛先', '件名', '送信']],
			['src/routes/settings/+page.svelte', ['自動転送', 'APIキー', '署名']]
		] as const;

		for (const [path, expected] of labels) {
			const content = source(path);
			for (const label of expected)
				assert.ok(content.includes(label), `${path} is missing ${label}`);
		}
	});

	test('explains address identity, signatures, and API key use cases', () => {
		const settings = source('src/routes/settings/+page.svelte');
		assert.match(settings, /差出人名（受信者に見える名前）/);
		assert.match(settings, /署名（メール本文の末尾に自動挿入）/);
		assert.match(settings, /問い合わせフォームの受付完了メール/);
		assert.match(settings, /CRM・AIへの受信メール取り込み/);
		assert.match(settings, /一覧・本文の取得、既読・スター変更/);
		assert.match(settings, /ドメイン・ユーザー・アドレス管理/);
		assert.match(settings, /パスワードと同じ秘密情報として管理/);
	});

	test('uses valid ASCII mailbox examples and a fixed Japanese time locale', () => {
		for (const path of [
			'src/routes/setup/+page.svelte',
			'src/routes/onboarding/+page.svelte',
			'src/routes/admin/+page.svelte',
			'src/routes/settings/+page.svelte'
		]) {
			assert.doesNotMatch(source(path), /placeholder=(?:\{|)["'](?:名前|追加)["']/, path);
		}

		assert.match(source('src/routes/compose/+page.svelte'), /toLocaleTimeString\('ja-JP'/);
	});

	test('preserves internal forwarding protocol constants', () => {
		const forwarding = source('src/lib/server/forwarding-delivery.ts');
		assert.match(forwarding, /X-QuickMail-Forwarded/);
		assert.match(forwarding, /quickmail-forward:/);
	});

	test('keeps page errors shown to users in Japanese', () => {
		const pageServers = [
			'src/routes/compose/+page.server.ts',
			'src/routes/mail/[id]/+page.server.ts',
			'src/routes/admin/+page.server.ts'
		];
		for (const path of pageServers) {
			const content = source(path);
			assert.doesNotMatch(content, /Choose either|Unauthorized|Email not found|Forbidden/);
		}
	});

	test('sends forwarding verification messages in Japanese', () => {
		for (const path of [
			'src/routes/api/forwarding/destinations/+server.ts',
			'src/routes/api/forwarding/rules/[id]/+server.ts'
		]) {
			const content = source(path);
			assert.match(content, /自動転送先を確認してください/, path);
			assert.match(content, /有効期限は24時間/, path);
			assert.doesNotMatch(content, /Confirm automatic forwarding|Verify this destination/, path);
		}
	});

	test('does not render raw compose or reply API errors', () => {
		for (const path of ['src/routes/compose/+page.svelte', 'src/routes/mail/[id]/+page.svelte']) {
			assert.doesNotMatch(source(path), /\berror\s*=\s*body\.error\b/, path);
		}
	});

	test('does not render provider delivery details in the message UI', () => {
		const thread = source('src/lib/components/ThreadMessage.svelte');
		assert.doesNotMatch(thread, /message\.status_detail/);
		assert.match(thread, /deliveryFailureMessage\(message\.status\)/);
	});

	test('labels receive-only compose and reply states instead of offering a send action', () => {
		const compose = source('src/routes/compose/+page.svelte');
		assert.match(compose, /disabled=\{sending \|\| !fromAddressId\}/);
		assert.match(compose, /受信専用です。<a href="\/settings"/);
		const detail = source('src/routes/mail/[id]/+page.svelte');
		assert.match(detail, /disabled=\{!data\.replyFrom\}/);
		assert.match(detail, /返信できません（受信専用）/);
	});

	test('keeps visible fallback copy Japanese across mail surfaces', () => {
		const mailbox = source('src/lib/components/MailboxView.svelte');
		assert.match(mailbox, /view === 'drafts' \? '宛先なし' : '不明'/);
		assert.match(mailbox, /displayMailSubject\(thread\.subject\)/);

		const threadPage = source('src/routes/mail/[id]/+page.svelte');
		assert.match(threadPage, /displayMailSubject\(data\.subject\)/);

		const manualForward = source('src/lib/server/manual-forward.ts');
		assert.doesNotMatch(manualForward, /Forwarded message|\(no message body\)/);
		assert.match(manualForward, /---------- 転送メッセージ ----------/);

		const push = source('src/lib/server/push-notifications.ts');
		assert.doesNotMatch(push, /Unknown sender|`From \$\{|\(no subject\)/);

		const serviceWorker = source('src/service-worker.ts');
		assert.doesNotMatch(serviceWorker, /New message|You received a new email/);
	});
});
