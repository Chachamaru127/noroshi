<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import RichTextEditor from '$lib/components/RichTextEditor.svelte';
	import AttachmentPicker from '$lib/components/AttachmentPicker.svelte';
	import { translateMailError } from '$lib/mail-ui-errors';
	import { formatFileSize, htmlToPlainText, isHtmlEmpty } from '$lib/utils/html';
	import { requestSkipViewTransition } from '$lib/app-chrome';
	import type { OutboundAttachmentInput } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const addresses = $derived(data.addresses);
	const defaultAddressId = $derived(
		addresses.find((address) => address.is_default)?.id ?? addresses[0]?.id ?? ''
	);

	// Falls back to the default identity until the composer picks another.
	let chosenAddressId = $state('');
	const fromAddressId = $derived(chosenAddressId || defaultAddressId);

	// The draft seeds the form once; after that the fields own their values.
	const draft = untrack(() => data.draft);
	const forward = untrack(() => data.forward);
	const forwarding = Boolean(forward);

	let draftId = $state<string | null>(draft?.id ?? null);
	let to = $state(draft?.to_addr ?? '');
	let cc = $state(draft?.cc_addr ?? '');
	let bcc = $state(draft?.bcc_addr ?? '');
	let subject = $state(draft?.subject ?? forward?.subject ?? '');
	let html = $state(draft?.body_html ?? forward?.html ?? '');
	let attachments = $state<OutboundAttachmentInput[]>([]);
	let forwardedAttachments = $state(forward?.attachments ?? []);
	let showCopies = $state(Boolean(draft?.cc_addr || draft?.bcc_addr));
	let error = $state('');
	let sending = $state(false);
	let savingDraft = $state(false);
	let savedAt = $state('');

	const hasDraftText = $derived(Boolean(to.trim() || subject.trim() || !isHtmlEmpty(html)));
	const forwardedBytes = $derived(
		forwardedAttachments.reduce((total, attachment) => total + attachment.size_bytes, 0)
	);
	const title = $derived(draftId ? '下書き' : forwarding ? 'メールを転送' : '新規メール');

	async function saveDraft(): Promise<boolean> {
		if (savingDraft || !hasDraftText) return false;
		savingDraft = true;
		error = '';

		try {
			const res = await fetch('/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: draftId,
					fromAddressId,
					to,
					cc: cc.trim() || undefined,
					bcc: bcc.trim() || undefined,
					subject,
					html,
					text: isHtmlEmpty(html) ? '' : htmlToPlainText(html)
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = translateMailError(body.error, 'draft');
				return false;
			}
			draftId = body.id;
			savedAt = new Date().toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' });
			return true;
		} catch {
			error = '通信エラーが発生しました';
			return false;
		} finally {
			savingDraft = false;
		}
	}

	async function closeComposer() {
		if (forwarding) {
			requestSkipViewTransition();
			await goto(`/mail/${forward?.id}`);
			return;
		}
		if (hasDraftText && !(await saveDraft())) return;
		if (attachments.length > 0) {
			error = '添付ファイルは下書きに保存されません。メールを送信するか、先に添付を外してください。';
			return;
		}
		requestSkipViewTransition();
		await goto(draftId ? '/drafts' : '/inbox');
	}

	function removeForwardedAttachment(id: string) {
		forwardedAttachments = forwardedAttachments.filter((attachment) => attachment.id !== id);
	}

	async function discardDraft() {
		if (!draftId) {
			window.location.href = '/inbox';
			return;
		}
		await fetch(`/api/drafts/${draftId}`, { method: 'DELETE' });
		window.location.href = '/drafts';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (isHtmlEmpty(html)) {
			error = 'メール本文を入力してください';
			return;
		}

		sending = true;
		error = '';

		try {
			const res = await fetch('/api/mail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					draftId: draftId ?? undefined,
					fromAddressId,
					to,
					cc: cc.trim() || undefined,
					bcc: bcc.trim() || undefined,
					subject,
					html,
					text: htmlToPlainText(html),
					attachments,
					forwardOfId: forward?.id,
					forwardAttachmentIds: forward
						? forwardedAttachments.map((attachment) => attachment.id)
						: undefined
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = translateMailError(body.error, 'send');
				return;
			}
			window.location.href = '/sent';
		} catch {
			error = '通信エラーが発生しました';
		} finally {
			sending = false;
		}
	}
</script>

<svelte:head>
	<title>{forwarding ? '転送' : draftId ? '下書き' : '作成'} — QuickMail-ja</title>
</svelte:head>

<form class="compose-page" onsubmit={submit}>
	<header class="compose-mobile-bar">
		<button
			type="button"
			class="icon-btn"
			aria-label="閉じる"
			onpointerdown={(event) => event.stopPropagation()}
			onclick={closeComposer}
		>
			<Icon name="close-line" size={22} />
		</button>
		<div class="compose-heading">
			<h1 class="page-title">{title}</h1>
			{#if savedAt}<span class="saved">保存済み {savedAt}</span>{/if}
		</div>
		<button type="submit" class="btn-primary" disabled={sending}>
			{sending ? '送信中…' : '送信'}
		</button>
	</header>

	<header class="compose-header">
		<div class="compose-heading">
			<h1 class="page-title">{title}</h1>
			{#if savedAt}<span class="saved">保存済み {savedAt}</span>{/if}
		</div>

		<div class="compose-actions">
			<button
				type="button"
				class="btn-ghost"
				onclick={() => (showCopies = !showCopies)}
				aria-expanded={showCopies}
			>
				Cc / Bcc
			</button>
			{#if !forwarding}
				<button
					type="button"
					class="btn-ghost"
					disabled={savingDraft || !hasDraftText}
					onclick={saveDraft}
				>
					<Icon name="save-line" size={15} />
					{savingDraft ? '保存中…' : '下書きを保存'}
				</button>
			{/if}
			{#if draftId}
				<button type="button" class="btn-ghost" onclick={discardDraft} aria-label="下書きを破棄">
					<Icon name="delete-bin-line" size={15} />
				</button>
			{/if}
			<button type="submit" class="btn-primary" disabled={sending}>
				<Icon name="send-plane-2-fill" size={16} />
				{sending ? '送信中…' : '送信'}
			</button>
		</div>
	</header>

	<div class="surface compose-fields">
		<!-- With several domains connected, choosing the identity matters. -->
		<div class="field-row">
			<span class="field-label">差出人</span>
			{#if addresses.length > 1}
				<select
					value={fromAddressId}
					onchange={(event) => (chosenAddressId = event.currentTarget.value)}
					class="field-input"
					aria-label="差出人を選択"
				>
					{#each addresses as address (address.id)}
						<option value={address.id}>
							{address.label ? `${address.label} · ${address.address}` : address.address}
						</option>
					{/each}
				</select>
			{:else}
				<span class="field-static">
					{addresses[0]?.label
						? `${addresses[0].label} · ${addresses[0].address}`
						: (addresses[0]?.address ?? '—')}
				</span>
			{/if}
		</div>

		<div class="field-row">
			<label class="field-label" for="to">宛先</label>
			<input
				id="to"
				type="text"
				inputmode="email"
				autocomplete="email"
				bind:value={to}
				required
				placeholder="recipient@example.com"
				class="field-input"
			/>
			<button
				type="button"
				class="copies-toggle"
				onclick={() => (showCopies = !showCopies)}
				aria-expanded={showCopies}
			>
				Cc / Bcc
			</button>
		</div>

		{#if showCopies}
			<div class="field-row">
				<label class="field-label" for="cc">Cc</label>
				<input id="cc" type="text" bind:value={cc} placeholder="カンマ区切り" class="field-input" />
			</div>
			<div class="field-row">
				<label class="field-label" for="bcc">Bcc</label>
				<input id="bcc" type="text" bind:value={bcc} placeholder="カンマ区切り" class="field-input" />
			</div>
		{/if}

		<div class="field-row">
			<label class="field-label" for="subject">件名</label>
			<input
				id="subject"
				type="text"
				bind:value={subject}
				required
				placeholder="件名"
				class="field-input"
			/>
		</div>
	</div>

	{#if forwarding && forwardedAttachments.length > 0}
		<section class="forwarded-files" aria-labelledby="forwarded-attachments-heading">
			<div class="forwarded-files-heading">
				<h2 id="forwarded-attachments-heading">転送する添付ファイル</h2>
				<span>合計 {formatFileSize(forwardedBytes)}</span>
			</div>
			<ul>
				{#each forwardedAttachments as attachment (attachment.id)}
					<li>
						<Icon name="file-3-line" size={15} />
						<span class="forwarded-file-name">{attachment.filename}</span>
						<span class="forwarded-file-size">{formatFileSize(attachment.size_bytes)}</span>
						<button
							type="button"
							class="forwarded-file-remove"
							aria-label={`転送する添付ファイル「${attachment.filename}」を削除`}
							onclick={() => removeForwardedAttachment(attachment.id)}
						>
							<Icon name="close-line" size={16} />
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if attachments.length}
		<div class="compose-chips">
			<AttachmentPicker
				bind:attachments
				mode="chips"
				reservedCount={forwardedAttachments.length}
			/>
		</div>
	{/if}

	<div class="compose-editor">
		<RichTextEditor
			bind:html
			fill
			minHeight={160}
			placeholder={forwarding ? '転送するメールの上にメッセージを入力…' : 'メール本文を入力…'}
		>
			{#snippet toolbarEnd()}
				<AttachmentPicker
					bind:attachments
					mode="button"
					reservedCount={forwardedAttachments.length}
				/>
				{#if !forwarding}
					<button
						type="button"
						class="icon-btn"
						disabled={savingDraft || !hasDraftText}
						aria-label={savingDraft ? '保存中' : '下書きを保存'}
						onclick={saveDraft}
					>
						<Icon name="save-line" size={18} />
					</button>
				{/if}
				{#if draftId}
					<button
						type="button"
						class="icon-btn danger"
						aria-label="下書きを破棄"
						onclick={discardDraft}
					>
						<Icon name="delete-bin-line" size={18} />
					</button>
				{/if}
			{/snippet}
		</RichTextEditor>
	</div>

	{#if error}
		<p class="compose-error" role="alert">{error}</p>
	{/if}

	<div class="compose-desktop-foot">
		<AttachmentPicker bind:attachments reservedCount={forwardedAttachments.length} />
	</div>
</form>

<style>
	.compose-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
		flex-wrap: wrap;
	}

	.compose-heading {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
	}

	.saved {
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.compose-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.compose-fields {
		overflow: hidden;
	}

	.field-static {
		font-size: 0.9375rem;
		color: var(--color-text-secondary);
	}

	.copies-toggle {
		display: none;
	}

	.compose-editor {
		margin-top: 1rem;
	}

	.forwarded-files {
		margin-top: 1rem;
		padding: 0.875rem 1rem;
		border-radius: 1rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.forwarded-files-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.forwarded-files-heading h2 {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.forwarded-files ul {
		display: grid;
		gap: 0.25rem;
	}

	.forwarded-files li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--touch-target);
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.forwarded-file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.forwarded-file-size {
		flex-shrink: 0;
		color: var(--color-muted);
	}

	.forwarded-file-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: 0.75rem;
		color: var(--color-muted);
	}

	.forwarded-file-remove:hover,
	.forwarded-file-remove:focus-visible {
		color: var(--color-danger);
		background: var(--color-surface-hover);
	}

	.compose-error {
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	.compose-mobile-bar {
		display: none;
	}

	.compose-chips {
		display: none;
	}

	.compose-desktop-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	@media (max-width: 900px) {
		.compose-page {
			display: flex;
			flex-direction: column;
			flex: 1;
			width: 100%;
			min-width: 0;
			min-height: 0;
			height: 100%;
			background: var(--color-surface);
		}

		.compose-header {
			display: none;
		}

		.compose-mobile-bar {
			position: sticky;
			top: 0;
			z-index: 20;
			display: flex;
			align-items: center;
			gap: 0.375rem;
			flex-shrink: 0;
			min-height: calc(3.25rem + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 0.375rem 0.25rem;
			background: var(--color-surface);
			box-shadow: inset 0 -1px 0 var(--color-line);
		}

		.compose-mobile-bar .compose-heading {
			flex: 1;
			min-width: 0;
			flex-direction: column;
			align-items: center;
			gap: 0;
		}

		.compose-mobile-bar .page-title {
			font-size: 1.0625rem;
		}

		.compose-mobile-bar .btn-primary {
			min-width: 4.5rem;
		}

		.compose-fields {
			flex-shrink: 0;
			border-radius: 0;
			box-shadow: none;
			background: var(--color-surface);
		}

		.compose-fields :global(.field-row) {
			min-height: var(--touch-target);
			padding: 0 1rem;
		}

		.copies-toggle {
			display: flex;
			align-items: center;
			flex-shrink: 0;
			min-height: var(--touch-target);
			padding: 0 0.25rem 0 0.5rem;
			font-size: 0.8125rem;
			font-weight: 500;
			color: var(--color-accent-text);
		}

		.compose-editor {
			display: flex;
			flex: 1;
			flex-direction: column;
			min-height: 0;
			margin: 0;
		}

		.forwarded-files {
			flex-shrink: 0;
			margin: 0;
			padding: 0.5rem 1rem;
			border-radius: 0;
			box-shadow: inset 0 -1px 0 var(--color-line);
		}

		.compose-error {
			margin: 0;
			padding: 0 1rem 0.5rem;
		}

		.compose-chips {
			display: block;
			flex-shrink: 0;
			padding: 0.375rem 1rem 0.5rem;
		}

		.compose-desktop-foot {
			display: none;
		}

		.compose-editor :global(.icon-btn.danger) {
			color: var(--color-danger);
		}
	}
</style>
