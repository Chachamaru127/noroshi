import { hashToken } from './crypto';

export const FORWARDING_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FORWARDING_DESTINATION_LENGTH = 254;

export type ForwardingDestinationStatus = 'pending' | 'verified';
export type ForwardingRuleStatus = 'disabled' | 'enabled';
export type ForwardingAttemptStatus = 'queued' | 'processing' | 'sent' | 'failed';

export class ForwardingValidationError extends Error {
	constructor(message = 'Enter a valid external email address') {
		super(message);
		this.name = 'ForwardingValidationError';
	}
}

export class ForwardingStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ForwardingStateError';
	}
}

export type ForwardingVerificationErrorCode = 'invalid' | 'expired' | 'used';

export class ForwardingVerificationError extends Error {
	readonly code: ForwardingVerificationErrorCode;

	constructor(code: ForwardingVerificationErrorCode) {
		super(
			code === 'expired'
				? 'Verification token expired'
				: code === 'used'
					? 'Verification token already used'
					: 'Invalid verification token'
		);
		this.name = 'ForwardingVerificationError';
		this.code = code;
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createVerificationToken(now = Date.now()): Promise<{
	token: string;
	tokenHash: string;
	createdAt: number;
	expiresAt: number;
}> {
	const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	return {
		token,
		tokenHash: await hashToken(token),
		createdAt: now,
		expiresAt: now + FORWARDING_VERIFICATION_TTL_MS
	};
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Normalize and validate an external destination without accepting header syntax. */
export function normalizeForwardingDestination(value: unknown): string {
	if (typeof value !== 'string') throw new ForwardingValidationError();
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new ForwardingValidationError();
	const normalized = value.trim().toLowerCase();
	if (!normalized || normalized.length > MAX_FORWARDING_DESTINATION_LENGTH) {
		throw new ForwardingValidationError();
	}

	const at = normalized.indexOf('@');
	if (at <= 0 || at !== normalized.lastIndexOf('@')) throw new ForwardingValidationError();

	const local = normalized.slice(0, at);
	const domain = normalized.slice(at + 1);
	if (
		local.length > 64 ||
		local.startsWith('.') ||
		local.endsWith('.') ||
		local.includes('..') ||
		!LOCAL_PART.test(local)
	) {
		throw new ForwardingValidationError();
	}

	const labels = domain.split('.');
	if (
		labels.length < 2 ||
		domain.length > 253 ||
		labels.some((label) => label.length === 0 || label.length > 63 || !DOMAIN_LABEL.test(label))
	) {
		throw new ForwardingValidationError();
	}

	return normalized;
}
