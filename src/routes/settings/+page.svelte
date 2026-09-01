<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StackHeader from '$lib/components/StackHeader.svelte';
	import Check from '$lib/components/Check.svelte';
	import AddressField from '$lib/components/AddressField.svelte';
	import DesktopNotifications from '$lib/components/DesktopNotifications.svelte';
	import InstallApp from '$lib/components/InstallApp.svelte';
	import SortRuleSettings from '$lib/components/SortRuleSettings.svelte';
	import {
		readThemePreference,
		setThemePreference,
		THEME_OPTIONS,
		type ThemePreference
	} from '$lib/theme';
	import { MAX_EMAIL_SIGNATURE_LENGTH } from '$lib/email-signature';
	import { domainStatusLabel } from '$lib/provider-copy';
	import {
		canApplyForwardingRefreshOutcome,
		canDisableForwarding,
		forwardingAttemptStatus,
		forwardingStatus,
		isCurrentForwardingRefresh,
		isForwardingDestinationChanged,
		replaceForwardingItemBySource,
		reconcileForwardingInteraction,
		safeForwardingError,
		scopeLabel,
		type ForwardingAttemptStatus,
		type ForwardingRefreshOutcome,
		type ForwardingStatusCopy
	} from '$lib/settings-forwarding';
	import type { ApiTokenSummary, MailAddress } from '$lib/types';
	import type { PageData } from './$types';

	type ForwardingDestinationState = {
		id: string;
		destination_address: string;
		status: 'pending' | 'verified';
		verification_expires_at: string | null;
		verification_used_at: string | null;
		verified_at: string | null;
	};

	type ForwardingRuleState = {
		id: string;
		destination_id: string;
		status: 'disabled' | 'enabled';
	};

	type ForwardingAttemptState = {
		status: ForwardingAttemptStatus;
		attempt_count: number;
		error_code: string | null;
		next_attempt_at: string | null;
		last_attempt_at: string | null;
	};

	type ForwardingItem = {
		source_address: MailAddress;
		destination: ForwardingDestinationState | null;
		rule: ForwardingRuleState | null;
		latest_attempt: ForwardingAttemptState | null;
	};

	let { data }: { data: PageData } = $props();

	// The preference lives in localStorage, so it can only be read on the client.
	let theme = $state<ThemePreference>('system');
	$effect(() => {
		theme = readThemePreference();
	});

	function chooseTheme(next: ThemePreference) {
		theme = next;
		setThemePreference(next);
	}

	let signature = $state(untrack(() => data.signature));
	let signatureBusy = $state(false);
	let signatureError = $state('');
	let signatureSaved = $state(false);

	let forwarding = $state<ForwardingItem[]>(untrack(() => data.forwarding as ForwardingItem[]));
	let forwardingSourceId = $state(
		untrack(() => data.addresses.find((address) => address.can_send !== false)?.id ?? '')
	);
	let forwardingDestination = $state(
		untrack(() => data.forwarding[0]?.destination?.destination_address ?? '')
	);
	let forwardingBusy = $state(false);
	let forwardingAction = $state('');
	let forwardingError = $state('');
	let forwardingSaved = $state('');
	let forwardingAcknowledged = $state(false);
	let forwardingRefreshBusy = $state(false);
	let forwardingRefreshError = $state('');
	let forwardingRefreshGeneration = 0;
	let forwardingRefreshRequest: {
		generation: number;
		promise: Promise<ForwardingRefreshResult>;
	} | null = null;

	type ForwardingRefreshResult = {
		generation: number;
		outcome: ForwardingRefreshOutcome;
	};

	const selectedForwarding = $derived(
		forwarding.find((item) => item.source_address.id === forwardingSourceId) ?? null
	);
	const selectedForwardingStatus = $derived<ForwardingStatusCopy>(
		forwardingStatus({
			destinationStatus: selectedForwarding?.destination?.status,
			ruleStatus: selectedForwarding?.rule?.status,
			attemptStatus: selectedForwarding?.latest_attempt?.status
		})
	);
	const selectedAttemptStatus = $derived(
		selectedForwarding?.latest_attempt
			? forwardingAttemptStatus(
					selectedForwarding.latest_attempt.status,
					selectedForwarding.latest_attempt.next_attempt_at
				)
			: null
	);
	const forwardingDestinationChanged = $derived(
		isForwardingDestinationChanged(
			selectedForwarding?.destination?.destination_address,
			forwardingDestination
		)
	);
	const canEnableForwarding = $derived(
		Boolean(
			selectedForwarding?.rule &&
			selectedForwarding.destination?.status === 'verified' &&
			selectedForwarding.rule.status !== 'enabled' &&
			!forwardingDestinationChanged &&
			forwardingAcknowledged
		)
	);

	function safeSettingsError(value: unknown, fallback: string): string {
		if (typeof value !== 'string') return fallback;
		if (value.includes('Signature must be text')) return '署名はテキストで入力してください。';
		if (value.includes('Signature must be')) return '署名が長すぎます。';
		if (value.includes('Could not save signature')) return '署名を保存できませんでした。';
		if (value.includes('Could not create the API key')) return 'APIキーを作成できませんでした。';
		if (value.includes('Could not revoke that key')) return 'APIキーを無効化できませんでした。';
		if (value.includes('Could not add that address')) return 'アドレスを追加できませんでした。';
		if (value.includes('Could not save that name')) return '名前を保存できませんでした。';
		if (value.includes('Could not save that signature')) return '署名を保存できませんでした。';
		if (value.includes('Could not remove that address')) return 'アドレスを削除できませんでした。';
		if (value.includes('Keep at least one address')) return 'アドレスを1件以上残してください。';
		if (value.includes('Database unavailable')) return 'データベースを利用できません。';
		return fallback;
	}

	function selectForwardingSource(id: string) {
		forwardingSourceId = id;
		const item = forwarding.find((entry) => entry.source_address.id === id);
		forwardingDestination = item?.destination?.destination_address ?? '';
		forwardingAcknowledged = false;
		forwardingError = '';
		forwardingSaved = '';
	}

	function updateForwardingItem(next: ForwardingItem) {
		forwarding = forwarding.map((item) =>
			item.source_address.id === next.source_address.id ? next : item
		);
	}

	function removeForwardingSource(sourceAddressId: string) {
		const next = forwarding.filter((item) => item.source_address.id !== sourceAddressId);
		forwarding = next;
		if (forwardingSourceId === sourceAddressId) {
			const replacement = next[0] ?? null;
			forwardingSourceId = replacement?.source_address.id ?? '';
			forwardingDestination = replacement?.destination?.destination_address ?? '';
			forwardingAcknowledged = false;
		}
	}

	function reportAddressMutationRefreshFailure(action: 'added' | 'removed') {
		forwardingRefreshError =
			action === 'removed'
				? 'アドレスは削除されましたが、自動転送の状態を更新できませんでした。残りのアドレスを設定する前に「状態を更新」を実行してください。'
				: 'アドレスは追加されましたが、自動転送の状態を更新できませんでした。設定する前に「状態を更新」を実行してください。';
	}

	function applyForwardingSnapshot(next: ForwardingItem[], preserveInteraction = true) {
		const current = forwarding.find((item) => item.source_address.id === forwardingSourceId);
		const nextForCurrentSource = next.find((item) => item.source_address.id === forwardingSourceId);
		const interaction = reconcileForwardingInteraction({
			currentDestination: current?.destination?.destination_address,
			nextDestination: nextForCurrentSource?.destination?.destination_address,
			draftDestination: forwardingDestination,
			acknowledged: forwardingAcknowledged,
			sourceStillSelected: Boolean(nextForCurrentSource),
			preserveInteraction
		});

		forwarding = next;
		if (!nextForCurrentSource) {
			forwardingSourceId = next[0]?.source_address.id ?? '';
		}
		forwardingDestination = nextForCurrentSource
			? interaction.destination
			: next[0]?.destination?.destination_address ?? '';
		forwardingAcknowledged = nextForCurrentSource ? interaction.acknowledged : false;
	}

	async function readForwardingBody(response: Response): Promise<Record<string, unknown>> {
		return (await response.json().catch(() => ({}))) as Record<string, unknown>;
	}

	function invalidateForwardingRefresh() {
		forwardingRefreshGeneration += 1;
		forwardingRefreshBusy = false;
		forwardingRefreshError = '';
	}

	async function reconcileForwardingState(options: {
		forceFresh?: boolean;
		preserveInteraction?: boolean;
	} = {}): Promise<ForwardingRefreshResult> {
		const forceFresh = options.forceFresh ?? false;
		const preserveInteraction = options.preserveInteraction ?? true;
		if (!forceFresh && forwardingRefreshRequest?.generation === forwardingRefreshGeneration) {
			return forwardingRefreshRequest.promise;
		}

		const generation = forceFresh
			? ++forwardingRefreshGeneration
			: forwardingRefreshGeneration;
		const request: Promise<ForwardingRefreshResult> = (async () => {
			try {
				const response = await fetch('/api/forwarding');
				const result = await readForwardingBody(response);
				if (!isCurrentForwardingRefresh(generation, forwardingRefreshGeneration)) {
					return { generation, outcome: 'stale' };
				}
				if (!response.ok || !Array.isArray(result.forwarding)) {
					return { generation, outcome: 'failed' };
				}
				applyForwardingSnapshot(result.forwarding as ForwardingItem[], preserveInteraction);
				return { generation, outcome: 'applied' };
			} catch {
				return {
					generation,
					outcome: isCurrentForwardingRefresh(generation, forwardingRefreshGeneration)
						? 'failed'
						: 'stale'
				};
			}
		})();
		const requestRecord = { generation, promise: request };
		forwardingRefreshRequest = requestRecord;

		try {
			return await request;
		} finally {
			if (forwardingRefreshRequest === requestRecord) forwardingRefreshRequest = null;
		}
	}

	async function refreshForwardingStatus() {
		if (forwardingBusy || forwardingRefreshBusy) return;
		const generation = forwardingRefreshGeneration;
		forwardingRefreshBusy = true;
		forwardingRefreshError = '';
		const result = await reconcileForwardingState();
		if (!isCurrentForwardingRefresh(generation, forwardingRefreshGeneration)) return;
		forwardingRefreshBusy = false;
		if (result.outcome === 'failed') {
			forwardingRefreshError = '自動転送の状態を更新できませんでした。もう一度お試しください。';
		}
	}

	$effect(() => {
		const onWindowFocus = () => {
			void refreshForwardingStatus();
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') void refreshForwardingStatus();
		};

		window.addEventListener('focus', onWindowFocus);
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			window.removeEventListener('focus', onWindowFocus);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});

	function forwardingErrorAfterReconcile(error: unknown, reconciled: ForwardingRefreshResult): string {
		const message = safeForwardingError(error);
		return reconciled.outcome === 'failed'
			? `${message}現在の状態を更新できませんでした。「設定」を再読み込みして確認してください。`
			: message;
	}

	async function saveForwardingDestination(event: SubmitEvent) {
		event.preventDefault();
		if (!forwardingSourceId || !forwardingDestination.trim()) {
			forwardingError = '転送元アドレスを選択し、転送先を入力してください。';
			return;
		}

		const current = selectedForwarding;
		const isNew = !current?.destination;
		const isPendingResend = current?.destination?.status === 'pending' && !forwardingDestinationChanged;
		const endpoint = isNew || isPendingResend
			? '/api/forwarding/destinations'
			: `/api/forwarding/rules/${current.rule?.id ?? ''}`;
		const body = isNew || isPendingResend
			? { sourceAddressId: forwardingSourceId, destination: forwardingDestination }
			: { destination: forwardingDestination };

		invalidateForwardingRefresh();
		forwardingBusy = true;
		forwardingAction = 'save';
		forwardingError = '';
		forwardingSaved = '';
		try {
			const response = await fetch(endpoint, {
				method: isNew || isPendingResend ? 'POST' : 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = await readForwardingBody(response);
			if (!response.ok) {
				const reconciled = await reconcileForwardingState({
					forceFresh: true,
					preserveInteraction: true
				});
				forwardingError = forwardingErrorAfterReconcile(result.error, reconciled);
				return;
			}

			if (result.forwarding && typeof result.forwarding === 'object') {
				updateForwardingItem(result.forwarding as ForwardingItem);
			} else if (current && result.destination && result.rule) {
				updateForwardingItem({
					...current,
					destination: result.destination as ForwardingDestinationState,
					rule: result.rule as ForwardingRuleState
				});
			}
			await reconcileForwardingState({ forceFresh: true, preserveInteraction: false });
			forwardingAcknowledged = false;
				forwardingSaved = result.verification_sent
					? '確認メールを送信しました。自動転送を有効にする前に、転送先の受信トレイを確認してください。'
					: '自動転送先を保存しました。';
		} catch {
			const reconciled = await reconcileForwardingState({
				forceFresh: true,
				preserveInteraction: true
			});
				forwardingError =
					reconciled.outcome === 'failed'
						? '自動転送の更新中にネットワークエラーが発生しました。現在の状態を更新できませんでした。「設定」を再読み込みして確認してください。'
						: '自動転送の更新中にネットワークエラーが発生しました。';
		} finally {
			forwardingBusy = false;
			forwardingAction = '';
		}
	}

	async function setForwardingEnabled(enabled: boolean) {
		const current = selectedForwarding;
		const rule = current?.rule;
		if (!rule) return;
		if (enabled && !canEnableForwarding) return;

		invalidateForwardingRefresh();
		forwardingBusy = true;
		forwardingAction = enabled ? 'enable' : 'disable';
		forwardingError = '';
		forwardingSaved = '';
		try {
			const response = await fetch(`/api/forwarding/rules/${rule.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			const result = await readForwardingBody(response);
			if (!response.ok) {
				const reconciled = await reconcileForwardingState({
					forceFresh: true,
					preserveInteraction: true
				});
				forwardingError = forwardingErrorAfterReconcile(result.error, reconciled);
				return;
			}
			if (result.rule) {
				forwarding = replaceForwardingItemBySource(
					forwarding,
					current.source_address.id,
					(item) => ({ ...item, rule: result.rule as ForwardingRuleState })
				);
			}
			await reconcileForwardingState({ forceFresh: true, preserveInteraction: false });
			forwardingAcknowledged = false;
				forwardingSaved = enabled ? '自動転送を有効にしました。' : '自動転送を無効にしました。';
		} catch {
			const reconciled = await reconcileForwardingState({
				forceFresh: true,
				preserveInteraction: true
			});
				forwardingError =
					reconciled.outcome === 'failed'
						? '自動転送の更新中にネットワークエラーが発生しました。現在の状態を更新できませんでした。「設定」を再読み込みして確認してください。'
						: '自動転送の更新中にネットワークエラーが発生しました。';
		} finally {
			forwardingBusy = false;
			forwardingAction = '';
		}
	}

	async function saveSignature(event: SubmitEvent) {
		event.preventDefault();
		signatureBusy = true;
		signatureError = '';
		signatureSaved = false;

		try {
			const res = await fetch('/api/settings/signature', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ signature })
			});
			const body = await res.json();
				if (!res.ok) {
					signatureError = safeSettingsError(body.error, '署名を保存できませんでした。');
				return;
			}

			signature = body.signature;
			signatureSaved = true;
		} catch {
			signatureError = 'ネットワークエラーが発生しました。';
		} finally {
			signatureBusy = false;
		}
	}

	// Server data until an edit happens, then whatever the API returned.
	let edited = $state<MailAddress[] | null>(null);
	const addresses = $derived(edited ?? data.addresses);

	let localPart = $state('');
	let displayName = $state('');
	let domainId = $state('');
	let error = $state('');
	let busy = $state(false);
	let savingId = $state('');

	let keyName = $state('');
	let sendScope = $state(true);
	let readScope = $state(true);
	let adminScope = $state(false);
	let tokens = $state<ApiTokenSummary[]>([]);
	let hydrated = $state(false);
	$effect(() => {
		if (!hydrated) {
			tokens = data.apiTokens;
			hydrated = true;
		}
	});
	let keyBusy = $state(false);
	let keyError = $state('');
	let creating = $state(false);
	let revealed = $state<{ summary: ApiTokenSummary; token: string } | null>(null);
	let copied = $state(false);

	const canCreateKey = $derived(
		Boolean(keyName.trim()) && (sendScope || readScope || (data.isAdmin && adminScope))
	);

	function openCreate() {
		keyName = '';
		sendScope = true;
		readScope = true;
		adminScope = false;
		keyError = '';
		revealed = null;
		copied = false;
		creating = true;
	}

	function closeCreate() {
		creating = false;
		revealed = null;
		copied = false;
		keyError = '';
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (creating && event.key === 'Escape' && !revealed) closeCreate();
	}

	async function createKey(event?: SubmitEvent) {
		if (event) event.preventDefault();
		keyBusy = true;
		keyError = '';
		try {
			const scopes = [];
			if (sendScope) scopes.push('mail:send');
			if (readScope) scopes.push('mail:read');
			if (data.isAdmin && adminScope) scopes.push('admin');

			const res = await fetch('/api/apikeys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: keyName, scopes })
			});
			const body = await res.json();
				if (!res.ok) {
					keyError = safeSettingsError(body.error, 'APIキーを作成できませんでした。');
				return;
			}
			tokens = [body.tokenMeta, ...tokens.filter((token) => token.id !== body.tokenMeta.id)];
			revealed = { summary: body.tokenMeta, token: body.token };
			copied = false;
			keyName = '';
		} catch {
			keyError = 'ネットワークエラーが発生しました。';
		} finally {
			keyBusy = false;
		}
	}

	async function copyKey() {
		if (!revealed) return;
		try {
			await navigator.clipboard.writeText(revealed.token);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard unavailable — the box is still selectable */
		}
	}

	async function revokeKey(id: string) {
		if (!confirm('このAPIキーを無効化しますか？')) return;
		const res = await fetch(`/api/apikeys/${id}`, { method: 'DELETE' });
		const body = await res.json();
		if (!res.ok) {
			keyError = safeSettingsError(body.error, 'APIキーを無効化できませんでした。');
			return;
		}
		tokens = body.tokens;
	}

	function formatDate(value: string): string {
		return new Date(value).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
	}

	$effect(() => {
		if (!domainId && data.domains[0]) {
			domainId = data.domains[0].id;
		}
	});

	const selectedDomain = $derived(data.domains.find((domain) => domain.id === domainId));

	async function addAddress(event: SubmitEvent) {
		event.preventDefault();
		invalidateForwardingRefresh();
		busy = true;
		error = '';

		try {
			const res = await fetch('/api/addresses', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainId, localPart, label: displayName.trim() || null })
			});
			const body = await res.json();
				if (!res.ok) {
					error = safeSettingsError(body.error, 'アドレスを追加できませんでした。');
				return;
			}
			edited = [...addresses, body.address];
			const reconciled = await reconcileForwardingState({
				forceFresh: true,
				preserveInteraction: true
			});
			if (
				canApplyForwardingRefreshOutcome(
					reconciled.outcome,
					reconciled.generation,
					forwardingRefreshGeneration
				)
			) {
				if (reconciled.outcome === 'applied') forwardingRefreshError = '';
				else reportAddressMutationRefreshFailure('added');
			}
			localPart = '';
			displayName = '';
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			busy = false;
		}
	}

	async function saveLabel(id: string, label: string) {
		const current = addresses.find((address) => address.id === id);
		if (!current || (current.label ?? '') === label.trim()) return;

		savingId = id;
		error = '';
		try {
			const res = await fetch(`/api/addresses/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label: label.trim() || null })
			});
			const body = await res.json();
				if (!res.ok) {
					error = safeSettingsError(body.error, '名前を保存できませんでした。');
				return;
			}
			edited = body.addresses;
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			savingId = '';
		}
	}

	async function makeDefault(id: string) {
		const res = await fetch(`/api/addresses/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ isDefault: true })
		});
		const body = await res.json();
		if (res.ok) edited = body.addresses;
	}

	async function saveMailboxSignature(id: string, value: string) {
		const current = addresses.find((address) => address.id === id);
		if (!current || (current.signature ?? '') === value.trim()) return;

		savingId = id;
		error = '';
		try {
			const res = await fetch(`/api/addresses/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ signature: value })
			});
			const body = await res.json();
				if (!res.ok) {
					error = safeSettingsError(body.error, '署名を保存できませんでした。');
				return;
			}
			edited = body.addresses;
		} catch {
			error = 'ネットワークエラーが発生しました。';
		} finally {
			savingId = '';
		}
	}

	async function remove(id: string) {
		invalidateForwardingRefresh();
		const res = await fetch(`/api/addresses/${id}`, { method: 'DELETE' });
		const body = await res.json();
		if (!res.ok) {
			error = safeSettingsError(body.error, 'アドレスを削除できませんでした。');
			return;
		}
		edited = body.addresses;
		removeForwardingSource(id);
		const reconciled = await reconcileForwardingState({
			forceFresh: true,
			preserveInteraction: true
		});
		if (
			canApplyForwardingRefreshOutcome(
				reconciled.outcome,
				reconciled.generation,
				forwardingRefreshGeneration
			)
		) {
			if (reconciled.outcome === 'applied') forwardingRefreshError = '';
			else reportAddressMutationRefreshFailure('removed');
		}
	}
</script>

<svelte:head>
	<title>設定 — Noroshi</title>
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="settings-page">
	<StackHeader title="設定" back={false} />

	<section class="surface-lg card">
		<h2><Icon name="contrast-2-line" size={18} /> 外観</h2>

		<div class="theme-options" role="radiogroup" aria-label="テーマ">
			{#each THEME_OPTIONS as option (option.value)}
				<button
					type="button"
					role="radio"
					aria-checked={theme === option.value}
					class="theme-option"
					class:selected={theme === option.value}
					onclick={() => chooseTheme(option.value)}
				>
					<span class="theme-preview theme-preview-{option.value}">
						<span class="preview-bar"></span>
						<span class="preview-line"></span>
						<span class="preview-line short"></span>
					</span>
					<span class="theme-label">
						<Icon name={option.icon} size={15} />
						{option.label}
					</span>
					{#if theme === option.value}
						<span class="theme-check"><Icon name="check-line" size={14} /></span>
					{/if}
				</button>
			{/each}
		</div>
	</section>

	<InstallApp />

	<DesktopNotifications configured={data.push.configured} publicKey={data.push.publicKey} />

	<section class="surface-lg card">
		<h2><Icon name="pencil-line" size={18} /> 署名</h2>
		<p class="card-hint">メールボックス固有の署名がない場合に使用します。</p>

		<form class="signature-form" onsubmit={saveSignature}>
			<textarea
				id="email-signature"
				bind:value={signature}
				maxlength={MAX_EMAIL_SIGNATURE_LENGTH}
				rows="3"
				placeholder={'よろしくお願いします。\n（署名）'}
				class="signature-input"
			></textarea>

			<div class="signature-actions">
				<span class="character-count">{signature.length}/{MAX_EMAIL_SIGNATURE_LENGTH}</span>
				<button type="submit" class="btn-primary" disabled={signatureBusy}>
					{signatureBusy ? '保存中…' : '保存'}
				</button>
			</div>

			{#if signatureError}<p class="error">{signatureError}</p>{/if}
				{#if signatureSaved}<p class="saved">保存しました</p>{/if}
		</form>
	</section>

	<section class="surface-lg card forwarding-card" aria-labelledby="automatic-forwarding-title">
		<h2 id="automatic-forwarding-title"><Icon name="arrow-left-right-line" size={18} /> 自動転送</h2>
		<p class="card-hint">
			新着メッセージと添付ファイルをNoroshiの外部へ転送します。自分で管理できる転送先を指定してください。
			Noroshiのアドレスや、同じ管理ドメイン内の転送先は指定できません。
		</p>

		{#if forwarding.length}
			<div class="forwarding-refresh-row">
				<button
					type="button"
					class="btn-ghost"
					aria-label="自動転送の状態を更新"
					aria-busy={forwardingRefreshBusy}
					disabled={forwardingBusy || forwardingRefreshBusy}
					onclick={() => void refreshForwardingStatus()}
				>
					<Icon name="refresh-line" size={15} />
						{forwardingRefreshBusy ? '更新中…' : '状態を更新'}
				</button>
				{#if forwardingRefreshBusy}
					<span class="hint" role="status" aria-live="polite">自動転送の状態を更新中…</span>
				{/if}
			</div>
			{#if forwardingRefreshError}
				<p class="error" role="alert" aria-live="assertive">{forwardingRefreshError}</p>
			{/if}
			<div class="forwarding-form">
				<label class="field-title" for="forwarding-source">転送元アドレス</label>
				<select
					id="forwarding-source"
					class="text-input forwarding-select"
					value={forwardingSourceId}
					disabled={forwardingBusy}
					onchange={(event) => selectForwardingSource(event.currentTarget.value)}
				>
					{#each forwarding as item (item.source_address.id)}
						<option value={item.source_address.id} disabled={item.source_address.can_send === false}>{item.source_address.address}{item.source_address.can_send === false ? '（受信専用）' : ''}</option>
					{/each}
				</select>
			</div>

			{#if selectedForwarding}
				<div class="forwarding-status status-{selectedForwardingStatus.tone}" role="status" aria-live="polite">
					<div class="forwarding-status-head">
						<span class="status-label">
							<Icon
								name={selectedForwardingStatus.tone === 'good'
									? 'checkbox-circle-line'
									: selectedForwardingStatus.tone === 'danger'
										? 'error-warning-line'
										: 'information-line'}
								size={16}
							/>
							{selectedForwardingStatus.label}
						</span>
						{#if selectedForwarding.destination}
							<span class="status-destination">{selectedForwarding.destination.destination_address}</span>
						{/if}
					</div>
					<p>{selectedForwardingStatus.detail}</p>
				</div>

				<form class="forwarding-form" onsubmit={saveForwardingDestination}>
						<label class="field-title" for="forwarding-destination">転送先メールアドレス</label>
					<input
						id="forwarding-destination"
						type="email"
						class="text-input"
						bind:value={forwardingDestination}
						placeholder="external@example.net"
						autocomplete="email"
						aria-describedby="forwarding-destination-help"
						disabled={forwardingBusy}
						required
					/>
					<p id="forwarding-destination-help" class="hint">
						<Icon name="shield-check-line" size={14} />
						このアドレスに確認リンクを送信します。リンクの有効期限は24時間で、1回だけ使用できます。
					</p>
					<div class="forwarding-actions">
						<button type="submit" class="btn-primary" disabled={forwardingBusy}>
							{#if forwardingAction === 'save'}
								{selectedForwarding.destination?.status === 'pending' && !forwardingDestinationChanged
									? '送信中…'
									: '保存中…'}
							{:else if selectedForwarding.destination?.status === 'pending' && !forwardingDestinationChanged}
								確認メールを再送信
							{:else if selectedForwarding.destination}
								{forwardingDestinationChanged ? '新しい確認メールを送信' : '転送先を保存'}
							{:else}
								確認メールを送信
							{/if}
						</button>
					</div>
				</form>

				{#if selectedForwarding.destination?.status === 'pending'}
					<p class="forwarding-pending-note">
						確認待ちです。自動転送を有効にする前に、転送先に届いたメールを開いてください。
					</p>
				{:else if canDisableForwarding(selectedForwarding.rule?.status)}
					<div class="forwarding-controls">
						<button
							type="button"
							class="btn-ghost"
							disabled={forwardingBusy}
							onclick={() => setForwardingEnabled(false)}
						>
							{forwardingAction === 'disable' ? '無効化中…' : '自動転送を無効にする'}
						</button>
					</div>
				{:else if selectedForwarding.destination?.status === 'verified' && selectedForwarding.rule}
					<div class="forwarding-enable-box" role="note">
						{#if forwardingDestinationChanged}
							<p class="forwarding-warning">
								<Icon name="information-line" size={15} />
									変更した転送先を保存し、確認してから自動転送を有効にしてください。
							</p>
						{:else}
							<p class="forwarding-warning">
								<Icon name="alert-line" size={15} />
								<span class="forwarding-warning-copy">
									有効にすると、新着メッセージと添付ファイルをNoroshiの外部にある
										<strong>{selectedForwarding.destination.destination_address}</strong>へ送信します。
								</span>
							</p>
							<label class="forwarding-acknowledge">
								<input type="checkbox" bind:checked={forwardingAcknowledged} disabled={forwardingBusy} />
									<span>この外部送信の動作を理解しました。</span>
							</label>
							<button
								type="button"
								class="btn-primary"
								disabled={forwardingBusy || !canEnableForwarding}
								onclick={() => setForwardingEnabled(true)}
							>
							{forwardingAction === 'enable' ? '有効化中…' : '自動転送を有効にする'}
							</button>
						{/if}
					</div>
				{/if}

				{#if selectedForwarding.latest_attempt}
					<p
						class="forwarding-attempt status-{selectedAttemptStatus?.tone ?? 'neutral'}"
							aria-label="最新の自動転送試行: {selectedAttemptStatus?.label}"
						>
						最新の試行: <strong>{selectedAttemptStatus?.label}</strong>
						<span>{selectedAttemptStatus?.detail}</span>
					</p>
				{/if}
			{:else}
					<p class="empty">保存済みの転送元アドレスを選択して、自動転送を設定してください。</p>
			{/if}

			{#if forwardingError}<p class="error" role="alert">{forwardingError}</p>{/if}
			{#if forwardingSaved}<p class="saved" role="status">{forwardingSaved}</p>{/if}
		{:else}
			<p class="empty">自動転送を設定する前に、転送元アドレスを追加してください。</p>
		{/if}
	</section>

	<SortRuleSettings folders={data.folders} initialRules={data.sortRules} />

	<section class="surface-lg card">
		<h2><Icon name="at-line" size={18} /> アドレス</h2>
		<p class="card-hint">
			<strong>差出人名</strong>は、受信者のメール一覧に送信者として表示される名前です（例：サポート窓口）。
			<strong>署名</strong>は、送信するメール本文の末尾に自動で入る組織名や連絡先です。
			このアドレスの署名を空欄にすると、アカウント共通の署名を使用します。
		</p>

		<ul class="address-list">
			{#each addresses as address (address.id)}
				<li class="address-row">
					<div class="address-head">
						<div class="min-w-0 flex-1">
							<label class="field-title" for="address-label-{address.id}">
								差出人名（受信者に見える名前）
							</label>
							<input
								id="address-label-{address.id}"
								type="text"
								class="name-input"
								value={address.label ?? ''}
								placeholder="差出人名"
								aria-label="{address.address}の差出人名"
								disabled={savingId === address.id}
								onchange={(event) => saveLabel(address.id, event.currentTarget.value)}
							/>
							<p class="address-domain">{address.address}</p>
						</div>

						{#if address.is_default}
						<span class="badge">既定</span>
						{:else}
							<button type="button" class="btn-ghost text-xs" onclick={() => makeDefault(address.id)}>
								既定にする
							</button>
						{/if}

						{#if addresses.length > 1}
							<button
								type="button"
								class="icon-btn"
								aria-label="{address.address}を削除"
								onclick={() => remove(address.id)}
							>
								<Icon name="delete-bin-line" size={15} />
							</button>
						{/if}
					</div>
					<label class="field-title" for="address-signature-{address.id}">
						署名（メール本文の末尾に自動挿入）
					</label>
					<textarea
						id="address-signature-{address.id}"
						class="mailbox-signature"
						rows="2"
						maxlength={MAX_EMAIL_SIGNATURE_LENGTH}
						value={address.signature ?? ''}
							placeholder="このアドレスの署名"
							aria-label="{address.address}の署名"
						disabled={savingId === address.id}
						onchange={(event) => saveMailboxSignature(address.id, event.currentTarget.value)}
					></textarea>
				</li>
			{/each}
		</ul>

		<form class="add-form" onsubmit={addAddress}>
			<div class="add-field">
				<label class="field-title" for="new-display-name">差出人名</label>
				<input
					id="new-display-name"
					type="text"
					bind:value={displayName}
					placeholder="サポート"
					class="name-add-input"
					autocomplete="off"
				/>
				<AddressField
					bind:localPart
					bind:domainId
					domains={data.domains}
					placeholder="support"
					label="メールアドレス"
				/>
			</div>
			<button type="submit" class="btn-primary" disabled={busy || !localPart.trim()}>
				{busy ? '追加中…' : '追加'}
			</button>
		</form>

		{#if selectedDomain && !selectedDomain.receiving_enabled}
			<p class="hint">
				<Icon name="information-line" size={14} />
				{selectedDomain.name}は送信できますが、受信が無効です。
			</p>
		{/if}

		{#if error}<p class="error">{error}</p>{/if}
	</section>

	<section class="surface-lg card">
		<h2><Icon name="global-line" size={18} /> 接続済みドメイン</h2>
		<ul class="domain-list">
			{#each data.domains as domain (domain.id)}
				<li class="domain-row">
					<span class="domain-name">{domain.name}</span>
					<span class="caps">
						<span class="chip" class:chip-on={domain.sending_enabled}>送信</span>
						<span class="chip" class:chip-on={domain.receiving_enabled}>受信</span>
						<span class="chip" class:chip-ok={domain.status === 'verified'}>{domainStatusLabel(domain.status)}</span>
					</span>
				</li>
			{/each}
		</ul>
	</section>

	<section class="surface-lg card">
		<div class="card-head">
			<h2><Icon name="key-2-line" size={18} /> APIキー</h2>
			<button type="button" class="btn-primary" onclick={openCreate}>
				<Icon name="add-line" size={15} />
					新規作成
			</button>
		</div>
		<p class="card-hint">
			APIキーは、外部システムや自動処理からNoroshiを操作するための認証情報です。ログイン用パスワードとは別に発行します。
			問い合わせフォームの受付完了メール、CRM・AIへの受信メール取り込み、定期処理からのメール送信などに使えます。
			作成時に「送信」「読み取り」から必要な権限だけを選びます。管理者は、ドメイン・ユーザー・アドレス管理の権限も追加できます。
		</p>
		<p class="hint">
			<Icon name="shield-keyhole-line" size={14} />
			作成したキーは一度だけ表示されます。パスワードと同じ秘密情報として管理してください。
		</p>

		{#if tokens.length}
			<ul class="key-list">
				{#each tokens as token (token.id)}
					<li class="key-row">
						<div class="min-w-0 flex-1">
							<p class="key-name">{token.name}</p>
							<p class="key-meta">
								<code>{token.preview}</code>
								<span class="caps">
									{#each token.scopes as scope (scope)}<span class="chip">{scopeLabel(scope)}</span>{/each}
								</span>
							</p>
						</div>
						<span class="key-created">{formatDate(token.created_at)}</span>
						<button
							type="button"
							class="icon-btn"
							aria-label="{token.name}を無効化"
							onclick={() => revokeKey(token.id)}
						>
							<Icon name="delete-bin-line" size={15} />
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty">APIキーはありません</p>
		{/if}

		{#if keyError && !creating}<p class="error">{keyError}</p>{/if}

		<details class="install-details">
			<summary>開発者向け：CLI（コマンド操作ツール）を使う</summary>
			<p class="hint">
				公開リポジトリのURLが決まるまでは、ローカルのソースから <code>bun run quickmail</code> を実行してください。
			</p>
		</details>
	</section>
</div>

{#if creating}
	<div
		class="modal-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget && !revealed) closeCreate();
		}}
	>
		<div
			class="key-modal"
			role="dialog"
			aria-modal="true"
			aria-label={revealed ? 'APIキーをコピー' : '新しいAPIキー'}
			tabindex="-1"
		>
			<div class="modal-head">
				<h3>
					<Icon name="key-2-line" size={16} />
					{revealed ? 'このAPIキーをコピー' : '新しいAPIキー'}
				</h3>
				<button type="button" class="icon-btn" aria-label="閉じる" onclick={closeCreate}>
					<Icon name="close-line" size={16} />
				</button>
			</div>

			{#if revealed}
				<p class="modal-note">この画面で一度だけ表示されます。今すぐコピーしてください。</p>
				<pre class="token-box">{revealed.token}</pre>
				<div class="modal-actions">
					<button type="button" class="btn-primary" onclick={copyKey}>
						<Icon name={copied ? 'check-line' : 'file-copy-line'} size={15} />
						{copied ? 'コピーしました' : 'コピー'}
					</button>
					<button type="button" class="btn-ghost" onclick={closeCreate}>完了</button>
				</div>
			{:else}
				<form class="key-form" onsubmit={createKey}>
					<label class="sr-only" for="apikey-name">キー名</label>
					<input
						id="apikey-name"
						class="text-input"
						placeholder="キー名"
						value={keyName}
						oninput={(event) => (keyName = event.currentTarget.value)}
					/>

					<div class="scope-row">
						<Check label="メールを送信する" caption="フォームや自動処理から送信" checked={sendScope} onchange={(next) => (sendScope = next)} />
						<Check label="受信メールを読み取る" caption="一覧・本文の取得、既読・スター変更" checked={readScope} onchange={(next) => (readScope = next)} />
						{#if data.isAdmin}
							<Check
								label="設定を管理する"
								caption="ドメイン・ユーザー・アドレス管理"
								checked={adminScope}
								onchange={(next) => (adminScope = next)}
							/>
						{/if}
					</div>

					{#if keyError}<p class="error">{keyError}</p>{/if}

					<div class="modal-actions">
						<button type="button" class="btn-ghost" onclick={closeCreate}>キャンセル</button>
						<button type="submit" class="btn-primary" disabled={keyBusy || !canCreateKey}>
							{keyBusy ? '作成中…' : '作成'}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{/if}

<style>
	.settings-page {
		max-width: 42rem;
	}

	.settings-page :global(.stack-header) {
		margin-bottom: 0;
	}

	.card {
		margin-top: 1.5rem;
		padding: 1.5rem;
	}

	@media (max-width: 900px) {
		.settings-page {
			max-width: none;
			padding-bottom: 1.5rem;
		}

		.card {
			padding: 1.25rem 1rem;
		}
	}

	.card-head {
		display: flex;
		align-items: center;
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

	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.forwarding-form {
		margin-top: 1rem;
	}

	.forwarding-select {
		margin-top: 0.5rem;
		appearance: auto;
	}

	.forwarding-refresh-row {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.forwarding-status {
		margin-top: 1rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.forwarding-status.status-pending {
		background: var(--tone-warn-bg, var(--color-surface-muted));
	}

	.forwarding-status.status-good {
		background: var(--tone-good-bg);
	}

	.forwarding-status.status-danger {
		background: var(--tone-danger-bg, var(--color-surface-muted));
	}

	.forwarding-status-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.status-label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.status-destination {
		min-width: 0;
		font-size: 0.75rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.forwarding-status p {
		margin-top: 0.25rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.forwarding-actions,
	.forwarding-controls {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.forwarding-pending-note {
		margin-top: 0.75rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.forwarding-enable-box {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
		margin-top: 1rem;
		padding: 0.875rem;
		border-radius: 0.75rem;
		background: var(--tone-warn-bg, var(--color-surface-muted));
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.forwarding-warning {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	.forwarding-warning strong {
		word-break: break-word;
	}

	.forwarding-warning-copy {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.forwarding-acknowledge {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.forwarding-acknowledge input {
		width: 1rem;
		height: 1rem;
		margin-top: 0.1rem;
		accent-color: var(--color-accent);
	}

	.forwarding-attempt {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.875rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.forwarding-attempt strong {
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.signature-form {
		margin-top: 1rem;
	}

	.signature-input {
		width: 100%;
		padding: 0.75rem 0.875rem;
		resize: vertical;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		line-height: 1.55;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.signature-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.signature-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

	.character-count {
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.saved {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--tone-good-fg);
	}

	.theme-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.625rem;
		margin-top: 1rem;
	}

	.theme-option {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.625rem;
		border-radius: 0.875rem;
		text-align: left;
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: box-shadow 0.15s, background 0.15s;
	}

	.theme-option:hover {
		background: var(--color-surface-muted);
	}

	.theme-option.selected {
		box-shadow: inset 0 0 0 2px var(--color-accent);
	}

	/* A miniature of the app in that theme — fixed colours, not theme tokens. */
	.theme-preview {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.3125rem;
		height: 3.25rem;
		padding: 0.5rem;
		border-radius: 0.5rem;
		overflow: hidden;
	}

	.preview-bar {
		width: 60%;
		height: 0.375rem;
		border-radius: 9999px;
	}

	.preview-line {
		width: 100%;
		height: 0.25rem;
		border-radius: 9999px;
		opacity: 0.55;
	}

	.preview-line.short {
		width: 70%;
	}

	.theme-preview-light {
		background: #f5f5f5;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
	}

	.theme-preview-light .preview-bar,
	.theme-preview-light .preview-line {
		background: #0a0a0a;
	}

	.theme-preview-dark {
		background: #17171a;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
	}

	.theme-preview-dark .preview-bar,
	.theme-preview-dark .preview-line {
		background: #f4f4f5;
	}

	.theme-preview-system {
		background: linear-gradient(120deg, #f5f5f5 0 50%, #17171a 50% 100%);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.theme-preview-system .preview-bar,
	.theme-preview-system .preview-line {
		background: linear-gradient(120deg, #0a0a0a 0 50%, #f4f4f5 50% 100%);
	}

	.theme-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.theme-option.selected .theme-label {
		color: var(--color-text);
	}

	.theme-check {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 9999px;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.address-list {
		margin-top: 1rem;
	}

	.address-row {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.5rem;
		padding: 0.75rem 0;
	}

	.address-row + .address-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.address-head {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.name-input {
		width: 100%;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		background: transparent;
		outline: none;
	}

	.name-input::placeholder {
		color: var(--color-muted);
		font-weight: 400;
	}

	.mailbox-signature {
		width: 100%;
		padding: 0.5rem 0.75rem;
		resize: vertical;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.mailbox-signature:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.mailbox-signature::placeholder {
		color: var(--color-muted);
	}

	.address-domain {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.field-title {
		display: block;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.name-add-input {
		width: 100%;
		margin: 0.5rem 0 0.875rem;
		padding: 0.625rem 0.875rem;
		border-radius: 0.625rem;
		font-size: 0.9375rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.name-add-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.badge {
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		background: var(--color-surface-muted);
	}

	.add-form {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	.add-field {
		flex: 1;
		min-width: 0;
	}

	.domain-list {
		margin-top: 1rem;
	}

	.domain-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0;
	}

	.domain-row + .domain-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.domain-name {
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.caps {
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

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.75rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.error {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.empty {
		margin-top: 1rem;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}

	.key-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		margin-top: 1rem;
	}

	.text-input {
		width: 100%;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: box-shadow 0.15s;
	}

	.text-input::placeholder {
		color: var(--color-muted);
	}

	.text-input:focus {
		outline: none;
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.scope-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
	}

	.key-list {
		margin-top: 1rem;
	}

	.key-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 0;
	}

	.key-row + .key-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.key-name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.key-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.1875rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.key-meta code {
		font-size: 0.75rem;
	}

	.key-created {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: var(--color-scrim);
	}

	.key-modal {
		width: 100%;
		max-width: 26rem;
		padding: 1.25rem 1.375rem 1.375rem;
		border-radius: 1.25rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-md);
	}

	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.modal-head h3 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 1rem;
		font-weight: 600;
	}

	.modal-note {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}

	.token-box {
		overflow-x: auto;
		margin-top: 0.875rem;
		padding: 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		word-break: break-all;
		white-space: pre-wrap;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.key-form .modal-actions {
		margin-top: 0.25rem;
	}

	@media (max-width: 900px) {
		.settings-page {
			max-width: none;
		}

		.card {
			margin-top: 1rem;
			padding: 1.25rem 1rem;
			box-shadow: none;
		}

		.theme-options {
			gap: 0.5rem;
		}

		.forwarding-status-head {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.25rem;
		}

		.forwarding-actions,
		.forwarding-controls,
		.forwarding-refresh-row {
			justify-content: stretch;
		}

		.forwarding-actions .btn-primary,
		.forwarding-controls .btn-ghost,
		.forwarding-refresh-row .btn-ghost,
		.forwarding-enable-box .btn-primary {
			width: 100%;
		}
	}
</style>
