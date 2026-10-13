import {
	createLocalResendClient,
	isDomainReceivable,
	isDomainSendable,
	ResendError,
	type ResendClient,
	type ResendDomain
} from '../resend';
import type { EmailProvider, ProviderDomain } from '../email-provider';
import { parseMailDomains, ProviderError } from '../email-provider';
import type { OutboundMailInput, OutboundMailResult } from '../send-mail';

export function createResendProvider(
	apiKey: string,
	cloudflareInboundDomains?: string,
	resendSendDomains?: string,
	apiBase?: string
): EmailProvider {
	const client = createLocalResendClient(apiKey, apiBase);
	const usesCloudflareInbound = cloudflareInboundDomains !== undefined;
	const inboundDomains = new Set(parseMailDomains(cloudflareInboundDomains));
	const configuredSendDomains = parseMailDomains(resendSendDomains);
	const sendDomains = new Set(configuredSendDomains);
	const configuredDomains = [...inboundDomains].map((name) => ({
		id: name,
		name,
		status: sendDomains.has(name) ? 'verified' : 'inbound_configured',
		region: null,
		sendingEnabled: sendDomains.has(name),
		receivingEnabled: true
	}));
	const withInboundCapability = (domain: ProviderDomain): ProviderDomain => ({
		...domain,
		receivingEnabled: usesCloudflareInbound
			? inboundDomains.has(domain.name.toLowerCase())
			: domain.receivingEnabled
	});

	return {
		kind: 'resend',
		async send(input: OutboundMailInput): Promise<OutboundMailResult> {
			const senderDomain = parseMailDomains(input.from.domain_name)[0];
			if (!senderDomain || !sendDomains.has(senderDomain)) {
				throw new ProviderError(503, 'send_domain_not_configured', 'Resend sending is not configured for this domain');
			}
			try {
				const result = await client.send(
					{
						from: `${input.senderName} <${input.from.address}>`,
						to: input.to,
						...(input.cc?.length ? { cc: input.cc } : {}),
						...(input.bcc?.length ? { bcc: input.bcc } : {}),
						reply_to: input.replyTo ?? input.from.address,
						subject: input.subject,
						text: input.text,
						html: input.html,
						...(input.headers && Object.keys(input.headers).length
							? { headers: input.headers }
							: {}),
						...(input.attachments?.length
							? {
									attachments: input.attachments.map((file) => ({
										filename: file.filename,
										content: file.content,
										content_type: file.type
									}))
								}
							: {})
					},
					input.idempotencyKey
				);

				return { providerId: result.id };
			} catch (error) {
				throw wrapResendError(error);
			}
		},
		async listDomains(): Promise<ProviderDomain[]> {
			if (usesCloudflareInbound) return configuredDomains;
			try {
				const remote = await client.listDomains();
				return remote.map((domain) => withInboundCapability(toProviderDomain(domain)));
			} catch (error) {
				throw wrapResendError(error);
			}
		},
		async getDomain(id: string): Promise<ProviderDomain> {
			if (usesCloudflareInbound) {
				const configured = configuredDomains.find((domain) => domain.id === id);
				if (configured) return configured;
				throw new ProviderError(404, 'domain_not_configured', `${id} is not configured`);
			}
			try {
				return withInboundCapability(toProviderDomain(await client.getDomain(id)));
			} catch (error) {
				throw wrapResendError(error);
			}
		}
	};
}

/** Webhook ingest still needs the receiving endpoints on the raw client. */
export function getResendReceivingClient(apiKey: string, apiBase?: string): ResendClient {
	return createLocalResendClient(apiKey, apiBase);
}

function toProviderDomain(domain: ResendDomain): ProviderDomain {
	return {
		id: domain.id,
		name: domain.name,
		status: domain.status,
		region: domain.region ?? null,
		sendingEnabled: isDomainSendable(domain),
		receivingEnabled: isDomainReceivable(domain)
	};
}

function wrapResendError(error: unknown): ProviderError {
	if (error instanceof ProviderError) return error;
	if (error instanceof ResendError) {
		return new ProviderError(error.status, error.code, error.message);
	}
	return new ProviderError(
		502,
		'resend_error',
		error instanceof Error ? error.message : 'Resend request failed'
	);
}
