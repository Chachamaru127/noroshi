import { MAX_ATTACHMENTS_PER_EMAIL } from '$lib/constants';

export function mailMultipartBody(
	payload: Record<string, unknown>,
	attachments: Array<{ filename: string; type: string; content: string }>
): FormData {
	const form = new FormData();
	form.set('payload', JSON.stringify(payload));
	for (const attachment of attachments) {
		const binary = atob(attachment.content);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		form.append('attachment', new Blob([bytes], { type: attachment.type }), attachment.filename);
	}
	return form;
}

export function remainingAttachmentSlots(uploadedCount: number, reservedCount = 0): number {
	return Math.max(0, MAX_ATTACHMENTS_PER_EMAIL - uploadedCount - reservedCount);
}

export function isImageType(contentType: string): boolean {
	return contentType.startsWith('image/');
}

export function isPreviewableInline(contentType: string): boolean {
	const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
	return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(normalized);
}

export function attachmentHref(emailId: string, attachmentId: string, download = false): string {
	const base = `/api/mail/${emailId}/attachments/${attachmentId}`;
	return download ? `${base}?download=1` : base;
}

export function attachmentIcon(contentType: string): string {
	if (isImageType(contentType)) return 'image-line';
	if (contentType === 'application/pdf') return 'file-pdf-line';
	if (contentType.startsWith('text/')) return 'file-text-line';
	if (contentType.includes('zip') || contentType.includes('compressed')) return 'file-zip-line';
	return 'file-3-line';
}
