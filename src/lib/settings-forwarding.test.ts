import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	canDisableForwarding,
	canApplyForwardingRefreshOutcome,
	forwardingAttemptStatus,
	forwardingStatus,
	isCurrentForwardingRefresh,
	isForwardingDestinationChanged,
	replaceForwardingItemBySource,
	reconcileForwardingInteraction,
	safeForwardingError,
	scopeLabel
} from './settings-forwarding';
import { domainStatusLabel } from './provider-copy';

const settingsPageSource = readFileSync(
	new URL('../routes/settings/+page.svelte', import.meta.url),
	'utf8'
);

describe('settings automatic forwarding helpers', () => {
	test('translates known API scopes and hides unknown scopes', () => {
		assert.equal(scopeLabel('mail:send'), '送信');
		assert.equal(scopeLabel('mail:read'), '読み取り');
		assert.equal(scopeLabel('admin'), '管理者');
		assert.equal(scopeLabel('provider-internal-scope'), '権限不明');
	});

	test('renders only allowlisted domain statuses', () => {
		assert.equal(domainStatusLabel('verified'), '確認済み');
		assert.equal(domainStatusLabel('pending'), '確認待ち');
		assert.equal(domainStatusLabel('missing'), '見つかりません');
		assert.equal(domainStatusLabel('provider-private-status'), '状態不明');
	});

	test('describes the unconfigured and pending states without exposing data', () => {
		assert.deepEqual(forwardingStatus({}), {
			label: '未設定',
			tone: 'neutral',
			detail: '自動転送先を選択してください。'
		});

		assert.deepEqual(forwardingStatus({ destinationStatus: 'pending' }), {
			label: '確認待ち',
			tone: 'pending',
			detail: '転送先の受信トレイに届いた確認メールを確認してください。'
		});
	});

	test('describes verified, enabled, and disabled rule states', () => {
		assert.deepEqual(
			forwardingStatus({
				destinationStatus: 'verified',
				ruleStatus: 'enabled',
				attemptStatus: 'failed'
			}),
			{
				label: '有効',
				tone: 'good',
				detail: '新着メッセージと添付ファイルをこの転送先に送信します。'
			}
		);
		assert.deepEqual(forwardingStatus({ destinationStatus: 'verified', ruleStatus: 'disabled' }), {
			label: '確認済み・無効',
			tone: 'neutral',
			detail: '転送先を確認済みです。準備ができたら自動転送を有効にしてください。'
		});
		assert.deepEqual(
			forwardingStatus({
				destinationStatus: 'verified',
				ruleStatus: 'disabled',
				attemptStatus: 'failed'
			}),
			{
				label: '確認済み・無効',
				tone: 'neutral',
				detail: '転送先を確認済みです。準備ができたら自動転送を有効にしてください。'
			}
		);
	});

	test('describes every MVP delivery state', () => {
		assert.deepEqual(forwardingAttemptStatus('queued'), {
			label: '待機中',
			tone: 'pending',
			detail: '次の配信試行を待っています。'
		});
		assert.deepEqual(forwardingAttemptStatus('processing'), {
			label: '送信中',
			tone: 'pending',
			detail: '転送メールを送信しています。'
		});
		assert.deepEqual(forwardingAttemptStatus('sent'), {
			label: '送信済み',
			tone: 'good',
			detail: '最新のメッセージは配信受付済みです。'
		});
		assert.deepEqual(forwardingAttemptStatus('failed'), {
			label: '失敗',
			tone: 'danger',
			detail: '利用可能な回数の再試行後も配信できませんでした。'
		});
		assert.deepEqual(forwardingAttemptStatus('failed', '2026-08-25T01:00:00.000Z'), {
			label: '再試行予定',
			tone: 'pending',
			detail: '最新の送信は一時的に失敗しました。再試行します。'
		});
	});

	test('applies an enable response only to the source captured when the request started', () => {
		const items = [
			{ source_address: { id: 'source-a' }, rule: { status: 'disabled' } },
			{ source_address: { id: 'source-b' }, rule: { status: 'disabled' } }
		];
		const next = replaceForwardingItemBySource(items, 'source-a', (item) => ({
			...item,
			rule: { status: 'enabled' }
		}));

		assert.equal(next[0]?.rule.status, 'enabled');
		assert.equal(next[1]?.rule.status, 'disabled');
	});

	test('only treats a changed destination as a new verification', () => {
		assert.equal(isForwardingDestinationChanged(undefined, 'external@example.net'), true);
		assert.equal(
			isForwardingDestinationChanged('External@example.net', ' external@example.net '),
			false
		);
		assert.equal(isForwardingDestinationChanged('old@example.net', 'new@example.net'), true);
	});

	test('only enabled rules can be disabled', () => {
		assert.equal(canDisableForwarding('enabled'), true);
		assert.equal(canDisableForwarding('disabled'), false);
		assert.equal(canDisableForwarding(null), false);
	});

	test('preserves a dirty destination draft and acknowledgement across refreshes', () => {
		assert.deepEqual(
			reconcileForwardingInteraction({
				currentDestination: 'old@example.net',
				nextDestination: 'old@example.net',
				draftDestination: 'draft@example.net',
				acknowledged: true,
				sourceStillSelected: true,
				preserveInteraction: true
			}),
			{ destination: 'draft@example.net', acknowledged: true }
		);
	});

	test('keeps a dirty draft while clearing acknowledgement when the server destination changes', () => {
		assert.deepEqual(
			reconcileForwardingInteraction({
				currentDestination: 'old@example.net',
				nextDestination: 'new@example.net',
				draftDestination: 'draft@example.net',
				acknowledged: true,
				sourceStillSelected: true,
				preserveInteraction: true
			}),
			{ destination: 'draft@example.net', acknowledged: false }
		);
		assert.deepEqual(
			reconcileForwardingInteraction({
				currentDestination: 'old@example.net',
				nextDestination: 'new@example.net',
				draftDestination: 'old@example.net',
				acknowledged: true,
				sourceStillSelected: true,
				preserveInteraction: true
			}),
			{ destination: 'new@example.net', acknowledged: false }
		);
		assert.equal(isCurrentForwardingRefresh(3, 3), true);
		assert.equal(isCurrentForwardingRefresh(2, 3), false);
	});

	test('stale refresh outcomes cannot clear a newer mutation error', () => {
		let refreshError = 'newer mutation error';
		if (canApplyForwardingRefreshOutcome('stale', 2, 3)) refreshError = '';
		assert.equal(refreshError, 'newer mutation error');
		assert.equal(canApplyForwardingRefreshOutcome('failed', 3, 3), true);
		assert.equal(canApplyForwardingRefreshOutcome('applied', 3, 3), true);
	});

	test('maps known errors and redacts arbitrary provider details', () => {
		assert.equal(
			safeForwardingError('Destination must be outside QuickMail domains'),
			'QuickMail-jaの管理ドメイン以外のアドレスを指定してください。'
		);
		assert.equal(
			safeForwardingError('Verify the forwarding destination before enabling it'),
			'自動転送を有効にする前に、転送先メールアドレスを確認してください。'
		);
		const privateProviderDetail = 'provider-internal-diagnostic';
		assert.equal(safeForwardingError(privateProviderDetail), '自動転送を更新できませんでした。');
		assert.doesNotMatch(safeForwardingError(privateProviderDetail), /provider-internal-diagnostic/);
	});

	test('keeps the external destination warning in one wrapping prose child', () => {
		assert.match(
			settingsPageSource,
			/<p class="forwarding-warning">\s*<Icon name="alert-line"[^>]*\/>\s*<span class="forwarding-warning-copy">[\s\S]*?<strong>\{selectedForwarding\.destination\.destination_address\}<\/strong>へ送信します。\s*<\/span>\s*<\/p>/
		);
		assert.match(
			settingsPageSource,
			/\.forwarding-warning-copy\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;[^}]*\}/s
		);
	});
});
