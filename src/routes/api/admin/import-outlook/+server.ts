import { json, type RequestHandler } from '@sveltejs/kit';
import {
	importOutlookEml,
	MAX_HISTORICAL_EML_BYTES,
	type OutlookImportDirection
} from '$lib/server/outlook-import';
import {
	MAX_EML_MULTIPART_BYTES,
	requireBoundedContentLength,
	RequestBodyError,
	safeRuntimeErrorCode
} from '$lib/server/request-security';

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	if (!locals.user?.is_admin || locals.authMethod !== 'session') {
		return json({ error: '管理者としてブラウザからログインしてください。' }, { status: 403 });
	}
	if (!platform?.env.DB || !platform.env.ATTACHMENTS) {
		return json({ error: '保存先を利用できません。' }, { status: 503 });
	}

	try {
		requireBoundedContentLength(request, MAX_EML_MULTIPART_BYTES);
	} catch (error) {
		if (error instanceof RequestBodyError) {
			return json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
	const form = await request.formData();
	const file = form.get('file');
	const direction = form.get('direction');
	const mailboxAddress = String(form.get('mailboxAddress') ?? '')
		.trim()
		.toLowerCase();
	if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.eml')) {
		return json({ error: 'EMLファイルを選択してください。' }, { status: 400 });
	}
	if (file.size === 0 || file.size > MAX_HISTORICAL_EML_BYTES) {
		return json({ error: 'EMLファイルのサイズ上限を超えています。' }, { status: 413 });
	}
	if (direction !== 'inbound' && direction !== 'outbound') {
		return json({ error: '受信または送信済みを選択してください。' }, { status: 400 });
	}

	const address = locals.addresses.find(
		(entry) => entry.user_id === locals.user!.id && entry.address.toLowerCase() === mailboxAddress
	);
	if (!address) {
		return json({ error: 'このアカウントのメールアドレスを選択してください。' }, { status: 400 });
	}

	try {
		const result = await importOutlookEml(
			{ DB: platform.env.DB, ATTACHMENTS: platform.env.ATTACHMENTS },
			{
				userId: locals.user.id,
				domainId: address.domain_id,
				mailboxAddress: address.address,
				direction: direction as OutlookImportDirection,
				raw: await file.arrayBuffer()
			}
		);
		return json(result);
	} catch (error) {
		console.error('Historical Outlook import failed', { code: safeRuntimeErrorCode(error) });
		return json({ error: 'このメールを取り込めませんでした。' }, { status: 422 });
	}
};
