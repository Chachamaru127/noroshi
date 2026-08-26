export type ForwardingStatusInput = {
	destinationStatus?: string | null;
	ruleStatus?: 'disabled' | 'enabled' | null;
	attemptStatus?: string | null;
};

export type ForwardingStatusTone = 'neutral' | 'pending' | 'good' | 'danger';

export type ForwardingStatusCopy = {
	label: string;
	tone: ForwardingStatusTone;
	detail: string;
};

export type ForwardingRefreshOutcome = 'applied' | 'failed' | 'stale';

export type ForwardingAttemptStatus = 'queued' | 'processing' | 'sent' | 'failed';

export type ForwardingAttemptStatusCopy = {
	label: string;
	tone: ForwardingStatusTone;
	detail: string;
};

export function scopeLabel(scope: string): string {
	if (scope === 'mail:send' || scope === 'send') return '送信';
	if (scope === 'mail:read' || scope === 'read') return '読み取り';
	if (scope === 'admin') return '管理者';
	return '権限不明';
}

export function forwardingAttemptStatus(
	status: ForwardingAttemptStatus,
	nextAttemptAt?: string | null
): ForwardingAttemptStatusCopy {
	switch (status) {
		case 'queued':
			return {
				label: '待機中',
				tone: 'pending',
				detail: '次の配信試行を待っています。'
			};
		case 'processing':
			return {
				label: '送信中',
				tone: 'pending',
				detail: '転送メールを送信しています。'
			};
		case 'sent':
			return {
				label: '送信済み',
				tone: 'good',
				detail: '最新のメッセージは配信受付済みです。'
			};
		case 'failed':
			if (nextAttemptAt) {
				return {
					label: '再試行予定',
					tone: 'pending',
					detail: '最新の送信は一時的に失敗しました。再試行します。'
				};
			}
			return {
				label: '失敗',
				tone: 'danger',
				detail: '利用可能な回数の再試行後も配信できませんでした。'
			};
	}
}

export function replaceForwardingItemBySource<T extends { source_address: { id: string } }>(
	items: T[],
	sourceAddressId: string,
	replace: (item: T) => T
): T[] {
	return items.map((item) => (item.source_address.id === sourceAddressId ? replace(item) : item));
}

export function forwardingStatus(input: ForwardingStatusInput): ForwardingStatusCopy {
	if (!input.destinationStatus) {
		return {
			label: '未設定',
			tone: 'neutral',
			detail: '自動転送先を選択してください。'
		};
	}

	if (input.destinationStatus === 'pending') {
		return {
			label: '確認待ち',
			tone: 'pending',
			detail: '転送先の受信トレイに届いた確認メールを確認してください。'
		};
	}

	// A rule can remain enabled while one delivery is retrying or has a
	// transient provider failure. The persisted rule state is the authority for
	// the control shown here; the latest attempt is displayed separately.
	if (input.ruleStatus === 'enabled') {
		return {
			label: '有効',
			tone: 'good',
			detail: '新着メッセージと添付ファイルをこの転送先に送信します。'
		};
	}

	return {
		label: '確認済み・無効',
		tone: 'neutral',
		detail: '転送先を確認済みです。準備ができたら自動転送を有効にしてください。'
	};
}

export function isForwardingDestinationChanged(
	current: string | null | undefined,
	next: string
): boolean {
	return (current ?? '').trim().toLowerCase() !== next.trim().toLowerCase();
}

export function canDisableForwarding(
	ruleStatus: 'disabled' | 'enabled' | null | undefined
): boolean {
	return ruleStatus === 'enabled';
}

export function reconcileForwardingInteraction(input: {
	currentDestination?: string | null;
	nextDestination?: string | null;
	draftDestination: string;
	acknowledged: boolean;
	sourceStillSelected: boolean;
	preserveInteraction: boolean;
}): { destination: string; acknowledged: boolean } {
	const nextDestination = input.nextDestination ?? '';
	const draftIsDirty = isForwardingDestinationChanged(
		input.currentDestination,
		input.draftDestination
	);
	const serverDestinationChanged = isForwardingDestinationChanged(
		input.currentDestination,
		nextDestination
	);

	return {
		destination:
			input.preserveInteraction && input.sourceStillSelected && draftIsDirty
				? input.draftDestination
				: nextDestination,
		acknowledged:
			input.preserveInteraction && input.sourceStillSelected && !serverDestinationChanged
				? input.acknowledged
				: false
	};
}

export function isCurrentForwardingRefresh(
	requestGeneration: number,
	currentGeneration: number
): boolean {
	return requestGeneration === currentGeneration;
}

export function canApplyForwardingRefreshOutcome(
	outcome: ForwardingRefreshOutcome,
	requestGeneration: number,
	currentGeneration: number
): boolean {
	return outcome !== 'stale' && isCurrentForwardingRefresh(requestGeneration, currentGeneration);
}

export function safeForwardingError(
	error: unknown,
	fallback = '自動転送を更新できませんでした。'
): string {
	if (typeof error !== 'string') return fallback;

	if (error.includes('Destination must be outside QuickMail domains')) {
		return 'QuickMail-jaの管理ドメイン以外のアドレスを指定してください。';
	}
	if (error.includes('Verify the forwarding destination before enabling it')) {
		return '自動転送を有効にする前に、転送先メールアドレスを確認してください。';
	}
	if (error.includes('Source address and destination are required')) {
		return '転送元アドレスを選択し、転送先を入力してください。';
	}
	if (error.includes('Source address not found')) {
		return '保存済みの転送元アドレスを選択してください。';
	}
	if (
		error.includes('valid external email address') ||
		error.includes('Destination must be an email address')
	) {
		return '有効な外部メールアドレスを入力してください。';
	}

	return fallback;
}
