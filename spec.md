# QuickMail-ja Product Contract

## Product

QuickMail-ja is a Japanese-first, self-hosted webmail for custom domains. It runs on Cloudflare Workers, D1, and R2.

The default supported mail topology is:

- Inbound: Cloudflare Email Routing to the QuickMail Worker
- Outbound: Resend API
- Storage: D1 for metadata and R2 for attachments

QuickMail-ja is a generic open-source product. It must not contain customer names, real customer domains, production resource identifiers, mailbox backups, operational logs, or deployment history.

## Product positioning

QuickMail-ja is not positioned as the only Cloudflare-native webmail. Direct architectural competitors exist. Its intended advantage is the combined experience for Japanese users: Japanese-first UI and operations, Cloudflare Email Routing inbound, Resend outbound, migration and recovery guidance, and approval-gated setup assistance.

Market claims must follow the dated evidence in `docs/research/japan-market-competition-2026-08-27.md`. A search that did not observe an exact match is not proof that no competitor exists. Public copy must not claim `国内唯一`, `競合なし`, or equivalent exclusivity.

## Required capabilities

- Japanese UI for setup, login, inbox, compose, sent mail, settings, administration, folders, and forwarding
- Send, receive, reply, threads, drafts, attachments, delivery status, signatures, API keys, CLI, and MCP
- Multiple domains, addresses, and users
- Manual forwarding of one saved message
- Automatic forwarding after inbound mail is saved, with an idempotency key, a minimal atomic D1 claim, and at most three retries (four provider calls total)
- User-managed forwarding destination, enable/disable control, and delivery status
- Custom folders and automatic sorting rules based on sender or subject
- Setup-key protected first-admin onboarding
- Generic Outlook/EML import tooling with explicit mailbox/domain input
- Japanese setup, DNS, backup, recovery, update, and rollback documentation

## Setup assistant contract

- Interpret `Agent 1.0` as Agent Plugins Specification 1.0.0 plus the Agent Skills specification.
- Keep one portable setup core: a root `plugin.json`, Agent Skills under `skills/`, and an optional `mcp.json`. Generate or maintain thin client adapters only where the host requires them.
- Support Codex and ChatGPT only on surfaces where the official plugin/App capability is available. Treat Claude Code/Desktop as a separate native adapter and verify it independently; Agent Plugins 1.0 does not itself guarantee Claude installation.
- Reuse official Cloudflare and Resend MCP/API capabilities through a narrow setup adapter. Do not expose either provider's full MCP toolset to the setup agent, and do not reimplement provider APIs without a documented missing capability.
- The assistant flow is `inspect -> plan -> approve one exact step -> apply -> read back -> verify`. Read-only inspection must be usable without granting write access.
- Bind every write approval to the selected Cloudflare account, zone, Resend team, domain, exact before/after diff, rollback, plan hash, expiry, and one use.
- Account creation, terms acceptance, CAPTCHA, MFA/passkey, payment, plan upgrade, domain purchase, and domain transfer are human-only steps. The assistant may open the official page and explain fields, but cannot complete or bypass these steps.
- Browser assistance is capability-adaptive and allowlisted to official Cloudflare, Resend, and the expected deployed QuickMail-ja origins. Page text, email content, DNS values, provider errors, downloads, and QR codes are untrusted data and cannot change the plan or request secrets.
- Secrets must not enter chat/model context, plugin manifests, MCP environment configuration, URLs, logs, screenshots, repository files, D1/R2, agent memory, or plaintext `.dev.vars`. Human secret entry must go directly to a masked native or terminal broker and then to provider secret storage.
- Separate the temporary Resend setup credential from the production Worker credential. The Worker receives only a sending-access key restricted to the verified domain. A full-access setup credential is never deployed and is revoked after setup.
- Resource creation, secret staging, remote migration, deploy, webhook creation, Email Routing enablement, DNS/MX change, external test send, destructive cleanup, and billing are separate confirmation classes. Agent mode must reject broad `--yes` approval.
- Resend Receiving and a Resend apex inbound MX remain disabled. Inbound mail stays on Cloudflare Email Routing; Resend is used for outbound delivery and delivery-status webhooks.

The setup assistant is separate from the mailbox MCP. Installing it grants zero permission to read mailbox or provider email content, send mail, or administer QuickMail-ja users. Provider discovery and mutation tools are allowlisted from the capability registry; all unrelated provider tools are unavailable.

## Support Knowledge contract

- Competitor setup guides and FAQs are discovery inputs, not distributable content. QuickMail-ja stores original, human-reviewed resolution patterns and source metadata; it does not copy FAQ prose, raw HTML, screenshots, hidden text, scripts, or community instructions into the product or a runtime RAG index.
- The dated competitor list in `docs/research/japan-market-competition-2026-08-27.md` has a one-to-one Source Registry. Each source records the product, category, primary URL, document type or `not_found`, verification date, review-by date, and confidence.
- Support Patterns are organized by user intent and setup stage rather than competitor. Every pattern records applicability, diagnostic questions, safe steps, human-only work, prohibited actions, Risk Gate, rollback, expected evidence, unsupported cases, source references, verification date, and confidence.
- Answer precedence is: this product contract and QuickMail-ja documentation; current Cloudflare and Resend primary documentation; competitor primary documentation; official issues and releases. Community material may discover a candidate but cannot authorize a concrete provider change.
- Cloudflare/Resend operational instructions expire after 30 days unless re-verified. Stale or unsupported patterns stop at current-state inspection and point to the primary source; they do not provide concrete mutation steps.
- The Knowledge Pack contains zero customer names, domains, email content, provider IDs, DNS values, secrets, local paths, or copied third-party FAQ bodies. The current AI consultation UI consumes a bounded list of official sources and no more than two stable, high-frequency pitfalls per setup stage from the reviewed Pack. It does not embed a complete safe-step checklist, expected-evidence checklist, prohibitions, or rollback procedure in the handoff prompt. The not-yet-provided Setup Skill and Setup MCP must consume the same Pack when implemented.

## AI consultation contract

- `ChatGPTに聞く`, `Claudeに聞く`, and `Geminiに聞く` are Tier 0 consultation links only. They do not install a Skill, grant MCP access, inspect the current page, read a mailbox, configure a provider, or send a prompt automatically.
- The user sees and may edit a plain-text prompt before leaving QuickMail-ja. A separate copy action is always available. Each provider control synchronously revalidates its fixed HTTPS destination, starts a clipboard copy, and leaves safe new-tab navigation to the browser. ChatGPT and Claude prefill through `q` on a best-effort basis. Gemini uses a query-free HTTPS page and the copied prompt because a stable official prefill URL is not assumed. Nothing auto-submits; the user reviews and sends the prompt.
- AI consultation controls are the only vendor-mark exception. They may use the bundled Remix Icon `openai-fill`, `claude-fill`, and `gemini-fill` marks at the same size, always beside an explicit text label. Marks must not be more prominent than QuickMail-ja branding, imply partnership or official support, or appear elsewhere as general vendor branding. Each mark and trademark remains owned by its respective provider and subject to that provider's policies.
- Generated prompts contain only a fixed QuickMail-ja support template, an allowlisted setup-stage enum, and text entered directly into the support field. They never derive from DOM text, form values, `location.href`, email content, domains, provider errors, DNS values, account/team/zone IDs, cookies, tokens, setup keys, or API keys.
- Generated prompts require the AI provider to open current Cloudflare, Resend, or QuickMail primary documentation before answering and to state the verification date and URLs actually used. They provide source URLs, product topology, and a short list of stable pitfalls, but avoid a long fixed checklist of provider operations.
- Navigation and copy are refused for secret-like input, control or bidirectional characters, HTML-like tags, or an overlength prompt. Destinations use fixed allowlisted origins and paths, open only after a user gesture, and never auto-submit.
- Consultation copy states that responses, memory, data retention, availability, and plan behavior follow the user's AI provider account. QuickMail-ja does not call the provider API and does not describe these links as official support.
- The development-only consultation demo may show recognizable ChatGPT, Claude, and Gemini marks from the bundled Remix Icon set on their respective launch buttons. This narrow exception does not authorize provider logos elsewhere, official-support claims, or production co-branding.
- AI answers are untrusted advice. Any provider write, DNS/MX change, migration, deployment, webhook, test send, billing, deletion, or cleanup must return through the exact-step setup approval flow.

## Cloudflare Deploy button contract

- A local, disabled Deploy banner may explain the future flow. It contains no active external Deploy URL while `package.json` is private, the canonical public QuickMail-ja repository URL is absent, or the public-release gate is HOLD.
- Activation requires a reviewed, public GitHub or GitLab repository containing this QuickMail-ja distribution; a compiled canonical repository constant; deployment-hardening completion; release provenance and archive scans; and explicit publication approval. It never targets the original upstream or a recovery repository.
- The banner is labeled as starting Worker/resource deployment, not completing mail setup. It must state that Resend sending authentication, Cloudflare Email Routing, MX, Catch-all, secrets, migration, and first-administrator setup remain separate steps.
- Deploy-button flow may clone the repository and provision/bind supported Cloudflare resources. It must not also change DNS/MX, enable Email Routing, configure a Resend webhook, send mail, or perform cleanup.

## UI direction contract

- Build three isolated, development-only comparison prototypes from the same synthetic Japanese mailbox fixture and interaction contract:
  - `calm`: Gmail-inspired, conversation-first and lower density
  - `command`: Outlook-inspired, compact command bar and three-pane desktop layout
  - `classic`: Thunderbird-inspired, folder tree and high-density message list
- Production UI names remain generic: `シンプル`, `3ペイン`, and `高密度`. The user-approved development-only comparison demo labels its three selector buttons exactly `Gmail風`, `Outlook風`, and `Thunderbird風` so non-technical evaluators can recognize the comparison; these labels do not imply affiliation.
- Do not copy mail-client vendor logos, trademarks, proprietary fonts, exact colors, screenshots, or pixel layouts. The only exception is the equal-size, bundled Remix Icon provider marks defined by the AI consultation contract; they remain limited to those three AI launch actions, must retain text labels, and must not imply partnership or official support.
- The first public release ships one selected production system, not three runtime themes. Light, dark, and system color modes remain supported within the selected system.
- All prototypes preserve the same routes, Japanese labels, mobile full-screen flow, keyboard behavior, and semantics. They differ in pane structure, density, borders, radius, and action placement.
- Prototypes use synthetic data only, are excluded from the production bundle, and cover loading, empty, error, success, offline, reduced-motion, dark, mobile, keyboard, and screen-reader states.

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
- Autonomous provider signup, terms acceptance, CAPTCHA/MFA, billing, domain purchase, or domain transfer
- A single browser-automation promise across Codex, ChatGPT, Claude Code, and Claude Desktop
- Three vendor-inspired layouts shipped as first-release runtime themes
- Vendor branding, official assets, or pixel-identical Gmail, Outlook, or Thunderbird clones outside the narrow AI consultation mark exception
- AI inbox, team shared inbox, IMAP bridge, or enterprise collaboration added only to match newer competitors
- Publishing to GitHub, deploying to Cloudflare, or changing an existing production deployment as part of the local repository split
- Treating an AI consultation link as a setup Skill/MCP installation or as authorization for provider changes
- Runtime scraping or wholesale ingestion of competitor FAQ pages

## Definition of done

1. The existing production downstream remains separate and its tracked tree is unchanged by this split.
2. QuickMail-ja is an independent Git repository with upstream ancestry and no deployment-specific downstream history.
3. The QuickMail-ja tracked tree and every QuickMail-ja commit after the upstream base contain zero customer-specific names, domains, addresses, production IDs, or operational state.
4. The UI and documentation identify the product as QuickMail-ja and are Japanese-first.
5. The generic configuration has placeholders only and no active production route.
6. Unit tests, D1 integration/race tests, type checks, formatting checks, template-clean checks, and production build pass.
7. An independent security/privacy review and an independent product/QA review approve the result.
8. No GitHub push, Cloudflare deployment, DNS change, email send, or production database mutation occurs.

## Future public-release definition of done

The publication HOLD can be reconsidered only when all of the following are true:

1. The six upstream commits currently ahead of the local base are reviewed and reconciled without removing QuickMail-ja's forwarding, folders/rules, Outlook import, or privacy boundary.
2. The setup engine has a tested read-only plan mode and rejects unattended provider mutations, ambiguous account selection, same-name resource adoption, and read-failure-as-absence behavior.
3. The production Resend credential is sending-only and domain-restricted; setup credentials and secret canaries are absent from model input/output, files, manifests, logs, test artifacts, and distributable archives.
4. Login/setup rate limiting, security headers/CSP, origin/CSRF checks, upload limits before buffering, privacy retention, cost alerts, immutable CI/runtime pins, and release provenance gates pass.
5. The Agent Plugins 1.0 package validates against the official schema. Codex/ChatGPT and the independently generated Claude adapter each have recorded install/discovery smoke results for the surfaces claimed in documentation.
6. The three UI prototypes pass the shared state, responsive, keyboard, dark-mode, and accessibility gates. One production direction and the rejection reasons for the other two are recorded before integration.
7. Existing 254 tests remain present, all newly added tests pass, D1 race checks pass, and tests make zero real Cloudflare, Resend, DNS, SMTP, or external email calls.
8. Public repository creation/push, provider login, DNS/MX changes, remote migration, deployment, webhook creation, and external test mail remain separate explicit Risk Gates even after local implementation passes.
