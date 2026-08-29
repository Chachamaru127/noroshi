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
import { buildHtmlEmail, escapeHtml } from '$lib/server/send-mail';
import {
	createOrResetForwardingDestination,
	ForwardingValidationError,
	forwardingVerificationIdempotencyKey
} from '$lib/server/forwarding';

type DestinationBody = {
	sourceAddressId?: unknown;
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
	const escapedLink = escapeHtml(link.toString());
	const text = [
		'QuickMail-ja 自動転送先の確認',
		'',
		`転送元: ${input.source}`,
		`転送先: ${input.destination}`,
		'',
		'次のリンクを開いて転送先を確認してください:',
		link.toString(),
		'',
		'このリンクの有効期限は24時間で、1回だけ使用できます。'
	].join('\n');
	const html = buildHtmlEmail(
		`<p>QuickMail-jaの自動転送先を確認してください。</p>` +
			`<p>転送元: <strong>${escapeHtml(input.source)}</strong><br>` +
			`転送先: <strong>${escapeHtml(input.destination)}</strong></p>` +
			`<p><a href="${escapedLink}">転送先を確認する</a></p>` +
			`<p>このリンクの有効期限は24時間で、1回だけ使用できます。</p>`
	);
	return { text, html };
}

async function sendVerificationEmail(
	platform: App.Platform | undefined,
	input: {
		origin: string;
		token: string;
		destination: string;
		source: Awaited<ReturnType<typeof createOrResetForwardingDestination>>['sourceAddress'];
		userName: string;
		idempotencyKey: string;
	}
): Promise<void> {
	const provider = getEmailProvider(platform);
	const message = verificationMessage({
		origin: input.origin,
		token: input.token,
		destination: input.destination,
		source: input.source.address
	});

	await provider.send({
		from: input.source,
		senderName: input.userName,
		to: [input.destination],
		subject: '【QuickMail-ja】自動転送先を確認してください',
		text: message.text,
		html: message.html,
		idempotencyKey: input.idempotencyKey
	});
}

const post: RequestHandler = async ({ request, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await readEndpointJsonBody(request, MAX_SMALL_JSON_BYTES)) as DestinationBody;
	if (!body || typeof body.sourceAddressId !== 'string' || typeof body.destination !== 'string') {
		return json({ error: 'Source address and destination are required' }, { status: 400 });
	}

	try {
		const result = await createOrResetForwardingDestination(db, locals.user.id, {
			sourceAddressId: body.sourceAddressId,
			destination: body.destination
		});

		if (result.verificationToken) {
			try {
				await sendVerificationEmail(platform, {
					origin: url.origin,
					token: result.verificationToken,
					destination: result.destination.destination_address,
					source: result.sourceAddress,
					userName: locals.user.name,
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

		return json(
			{
				ok: true,
				verification_sent: Boolean(result.verificationToken),
				forwarding: {
					source_address: result.sourceAddress,
					destination: result.destination,
					rule: result.rule,
					latest_attempt: null
				}
			},
			{ status: result.created ? 201 : 200 }
		);
	} catch (error) {
		if (error instanceof ForwardingValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: 'Could not save forwarding destination' }, { status: 400 });
	}
};

export const POST = withRequestBodyErrors(post);
