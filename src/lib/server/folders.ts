import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { MailFolder, MailFolderDeleteImpact } from '$lib/types';
import { normalizeMailSortKey } from './mail-sort-key';

const MAX_FOLDERS = 50;
const MAX_FOLDER_NAME_LENGTH = 80;
const MAX_ASSIGNMENT_MESSAGES = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const RESERVED_NAME_KEYS = new Set(
	[
		'inbox',
		'sent',
		'drafts',
		'starred',
		'trash',
		'受信トレイ',
		'送信済み',
		'下書き',
		'スター付き',
		'ゴミ箱'
	].map(normalizeMailSortKey)
);

export class MailFolderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MailFolderValidationError';
	}
}

export class MailFolderNotFoundError extends Error {
	constructor() {
		super('Folder or selected message was not found.');
		this.name = 'MailFolderNotFoundError';
	}
}

function normalizeFolderName(value: string): { name: string; key: string } {
	const name = value.trim();
	if (!name) throw new MailFolderValidationError('Folder name is required.');
	if (Array.from(name).length > MAX_FOLDER_NAME_LENGTH) {
		throw new MailFolderValidationError('Folder name must be 80 characters or fewer.');
	}
	if (CONTROL_CHARACTERS.test(name)) {
		throw new MailFolderValidationError('Folder name cannot contain control characters.');
	}
	const key = normalizeMailSortKey(name);
	if (RESERVED_NAME_KEYS.has(key)) {
		throw new MailFolderValidationError('That folder name is reserved.');
	}
	return { name, key };
}

type FolderRow = Omit<MailFolder, 'conversation_count' | 'unread_count'>;

async function getFolderRow(
	db: D1Database,
	userId: string,
	folderId: string
): Promise<FolderRow | null> {
	return db
		.prepare(
			`SELECT id,user_id,name,position,created_at,updated_at
			 FROM mail_folders WHERE id = ? AND user_id = ?`
		)
		.bind(folderId, userId)
		.first<FolderRow>();
}

function withoutCounts(row: FolderRow): MailFolder {
	return { ...row, conversation_count: 0, unread_count: 0 };
}

export async function createFolder(
	db: D1Database,
	userId: string,
	value: string
): Promise<MailFolder> {
	const { name, key } = normalizeFolderName(value);
	const id = crypto.randomUUID();
	let result: { meta?: { changes?: number } };
	try {
		result = await db
			.prepare(
				`INSERT INTO mail_folders (id,user_id,name,name_key,position)
				 SELECT ?,?,?,?,COALESCE(MAX(position),-1)+1
				 FROM mail_folders
				 WHERE user_id = ?
				 HAVING COUNT(*) < ?`
			)
			.bind(id, userId, name, key, userId, MAX_FOLDERS)
			.run();
	} catch (error) {
		if (String(error).toLowerCase().includes('unique')) {
			throw new MailFolderValidationError('A folder with that name already exists.');
		}
		throw error;
	}

	if ((result.meta?.changes ?? 0) === 0) {
		throw new MailFolderValidationError(`A maximum of ${MAX_FOLDERS} folders is allowed.`);
	}
	const folder = await getFolderRow(db, userId, id);
	if (!folder) throw new Error('Created folder could not be loaded.');
	return withoutCounts(folder);
}

export async function renameFolder(
	db: D1Database,
	userId: string,
	folderId: string,
	value: string,
	domainId?: string | null
): Promise<MailFolder> {
	const { name, key } = normalizeFolderName(value);
	let result: { meta?: { changes?: number } };
	try {
		result = await db
			.prepare(
				`UPDATE mail_folders SET name = ?,name_key = ?,updated_at = datetime('now')
				 WHERE id = ? AND user_id = ?`
			)
			.bind(name, key, folderId, userId)
			.run();
	} catch (error) {
		if (String(error).toLowerCase().includes('unique')) {
			throw new MailFolderValidationError('A folder with that name already exists.');
		}
		throw error;
	}
	if ((result.meta?.changes ?? 0) === 0) throw new MailFolderNotFoundError();
	const folder = (await listFolders(db, userId, domainId)).find((entry) => entry.id === folderId);
	if (!folder) throw new MailFolderNotFoundError();
	return folder;
}

export async function listFolders(
	db: D1Database,
	userId: string,
	domainId?: string | null
): Promise<MailFolder[]> {
	const domainScope = domainId ? 'AND e.domain_id = ?' : '';
	const unreadDomainScope = domainId ? 'AND unread.domain_id = ?' : '';
	const bindings: unknown[] = domainId ? [domainId, domainId, userId] : [userId];
	const { results } = await db
		.prepare(
			`SELECT f.id,f.user_id,f.name,f.position,f.created_at,f.updated_at,
				(SELECT COUNT(*) FROM mail_thread_folders mtf
				 WHERE mtf.user_id = f.user_id AND mtf.folder_id = f.id
				   AND EXISTS (
					 SELECT 1 FROM emails e INDEXED BY idx_emails_user_thread_identity
					 WHERE e.user_id = mtf.user_id
					   AND COALESCE(e.thread_id,e.id) = mtf.thread_id
					   AND e.deleted_at IS NULL
					   AND (e.status IS NULL OR e.status <> 'draft')
					   ${domainScope}
				   )) AS conversation_count,
				(SELECT COUNT(*) FROM mail_thread_folders mtf
				 WHERE mtf.user_id = f.user_id AND mtf.folder_id = f.id
				   AND EXISTS (
					 SELECT 1 FROM emails unread INDEXED BY idx_emails_user_thread_identity
					 WHERE unread.user_id = mtf.user_id
					   AND COALESCE(unread.thread_id,unread.id) = mtf.thread_id
					   AND unread.direction = 'inbound' AND unread.is_read = 0
					   AND unread.deleted_at IS NULL
					   ${unreadDomainScope}
				   )) AS unread_count
			 FROM mail_folders f
			 WHERE f.user_id = ?
			 ORDER BY f.position ASC,f.created_at ASC,f.id ASC`
		)
		.bind(...bindings)
		.all<MailFolder>();
	return results;
}

export async function getFolderDeletionImpact(
	db: D1Database,
	userId: string,
	folderId: string
): Promise<MailFolderDeleteImpact> {
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM mail_thread_folders a
				 WHERE a.user_id = f.user_id AND a.folder_id = f.id) AS conversation_count,
				(SELECT COUNT(*) FROM mail_sort_rules r
				 WHERE r.user_id = f.user_id AND r.folder_id = f.id) AS rule_count
			 FROM mail_folders f WHERE f.id = ? AND f.user_id = ?`
		)
		.bind(folderId, userId)
		.first<MailFolderDeleteImpact>();
	if (!row) throw new MailFolderNotFoundError();
	return row;
}

export async function deleteFolder(
	db: D1Database,
	userId: string,
	folderId: string
): Promise<MailFolderDeleteImpact> {
	const impact = await getFolderDeletionImpact(db, userId, folderId);
	const results = await db.batch([
		db
			.prepare('DELETE FROM mail_sort_rules WHERE folder_id = ? AND user_id = ?')
			.bind(folderId, userId),
		db
			.prepare('DELETE FROM mail_thread_folders WHERE folder_id = ? AND user_id = ?')
			.bind(folderId, userId),
		db.prepare('DELETE FROM mail_folders WHERE id = ? AND user_id = ?').bind(folderId, userId)
	]);
	const folderDelete = results[2] as { meta?: { changes?: number } } | undefined;
	if ((folderDelete?.meta?.changes ?? 0) === 0) throw new MailFolderNotFoundError();
	return impact;
}

export async function assignThreadsToFolder(
	db: D1Database,
	userId: string,
	messageIds: string[],
	folderId: string | null
): Promise<number> {
	if (messageIds.length === 0) throw new MailFolderValidationError('Select at least one message.');
	if (messageIds.length > MAX_ASSIGNMENT_MESSAGES) {
		throw new MailFolderValidationError(
			`No more than ${MAX_ASSIGNMENT_MESSAGES} messages can be moved at once.`
		);
	}
	if (messageIds.some((id) => !id.trim() || id.length > 128 || CONTROL_CHARACTERS.test(id))) {
		throw new MailFolderValidationError('A selected message ID is invalid.');
	}
	if (
		folderId !== null &&
		(!folderId.trim() || folderId.length > 128 || CONTROL_CHARACTERS.test(folderId))
	) {
		throw new MailFolderValidationError('Folder ID is invalid.');
	}
	const ids = [...new Set(messageIds)];
	const requestedIds = JSON.stringify(ids);
	const statement = folderId
		? db
				.prepare(
					`WITH requested(id) AS (
						SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)
					), valid AS (
						SELECT e.id,COALESCE(e.thread_id,e.id) AS thread_id
						FROM emails e JOIN requested r ON r.id = e.id
						WHERE e.user_id = ? AND (e.status IS NULL OR e.status <> 'draft')
					), eligible(thread_id) AS (
						SELECT DISTINCT v.thread_id FROM valid v
						WHERE (SELECT COUNT(*) FROM valid) = (SELECT COUNT(*) FROM requested)
						  AND EXISTS (SELECT 1 FROM mail_folders f WHERE f.id = ? AND f.user_id = ?)
					)
					INSERT INTO mail_thread_folders
						(user_id,thread_id,folder_id,assigned_by,created_at,updated_at)
					SELECT ?,thread_id,?,'manual',datetime('now'),datetime('now') FROM eligible
					WHERE true
					ON CONFLICT(user_id,thread_id) DO UPDATE SET
						folder_id=excluded.folder_id,assigned_by='manual',updated_at=datetime('now')
					RETURNING thread_id`
				)
				.bind(requestedIds, userId, folderId, userId, userId, folderId)
		: db
				.prepare(
					`WITH requested(id) AS (
						SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)
					), valid AS (
						SELECT e.id,COALESCE(e.thread_id,e.id) AS thread_id
						FROM emails e JOIN requested r ON r.id = e.id
						WHERE e.user_id = ? AND (e.status IS NULL OR e.status <> 'draft')
					), eligible(thread_id) AS (
						SELECT DISTINCT v.thread_id FROM valid v
						WHERE (SELECT COUNT(*) FROM valid) = (SELECT COUNT(*) FROM requested)
						  AND EXISTS (
							SELECT 1 FROM mail_thread_folders current_assignment
							WHERE current_assignment.user_id = ?
							  AND current_assignment.thread_id = v.thread_id
						  )
					)
					INSERT INTO mail_thread_folder_suppressions
						(user_id,thread_id,created_at,updated_at)
					SELECT ?,thread_id,datetime('now'),datetime('now') FROM eligible
					WHERE true
					ON CONFLICT(user_id,thread_id) DO UPDATE SET updated_at=datetime('now')
					RETURNING thread_id`
				)
				.bind(requestedIds, userId, userId, userId);

	// Validation and mutation intentionally share one SQLite statement. A
	// concurrent permanent delete therefore either wins before this statement
	// (zero writes) or is followed by its atomic metadata cleanup.
	const { results } = await statement.all<{ thread_id: string }>();
	if (results.length === 0 && folderId !== null) throw new MailFolderNotFoundError();
	return results.length;
}
