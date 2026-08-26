<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import {
		deletePushSubscription,
		getPushSubscription,
		isPushSubscriptionRegistered,
		savePushSubscription,
		subscribeToPush,
		subscriptionUsesPublicKey,
		supportsWebPush
	} from '$lib/push-client';

	let {
		configured,
		publicKey
	}: {
		configured: boolean;
		publicKey: string | null;
	} = $props();

	type PushState =
		| 'loading'
		| 'unsupported'
		| 'unconfigured'
		| 'denied'
		| 'disabled'
		| 'enabled'
		| 'error';

	let pushState = $state<PushState>('loading');
	let pushBusy = $state(false);
	let pushError = $state('');
	const pushStatusLabel = $derived(
		({
			loading: '確認中',
			unsupported: '非対応',
			unconfigured: '設定が必要',
			denied: 'ブロック中',
			disabled: 'オフ',
			enabled: 'オン',
			error: 'エラー'
		} satisfies Record<PushState, string>)[pushState]
	);

	function pushErrorMessage(error: unknown): string {
		return '通知を更新できませんでした。ブラウザーの設定を確認してください。';
	}

	async function refreshPushState() {
		pushError = '';
		if (!configured || !publicKey) {
			pushState = 'unconfigured';
			return;
		}
		if (!supportsWebPush()) {
			pushState = 'unsupported';
			return;
		}
		if (Notification.permission === 'denied') {
			pushState = 'denied';
			return;
		}

		try {
			const subscription = await getPushSubscription();
			if (
				subscription &&
				Notification.permission === 'granted' &&
				subscriptionUsesPublicKey(subscription, publicKey) &&
				(await isPushSubscriptionRegistered(subscription))
			) {
				pushState = 'enabled';
			} else {
				pushState = 'disabled';
			}
		} catch (error) {
			pushState = 'error';
			pushError = pushErrorMessage(error);
		}
	}

	$effect(() => {
		void refreshPushState();
	});

	async function enableDesktopNotifications() {
		if (!publicKey || !supportsWebPush()) return;
		pushBusy = true;
		pushError = '';
		try {
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				pushState = permission === 'denied' ? 'denied' : 'disabled';
				pushError =
					permission === 'denied'
						? 'このブラウザーでは通知がブロックされています。サイトの設定で許可してください。'
						: '通知の許可が得られませんでした。';
				return;
			}

			const subscription = await subscribeToPush(publicKey);
			await savePushSubscription(subscription);
			pushState = 'enabled';
		} catch (error) {
			pushState = 'error';
			pushError = pushErrorMessage(error);
		} finally {
			pushBusy = false;
		}
	}

	async function disableDesktopNotifications() {
		pushBusy = true;
		pushError = '';
		try {
			const subscription = await getPushSubscription();
			if (subscription) {
				await deletePushSubscription(subscription);
				const removed = await subscription.unsubscribe();
				if (!removed) throw new Error('ブラウザーから通知登録を解除できませんでした。');
			}
			pushState = 'disabled';
		} catch (error) {
			pushState = 'error';
			pushError = pushErrorMessage(error);
		} finally {
			pushBusy = false;
		}
	}
</script>

<section class="surface-lg card">
	<div class="card-head">
		<div>
			<h2><Icon name="notification-3-line" size={18} /> 通知</h2>
			<p class="section-description">アプリを閉じた後でも、新着メールを通知します。</p>
		</div>
		<span class="badge" class:notification-on={pushState === 'enabled'}>{pushStatusLabel}</span>
	</div>

	{#if pushState === 'unconfigured'}
		<p class="hint">
			<Icon name="information-line" size={14} />
			通知を有効にするには、サーバーにVAPIDキーが必要です。
		</p>
	{:else if pushState === 'unsupported'}
		<p class="hint">
			<Icon name="information-line" size={14} />
			このブラウザーはWeb Push通知に対応していません。
		</p>
	{:else if pushState === 'denied'}
		<p class="hint">
			<Icon name="information-line" size={14} />
			通知がブロックされています。ブラウザーの設定でこのサイトの通知を許可してください。
		</p>
	{:else}
		<div class="notification-controls">
			<p class="hint notification-hint">
				{pushState === 'enabled'
					? 'このブラウザーでアカウントの通知を受け取ります。'
					: '通知を有効にするときだけ許可を求めます。'}
			</p>
			{#if pushState === 'enabled'}
				<button
					type="button"
					class="btn-ghost"
					disabled={pushBusy}
					onclick={disableDesktopNotifications}
				>
					{pushBusy ? '無効化中…' : '無効にする'}
				</button>
			{:else}
				<button
					type="button"
					class="btn-primary"
					disabled={pushBusy || pushState === 'loading'}
					onclick={enableDesktopNotifications}
				>
					{pushBusy ? '有効化中…' : pushState === 'loading' ? '確認中…' : '有効にする'}
				</button>
			{/if}
		</div>
	{/if}

	{#if pushError}<p class="error" aria-live="polite">{pushError}</p>{/if}
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
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		background: var(--color-surface-muted);
	}

	.notification-on {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.notification-controls {
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

	.notification-hint {
		margin-top: 0;
	}

	.error {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}
</style>
