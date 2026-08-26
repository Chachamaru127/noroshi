<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import Icon from './Icon.svelte';
	import { folderNameLength, folderUiError } from '$lib/folder-ui';
	import type { MailFolder, MailFolderDeleteImpact } from '$lib/types';

	let {
		folders,
		variant = 'sidebar',
		onNavigate,
		dialogOpen = $bindable(false),
		dialogBusy = $bindable(false)
	}: {
		folders: MailFolder[];
		variant?: 'sidebar' | 'mobile';
		onNavigate?: () => void;
		dialogOpen?: boolean;
		dialogBusy?: boolean;
	} = $props();

	let editor = $state<'create' | 'rename' | null>(null);
	let target = $state<MailFolder | null>(null);
	let name = $state('');
	let deleting = $state<MailFolder | null>(null);
	let impact = $state<MailFolderDeleteImpact | null>(null);
	let busy = $state(false);
	let error = $state('');
	let input = $state<HTMLInputElement>();
	let confirmButton = $state<HTMLButtonElement>();
	let addButton = $state<HTMLButtonElement>();
	let returnFocusTarget = $state<HTMLElement>();
	const nameLength = $derived(folderNameLength(name));
	const folderNavigationTitleId = $derived(`folder-navigation-title-${variant}`);

	function visibleFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
		return Boolean(
			element?.isConnected &&
			!element.closest('[inert], [aria-hidden="true"]') &&
			element.getClientRects().length > 0
		);
	}

	function folderLinkFor(control: EventTarget | null): HTMLAnchorElement | null {
		return control instanceof HTMLElement
			? (control.closest('.folder-row')?.querySelector<HTMLAnchorElement>('a[href]') ?? null)
			: null;
	}

	function modalLayer(node: HTMLElement) {
		document.body.appendChild(node);
		const background = Array.from(document.body.children).filter(
			(element): element is HTMLElement => element instanceof HTMLElement && element !== node
		);
		const previousInert = background.map((element) => element.inert);
		for (const element of background) element.inert = true;
		queueMicrotask(() => node.querySelector<HTMLElement>('[role="dialog"]')?.focus());

		return {
			destroy() {
				background.forEach((element, index) => (element.inert = previousInert[index] ?? false));
				node.remove();
				queueMicrotask(() => {
					if (visibleFocusTarget(returnFocusTarget)) {
						returnFocusTarget.focus({ preventScroll: true });
					} else if (visibleFocusTarget(addButton)) addButton.focus({ preventScroll: true });
				});
			}
		};
	}

	function trapDialogFocus(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const dialog = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
			'[role="dialog"]'
		);
		if (!dialog) return;
		const focusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
			)
		);
		if (focusable.length === 0) {
			event.preventDefault();
			dialog.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		const atBoundary = active === dialog || !dialog.contains(active);
		if (event.shiftKey && (active === first || atBoundary)) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && (active === last || atBoundary)) {
			event.preventDefault();
			first?.focus();
		}
	}

	$effect(() => {
		dialogOpen = Boolean(editor || deleting);
		dialogBusy = busy;
	});

	$effect(() => {
		if (editor) queueMicrotask(() => input?.focus());
	});

	$effect(() => {
		if (deleting && impact) queueMicrotask(() => confirmButton?.focus());
	});

	$effect(() => {
		if (!editor && !deleting) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !busy) closeDialog();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function closeDialog() {
		editor = null;
		target = null;
		deleting = null;
		impact = null;
		name = '';
		error = '';
	}

	function startCreate() {
		returnFocusTarget = addButton;
		target = null;
		name = '';
		error = '';
		editor = 'create';
	}

	function startRename(folder: MailFolder, opener: EventTarget | null) {
		returnFocusTarget = folderLinkFor(opener) ?? addButton;
		target = folder;
		name = folder.name;
		error = '';
		editor = 'rename';
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (nameLength > 80) {
			error = 'フォルダ名は80文字以内で入力してください。';
			return;
		}
		if (nameLength === 0 || busy) return;
		busy = true;
		error = '';
		try {
			const url = editor === 'rename' && target ? `/api/folders/${target.id}` : '/api/folders';
			const response = await fetch(url, {
				method: editor === 'rename' ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const body = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				error = folderUiError(body.error);
				return;
			}
			closeDialog();
			await invalidateAll();
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			busy = false;
		}
	}

	async function requestDelete(folder: MailFolder, opener: EventTarget | null) {
		returnFocusTarget = folderLinkFor(opener) ?? addButton;
		deleting = folder;
		impact = null;
		error = '';
		busy = true;
		try {
			const response = await fetch(`/api/folders/${folder.id}`);
			const body = (await response.json().catch(() => ({}))) as {
				impact?: MailFolderDeleteImpact;
				error?: unknown;
			};
			if (!response.ok || !body.impact) {
				error = folderUiError(body.error);
				return;
			}
			impact = body.impact;
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!deleting || !impact || busy) return;
		busy = true;
		error = '';
		const removedId = deleting.id;
		try {
			const response = await fetch(`/api/folders/${removedId}`, { method: 'DELETE' });
			const body = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				error = folderUiError(body.error);
				return;
			}
			returnFocusTarget = addButton;
			closeDialog();
			if ($page.url.pathname === `/folders/${removedId}`) {
				await goto('/inbox');
				await invalidateAll();
			} else await invalidateAll();
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			busy = false;
		}
	}

	function active(folder: MailFolder) {
		return $page.url.pathname === `/folders/${folder.id}`;
	}
</script>

<section
	class:mobile={variant === 'mobile'}
	class="folders"
	aria-labelledby={folderNavigationTitleId}
>
	<div class="folders-head">
		<p id={folderNavigationTitleId}>フォルダ</p>
		<button
			bind:this={addButton}
			type="button"
			class="add-folder"
			aria-label="フォルダを追加"
			onclick={startCreate}
		>
			<Icon name="add-line" size={16} />
		</button>
	</div>

	<nav class="folder-list" aria-label="カスタムフォルダ">
		{#each folders as folder (folder.id)}
			<div class="folder-row" class:active={active(folder)}>
				<a
					href={`/folders/${folder.id}`}
					aria-current={active(folder) ? 'page' : undefined}
					onclick={onNavigate}
				>
					<Icon name={active(folder) ? 'folder-fill' : 'folder-line'} size={17} />
					<span>{folder.name}</span>
					{#if folder.unread_count > 0}<strong>{folder.unread_count}</strong>{/if}
				</a>
				<div class="folder-actions">
					<button
						type="button"
						aria-label={`${folder.name}の名前を変更`}
						title="名前を変更"
						onclick={(event) => startRename(folder, event.currentTarget)}
					>
						<Icon name="edit-line" size={15} />
					</button>
					<button
						type="button"
						aria-label={`${folder.name}を削除`}
						title="フォルダを削除"
						onclick={(event) => requestDelete(folder, event.currentTarget)}
					>
						<Icon name="delete-bin-line" size={15} />
					</button>
				</div>
			</div>
		{/each}
		{#if folders.length === 0}
			<p class="folder-empty">フォルダはまだありません。</p>
		{/if}
	</nav>
</section>

{#if editor}
	<div
		use:modalLayer
		class="dialog-scrim"
		role="presentation"
		onkeydown={trapDialogFocus}
		onclick={(event) => event.target === event.currentTarget && !busy && closeDialog()}
	>
		<div
			class="folder-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="folder-editor-title"
			tabindex="-1"
		>
			<h2 id="folder-editor-title">{editor === 'create' ? 'フォルダを追加' : '名前を変更'}</h2>
			<form onsubmit={save}>
				<label for="folder-name">フォルダ名</label>
				<input
					bind:this={input}
					id="folder-name"
					bind:value={name}
					autocomplete="off"
					aria-describedby="folder-name-hint"
					aria-invalid={nameLength > 80}
				/>
				<p id="folder-name-hint" class="hint" class:invalid={nameLength > 80}>
					{nameLength > 80 ? 'フォルダ名は80文字以内で入力してください。' : `${nameLength}/80文字`}
				</p>
				{#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
				<div class="dialog-actions">
					<button type="button" class="btn-ghost" disabled={busy} onclick={closeDialog}
						>キャンセル</button
					>
					<button
						type="submit"
						class="btn-primary"
						disabled={busy || nameLength === 0 || nameLength > 80}
						>{busy ? '保存中…' : '保存'}</button
					>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if deleting}
	<div
		use:modalLayer
		class="dialog-scrim"
		role="presentation"
		onkeydown={trapDialogFocus}
		onclick={(event) => event.target === event.currentTarget && !busy && closeDialog()}
	>
		<div
			class="folder-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="folder-delete-title"
			aria-describedby="folder-delete-description folder-delete-status"
			aria-busy={busy}
			tabindex="-1"
		>
			<h2 id="folder-delete-title">「{deleting.name}」を削除</h2>
			<p id="folder-delete-description" class="delete-note">
				<strong>メールは削除されません。</strong> 添付ファイルも保持されます。メールのフォルダ分けが解除されます。このフォルダを使う自動振り分けルールだけが削除されます。
			</p>
			<p id="folder-delete-status" role="status" aria-live="polite" aria-atomic="true">
				{#if busy && impact}
					フォルダを削除しています…
				{:else if impact}
					このフォルダには{impact.conversation_count}件の会話と{impact.rule_count}件の自動振り分けルールがあります。
				{:else if busy}
					影響を確認しています…
				{:else}
					影響を確認できませんでした。
				{/if}
			</p>
			{#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				<button type="button" class="btn-ghost" disabled={busy} onclick={closeDialog}
					>キャンセル</button
				>
				<button
					bind:this={confirmButton}
					type="button"
					class="delete-button"
					disabled={busy || !impact}
					onclick={remove}>{busy && impact ? '削除中…' : 'フォルダを削除'}</button
				>
			</div>
		</div>
	</div>
{/if}

<style>
	.folders {
		margin-top: 1rem;
		padding-top: 0.75rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}
	.folders-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 1.75rem;
		padding: 0 0.5rem;
	}
	.folders-head p {
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-muted);
	}
	.add-folder,
	.folder-actions button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.4rem;
		color: var(--color-muted);
	}
	.add-folder:hover,
	.folder-actions button:hover {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}
	.folder-list {
		margin-top: 0.25rem;
		max-height: min(18rem, 40vh);
		overflow-y: auto;
	}
	.folder-row {
		display: flex;
		align-items: center;
		min-width: 0;
		border-radius: 0.625rem;
		color: var(--color-text-secondary);
	}
	.folder-row:hover,
	.folder-row.active {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}
	.folder-row.active {
		font-weight: 500;
	}
	.folder-row a {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
		min-height: 2.25rem;
		padding: 0 0.625rem;
	}
	.folder-row a span {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.875rem;
	}
	.folder-row a strong {
		min-width: 1.25rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		text-align: center;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}
	.folder-actions {
		display: none;
		align-items: center;
		padding-right: 0.25rem;
	}
	.folder-row:hover .folder-actions,
	.folder-row:focus-within .folder-actions {
		display: flex;
	}
	.folder-empty {
		padding: 0.5rem 0.625rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}
	.folders.mobile {
		margin-top: 0.875rem;
		padding-top: 0.875rem;
	}
	.folders.mobile .folders-head {
		padding: 0 0.75rem;
	}
	.folders.mobile .folder-row {
		min-height: 2.75rem;
	}
	.folders.mobile .folder-row a {
		min-height: 2.75rem;
		padding-left: 0.75rem;
	}
	.folders.mobile .folder-actions {
		display: flex;
	}
	.dialog-scrim {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: var(--color-scrim);
	}
	.folder-dialog {
		width: min(28rem, 100%);
		padding: 1.25rem;
		border-radius: 1rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-md);
	}
	.folder-dialog h2 {
		margin-bottom: 0.875rem;
		font-size: 1.0625rem;
		font-weight: 600;
	}
	.folder-dialog p {
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}
	.folder-dialog label {
		display: block;
		margin-bottom: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
	}
	.folder-dialog input {
		width: 100%;
		min-height: 2.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.625rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		outline: none;
	}
	.folder-dialog input:focus {
		box-shadow: 0 0 0 2px var(--color-accent);
	}
	.folder-dialog .hint {
		margin-top: 0.375rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}
	.folder-dialog .hint.invalid {
		color: var(--color-danger);
	}
	.delete-note {
		margin-top: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.625rem;
		background: var(--color-surface-muted);
	}
	.dialog-error {
		margin-top: 0.625rem;
		color: var(--color-danger) !important;
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.delete-button {
		min-height: 2.5rem;
		padding: 0.5rem 1rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: white;
		background: var(--color-danger);
	}
	.delete-button:disabled {
		opacity: 0.45;
	}
	@media (max-width: 900px) {
		.folders.mobile .add-folder,
		.folders.mobile .folder-actions button {
			width: var(--touch-target);
			height: var(--touch-target);
		}

		.folders.mobile .folder-list {
			max-height: 35vh;
		}
		.dialog-scrim {
			align-items: end;
			padding: 0;
		}
		.folder-dialog {
			width: 100%;
			padding: 1.25rem 1rem calc(1.25rem + env(safe-area-inset-bottom));
			border-radius: 1.25rem 1.25rem 0 0;
		}
		.folder-dialog .delete-button {
			min-height: var(--touch-target);
		}
	}
</style>
