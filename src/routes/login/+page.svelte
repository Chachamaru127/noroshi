<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';
	import { discardPushSubscriptionFromAnotherAccount } from '$lib/push-client';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	function safeLoginError(value: unknown): string {
		if (typeof value !== 'string') return 'ログインに失敗しました。';
		if (value.includes('Email and password are required')) return 'メールアドレスとパスワードを入力してください。';
		if (value.includes('Invalid email or password')) return 'メールアドレスまたはパスワードが正しくありません。';
		if (value.includes('Database unavailable')) return 'データベースを利用できません。';
		return 'ログインに失敗しました。';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		loading = true;

		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password })
			});
			const data = await res.json();
			if (!res.ok) {
				error = safeLoginError(data.error);
				return;
			}
			try {
				await discardPushSubscriptionFromAnotherAccount();
			} catch (pushError) {
				console.warn('Could not reconcile the existing push subscription after login', pushError);
			}
			window.location.href = '/inbox';
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
		<title>ログイン — QuickMail-ja</title>
</svelte:head>

<div class="auth-shell">
	<div class="auth-card">
		<div class="auth-brand">
			<div class="brand-icon"><Logo size={48} /></div>
			<h1>ログイン</h1>
		</div>

		<form class="mt-8 space-y-4" onsubmit={submit}>
			<div>
				<label for="email" class="text-sm text-[var(--color-text-secondary)]">メールアドレス</label>
				<input id="email" type="email" bind:value={email} required autocomplete="username" class="auth-input" />
			</div>
			<div>
				<label for="password" class="text-sm text-[var(--color-text-secondary)]">パスワード</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
					class="auth-input"
				/>
			</div>

			{#if error}
				<p class="text-sm text-[var(--color-text-secondary)]">{error}</p>
			{/if}

			<button type="submit" disabled={loading} class="btn-primary mt-2 w-full py-2.5">
				{loading ? 'ログイン中…' : 'ログイン'}
			</button>
		</form>
	</div>
</div>

<style>
	.auth-brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.brand-icon {
		display: flex;
		margin-bottom: 1rem;
		/* Matches the mark's own corner radius so the shadow hugs the tile. */
		border-radius: 0.775rem;
		box-shadow: var(--shadow-sm);
	}
</style>
