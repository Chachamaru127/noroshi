<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import RichTextEditor from '$lib/components/RichTextEditor.svelte';
	import AttachmentPicker from '$lib/components/AttachmentPicker.svelte';
	import ThreadMessage from '$lib/components/ThreadMessage.svelte';
	import FolderMoveMenu from '$lib/components/FolderMoveMenu.svelte';
	import { displayMailSubject } from '$lib/mail-ui-copy';
	import { translateMailError } from '$lib/mail-ui-errors';
	import { htmlToPlainText, isHtmlEmpty } from '$lib/utils/html';
	import { hasInAppHistory, requestSkipViewTransition } from '$lib/app-chrome';
	import type { OutboundAttachmentInput } from '$lib/types';
	import { mailMultipartBody } from '$lib/utils/attachments';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let replyHtml = $state('');
	let replyAttachments = $state<OutboundAttachmentInput[]>([]);
	let replyOpen = $state(false);
	let sending = $state(false);
	let error = $state('');

	const messages = $derived(data.messages);
	const displayedSubject = $derived(displayMailSubject(data.subject));
	const latest = $derived(messages[messages.length - 1]);
	const starred = $derived(messages.some((message) => message.is_starred));

	const backHref = $derived(data.backHref);

	/**
	 * Which messages are open: the newest one, whichever message was linked to,
	 * and anything the reader clicks.
	 */
	let opened = $state(new Set<string>());

	$effect(() => {
		const initial = new Set<string>();
		if (data.focusId) initial.add(data.focusId);
		const last = data.messages[data.messages.length - 1];
		if (last) initial.add(last.id);
		opened = initial;
	});

	function toggleMessage(id: string) {
		const next = new Set(opened);
		if (next.has(id) && next.size > 1) next.delete(id);
		else next.add(id);
		opened = next;
	}

	function expandAll() {
		opened = new Set(messages.map((message) => message.id));
	}

	const collapsedCount = $derived(messages.filter((message) => !opened.has(message.id)).length);

	/** Flags apply to the conversation, not to the message that opened it. */
	async function patch(body: Record<string, boolean>) {
		if (!latest) return;
		await fetch(`/api/mail/${latest.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	async function toggleStar() {
		await patch({ isStarred: !starred });
		await invalidateAll();
	}

	async function markUnread() {
		await patch({ isRead: false });
		goto(backHref);
	}

	async function trash() {
		await patch({ trashed: true });
		goto(backHref);
	}

	async function restore() {
		await patch({ trashed: false });
		goto(data.restoreHref);
	}

	function goBack() {
		requestSkipViewTransition();
		if (data.useHistoryBack && hasInAppHistory()) {
			history.back();
			return;
		}
		void goto(backHref);
	}

	async function destroy() {
		if (!latest) return;
		await fetch(`/api/mail/${latest.id}`, { method: 'DELETE' });
		goto('/trash');
	}

	/** Replies continue from the newest message, so the chain stays intact. */
	async function sendReply(event: SubmitEvent) {
		event.preventDefault();
		if (!latest || isHtmlEmpty(replyHtml)) return;

		sending = true;
		error = '';

		try {
			const res = await fetch(`/api/mail/${latest.id}`, {
				method: 'POST',
				body: mailMultipartBody(
					{ html: replyHtml, text: htmlToPlainText(replyHtml) },
					replyAttachments
				)
			});
			const body = await res.json();
			if (!res.ok) {
				error = translateMailError(body.error, 'reply');
				return;
			}

			replyHtml = '';
			replyAttachments = [];
			replyOpen = false;
			// The sent reply is now part of this conversation.
			await invalidateAll();
		} catch {
			error = '通信エラーが発生しました';
		} finally {
			sending = false;
		}
	}
</script>

<svelte:head>
	<title>{displayedSubject} — Noroshi</title>
</svelte:head>

<div class="mail-page">
	<header class="mail-toolbar">
		<a
			href={backHref}
			class="btn-ghost back-btn"
			aria-label="戻る"
			onclick={(event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
				event.preventDefault();
				goBack();
			}}
		>
			<Icon name="arrow-left-line" size={18} />
		</a>

		<div class="toolbar-actions">
			{#if latest && !data.trashed}
				<FolderMoveMenu
					folders={data.folders}
					ids={[latest.id]}
					currentFolderId={data.assignedFolderId ?? undefined}
					compact={false}
					onMoved={(destinationId) =>
						goto(destinationId ? `/folders/${destinationId}` : data.unfiledHref)}
				/>
			{/if}
			<button
				type="button"
				class="icon-btn"
				class:starred
				aria-label={starred ? 'スターを外す' : 'スターを付ける'}
				onclick={toggleStar}
			>
				<Icon name={starred ? 'star-fill' : 'star-line'} size={16} />
			</button>

			{#if data.trashed}
				<button type="button" class="icon-btn" aria-label="復元" onclick={restore}>
					<Icon name="arrow-go-back-line" size={16} />
				</button>
				<button type="button" class="icon-btn danger" aria-label="完全に削除" onclick={destroy}>
					<Icon name="delete-bin-2-line" size={16} />
				</button>
			{:else}
				<button type="button" class="icon-btn" aria-label="未読にする" onclick={markUnread}>
					<Icon name="mail-line" size={16} />
				</button>
				<button type="button" class="icon-btn" aria-label="ゴミ箱へ移動" onclick={trash}>
					<Icon name="delete-bin-line" size={16} />
				</button>
			{/if}

			<button
				type="button"
				class="btn-primary reply-launch"
				disabled={!data.replyFrom}
				title={!data.replyFrom ? 'このアドレスは受信専用です' : undefined}
				onclick={() => (replyOpen = !replyOpen)}
			>
				<Icon name="reply-line" size={16} />
				{data.replyFrom ? (replyOpen ? '閉じる' : '返信') : '受信専用'}
			</button>
		</div>
	</header>

	<article class="surface-lg mail-card">
		<div class="subject-row">
			<h1>{displayedSubject}</h1>
			{#if messages.length > 1}
				<span class="thread-count">{messages.length}件のメール</span>
			{/if}
		</div>

		{#if collapsedCount > 0}
			<button type="button" class="expand-all" onclick={expandAll}>
				すべてのメール（{messages.length}件）を展開
			</button>
		{/if}

		<div class="thread">
			{#each messages as message (message.id)}
				<ThreadMessage
					{message}
					expanded={opened.has(message.id)}
					onToggle={() => toggleMessage(message.id)}
				/>
			{/each}
		</div>
	</article>

	{#if replyOpen}
		<form class="reply-section" onsubmit={sendReply}>
			<p class="reply-to">
				返信先:
				<strong>
					{latest?.direction === 'inbound' ? latest.from_addr : latest?.to_addr}
				</strong>
			</p>
			{#if data.replyFrom}
				<p class="reply-from">
					差出人:
					<strong>
						{#if data.replyFromName}{data.replyFromName} ·
						{/if}{data.replyFrom}
					</strong>
				</p>
			{/if}

			<RichTextEditor bind:html={replyHtml} embedded minHeight={160} placeholder="返信を入力…" />

			<div class="reply-footer">
				<AttachmentPicker bind:attachments={replyAttachments} />
				<div class="reply-actions">
					<button type="button" class="btn-ghost" onclick={() => (replyOpen = false)}>
						キャンセル
					</button>
					<button type="submit" class="btn-primary" disabled={sending || !data.replyFrom}>
						<Icon name="send-plane-2-fill" size={16} />
						{sending ? '送信中…' : '送信'}
					</button>
				</div>
			</div>

			{#if error}
				<p class="reply-status">{error}</p>
			{/if}
		</form>
	{:else}
		<button
			type="button"
			class="reply-prompt"
			disabled={!data.replyFrom}
			title={!data.replyFrom ? 'このアドレスは受信専用です' : undefined}
			onclick={() => (replyOpen = true)}
		>
			<Icon name="reply-line" size={15} />
			{data.replyFrom ? '返信' : '返信できません（受信専用）'}
		</button>
	{/if}
</div>

<style>
	.mail-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.toolbar-actions :global(.icon-btn.starred) {
		color: var(--color-star);
	}

	.toolbar-actions :global(.icon-btn.danger:hover) {
		color: var(--color-danger);
	}

	.mail-card {
		padding: 1.75rem;
	}

	.mail-card h1 {
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.35;
	}

	.subject-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 1rem;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.thread-count {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.expand-all {
		margin-top: 0.875rem;
		font-size: 0.75rem;
		color: var(--color-muted);
		text-decoration: underline;
	}

	.expand-all:hover {
		color: var(--color-text);
	}

	.reply-section {
		margin-top: 1rem;
		padding: 1.75rem;
		background: var(--color-surface);
		border-radius: 1.25rem;
		box-shadow: var(--shadow-sm);
	}

	.reply-to,
	.reply-from {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}

	.reply-from {
		margin: 0.25rem 0 0.625rem;
	}

	.reply-to strong,
	.reply-from strong {
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.reply-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.75rem;
		flex-wrap: wrap;
	}

	.reply-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.reply-status {
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	.back-btn {
		flex-shrink: 0;
	}

	/* Dormant reply box at the foot of the thread; opens the composer. */
	.reply-prompt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin-top: 1rem;
		padding: 0.75rem 1.75rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: background 0.15s;
	}

	.reply-prompt:hover {
		background: var(--color-surface-muted);
	}

	@media (max-width: 900px) {
		.mail-page {
			display: flex;
			flex-direction: column;
			flex: 1;
			width: 100%;
			min-height: 0;
			height: 100%;
			background: var(--color-surface);
		}

		.mail-toolbar {
			position: sticky;
			top: 0;
			z-index: 20;
			min-height: calc(3.25rem + env(safe-area-inset-top));
			margin: 0;
			padding: env(safe-area-inset-top) 0.5rem 0.25rem;
			background: var(--color-surface);
			box-shadow: inset 0 -1px 0 var(--color-line);
		}

		.mail-toolbar .btn-primary {
			padding-left: 0.75rem;
			padding-right: 0.75rem;
		}

		.reply-launch {
			display: none;
		}

		.mail-card {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			overscroll-behavior: contain;
			margin: 0;
			padding: 1.25rem 1rem 1.5rem;
			border-radius: 0;
			box-shadow: none;
			background: var(--color-surface);
		}

		.mail-card h1 {
			font-size: 1.125rem;
		}

		.reply-prompt {
			flex-shrink: 0;
			z-index: 10;
			margin: 0;
			width: auto;
			border-radius: 0;
			padding: 0.875rem 1rem calc(0.875rem + env(safe-area-inset-bottom));
			background: var(--color-surface);
			box-shadow: inset 0 1px 0 var(--color-line);
		}

		.reply-section {
			flex-shrink: 0;
			z-index: 10;
			margin: 0;
			padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom));
			background: var(--color-surface);
			box-shadow: inset 0 1px 0 var(--color-line);
		}

		.reply-footer {
			flex-direction: column;
			align-items: stretch;
		}

		.reply-actions {
			margin-left: 0;
			width: 100%;
		}

		.reply-actions .btn-primary {
			flex: 1;
		}
	}
</style>
