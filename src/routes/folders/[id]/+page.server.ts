import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listFolders } from '$lib/server/folders';
import { listMailbox } from '$lib/server/mail-store';
import { readFilters } from '$lib/server/mailbox';

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	if (!locals.user || !platform?.env.DB) throw error(401, 'ログインが必要です。');

	const folder = (await listFolders(platform.env.DB, locals.user.id, locals.activeDomainId)).find(
		(entry) => entry.id === params.id
	);
	if (!folder) throw error(404, 'フォルダが見つかりません。');

	const filters = readFilters(url);
	const mailbox = await listMailbox(platform.env.DB, locals.user.id, {
		view: 'folder',
		folderId: folder.id,
		domainId: locals.activeDomainId,
		q: filters.q,
		unreadOnly: filters.unreadOnly,
		starredOnly: filters.starredOnly,
		attachmentsOnly: filters.attachmentsOnly,
		page: Number(url.searchParams.get('page')) || 1
	});

	return { view: 'folder' as const, folder, mailbox, filters };
};
