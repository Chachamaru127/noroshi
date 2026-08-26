# QuickMail-ja Repository Separation Plan

Status: In progress
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

Status: In progress

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
Status: Pending

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
Status: Pending

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
Status: Pending

- Run dependency install, unit tests, D1 integration/race tests, type checks, formatter checks, template-clean checks, build, and diff checks.
- Scan the tracked tree, new commit history, and distributable output for customer-specific strings, UUIDs, real routes, state folders, and backups.
- Verify the production downstream tracked tree is unchanged.
- Obtain independent security/privacy and product/QA reviews.

Acceptance:

- All automated gates pass or any baseline-only warning is documented.
- Independent reviewers return APPROVE with no unresolved P0/P1 finding.

### QMJ-5 — Local handoff

Depends on: QMJ-4
Status: Pending

- Create clean local commits only.
- Report both repository paths, commit IDs, validation evidence, and the remaining external publication gate.
- Turn Harness work mode off.

Acceptance:

- The generic product and production downstream are independent repositories.
- No push or deployment has occurred.

## Spec delta

Before: the production downstream combines generic application code with production configuration, operational history, and customer-specific UI copy.

After: the existing deployment remains the production downstream. QuickMail-ja contains only generic Japanese-first product code and public-safe history. Production configuration and customer operational records remain downstream-only.

## Review findings incorporated

- Product: a separate repository is justified by Japanese setup/operations plus forwarding, folders, rules, and migration—not translation alone.
- Architecture: use upstream ancestry plus one scrubbed feature commit; never copy the downstream `.git` directory.
- Security: exclude backups, `.wrangler`, output, Harness state, real identifiers, and all customer-specific history.
- QA: align setup/docs on Cloudflare inbound + Resend outbound; strengthen clean-template and CI gates.
- Skeptic: keep publication blocked until the full tracked tree and reachable QuickMail-ja history are customer-neutral.
