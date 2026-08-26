<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import WizardShell from '$lib/components/WizardShell.svelte';
	import DomainPicker from '$lib/components/DomainPicker.svelte';
	import AddressField from '$lib/components/AddressField.svelte';
	import {
		missingProviderTitle,
		noDomainsBody,
		noDomainsTitle,
		onboardingSubtitle,
		providerName,
		safeProviderError
	} from '$lib/provider-copy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let selected = $state<string[]>([]);
	let connecting = $state(false);
	let creating = $state(false);
	let error = $state('');

	let localPart = $state('');
	let addressDomainId = $state('');

	function safeOnboardingError(value: unknown): string {
		if (typeof value !== 'string') return '処理を完了できませんでした。';
		if (value.includes('Select at least one domain')) return 'ドメインを1つ以上選択してください。';
		if (value.includes('Could not connect that domain') || value.includes('Failed to connect domain')) {
			return 'ドメインを接続できませんでした。';
		}
		if (value.includes('Could not create that address') || value.includes('Failed to create address')) {
			return 'アドレスを作成できませんでした。';
		}
		if (value.includes('Pick a domain and enter an address')) return 'ドメインとアドレスを入力してください。';
		if (value.includes('Database unavailable')) return 'データベースを利用できません。';
		return '処理を完了できませんでした。';
	}

	// Seed the picker with the first connected domain once data is available.
	$effect(() => {
		if (!addressDomainId && data.domains[0]) {
			addressDomainId = data.domains[0].id;
		}
	});

	// Step 1 only appears for an admin who hasn't connected anything yet.
	const needsDomain = $derived(data.domains.length === 0);
	const connectable = $derived(data.available.filter((domain) => !domain.connected));
	const cleanLocal = $derived(localPart.trim().toLowerCase().replace(/@.*$/, ''));
	const activeDomain = $derived(data.domains.find((domain) => domain.id === addressDomainId));

	async function connectDomains() {
		if (selected.length === 0) {
			error = 'ドメインを1つ以上選択してください。';
			return;
		}

		connecting = true;
		error = '';

		try {
			const res = await fetch('/api/domains', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainIds: selected })
			});
			const body = await res.json();
			if (!res.ok) {
				error = safeOnboardingError(body.error);
				return;
			}
			window.location.reload();
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			connecting = false;
		}
	}

	async function claimAddress(event: SubmitEvent) {
		event.preventDefault();
		creating = true;
		error = '';

		try {
			const res = await fetch('/api/addresses', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainId: addressDomainId, localPart: cleanLocal })
			});
			const body = await res.json();
			if (!res.ok) {
				error = safeOnboardingError(body.error);
				return;
			}
			window.location.href = '/inbox';
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
		<title>初期設定 — QuickMail-ja</title>
</svelte:head>

<WizardShell
	title={needsDomain ? 'ドメインを接続' : 'アドレスを作成'}
	subtitle={needsDomain
		? onboardingSubtitle(data.providerKind)
		: '送受信に使うアドレスを選択してください。'}
	partner={needsDomain}
	partnerKind={data.providerKind}
	partnerCaption={`QuickMail-ja + ${providerName(data.providerKind)}`}
>
	{#if needsDomain}
		{#if !data.isAdmin}
			<div class="surface-lg notice">
				<Icon name="time-line" size={18} />
				<div>
				<p class="notice-title">管理者の設定を待っています</p>
				<p class="notice-body">まだドメインが接続されていません。管理者に初期設定を依頼してください。</p>
				</div>
			</div>
		{:else if !data.providerConfigured || data.loadError}
			<div class="surface-lg notice notice-warn">
				<Icon name={data.providerConfigured ? 'error-warning-line' : 'key-2-line'} size={18} />
				<div>
					<p class="notice-title">
						{data.providerConfigured ? 'ドメインを読み込めませんでした' : missingProviderTitle(data.providerKind)}
					</p>
					<p class="notice-body">{safeProviderError(data.loadError)}</p>
				</div>
			</div>
		{:else if connectable.length === 0}
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
			<DomainPicker domains={connectable} bind:selected />

			{#if error}<p class="error">{error}</p>{/if}

			<button
				type="button"
				class="btn-primary w-full py-2.5 mt-4"
				disabled={connecting}
				onclick={connectDomains}
			>
				{connecting
					? '接続中…'
					: `ドメイン${selected.length}件で続行`}
			</button>
		{/if}
	{:else}
		<form class="surface-lg address-card" onsubmit={claimAddress}>
				<AddressField
					bind:localPart
					bind:domainId={addressDomainId}
					domains={data.domains}
					label="メールアドレス"
					placeholder="info"
				/>

			{#if cleanLocal && activeDomain}
				<p class="preview">
					<strong>{cleanLocal}@{activeDomain.name}</strong>として送受信します。
				</p>
			{/if}

			{#if activeDomain && !activeDomain.receiving_enabled}
				<p class="hint">
					<Icon name="information-line" size={14} />
					{activeDomain.name}では受信が有効になっていません。送信はできますが、受信メールは届きません。
				</p>
			{/if}

			{#if error}<p class="error">{error}</p>{/if}

			<button
				type="submit"
				class="btn-primary w-full py-2.5 mt-4"
				disabled={creating || !cleanLocal}
			>
			{creating ? '作成中…' : '受信トレイへ'}
			</button>
		</form>

		{#if data.isAdmin && data.available.some((domain) => !domain.connected)}
			<p class="footnote">
				複数のドメインを使いますか？<a href="/admin">管理画面</a>からいつでも接続できます。
			</p>
		{/if}
	{/if}
</WizardShell>

<style>
	.address-card {
		padding: 1.5rem;
	}

	.preview {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.notice {
		display: flex;
		gap: 0.75rem;
		padding: 1.25rem;
		color: var(--color-text-secondary);
	}

	.notice-warn {
		box-shadow: 0 0 0 1px var(--tone-notice-line), var(--shadow-sm);
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

	.footnote {
		margin-top: 1rem;
		text-align: center;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.footnote a {
		color: var(--color-text-secondary);
		text-decoration: underline;
	}
</style>
