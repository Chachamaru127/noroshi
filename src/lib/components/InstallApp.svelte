<script lang="ts">
	import Icon from './Icon.svelte';
	import {
		clearInstallPrompt,
		isIOS,
		isStandaloneDisplay,
		subscribeInstallPrompt,
		type InstallPromptEvent
	} from '$lib/app-chrome';

	let deferred = $state<InstallPromptEvent | null>(null);
	let standalone = $state(false);
	let ios = $state(false);
	let busy = $state(false);

	$effect(() => {
		standalone = isStandaloneDisplay();
		ios = isIOS();
		return subscribeInstallPrompt((prompt) => {
			deferred = prompt;
		});
	});

	async function install() {
		if (!deferred) return;
		busy = true;
		try {
			await deferred.prompt();
			clearInstallPrompt();
		} finally {
			busy = false;
		}
	}
</script>

<section class="surface-lg card">
	<div class="card-head">
		<div>
			<h2><Icon name="smartphone-line" size={18} /> ホーム画面</h2>
			<p class="section-description">
				{standalone
					? 'メールアプリはこの端末にインストールされています。'
					: 'ブラウザーの枠を表示せず、通常のアプリのように開けます。'}
			</p>
		</div>
		<span class="badge" class:on={standalone}>{standalone ? 'インストール済み' : '任意'}</span>
	</div>

	{#if standalone}
		<p class="hint">単独で起動している間も通知とテーマの設定が適用されます。</p>
	{:else if ios}
		<p class="hint">
			<Icon name="share-forward-line" size={14} />
			共有をタップしてから「ホーム画面に追加」を選択してください。
		</p>
	{:else if deferred}
		<div class="actions">
			<p class="hint flush">ホーム画面またはアプリ一覧に追加します。</p>
			<button type="button" class="btn-primary" disabled={busy} onclick={install}>
				{busy ? 'インストール中…' : 'インストール'}
			</button>
		</div>
	{:else}
		<p class="hint">
			<Icon name="information-line" size={14} />
			ブラウザーのメニューからインストールするか、ホーム画面に追加してください。
		</p>
	{/if}
</section>

<style>
	.card {
		margin-top: 1.5rem;
		padding: 1.5rem;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.card h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.section-description {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.badge {
		flex-shrink: 0;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		background: var(--color-surface-muted);
	}

	.badge.on {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 1rem;
	}

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.75rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.flush {
		margin-top: 0;
	}

	@media (max-width: 900px) {
		.card {
			padding: 1.25rem 1rem;
		}

		.actions {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
