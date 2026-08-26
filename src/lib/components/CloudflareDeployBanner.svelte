<script module lang="ts">
	const SUPPORTED_REPOSITORY_HOSTS = new Set(['github.com', 'gitlab.com']);
	const UPSTREAM_REPOSITORY = 'github.com/DivinPrince/quickmail';

	export type CloudflareDeployInput = {
		repositoryUrl?: string;
		repositoryPublic: boolean;
		releaseApproved: boolean;
	};

	export function cloudflareDeployHref(input: CloudflareDeployInput): string | null {
		if (!input.repositoryUrl || !input.repositoryPublic || !input.releaseApproved) return null;

		let repository: URL;
		try {
			repository = new URL(input.repositoryUrl);
		} catch {
			return null;
		}

		if (
			repository.protocol !== 'https:' ||
			!SUPPORTED_REPOSITORY_HOSTS.has(repository.hostname.toLowerCase()) ||
			repository.username ||
			repository.password ||
			repository.search ||
			repository.hash
		) {
			return null;
		}

		let path: string;
		try {
			path = decodeURIComponent(repository.pathname).replace(/^\/+|\/+$/g, '');
		} catch {
			return null;
		}
		const segments = path.split('/').filter(Boolean);
		if (
			segments.length < 2 ||
			segments.at(-1)?.toLowerCase() !== 'quickmail-ja' ||
			segments.some((segment) => segment.toLowerCase().includes('recovery'))
		) {
			return null;
		}

		const identity = `${repository.hostname}/${path}`;
		if (identity.toLowerCase() === UPSTREAM_REPOSITORY.toLowerCase()) return null;

		const canonicalRepository = `https://${repository.hostname.toLowerCase()}/${segments.join('/')}`;
		const deploy = new URL('https://deploy.workers.cloudflare.com/');
		deploy.searchParams.set('url', canonicalRepository);
		return deploy.toString();
	}
</script>

<script lang="ts">
	type Props = {
		repositoryUrl?: string;
		repositoryPublic?: boolean;
		releaseApproved?: boolean;
	};

	let { repositoryUrl, repositoryPublic = false, releaseApproved = false }: Props = $props();

	const deployHref = $derived(
		cloudflareDeployHref({ repositoryUrl, repositoryPublic, releaseApproved })
	);
</script>

<section class="deploy-card" aria-labelledby="cloudflare-deploy-title">
	<div class="deploy-copy">
		<p class="eyebrow">Cloudflare Workers</p>
		<h2 id="cloudflare-deploy-title">Cloudflareへの展開</h2>
		<p>デプロイ完了とメール開通は別です。公開後も、メール経路と送信設定を確認します。</p>
	</div>

	{#if deployHref}
		<a
			class="deploy-button"
			href={deployHref}
			target="_blank"
			rel="noopener noreferrer"
			referrerpolicy="no-referrer"
		>
			<img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
		</a>
	{:else}
		<div class="deploy-button is-disabled" aria-disabled="true">
			<img src="https://deploy.workers.cloudflare.com/button" alt="" aria-hidden="true" />
			<span>公開準備中</span>
		</div>
	{/if}
</section>

<style>
	.deploy-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.25rem;
		padding: 1.25rem;
		border-radius: 1rem;
		background: var(--color-surface, #fff);
		box-shadow: inset 0 0 0 1px var(--color-line, #d9dfdb);
	}

	.deploy-copy {
		min-width: 0;
	}

	.eyebrow {
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-muted, #66736c);
	}

	h2 {
		margin-top: 0.25rem;
		font-size: 1rem;
		font-weight: 650;
		color: var(--color-text, #17201b);
	}

	.deploy-copy > p:last-child {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--color-text-secondary, #556159);
	}

	.deploy-button {
		position: relative;
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		min-height: 44px;
	}

	.deploy-button img {
		display: block;
		width: 180px;
		height: auto;
	}

	.deploy-button:focus-visible {
		outline: 3px solid var(--color-focus-halo, rgb(105 150 126 / 30%));
		outline-offset: 3px;
	}

	.is-disabled {
		opacity: 0.52;
		filter: grayscale(1);
		cursor: not-allowed;
	}

	.is-disabled span {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border-radius: 0.35rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: #fff;
		background: rgb(20 24 22 / 72%);
	}

	@media (max-width: 640px) {
		.deploy-card {
			align-items: stretch;
			flex-direction: column;
		}

		.deploy-button,
		.deploy-button img {
			width: 100%;
		}
	}
</style>
