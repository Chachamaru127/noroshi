import type { AiSupportStage } from './ai-support';

export type AiSupportKnowledge = Readonly<{
	patternIds: readonly string[];
	reviewBy: string;
	officialDocs: readonly Readonly<{ label: string; url: string }>[];
}>;

export const AI_SUPPORT_KNOWLEDGE_LIMITS = Object.freeze({
	patterns: 2,
	officialDocs: 2
});

function reviewed(
	patternIds: string[],
	reviewBy: string,
	officialDocs: { label: string; url: string }[]
): AiSupportKnowledge {
	return Object.freeze({
		patternIds: Object.freeze(patternIds),
		reviewBy,
		officialDocs: Object.freeze(officialDocs.map((doc) => Object.freeze(doc)))
	});
}

/**
 * Bounded projection of official sources referenced by support/knowledge/patterns.json.
 * The AI prompt asks the provider to re-open these sources instead of embedding fixed steps.
 */
export const AI_SUPPORT_KNOWLEDGE: Readonly<Record<AiSupportStage, AiSupportKnowledge>> =
	Object.freeze({
		deploy: reviewed(['deploy.banner.boundary'], '2026-09-26', [
			{
				label: 'Cloudflare Deploy buttons',
				url: 'https://developers.cloudflare.com/workers/platform/deploy-buttons/'
			},
			{
				label: 'QuickMail公式リポジトリ',
				url: 'https://github.com/DivinPrince/quickmail'
			}
		]),
		'email-routing': reviewed(
			['cloudflare.email.routing', 'cloudflare.worker.route'],
			'2026-09-26',
			[
				{
					label: 'Cloudflare Email Routing',
					url: 'https://developers.cloudflare.com/email-service/get-started/route-emails/'
				},
				{
					label: 'Cloudflare Email Routing rules',
					url: 'https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/'
				}
			]
		),
		resend: reviewed(['resend.domain.verification', 'resend.receiving.conflict'], '2026-09-26', [
			{
				label: 'Resend Managing Domains',
				url: 'https://resend.com/docs/dashboard/domains/introduction'
			},
			{
				label: 'Resend MX conflict guidance',
				url: 'https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records'
			}
		]),
		'first-admin': reviewed(['onboarding.setup.key'], '2026-11-25', [
			{
				label: 'QuickMail公式リポジトリ',
				url: 'https://github.com/DivinPrince/quickmail'
			}
		])
	});
