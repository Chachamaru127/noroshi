// Five 5 MiB attachments expand by 4/3 in JSON base64. Keep bounded headroom
// for message fields without rejecting the documented attachment limit.
// Keep decoded JSON comfortably below the Workers 128 MiB ceiling even while
// parsing creates a second object graph. Larger attachment sets use multipart.
export const MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_SMALL_JSON_BYTES = 64 * 1024;
export const MAX_DRAFT_JSON_BYTES = 512 * 1024;
export const MAX_EML_MULTIPART_BYTES = 51 * 1024 * 1024;
export const MAX_MAIL_MULTIPART_BYTES = 27 * 1024 * 1024;
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class RequestBodyError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 411 | 413
	) {
		super(message);
		this.name = 'RequestBodyError';
	}
}

export function rejectCrossOriginMutation(request: Request, url: URL): boolean {
	if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
	if (url.pathname.startsWith('/api/webhooks/')) return false;
	if (/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) return false;
	return request.headers.get('origin') !== url.origin;
}

export function applySecurityHeaders(response: Response, url: URL): Response {
	const headers = response.headers;
	headers.set(
		'Content-Security-Policy',
		"default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
	);
	headers.set('X-Frame-Options', 'DENY');
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
	headers.set('X-Content-Type-Options', 'nosniff');
	if (url.protocol === 'https:') {
		headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	return response;
}

export function requireBoundedContentLength(request: Request, maximum: number): number {
	const raw = request.headers.get('content-length');
	if (!raw) throw new RequestBodyError('Content-Length is required', 411);
	const length = Number(raw);
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new RequestBodyError('Invalid Content-Length', 400);
	}
	if (length > maximum) throw new RequestBodyError('Request body is too large', 413);
	return length;
}

export async function readJsonBody<T>(
	request: Request,
	maximum = MAX_JSON_REQUEST_BYTES
): Promise<T> {
	const declared = request.headers.get('content-length');
	if (declared && Number(declared) > maximum)
		throw new RequestBodyError('Request body is too large', 413);
	if (!request.body) throw new RequestBodyError('Request body is required', 400);

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximum) {
			await reader.cancel();
			throw new RequestBodyError('Request body is too large', 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch {
		throw new RequestBodyError('Invalid JSON body', 400);
	}
}

export async function readTextBody(request: Request, maximum: number): Promise<string> {
	const declared = request.headers.get('content-length');
	if (declared && Number(declared) > maximum)
		throw new RequestBodyError('Request body is too large', 413);
	if (!request.body) throw new RequestBodyError('Request body is required', 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximum) {
			await reader.cancel();
			throw new RequestBodyError('Request body is too large', 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export function safeRuntimeErrorCode(error: unknown): string {
	if (error instanceof RequestBodyError) return `request_${error.status}`;
	if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) {
		return error.name.toLowerCase();
	}
	return 'unknown_error';
}
