import { json, type RequestHandler } from '@sveltejs/kit';
import {
	MAX_SMALL_JSON_BYTES,
	readEndpointJsonBody,
	withRequestBodyErrors
} from '$lib/server/request-security';
import {
	describeProviderError,
	getEmailProvider,
	statusForProviderError
} from '$lib/server/context';
import {
	createOrResetForwardingDestination,
	ForwardingStateError,
	ForwardingValidationError,
	forwardingVerificationIdempotencyKey,
	getForwardingRuleForUser,
	setForwardingRuleEnabled
} from '$lib/server/forwarding';
import { buildHtmlEmail, escapeHtml } from '$lib/server/send-mail';

type RuleBody = {
	enabled?: unknown;
	destination?: unknown;
};

function verificationMessage(input: {
	origin: string;
	token: string;
	destination: string;
	source: string;
}) {
	const link = new URL('/api/forwarding/verify', input.origin);
	link.searchParams.set('token', input.token);
	const text = [
		'QuickMail-ja 自動転送先の確認',
		'',
		`転送元: ${input.source}`,
		`転送先: ${input.destination}`,
		'',
		`確認リンク: ${link.toString()}`,
		'',
		'このリンクの有効期限は24時間で、1回だけ使用できます。'
	].join('\n');
	const html = buildHtmlEmail(
		`<p>QuickMail-jaの自動転送先を確認してください。</p>` +
			`<p>転送元: <strong>${escapeHtml(input.source)}</strong><br>` +
			`転送先: <strong>${escapeHtml(input.destination)}</strong></p>` +
			`<p><a href="${escapeHtml(link.toString())}">転送先を確認する</a></p>` +
			`<p>このリンクの有効期限は24時間で、1回だけ使用できます。</p>`
	);
	return { text, html };
}

const patch: RequestHandler = async ({ params, request, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const ruleId = params.id;
	if (!ruleId) return json({ error: 'Rule not found' }, { status: 404 });
	const body = (await readEndpointJsonBody(request, MAX_SMALL_JSON_BYTES)) as RuleBody;
	if (!body || (body.enabled === undefined && body.destination === undefined)) {
		return json({ error: 'Enabled or destination is required' }, { status: 400 });
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		return json({ error: 'Enabled must be a boolean' }, { status: 400 });
	}

	try {
		if (body.destination !== undefined) {
			if (typeof body.destination !== 'string') {
				return json({ error: 'Destination must be an email address' }, { status: 400 });
			}
			const current = await getForwardingRuleForUser(db, locals.user.id, ruleId);
			if (!current) return json({ error: 'Rule not found' }, { status: 404 });
			const result = await createOrResetForwardingDestination(db, locals.user.id, {
				sourceAddressId: current.source_address_id,
				destination: body.destination
			});

			if (result.verificationToken) {
				try {
					const provider = getEmailProvider(platform);
					const link = new URL('/api/forwarding/verify', url.origin);
					link.searchParams.set('token', result.verificationToken);
					const message = verificationMessage({
						origin: url.origin,
						token: result.verificationToken,
						destination: result.destination.destination_address,
						source: result.sourceAddress.address
					});
					await provider.send({
						from: result.sourceAddress,
						senderName: locals.user.name,
						to: [result.destination.destination_address],
						subject: '【QuickMail-ja】自動転送先を確認してください',
						text: message.text,
						html: message.html,
						idempotencyKey: forwardingVerificationIdempotencyKey(
							result.destination.id,
							result.verificationTokenHash!
						)
					});
				} catch (error) {
					return json(
						{ error: describeProviderError(error, 'Could not send verification email') },
						{ status: statusForProviderError(error) }
					);
				}
			}

			let rule = result.rule;
			if (body.enabled !== undefined) {
				const updated = await setForwardingRuleEnabled(db, locals.user.id, rule.id, body.enabled);
				if (!updated) return json({ error: 'Rule not found' }, { status: 404 });
				rule = updated;
			}

			return json({
				ok: true,
				verification_sent: Boolean(result.verificationToken),
				destination: result.destination,
				rule
			});
		}

		if (typeof body.enabled !== 'boolean') {
			return json({ error: 'Enabled must be a boolean' }, { status: 400 });
		}
		const rule = await setForwardingRuleEnabled(db, locals.user.id, ruleId, body.enabled);
		if (!rule) return json({ error: 'Rule not found' }, { status: 404 });
		return json({ ok: true, rule });
	} catch (error) {
		if (error instanceof ForwardingValidationError || error instanceof ForwardingStateError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: 'Could not update forwarding rule' }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	try {
		const rule = await setForwardingRuleEnabled(db, locals.user.id, params.id!, false);
		if (!rule) return json({ error: 'Rule not found' }, { status: 404 });
		return json({ ok: true, rule });
	} catch {
		return json({ error: 'Could not disable forwarding rule' }, { status: 400 });
	}
};

export const PATCH = withRequestBodyErrors(patch);
