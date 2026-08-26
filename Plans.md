# QuickMail-ja Repository Separation Plan

Status: Local sanitized release candidate complete; market/plugin/UI plan added — implementation, public release, and deployment remain on HOLD
Team validation mode: `subagent`

## Purpose

Separate an existing customer deployment from a publishable generic Japanese product without exposing downstream history or production identifiers.

## Pre-approval and risk gates

- Pre-approved local work: create the sibling repository, edit generic source/docs/tests, install dependencies, run local tests/builds, and create local commits.
- No secret reads are required.
- No destructive action against the existing production repository is permitted.
- GitHub repository creation/push, Cloudflare deployment, DNS changes, production D1/R2 access, and external email sends are separate Risk Gates and are out of scope.

## Task graph

### QMJ-1 — Establish the public-history boundary

Status: Completed locally — reachable product history and the independent repository boundary are clean

- Keep only the original upstream history through `77e8858`.
- Keep the remote named `upstream`; do not configure `origin` until the public repository exists.
- Record this product contract and plan.
- Confirm the production downstream repository remains untouched.

Acceptance:

- Independent repository exists at the requested path.
- `git log` contains upstream history only before generic commits.
- No deployment-specific downstream commit is reachable from QuickMail-ja.

### QMJ-2 — Import and generalize the feature set atomically

Depends on: QMJ-1
Status: Completed locally

- Import the current application feature set without importing the downstream `.git`, backups, operations files, or Harness state.
- Replace all customer branding, domains, addresses, Worker/D1/R2 values, examples, and test fixtures with generic values before the first feature commit.
- Use QuickMail-ja as the product name and Japanese as the fixed first-release UI language.
- Keep the supported topology consistent: Cloudflare Email Routing inbound and Resend outbound.
- Make Outlook import inputs explicit and generic.
- Preserve manual/automatic forwarding, folders, sender/subject rules, signatures, API keys, CLI, MCP, and existing security controls.

Acceptance:

- The first QuickMail-ja feature commit contains no customer-specific text or production identifier.
- No active custom route or real Cloudflare resource ID exists.
- Existing behavior is covered by tests before commit.

### QMJ-3 — Make distribution and documentation truthful

Depends on: QMJ-2
Status: Completed locally

- Write a Japanese-first README with topology, cost boundary, limitations, backup/recovery, and update flow.
- Retain MIT attribution and identify the upstream source/base.
- Disable or clearly mark remote installer/Deploy links until a QuickMail-ja GitHub URL exists.
- Add an upstream sync procedure that keeps customer production changes downstream.
- Expand clean-template checks and CI to include tests and D1 verification.

Acceptance:

- A new user cannot be directed to the original upstream build while believing it is QuickMail-ja.
- Documentation and generated configuration describe the same inbound/outbound topology.

### QMJ-4 — Validate the generic release candidate

Depends on: QMJ-3
Status: Completed locally — automated gates pass and the independent A-security review approved

- Run dependency install, unit tests, D1 integration/race tests, type checks, formatter checks, template-clean checks, build, and diff checks.
- Scan the tracked tree, new commit history, and distributable output for customer-specific strings, UUIDs, real routes, state folders, and backups.
- Verify the production downstream tracked tree is unchanged.
- Obtain independent security/privacy and product/QA reviews.

Acceptance:

- All automated gates pass or any baseline-only warning is documented.
- Independent reviewers return APPROVE with no unresolved P0/P1 finding.

### QMJ-5 — Local handoff

Depends on: QMJ-4
Status: Completed locally — sanitized release-candidate handoff is prepared without push or deployment

- Create clean local commits only.
- Report both repository paths, commit IDs, validation evidence, and the remaining external publication gate.
- Turn Harness work mode off.

Acceptance:

- The generic product and production downstream are independent repositories.
- No push or deployment has occurred.

## Local validation evidence — 2026-08-26

- `bun install --frozen-lockfile`: completed with no dependency changes.
- `bun test`: 254 passed, 0 failed.
- `bun run test:d1-forwarding`: passed.
- `bun run check`: 0 errors, 0 warnings.
- `bun run format:check`: passed.
- `bun run check:clean`: passed across 261 tracked files, including text `bun.lock`.
- `bun run build`: passed.
- `bun run test:archive`: the extracted archive passed its included `check:clean` guard.
- `git diff --check` and `git diff --cached --check`: passed.
- Outlook import destructive-boundary tests cover equal/nested paths, root/home/working-directory boundaries, non-owned non-empty staging, marker/manifest symlink rejection, and marked staging reuse without recursive deletion. An exclusive staging lock spans scan through manifest install; bigint nanosecond fingerprints detect in-place mutation. Lock and temporary-file removal first renames to a random same-directory quarantine, verifies the moved inode, and deletes only an exact match; mismatches remain quarantined and block later imports.
- `BOOTSTRAP_SECRET` runtime tests cover missing (503), wrong (403), and correct-key execution through mocked database/provider dependencies without external calls.
- The tracked working tree and reachable product commits passed the forbidden customer/source identifier scan and the case-sensitive local absolute-path scan.
- `LICENSE.md` is byte-identical to upstream commit `77e8858`.
- Independent A-security review returned APPROVE. This is not approval to publish or deploy.

## HOLD gates after local validation

- Public repository creation, `origin` configuration, push, release publication, Cloudflare deployment, DNS changes, remote D1/R2 access, and email sends remain external Risk Gates.
- A QuickMail-ja public URL is not configured. Remote installer and Deploy links remain disabled.
- Release hardening remains separate: pin GitHub Actions and Bun to reviewed immutable versions, then verify deployed logging, retention, privacy, cost alerts, and rollback behavior in the release environment.
- The final public handoff must use the intended no-tags sanitized commits so ignored local state, tags, and unreachable Git objects cannot enter the published repository.
- No public release approval is claimed by the local validation or independent A-security approval.

## Spec delta

Before: the production downstream combines generic application code with production configuration, operational history, and customer-specific UI copy.

After: the existing deployment remains the production downstream. QuickMail-ja contains only generic Japanese-first product code and public-safe history. Production configuration and customer operational records remain downstream-only.

## Review findings incorporated

- Product: a separate repository is justified by Japanese setup/operations plus forwarding, folders, rules, and migration—not translation alone.
- Architecture: use upstream ancestry plus one scrubbed feature commit; never copy the downstream `.git` directory.
- Security: exclude backups, `.wrangler`, output, Harness state, real identifiers, and all customer-specific history.
- QA: align setup/docs on Cloudflare inbound + Resend outbound; strengthen clean-template and CI gates.
- Skeptic: keep publication blocked until the full tracked tree and reachable QuickMail-ja history are customer-neutral.

## Next roadmap — Japanese setup distribution, Agent Plugin, and UI direction

Status: QMJ-6, QMJ-6A, QMJ-6B, and QMJ-7 are complete locally. QMJ-8 onward are not implemented. Public release remains HOLD.

### Product decision

QuickMail-ja is positioned as a Japanese-first self-hosted webmail with guided setup, migration, and recovery. It is not positioned as the only Cloudflare webmail. The dated evidence is `docs/research/japan-market-competition-2026-08-27.md`.

`Agent 1.0` means Agent Plugins Specification 1.0.0 plus the Agent Skills specification. The portable standard covers packaging of Skills and MCP; browser operation, authentication, approval UX, and secret storage remain host-specific.

The three requested UI directions are comparison prototypes. The first public release selects one production system rather than maintaining three runtime themes.

### Priority boundary

Required:

- QMJ-6, QMJ-6A, QMJ-6B, and QMJ-7 through QMJ-14 below.
- Read-only-first setup planning, least-privilege credentials, separate approval classes, DNS rollback, runtime hardening, and client compatibility evidence.
- Three isolated UI prototypes followed by one recorded production choice.
- One source-attributed Support Knowledge Pack shared by the Japanese UI, Setup Skill, and future Setup MCP.

Recommended:

- QMJ-15 sandbox pilot on each claimed client.
- Remote MCP/App adapter after the portable local core is stable.
- Japanese user validation with five small-organization operators.
- A dated comparison page against domestic managed mail on ownership, cost responsibility, and operating burden.

Optional after first release:

- Build-time alternative UI preset, remote multi-device setup session, managed setup service, automated key rotation, team/RBAC, and Cloudflare Email Service outbound.

Reject for first release:

- `国内唯一` or `競合なし` claims.
- Autonomous signup, terms acceptance, CAPTCHA/MFA, payment, domain purchase, or transfer.
- Broad `--yes`, self-approval, one confirmation for multiple risk classes, or secrets in chat/plugin/MCP env/plaintext files.
- Three vendor-inspired production themes, vendor assets, or pixel-identical clones.
- AI inbox, IMAP bridge, shared team workspace, or enterprise archive added only to match competitors.
- Copying, scraping, or bundling competitor FAQ prose, HTML, screenshots, or hidden instructions.
- Describing public AI query links as setup automation, official support, or authorization to change provider state.

### Pre-approval and Risk Gates for this roadmap

Approval state: planning plus local implementation of QMJ-6A/QMJ-6B was requested and completed. QMJ-8 onward and every external mutation remain pending.

- Secret reads for local implementation and automated tests: none. Tests use canaries and FakeProvider only.
- Locally safe for QMJ-6A/QMJ-6B: edit generic source/docs/tests, create public-only fixtures, run local checks/builds, and create local commits. No new dependency is required for this slice.
- Separate exact-action approval required: provider OAuth/login, account/team selection, resource creation, secret staging, remote D1 migration, deployment, webhook creation, Email Routing enablement, DNS/MX/catch-all change, external test send, revocation/deletion, billing, repository publication, push, and release publication.
- Human-only: account registration, terms, CAPTCHA, MFA/passkey, payment, plan upgrade, domain purchase, and transfer.
- External-send gate: off by default. A future canary requires one user-entered recipient they control, exact From/subject/body preview, one-use idempotency key, and a separate approval.
- No plan approval authorizes any existing production deployment, mailbox, real DNS zone, or customer data.

### Task graph

#### QMJ-6 — Dated market and competition evidence

Priority: Required
Depends on: QMJ-5
Status: Completed in planning

- Research direct Cloudflare-native products, traditional Japanese webmail/server products, domestic managed mail, and SaaS substitutes.
- Use Grok as an independent discovery/rebuttal pass and verify product claims against primary sources.
- Record observation date, classification, URLs, unknowns, and the `not observed != absent` rule.

Binary DoD:

- `docs/research/japan-market-competition-2026-08-27.md` exists and contains direct, adjacent, and managed/SaaS alternatives.
- Every named product has a primary URL and observation date.
- Exclusivity claims are 0; exact-match non-observation is labeled with medium confidence.

#### QMJ-7 — Product, setup, and UI contract delta

Priority: Required
Depends on: QMJ-6
Status: Completed in planning

- Update `spec.md` with the product position, Agent Plugins 1.0 interpretation, provider/browser/secret boundaries, and UI prototype contract.
- Record the UI Design Read, design dials, shared fixtures, states, and selection gates.

Binary DoD:

- `spec.md` names Agent Plugins 1.0.0 and separates portable packaging from host browser/auth capability.
- `docs/design/ui-patterns-plan.md` defines `calm`, `command`, and `classic`, including loading/empty/error/offline/mobile/dark/keyboard states.
- The contract says one selected production UI and forbids vendor asset/pixel copying.

#### QMJ-6A — Source-attributed Support Knowledge Pack

Priority: Required
Depends on: QMJ-6 and QMJ-7
Status: Completed locally on 2026-08-27

- Register all 24 products/configurations in the dated competition report without copying their documentation. Record primary setup/FAQ sources when present, or `not_found` with the observation date.
- Normalize the highest-value setup and recovery lessons into Japanese intent-based Support Patterns covering pre-deploy, Cloudflare deployment, Email Routing/MX/Catch-all, Resend outbound verification, D1/R2 bindings, first admin/setup key, Outlook/EML import, backup, recovery, and Gmail limitations.
- Make QuickMail-ja's fixed topology authoritative. Mark Resend Receiving, Resend apex inbound MX, broad provider MCP access, and full-access runtime credentials as prohibited or inapplicable.
- Validate the Pack locally and keep it consumable by the UI, Setup Skill, and future Setup MCP without adding runtime scraping, embeddings, or a new database.

Binary DoD:

- The Source Registry covers 24/24 entries in the competition report exactly once, each with primary URL or `not_found`, category, verification date, review-by date, and confidence.
- Every Support Pattern passes the schema and contains applicability, safe steps, human-only work, prohibited actions, Risk Gate, rollback, expected evidence, unsupported cases, source references, and verification date.
- Stored competitor prose, raw HTML, screenshots, hidden text, scripts, long quotations, customer values, provider IDs, DNS values, secrets, and local paths are 0.
- Stale, missing-source, or unsupported entries fail closed to primary-source re-verification instead of concrete mutation instructions.
- Knowledge tests perform 0 Cloudflare, Resend, DNS, SMTP, AI-service, or external-email calls.

Evidence:

- `support/knowledge/sources.json` registers the 24 researched products/configurations and 12 authoritative provider references with dated provenance.
- `support/knowledge/patterns.json` contains 15 schema-validated Japanese setup, limitation, and recovery patterns.
- `bun test scripts/support-knowledge.test.mjs` and `bun run check:clean` pass without external calls.

#### QMJ-6B — AI consultation dock and dormant Cloudflare Deploy banner

Priority: Required
Depends on: QMJ-6A and QMJ-7
Status: Completed locally on 2026-08-27

- Add a reusable Japanese consultation component with a visible prompt preview, explicit copy action, and text-only `ChatGPTに聞く`, `Claudeに聞く`, and `Geminiに聞く` controls.
- Use a pure prompt/link module with fixed provider origins and paths, an allowlisted setup-stage enum, conservative length limit, control/bidi/HTML rejection, and secret-pattern blocking. Do not read the page, forms, mailbox, current URL, provider error, domain, DNS, account, or secret state.
- Treat ChatGPT prefill as best-effort, Claude prefill as documented, and Gemini as copy-then-open. Never substitute another Google product or auto-send.
- Add a disabled Cloudflare Deploy banner. It becomes active only after a canonical public QuickMail-ja repository, deployment hardening, provenance/archive checks, and explicit release approval.
- Explain the three support tiers: AI consultation link (no permission), Setup Skill (instructions), and Setup MCP (future exact-step approval). Keep the current mailbox MCP separate.

Binary DoD:

- Generated AI destinations are fixed allowlisted origins/paths and make 0 provider API calls; decoded prompt equals the visible/copyable prompt.
- Secret, HTML-like, control/bidi, or overlength input yields 0 AI href and 0 clipboard action. Page/form/mail/domain/provider/DNS state is never interpolated.
- The three controls are keyboard reachable, text-labeled, at least 44px, and have a visible copy fallback with `aria-live` feedback. External links use `noopener noreferrer` and `referrerpolicy=no-referrer`.
- ChatGPT/Gemini limitations and external-provider data handling are disclosed; no button claims setup automation or official support.
- While the public repository URL is absent or release status is HOLD, active Cloudflare Deploy links are 0. The banner states `deploy != mail ready` and lists the remaining setup classes.
- Unit, Japanese-copy, accessibility, distribution-contract, clean-template, build, archive, and diff checks pass with 0 external network call from tests.

Evidence:

- `src/lib/components/AiSupportDock.svelte` and `src/lib/ai-support.ts` implement the visible prompt, copy fallback, and fixed three-provider handoff.
- `README.md` contains an intentionally inactive Cloudflare Deploy banner and the post-deploy mail-readiness boundary.
- `bun test src/lib/ai-support.test.ts src/lib/ai-support-a11y.test.ts scripts/deploy-banner.test.mjs`, `bun run check`, and `bun run check:clean` pass without provider calls.

#### QMJ-8 — Upstream reconciliation and setup threat model

Priority: Required
Depends on: QMJ-6A, QMJ-6B, and QMJ-7
Status: Not started

- Independently review the six commits currently on `upstream/main` but not local `main`, including manual forwarding, domain-scoped conversations, account roles, mobile sign-out, and compose changes.
- Preserve QuickMail-ja forwarding, folder/rule, Outlook import, Japanese UI, and privacy contracts while reconciling relevant fixes.
- Define a capability registry for every setup action: provider, read/write/destructive/send/billing class, required scope, data handled, cost class, confirmation class, and rollback.
- Treat same-name D1/R2/Worker resources as collisions unless a matching ownership manifest is explicitly adopted.

Binary DoD:

- Each of the six upstream commits has a keep/adapt/reject decision and regression evidence.
- All upstream-reconciled tests pass and the existing 254-test baseline has no deleted test without a recorded replacement.
- Every future setup action exists in one capability registry and the setup plugin exposes zero mailbox read/send/admin tools.
- Independent security and skeptic reviewers have no unresolved P0/P1 finding.

#### QMJ-9 — Runtime and setup hardening before provider writes

Priority: Required
Depends on: QMJ-8
Status: Not started

- Add login/setup rate limits, CSP/HSTS/frame/referrer/permissions headers, same-origin/CSRF negative coverage, upload limits before buffering, privacy/log retention, cost-alert guidance, and external-font removal.
- Replace the current one-key Resend setup. A temporary full-access setup credential may inspect/create domain or webhook but is never deployed; the Worker receives only a domain-restricted sending key.
- Remove plaintext production secret persistence from `.dev.vars` and prevent secrets from chat, stdout/stderr, snapshots, manifests, MCP env, audit, screenshots, and archives.
- Remove default-first Cloudflare account selection and block agent-mode `--yes` for external changes.
- Pin Bun, Wrangler, CI actions, plugin artifacts, and dependencies to reviewed immutable versions; produce checksum/SBOM/provenance and reject `curl | sh`/`@latest` release paths.

Binary DoD:

- Rate-limit, headers, origin/CSRF, upload-limit, and privacy tests pass.
- Secret canaries occur 0 times in model I/O fixtures, env files, logs, snapshots, state, archives, and distributable output.
- Ambiguous account/team/zone selection, provider read failure, same-name collision, and unattended write each cause a fail-closed stop with 0 provider writes.
- Worker runtime contains a sending-only domain-restricted Resend key and never contains a full-access setup key.
- Independent security review returns APPROVE.

#### QMJ-10 — Provider-neutral inspect/plan/apply engine

Priority: Required
Depends on: QMJ-9
Status: Not started

- Split setup into `inspect -> plan -> apply(step) -> readback -> verify`.
- Emit a canonical mutation plan with immutable account/team/zone/domain/resource IDs, exact before/after diff, cost class, rollback, plan hash, expiry, and one-use approval ID.
- Use official Cloudflare and Resend MCP/API capabilities behind a narrow allowlisted setup adapter; never expose either full provider toolset. Keep adapters behind FakeCloudflare, FakeResend, FakeBrowser, and FakeDNS seams.
- Stage resource creation, secret upload, remote migration, deploy, webhook, Email Routing, DNS/catch-all, external send, and cleanup as separate steps.
- Export authoritative DNS and routing rules before any cutover. Never add Resend Receiving or Resend apex inbound MX.

Binary DoD:

- Dry-run and every automated test make 0 real Cloudflare, Resend, DNS, SMTP, or external-send calls.
- Target ID, current-state fingerprint, plan hash, expiry, or approval mismatch yields 0 writes.
- Existing M365/Gmail MX fixtures produce an exact snapshot, diff, and idempotent rollback without removing concurrent/unowned records.
- Provider-list failure is an error, not an empty list; duplicate webhook/resource creation is prevented.
- Rollback can be run twice and never automatically deletes D1, non-empty R2, a zone, or a Resend domain.

#### QMJ-11 — Agent Plugins 1.0 package and host adapters

Priority: Required
Depends on: QMJ-6A and QMJ-10
Status: Not started

- Add the portable root `plugin.json`, `skills/quickmail-ja-setup/SKILL.md`, an operations Skill, and optional `mcp.json` from one capability registry.
- Reuse the QMJ-6A Knowledge Pack as the Skill's reviewed setup reference instead of duplicating competitor instructions.
- Keep the setup plugin separate from the mailbox MCP.
- Add a Codex/ChatGPT adapter only for officially supported surfaces and a separately generated Claude Code/Desktop adapter.
- Capability-adapt browser assistance: official allowlisted origins only; page text, email, DNS, provider errors, downloads, QR codes, and unexpected tabs/iframes are untrusted.
- Stop for human takeover on login credentials, MFA, CAPTCHA, terms, payment, account switch, unexpected origin, or DOM/API mismatch.

Binary DoD:

- Agent Plugins 1.0 schema validation and Agent Skills validation pass.
- Path traversal, symlink escape, secret-in-env, unsupported transport, unknown capability, and capability-drift fixtures fail closed.
- Codex/ChatGPT documentation claims only surfaces with a recorded install/discovery smoke. Claude remains labeled unverified until its native smoke passes.
- Browser-less execution reaches the same manual checklist without losing state.
- Installing the setup plugin grants 0 mailbox/provider-email read, email send, or QuickMail admin capability, and exposes 0 provider tool outside the capability registry.

#### QMJ-12 — Isolated UI comparison lab

Priority: Required
Depends on: QMJ-7; may run in parallel with QMJ-8 through QMJ-11
Status: Not started

- Capture the existing light/dark baseline at 1440x900, 1024x768, and 390x844.
- Build `calm`/シンプル, `command`/3ペイン, and `classic`/高密度 from one synthetic Japanese fixture and one interaction contract.
- Keep prototypes development-only and out of production routes and bundle.
- Cover selection, body, compose, loading, empty, error, success, offline, long Japanese subject, attachment, and HTML body states.

Binary DoD:

- All three patterns render the same fixtures and states at 1440px, 1024px, and 390px in light and dark mode.
- Horizontal overflow is 0; touch targets are at least 44px; keyboard flow reaches navigation, message selection, body, and reply.
- axe serious/critical violations are 0 and text/form/button contrast meets WCAG AA.
- Vendor logos, proprietary fonts, screenshots, trademark images, and production imports of prototype code are 0.

#### QMJ-13 — UI evaluation and one-system decision

Priority: Required
Depends on: QMJ-12
Status: Not started

- Run the same five tasks: initial comprehension, inbox scan, folder move, message inspection, and reply start.
- Record time, confusion, and misoperation with up to five Japanese small-organization operators.
- Score familiarity, information density, mobile behavior, keyboard/accessibility, and maintenance cost.
- Record the selected pattern and rejection reasons in an ADR.

Binary DoD:

- All participants run the same fixture and five tasks.
- One pattern has a recorded accept decision and two have explicit rejection reasons.
- Production integration references one design system only; runtime vendor-style switching remains absent.

#### QMJ-14 — Selected UI integration and local cross-cutting QA

Priority: Required
Depends on: QMJ-6A, QMJ-6B, QMJ-11, and QMJ-13
Status: Not started

- Integrate only the selected layout into existing components and preserve Japanese routes, folders, forwarding, compose, mobile, and light/dark/system behavior.
- Add Playwright/axe visual and functional smoke with temporary local D1 and fake providers.
- Ensure inbox/API failures are visible and preserve user selection where recovery is possible.
- Extend clean-template, archive, and CI checks to plugin/adapters/design assets.

Binary DoD:

- Existing 254 tests remain represented; full suite, D1 race, type, format, clean-template, build, archive, and diff checks pass.
- Chromium/Firefox/WebKit functional smoke and 18 representative visual snapshots pass with external network denied.
- Production bundle contains 0 unselected design-system dependency, 0 design-lab route, and 0 external Google Fonts request.
- Independent product, accessibility, QA, skeptic, and security reviewers return APPROVE with no unresolved P0/P1.

#### QMJ-15 — Claimed-client sandbox pilot

Priority: Recommended and externally gated
Depends on: QMJ-14
Status: Not started

- Install the package in isolated Codex Desktop/ChatGPT, Claude Code, and Claude Desktop profiles only on surfaces intended for public claims.
- Start with FakeProvider, then use a new sandbox account/domain or non-production subdomain if separately approved.
- Exercise inspect, plan, reject, resume, apply, readback, verify, and rollback. Send no real mail unless separately approved to one controlled address.

Binary DoD:

- Every claimed surface has dated install/discovery evidence and a documented unsupported fallback.
- No production zone, MX, mailbox, existing deployment resource, or customer data is touched.
- Sandbox rollback restores the exact prior state and leaves no unowned mutation.

#### QMJ-16 — Public release gate

Priority: Release Gate
Depends on: QMJ-14; QMJ-15 for browser/setup claims
Status: HOLD

- Re-run market claims, trademark/name review, upstream divergence, archive/privacy scan, dependency audit, SBOM, signatures/provenance, rollback, cost, and documentation truthfulness.
- Keep repository creation/push, plugin publication, provider login, deploy, DNS, remote migration, webhook, and external send as distinct user approvals.

Binary DoD:

- Public artifact checksum/signature/provenance verifies and contains no secret, customer value, browser profile, local path, state folder, backup, or unselected design prototype.
- Every public capability claim has recorded evidence; unsupported host behavior is labeled.
- The user explicitly approves each external release action immediately before it occurs.

### Review loops

- After QMJ-8: architecture + security + skeptic review; fix all P0/P1 before QMJ-9.
- After QMJ-11: Agent Plugins schema/host-compatibility + security/abuse review; fix all P0/P1 before any real provider pilot.
- After QMJ-13: product + Japanese UX + accessibility review; record one UI decision before production integration.
- After QMJ-14: independent integrated review across spec, security, accessibility, QA, and archive/privacy boundaries.
- After QMJ-15: release review based on sandbox evidence. Passing local tests never implies public release or production completion.
