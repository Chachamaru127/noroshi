# QuickMail-ja Product Contract

## Product

QuickMail-ja is a Japanese-first, self-hosted webmail for custom domains. It runs on Cloudflare Workers, D1, and R2.

The default supported mail topology is:

- Inbound: Cloudflare Email Routing to the QuickMail Worker
- Outbound: Resend API
- Storage: D1 for metadata and R2 for attachments

QuickMail-ja is a generic open-source product. It must not contain customer names, real customer domains, production resource identifiers, mailbox backups, operational logs, or deployment history.

## Required capabilities

- Japanese UI for setup, login, inbox, compose, sent mail, settings, administration, folders, and forwarding
- Send, receive, reply, threads, drafts, attachments, delivery status, signatures, API keys, CLI, and MCP
- Multiple domains, addresses, and users
- Manual forwarding of one saved message
- Automatic forwarding after inbound mail is saved, with an idempotency key, a minimal atomic D1 claim, and at most three provider attempts
- User-managed forwarding destination, enable/disable control, and delivery status
- Custom folders and automatic sorting rules based on sender or subject
- Setup-key protected first-admin onboarding
- Generic Outlook/EML import tooling with explicit mailbox/domain input
- Japanese setup, DNS, backup, recovery, update, and rollback documentation

## Safety and distribution boundaries

- Preserve the original MIT license and attribution to DivinPrince/quickmail.
- Base public history on upstream commit `77e8858acc5043fcc103f8560c60d0c5f958ccc0`; do not import any deployment-specific downstream history.
- Do not include active custom routes, Cloudflare account IDs, D1 IDs, R2 production names, real domains, real email addresses, secrets, backups, `.wrangler`, `out`, `.claude`, or `.harness*` state.
- Until a QuickMail-ja GitHub URL exists, do not present an installer or Deploy button that silently installs the original upstream build.
- Generic templates use placeholders and cannot address any existing production resource without explicit user setup.

## Non-goals for the first public release

- IMAP, POP, or Gmail two-way synchronization
- Google Workspace or Microsoft 365 feature parity
- Enterprise archive, legal hold, compliance SLA, malware scanning, or managed deliverability guarantees
- Runtime multi-language switching or per-tenant rebranding
- Publishing to GitHub, deploying to Cloudflare, or changing an existing production deployment as part of the local repository split

## Definition of done

1. The existing production downstream remains separate and its tracked tree is unchanged by this split.
2. QuickMail-ja is an independent Git repository with upstream ancestry and no deployment-specific downstream history.
3. The QuickMail-ja tracked tree and every QuickMail-ja commit after the upstream base contain zero customer-specific names, domains, addresses, production IDs, or operational state.
4. The UI and documentation identify the product as QuickMail-ja and are Japanese-first.
5. The generic configuration has placeholders only and no active production route.
6. Unit tests, D1 integration/race tests, type checks, formatting checks, template-clean checks, and production build pass.
7. An independent security/privacy review and an independent product/QA review approve the result.
8. No GitHub push, Cloudflare deployment, DNS change, email send, or production database mutation occurs.
