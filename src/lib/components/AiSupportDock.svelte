<script lang="ts">
	import {
		AI_SUPPORT_PROVIDERS,
		AI_SUPPORT_QUESTION_MAX_LENGTH,
		AiSupportInputError,
		buildAiSupportDestination,
		buildAiSupportPrompt,
		type AiSupportStage
	} from '$lib/ai-support';

	let { stage }: { stage: AiSupportStage } = $props();
	let question = $state('');
	let copyStatus = $state('');

	const draft = $derived.by(() => {
		try {
			const prompt = buildAiSupportPrompt(stage, question);
			return {
				prompt,
				destinations: AI_SUPPORT_PROVIDERS.map(({ id, label }) => ({
					...buildAiSupportDestination(id, prompt),
					label
				})),
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
				'unsafe-url': '安全な質問リンクを作成できませんでした。'
			}[code];
			return { prompt: '', destinations: [], error: message };
		}
	});

	function copyPrompt(): void {
		if (!draft.prompt) {
			copyStatus = '質問を入力してください。';
			return;
		}
		if (!navigator.clipboard?.writeText) {
			copyStatus = 'コピーできませんでした。表示された質問文を選択してコピーしてください。';
			return;
		}
		void navigator.clipboard.writeText(draft.prompt).then(
			() => {
				copyStatus = '質問文をコピーしました。';
			},
			() => {
				copyStatus = 'コピーできませんでした。表示された質問文を選択してコピーしてください。';
			}
		);
	}
</script>

<section class="surface-lg ai-support" aria-labelledby="ai-support-title">
	<div class="support-head">
		<div>
			<h2 id="ai-support-title">導入についてAIに質問</h2>
			<p>普段使っているAIへ、下に表示する質問文だけを渡します。APIキーは不要です。</p>
		</div>
	</div>

	<label for="ai-support-question">聞きたいこと</label>
	<input
		id="ai-support-question"
		type="text"
		bind:value={question}
		oninput={() => (copyStatus = '')}
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
			<h3>AIへ渡す質問文</h3>
			<button type="button" class="copy-button" onclick={copyPrompt} disabled={!draft.prompt}>
				質問文をコピー
			</button>
		</div>
		<pre class="prompt-preview">{draft.prompt ||
				'質問を入力すると、AIへ渡す全文をここに表示します。'}</pre>
	</div>

	<div class="provider-actions" aria-label="質問先を選択">
		{#each draft.destinations as destination}
			<a
				class="provider-link"
				href={destination.href}
				target="_blank"
				rel="noopener noreferrer"
				referrerpolicy="no-referrer"
				onclick={destination.mode === 'copy-then-open' ? copyPrompt : undefined}
			>
				{destination.label}
			</a>
		{/each}
	</div>
	<p class="fallback-copy">
		入力済みにならない場合は「質問文をコピー」でコピーし、開いたAIへ貼り付けてください。Geminiは質問文をコピーしてから公式画面を開きます。
	</p>
	<p class="copy-status" aria-live="polite" aria-atomic="true">{copyStatus}</p>
</section>

<style>
	.ai-support {
		margin-top: 1rem;
		padding: 1.25rem;
	}

	.support-head h2,
	.prompt-head h3 {
		font-weight: 600;
		color: var(--color-text);
	}

	.support-head h2 {
		font-size: 1rem;
	}

	.support-head p,
	.warning,
	.fallback-copy,
	.copy-status {
		font-size: 0.75rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
	}

	.support-head p {
		margin-top: 0.35rem;
	}

	label {
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
	.provider-link:focus-visible {
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

	.prompt-head h3 {
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

	.fallback-copy {
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
