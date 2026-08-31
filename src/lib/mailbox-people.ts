import type { MailboxView, ThreadSummary } from './types';

export type MailboxPeopleView = MailboxView | 'folder';

/**
 * Render the participant data the current list API actually supplies.
 *
 * Sent-only rows can contain only the sender identity until the server has
 * reconstructed recipients. Keep the established local-part fallback instead
 * of hiding the row or inventing an external display name.
 */
export function mailboxPeople(thread: ThreadSummary, view: MailboxPeopleView): string {
	if (view === 'drafts' || (view === 'sent' && thread.participants.every((item) => item.self))) {
		return legacyRecipient(thread) || (view === 'drafts' ? '宛先なし' : '不明');
	}

	const names = thread.participants
		.map((participant) => (participant.self ? '自分' : participant.label || participant.address))
		.filter(Boolean)
		.join(', ');
	return names || '不明';
}

export function mailboxInitial(thread: ThreadSummary): string {
	const external = thread.participants.find((participant) => !participant.self);
	const participant = external ?? thread.participants[0];
	return (participant?.label || participant?.address || '?')[0].toUpperCase();
}

function legacyRecipient(thread: ThreadSummary): string {
	const [first] = thread.participants;
	return first?.address ? first.address.split('@')[0].replace(/[._-]+/g, ' ') : '';
}
