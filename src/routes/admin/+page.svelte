<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import StackHeader from '$lib/components/StackHeader.svelte';
	import AddressField from '$lib/components/AddressField.svelte';
	import { displayMailSubject } from '$lib/mail-ui-copy';
	import { domainStatusLabel, safeProviderError } from '$lib/provider-copy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let localPart = $state('');
	let newUserDomainId = $state('');
	let name = $state('');
	let password = $state('');

	$effect(() => {
		if (!newUserDomainId && data.domains[0]) {
			newUserDomainId = data.domains[0].id;
		}
	});
	let userError = $state('');
	let creatingUser = $state(false);

	let connecting = $state<string | null>(null);
	let domainError = $state('');
	let inboundImportFiles = $state<File[]>([]);
	let outboundImportFiles = $state<File[]>([]);
	let importMailboxAddress = $state('');
	let importingOutlook = $state(false);
	let importProgress = $state('');
	let importResult = $state('');
	let importError = $state('');

	const connectable = $derived(data.available.filter((domain) => !domain.connected));
	const ownAddresses = $derived(
		data.addresses.filter((address) => address.user_id === data.currentUserId)
	);

	$effect(() => {
		if (!importMailboxAddress && ownAddresses[0]) {
			importMailboxAddress = ownAddresses.find((address) => address.is_default)?.address ?? ownAddresses[0].address;
		}
	});

	function safeAdminError(value: unknown): string {
		if (typeof value !== 'string') return '処理を完了できませんでした。';
		if (value.includes('Name, address, and domain are required')) return '名前、アドレス、ドメインを入力してください。';
		if (value.includes('Password is required')) return 'パスワードを入力してください。';
		if (value.includes('Password must be at least 8 characters')) return 'パスワードは8文字以上で入力してください。';
		if (value.includes('Domain is not connected') || value.includes('Domain not connected')) return 'ドメインが接続されていません。';
		if (value.includes('Failed to create user')) return 'ユーザーを作成できませんでした。';
		if (value.includes('Could not connect that domain') || value.includes('Failed to connect domain')) return 'ドメインを接続できませんでした。';
		if (value.includes('Update failed') || value.includes('Failed to refresh domain')) return '更新できませんでした。';
		if (value.includes('Database unavailable')) return 'データベースを利用できません。';
		return '処理を完了できませんでした。';
	}

	function addressesFor(domainId: string) {
		return data.addresses.filter((address) => address.domain_id === domainId);
	}

	function userLabel(userId: string | null) {
		if (!userId) return 'なし（未振り分けメールは保留）';
		const match = data.users.find((user) => user.id === userId);
		return match ? `${match.name}（${match.email}）` : '不明なユーザー';
	}

	async function createUser(event: SubmitEvent) {
		event.preventDefault();
		userError = '';
		creatingUser = true;

		try {
			const res = await fetch('/api/admin/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, localPart, domainId: newUserDomainId, password })
			});
			const body = await res.json();
			if (!res.ok) {
				userError = safeAdminError(body.error);
				return;
			}
			window.location.reload();
		} catch {
			userError = 'ネットワークエラーが発生しました。';
		} finally {
			creatingUser = false;
		}
	}

	async function connect(domainId: string) {
		connecting = domainId;
		domainError = '';

		try {
			const res = await fetch('/api/domains', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainId })
			});
			const body = await res.json();
			if (!res.ok) {
				domainError = safeAdminError(body.error);
				return;
			}
			window.location.reload();
		} catch {
			domainError = 'ネットワークエラーが発生しました。';
		} finally {
			connecting = null;
		}
	}

	async function updateDomain(domainId: string, patch: Record<string, unknown>) {
		domainError = '';
		const res = await fetch(`/api/domains/${domainId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});
		const body = await res.json();
		if (!res.ok) {
			domainError = safeAdminError(body.error);
			return;
		}
		window.location.reload();
	}

	async function disconnect(domainId: string, domainName: string) {
		if (!confirm(`${domainName}の利用をこのダッシュボードから停止しますか？すでに受信したメールは保持されます。`)) {
			return;
		}

		const res = await fetch(`/api/domains/${domainId}`, { method: 'DELETE' });
		if (res.ok) window.location.reload();
	}

	async function importOutlook(event: SubmitEvent) {
		event.preventDefault();
		importError = '';
		importResult = '';
		importingOutlook = true;

		try {
			const candidates = [
				...inboundImportFiles.map((file) => ({ file, direction: 'inbound' as const })),
				...outboundImportFiles.map((file) => ({ file, direction: 'outbound' as const }))
			];
			const unique = [] as typeof candidates;
			const hashes = new Set<string>();
			for (let index = 0; index < candidates.length; index += 1) {
				importProgress = `重複を確認中 ${index + 1}/${candidates.length}`;
				const digest = await crypto.subtle.digest('SHA-256', await candidates[index].file.arrayBuffer());
				const hash = [...new Uint8Array(digest)]
					.map((byte) => byte.toString(16).padStart(2, '0'))
					.join('');
				if (!hashes.has(hash)) {
					hashes.add(hash);
					unique.push(candidates[index]);
				}
			}

			const dated = await Promise.all(
				unique.map(async (entry) => ({ ...entry, timestamp: await emlTimestamp(entry.file) }))
			);
			dated.sort((a, b) => a.timestamp - b.timestamp || a.file.name.localeCompare(b.file.name));

			let imported = 0;
			let skipped = 0;
			const failures: string[] = [];
			for (let index = 0; index < dated.length; index += 1) {
				const entry = dated[index];
				importProgress = `取り込み中 ${index + 1}/${dated.length}`;
				const form = new FormData();
				form.set('file', entry.file);
				form.set('direction', entry.direction);
				form.set('mailboxAddress', importMailboxAddress);
				try {
					const response = await fetch('/api/admin/import-outlook', { method: 'POST', body: form });
					const body = await response.json();
					if (!response.ok) throw new Error(body.error || 'import_failed');
					if (body.imported) imported += 1;
					else skipped += 1;
				} catch {
					failures.push(entry.file.name);
				}
			}

			if (failures.length > 0) {
				importError = `${failures.length}通を取り込めませんでした。最初の失敗: ${failures[0]}`;
			} else {
				importResult = `${imported}通を取り込みました。重複または取込済み: ${candidates.length - unique.length + skipped}通`;
			}
		} finally {
			importingOutlook = false;
			importProgress = '';
		}
	}

	async function emlTimestamp(file: File): Promise<number> {
		const header = (await file.slice(0, 128 * 1024).text()).replace(/\r?\n[ \t]+/g, ' ');
		const value = header.match(/^Date:\s*(.+)$/im)?.[1]?.trim();
		const parsed = value ? Date.parse(value) : Number.NaN;
		return Number.isFinite(parsed) ? parsed : file.lastModified;
	}
</script>

<svelte:head>
		<title>管理 — QuickMail-ja</title>
</svelte:head>

<div class="admin-page">
		<StackHeader title="管理" back={false} />

	{#if data.loadError}
		<div class="surface-lg banner">
			<Icon name="error-warning-line" size={16} />
				<span>{safeProviderError(data.loadError)}</span>
		</div>
	{/if}

	<section class="surface-lg admin-card">
			<h2><Icon name="global-line" size={18} /> ドメイン</h2>
			<p class="card-hint">キャッチオールで一致しないメールを受け取ります。</p>

		<ul class="domain-list">
			{#each data.domains as domain (domain.id)}
				<li class="domain-item">
					<div class="domain-head">
						<div class="min-w-0">
							<p class="domain-name">{domain.name}</p>
							<p class="domain-sub">
								{addressesFor(domain.id).length}件のアドレス
								{#if domain.region}· {domain.region}{/if}
							</p>
						</div>
						<div class="chips">
							<span class="chip" class:chip-on={domain.sending_enabled}>送信</span>
							<span class="chip" class:chip-on={domain.receiving_enabled}>受信</span>
							<span class="chip" class:chip-ok={domain.status === 'verified'}>{domainStatusLabel(domain.status)}</span>
						</div>
					</div>

					<div class="domain-controls">
						<label class="control">
							<span class="control-label">キャッチオール</span>
							<select
								value={domain.catchall_user_id ?? ''}
								onchange={(event) =>
									updateDomain(domain.id, {
										catchallUserId: (event.currentTarget as HTMLSelectElement).value || null
									})}
							>
								<option value="">なし（未振り分けとして保留）</option>
								{#each data.users as user (user.id)}
									<option value={user.id}>{user.name} — {user.email}</option>
								{/each}
							</select>
						</label>

						<div class="control-actions">
							<button
								type="button"
								class="btn-ghost text-xs"
								onclick={() => updateDomain(domain.id, { refresh: true })}
							>
								<Icon name="refresh-line" size={14} /> 再同期
							</button>
							<button
								type="button"
								class="btn-ghost text-xs"
								onclick={() => disconnect(domain.id, domain.name)}
							>
								接続を解除
							</button>
						</div>
					</div>

					{#if !domain.receiving_enabled}
						<p class="hint">
							<Icon name="information-line" size={13} />
							受信が無効です
							。Cloudflare Email RoutingのキャッチオールをこのWorkerに向けてください。
						</p>
					{/if}
					{#if domain.catchall_user_id}
						<p class="hint">
							<Icon name="user-received-line" size={13} />
							{userLabel(domain.catchall_user_id)}に振り分けます。
						</p>
					{/if}
				</li>
			{/each}
		</ul>

		{#if connectable.length > 0}
			<div class="connect-block">
				<p class="connect-title">
						{data.providerKind === 'cloudflare' ? 'Cloudflare Email' : 'Resendで送信'}に利用可能
				</p>
				<ul class="connect-list">
					{#each connectable as domain (domain.id)}
						<li class="connect-row">
							<div class="min-w-0">
								<p class="domain-name">{domain.name}</p>
						<p class="domain-sub">{domainStatusLabel(domain.status)}{#if domain.region} · {domain.region}{/if}</p>
							</div>
							<button
								type="button"
								class="btn-primary text-xs"
								disabled={connecting === domain.id}
								onclick={() => connect(domain.id)}
							>
							{connecting === domain.id ? '接続中…' : '接続'}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if domainError}<p class="error">{domainError}</p>{/if}
	</section>

	<div class="admin-grid">
		<section class="surface-lg admin-card">
			<h2><Icon name="user-add-line" size={18} /> 新しいユーザー</h2>
			<p class="card-hint">アドレスがログインIDになります。</p>
			<form class="mt-4 space-y-3" onsubmit={createUser}>
				<input type="text" bind:value={name} required placeholder="表示名" class="admin-input" />
				<AddressField
					bind:localPart
					bind:domainId={newUserDomainId}
					domains={data.domains}
					placeholder="info"
					label="メールアドレス"
				/>
				<input
					type="text"
					bind:value={password}
					required
					minlength="8"
					placeholder="仮パスワード"
					class="admin-input"
				/>

				{#if userError}<p class="error">{userError}</p>{/if}

				<button type="submit" disabled={creatingUser} class="btn-primary">
					{creatingUser ? '作成中…' : '作成'}
				</button>
			</form>
		</section>

		<section class="surface-lg admin-card">
			<h2><Icon name="group-line" size={18} /> ユーザー {data.users.length}人</h2>
			<ul class="user-list">
				{#each data.users as user (user.id)}
					<li class="user-row">
						<div class="user-avatar">{(user.name[0] ?? '?').toUpperCase()}</div>
						<div class="min-w-0 flex-1">
							<p class="user-name">{user.name}</p>
							<p class="user-email">
								{data.addresses
									.filter((address) => address.user_id === user.id)
									.map((address) => address.address)
									.join(', ') || user.email}
							</p>
						</div>
						{#if user.is_admin}
						<span class="admin-badge">管理者</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	</div>

	<section class="surface-lg admin-card">
		<h2><Icon name="archive-stack-line" size={18} /> Outlookメール移行</h2>
		<p class="card-hint">
			保存済みのEMLを日時順に取り込みます。取り込み中は通知・自動転送・外部送信を行いません。
		</p>
		<form class="import-form" onsubmit={importOutlook}>
			<label class="control">
				<span class="control-label">反映先アドレス</span>
				<select bind:value={importMailboxAddress} required>
					{#each ownAddresses as address (address.id)}
						<option value={address.address}>{address.address}</option>
					{/each}
				</select>
			</label>
			<div class="import-files">
				<label class="file-picker">
					<span>受信・アーカイブのEML</span>
					<input
						type="file"
						accept=".eml,message/rfc822"
						multiple
						onchange={(event) =>
							(inboundImportFiles = Array.from(event.currentTarget.files ?? []))}
					/>
					<small>{inboundImportFiles.length}ファイル</small>
				</label>
				<label class="file-picker">
					<span>送信済みのEML</span>
					<input
						type="file"
						accept=".eml,message/rfc822"
						multiple
						onchange={(event) =>
							(outboundImportFiles = Array.from(event.currentTarget.files ?? []))}
					/>
					<small>{outboundImportFiles.length}ファイル</small>
				</label>
			</div>
			<button
				type="submit"
				class="btn-primary"
				disabled={importingOutlook || !importMailboxAddress || inboundImportFiles.length + outboundImportFiles.length === 0}
			>
				{importingOutlook ? importProgress || '準備中…' : 'メールを取り込む'}
			</button>
			{#if importResult}<p class="success">{importResult}</p>{/if}
			{#if importError}<p class="error">{importError}</p>{/if}
		</form>
	</section>

	{#if data.unrouted.length > 0}
		<section class="surface-lg admin-card">
			<h2><Icon name="question-mark" size={18} /> 未振り分けメール</h2>
			<p class="card-hint">一致するアドレスまたはキャッチオールがありません。</p>
			<ul class="user-list">
				{#each data.unrouted as item (item.id)}
					<li class="user-row">
						<div class="min-w-0 flex-1">
						<p class="user-name">{displayMailSubject(item.subject)}</p>
							<p class="user-email">{item.from_addr} → {item.to_addr}</p>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.admin-page :global(.stack-header) {
		margin-bottom: 0;
	}

	.banner {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		padding: 0.875rem 1.125rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		box-shadow: 0 0 0 1px var(--tone-notice-line), var(--shadow-sm);
	}

	.admin-grid {
		display: grid;
		gap: 1.25rem;
		margin-top: 1.25rem;
	}

	@media (min-width: 900px) {
		.admin-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	.admin-card {
		margin-top: 1.25rem;
		padding: 1.5rem;
	}

	.admin-grid .admin-card {
		margin-top: 0;
	}

	.admin-card h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.domain-list {
		margin-top: 1rem;
	}

	.domain-item {
		padding: 1rem 0;
	}

	.domain-item + .domain-item {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.domain-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.domain-name {
		font-size: 0.9375rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.domain-sub {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.chips {
		display: flex;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.chip {
		padding: 0.0625rem 0.4375rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		color: var(--color-muted);
		background: var(--color-surface-muted);
	}

	.chip-on {
		color: var(--color-text-secondary);
	}

	.chip-ok {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.domain-controls {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.875rem;
	}

	.control {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
	}

	.control-label {
		font-size: 0.6875rem;
		color: var(--color-muted);
	}

	.control select {
		max-width: 100%;
		padding: 0.4375rem 0.625rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
		outline: none;
		cursor: pointer;
	}

	.control-actions {
		display: flex;
		gap: 0.25rem;
	}

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.connect-block {
		margin-top: 1.25rem;
		padding-top: 1rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.connect-title {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-muted);
	}

	.connect-list {
		margin-top: 0.625rem;
	}

	.connect-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0;
	}

	.admin-input {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.admin-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.user-list {
		margin-top: 1rem;
	}

	.user-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0;
	}

	.user-row + .user-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.user-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
	}

	.user-name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.user-email {
		font-size: 0.8125rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.admin-badge {
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.error {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}

	.import-form {
		display: grid;
		gap: 1rem;
		margin-top: 1rem;
	}

	.import-files {
		display: grid;
		gap: 0.75rem;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.file-picker {
		display: grid;
		gap: 0.375rem;
		padding: 0.875rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.file-picker input {
		max-width: 100%;
		font-size: 0.75rem;
	}

	.file-picker small {
		color: var(--color-muted);
	}

	.success {
		font-size: 0.8125rem;
		color: var(--tone-good-fg);
	}

	@media (max-width: 900px) {
		.admin-card {
			padding: 1.25rem 1rem;
			box-shadow: none;
		}
	}
</style>
