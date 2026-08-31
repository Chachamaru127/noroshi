# QuickMail-ja Repository Separation Plan

Status: Local sanitized release candidate and QMJ-9 runtime/setup hardening complete — public release, provider writes, and deployment remain on HOLD
Team validation mode: `subagent`

## Purpose

Separate an existing customer deployment from a publishable generic Japanese product without exposing downstream history or production identifiers.

## Pre-approval and risk gates

- Pre-approved local work: create the sibling repository, edit generic source/docs/tests, install dependencies, run local tests/builds, and create local commits.
- No secret reads are required.
- No destructive action against the existing production repository is permitted.
- GitHub repository creation/push, Cloudflare deployment, DNS changes, production D1/R2 access, and external email sends are separate Risk Gates and are out of scope.
- QMJ-12 implementation may add a pinned QA-only accessibility dependency after lockfile/license review; it may not add Fluent UI React, Material Web, Bolt, a vendor font, or another runtime design-system dependency.
- Updating the public Pages comparison preview is an external deployment Risk Gate. It requires a final local review, exact artifact readback, and explicit approval immediately before deployment. It does not authorize email send, DNS, production Worker, D1, or R2 changes.
- The currently deployed preview predates the current `noindex` and reviewed-artifact contract. Treat it as a known non-compliant baseline and do not describe or share it as the approved comparison until a reviewed artifact is explicitly approved and redeployed.
- QMJ-13 participant outreach is an external-contact Risk Gate. Collect only anonymous usage categories, never names, email addresses, recordings, or mailbox content, and request approval before inviting participants.

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

Status: QMJ-6, QMJ-6A, QMJ-6B, QMJ-7, QMJ-8A, and QMJ-9 are complete locally. QMJ-8B runs in parallel and remains a release dependency. QMJ-10 provider-neutral local engine and QMJ-11B Agent Plugin packages (portable root plus Codex native repo marketplace adapter, operations, and canonical BYOK guidance Skill) are implemented; real provider adapters and ChatGPT desktop UI discovery remain unverified. Public release remains HOLD.

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

Approval state: planning plus local implementation of QMJ-6A/QMJ-6B and the guidance-only QMJ-11A packaging increment was requested. QMJ-10 local engine and QMJ-11B portable/native packages are implemented, while real provider adapters, ChatGPT desktop UI discovery, and every external mutation remain pending. Public release remains HOLD.

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
- The contract says one selected production UI and forbids vendor asset/pixel copying outside the narrow, text-labeled AI consultation mark exception.

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

- Add a reusable Japanese consultation component with a visible prompt preview, explicit copy action, and `ChatGPTに聞く`, `Claudeに聞く`, and `Geminiに聞く` controls. Only these controls may pair equal-size bundled Remix Icon provider marks with the permanent text labels. The marks must stay subordinate to QuickMail-ja branding, must not imply partnership or official support, and remain subject to each provider's trademark ownership and policies. Vendor branding remains prohibited elsewhere.
- Use a pure prompt/link module with fixed provider origins and paths, an allowlisted setup-stage enum, conservative length limit, control/bidi/HTML rejection, and secret-pattern blocking. Do not read the page, forms, mailbox, current URL, provider error, domain, DNS, account, or secret state.
- On one user click, synchronously revalidate the fixed HTTPS destination, start clipboard copy, and allow safe new-tab navigation. Treat ChatGPT and Claude `q` prefill as best-effort. Open Gemini with a query-free HTTPS URL and the copied prompt. Never use an undocumented custom scheme, substitute another Google product, or auto-send; the user reviews and sends.
- Add a disabled Cloudflare Deploy banner. It becomes active only after a canonical public QuickMail-ja repository, deployment hardening, provenance/archive checks, and explicit release approval.
- Explain the three support tiers: AI consultation link (no permission), Setup Skill (instructions), and Setup MCP (future exact-step approval). Keep the current mailbox MCP separate.

Binary DoD:

- Generated AI destinations are fixed allowlisted origins/paths and make 0 provider API calls; decoded prompt equals the visible/copyable prompt.
- Secret, HTML-like, control/bidi, or overlength input yields 0 AI href and 0 clipboard action. Page/form/mail/domain/provider/DNS state is never interpolated.
- The three controls are keyboard reachable, permanently text-labeled, at least 44px, and have a visible copy fallback with `aria-live` feedback. Their bundled Remix Icon marks use an equal size and do not replace the labels. External links use `noopener noreferrer` and `referrerpolicy=no-referrer`.
- ChatGPT/Gemini limitations and external-provider data handling are disclosed; no button claims setup automation or official support.
- While the public repository URL is absent or release status is HOLD, active Cloudflare Deploy links are 0. The banner states `deploy != mail ready` and lists the remaining setup classes.
- Unit, Japanese-copy, accessibility, distribution-contract, clean-template, build, archive, and diff checks pass with 0 external network call from tests.

Evidence:

- `src/lib/components/AiSupportDock.svelte` and `src/lib/ai-support.ts` implement the visible prompt, copy fallback, and fixed three-provider handoff.
- The handoff prompt supplies a bounded list of official sources and no more than two stable, high-frequency pitfalls per stage. It requires fresh source verification, verification date, and the URLs actually used; detailed Knowledge Pack operations are not embedded.
- `README.md` contains an intentionally inactive Cloudflare Deploy banner and the post-deploy mail-readiness boundary.
- `bun test src/lib/ai-support.test.ts src/lib/ai-support-a11y.test.ts scripts/deploy-banner.test.mjs`, `bun run check`, and `bun run check:clean` pass without provider calls.

#### QMJ-8A — Setup capability registry and threat model

Priority: Required
Depends on: QMJ-6A, QMJ-6B, and QMJ-7
Status: Not started

- Define a capability registry for every setup action: provider, read/write/destructive/send/billing class, required scope, data handled, cost class, confirmation class, and rollback.
- Treat same-name D1/R2/Worker resources as collisions unless a matching ownership manifest is explicitly adopted.
- Threat-model browser guidance, provider adapters, secret entry, account/team/zone selection, DNS changes, external sends, rollback, and crash/resume before provider writes are implemented.

Binary DoD:

- Every future setup action exists in one capability registry and the setup plugin exposes zero mailbox read/send/admin tools.
- Independent security and skeptic reviewers have no unresolved P0/P1 finding.

#### QMJ-8B — Six upstream feature reconciliation

Priority: Required for production UI release; parallel to setup hardening
Depends on: QMJ-7
Status: Not started

- Independently review the six commits currently on `upstream/main` but not local `main`, including manual forwarding, domain-scoped conversations, account roles, mobile sign-out, and compose changes.
- Preserve QuickMail-ja forwarding, folder/rule, Outlook import, Japanese UI, and privacy contracts while reconciling relevant fixes.
- Do not make QMJ-8B a prerequisite for the isolated setup engine or sandbox setup pilot unless an upstream change directly affects login, inbox, compose, or the tested mail flow.

Binary DoD:

- Each of the six upstream commits has a keep/adapt/reject decision and regression evidence.
- All upstream-reconciled tests pass and the existing 254-test baseline has no deleted test without a recorded replacement.
- Independent regression and product reviewers have no unresolved P0/P1 finding.

#### QMJ-9 — Runtime and setup hardening before provider writes

Priority: Required
Depends on: QMJ-8A
Status: Completed locally on 2026-08-29

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

Evidence:

- Integrated setup hardening `25da541` as `0dadf4d`, runtime request hardening through `cf546f1`, release supply-chain evidence `a2f7b8d` as `42c64eb`, distribution contract `de09c65`, and final review corrections `6f8f0dc`.
- `bun test`: 404 passed, 0 failed. `bun run test:d1-forwarding`: passed.
- `bun run check`: 0 errors, 0 warnings. `bun run format:check`, `bun run check:clean`, `bun run build`, and `git diff --check`: passed.
- Bun 1.3.14 is enforced before normal and local-dev setup; install remains frozen. Runtime secrets use native Worker secret prompts or the bounded local child-process path and are absent from `.dev.vars`.
- Resend send-domain metadata starts empty and is written only after exact verified-domain selection and domain-scoped sending-key attestation. Cloudflare inbound metadata alone cannot mark a domain sendable.
- Local development can discover the configured Cloudflare inbound domain and create the first administrator without a Resend credential or provider call; compose/send remains fail-closed until Resend is configured. Production provider behavior is unchanged.
- The clean-clone local path requires an explicit, syntax-validated `--domain` outside a TTY, strips inherited Resend credentials at both environment boundaries, and labels both wizard steps receive-only. Unexpected setup errors return a fixed message without leaking internal details.
- Existing deployments use an explicit pre-deploy upgrade gate: one named send domain, an existing runtime Resend key, an operator attestation that the key is restricted to that domain, and an opaque `AUTH_RATE_LIMIT_SECRET` readback are all required. Multiple inbound domains remain supported; multiple outbound keys/domains are deferred beyond QMJ-9. Missing evidence stops before deployment.
- Setup reruns remove only the four legacy wizard secret assignments from `.dev.vars` before writing non-secret settings. A failed first-admin attempt can reuse one normalized exact partial domain row while preserving its id; existing users, extra domains, and cross-domain collisions stop fail-closed.
- New attachment bytes use multipart only: repository UI callers are migrated, CLI/MCP expose no upload caller, JSON base64 attachment content is rejected before storage/provider, and manual-forward attachment IDs remain valid JSON. Multipart retains five files, five MiB each, and 25 MiB total. Attachment-free JSON and multilingual bodies use a finite UTF-8-derived limit. Every bounded JSON/mail endpoint maps malformed, missing-length, and oversized bodies to HTTP 400/411/413 at its own narrow request-body boundary.
- Resend sends fail before a provider call unless the normalized From domain is allowlisted. The allowlist reaches webhook, Cloudflare Email Routing, and scheduled forwarding paths; rerunning setup clears stale local send authorization before a new attestation.
- Legacy Resend UUID domain rows reconcile and refresh by normalized domain name while retaining the stored ID and its foreign-key identity.
- Independent security and product re-reviews returned APPROVE with no unresolved P0/P1. No provider, network, deploy, DNS, billing, or external-send call was made.

#### QMJ-10 — Provider-neutral inspect/plan/apply engine

Priority: Required
Depends on: QMJ-9
Status: Implemented locally — the provider-neutral contract engine and Fake* regression seams are in place; real provider adapters, CLI automation, and QMJ-11B remain deferred

- Split setup into `inspect -> plan -> apply(step) -> readback -> verify`.
- Emit a canonical mutation plan with immutable account/team/zone/domain/resource IDs, exact before/after diff, cost class, rollback, plan hash, expiry, and one-use approval ID.
- Use official Cloudflare and Resend MCP/API capabilities behind a narrow allowlisted setup adapter; never expose either full provider toolset. Keep adapters behind FakeCloudflare, FakeResend, FakeBrowser, and FakeDNS seams.
- Stage resource creation, secret upload, remote migration, deploy, webhook, Email Routing, DNS/catch-all, external send, and cleanup as separate steps.
- Export authoritative DNS and routing rules before any cutover. Never add Resend Receiving or Resend apex inbound MX.

Local implementation boundary:

- `scripts/setup-engine.mjs` provides the read-only inspect, canonical one-step
  plan, approval, guarded apply, readback, verify, rollback, and atomic local
  state contract exercised by FakeCloudflare, FakeResend, FakeBrowser, and
  FakeDNS.
- Real Cloudflare/Resend/DNS/browser provider adapters, CLI automation, remote
  migration/deploy/webhook/send, and the QMJ-11B provider concurrency contract
  (recreated DNS IDs and provider etag/If-Match TOCTOU) are not implemented or
  exercised in QMJ-10.

Binary DoD:

- Dry-run and every automated test make 0 real Cloudflare, Resend, DNS, SMTP, or external-send calls.
- Target ID, current-state fingerprint, plan hash, expiry, or approval mismatch yields 0 writes.
- Existing M365/Gmail MX fixtures produce an exact snapshot, diff, and idempotent rollback without removing concurrent/unowned records.
- Provider-list failure is an error, not an empty list; duplicate webhook/resource creation is prevented.
- Rollback can be run twice and never automatically deletes D1, non-empty R2, a zone, or a Resend domain.

#### QMJ-11A — Portable guidance Skill and repo adapters

Priority: Required
Depends on: QMJ-6A
Status: Implemented locally — portable BYOK guidance Skill, committed-tree package, and repo-scoped Codex and Claude Code adapters pass local checks; browser-client upload/discovery smoke remains unverified

- Keep this increment guidance-only: explain BYOK, open allowlisted official setup screens when the host and user permit it, and hand login, MFA, terms, secrets, saves, DNS changes, deploys, and sends back to the user. Do not represent it as QMJ-10 provider automation.
- Reuse the QMJ-6A Knowledge Pack as the Skill's reviewed setup reference instead of duplicating competitor instructions.
- Maintain one canonical Skill and only thin repo adapters for documented Codex and Claude Code discovery surfaces. ChatGPT and Claude Desktop/Web require their supported upload flow; clone alone is not installation.
- Capability-adapt browser assistance: official allowlisted origins only; page text, email, DNS, provider errors, downloads, QR codes, and unexpected tabs/iframes are untrusted.
- Stop for human takeover on login credentials, MFA, CAPTCHA, terms, payment, account switch, unexpected origin, or DOM/API mismatch.

Binary DoD:

- Agent Skills validation, committed-tree ZIP packaging, archive cleanliness, path traversal, symlink, and secret canaries pass.
- Documentation claims only surfaces with a recorded install/discovery or upload smoke. Unverified clients remain labeled as such.
- Browser-less execution reaches the same manual checklist without losing state.
- The Skill creates, changes, deploys, deletes, and sends nothing; provider mutations remain QMJ-10/QMJ-11B work.

#### QMJ-11B — Agent Plugin and provider-enabled host adapters

Priority: Required for automated setup claims
Depends on: QMJ-8A, QMJ-10, and QMJ-11A
Status: Local portable and Codex native packages implemented — operations and canonical BYOK guidance Skills are bundled; provider adapters and ChatGPT desktop UI discovery remain unverified

- Add the portable root `plugin.json`, the operations and canonical BYOK guidance Skills, and optional `mcp.json` from the QMJ-8A capability registry.
- Keep the setup plugin separate from the mailbox MCP.
- Add provider-enabled Codex/ChatGPT and independently generated Claude adapters only for officially supported surfaces.

Local implementation boundary:

- Root `plugin.json`, narrow stdio `mcp.json`, QMJ-10 operations Skill, canonical BYOK guidance Skill with reviewed references, generated capability projection, Claude native Skill adapter, Codex native `.agents/plugins/marketplace.json`, and Codex native `.codex-plugin/plugin.json` adapter are implemented and checked.
- Codex native adapter files are generated from the canonical portable Skill and setup runtime; `.agents/plugins` is intentionally outside the Agent Plugin ZIP allowlist.
- The MCP exposes only `setup_inspect`, `setup_plan`, `setup_approve`, `setup_apply`, `setup_readback`, and `setup_verify`. `setup_apply` is fail-closed because no provider adapter is enabled.
- The separate interactive `scripts/setup.mjs` CLI is outside the QMJ-10 provider-neutral contract, excluded from the Agent Plugin allowlist, and never invoked by the Setup MCP.
- Codex CLI clean-profile marketplace add, available discovery, install, enabled state, cached BYOK setup Skill, and MCP initialize are exercised without login or external calls. ChatGPT desktop local marketplace UI discovery is not exercised.
- Cloudflare/Resend provider adapters, mailbox MCP access, provider email read/send, account login, secrets, DNS, migrations, deployment, and external provider activity are not implemented or exercised here.

Binary DoD:

- Agent Plugins 1.0 schema validation passes.
- Unsupported transport, unknown capability, capability drift, and provider-write fixtures fail closed.
- Installing the setup plugin grants 0 mailbox/provider-email read, email send, or QuickMail admin capability, and exposes 0 provider tool outside the capability registry.
- Codex native discovery is reproducible from a temporary profile with `codex plugin marketplace add`, `codex plugin list --json --available`, `codex plugin add`, `codex plugin list`, and installed-cache MCP stdio initialize; the existing global config remains unchanged.

#### QMJ-12 — Isolated UI comparison lab

Priority: Required
Depends on: QMJ-7; may run in parallel with QMJ-8A, QMJ-8B, and QMJ-9 through QMJ-11B
Status: Planned refinement — current interactive prototype is the baseline; token, structure, public-label, and evaluation gates below remain

Spec delta:

- Replace vendor imitation language with three QuickMail-ja-owned patterns informed by Material 3, Fluent 2, and Thunderbird/Bolt primary sources.
- Separate one shared visual theme from statically registered layout profiles. The user-provided hex values are not adopted as official or local pattern palettes.
- Make future comparison patterns additive through a minimal `UIProfile` registry, delta document, renderer, and tests; reject a general plugin/theme SDK until a concrete second consumer requires it.
- Limit pre-selection parity to comparable inbox, selected-message, and compose states. Move the exhaustive state matrix to the selected production pattern in QMJ-14.
- Use the explicit comparison labels `Gmail風`, `Outlook風`, and `Thunderbird風`; retain the unofficial and unaffiliated notice and do not add vendor logos, fonts, screenshots, exact palettes, or pixel copying.

Planning classification:

| Class       | Decision                                                                                                                                                                | Why                                                                                                                        | User-visible effect                                                   | Gate                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| Required    | Shared visual theme plus statically registered UI profiles                                                                                                              | Keeps common styling centralized while allowing structural layouts to be added without cloning the app                     | New comparison patterns have a defined, bounded extension point       | QMJ-12A–12B              |
| Required    | Structure/geometry, keyboard, axe, contrast, responsive, and network contracts                                                                                          | A CSS marker or screenshot alone cannot prove a usable mail client                                                         | Each profile is measurably distinct and operable                      | QMJ-12B–12C              |
| Recommended | Keep the existing static HTML/CSS/JS comparison prototype and defer Svelte production integration to QMJ-14; add only pinned QA tooling                                 | A second demo implementation would create drift; Material Web is in maintenance mode and Bolt tokens are not release-ready | One comparison implementation and no extra runtime UI framework       | Dependency review        |
| Optional    | View official Figma kits as human reference only                                                                                                                        | They can speed visual study without introducing asset provenance risk                                                      | No kit asset is shipped                                               | Manual reference         |
| Reject      | Dynamic theme plugins, third-party profile loading, three production runtime themes, vendor palettes/fonts/logos/screenshots, pixel clones, or checked-in Figma exports | They solve no current user need and add maintenance, security, and trademark risk                                          | Public UI remains QuickMail-ja and the extension contract stays small | Static and visual review |

- Capture the existing light/dark baseline at 1440x900, 1024x768, and 390x844 before visual changes.
- Build the `calm`, `command`, and `classic` concepts from one synthetic Japanese fixture and one interaction contract. A publicly reachable preview labels them `Gmail風`, `Outlook風`, and `Thunderbird風` while stating that the comparison is unofficial and unaffiliated.
- Keep prototypes development-only and out of production routes and bundle.
- Keep one semantic token contract, but give each profile its own light/dark palette, typography fallback, radius, and density so the three references are visually distinguishable. Do not use vendor logos, proprietary fonts, screenshots, or copied assets.
- Use official Fluent 2, Material 3, and Thunderbird/Bolt sources as design references only. Keep a shared QuickMail-ja theme source plus statically registered profile deltas; add no runtime vendor design-system dependency.

Completed prototype scope (2026-08-27):

- The isolated synthetic demo implements structurally distinct Gmail-style single-list, Outlook-style three-pane, and Thunderbird-style folder-tree/table layouts.
- Automated checks cover the initial shell, all three desktop structures, 390x844 overflow and 44px targets, light/dark switching, dialog focus containment/restoration, and AI handoff refusal cases.

Current verification state (2026-08-27): automated QA and the non-human AI rubric evaluation pass, but neither authorizes release. QMJ-12C remains in progress until an actual human reviews all 18 screens and real Safari + VoiceOver evidence is approved.

Remaining before QMJ-12 completion:

| Task    | 内容                                                                                                                                                                                                                                                           | DoD                                                                                                                                                                                                                                                                    | Depends | Status         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| QMJ-12A | `[lane:fast] [stage:foundation] [tdd:skip:docs-only]` Add `sources.md`, shared `base.DESIGN.md`, and `calm/command/classic.DESIGN.md`; define the minimal static `UIProfile` contract and explicit non-goals.                                                  | Source roles and local values are separated; runtime registry fields are limited to ID, label, renderer, and optional evaluator description; profile files contain layout deltas; dynamic plugins, remote themes, and production multi-profile switching are excluded. | QMJ-7   | cc:COMPLETED   |
| QMJ-12B | `[lane:gate] [stage:tdd-implementation] [tdd:required]` Improve the existing static demo through one minimal `UIProfile` registry and three renderers; keep metrics/breakpoints in DESIGN.md, CSS/renderers, and RED contract tests rather than registry data. | Generic IDs/labels, profile isolation, all three fixed viewport structures, state preservation, row metrics, `noindex`, notice, same-origin passive network, and 0 new runtime design-system dependencies pass.                                                        | QMJ-12A | cc:COMPLETED   |
| QMJ-12C | `[lane:gate] [stage:verification] [tdd:required]` Add bounded accessibility, responsive, contrast, deterministic snapshot, and browser-functional coverage without duplicating the UI implementation.                                                          | The 48-run axe contract, WCAG ratios, VoiceOver smoke, 18 default snapshots, keyboard/focus flow, overflow, reduced motion, and Chromium/Firefox/WebKit functional checks meet the Binary DoD.                                                                         | QMJ-12B | cc:IN_PROGRESS |
| QMJ-12D | `[lane:gate] [stage:review] [tdd:skip:independent-review]` Run integrated scope, UI, security, accessibility, regression, and skeptic reviews; fix and re-review up to three iterations.                                                                       | Independent reviewers return APPROVE with no unresolved P0/P1; full local checks pass; Plans/spec alignment is read back; no deploy occurs.                                                                                                                            | QMJ-12C | cc:COMPLETED   |

Binary DoD:

- All three patterns render the same inbox, selected-message, and compose fixtures at 1440px, 1024px, and 390px in light and dark mode; 18 deterministic default-state snapshots are reviewed.
- Chromium on the pinned CI OS/browser/DPR/locale/timezone/fixture clock is the QMJ-12 pixel baseline with animation and caret disabled; Firefox/WebKit run functional, overflow, and axe smoke.
- Structural tests assert each pattern's pane count, pane width, row-height range, and search/compose/command/filter placement rather than checking only a CSS marker.
- Horizontal overflow is 0; mobile touch targets are at least 44px; keyboard flow reaches search, compose, navigation, message selection, body, and reply and restores focus after dialog or pattern changes.
- axe serious/critical and WCAG A/AA moderate violations are 0 for the specified 48 runs unless a dated waiver names the owner, reason, and expiry.
- Normal text contrast is at least 4.5:1; large text, component boundaries, and focus indicators are at least 3:1. Light/dark default, hover, focus, selected, unread, and disabled states are recorded.
- One VoiceOver/Safari smoke per pattern verifies search, folder navigation, unread/selected announcement, message body, reply/back, compose validation, and error/offline live regions; automated accessible-name/state tests complement but do not replace it.
- Public preview has both `<meta name="robots" content="noindex,nofollow">` and a Pages `_headers` `X-Robots-Tag` rule, a persistent unofficial/no-real-mail notice, explicit `Gmail風` / `Outlook風` / `Thunderbird風` comparison labels, and 0 external font requests. Page load and passive operation are same-origin only; fixed ChatGPT, Claude, and Gemini navigation is permitted only after the existing explicit user gesture and safety validation. Deployed HTML and headers are read back before the preview is called compliant.
- Mail-client vendor logos, proprietary fonts, screenshots, trademark images, exact vendor palettes, checked-in Figma exports, new runtime design-system dependencies, and production imports of prototype code are 0. Product names may appear only as text labels ending in `風` to identify an unofficial comparison reference. The only vendor-mark exception is the three equal-size bundled Remix Icon marks used beside the permanent ChatGPT, Claude, and Gemini consultation text labels; it does not extend to layout branding.

#### QMJ-13 — UI evaluation and one-system decision

Priority: Required
Depends on: QMJ-12
Status: Not started

- Run the same seven tasks: initial comprehension, inbox scan, search, folder move, message inspection, reply start, and compose-to-draft.
- Record time, confusion, and misoperation with three to five Japanese small-organization operators; fewer than three may be recorded as discovery but cannot select a pattern.
- Before outreach, define each task's success, confusion/misoperation counting, rating scale, weights, tie-breaker, and product-owner decision rule. Counterbalance the presentation order and record only anonymous usage categories. Score task completion, time, confusion, misoperation, reuse intent, information density, mobile behavior, keyboard/accessibility, and maintenance cost; do not treat a five-person mean as statistical proof.
- Record the selected pattern and rejection reasons in an ADR.

Binary DoD:

- All participants run the same fixture and seven tasks.
- Three to five participants complete the study; discovery with fewer than three does not open the selection gate.
- One pattern has a recorded accept decision and two have explicit rejection reasons.
- Production integration references one design system only; runtime vendor-style switching remains absent.

#### QMJ-14 — Selected UI integration and local cross-cutting QA

Priority: Required
Depends on: QMJ-6A, QMJ-6B, QMJ-8B, QMJ-11A, and QMJ-13
Status: Not started

- Integrate only the selected layout into existing components and preserve Japanese routes, folders, forwarding, compose, mobile, and light/dark/system behavior.
- Add Playwright/axe visual and functional smoke with temporary local D1 and fake providers.
- Ensure inbox/API failures are visible and preserve user selection where recovery is possible.
- Extend clean-template, archive, and CI checks to plugin/adapters/design assets.
- Complete loading, empty, error, success, offline, long-Japanese, attachment, HTML, reduced-motion, dark, mobile, keyboard, screen-reader, and contrast states for the selected pattern at 1440x900, 1024x768, and 390x844.

Binary DoD:

- The full pre-implementation test manifest remains represented; full suite, D1 race, type, format, clean-template, build, archive, and diff checks pass.
- Eighteen selected-pattern snapshots pass: 3 states × 3 widths × 2 themes. Chromium on the pinned CI OS/browser/DPR/locale/timezone/fixture clock is the pixel baseline with animation and caret disabled; Firefox/WebKit run functional, overflow, and axe smoke with external network denied.
- Production bundle contains 0 unselected design-system dependency, 0 design-lab route, and 0 external Google Fonts request.
- Independent product, accessibility, QA, skeptic, and security reviewers return APPROVE with no unresolved P0/P1.

#### QMJ-15 — Boundary-controlled HOTL sandbox pilot

Priority: Recommended and externally gated
Depends on: QMJ-9, QMJ-10, and QMJ-11B; before real provider mail-flow, pass a focused local login/inbox/compose smoke against the existing UI (QMJ-14 is not a prerequisite)
Status: Partially completed — Codex real-provider pilot completed; cross-host discovery remains externally gated

- On 2026-08-31, one isolated test domain completed the Codex browser-assisted real-provider path through send, reply receipt, idempotency readback, and rollback. Mail evidence correlated one non-secret canary across Cloudflare Email Routing Activity, Worker/D1, Resend, and QuickMail-ja UI. DNS evidence separately matched the domain and configuration across authoritative and public resolvers. Customer domains, account IDs, resource IDs, and secrets are intentionally absent from this repository.
- This pilot proves the Codex-assisted provider path used in that session. It does not prove clean-profile Skill discovery or restart/resume from a clean clone.
- Clean-profile Codex Skill discovery and restart/resume remain unconfirmed. ChatGPT Desktop, Claude Desktop, and Claude Code also remain independently unconfirmed on their officially supported Skill/plugin/browser surfaces. Until dated evidence exists, show the documented manual fallback and do not claim automatic discovery from a cloned folder.

- Use one fresh Cloudflare test account, one fresh Resend test team, one dedicated non-production DNS zone, isolated client profiles, and tester-controlled sender/recipient addresses. Do not use an existing production zone or a subdomain that requires writes to one.
- Treat local checks, FakeProvider, read-only inspection, readback, verification, evidence capture, waits, and crash/resume as HOTL-safe inside the fixed sandbox envelope. Keep signup, login, CAPTCHA, MFA, terms, payment, upgrades, account switching, and secret entry human-only.
- Keep resource creation, secret staging, remote migration, deploy, webhook, Email Routing/catch-all, each exact same-purpose DNS change-set, every external send, rollback, and cleanup as separate exact one-use approval steps; an apex MX cutover is always its own step. Do not add a blanket sandbox `--yes` mode.
- Run the pilot in seven bounded stages: identity/cost/isolation preflight; FakeProvider rehearsal; four-client install/discovery smoke; sandbox create/migrate/deploy; human-entered setup key, first-admin creation, login, and setup-key invalidation; one controlled inbound, one controlled outbound, and one reply receipt; rollback/readback and independent review.
- Verify Codex on a documented repo-scoped surface and Claude Code from a clean clone. Verify ChatGPT and Claude Desktop only through their officially supported Skill/plugin upload or a named adapter specified and independently approved in QMJ-11B; otherwise label the automation unsupported. Do not claim that those clients discover a cloned folder automatically. Record a browserless manual fallback for every unsupported capability.
- Default to free-tier limits and at most one Worker, D1, R2, Email Routing rule or catch-all, Resend domain, and webhook. Stop before any paid action or extra resource. Use non-sensitive unique canary tokens and never automatically retry an uncertain send result.
- In FakeProvider/local tests only, inject provider read/list failure, ambiguous account/zone, same-name collision, stale fingerprint or plan hash, expired/reused approval, provider 429/5xx, partial deployment, duplicate/out-of-order webhook, idempotency replay, browser origin/DOM drift, and crash-before-readback. Each case must yield zero unowned write or duplicate send. Do not deliberately inject faults into the real sandbox; a naturally observed failure stops at readback and resumes only from verified state.

Binary DoD:

- Every claimed surface has dated clean-profile install/discovery and restart/resume evidence, or is labeled unsupported with a tested manual fallback.
- FakeCloudflare, FakeResend, FakeDNS, and FakeBrowser complete `inspect -> plan -> reject/approve one step -> apply -> readback -> verify -> resume -> rollback` with 0 real network, provider, DNS, or send calls; every negative fixture fails closed.
- Isolation readback proves that no production account, zone, MX, mailbox, existing deployment, provider credential, customer identifier, or customer data entered the run. Secret canaries occur 0 times in model I/O, MCP environment, files, `.dev.vars`, logs, screenshots, D1/R2, or distributable artifacts.
- A human enters the setup key without exposing it to the assistant, creates the first administrator, logs in, and proves that the setup key is invalidated and cannot be reused.
- The approved sandbox receives one controlled inbound message, sends one controlled outbound message from the authenticated QuickMail UI through Resend, and receives one reply. Cloudflare activity, QuickMail storage/UI, Resend delivery/Webhook status, and SPF/DKIM/DMARC evidence agree; replaying the same idempotency key produces no second delivery.
- Usage remains inside the declared free/approved resource and message ceilings. Any charge-required path stops before purchase.
- Rollback restores the exact prior DNS/routing state, succeeds a second time as a no-op, and leaves no unowned mutation. Cleanup and credential revocation have separate evidence.
- Independent host-compatibility, QA/skeptic, security/abuse, and release reviewers return APPROVE with no unresolved P0/P1. Local green alone is not sandbox-pilot completion.

#### QMJ-16 — Public release gate

Priority: Release Gate
Depends on: QMJ-14; QMJ-15 for browser/setup claims
Status: HOLD

- Re-run market claims, trademark/name review, upstream divergence, archive/privacy scan, dependency audit, SBOM, signatures/provenance, rollback, cost, and documentation truthfulness.
- Keep repository creation/push, plugin publication, provider login, deploy, DNS, remote migration, webhook, and external send as distinct user approvals.

Binary DoD:

- Public artifact checksum/signature/provenance verifies and contains no secret, customer value, browser profile, local path, state folder, backup, or unselected design prototype.
- Every public capability claim has recorded evidence; unsupported host behavior is labeled.
- The publish job is gated by a human-controlled GitHub protected environment or equivalent identity-attested reviewer approval bound to the exact release revision; a free-text receipt `reviewer` field alone is insufficient.
- The user explicitly approves each external release action immediately before it occurs.

### Review loops

- After QMJ-8A: setup architecture + security + skeptic review; fix all P0/P1 before QMJ-9.
- After QMJ-8B: upstream reconciliation + regression review; fix all P0/P1 before QMJ-14 or public release.
- After QMJ-11A: package/install boundary review. After QMJ-11B: Agent Plugins schema/host-compatibility + security/abuse review; fix all P0/P1 before any real provider pilot.
- After QMJ-13: product + Japanese UX + accessibility review; record one UI decision before production integration.
- After QMJ-14: independent integrated review across spec, security, accessibility, QA, and archive/privacy boundaries.
- After QMJ-15: release review based on sandbox evidence. Passing local tests never implies public release or production completion.
