export function displayMailSubject(subject: unknown): string {
	if (typeof subject !== 'string') return '（件名なし）';

	const value = subject.trim();
	return value && value !== '(no subject)' ? value : '（件名なし）';
}
