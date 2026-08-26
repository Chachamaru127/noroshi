/**
 * Stable key for literal mail sorting comparisons.
 *
 * SQLite/D1 lower() only folds ASCII, while lowercasing a whole JavaScript
 * string is context-sensitive (Greek Σ becomes final ς at a word end). Fold
 * each Unicode code point independently through the runtime's Unicode
 * upper/lower tables, with the Default Case Folding expansions that cannot be
 * recovered that way. NFKC on both sides also aligns composed accents and
 * compatibility-width characters.
 *
 * This is locale-independent: I/i compare equal, while dotted İ and dotless ı
 * remain distinct, matching Unicode default rather than Turkish locale rules.
 */
export function normalizeMailSortKey(value: string): string {
	let result = '';
	for (const character of value.normalize('NFKC')) {
		switch (character) {
			case '\u00df': // LATIN SMALL LETTER SHARP S
			case '\u1e9e': // LATIN CAPITAL LETTER SHARP S
				result += 'ss';
				break;
			case '\u0130': // LATIN CAPITAL LETTER I WITH DOT ABOVE
				result += 'i\u0307';
				break;
			case '\u0131': // LATIN SMALL LETTER DOTLESS I
				result += '\u0131';
				break;
			default:
				result += character.toUpperCase().toLowerCase();
		}
	}
	return result.normalize('NFKC');
}
