export function htmlToPlainText(html: string): string {
	const withLineBreaks = html
		.replace(/<br\s*\/?>[ \t]*\r?\n?/gi, '\n')
		.replace(/(<\/(?:blockquote|div|h[1-6]|li|p|pre|section|tr)>)[ \t]*\r?\n?/gi, '$1\n');
	const text =
		typeof DOMParser === 'undefined'
			? stripMarkup(withLineBreaks)
			: (new DOMParser().parseFromString(withLineBreaks, 'text/html').body.textContent ?? '');
	return text.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decode tags and whitespace entities when DOMParser is unavailable (SSR). */
function stripMarkup(html: string): string {
	const namedEntities: Record<string, string> = {
		amp: '&',
		apos: "'",
		gt: '>',
		lt: '<',
		nbsp: ' ',
		quot: '"'
	};
	return html
		.replace(/<[^>]+>/g, '')
		.replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (_match, name: string) => namedEntities[name.toLowerCase()])
		.replace(/&#(x)?([0-9a-f]+);/gi, (_match, hex: string | undefined, value: string) => {
			const code = Number.parseInt(value, hex ? 16 : 10);
			return Number.isNaN(code) ? '' : String.fromCharCode(code);
		});
}

export function isHtmlEmpty(html: string): boolean {
	if (!html.trim()) return true;
	if (html.includes('<img')) return false;
	// Derived emptiness is evaluated during SSR, where DOMParser is unavailable.
	if (typeof DOMParser === 'undefined') {
		return !stripMarkup(html).trim();
	}
	return !htmlToPlainText(html);
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
