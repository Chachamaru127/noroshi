<script lang="ts">
	import {
		AI_SUPPORT_PROVIDERS,
		AI_SUPPORT_QUESTION_MAX_LENGTH,
		AiSupportInputError,
		buildAiSupportDestination,
		buildAiSupportPrompt,
		copyAiSupportPrompt,
		type AiSupportStage
	} from '$lib/ai-support';

	let { stage }: { stage: AiSupportStage } = $props();
	let question = $state('');
	let copyStatus = $state('');
	let geminiCopiedPrompt = $state('');

	const draft = $derived.by(() => {
		try {
			const prompt = buildAiSupportPrompt(stage, question);
			const destinations = AI_SUPPORT_PROVIDERS.map(({ id, label }) => ({
				...buildAiSupportDestination(id, prompt),
				label
			}));
			return {
				prompt,
				destinations: destinations.filter((destination) => destination.mode === 'prefill'),
				geminiHref:
					destinations.find((destination) => destination.provider === 'gemini')?.href ?? '',
				error: ''
			};
		} catch (error) {
			const code = error instanceof AiSupportInputError ? error.code : 'unsafe-url';
			const message = {
				empty: '',
				overlength: `質問は${AI_SUPPORT_QUESTION_MAX_LENGTH}文字以内で入力してください。`,
				control: '改行や制御文字を削除してください。',
				bidi: '文字方向を変える特殊文字を削除してください。',
				html: 'HTMLタグを削除して、通常の文章で入力してください。',
				secret: '秘密情報らしき文字列があります。APIキーやパスワードを削除してください。',
				'personal-data': 'メールアドレスなどの個人情報を削除してください。',
				'unsafe-url': '安全な質問リンクを作成できませんでした。'
			}[code];
			return { prompt: '', destinations: [], geminiHref: '', error: message };
		}
	});

	function resetQuestionState(): void {
		copyStatus = '';
		geminiCopiedPrompt = '';
	}

	async function copyPrompt(forGemini = false): Promise<void> {
		if (!draft.prompt) {
			copyStatus = '質問を入力してください。';
			return;
		}
		if (forGemini) geminiCopiedPrompt = '';
		const prompt = draft.prompt;
		let result: Awaited<ReturnType<typeof copyAiSupportPrompt>>;
		try {
			result = await copyAiSupportPrompt(prompt, navigator.clipboard);
		} catch {
			copyStatus = '安全な質問文として確認できませんでした。';
			geminiCopiedPrompt = '';
			return;
		}
		if (result === 'copied' && draft.prompt === prompt) {
			copyStatus = '質問文をコピーしました。';
			if (forGemini) geminiCopiedPrompt = prompt;
		} else if (result === 'copied') {
			copyStatus = '質問が変更されたため、もう一度コピーしてください。';
			geminiCopiedPrompt = '';
		} else {
			copyStatus = 'コピーできませんでした。表示された質問文を選択してコピーしてください。';
			geminiCopiedPrompt = '';
		}
	}
</script>

<section class="surface-lg ai-support" aria-labelledby="ai-support-title">
	<div class="support-head">
		<div>
			<h2 id="ai-support-title">導入についてAIに質問</h2>
			<p>
				普段使っているAIへ、下に表示する質問文だけを渡します。QuickMail-jaの公式サポートではありません。
			</p>
		</div>
	</div>

	<label for="ai-support-question">聞きたいこと</label>
	<input
		id="ai-support-question"
		type="text"
		bind:value={question}
		oninput={resetQuestionState}
		maxlength={AI_SUPPORT_QUESTION_MAX_LENGTH + 1}
		placeholder="例：Cloudflareの画面で次に何を確認しますか？"
		aria-describedby="ai-support-warning ai-support-error"
	/>
	<p id="ai-support-warning" class="warning">
		パスワード、APIキー、セットアップキー、メール本文、個人情報は入力しないでください。
	</p>
	{#if draft.error}
		<p id="ai-support-error" class="error" role="alert">{draft.error}</p>
	{:else}
		<span id="ai-support-error" class="sr-only">入力に問題はありません。</span>
	{/if}

	<div class="prompt-panel">
		<div class="prompt-head">
			<label for="ai-support-prompt-preview">AIへ渡す質問文</label>
			<button
				type="button"
				class="copy-button"
				onclick={() => void copyPrompt()}
				disabled={!draft.prompt}
			>
				質問文をコピー
			</button>
		</div>
		<textarea
			id="ai-support-prompt-preview"
			readonly
			class="prompt-preview"
			rows="8"
			value={draft.prompt || '質問を入力すると、AIへ渡す全文をここに表示します。'}></textarea>
	</div>

	<div class="provider-actions" aria-label="質問先を選択">
		{#each draft.destinations as destination}
			<a
				class="provider-link"
				href={destination.href}
				target="_blank"
				rel="noopener noreferrer"
				referrerpolicy="no-referrer"
			>
				{destination.label}
			</a>
		{/each}
		<div class="gemini-actions">
			<button
				type="button"
				class="provider-link"
				disabled={!draft.prompt}
				onclick={() => void copyPrompt(true)}
			>
				Gemini用に質問文をコピー
			</button>
			{#if draft.geminiHref && geminiCopiedPrompt === draft.prompt}
				<a
					class="provider-link"
					href={draft.geminiHref}
					target="_blank"
					rel="noopener noreferrer"
					referrerpolicy="no-referrer"
				>
					Geminiを開く
				</a>
			{:else}
				<span class="provider-link provider-link-disabled" aria-disabled="true">Geminiを開く</span>
			{/if}
		</div>
	</div>
	<p class="fallback-copy">
		入力済みにならない場合は「質問文をコピー」でコピーし、開いたAIへ貼り付けてください。
	</p>
	<p class="disclosure">
		ChatGPTとClaudeでは質問文がURLに含まれ、ブラウザ履歴やAI提供者側に残る可能性があります。Geminiでは質問文をクリップボードへコピーします。回答、記憶・データ保持、利用可否は各AIサービスのアカウント、契約、ポリシーに従います。
	</p>
	<p class="copy-status" aria-live="polite" aria-atomic="true">{copyStatus}</p>
</section>

<style>
	.ai-support {
		margin-top: 1rem;
		padding: 1.25rem;
	}

	.support-head h2,
	.prompt-head label {
		font-weight: 600;
		color: var(--color-text);
	}

	.support-head h2 {
		font-size: 1rem;
	}

	.support-head p,
	.warning,
	.fallback-copy,
	.disclosure,
	.copy-status {
		font-size: 0.75rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
	}

	.support-head p {
		margin-top: 0.35rem;
	}

	label[for='ai-support-question'] {
		display: block;
		margin-top: 1rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	input {
		width: 100%;
		min-height: var(--touch-target);
		margin-top: 0.45rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	input:focus-visible,
	.copy-button:focus-visible,
	.provider-link:focus-visible,
	.prompt-preview:focus-visible {
		box-shadow:
			inset 0 0 0 1px var(--color-focus-line),
			0 0 0 3px var(--color-focus-halo);
	}

	.warning {
		margin-top: 0.5rem;
	}

	.error {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-danger);
	}

	.prompt-panel {
		margin-top: 1rem;
		border-radius: 0.75rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		overflow: hidden;
	}

	.prompt-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--color-line);
	}

	.prompt-head label {
		margin: 0;
		font-size: 0.8125rem;
	}

	.copy-button,
	.provider-link {
		min-height: var(--touch-target);
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.copy-button {
		padding: 0 0.75rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.copy-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.prompt-preview {
		display: block;
		width: 100%;
		min-height: 7rem;
		max-height: 15rem;
		padding: 0.875rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: inherit;
		font-size: 0.75rem;
		line-height: 1.65;
		color: var(--color-text-secondary);
		background: transparent;
		border: 0;
		resize: vertical;
		outline: none;
	}

	.provider-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin-top: 0.875rem;
	}

	.provider-link {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.625rem;
		text-align: center;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.provider-link:hover {
		background: var(--color-surface-hover);
	}

	.provider-link:disabled,
	.provider-link-disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.gemini-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.fallback-copy,
	.disclosure {
		margin-top: 0.75rem;
	}

	.copy-status {
		min-height: 1.2rem;
		margin-top: 0.35rem;
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

	@media (max-width: 640px) {
		.provider-actions {
			grid-template-columns: 1fr;
		}

		.prompt-head {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
