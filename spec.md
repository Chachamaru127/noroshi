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

- Setup is BYOK. Cloudflare, Resend, and a future Gmail connector's Google Cloud project and OAuth credentials are owned and supplied by the operator. QuickMail-ja does not ship a shared provider API key, OAuth Client ID, or OAuth Client Secret.
- Interpret `Agent 1.0` as Agent Plugins Specification 1.0.0 plus the Agent Skills specification.
- Keep one portable setup core: a root `plugin.json`, Agent Skills under `skills/`, and an optional `mcp.json`. Generate or maintain thin client adapters only where the host requires them.
- Support Codex and ChatGPT only on surfaces where the official plugin/App capability is available. Treat Claude Code/Desktop as a separate native adapter and verify it independently; Agent Plugins 1.0 does not itself guarantee Claude installation.
- Keep `skills/quickmail-ja-setup` as the single guidance source. Repo-scoped Codex and Claude Code files may only point to that source; they must not copy its instructions. A clone may enable repo discovery in supported coding clients, but it never auto-installs a Skill in ChatGPT or Claude Desktop. Those surfaces require their supported upload or plugin flow and an independent smoke result.
- A portable guidance-only Skill may ship before QMJ-10. It may open allowlisted official pages when the host has browser capability and the user permits it, but it does not create, save, delete, deploy, change DNS, enter secrets, or send mail. Provider mutations remain blocked until the QMJ-10 approval engine exists.
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

### Sandbox HOTL validation contract

- `HOTL` means the operator monitors an already-approved sandbox run while the assistant continues through local tests, FakeProvider exercises, read-only inspection, readback, verification, evidence capture, and wait/resume work. Monitoring does not waive the human-only steps or exact one-step approvals above.
- Real-provider validation uses one fresh Cloudflare test account, one fresh Resend test team, one dedicated non-production DNS zone, isolated client profiles, and only tester-controlled sender and recipient addresses. A production account, customer zone, existing mailbox, deployment, backup, or customer message is outside the sandbox envelope.
- The default pilot is free-tier only and may create at most one Worker, one D1 database, one R2 bucket, one Email Routing destination or catch-all rule, one Resend domain, and one webhook. Any payment request, plan upgrade, extra resource, or scope expansion stops before the action and requires a new decision.
- Resource creation, secret staging, migration, deploy, webhook creation, Email Routing or catch-all enablement, each external test send, rollback, and cleanup remain separate one-use approvals. One exact, same-purpose DNS change-set may be one approval when it is bound to the account, zone, domain, complete before/after diff, and rollback; an apex MX cutover is always a separate approval. A test account does not make these actions read-only or harmless.
- A real send is limited to the exact tester-controlled address and non-sensitive From, subject, and body shown before approval. The approval is one-use. Its canary operation has one fixed idempotency key, and a resume or replay of that same operation reuses the key so it cannot create a second delivery. An unknown delivery result is inspected and never automatically retried.
- The assistant stops before mutation on account, team, zone, domain, origin, plan hash, current-state fingerprint, cost, permission, or ownership mismatch; provider read failure; same-name collision; unexpected DNS; secret exposure; a non-allowlisted recipient; or rollback drift.
- Each step records only non-secret evidence: client/version/date, source revision and package checksum, immutable sandbox target references, capability ID, before-state fingerprint, exact diff, cost class, approval ID and expiry, provider result ID when safe, readback, and outcome. Secret values, message bodies, customer headers, QR codes, browser profiles, and screenshots containing credentials are excluded.
- Rollback restores only records and rules whose immutable ownership and before-state snapshot match. It is idempotent and does not automatically delete a zone, D1 database, non-empty R2 bucket, Worker, or Resend domain. Destructive cleanup is a later exact-step approval.

## Support Knowledge contract

- Competitor setup guides and FAQs are discovery inputs, not distributable content. QuickMail-ja stores original, human-reviewed resolution patterns and source metadata; it does not copy FAQ prose, raw HTML, screenshots, hidden text, scripts, or community instructions into the product or a runtime RAG index.
- The dated competitor list in `docs/research/japan-market-competition-2026-08-27.md` has a one-to-one Source Registry. Each source records the product, category, primary URL, document type or `not_found`, verification date, review-by date, and confidence.
- Support Patterns are organized by user intent and setup stage rather than competitor. Every pattern records applicability, diagnostic questions, safe steps, human-only work, prohibited actions, Risk Gate, rollback, expected evidence, unsupported cases, source references, verification date, and confidence.
- Answer precedence is: this product contract and QuickMail-ja documentation; current Cloudflare and Resend primary documentation; competitor primary documentation; official issues and releases. Community material may discover a candidate but cannot authorize a concrete provider change.
- Cloudflare/Resend operational instructions expire after 30 days unless re-verified. Stale or unsupported patterns stop at current-state inspection and point to the primary source; they do not provide concrete mutation steps.
- The Knowledge Pack contains zero customer names, domains, email content, provider IDs, DNS values, secrets, local paths, or copied third-party FAQ bodies. The current AI consultation UI consumes a bounded list of official sources and no more than two stable, high-frequency pitfalls per setup stage from the reviewed Pack. It does not embed a complete safe-step checklist, expected-evidence checklist, prohibitions, or rollback procedure in the handoff prompt. The provided Setup Skill ships a generated, setup-only projection of the same Pack for standalone uploads and checks it for source drift. The not-yet-provided Setup MCP must consume the same Pack when implemented.

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
  - `calm`: Material 3-informed, search-first, conversation-first, and lower density
  - `command`: Fluent 2-informed, compact command bar and three-pane desktop layout
  - `classic`: Bolt- and Thunderbird-pane-informed, folder tree and high-density multi-column message list
- These are QuickMail-ja-owned patterns, not Gmail, Outlook, or Thunderbird implementations. Official sources define roles and interaction principles; QuickMail-ja owns every shipped value, component, icon choice, and layout implementation.
- Comparison UI names are `Gmail風`, `Outlook風`, and `Thunderbird風` so the three reference directions are immediately understandable. These text-only nominative references do not use vendor logos or claim affiliation. A publicly reachable comparison preview states that it is unofficial, unaffiliated, synthetic, and unable to send or receive real mail.
- The three patterns use one QuickMail-ja color palette, one system-font stack, and one icon set. They differ through pane structure, density, borders, radius, information hierarchy, and action placement. Vendor palettes are not comparison variables.
- Internally, the comparison is themeable through two bounded layers: a shared visual theme for color, typography, focus, icons, and light/dark behavior; and a `UIProfile` for pane composition, density, action placement, and responsive collapse rules. A profile is not a CSS-only skin because the mail DOM composition differs by pattern.
- The repository keeps `docs/design/patterns/base.DESIGN.md` as the single visual-theme primitive and semantic token source plus three profile deltas. Each source note separates the upstream role or principle from the QuickMail-ja local value and records the official URL and verification date.
- The static comparison demo uses one explicit `UIProfile` registry. Each runtime entry is limited to a stable generic ID, public Japanese label, and renderer, with an optional short evaluator description. Layout metrics, pane widths, breakpoints, and responsive rules stay in the profile DESIGN document, renderer/CSS, and contract tests rather than becoming a data-driven runtime schema. Adding a future comparison pattern requires one profile entry, one delta document, its renderer, and contract tests; it does not require editing an unrelated profile.
- The first-release profile mechanism is local and statically registered. It does not provide dynamic plugin loading, third-party theme installation, arbitrary inheritance, remote theme downloads, per-user production switching, or a public theme SDK.
- Fluent UI React, Material Web, Bolt code, and vendor Figma exports are reference material only and are not runtime dependencies or checked-in assets. Figma kits may be viewed by a human, but their components, images, icons, and exports are not copied into the repository.
- Do not copy mail-client vendor logos, proprietary fonts, screenshots, or pixel layouts. Each `風` profile may use a local palette close to the referenced product so users can distinguish it, but must remain an independently implemented approximation and must not imply partnership or official support. The only icon-mark exception is the equal-size, bundled Remix Icon provider marks defined by the AI consultation contract; they remain limited to those three AI launch actions and must retain text labels.
- The first public release ships one selected production system, not three runtime themes. Light, dark, and system color modes remain supported within the selected system.
- All prototypes preserve the same routes, Japanese labels, mobile full-screen flow, keyboard behavior, and semantics. They differ in pane structure, density, borders, radius, and action placement.
- Before selection, all patterns use synthetic data only, remain excluded from the production bundle, and cover the three comparable task states: inbox, selected message, and compose. Loading, empty, error, success, offline, long-Japanese, attachment, HTML, reduced-motion, dark, mobile, keyboard, and screen-reader completion gates apply to the selected pattern during production integration; the comparison lab keeps representative failure and accessibility coverage needed for a fair choice.
- The public comparison preview is `noindex,nofollow`, contains no external font request, and preserves the selected mailbox, selected message, first visible message as a logical anchor, and the complete synthetic draft fields and attachment metadata when switching patterns. Focus moves to the same logical message or control when available and otherwise returns to the pattern selector; raw pixel scroll positions need not match across different structures.
- The comparison structures are fixed by viewport: `calm` is navigation plus a list whose selected message replaces the list at 1440, 1024, and 390; `command` is folder/list/reader at 1440, collapsed-navigation/list/reader at 1024, and one screen at 390; `classic` is folder-tree/thread-table/reader at 1440 and 1024 with fewer metadata columns at 1024, and one screen at 390.

## Safety and distribution boundaries

- Preserve the original MIT license and attribution to DivinPrince/quickmail.
- Base public history on upstream commit `77e8858acc5043fcc103f8560c60d0c5f958ccc0`; do not import any deployment-specific downstream history.
- Do not include active custom routes, Cloudflare account IDs, D1 IDs, R2 production names, real domains, real email addresses, secrets, backups, `.wrangler`, `out`, or `.harness*` state. Under `.claude`, the only distributable path is the enumerated regular-file adapter `.claude/skills/quickmail-ja-setup/SKILL.md`; `.claude/state` and every other operational or client-local file remain forbidden. The same exact-path rule applies to `.agents/skills/quickmail-ja-setup/SKILL.md`.
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
