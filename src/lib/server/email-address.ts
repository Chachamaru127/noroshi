export type EmailIdentity = {
	name: string | null;
	address: string;
};

/** Parse one RFC-style mailbox without treating its display name as identity. */
export function parseEmailIdentity(value: string): EmailIdentity {
	const trimmed = value.trim();
	const bracketMatch = trimmed.match(/^(.*?)<([^>]+)>$/);
	const address = parseEmailAddress(bracketMatch?.[2] ?? trimmed);
	if (!isUsableEmailAddress(address)) return { name: null, address };
	if (!bracketMatch) return { name: null, address };

	const rawName = bracketMatch[1].trim();
	const name =
		rawName.startsWith('"') && rawName.endsWith('"')
			? rawName.slice(1, -1).replace(/\\(.)/g, '$1').trim()
			: rawName;
	return { name: name || null, address };
}

export function parseEmailAddress(value: string): string {
	const trimmed = value.trim();
	const bracketMatch = trimmed.match(/<([^>]+)>/);
	if (bracketMatch) {
		return bracketMatch[1].toLowerCase().trim();
	}

	const emailMatch = trimmed.match(/[^\s<>]+@[^\s<>]+/);
	return (emailMatch?.[0] ?? trimmed).toLowerCase().trim();
}

export function isUsableEmailAddress(value: string): boolean {
	if (/[\s\u0000-\u001f\u007f]/u.test(value)) return false;
	const separator = value.indexOf('@');
	return separator > 0 && separator === value.lastIndexOf('@') && separator < value.length - 1;
}

export function parseEmailAddresses(
	value: string | string[] | null | undefined
): string[] {
	if (!value) return [];

	const parts = Array.isArray(value) ? value : value.split(',');
	const addresses = new Set<string>();

	for (const part of parts) {
		const parsed = parseEmailAddress(part);
		if (parsed.includes('@')) {
			addresses.add(parsed);
		}
	}

	return [...addresses];
}

export function domainOf(address: string): string | null {
	const parsed = parseEmailAddress(address);
	const domain = parsed.split('@')[1];
	return domain || null;
}

/**
 * Every address an inbound Resend message could have been destined for.
 *
 * `received_for` is the address Resend actually accepted mail for (it survives
 * forwarding), so it is checked before the visible To/Cc headers.
 */
export function collectInboundRecipients(payload: {
	received_for?: string[] | null;
	to?: string[] | string | null;
	cc?: string[] | string | null;
	bcc?: string[] | string | null;
}): string[] {
	const recipients = new Set<string>();

	for (const source of [payload.received_for, payload.to, payload.cc, payload.bcc]) {
		for (const address of parseEmailAddresses(source ?? null)) {
			recipients.add(address);
		}
	}

	return [...recipients];
}
