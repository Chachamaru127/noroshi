import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deliveryFailureMessage, translateMailError } from './mail-ui-errors';

describe('mail UI error translation', () => {
	test('maps known compose, reply, attachment, and draft errors', () => {
		assert.equal(translateMailError('Unauthorized', 'send'), 'ログインが必要です。');
		assert.equal(
			translateMailError('Invalid attachments', 'send'),
			'添付ファイルを確認してください。'
		);
		assert.equal(
			translateMailError('To, subject, and message are required', 'send'),
			'宛先、件名、本文を入力してください。'
		);
		assert.equal(
			translateMailError('Message body is required', 'reply'),
			'本文を入力してください。'
		);
		assert.equal(
			translateMailError('Failed to send email', 'send'),
			'メールを送信できませんでした。'
		);
		assert.equal(
			translateMailError('Failed to send reply', 'reply'),
			'返信を送信できませんでした。'
		);
		assert.equal(
			translateMailError('Could not save draft', 'draft'),
			'下書きを保存できませんでした。'
		);
	});

	test('uses a fixed Japanese fallback for unknown or malformed details', () => {
		assert.equal(
			translateMailError('RESEND_API_KEY is not set: secret detail', 'send'),
			'メールを送信できませんでした。'
		);
		assert.equal(
			translateMailError({ message: 'internal detail' }, 'reply'),
			'返信を送信できませんでした。'
		);
		assert.equal(translateMailError(undefined, 'draft'), '下書きを保存できませんでした。');
	});

	test('uses allowlisted Japanese delivery failure copy without provider detail', () => {
		assert.equal(deliveryFailureMessage('bounced'), '宛先に届きませんでした。');
		assert.equal(deliveryFailureMessage('failed'), '送信できませんでした。');
		assert.equal(deliveryFailureMessage('provider-internal-detail'), '送信できませんでした。');
	});
});
