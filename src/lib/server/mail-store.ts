import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { MAILBOX_PAGE_SIZE } from '$lib/constants';
import { MAX_BODY_BYTES } from './constants';
import { stripQuotedText } from '$lib/utils/quotes';
import { displaySubject, normalizeSubject, resolveThreadId } from './threads';
import { normalizeMailSortKey } from './mail-sort-key';
import type {
	DeliveryStatus,
	EmailAttachmentMeta,
	EmailRow,
	EmailSummary,
	MailboxCounts,
	MailboxPage,
	MailboxView,
	MailStatus,
	ThreadMessage,
	ThreadParticipant,
	ThreadSummary
} from '$lib/types';

export class ProviderDeliveryAlreadyClaimedError extends Error {
	constructor(providerId: string) {
		super(`Provider delivery already claimed: ${providerId}`);
		this.name = 'ProviderDeliveryAlreadyClaimedError';
	}
}

export async function getUserIdByEmail(db: D1Database, email: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT id FROM users WHERE email = ?')
		.bind(email.toLowerCase())
		.first<{ id: string }>();

	return row?.id ?? null;
}

export async function insertEmail(
	db: D1Database,
	input: {
		userId: string;
		direction: 'inbound' | 'outbound';
		from: string;
		to: string;
		cc?: string | null;
		bcc?: string | null;
		subject: string;
		bodyText?: string | null;
		bodyHtml?: string | null;
		messageId?: string | null;
		inReplyTo?: string | null;
		references?: string | null;
		replyToEmailId?: string | null;
		domainId?: string | null;
		/** Registered mailbox identity; synthetic and catch-all identities remain NULL. */
		addressId?: string | null;
		providerId?: string | null;
		status?: MailStatus | null;
		forwardingHop?: number;
		attachmentsReady?: boolean;
		isRead?: boolean;
		createdAt?: Date;
		/** Preserve a trusted historical EML body beyond the live ingress limit. */
		preserveBody?: boolean;
		/** Override subject fallback when callers must create a separate conversation. */
		subjectMatch?: boolean;
	}
): Promise<string> {
	const id = crypto.randomUUID();
	const bodyText = input.preserveBody ? (input.bodyText ?? null) : truncate(input.bodyText ?? null);
	const bodyHtml = input.preserveBody ? (input.bodyHtml ?? null) : truncate(input.bodyHtml ?? null);

	// Every message lands in a conversation before it is stored, so the list
	// view never has to guess. Resolution and insert are intentionally separate
	// D1 statements in this MVP; a concurrent same-subject first message can
	// still start a second thread. Atomic thread creation is deferred.
	const threadId = await resolveThreadId(db, input.userId, {
		emailId: id,
		direction: input.direction,
		subject: input.subject,
		from: input.from,
		to: input.to,
		cc: input.cc,
		inReplyTo: input.inReplyTo,
		references: input.references,
		replyToEmailId: input.replyToEmailId,
		domainId: input.domainId ?? null,
		subjectMatch: input.subjectMatch ?? input.status !== 'draft'
	});

	const createdAt = input.createdAt ?? new Date();
	const inserted = await db
		.prepare(
			`INSERT INTO emails (
				id, user_id, direction, from_addr, to_addr, cc_addr, bcc_addr, subject,
				sort_sender_key, sort_subject_key,
				body_text, body_html, message_id, in_reply_to, references_header,
				reply_to_email_id, thread_id, thread_key,
				domain_id, address_id, provider_id, status, forwarding_hop, attachments_ready, status_at, is_read,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
		)
		.bind(
			id,
			input.userId,
			input.direction,
			input.from,
			input.to,
			input.cc ?? null,
			input.bcc ?? null,
			input.subject,
			normalizeMailSortKey(input.from),
			normalizeMailSortKey(input.subject),
			bodyText,
			bodyHtml,
			input.messageId ?? null,
			input.inReplyTo ?? null,
			input.references ?? null,
			input.replyToEmailId ?? null,
			threadId,
			normalizeSubject(input.subject),
			input.domainId ?? null,
			input.addressId ?? null,
			input.providerId ?? null,
			input.status ?? null,
			input.forwardingHop ?? 0,
			input.attachmentsReady === false ? 0 : 1,
			input.isRead ? 1 : 0,
			createdAt.toISOString()
		)
		.run();
	if (input.providerId && (inserted.meta.changes ?? 0) === 0) {
		throw new ProviderDeliveryAlreadyClaimedError(input.providerId);
	}

	return id;
}

/** Already stored? Resend retries webhooks, so inbound writes must be idempotent. */
export async function emailExistsByProviderId(
	db: D1Database,
	providerId: string,
	recipient?: string
): Promise<boolean> {
	const row = await db
		.prepare(
			recipient
				? 'SELECT record_id FROM provider_delivery_claims WHERE provider_id = ? AND recipient = lower(?)'
				: 'SELECT record_id FROM provider_delivery_claims WHERE provider_id = ? LIMIT 1'
		)
		.bind(...(recipient ? [providerId, recipient] : [providerId]))
		.first<{ record_id: string }>();
	return Boolean(row);
}

export async function markInboundAttachmentsReady(db: D1Database, emailId: string): Promise<void> {
	await db
		.prepare("UPDATE emails SET attachments_ready = 1 WHERE id = ? AND direction = 'inbound'")
		.bind(emailId)
		.run();
}

/** Applied when Resend reports delivery/bounce/complaint on something we sent. */
export async function updateEmailStatusByProviderId(
	db: D1Database,
	providerId: string,
	status: DeliveryStatus,
	detail?: string | null
): Promise<void> {
	await db
		.prepare(
			`UPDATE emails SET status = ?, status_at = datetime('now'), status_detail = ?
			 WHERE provider_id = ?`
		)
		.bind(status, detail ?? null, providerId)
		.run();
}

/**
 * Every mailbox is a slice of the same table: Drafts are unsent outbound rows,
 * Trash is anything with `deleted_at`, and the rest hide trashed mail. A
 * conversation shows up in a mailbox when any of its messages match.
 */
function viewFilter(view: MailboxView | 'folder'): string {
	switch (view) {
		case 'inbox':
			return `e.deleted_at IS NULL AND e.direction = 'inbound'
				AND NOT EXISTS (
					SELECT 1 FROM mail_thread_folders inbox_folder
					WHERE inbox_folder.user_id = e.user_id
					  AND inbox_folder.thread_id = COALESCE(e.thread_id,e.id)
				)`;
		case 'sent':
			return "e.deleted_at IS NULL AND e.direction = 'outbound' AND (e.status IS NULL OR e.status <> 'draft')";
		case 'drafts':
			return "e.deleted_at IS NULL AND e.status = 'draft'";
		case 'starred':
			return "e.deleted_at IS NULL AND e.is_starred = 1 AND (e.status IS NULL OR e.status <> 'draft')";
		case 'trash':
			return 'e.deleted_at IS NOT NULL';
		case 'folder':
			return "e.deleted_at IS NULL AND (e.status IS NULL OR e.status <> 'draft')";
	}
}

/**
 * Which messages of a matched conversation are actually rendered. Wider than
 * `viewFilter` on purpose — an inbox row counts the replies we sent too, so it
 * reads as one conversation rather than a matched message.
 */
function displayFilter(view: MailboxView | 'folder', alias: string): string {
	switch (view) {
		case 'trash':
			return `${alias}.deleted_at IS NOT NULL`;
		case 'drafts':
			return `${alias}.deleted_at IS NULL AND ${alias}.status = 'draft'`;
		default:
			return `${alias}.deleted_at IS NULL AND (${alias}.status IS NULL OR ${alias}.status <> 'draft')`;
	}
}

export type MailboxQuery = {
	view: MailboxView | 'folder';
	/** Required for the custom-folder view. */
	folderId?: string | null;
	/** Restrict to one connected domain; omit for the combined view. */
	domainId?: string | null;
	/** Restrict to a registered address owned by the current user. */
	addressId?: string | null;
	/** Free text matched against participants, subject and body. */
	q?: string | null;
	unreadOnly?: boolean;
	starredOnly?: boolean;
	attachmentsOnly?: boolean;
	page?: number;
	pageSize?: number;
};

type ThreadMessageRow = {
	id: string;
	thread_id: string;
	direction: 'inbound' | 'outbound';
	from_addr: string;
	to_addr: string;
	subject: string;
	body_head: string | null;
	is_read: number;
	is_starred: number;
	has_attachments: number;
	domain_id: string | null;
	address_id: string | null;
	status: MailStatus | null;
	created_at: string;
};

/** Builds the WHERE clause and bindings shared by the count and the page query. */
function buildScope(userId: string, query: MailboxQuery): { where: string; bindings: unknown[] } {
	const filters = ['e.user_id = ?', viewFilter(query.view)];
	const bindings: unknown[] = [userId];
	if (query.view === 'folder') {
		if (!query.folderId) throw new Error('folderId is required for the folder mailbox.');
		filters.push(
			`EXISTS (
				SELECT 1 FROM mail_thread_folders selected_folder
				WHERE selected_folder.user_id = e.user_id
				  AND selected_folder.thread_id = COALESCE(e.thread_id,e.id)
				  AND selected_folder.folder_id = ?
			)`
		);
		bindings.push(query.folderId);
	}

	if (query.domainId) {
		filters.push('e.domain_id = ?');
		bindings.push(query.domainId);
	}

	if (query.addressId) {
		filters.push(
			`e.address_id = ? AND EXISTS (
				SELECT 1 FROM addresses selected_address
				WHERE selected_address.id = ? AND selected_address.user_id = e.user_id
			)`
		);
		bindings.push(query.addressId, query.addressId);
	}

	const term = query.q?.trim();
	if (term) {
		filters.push(
			`(e.subject LIKE ? ESCAPE '\\' OR e.from_addr LIKE ? ESCAPE '\\'
			  OR e.to_addr LIKE ? ESCAPE '\\' OR e.body_text LIKE ? ESCAPE '\\')`
		);
		const like = `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
		bindings.push(like, like, like, like);
	}

	if (query.unreadOnly) {
		filters.push(
			query.view === 'folder' ? "e.direction = 'inbound' AND e.is_read = 0" : 'e.is_read = 0'
		);
	}
	if (query.starredOnly) filters.push('e.is_starred = 1');
	if (query.attachmentsOnly) {
		filters.push('EXISTS(SELECT 1 FROM email_attachments a WHERE a.email_id = e.id)');
	}

	return { where: filters.join(' AND '), bindings };
}

/**
 * One page of conversations. Filters match individual messages, but the unit of
 * the list is the thread they belong to, ordered by its most recent message.
 */
export async function listMailbox(
	db: D1Database,
	userId: string,
	query: MailboxQuery
): Promise<MailboxPage> {
	const { where, bindings } = buildScope(userId, query);
	const pageSize = query.pageSize ?? MAILBOX_PAGE_SIZE;
	const display = displayFilter(query.view, 'm');

	const totalRow = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM (
				SELECT DISTINCT COALESCE(e.thread_id, e.id) AS thread_id FROM emails e WHERE ${where}
			)`
		)
		.bind(...bindings)
		.first<{ count: number }>();

	const total = totalRow?.count ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(1, query.page ?? 1), pageCount);

	if (total === 0) {
		return { threads: [], total, page, pageCount, pageSize };
	}

	const { results: rows } = await db
		.prepare(
			`SELECT t.thread_id, MAX(datetime(m.created_at)) AS last_at
			 FROM (
				SELECT DISTINCT COALESCE(e.thread_id, e.id) AS thread_id FROM emails e WHERE ${where}
			 ) t
			 JOIN emails m
			   ON m.user_id = ? AND COALESCE(m.thread_id, m.id) = t.thread_id AND ${display}
			 GROUP BY t.thread_id
			 ORDER BY last_at DESC
			 LIMIT ? OFFSET ?`
		)
		.bind(...bindings, userId, pageSize, (page - 1) * pageSize)
		.all<{ thread_id: string; last_at: string }>();

	const threadIds = rows.map((row) => row.thread_id);
	if (threadIds.length === 0) {
		return { threads: [], total, page, pageCount, pageSize };
	}

	const placeholders = threadIds.map(() => '?').join(', ');
	const { results: messages } = await db
		.prepare(
			`SELECT m.id, COALESCE(m.thread_id, m.id) AS thread_id, m.direction, m.from_addr, m.to_addr,
			        m.subject, m.is_read, m.is_starred, m.created_at, m.domain_id, m.address_id, m.status,
			        substr(COALESCE(m.body_text, ''), 1, 4000) AS body_head,
			        EXISTS(SELECT 1 FROM email_attachments a WHERE a.email_id = m.id) AS has_attachments
			 FROM emails m
			 WHERE m.user_id = ? AND COALESCE(m.thread_id, m.id) IN (${placeholders}) AND ${display}
			 ORDER BY datetime(m.created_at) ASC`
		)
		.bind(userId, ...threadIds)
		.all<ThreadMessageRow>();

	const byThread = new Map<string, ThreadMessageRow[]>();
	for (const message of messages) {
		const bucket = byThread.get(message.thread_id);
		if (bucket) bucket.push(message);
		else byThread.set(message.thread_id, [message]);
	}

	const threads = threadIds
		.map((threadId) => byThread.get(threadId))
		.filter((group): group is ThreadMessageRow[] => Boolean(group?.length))
		.map(toThreadSummary);

	return { threads, total, page, pageCount, pageSize };
}

/** `messages` is the whole conversation, oldest first. */
function toThreadSummary(messages: ThreadMessageRow[]): ThreadSummary {
	const oldest = messages[0];
	const latest = messages[messages.length - 1];

	// Senders in the order they first spoke, with our own identities collapsed
	// into a single "me" the way a conversation header reads.
	const participants: ThreadParticipant[] = [];
	for (const message of messages) {
		if (message.direction === 'outbound') {
			if (!participants.some((entry) => entry.self)) {
				participants.push({ label: 'me', address: message.from_addr, self: true });
			}
			continue;
		}

		const address = message.from_addr;
		const seen = participants.some(
			(entry) => !entry.self && entry.address.toLowerCase() === address.toLowerCase()
		);
		if (seen) continue;

		participants.push({ label: displayNameFor(address), address, self: false });
	}

	return {
		thread_id: oldest.thread_id,
		latest_id: latest.id,
		// The conversation keeps the subject it started with, not "Re: Re: …".
		subject: displaySubject(oldest.subject),
		preview: buildPreview(latest.body_head),
		participants,
		message_count: messages.length,
		is_read: messages.every((message) => message.is_read === 1),
		is_starred: messages.some((message) => message.is_starred === 1),
		is_draft: latest.status === 'draft',
		has_attachments: messages.some((message) => message.has_attachments === 1),
		domain_id: latest.domain_id,
		address_id: latest.address_id,
		status: latest.status === 'draft' ? null : latest.status,
		created_at: latest.created_at
	};
}

/** "hello.there@x.com" → "hello there"; the list capitalizes it in CSS. */
function displayNameFor(address: string): string {
	if (!address) return 'Unknown';
	const [local] = address.split('@');
	return local.replace(/[._-]+/g, ' ');
}

/** The newest message's own words — quoted history is dropped. */
function buildPreview(bodyHead: string | null): string {
	if (!bodyHead) return '';
	return stripQuotedText(bodyHead).replace(/\s+/g, ' ').trim().slice(0, 180);
}

/** Flat message list, used by the JSON API rather than the mailbox UI. */
export async function listEmails(
	db: D1Database,
	userId: string,
	options: {
		direction?: 'inbound' | 'outbound';
		domainId?: string | null;
		addressId?: string | null;
		limit?: number;
	} = {}
): Promise<EmailSummary[]> {
	const view: MailboxView = options.direction === 'outbound' ? 'sent' : 'inbox';
	const { where, bindings } = buildScope(userId, {
		view,
		domainId: options.domainId,
		addressId: options.addressId
	});

	const { results } = await db
		.prepare(
			`SELECT e.id, e.direction, e.from_addr, e.to_addr, e.subject, e.is_read, e.is_starred,
			        e.created_at, e.domain_id, e.address_id, e.status,
			        substr(COALESCE(e.body_text, ''), 1, 4000) AS body_head,
			        EXISTS(SELECT 1 FROM email_attachments a WHERE a.email_id = e.id) AS has_attachments
			 FROM emails e
			 WHERE ${where}
			 ORDER BY datetime(e.created_at) DESC
			 LIMIT ?`
		)
		.bind(...bindings, options.limit ?? 100)
		.all<ThreadMessageRow>();

	return results.map((row) => ({
		id: row.id,
		direction: row.direction,
		from_addr: row.from_addr,
		to_addr: row.to_addr,
		subject: row.subject,
		preview: buildPreview(row.body_head),
		is_read: row.is_read === 1,
		is_starred: row.is_starred === 1,
		is_draft: row.status === 'draft',
		has_attachments: row.has_attachments === 1,
		domain_id: row.domain_id,
		address_id: row.address_id,
		status: row.status === 'draft' ? null : row.status,
		created_at: row.created_at
	}));
}

/**
 * Row counts behind every sidebar entry, in one round trip. Counted in
 * conversations so the badges agree with what the lists actually show.
 */
export async function getMailboxCounts(
	db: D1Database,
	userId: string,
	domainId?: string | null
): Promise<MailboxCounts> {
	const bindings: unknown[] = [userId];
	let scope = 'user_id = ?';
	if (domainId) {
		scope += ' AND domain_id = ?';
		bindings.push(domainId);
	}

	const thread = 'COALESCE(thread_id, id)';

	const row = await db
		.prepare(
			`SELECT
				COUNT(DISTINCT CASE WHEN deleted_at IS NULL AND direction = 'inbound'
					AND NOT EXISTS (SELECT 1 FROM mail_thread_folders inbox_folder
						WHERE inbox_folder.user_id = emails.user_id
						  AND inbox_folder.thread_id = COALESCE(emails.thread_id,emails.id))
					THEN ${thread} END) AS inbox,
				COUNT(DISTINCT CASE WHEN deleted_at IS NULL AND direction = 'inbound' AND is_read = 0
					AND NOT EXISTS (SELECT 1 FROM mail_thread_folders inbox_folder
						WHERE inbox_folder.user_id = emails.user_id
						  AND inbox_folder.thread_id = COALESCE(emails.thread_id,emails.id))
					THEN ${thread} END) AS inbox_unread,
				COUNT(DISTINCT CASE WHEN deleted_at IS NULL AND is_starred = 1 AND (status IS NULL OR status <> 'draft') THEN ${thread} END) AS starred,
				COUNT(DISTINCT CASE WHEN deleted_at IS NULL AND status = 'draft' THEN ${thread} END) AS drafts,
				COUNT(DISTINCT CASE WHEN deleted_at IS NULL AND direction = 'outbound' AND (status IS NULL OR status <> 'draft') THEN ${thread} END) AS sent,
				COUNT(DISTINCT CASE WHEN deleted_at IS NOT NULL THEN ${thread} END) AS trash
			 FROM emails WHERE ${scope}`
		)
		.bind(...bindings)
		.first<Record<keyof MailboxCounts, number | null>>();

	return {
		inbox: row?.inbox ?? 0,
		inbox_unread: row?.inbox_unread ?? 0,
		starred: row?.starred ?? 0,
		drafts: row?.drafts ?? 0,
		sent: row?.sent ?? 0,
		trash: row?.trash ?? 0
	};
}

export async function countUnread(
	db: D1Database,
	userId: string,
	domainId?: string | null
): Promise<number> {
	const counts = await getMailboxCounts(db, userId, domainId);
	return counts.inbox_unread;
}

/**
 * Widens a set of message ids to every message in the same conversations.
 * List actions read as conversation actions — trashing a thread trashes the
 * replies with it.
 */
export async function expandToThreads(
	db: D1Database,
	userId: string,
	ids: string[]
): Promise<string[]> {
	if (ids.length === 0) return [];

	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT id FROM emails
			 WHERE user_id = ?
			 AND COALESCE(thread_id, id) IN (
				SELECT COALESCE(thread_id, id) FROM emails WHERE user_id = ? AND id IN (${placeholders})
			 )`
		)
		.bind(userId, userId, ...ids)
		.all<{ id: string }>();

	return results.map((row) => row.id);
}

export type MailFlagUpdate = {
	isRead?: boolean;
	isStarred?: boolean;
	trashed?: boolean;
};

/** Applies list actions (read/unread, star, trash, restore) to a set of rows. */
export async function setEmailFlags(
	db: D1Database,
	userId: string,
	ids: string[],
	update: MailFlagUpdate
): Promise<number> {
	if (ids.length === 0) return 0;

	const assignments: string[] = [];
	const bindings: unknown[] = [];

	if (update.isRead !== undefined) {
		assignments.push('is_read = ?');
		bindings.push(update.isRead ? 1 : 0);
	}
	if (update.isStarred !== undefined) {
		assignments.push('is_starred = ?');
		bindings.push(update.isStarred ? 1 : 0);
	}
	if (update.trashed !== undefined) {
		assignments.push(update.trashed ? "deleted_at = datetime('now')" : 'deleted_at = NULL');
	}

	if (assignments.length === 0) return 0;

	const placeholders = ids.map(() => '?').join(', ');
	const result = await db
		.prepare(
			`UPDATE emails SET ${assignments.join(', ')}
			 WHERE user_id = ? AND id IN (${placeholders})`
		)
		.bind(...bindings, userId, ...ids)
		.run();

	return result.meta?.changes ?? 0;
}

/**
 * Irreversible: atomically queues attachment cleanup and drops the D1 mail rows,
 * then removes the R2 objects. A post-commit R2 failure remains in the durable
 * cleanup outbox without turning the committed D1 deletion into a false failure.
 */
export async function deleteEmailsPermanently(
	db: D1Database,
	bucket: R2Bucket | undefined,
	userId: string,
	ids: string[],
	options: { onlyTrashed?: boolean } = {}
): Promise<number> {
	if (ids.length === 0) return 0;
	const requestedIds = JSON.stringify([...new Set(ids)]);
	const trashPredicate = options.onlyTrashed ? ' AND e.deleted_at IS NOT NULL' : '';
	const selectedAttachments = db
		.prepare(
			`SELECT a.storage_key
			 FROM email_attachments a
			 JOIN emails e ON e.id = a.email_id
			 JOIN json_each(?) requested ON CAST(requested.value AS TEXT) = e.id
			 WHERE e.user_id = ? AND a.storage_key IS NOT NULL${trashPredicate}`
		)
		.bind(requestedIds, userId);

	// All D1 rows disappear in one transaction. The first statement captures
	// exactly the R2 keys covered by that transaction; objects are deleted only
	// after D1 commits, so a rolled-back D1 batch never loses attachment data.
	const batch = await db.batch<{ storage_key: string }>([
		selectedAttachments,
		db
			.prepare(
				`INSERT OR IGNORE INTO attachment_cleanup_outbox(storage_key)
				 SELECT a.storage_key
				 FROM email_attachments a
				 JOIN emails e ON e.id = a.email_id
				 JOIN json_each(?) requested ON CAST(requested.value AS TEXT) = e.id
				 WHERE e.user_id = ? AND a.storage_key IS NOT NULL${trashPredicate}`
			)
			.bind(requestedIds, userId),
		db
			.prepare(
				`DELETE FROM email_attachments
				 WHERE email_id IN (
					SELECT e.id FROM emails e
					JOIN json_each(?) requested ON CAST(requested.value AS TEXT) = e.id
					WHERE e.user_id = ?${trashPredicate}
				 )`
			)
			.bind(requestedIds, userId),
		db
			.prepare(
				`DELETE FROM emails
				 WHERE user_id = ?
				   AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
				   ${options.onlyTrashed ? 'AND deleted_at IS NOT NULL' : ''}`
			)
			.bind(userId, requestedIds),
		db
			.prepare(
				`DELETE FROM mail_thread_folders
				 WHERE user_id = ?
				   AND NOT EXISTS (
					 SELECT 1 FROM emails remaining
					 WHERE remaining.user_id = mail_thread_folders.user_id
					   AND COALESCE(remaining.thread_id,remaining.id) = mail_thread_folders.thread_id
				   )`
			)
			.bind(userId),
		db
			.prepare(
				`DELETE FROM mail_thread_folder_suppressions
				 WHERE user_id = ?
				   AND NOT EXISTS (
					 SELECT 1 FROM emails remaining
					 WHERE remaining.user_id = mail_thread_folder_suppressions.user_id
					   AND COALESCE(remaining.thread_id,remaining.id) = mail_thread_folder_suppressions.thread_id
				   )`
			)
			.bind(userId)
	]);

	const deleted = batch[3]?.meta?.changes ?? 0;
	if (bucket && deleted > 0) {
		const files = batch[0]?.results ?? [];
		await cleanupAttachmentObjects(db, bucket, files);
	}
	return deleted;
}

type AttachmentCleanupRow = { storage_key: string };

async function cleanupAttachmentObjects(
	db: D1Database,
	bucket: R2Bucket,
	files: AttachmentCleanupRow[]
): Promise<{ processed: number; failed: number }> {
	if (files.length === 0) return { processed: 0, failed: 0 };
	const cleanup = await Promise.allSettled(files.map((file) => bucket.delete(file.storage_key)));
	const successful: string[] = [];
	const failures: PromiseRejectedResult[] = [];
	cleanup.forEach((result, index) => {
		if (result.status === 'fulfilled') successful.push(files[index].storage_key);
		else failures.push(result);
	});

	if (successful.length > 0) {
		try {
			await db.batch(
				successful.map((storageKey) =>
					db.prepare('DELETE FROM attachment_cleanup_outbox WHERE storage_key = ?').bind(storageKey)
				)
			);
		} catch (error) {
			console.error('Attachment cleanup outbox acknowledgement failed', {
				count: successful.length,
				error_kind: error instanceof Error ? error.name.slice(0, 64) : typeof error
			});
		}
	}
	if (failures.length > 0) {
		const failedKeys = files
			.filter((_, index) => cleanup[index]?.status === 'rejected')
			.map((file) => file.storage_key);
		try {
			await db.batch(
				failedKeys.map((storageKey) =>
					db
						.prepare(
							`UPDATE attachment_cleanup_outbox
							 SET attempts = attempts + 1,
							     last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
							 WHERE storage_key = ?`
						)
						.bind(storageKey)
				)
			);
		} catch (error) {
			console.error('Attachment cleanup outbox failure recording failed', {
				count: failedKeys.length,
				error_kind: error instanceof Error ? error.name.slice(0, 64) : typeof error
			});
		}
		// Do not log storage keys or provider error messages: both may contain
		// tenant data. Counts and bounded error kinds are enough for diagnosis.
		console.error('Attachment R2 cleanup incomplete after permanent mail deletion', {
			failed: failures.length,
			total: files.length,
			error_kinds: [
				...new Set(
					failures.map(({ reason }) =>
						reason instanceof Error ? reason.name.slice(0, 64) : typeof reason
					)
				)
			].slice(0, 5)
		});
	}
	return { processed: files.length, failed: failures.length };
}

/** Retries a bounded batch of R2 objects left behind by committed D1 deletion. */
export async function drainAttachmentCleanupOutbox(
	db: D1Database,
	bucket: R2Bucket,
	limit = 100
): Promise<{ processed: number; failed: number }> {
	const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const { results } = await db
		.prepare(
			`SELECT storage_key FROM attachment_cleanup_outbox
			 ORDER BY julianday(COALESCE(last_attempt_at, created_at)), storage_key LIMIT ?`
		)
		.bind(boundedLimit)
		.all<AttachmentCleanupRow>();
	return cleanupAttachmentObjects(db, bucket, results);
}

/** "Mark all as read" from the list menu — scoped to the active domain filter. */
export async function markAllRead(
	db: D1Database,
	userId: string,
	domainId?: string | null
): Promise<number> {
	const bindings: unknown[] = [userId];
	let scope = `user_id = ? AND direction = 'inbound' AND deleted_at IS NULL AND is_read = 0
		AND NOT EXISTS (
			SELECT 1 FROM mail_thread_folders inbox_folder
			WHERE inbox_folder.user_id = emails.user_id
			  AND inbox_folder.thread_id = COALESCE(emails.thread_id,emails.id)
		)`;
	if (domainId) {
		scope += ' AND domain_id = ?';
		bindings.push(domainId);
	}

	const result = await db
		.prepare(`UPDATE emails SET is_read = 1 WHERE ${scope}`)
		.bind(...bindings)
		.run();

	return result.meta?.changes ?? 0;
}

export async function emptyTrash(
	db: D1Database,
	bucket: R2Bucket | undefined,
	userId: string
): Promise<number> {
	const { results } = await db
		.prepare('SELECT id FROM emails WHERE user_id = ? AND deleted_at IS NOT NULL')
		.bind(userId)
		.all<{ id: string }>();

	return deleteEmailsPermanently(
		db,
		bucket,
		userId,
		results.map((row) => row.id),
		{ onlyTrashed: true }
	);
}

export type DraftInput = {
	id?: string | null;
	from: string;
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	bodyText?: string | null;
	bodyHtml?: string | null;
	domainId?: string | null;
	addressId?: string | null;
};

/** Creates or updates a draft; drafts are outbound rows Resend never saw. */
export async function saveDraft(
	db: D1Database,
	userId: string,
	input: DraftInput
): Promise<string> {
	if (input.id) {
		const existing = await db
			.prepare("SELECT id FROM emails WHERE id = ? AND user_id = ? AND status = 'draft'")
			.bind(input.id, userId)
			.first<{ id: string }>();

		if (existing) {
			await db
				.prepare(
					`UPDATE emails SET from_addr = ?, to_addr = ?, cc_addr = ?, bcc_addr = ?,
					        subject = ?, thread_key = ?, body_text = ?, body_html = ?, domain_id = ?, address_id = ?,
					        created_at = datetime('now'), deleted_at = NULL
					 WHERE id = ? AND user_id = ?`
				)
				.bind(
					input.from,
					input.to,
					input.cc ?? null,
					input.bcc ?? null,
					input.subject,
					normalizeSubject(input.subject),
					input.bodyText ?? null,
					input.bodyHtml ?? null,
					input.domainId ?? null,
					input.addressId ?? null,
					input.id,
					userId
				)
				.run();

			return input.id;
		}
	}

	return insertEmail(db, {
		userId,
		direction: 'outbound',
		from: input.from,
		to: input.to,
		cc: input.cc ?? null,
		bcc: input.bcc ?? null,
		subject: input.subject,
		bodyText: input.bodyText ?? null,
		bodyHtml: input.bodyHtml ?? null,
		domainId: input.domainId ?? null,
		addressId: input.addressId ?? null,
		status: 'draft',
		isRead: true
	});
}

export async function getDraft(
	db: D1Database,
	userId: string,
	draftId: string
): Promise<EmailRow | null> {
	const row = await db
		.prepare("SELECT * FROM emails WHERE id = ? AND user_id = ? AND status = 'draft'")
		.bind(draftId, userId)
		.first<EmailRow>();

	return row ?? null;
}

export async function deleteDraft(db: D1Database, userId: string, draftId: string): Promise<void> {
	await db
		.prepare("DELETE FROM emails WHERE id = ? AND user_id = ? AND status = 'draft'")
		.bind(draftId, userId)
		.run();
}

export async function getEmailForUser(
	db: D1Database,
	userId: string,
	emailId: string
): Promise<EmailRow | null> {
	const row = await db
		.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?')
		.bind(emailId, userId)
		.first<EmailRow>();

	return row ?? null;
}

/**
 * The whole conversation an email belongs to, oldest first — both directions,
 * which is the point: a reply from the other side is part of the thread, not a
 * new message in the inbox.
 */
export async function listThreadMessages(
	db: D1Database,
	userId: string,
	email: EmailRow
): Promise<ThreadMessage[]> {
	const threadId = email.thread_id ?? email.id;

	// Opening a trashed message shows the trashed conversation; otherwise the
	// live one. Drafts are edited in the composer, never inline.
	const scope = email.deleted_at ? '' : 'AND e.deleted_at IS NULL';

	const { results } = await db
		.prepare(
			`SELECT e.id, e.direction, e.from_addr, e.to_addr, e.cc_addr, e.subject,
			        e.body_text, e.body_html, e.message_id, e.references_header,
			        e.status, e.status_detail, e.is_read, e.is_starred, e.deleted_at, e.created_at
			 FROM emails e
			 WHERE e.user_id = ?
			 AND COALESCE(e.thread_id, e.id) = ?
			 AND (e.status IS NULL OR e.status <> 'draft')
			 ${scope}
			 ORDER BY datetime(e.created_at) ASC`
		)
		.bind(userId, threadId)
		.all<
			Omit<ThreadMessage, 'attachments' | 'is_read' | 'is_starred'> & {
				is_read: number;
				is_starred: number;
			}
		>();

	if (results.length === 0) return [];

	// Every message in the thread can carry attachments — one round trip for all.
	const placeholders = results.map(() => '?').join(', ');
	const { results: files } = await db
		.prepare(
			`SELECT id, email_id, filename, content_type, size_bytes, created_at
			 FROM email_attachments
			 WHERE email_id IN (${placeholders})
			 ORDER BY created_at ASC`
		)
		.bind(...results.map((message) => message.id))
		.all<EmailAttachmentMeta>();

	// The query already filters drafts out, so `status` is a delivery state or null
	// and needs no further narrowing here.
	return results.map((message) => ({
		...message,
		is_read: message.is_read === 1,
		is_starred: message.is_starred === 1,
		attachments: files.filter((file) => file.email_id === message.id)
	}));
}

/** Opening a conversation clears the unread state on all of its messages. */
export async function markThreadRead(
	db: D1Database,
	userId: string,
	email: EmailRow
): Promise<void> {
	await db
		.prepare(
			`UPDATE emails SET is_read = 1
			 WHERE user_id = ? AND COALESCE(thread_id, id) = ? AND deleted_at IS NULL`
		)
		.bind(userId, email.thread_id ?? email.id)
		.run();
}

function truncate(value: string | null): string | null {
	if (!value) return null;
	if (value.length <= MAX_BODY_BYTES) return value;
	return value.slice(0, MAX_BODY_BYTES);
}
