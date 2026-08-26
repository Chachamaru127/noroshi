<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { folderUiError } from '$lib/folder-ui';
	import type { MailFolder } from '$lib/types';

	let {
		folders,
		ids,
		currentFolderId,
		label = 'フォルダへ移動',
		compact = true,
		onMoved,
		onFocusFallback
	}: {
		folders: MailFolder[];
		ids: string[];
		currentFolderId?: string | null;
		label?: string;
		compact?: boolean;
		onMoved?: (destinationId: string | null) => void | Promise<void>;
		onFocusFallback?: () => void;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let error = $state('');
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	function visibleFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
		return Boolean(
			element?.isConnected &&
			!element.closest('[inert], [aria-hidden="true"]') &&
			element.getClientRects().length > 0
		);
	}

	function close(restoreFocus = true) {
		if (restoreFocus) {
			if (visibleFocusTarget(trigger)) trigger.focus({ preventScroll: true });
			else onFocusFallback?.();
		}
		open = false;
	}

	$effect(() => {
		if (!open) return;
		queueMicrotask(() =>
			menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
		);
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target;
			if (!(target instanceof Node) || menu?.contains(target) || trigger?.contains(target)) return;
			close(false);
		};
		document.addEventListener('focusin', onFocusIn);
		return () => document.removeEventListener('focusin', onFocusIn);
	});

	function tabAwayFromMenu(backwards: boolean) {
		const focusable = Array.from(
			document.querySelectorAll<HTMLElement>(
				'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
			)
		).filter(
			(element) =>
				!menu?.contains(element) &&
				!element.closest('[aria-hidden="true"]') &&
				element.getClientRects().length > 0
		);
		const current = trigger ? focusable.indexOf(trigger) : -1;
		const next = current < 0 ? trigger : focusable[current + (backwards ? -1 : 1)];
		if (visibleFocusTarget(next)) next.focus({ preventScroll: true });
		else if (visibleFocusTarget(trigger)) trigger.focus({ preventScroll: true });
		else onFocusFallback?.();
		close(false);
	}

	function onMenuKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			event.preventDefault();
			tabAwayFromMenu(event.shiftKey);
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

		const items = Array.from(
			menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
		);
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? items.length - 1
					: event.key === 'ArrowDown'
						? current < 0
							? 0
							: (current + 1) % items.length
						: current < 0
							? items.length - 1
							: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	}

	async function move(destinationId: string | null) {
		if (busy || ids.length === 0 || destinationId === currentFolderId) return;
		busy = true;
		error = '';
		let moved = false;
		try {
			const response = await fetch('/api/folders/assign', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids, folderId: destinationId })
			});
			const body = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				error = folderUiError(body.error, 'move');
				return;
			}
			close(false);
			await onMoved?.(destinationId);
			await invalidateAll();
			moved = true;
		} catch {
			error = '通信エラーが発生しました。';
		} finally {
			busy = false;
		}
		if (moved) {
			await tick();
			if (visibleFocusTarget(trigger)) trigger.focus({ preventScroll: true });
			else onFocusFallback?.();
		}
	}
</script>

<div class="folder-move">
	<button
		bind:this={trigger}
		type="button"
		class:compact
		class="move-trigger"
		aria-label={label}
		aria-expanded={open}
		aria-haspopup="menu"
		disabled={busy || ids.length === 0}
		onclick={() => {
			error = '';
			if (open) close();
			else open = true;
		}}
	>
		<Icon name="folder-transfer-line" size={16} />
		{#if !compact}<span>{label}</span>{/if}
	</button>

	{#if open}
		<div class="move-layer" use:portal>
			<div class="move-backdrop" aria-hidden="true" onclick={() => close()}></div>
			<div
				bind:this={menu}
				class="move-menu"
				role="menu"
				tabindex="-1"
				aria-label="移動先フォルダ"
				onkeydown={onMenuKeydown}
			>
				<p class="move-title">移動先</p>
				<button
					type="button"
					class="move-option"
					role="menuitem"
					disabled={busy}
					onclick={() => move(null)}
				>
					<Icon name="inbox-line" size={16} />
					<span>フォルダ分けを解除</span>
				</button>
				{#each folders as folder (folder.id)}
					<button
						type="button"
						class="move-option"
						class:current={currentFolderId === folder.id}
						role="menuitem"
						disabled={busy || currentFolderId === folder.id}
						onclick={() => move(folder.id)}
					>
						<Icon name="folder-line" size={16} />
						<span>{folder.name}</span>
						{#if currentFolderId === folder.id}<Icon name="check-line" size={15} />{/if}
					</button>
				{/each}
				{#if folders.length === 0}
					<p class="move-empty">作成済みのフォルダはありません。</p>
				{/if}
				{#if error}<p class="move-error" role="alert">{error}</p>{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.folder-move {
		position: relative;
		display: inline-flex;
	}
	.move-layer {
		display: contents;
	}
	.move-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0 0.625rem;
		border-radius: 0.5rem;
		color: var(--color-text-secondary);
	}
	.move-trigger.compact {
		width: 1.875rem;
		height: 1.875rem;
		min-height: 0;
		padding: 0;
	}
	.move-trigger:hover:not(:disabled) {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}
	.move-trigger:disabled {
		opacity: 0.45;
	}
	.move-backdrop {
		position: fixed;
		inset: 0;
		z-index: 55;
	}
	.move-menu {
		position: fixed;
		top: 4.5rem;
		right: 1.5rem;
		z-index: 60;
		width: min(18rem, calc(100vw - 2rem));
		max-height: calc(100vh - 6rem);
		overflow-y: auto;
		padding: 0.375rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-md);
	}
	.move-title {
		padding: 0.375rem 0.625rem;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-muted);
	}
	.move-option {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		min-height: 2.5rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		color: var(--color-text-secondary);
		text-align: left;
	}
	.move-option span {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.move-option:hover:not(:disabled) {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}
	.move-option.current {
		color: var(--color-text);
		font-weight: 500;
	}
	.move-option:disabled {
		opacity: 0.7;
	}
	.move-empty,
	.move-error {
		padding: 0.625rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}
	.move-error {
		color: var(--color-danger);
	}
	@media (max-width: 900px) {
		.move-trigger,
		.move-trigger.compact,
		.move-option {
			min-height: var(--touch-target);
		}

		.move-trigger.compact {
			width: var(--touch-target);
			height: var(--touch-target);
		}

		.move-trigger:not(.compact) {
			width: var(--touch-target);
			padding: 0;
		}

		.move-trigger:not(.compact) span {
			display: none;
		}

		.move-menu {
			position: fixed;
			top: auto;
			right: 1rem;
			bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 0.75rem);
			left: 1rem;
			width: auto;
			max-height: 55vh;
			overflow-y: auto;
		}
	}
</style>
