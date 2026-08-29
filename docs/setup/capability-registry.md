# Setup capability registry

`setup/capabilities.json` is the single allowlist for future Cloudflare and Resend setup automation. QMJ-8 defines the contract only. It does not add a provider adapter, write path, browser automation, or mailbox permission.

## Boundary

- The registry contains only Cloudflare and Resend setup actions required by the product contract.
- `classes` describes whether an action reads, writes, destroys, sends, or changes billing.
- `required_scopes` uses provider-native grant names. Cloudflare entries use permission-group names; Resend entries use `full_access` or `sending_access` because Resend does not expose per-domain-management scopes. It is not a provider token or a grant.
- `scope_constraints` is an immutable exact-match list for every write. It binds identifiers plus all operation payload inputs, including resource names, migration IDs, secret broker destinations, deployment artifacts/bindings, DNS/routing payloads, webhook configuration, canary values, and cleanup ownership fingerprints.
- `adapter_operations` is the endpoint-level allowlist. D1/R2 read grants can reach stored content, so those credentials are temporary broker inputs and the adapter permits metadata-list operations only. It cannot query D1 rows or fetch R2 objects.
- `data_handled` names metadata that may cross the adapter boundary. Mailbox content, provider email content, attachment content, and QuickMail-ja user administration are prohibited.
- `confirmation_class` keeps resource creation, secret staging, remote migration, deployment, webhook creation, Email Routing, DNS changes, external sending, destructive cleanup, and billing separate.
- `rollback` states the recovery boundary. It does not authorize rollback or cleanup.
- `execution: human_only` means the setup assistant may explain the official screen but receives no provider tool for that action.
- Every Cloudflare write uses a temporary broker-only credential. Creating or OAuth-authorizing it and entering it into the native broker require a secret-staging approval. Revoking it after setup or abort is a separate destructive-cleanup approval bound to the exact account and token IDs. Worker secret names, Worker IDs, domains, DNS record IDs, routing rule IDs, the approved prior-state fingerprint, and the complete desired-state fingerprint are immutable plan inputs; missing or changed values stop execution. The desired-state fingerprint covers the Worker artifact and binding diff, migration bundle content, DNS record payload, routing state, and catch-all matcher/action/priority so the write payload cannot change after approval.

Resend domain, verification, webhook, and API-key setup requires a temporary `full_access` credential. The user creates it in the official Resend screen and enters it into the native secret broker; it remains outside model context and runtime configuration. Domain verification requires a fresh state fingerprint and runs only from explicitly eligible pre-verification states. `verified` and `pending` are readback-only no-ops because re-verification can temporarily move a live domain back to `pending`. Webhook URL and event types are immutable approved inputs. Its signing secret goes directly to the native secret broker and may not enter model context, logs, the filesystem, or a plaintext response. The separately created domain-restricted `sending_access` key follows the same secret-output boundary. A controlled test binds the sender, recipient, token, and idempotency key to the approved plan. Revoking the temporary setup credential is a separately confirmed human action.

Account creation, login, team/account selection, MFA, CAPTCHA, terms, billing, plan changes, and domain purchase/transfer are listed under `human_handoffs`. Each has the same explicit class, scope constraint, metadata, cost, confirmation, and rollback contract as an adapter action, but `execution` is `human_only` and its adapter operation list is empty.

For a new Cloudflare account, the registry may inspect existing zones and create the requested zone after resource-creation approval. Registrar nameserver delegation and waiting for the zone to become active remain an explicit human handoff. The setup assistant never deletes a Cloudflare zone automatically.

The current guidance-only Setup Skill exposes an empty capability list. Defining a future action in the registry does not expose or authorize it.

## Same-name resource collisions

A Cloudflare zone, DNS record, Email Routing state or rule, catch-all rule, D1 database, R2 bucket, Worker, Resend domain, webhook, or API key label with the requested name is a collision. Each create path has a corresponding metadata-inspection path. Each cleanup or revocation is resource-specific; there is no broad cleanup capability. A name match is never evidence of ownership.

Future inspection must stop when provider listing fails. Adoption requires an explicit user confirmation and an ownership manifest whose common fields all match: provider, project, resource type, resource ID, resource name, schema version, and fingerprint. The provider identity must also match: `account_id` for Cloudflare or `team_id` for Resend. A missing resource ID, ownership mismatch, or changed before-state fingerprint stops adoption and mutation. QMJ-10 will define the signed plan and one-use approval flow; QMJ-8 does not implement it.

## QMJ-8 workstream boundary

The plan defines `QMJ-8A` as the setup threat-model and registry gate, and `QMJ-8B` as the six upstream feature decisions. Completing QMJ-8A unblocks QMJ-9 setup hardening. QMJ-8B runs in parallel and blocks QMJ-14 and public release, but it does not block QMJ-9. The six commits are not pulled here.
