import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EmailAttachmentMeta, EmailRow, OutboundAttachmentInput } from '$lib/types';
import { MAX_ATTACHMENT_BYTES } from '../constants';
import {
	buildManualForwardDraft,
	ManualForwardError,
	materializeManualForwardAttachments,
	prepareManualForward
} from './manual-forward';
import { validateSubject } from './send-mail';
import { resolveThreadId } from './threads';
import { htmlToPlainText } from '../utils/html';

const sourceEmail: EmailRow = {
	id: 'email-1',
	user_id: 'user-1',
	direction: 'inbound',
	from_addr: 'Sender <sender@example.net>\r\nBcc: hidden@example.net',
	from_name: null,
	to_addr: 'info@example.com',
	cc_addr: null,
	bcc_addr: 'secret@example.net',
	subject: 'Quarterly <update>',
	body_text: null,
	body_html: '<p>Hello <strong>team</strong></p><img src="https://tracker.test/pixel">',
	message_id: 'message@example.net',
	in_reply_to: null,
	references_header: null,
	reply_to_email_id: null,
	thread_id: 'thread-1',
	thread_key: 'quarterly <update>',
	domain_id: 'domain-1',
	address_id: 'address-1',
	provider_id: 'provider-1',
	status: null,
	status_at: null,
	status_detail: null,
	is_read: 1,
	is_starred: 0,
	deleted_at: null,
	created_at: '2026-08-24T09:30:00.000Z'
};

const attachment: EmailAttachmentMeta = {
	id: 'attachment-1',
	email_id: sourceEmail.id,
	filename: 'report.pdf',
	content_type: 'application/pdf',
	size_bytes: 3,
	created_at: sourceEmail.created_at
};

describe('manual forward draft', () => {
	test('quotes one message as safe text without Bcc, raw headers, or inbound HTML', () => {
		const draft = buildManualForwardDraft(sourceEmail, [attachment]);

		assert.equal(draft.subject, 'Fwd: Quarterly <update>');
		assert.match(draft.text, /^\n\n---------- 転送メッセージ ----------/);
		assert.match(draft.text, /差出人: Sender <sender@example.net>/);
		assert.match(draft.text, /宛先: info@example.com/);
		assert.match(draft.text, /日付: Mon, 24 Aug 2026 09:30:00 GMT/);
		assert.match(draft.text, /件名: Quarterly <update>/);
		assert.match(draft.text, /Hello team/);
		assert.doesNotMatch(
			draft.text,
			/Bcc:|hidden@example.net|secret@example.net|provider-1|message@example.net|<strong>/
		);
		assert.match(draft.html, /Quarterly &lt;update&gt;/);
		assert.doesNotMatch(draft.html, /<strong>|<img|tracker\.test/);
		assert.equal(htmlToPlainText(draft.html), draft.text.trim());
		assert.match(
			htmlToPlainText(draft.html),
			/差出人: Sender <sender@example\.net>\n日付: Mon, 24 Aug 2026 09:30:00 GMT\n件名: Quarterly <update>\n宛先: info@example\.com\n\nHello team/
		);
		assert.deepEqual(draft.attachments, [attachment]);
	});

	test('uses Japanese labels and fallbacks for an empty message', () => {
		const draft = buildManualForwardDraft(
			{ ...sourceEmail, subject: '', body_text: null, body_html: null },
			[]
		);

		assert.equal(draft.subject, 'Fwd: （件名なし）');
		assert.match(draft.text, /---------- 転送メッセージ ----------/);
		assert.match(draft.text, /件名: （件名なし）/);
		assert.match(draft.text, /（本文なし）/);
	});

	test('treats a D1 timestamp without an offset as UTC', () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'Asia/Tokyo';
		try {
			const draft = buildManualForwardDraft(
				{ ...sourceEmail, created_at: '2026-08-24 09:30:00' },
				[]
			);

			assert.match(draft.text, /日付: Mon, 24 Aug 2026 09:30:00 GMT/);
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	test('keeps the complete original subject after the forward prefix', () => {
		const draft = buildManualForwardDraft({ ...sourceEmail, subject: 'x'.repeat(300) }, []);
		assert.equal(draft.subject, `Fwd: ${'x'.repeat(300)}`);
		assert.equal(validateSubject(draft.subject), null);
	});
});

function attachmentDb(ownerId = sourceEmail.user_id): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (!sql.includes('FROM email_attachments')) return null;
							const [attachmentId, emailId, userId] = args;
							if (
								attachmentId !== attachment.id ||
								emailId !== sourceEmail.id ||
								userId !== ownerId
							) {
								return null;
							}
							return { ...attachment, storage_key: 'stored/report.pdf', content_base64: null };
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

function forwardingDb(ownerId = sourceEmail.user_id): {
	db: D1Database;
	statements: string[];
} {
	const statements: string[] = [];
	return {
		statements,
		db: {
			prepare(sql: string) {
				statements.push(sql);
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes('FROM emails WHERE')) {
									const [emailId, userId] = args;
									return emailId === sourceEmail.id && userId === ownerId ? sourceEmail : null;
								}
								if (sql.includes('FROM email_attachments')) {
									const [attachmentId, emailId, userId] = args;
									return attachmentId === attachment.id &&
										emailId === sourceEmail.id &&
										userId === ownerId
										? {
												...attachment,
												storage_key: 'stored/report.pdf',
												content_base64: null
											}
										: null;
								}
								return null;
							}
						};
					}
				};
			}
		} as unknown as D1Database
	};
}

function attachmentBucket(bytes = new Uint8Array([1, 2, 3])): R2Bucket {
	return {
		async get(key: string) {
			if (key !== 'stored/report.pdf') return null;
			return { arrayBuffer: async () => bytes.buffer };
		}
	} as unknown as R2Bucket;
}

describe('manual forward attachments', () => {
	test('revalidates the source owner and only reads original data', async () => {
		const { db, statements } = forwardingDb();
		const result = await prepareManualForward(
			db,
			attachmentBucket(),
			sourceEmail.user_id,
			sourceEmail.id,
			[attachment.id],
			[]
		);

		assert.equal(result.source.id, sourceEmail.id);
		assert.deepEqual(result.attachments, [
			{ filename: 'report.pdf', type: 'application/pdf', content: 'AQID' }
		]);
		assert.equal(
			statements.some((sql) => /UPDATE|DELETE/i.test(sql)),
			false
		);
	});

	test('does not disclose a missing or foreign source', async () => {
		const { db } = forwardingDb('another-user');

		await assert.rejects(
			prepareManualForward(db, attachmentBucket(), sourceEmail.user_id, sourceEmail.id, [], []),
			(error: unknown) =>
				error instanceof ManualForwardError &&
				error.status === 404 &&
				error.message === 'Forward source not found'
		);
	});

	test('loads only selected owned attachments from R2', async () => {
		const result = await materializeManualForwardAttachments(
			attachmentDb(),
			attachmentBucket(),
			sourceEmail.user_id,
			sourceEmail.id,
			[attachment.id],
			[]
		);

		assert.deepEqual(result, [
			{ filename: 'report.pdf', type: 'application/pdf', content: 'AQID' }
		]);
	});

	test('hides missing, foreign, and cross-message attachment IDs behind one 404', async () => {
		await assert.rejects(
			materializeManualForwardAttachments(
				attachmentDb('another-user'),
				attachmentBucket(),
				sourceEmail.user_id,
				sourceEmail.id,
				[attachment.id],
				[]
			),
			(error: unknown) => error instanceof ManualForwardError && error.status === 404
		);
	});

	test('rejects duplicate IDs and oversized R2 content before provider send', async () => {
		await assert.rejects(
			materializeManualForwardAttachments(
				attachmentDb(),
				attachmentBucket(),
				sourceEmail.user_id,
				sourceEmail.id,
				[attachment.id, attachment.id],
				[]
			),
			(error: unknown) => error instanceof ManualForwardError && error.status === 400
		);

		await assert.rejects(
			materializeManualForwardAttachments(
				attachmentDb(),
				attachmentBucket(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
				sourceEmail.user_id,
				sourceEmail.id,
				[attachment.id],
				[]
			),
			(error: unknown) => error instanceof ManualForwardError && error.status === 400
		);
	});

	test('rejects oversized and malformed uploaded base64 before decoding', async () => {
		const originalAtob = globalThis.atob;
		let decodeCalls = 0;
		globalThis.atob = () => {
			decodeCalls += 1;
			throw new Error('decoder should not run');
		};

		try {
			await assert.rejects(
				materializeManualForwardAttachments(
					attachmentDb(),
					attachmentBucket(),
					sourceEmail.user_id,
					sourceEmail.id,
					[],
					[
						{
							filename: 'huge.bin',
							type: 'application/octet-stream',
							content: 'A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)
						}
					]
				),
				(error: unknown) => error instanceof ManualForwardError && error.status === 400
			);
			assert.equal(decodeCalls, 0);

			for (const content of ['A===', 'AAA', 'AA=A', '!!!!']) {
				await assert.rejects(
					materializeManualForwardAttachments(
						attachmentDb(),
						attachmentBucket(),
						sourceEmail.user_id,
						sourceEmail.id,
						[],
						[{ filename: 'bad.bin', type: 'application/octet-stream', content }]
					),
					(error: unknown) =>
						error instanceof ManualForwardError &&
						error.status === 400 &&
						error.message === 'Invalid attachment content'
				);
			}

			for (const record of [null, 42, {}]) {
				await assert.rejects(
					materializeManualForwardAttachments(
						attachmentDb(),
						attachmentBucket(),
						sourceEmail.user_id,
						sourceEmail.id,
						[],
						[record as unknown as OutboundAttachmentInput]
					),
					(error: unknown) =>
						error instanceof ManualForwardError &&
						error.status === 400 &&
						error.message === 'Invalid attachment content'
				);
			}
			assert.equal(decodeCalls, 0);
		} finally {
			globalThis.atob = originalAtob;
		}
	});
});

test('manual forwards can force a new thread despite a matching subject', async () => {
	const db = {
		prepare() {
			throw new Error('subject matching must not query the old thread');
		}
	} as unknown as D1Database;

	const threadId = await resolveThreadId(db, sourceEmail.user_id, {
		emailId: 'new-forward-id',
		direction: 'outbound',
		subject: `Fwd: ${sourceEmail.subject}`,
		from: sourceEmail.to_addr,
		to: sourceEmail.from_addr,
		domainId: sourceEmail.domain_id,
		subjectMatch: false
	});
	assert.equal(threadId, 'new-forward-id');
});
