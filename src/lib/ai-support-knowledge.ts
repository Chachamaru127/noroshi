import type { AiSupportStage } from './ai-support';

export type AiSupportKnowledge = Readonly<{
	patternIds: readonly string[];
	safeSteps: readonly string[];
	expectedEvidence: readonly string[];
}>;

export const AI_SUPPORT_KNOWLEDGE_LIMITS = Object.freeze({
	patterns: 2,
	safeSteps: 2,
	expectedEvidence: 2
});

function reviewed(
	patternIds: string[],
	safeSteps: string[],
	expectedEvidence: string[]
): AiSupportKnowledge {
	return Object.freeze({
		patternIds: Object.freeze(patternIds),
		safeSteps: Object.freeze(safeSteps),
		expectedEvidence: Object.freeze(expectedEvidence)
	});
}

/**
 * Bounded, reviewed projection of support/knowledge/patterns.json.
 * ai-support.test.ts fails if a selected line is no longer present in the Pack.
 */
export const AI_SUPPORT_KNOWLEDGE: Readonly<Record<AiSupportStage, AiSupportKnowledge>> =
	Object.freeze({
		deploy: reviewed(
			['deploy.banner.boundary'],
			[
				'デプロイ完了とメール開通を分けて確認します。',
				'未完了の設定を受信、送信、初回管理者の順に一覧化します。'
			],
			['Workerのデプロイ状態、D1とR2のBinding、未完了設定の一覧が確認できます。']
		),
		'email-routing': reviewed(
			['cloudflare.email.routing', 'cloudflare.worker.route'],
			[
				'変更前のDNSレコードとRouting Rulesを保存します。',
				'現在のRouting RulesとWorker名を読み取ります。'
			],
			[
				'Email Routingのドメイン状態と受信用レコードが一致します。',
				'対象ルールが有効で、ActionとWorkerが意図した値です。'
			]
		),
		resend: reviewed(
			['resend.domain.verification', 'resend.receiving.conflict'],
			[
				'Resend画面の現在値と権威DNSの差分を作ります。',
				'apex MXと送信用サブドメインのMXを別々に一覧化します。'
			],
			[
				'Resendの送信ドメインがverifiedで、Fromドメインと一致します。',
				'apex MXはCloudflare受信用、Resend MXは送信用サブドメインに限定されています。'
			]
		),
		'first-admin': reviewed(
			['onboarding.setup.key'],
			[
				'秘密値を表示せず、設定有無と初回管理者の有無だけを確認します。',
				'未設定なら新しい一回限りの値を秘密入力経路で登録する計画を作ります。'
			],
			['秘密値を露出せずに初回管理者作成が成功し、その後セットアップ画面へ戻れません。']
		)
	});
