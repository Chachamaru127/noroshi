import type { D1Database } from '@cloudflare/workers-types';
import type { MailSortRule } from '$lib/types';
import { normalizeMailSortKey } from './mail-sort-key';

const MAX_RULES = 100;
const MAX_CONDITION_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export class MailSortRuleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MailSortRuleValidationError';
	}
}

export class MailSortRuleNotFoundError extends Error {
	constructor() {
		super('Sorting rule or destination folder was not found.');
		this.name = 'MailSortRuleNotFoundError';
	}
}

type RuleInput = {
	folderId: string;
	senderContains?: string | null;
	subjectContains?: string | null;
	enabled?: boolean;
};

type RuleUpdate = {
	folderId?: string;
	senderContains?: string | null;
	subjectContains?: string | null;
	enabled?: boolean;
};

type RuleRow = Omit<MailSortRule, 'enabled'> & { enabled: number };

function validateId(value: string, label: string): string {
	const id = value.trim();
	if (!id || id.length > MAX_ID_LENGTH || CONTROL_CHARACTERS.test(id)) {
		throw new MailSortRuleValidationError(`${label} is invalid.`);
	}
	return id;
}

function normalizeCondition(value: string | null | undefined): string | null {
	if (value == null) return null;
	const condition = value.trim();
	if (!condition) return null;
	if (Array.from(condition).length > MAX_CONDITION_LENGTH) {
		throw new MailSortRuleValidationError(
			`Sorting conditions must be ${MAX_CONDITION_LENGTH} characters or fewer.`
		);
	}
	if (CONTROL_CHARACTERS.test(condition)) {
		throw new MailSortRuleValidationError('Sorting conditions cannot contain control characters.');
	}
	return condition;
}

function validatedConditions(input: {
	senderContains?: string | null;
	subjectContains?: string | null;
}): { sender: string | null; subject: string | null } {
	const sender = normalizeCondition(input.senderContains);
	const subject = normalizeCondition(input.subjectContains);
	if (!sender && !subject) {
		throw new MailSortRuleValidationError('At least one sorting condition is required.');
	}
	return { sender, subject };
}

function publicRule(row: RuleRow): MailSortRule {
	return { ...row, enabled: row.enabled === 1 };
}

async function findRule(
	db: D1Database,
	userId: string,
	ruleId: string
): Promise<MailSortRule | null> {
	const row = await db
		.prepare(
			`SELECT r.id,r.user_id,r.folder_id,f.name AS folder_name,
				r.sender_contains,r.subject_contains,r.enabled,r.position,r.created_at,r.updated_at
			 FROM mail_sort_rules r
			 JOIN mail_folders f ON f.id = r.folder_id AND f.user_id = r.user_id
			 WHERE r.id = ? AND r.user_id = ?`
		)
		.bind(ruleId, userId)
		.first<RuleRow>();
	return row ? publicRule(row) : null;
}

export async function listSortRules(db: D1Database, userId: string): Promise<MailSortRule[]> {
	const { results } = await db
		.prepare(
			`SELECT r.id,r.user_id,r.folder_id,f.name AS folder_name,
				r.sender_contains,r.subject_contains,r.enabled,r.position,r.created_at,r.updated_at
			 FROM mail_sort_rules r
			 JOIN mail_folders f ON f.id = r.folder_id AND f.user_id = r.user_id
			 WHERE r.user_id = ?
			 ORDER BY r.position ASC,r.created_at ASC,r.id ASC`
		)
		.bind(userId)
		.all<RuleRow>();
	return results.map(publicRule);
}

export async function createSortRule(
	db: D1Database,
	userId: string,
	input: RuleInput
): Promise<MailSortRule> {
	const folderId = validateId(input.folderId, 'Folder ID');
	const { sender, subject } = validatedConditions(input);
	const id = crypto.randomUUID();
	const result = await db
		.prepare(
			`INSERT INTO mail_sort_rules
				(id,user_id,folder_id,sender_contains,subject_contains,sender_match_key,subject_match_key,enabled,position)
			 SELECT ?,?,?,?,?,?,?,?,COALESCE(MAX(r.position),-1)+1
			 FROM mail_folders f
			 LEFT JOIN mail_sort_rules r ON r.user_id = f.user_id
			 WHERE f.id = ? AND f.user_id = ?
			 GROUP BY f.id
			 HAVING COUNT(r.id) < ?`
		)
		.bind(
			id,
			userId,
			folderId,
			sender,
			subject,
			sender ? normalizeMailSortKey(sender) : null,
			subject ? normalizeMailSortKey(subject) : null,
			input.enabled === false ? 0 : 1,
			folderId,
			userId,
			MAX_RULES
		)
		.run();
	if ((result.meta?.changes ?? 0) === 0) {
		const count = await db
			.prepare('SELECT COUNT(*) AS count FROM mail_sort_rules WHERE user_id = ?')
			.bind(userId)
			.first<{ count: number }>();
		if ((count?.count ?? 0) >= MAX_RULES) {
			throw new MailSortRuleValidationError(`A maximum of ${MAX_RULES} sorting rules is allowed.`);
		}
		throw new MailSortRuleNotFoundError();
	}
	const rule = await findRule(db, userId, id);
	if (!rule) throw new Error('Created sorting rule could not be loaded.');
	return rule;
}

export async function updateSortRule(
	db: D1Database,
	userId: string,
	ruleIdValue: string,
	input: RuleUpdate
): Promise<MailSortRule> {
	const ruleId = validateId(ruleIdValue, 'Rule ID');
	const existing = await findRule(db, userId, ruleId);
	if (!existing) throw new MailSortRuleNotFoundError();
	const folderId = validateId(input.folderId ?? existing.folder_id, 'Folder ID');
	const { sender, subject } = validatedConditions({
		senderContains:
			input.senderContains === undefined ? existing.sender_contains : input.senderContains,
		subjectContains:
			input.subjectContains === undefined ? existing.subject_contains : input.subjectContains
	});
	const result = await db
		.prepare(
			`UPDATE mail_sort_rules
			 SET folder_id = ?,sender_contains = ?,subject_contains = ?,
			     sender_match_key = ?,subject_match_key = ?,enabled = ?,updated_at = datetime('now')
			 WHERE id = ? AND user_id = ?
			   AND EXISTS (SELECT 1 FROM mail_folders f WHERE f.id = ? AND f.user_id = ?)`
		)
		.bind(
			folderId,
			sender,
			subject,
			sender ? normalizeMailSortKey(sender) : null,
			subject ? normalizeMailSortKey(subject) : null,
			input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
			ruleId,
			userId,
			folderId,
			userId
		)
		.run();
	if ((result.meta?.changes ?? 0) === 0) throw new MailSortRuleNotFoundError();
	const rule = await findRule(db, userId, ruleId);
	if (!rule) throw new MailSortRuleNotFoundError();
	return rule;
}

export async function deleteSortRule(
	db: D1Database,
	userId: string,
	ruleIdValue: string
): Promise<void> {
	const ruleId = validateId(ruleIdValue, 'Rule ID');
	const result = await db
		.prepare('DELETE FROM mail_sort_rules WHERE id = ? AND user_id = ?')
		.bind(ruleId, userId)
		.run();
	if ((result.meta?.changes ?? 0) === 0) throw new MailSortRuleNotFoundError();
}

export async function reorderSortRules(
	db: D1Database,
	userId: string,
	ruleIds: string[]
): Promise<MailSortRule[]> {
	if (ruleIds.length === 0 || ruleIds.length > MAX_RULES) {
		throw new MailSortRuleValidationError(`Order all 1 to ${MAX_RULES} sorting rules.`);
	}
	const ids = ruleIds.map((id) => validateId(id, 'Rule ID'));
	if (new Set(ids).size !== ids.length) {
		throw new MailSortRuleValidationError('Sorting rule IDs must be unique.');
	}
	const json = JSON.stringify(ids);
	const result = await db
		.prepare(
			`WITH requested AS (SELECT CAST(key AS INTEGER) AS position,value AS id FROM json_each(?))
			 UPDATE mail_sort_rules
			 SET position = (SELECT requested.position FROM requested WHERE requested.id = mail_sort_rules.id),
			     updated_at = datetime('now')
			 WHERE user_id = ?
			   AND id IN (SELECT id FROM requested)
			   AND (SELECT COUNT(*) FROM requested) =
			       (SELECT COUNT(*) FROM mail_sort_rules owned WHERE owned.user_id = ?)
			   AND NOT EXISTS (
			       SELECT 1 FROM requested
			       WHERE NOT EXISTS (
			           SELECT 1 FROM mail_sort_rules owned
			           WHERE owned.id = requested.id AND owned.user_id = ?
			       )
			   )`
		)
		.bind(json, userId, userId, userId)
		.run();
	if ((result.meta?.changes ?? 0) !== ids.length) {
		throw new MailSortRuleValidationError(
			'Order must contain all sorting rules owned by the user.'
		);
	}
	return listSortRules(db, userId);
}
