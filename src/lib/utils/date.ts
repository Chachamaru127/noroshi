const JA_LOCALE = 'ja-JP';

export function formatRelativeDate(value: string): string {
	const date = new Date(value);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMins < 1) return 'たった今';
	if (diffMins < 60) return `${diffMins}分前`;
	if (diffHours < 24 && date.getDate() === now.getDate()) {
		return date.toLocaleTimeString(JA_LOCALE, { hour: 'numeric', minute: '2-digit' });
	}
	if (diffDays < 7) {
		return date.toLocaleDateString(JA_LOCALE, { weekday: 'short' });
	}
	return date.toLocaleDateString(JA_LOCALE, { month: 'short', day: 'numeric' });
}

export function formatFullDate(value: string): string {
	return new Date(value).toLocaleString(JA_LOCALE, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}
