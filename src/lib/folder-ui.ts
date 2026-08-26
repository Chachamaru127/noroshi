export type FolderOperation = 'manage' | 'move';

/** Match the server contract: trim first, then count Unicode code points. */
export function folderNameLength(value: string): number {
	return Array.from(value.trim()).length;
}

export function mailDetailDestinations(input: {
	trashed: boolean;
	direction: 'inbound' | 'outbound';
	requestedFolderId: string | null;
	assignedFolderId: string | null;
}): {
	backHref: string;
	restoreHref: string;
	unfiledHref: string;
	currentFolderId: string | null;
} {
	const currentFolderId =
		!input.trashed &&
		input.assignedFolderId &&
		(!input.requestedFolderId || input.requestedFolderId === input.assignedFolderId)
			? input.assignedFolderId
			: null;
	const folderHref = (id: string) => `/folders/${encodeURIComponent(id)}`;
	const unfiledHref = input.direction === 'outbound' ? '/sent' : '/inbox';
	return {
		backHref: input.trashed
			? '/trash'
			: currentFolderId
				? folderHref(currentFolderId)
				: unfiledHref,
		restoreHref: input.assignedFolderId ? folderHref(input.assignedFolderId) : unfiledHref,
		unfiledHref,
		currentFolderId
	};
}

const KNOWN_ERRORS: Record<string, string> = {
	'Folder name is required.': 'フォルダ名を入力してください。',
	'Folder name must be 80 characters or fewer.': 'フォルダ名は80文字以内で入力してください。',
	'Folder name cannot contain control characters.':
		'フォルダ名に使用できない文字が含まれています。',
	'That folder name is reserved.': 'そのフォルダ名は使用できません。',
	'A folder with that name already exists.': '同じ名前のフォルダがあります。',
	'A maximum of 50 folders is allowed.': 'フォルダは50件まで作成できます。',
	'Folder or selected message was not found.': 'フォルダまたはメールが見つかりません。',
	'Folder was not found.': 'フォルダが見つかりません。',
	'Select at least one message.': '移動するメールを選択してください。',
	'No more than 100 messages can be moved at once.': '一度に移動できるメールは100件までです。'
};

/** Keep server and database details out of the browser UI. */
export function folderUiError(detail: unknown, operation: FolderOperation = 'manage'): string {
	if (typeof detail === 'string' && KNOWN_ERRORS[detail]) return KNOWN_ERRORS[detail];
	return operation === 'move'
		? 'メールを移動できませんでした。'
		: 'フォルダを更新できませんでした。';
}
