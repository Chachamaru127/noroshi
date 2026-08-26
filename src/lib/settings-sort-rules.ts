import type { MailSortRule } from '$lib/types';

const SAFE_RULE_ERRORS: Record<string, string> = {
	'Sorting rule is invalid.': '自動振り分けルールの入力内容を確認してください。',
	'At least one sorting condition is required.':
		'差出人または件名の条件を1つ以上入力してください。',
	'Sorting conditions must be 256 characters or fewer.':
		'条件はそれぞれ256文字以内で入力してください。',
	'Sorting conditions cannot contain control characters.':
		'条件に使用できない文字が含まれています。',
	'A maximum of 100 sorting rules is allowed.': '自動振り分けルールは100件まで作成できます。',
	'Sorting rule or destination folder was not found.':
		'ルールまたは移動先フォルダが見つかりません。',
	'Sorting rule was not found.': 'ルールが見つかりません。',
	'Sorting rule order is invalid.': 'ルールの並び順を更新できませんでした。',
	'Order all 1 to 100 sorting rules.': 'ルールの並び順を更新できませんでした。',
	'Sorting rule IDs must be unique.': 'ルールの並び順を更新できませんでした。',
	'Order must contain all sorting rules owned by the user.':
		'ルールの状態が変更されています。画面を再読み込みしてください。'
};

export function sortRuleUiError(value: unknown): string {
	if (typeof value !== 'string') return '自動振り分けルールを更新できませんでした。';
	return SAFE_RULE_ERRORS[value] ?? '自動振り分けルールを更新できませんでした。';
}

export function sortRuleConditionLength(value: string): number {
	return Array.from(value.trim()).length;
}

export function moveSortRule<T>(items: T[], index: number, direction: -1 | 1): T[] {
	const target = index + direction;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
	const next = [...items];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

export function deletedRuleFocusOrder(ruleIds: string[], deletedId: string): string[] {
	const index = ruleIds.indexOf(deletedId);
	if (index < 0) return [];
	return [ruleIds[index + 1], ruleIds[index - 1]].filter((id): id is string => Boolean(id));
}

export function survivingFocusCandidate<T extends { isConnected: boolean }>(
	candidates: Array<T | null | undefined>
): T | null {
	return candidates.find((candidate): candidate is T => Boolean(candidate?.isConnected)) ?? null;
}

export function sortRuleAccessibleLabel(
	rule: {
		folder_name: string;
		sender_contains: string | null;
		subject_contains: string | null;
		enabled: boolean;
	},
	index: number
): string {
	const conditions = [
		rule.sender_contains ? `差出人に「${rule.sender_contains}」を含む` : null,
		rule.subject_contains ? `件名に「${rule.subject_contains}」を含む` : null
	].filter((condition): condition is string => Boolean(condition));
	return `評価順${index + 1}。${rule.enabled ? '有効' : '無効'}。移動先「${rule.folder_name}」。${conditions.join('、')}`;
}

export function canStartSortRuleEditor(input: {
	busy: boolean;
	actionId: string;
	editorOpen: boolean;
}): boolean {
	return !input.busy && !input.actionId && !input.editorOpen;
}

export async function loadCurrentSortRules(fetcher: typeof fetch): Promise<MailSortRule[] | null> {
	try {
		const response = await fetcher('/api/sort-rules');
		const body = (await response.json().catch(() => null)) as { rules?: unknown } | null;
		return response.ok && Array.isArray(body?.rules) ? (body.rules as MailSortRule[]) : null;
	} catch {
		return null;
	}
}
