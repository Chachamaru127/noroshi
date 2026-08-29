<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import AiSupportDock from '$lib/components/AiSupportDock.svelte';
	import WizardShell from '$lib/components/WizardShell.svelte';
	import DomainPicker from '$lib/components/DomainPicker.svelte';
	import AddressField from '$lib/components/AddressField.svelte';
	import {
		domainPickerSubtitle,
		missingProviderHint,
		missingProviderTitle,
		noDomainsBody,
		noDomainsTitle,
		providerName,
		receivingHint,
		safeProviderError
	} from '$lib/provider-copy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let step = $state(1);
	let selected = $state<string[]>([]);

	let name = $state('');
	let localPart = $state('');
	let password = $state('');
	let confirm = $state('');
	let bootstrapSecret = $state('');
	let error = $state('');
	let submitting = $state(false);

	function safeSetupError(value: unknown): string {
		if (typeof value !== 'string') return 'アカウントを作成できませんでした。';
		if (value.includes('Setup already completed')) return '初期設定はすでに完了しています。';
		if (value.includes('Invalid setup key')) return 'セットアップキーが正しくありません。';
		if (value.includes('Setup protection is not configured'))
			return 'セットアップ保護が設定されていません。';
		if (value.includes('Choose a domain first')) return 'ドメインを選択してください。';
		if (value.includes('Your name is required')) return '名前を入力してください。';
		if (value.includes('Choose an address')) return 'アドレスを選択してください。';
		if (value.includes('Password must be at least 8 characters'))
			return 'パスワードは8文字以上で入力してください。';
		if (value.includes('Database unavailable')) return 'データベースを利用できません。';
		if (value.includes('Too many setup attempts'))
			return '初期設定の試行が多すぎます。時間をおいて再試行してください。';
		if (value.includes('Setup already completed or in progress'))
			return '初期設定は完了済み、または別の処理が進行中です。';
		return 'アカウントを作成できませんでした。';
	}

	const chosen = $derived(data.available.find((domain) => domain.id === selected[0]) ?? null);
	const cleanLocal = $derived(localPart.trim().toLowerCase().replace(/@.*$/, ''));
	// Once they type a name, offer the obvious mailbox for it.
	const suggestion = $derived(
		name
			.trim()
			.split(/\s+/)[0]
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, '') || 'info'
	);

	function goToDetails() {
		if (!chosen) {
			error = '続行するにはドメインを選択してください。';
			return;
		}
		error = '';
		step = 2;
	}

	async function finish(event: SubmitEvent) {
		event.preventDefault();
		error = '';

		if (password.length < 8) {
			error = 'パスワードは8文字以上で入力してください。';
			return;
		}
		if (password !== confirm) {
			error = 'パスワードが一致しません。';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					domainId: chosen?.id,
					localPart: cleanLocal || suggestion,
					name,
					password,
					bootstrapSecret
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = safeSetupError(body.error);
				return;
			}
			// The endpoint signs us in, so go straight to the inbox.
			window.location.href = body.signedIn ? '/inbox' : '/login';
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>初期設定 — QuickMail-ja</title>
</svelte:head>

<WizardShell
	title={step === 1 ? 'ドメインを選択' : 'アカウントを作成'}
	subtitle={step === 1
		? data.receiveOnlyLocal
			? 'ローカル確認用。受信ドメインのみ。送信はResend設定後に利用できます。'
			: domainPickerSubtitle(data.providerKind)
		: data.receiveOnlyLocal
			? `${chosen?.name}で受信アカウントを作成します。送信はResend設定後です。`
			: `${chosen?.name}で送受信します。`}
	steps={['ドメイン', 'アカウント']}
	current={step}
	partner={step === 1}
	partnerKind={data.providerKind}
	partnerCaption={`QuickMail-ja + ${providerName(data.providerKind)}`}
>
	{#if step === 1}
		{#if !data.providerConfigured}
			<div class="surface-lg notice notice-warn">
				<Icon name="key-2-line" size={18} />
				<div>
					<p class="notice-title">{missingProviderTitle(data.providerKind)}</p>
					<p class="notice-body">{safeProviderError(data.loadError)}</p>
					<pre class="snippet">{missingProviderHint(data.providerKind)}</pre>
				</div>
			</div>
		{:else if data.loadError}
			<div class="surface-lg notice notice-warn">
				<Icon name="error-warning-line" size={18} />
				<div>
					<p class="notice-title">ドメインを読み込めませんでした</p>
					<p class="notice-body">{safeProviderError(data.loadError)}</p>
				</div>
			</div>
		{:else if data.available.length === 0}
			<div class="surface-lg notice">
				<Icon name="global-line" size={18} />
				<div>
					<p class="notice-title">{noDomainsTitle(data.providerKind)}</p>
					<p class="notice-body">
						{noDomainsBody(data.providerKind)}
					</p>
				</div>
			</div>
		{:else}
			{#if data.receiveOnlyLocal}
				<div class="surface-lg notice">
					<Icon name="information-line" size={18} />
					<p class="notice-body">ローカル確認用です。受信ドメインだけを使用します。送信はResend設定後に利用できます。</p>
				</div>
			{/if}
			<DomainPicker domains={data.available} bind:selected multi={false} />

			{#if error}<p class="error">{error}</p>{/if}

			<button type="button" class="btn-primary w-full py-2.5 mt-4" onclick={goToDetails}>
				続行{chosen ? `（${chosen.name}）` : ''}
			</button>
		{/if}
	{:else}
		<form class="surface-lg details-card" onsubmit={finish}>
			<label class="field-title" for="bootstrap-secret">セットアップキー</label>
			<input
				id="bootstrap-secret"
				type="password"
				bind:value={bootstrapSecret}
				required
				autocomplete="off"
				class="text-input"
			/>

			<label class="field-title mt-4" for="name">名前</label>
			<input
				id="name"
				type="text"
				bind:value={name}
				required
				placeholder="山田太郎"
				class="text-input"
			/>

			<div class="mt-4">
				<AddressField
					bind:localPart
					domainId={chosen?.id ?? ''}
					domains={chosen ? [chosen] : []}
					placeholder={suggestion}
					label="メールアドレス"
				/>
			</div>

			<p class="preview">
				このアドレスが受信トレイとログインIDになります —
				<strong>{(cleanLocal || suggestion) + '@' + (chosen?.name ?? '')}</strong>
			</p>

			<label class="field-title mt-4" for="password">パスワード</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				required
				minlength="8"
				autocomplete="new-password"
				class="text-input"
			/>

			<label class="field-title mt-4" for="confirm">パスワード（確認）</label>
			<input
				id="confirm"
				type="password"
				bind:value={confirm}
				required
				minlength="8"
				autocomplete="new-password"
				class="text-input"
			/>

			{#if chosen && !chosen.can_receive}
				<p class="hint">
					<Icon name="information-line" size={14} />
					{receivingHint(data.providerKind, chosen.name)}
				</p>
			{/if}

			{#if error}<p class="error">{error}</p>{/if}

			<div class="actions">
				<button type="button" class="btn-ghost" onclick={() => (step = 1)}>
					<Icon name="arrow-left-line" size={16} /> 戻る
				</button>
				<button type="submit" class="btn-primary flex-1 py-2.5" disabled={submitting}>
					{submitting ? '設定中…' : 'アカウントを作成'}
				</button>
			</div>
		</form>
	{/if}

	<AiSupportDock stage={step === 1 ? 'resend' : 'first-admin'} />
</WizardShell>

<style>
	.details-card {
		padding: 1.5rem;
	}

	.field-title {
		display: block;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.text-input {
		width: 100%;
		margin-top: 0.5rem;
		padding: 0.625rem 0.875rem;
		border-radius: 0.625rem;
		font-size: 0.9375rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.text-input:focus {
		box-shadow:
			inset 0 0 0 1px var(--color-focus-line),
			0 0 0 3px var(--color-focus-halo);
	}

	.preview {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1.5rem;
	}

	.notice {
		display: flex;
		gap: 0.75rem;
		padding: 1.25rem;
		color: var(--color-text-secondary);
	}

	.notice-warn {
		box-shadow:
			0 0 0 1px var(--tone-notice-line),
			var(--shadow-sm);
	}

	.notice-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.notice-body {
		margin-top: 0.25rem;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	.snippet {
		margin-top: 0.625rem;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 0.75rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		overflow-x: auto;
	}

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.875rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.error {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}
</style>
