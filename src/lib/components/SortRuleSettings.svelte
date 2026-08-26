<script lang="ts">
	import { tick, untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import {
		canStartSortRuleEditor,
		deletedRuleFocusOrder,
		loadCurrentSortRules,
		moveSortRule,
		sortRuleAccessibleLabel,
		sortRuleConditionLength,
		sortRuleUiError,
		survivingFocusCandidate
	} from '$lib/settings-sort-rules';
	import type { MailFolder, MailSortRule } from '$lib/types';

	let {
		folders,
		initialRules
	}: {
		folders: MailFolder[];
		initialRules: MailSortRule[];
	} = $props();

	let rules = $state<MailSortRule[]>(untrack(() => initialRules));
	let editor = $state<'create' | 'edit' | null>(null);
	let editingId = $state<string | null>(null);
	let senderContains = $state('');
	let subjectContains = $state('');
	let folderId = $state(untrack(() => folders[0]?.id ?? ''));
	let enabled = $state(true);
	let busy = $state(false);
	let actionId = $state('');
	let error = $state('');
	let saved = $state('');
	let deleting = $state<MailSortRule | null>(null);
	let senderInput = $state<HTMLInputElement>();
	let deleteButton = $state<HTMLButtonElement>();
	let createButton = $state<HTMLButtonElement>();
	let editorOpener: HTMLElement | null = null;
	let deleteFocusCandidates: HTMLElement[] = [];
	let deleteDialog = $state<HTMLElement>();
	let deleteProgress = $state<HTMLElement>();

	const senderLength = $derived(sortRuleConditionLength(senderContains));
	const subjectLength = $derived(sortRuleConditionLength(subjectContains));
	const conditionsMissing = $derived(!senderContains.trim() && !subjectContains.trim());
	const formInvalid = $derived(
		!folderId || conditionsMissing || senderLength > 256 || subjectLength > 256
	);
	const canCreateRule = $derived(
		Boolean(folders.length) &&
			canStartSortRuleEditor({ busy, actionId, editorOpen: Boolean(editor) })
	);

	$effect(() => {
		// Deleting a folder can also remove its rules and then invalidate this page.
		rules = initialRules;
	});

	$effect(() => {
		const currentFolderId = untrack(() => folderId);
		if (!folders.some((folder) => folder.id === currentFolderId)) {
			folderId = folders[0]?.id ?? '';
		}
	});

	$effect(() => {
		if (editor) queueMicrotask(() => senderInput?.focus());
	});

	$effect(() => {
		if (deleting) queueMicrotask(() => deleteButton?.focus());
	});

	$effect(() => {
		if (deleting && busy) {
			void tick().then(() => (deleteProgress ?? deleteDialog)?.focus({ preventScroll: true }));
		}
	});

	function modalLayer(node: HTMLElement) {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		document.body.appendChild(node);
		const background = Array.from(document.body.children).filter(
			(element): element is HTMLElement => element instanceof HTMLElement && element !== node
		);
		const previousInert = background.map((element) => element.inert);
		for (const element of background) element.inert = true;
		return {
			destroy() {
				background.forEach((element, index) => (element.inert = previousInert[index] ?? false));
				node.remove();
				queueMicrotask(() => opener?.isConnected && opener.focus({ preventScroll: true }));
			}
		};
	}

	function trapDialogFocus(event: KeyboardEvent) {
		if (event.key === 'Escape' && !busy) {
			closeDelete();
			return;
		}
		if (event.key !== 'Tab') return;
		const dialog = event.currentTarget as HTMLElement;
		const focusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
			)
		);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (!first || !last) {
			event.preventDefault();
			dialog.focus({ preventScroll: true });
			return;
		}
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function clearMessages() {
		error = '';
		saved = '';
	}

	function clearEditor() {
		editor = null;
		editingId = null;
		senderContains = '';
		subjectContains = '';
		folderId = folders[0]?.id ?? '';
		enabled = true;
	}

	function restoreEditorFocus(candidates: Array<HTMLElement | null | undefined>) {
		void tick().then(() => survivingFocusCandidate(candidates)?.focus({ preventScroll: true }));
	}

	function restoreRuleActionFocus(ruleId: string, action: string) {
		void tick().then(() => {
			const control = Array.from(document.querySelectorAll<HTMLElement>('[data-rule-action]')).find(
				(candidate) => candidate.dataset.ruleAction === `${ruleId}:${action}`
			);
			survivingFocusCandidate([control, createButton])?.focus({ preventScroll: true });
		});
	}

	async function restoreDeleteDialogFocus() {
		await tick();
		survivingFocusCandidate([deleteButton, deleteDialog])?.focus({ preventScroll: true });
	}

	function closeEditor() {
		const opener = editorOpener;
		editorOpener = null;
		clearEditor();
		restoreEditorFocus([opener, createButton]);
	}

	function startCreate(event: MouseEvent) {
		if (!canCreateRule) return;
		clearMessages();
		clearEditor();
		editorOpener =
			event.currentTarget instanceof HTMLElement ? event.currentTarget : (createButton ?? null);
		editor = 'create';
	}

	function startEdit(rule: MailSortRule, opener: HTMLElement) {
		if (busy || actionId || editor) return;
		clearMessages();
		editorOpener = opener;
		editor = 'edit';
		editingId = rule.id;
		senderContains = rule.sender_contains ?? '';
		subjectContains = rule.subject_contains ?? '';
		folderId = rule.folder_id;
		enabled = rule.enabled;
	}

	function startDelete(rule: MailSortRule) {
		clearMessages();
		const orderedIds = deletedRuleFocusOrder(
			rules.map((current) => current.id),
			rule.id
		);
		const ruleButtons = Array.from(document.querySelectorAll<HTMLElement>('[data-rule-focus]'));
		deleteFocusCandidates = [
			...orderedIds.map((id) => ruleButtons.find((button) => button.dataset.ruleFocus === id)),
			createButton
		].filter((candidate): candidate is HTMLElement => Boolean(candidate));
		deleting = rule;
	}

	function closeDelete() {
		deleteFocusCandidates = [];
		deleting = null;
	}

	async function readResponse(response: Response): Promise<Record<string, unknown>> {
		return (await response.json().catch(() => ({}))) as Record<string, unknown>;
	}

	async function refreshSortRules(): Promise<boolean> {
		const current = await loadCurrentSortRules(fetch);
		if (!current) return false;
		rules = current;
		return true;
	}

	async function saveRule(event: SubmitEvent) {
		event.preventDefault();
		if (busy || actionId || formInvalid) {
			if (conditionsMissing) {
				error = '差出人または件名の条件を1つ以上入力してください。';
			} else if (senderLength > 256 || subjectLength > 256) {
				error = '条件はそれぞれ256文字以内で入力してください。';
			}
			return;
		}
		const creating = editor === 'create';
		const ruleId = editor === 'edit' ? editingId : null;
		if (!creating && !ruleId) return;
		busy = true;
		clearMessages();
		try {
			const response = await fetch(ruleId ? `/api/sort-rules/${ruleId}` : '/api/sort-rules', {
				method: ruleId ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderId,
					senderContains,
					subjectContains,
					enabled
				})
			});
			const body = await readResponse(response);
			if (!response.ok || !body.rule) {
				await refreshSortRules();
				error = sortRuleUiError(body.error);
				return;
			}
			const rule = body.rule as MailSortRule;
			rules = ruleId
				? rules.map((current) => (current.id === rule.id ? rule : current))
				: [...rules, rule];
			saved = ruleId ? 'ルールを保存しました。' : 'ルールを作成しました。';
			closeEditor();
		} catch {
			const reconciled = await refreshSortRules();
			error = reconciled
				? '保存結果を確認できなかったため、現在のルール一覧を更新しました。内容を確認してから再度操作してください。'
				: '通信エラーが発生し、現在のルール一覧も更新できませんでした。時間をおいて再度お試しください。';
		} finally {
			busy = false;
		}
	}

	async function setRuleEnabled(rule: MailSortRule, next: boolean, control: HTMLInputElement) {
		if (actionId) {
			control.checked = rule.enabled;
			return;
		}
		actionId = rule.id;
		clearMessages();
		try {
			const response = await fetch(`/api/sort-rules/${rule.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			const body = await readResponse(response);
			if (!response.ok || !body.rule) {
				error = sortRuleUiError(body.error);
				return;
			}
			const updated = body.rule as MailSortRule;
			rules = rules.map((current) => (current.id === updated.id ? updated : current));
			saved = next ? 'ルールを有効にしました。' : 'ルールを無効にしました。';
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			actionId = '';
			control.checked = rules.find((current) => current.id === rule.id)?.enabled ?? rule.enabled;
			restoreRuleActionFocus(rule.id, 'toggle');
		}
	}

	async function reorder(index: number, direction: -1 | 1) {
		if (actionId) return;
		const next = moveSortRule(rules, index, direction);
		if (next === rules) return;
		const ruleId = rules[index]?.id ?? '';
		const action = direction === -1 ? 'up' : 'down';
		actionId = ruleId || 'order';
		clearMessages();
		try {
			const response = await fetch('/api/sort-rules/reorder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: next.map((rule) => rule.id) })
			});
			const body = await readResponse(response);
			if (!response.ok || !Array.isArray(body.rules)) {
				error = sortRuleUiError(body.error);
				return;
			}
			rules = body.rules as MailSortRule[];
			saved = '評価順を変更しました。';
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			actionId = '';
			if (ruleId) restoreRuleActionFocus(ruleId, action);
		}
	}

	async function deleteRule() {
		if (!deleting || busy) return;
		busy = true;
		clearMessages();
		try {
			const response = await fetch(`/api/sort-rules/${deleting.id}`, { method: 'DELETE' });
			const body = await readResponse(response);
			if (!response.ok) {
				error = sortRuleUiError(body.error);
				return;
			}
			const focusCandidates = deleteFocusCandidates;
			rules = rules.filter((rule) => rule.id !== deleting?.id);
			deleting = null;
			deleteFocusCandidates = [];
			restoreEditorFocus(focusCandidates);
			saved = 'ルールを削除しました。既存メールの保存先は変わりません。';
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			busy = false;
			if (deleting) await restoreDeleteDialogFocus();
		}
	}
</script>

<section class="surface-lg rule-card" aria-labelledby="sort-rules-title">
	<div class="card-head">
		<h2 id="sort-rules-title"><Icon name="filter-3-line" size={18} /> 自動振り分け</h2>
		<button
			bind:this={createButton}
			type="button"
			class="btn-primary"
			disabled={!canCreateRule}
			onclick={startCreate}
		>
			<Icon name="add-line" size={15} /> 新規作成
		</button>
	</div>
	<p class="card-hint">
		差出人または件名に一致する新着メールを、指定したフォルダへ自動で移動します。両方を入力した場合は、両方に一致したときだけ振り分けます。
	</p>
	<p class="rule-note" role="note">
		<Icon name="information-line" size={15} />
		<span
			><strong>新しく受信したメールだけ</strong
			>が対象です。既存メール、取込済みメール、送信済みメール、下書きは移動しません。</span
		>
	</p>

	{#if !folders.length}
		<p class="empty">自動振り分けを設定する前に、フォルダを作成してください。</p>
	{/if}

	{#if editor}
		<form
			class="rule-editor"
			aria-label={editor === 'create' ? '自動振り分けルールを作成' : '自動振り分けルールを編集'}
			onsubmit={saveRule}
		>
			<h3>{editor === 'create' ? 'ルールを作成' : 'ルールを編集'}</h3>
			<div class="rule-fields">
				<label>
					<span>差出人に含む</span>
					<input
						bind:this={senderInput}
						bind:value={senderContains}
						type="text"
						placeholder="example.jp または sender@example.jp"
						autocomplete="off"
						aria-describedby="sender-condition-help sort-rule-condition-requirement"
						aria-invalid={conditionsMissing || senderLength > 256}
						disabled={busy}
					/>
					<small id="sender-condition-help" class:over={senderLength > 256}
						>{senderLength}/256文字</small
					>
				</label>
				<label>
					<span>件名に含む</span>
					<input
						bind:value={subjectContains}
						type="text"
						placeholder="請求書"
						autocomplete="off"
						aria-describedby="subject-condition-help sort-rule-condition-requirement"
						aria-invalid={conditionsMissing || subjectLength > 256}
						disabled={busy}
					/>
					<small id="subject-condition-help" class:over={subjectLength > 256}
						>{subjectLength}/256文字</small
					>
				</label>
				<label>
					<span>移動先フォルダ</span>
					<select bind:value={folderId} required disabled={busy}>
						{#each folders as folder (folder.id)}
							<option value={folder.id}>{folder.name}</option>
						{/each}
					</select>
				</label>
			</div>
			<label class="enabled-field">
				<input type="checkbox" bind:checked={enabled} disabled={busy} />
				<span>{editor === 'create' ? '作成後すぐに有効にする' : 'このルールを有効にする'}</span>
			</label>
			<p id="sort-rule-condition-requirement" class="condition-help">
				差出人または件名のどちらか1つ以上を入力してください。大文字と小文字は区別しません。
			</p>
			<div class="editor-actions">
				<button type="button" class="btn-ghost" disabled={busy} onclick={closeEditor}
					>キャンセル</button
				>
				<button type="submit" class="btn-primary" disabled={busy || formInvalid}
					>{busy ? '保存中…' : '保存'}</button
				>
			</div>
		</form>
	{/if}

	{#if rules.length}
		<ol class="rule-list" aria-label="自動振り分けルール（評価順）">
			{#each rules as rule, index (rule.id)}
				{@const accessibleRule = sortRuleAccessibleLabel(rule, index)}
				<li class="rule-row" class:disabled={!rule.enabled}>
					<div class="rule-group" role="group" aria-label={accessibleRule}>
						<div class="rule-order" aria-hidden="true">{index + 1}</div>
						<div class="rule-body">
							<div class="rule-summary">
								<strong>{rule.folder_name}</strong>
								<span class="status" class:on={rule.enabled}>{rule.enabled ? '有効' : '無効'}</span>
							</div>
							<dl>
								{#if rule.sender_contains}<div>
										<dt>差出人に含む</dt>
										<dd>{rule.sender_contains}</dd>
									</div>{/if}
								{#if rule.subject_contains}<div>
										<dt>件名に含む</dt>
										<dd>{rule.subject_contains}</dd>
									</div>{/if}
								<div>
									<dt>移動先フォルダ</dt>
									<dd>{rule.folder_name}</dd>
								</div>
							</dl>
						</div>
						<div class="rule-actions" aria-label="評価順{index + 1}: {rule.folder_name}の操作">
							<button
								type="button"
								class="icon-btn"
								aria-label="{accessibleRule}。上へ移動"
								data-rule-action="{rule.id}:up"
								title="上へ移動"
								disabled={index === 0 || Boolean(actionId) || busy || Boolean(editor)}
								onclick={() => reorder(index, -1)}><Icon name="arrow-up-line" size={17} /></button
							>
							<button
								type="button"
								class="icon-btn"
								aria-label="{accessibleRule}。下へ移動"
								data-rule-action="{rule.id}:down"
								title="下へ移動"
								disabled={index === rules.length - 1 ||
									Boolean(actionId) ||
									busy ||
									Boolean(editor)}
								onclick={() => reorder(index, 1)}><Icon name="arrow-down-line" size={17} /></button
							>
							<label class="toggle">
								<input
									type="checkbox"
									checked={rule.enabled}
									aria-label="{accessibleRule}。{rule.enabled ? '無効' : '有効'}にする"
									data-rule-action="{rule.id}:toggle"
									disabled={Boolean(actionId) || busy || Boolean(editor)}
									onchange={(event) =>
										setRuleEnabled(rule, event.currentTarget.checked, event.currentTarget)}
								/>
								<span>{rule.enabled ? '有効' : '無効'}</span>
							</label>
							<button
								type="button"
								class="icon-btn"
								aria-label="{accessibleRule}。編集"
								title="編集"
								disabled={Boolean(actionId) || Boolean(editor)}
								data-rule-focus={rule.id}
								onclick={(event) => startEdit(rule, event.currentTarget)}
								><Icon name="edit-line" size={17} /></button
							>
							<button
								type="button"
								class="icon-btn danger"
								aria-label="{accessibleRule}。削除"
								title="ルールを削除"
								disabled={Boolean(actionId) || busy || Boolean(editor)}
								onclick={() => startDelete(rule)}><Icon name="delete-bin-line" size={17} /></button
							>
						</div>
					</div>
				</li>
			{/each}
		</ol>
	{:else if folders.length}
		<p class="empty">自動振り分けルールはありません。</p>
	{/if}

	<div class="feedback" aria-live="polite">
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if saved}<p class="saved">{saved}</p>{/if}
	</div>
</section>

{#if deleting}
	<div class="modal-layer" use:modalLayer>
		<div class="modal-backdrop" aria-hidden="true"></div>
		<div class="modal-position">
			<div
				bind:this={deleteDialog}
				class="confirm-dialog surface-lg"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="delete-rule-title"
				aria-describedby="delete-rule-description"
				tabindex="-1"
				onkeydown={trapDialogFocus}
			>
				<h2 id="delete-rule-title">ルールを削除しますか？</h2>
				<p id="delete-rule-description">
					「{deleting.folder_name}」へ移動するこのルールを削除します。既存メールと現在のフォルダ分けは変わりません。
				</p>
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				{#if busy}
					<p bind:this={deleteProgress} class="delete-progress" role="status" tabindex="-1">
						ルールを削除中…
					</p>
				{/if}
				<div class="dialog-actions">
					<button type="button" class="btn-ghost" disabled={busy} onclick={closeDelete}
						>キャンセル</button
					>
					<button
						bind:this={deleteButton}
						type="button"
						class="btn-danger"
						disabled={busy}
						onclick={deleteRule}>{busy ? '削除中…' : 'ルールを削除'}</button
					>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.rule-card {
		padding: 1.25rem;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--color-muted);
	}
	.rule-note {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.875rem;
		padding: 0.75rem;
		border-radius: 0.75rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
	}
	.rule-note :global(i) {
		flex-shrink: 0;
		margin-top: 0.125rem;
		color: var(--color-accent);
	}
	.rule-editor {
		margin-top: 1rem;
		padding: 1rem;
		border-radius: 0.875rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}
	.rule-editor h3 {
		font-size: 0.875rem;
		font-weight: 600;
	}
	.rule-fields {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.875rem;
		margin-top: 0.875rem;
	}
	.rule-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}
	.rule-fields label:last-child {
		grid-column: 1 / -1;
	}
	.rule-fields input,
	.rule-fields select {
		width: 100%;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}
	.rule-fields input:focus,
	.rule-fields select:focus {
		box-shadow:
			inset 0 0 0 1px var(--color-focus-line),
			0 0 0 3px var(--color-focus-halo);
	}
	.rule-fields small {
		align-self: flex-end;
		font-size: 0.6875rem;
		color: var(--color-muted);
	}
	.rule-fields small.over {
		color: var(--color-danger);
	}
	.enabled-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.875rem;
		font-size: 0.8125rem;
	}
	.condition-help {
		margin-top: 0.625rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}
	.editor-actions,
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.rule-list {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		margin-top: 1rem;
	}
	.rule-group {
		display: grid;
		grid-template-columns: 1.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.875rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}
	.rule-row.disabled {
		opacity: 0.72;
	}
	.rule-order {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
	}
	.rule-body {
		min-width: 0;
	}
	.rule-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}
	.status {
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
		font-size: 0.6875rem;
		color: var(--color-muted);
		background: var(--color-surface-muted);
	}
	.status.on {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}
	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.875rem;
		margin-top: 0.375rem;
		font-size: 0.75rem;
	}
	dl div {
		display: flex;
		gap: 0.375rem;
		min-width: 0;
	}
	dt {
		flex-shrink: 0;
		color: var(--color-muted);
	}
	dd {
		overflow-wrap: anywhere;
		color: var(--color-text-secondary);
	}
	.rule-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}
	.icon-btn:disabled {
		opacity: 0.35;
	}
	.icon-btn.danger {
		color: var(--color-danger);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0 0.375rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
	.empty {
		margin-top: 1rem;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	.feedback {
		min-height: 1.25rem;
	}
	.error,
	.saved {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
	}
	.error {
		color: var(--color-danger);
	}
	.saved {
		color: var(--tone-good-fg);
	}
	.modal-layer {
		position: fixed;
		inset: 0;
		z-index: 100;
	}
	.modal-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.42);
	}
	.modal-position {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
	}
	.confirm-dialog {
		width: min(100%, 28rem);
		padding: 1.25rem;
		outline: none;
	}
	.confirm-dialog p {
		margin-top: 0.625rem;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
	}
	.delete-progress:focus {
		outline: none;
	}
	.btn-danger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.25rem;
		padding: 0.5rem 1rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: white;
		background: var(--color-danger);
	}
	.btn-danger:disabled {
		opacity: 0.45;
	}

	@media (max-width: 700px) {
		.rule-card {
			padding: 1rem;
		}
		.card-head {
			align-items: flex-start;
		}
		.rule-fields {
			grid-template-columns: 1fr;
		}
		.rule-fields label:last-child {
			grid-column: auto;
		}
		.rule-group {
			grid-template-columns: 1.75rem minmax(0, 1fr);
			align-items: start;
		}
		.rule-actions {
			grid-column: 1 / -1;
			justify-content: flex-end;
			padding-top: 0.375rem;
			box-shadow: inset 0 1px 0 var(--color-line);
		}
		.rule-actions .icon-btn,
		.toggle {
			min-width: var(--touch-target);
			min-height: var(--touch-target);
		}
		.toggle {
			justify-content: center;
		}
		.confirm-dialog .btn-danger {
			min-height: var(--touch-target);
		}
	}
</style>
