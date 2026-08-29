# QMJ-10 provider-neutral setup engine

## Purpose

This slice provides the local, provider-neutral control plane for setup
changes. It does not call Cloudflare, Resend, DNS, SMTP, a browser, or an
external mail recipient. Real adapters remain a later host integration gate.

The supported flow is deliberately narrow:

```text
inspect -> plan -> approve one exact step -> apply -> readback -> verify
```

`apply` accepts one canonical plan only. Resource creation, secret staging,
remote migration, deployment, webhook creation, Email Routing, DNS/catch-all,
external send, and destructive cleanup are separate step kinds and therefore
separate approval classes.

## Canonical plan

`scripts/setup-engine.mjs` emits a JSON-safe plan containing:

- immutable Cloudflare account / zone / resource IDs or Resend team / domain /
  resource IDs where the operation has them;
- an exact structured `before` and `after` state plus a path-level diff;
- current-state and desired-state fingerprints;
- capability ID, adapter kind, one step kind, cost class, and rollback contract;
- an expiry timestamp, one-use approval ID, and a SHA-256 plan hash.
- a separate rollback approval ID; rollback writes cannot reuse the apply
  approval.

Secret values, API keys, passwords, cookies, mail bodies, attachments, and
authorization headers are rejected from plan/evidence state. The key policy
normalizes camelCase and rejects the fixed secret/body/attachment names and
suffixes; it does not scan arbitrary values. An opaque
`secret_broker_reference` is the only secret-related key allowed, and it must
contain a non-empty broker reference rather than a secret value.

The step capability/operation pair is selected from the static
`SETUP_STEP_CAPABILITY_CONTRACT` in `scripts/setup-engine.mjs`. A pair that is
not listed for the step kind, or whose provider differs from the target, is
rejected before any adapter call.

## Adapter boundary

An adapter implements only:

```js
{
  inspect({ target, step }) -> Promise<{ state, ...safe metadata }>,
  applyStep({ plan }) -> Promise<{ resource_id?, provider_id?, status? }>,
  rollbackStep({ plan }) -> Promise<{ status? }>
}
```

Provider list/read failures must reject or return an explicit failure. They
must never be converted to an empty collection. The production engine has no
Cloudflare, Resend, browser, or DNS client; tests inject fakes through this
boundary.

Approval and apply progress use `AtomicApprovalLedger` with
`createAtomicSetupStateStore`. The local state record contains only one plan's
identity, one approval ID, and `approved`, `consumed`, `apply_started`, and
`readback_verified` flags. The transition to `consumed + apply_started` is
atomically renamed before the provider write. If the process stops after that
write but before readback, a restart may inspect/readback and mark verification;
it must not invoke the provider step again. A state record bound to another
plan, hash, or approval fails closed.

## Rollback safety

Rollback is idempotent. If the current state already equals `before`, it is a
no-op. If the state differs from both the approved `before` and `after`, it
stops with zero writes. A rollback write requires a separately approved,
one-use rollback approval. DNS rollback requires an authoritative snapshot and
an explicit owned-record list; an adapter must preserve concurrent/unowned
records. Zones, D1 databases, non-empty R2 buckets, and Resend domains are
manual-review-only and are never automatically deleted.

## File ownership

- `scripts/setup-engine.mjs`: canonical engine, plan/hash/approval/rollback
  contracts, topology guards, and atomic local state helper.
- `scripts/setup-engine.test.mjs`: FakeCloudflare, FakeResend, FakeBrowser,
  FakeDNS and all local contract/regression tests. No real network or provider
  calls.
- `package.json` test command: includes the engine contract suite.
- `.gitignore`: ignores only the local resumable state directory.

QMJ-11B may later add narrow official-provider adapters. It must not expand
this engine into a generic workflow, RBAC layer, full MCP wrapper, browser
automation framework, or autonomous signup/deploy/send path.
