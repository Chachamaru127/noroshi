import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const registry = JSON.parse(
	readFileSync(new URL('../setup/capabilities.json', import.meta.url), 'utf8')
);
const upstreamLedger = readFileSync(
	new URL('../docs/research/upstream-reconciliation-2026-08-29.md', import.meta.url),
	'utf8'
);

const allowedProviders = new Set(['cloudflare', 'resend']);
const allowedClasses = new Set(['read', 'write', 'destructive', 'send', 'billing']);
const requiredConfirmationClasses = new Set([
	'resource_creation',
	'secret_staging',
	'remote_migration',
	'deployment',
	'webhook_creation',
	'email_routing',
	'dns_change',
	'domain_verification',
	'external_send',
	'destructive_cleanup',
	'billing'
]);

const requiredSetupActions = new Set([
	'cloudflare.inspect_accounts',
	'cloudflare.inspect_zones',
	'cloudflare.create_zone',
	'cloudflare.inspect_zone',
	'cloudflare.inspect_d1',
	'cloudflare.inspect_r2',
	'cloudflare.inspect_workers',
	'cloudflare.create_d1',
	'cloudflare.create_r2',
	'cloudflare.create_worker',
	'cloudflare.stage_worker_secret',
	'cloudflare.apply_remote_migration',
	'cloudflare.deploy_worker',
	'cloudflare.inspect_email_routing',
	'cloudflare.enable_email_routing',
	'cloudflare.change_dns',
	'cloudflare.configure_catch_all',
	'cloudflare.delete_d1',
	'cloudflare.delete_r2',
	'cloudflare.delete_worker',
	'resend.inspect_team',
	'resend.inspect_domain',
	'resend.inspect_webhooks',
	'resend.inspect_api_keys',
	'resend.create_domain',
	'resend.verify_domain',
	'resend.create_sending_key',
	'resend.create_webhook',
	'resend.send_controlled_test',
	'resend.delete_domain',
	'resend.delete_webhook',
	'resend.revoke_api_key',
	'resend.revoke_setup_credential'
]);

const dangerousContracts = {
	'cloudflare.create_zone': [['write'], 'resource_creation', 'provider_adapter'],
	'cloudflare.create_d1': [['write'], 'resource_creation', 'provider_adapter'],
	'cloudflare.create_r2': [['write'], 'resource_creation', 'provider_adapter'],
	'cloudflare.create_worker': [['write'], 'resource_creation', 'provider_adapter'],
	'cloudflare.stage_worker_secret': [['write'], 'secret_staging', 'native_secret_broker'],
	'cloudflare.apply_remote_migration': [['write'], 'remote_migration', 'provider_adapter'],
	'cloudflare.deploy_worker': [['write'], 'deployment', 'provider_adapter'],
	'cloudflare.enable_email_routing': [['write'], 'email_routing', 'provider_adapter'],
	'cloudflare.change_dns': [['write'], 'dns_change', 'provider_adapter'],
	'cloudflare.configure_catch_all': [['write'], 'email_routing', 'provider_adapter'],
	'cloudflare.delete_d1': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'cloudflare.delete_r2': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'cloudflare.delete_worker': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'resend.create_domain': [['write'], 'resource_creation', 'provider_adapter'],
	'resend.verify_domain': [['write'], 'domain_verification', 'provider_adapter'],
	'resend.create_sending_key': [['write'], 'secret_staging', 'native_secret_broker'],
	'resend.create_webhook': [['write'], 'webhook_creation', 'native_secret_broker'],
	'resend.send_controlled_test': [['send', 'write'], 'external_send', 'provider_adapter'],
	'resend.delete_domain': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'resend.delete_webhook': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'resend.revoke_api_key': [['destructive', 'write'], 'destructive_cleanup', 'provider_adapter'],
	'resend.revoke_setup_credential': [['destructive', 'write'], 'destructive_cleanup', 'human_only']
};

test('defines one narrow Cloudflare and Resend setup registry', () => {
	assert.equal(registry.schema_version, 'quickmail-ja.setup-capabilities.v1');
	assert.deepEqual(registry.providers, ['cloudflare', 'resend']);
	assert.ok(Array.isArray(registry.capabilities));

	const ids = registry.capabilities.map((capability) => capability.id);
	assert.equal(new Set(ids).size, ids.length, 'capability IDs must be unique');
	for (const required of requiredSetupActions) {
		assert.ok(ids.includes(required), `missing setup action: ${required}`);
	}
	for (const capability of registry.capabilities) {
		assert.ok(allowedProviders.has(capability.provider), `${capability.id}: provider`);
		assert.ok(capability.classes.length > 0, `${capability.id}: classes`);
		assert.ok(
			capability.classes.every((entry) => allowedClasses.has(entry)),
			`${capability.id}: unknown class`
		);
		assert.ok(capability.required_scopes.length > 0, `${capability.id}: required_scopes`);
		assert.ok(capability.scope_constraints.length > 0, `${capability.id}: scope_constraints`);
		assert.ok(Array.isArray(capability.adapter_operations), `${capability.id}: adapter_operations`);
		assert.ok(capability.content_access, `${capability.id}: content_access`);
		assert.ok(capability.data_handled.length > 0, `${capability.id}: data_handled`);
		assert.ok(capability.cost_class, `${capability.id}: cost_class`);
		assert.ok(capability.confirmation_class, `${capability.id}: confirmation_class`);
		assert.ok(capability.rollback?.mode, `${capability.id}: rollback mode`);
		assert.ok(capability.rollback?.description_ja, `${capability.id}: rollback description`);
	}
});

test('keeps every risk class separate and makes read-only capabilities non-mutating', () => {
	const confirmations = new Set(
		[...registry.capabilities, ...registry.human_handoffs]
			.map((entry) => entry.confirmation_class)
			.filter(Boolean)
	);
	for (const required of requiredConfirmationClasses) {
		assert.ok(confirmations.has(required), `missing confirmation class: ${required}`);
	}

	for (const capability of registry.capabilities) {
		if (capability.confirmation_class !== 'read_only') continue;
		assert.deepEqual(capability.classes, ['read'], `${capability.id} must remain read-only`);
	}

	for (const [id, [classes, confirmation, execution]] of Object.entries(dangerousContracts)) {
		const capability = registry.capabilities.find((entry) => entry.id === id);
		assert.ok(capability, `missing dangerous capability: ${id}`);
		assert.deepEqual(capability.classes, classes, `${id}: classes drifted`);
		assert.equal(capability.confirmation_class, confirmation, `${id}: confirmation drifted`);
		assert.equal(capability.execution, execution, `${id}: execution drifted`);
	}
});

test('the guidance skill exposes no provider or mailbox tool', () => {
	assert.deepEqual(registry.guidance_skill.exposed_capability_ids, []);
	assert.deepEqual(registry.guidance_skill.mailbox_permissions, {
		read: false,
		send: false,
		admin: false
	});

	const serialized = JSON.stringify(registry.guidance_skill).toLowerCase();
	assert.ok(!serialized.includes('email_body'));
	assert.ok(!serialized.includes('mailbox_content'));
});

test('same-name resources fail closed unless an exact ownership manifest is adopted', () => {
	const collision = registry.resource_collision;
	assert.equal(collision.same_name_behavior, 'collision');
	assert.equal(collision.provider_read_failure_behavior, 'stop');
	assert.equal(collision.implicit_adoption, false);
	assert.equal(collision.adoption_requires_explicit_confirmation, true);
	assert.deepEqual(collision.ownership_manifest_common_fields, [
		'schema_version',
		'project_id',
		'provider',
		'resource_type',
		'resource_id',
		'resource_name',
		'manifest_fingerprint'
	]);
	assert.deepEqual(collision.provider_identity_fields, {
		cloudflare: ['account_id'],
		resend: ['team_id']
	});
});

test('provider email content and mailbox administration stay outside setup capabilities', () => {
	const prohibited = new Set([
		'mailbox_content',
		'provider_email_content',
		'email_body',
		'attachment_content',
		'quickmail_user_admin'
	]);
	for (const capability of registry.capabilities) {
		for (const datum of capability.data_handled) {
			assert.ok(!prohibited.has(datum), `${capability.id} handles prohibited data: ${datum}`);
		}
	}
});

test('uses provider-native grant names and closes create, inspect, and cleanup paths', () => {
	const allowedCloudflare = new Set([
		'Account Settings Read',
		'Zone Read',
		'Zone Edit',
		'DNS Read',
		'DNS Edit',
		'D1 Read',
		'D1 Edit',
		'Workers R2 Storage Read',
		'Workers R2 Storage Edit',
		'Workers Scripts Read',
		'Workers Scripts Edit',
		'Email Routing Rules Read',
		'Email Routing Rules Edit'
	]);
	const allowedResend = new Set(['full_access', 'sending_access', 'human_authenticated_session']);
	for (const capability of registry.capabilities) {
		const allowed = capability.provider === 'cloudflare' ? allowedCloudflare : allowedResend;
		for (const scope of capability.required_scopes) {
			assert.ok(allowed.has(scope), `${capability.id}: non-native scope ${scope}`);
		}
	}

	const ids = new Set(registry.capabilities.map((entry) => entry.id));
	assert.ok(ids.has('cloudflare.inspect_zones'));
	assert.ok(ids.has('cloudflare.create_zone'));
	assert.ok(ids.has('cloudflare.inspect_zone'));
	for (const [create, inspect, cleanup] of [
		['cloudflare.create_d1', 'cloudflare.inspect_d1', 'cloudflare.delete_d1'],
		['cloudflare.create_r2', 'cloudflare.inspect_r2', 'cloudflare.delete_r2'],
		['cloudflare.create_worker', 'cloudflare.inspect_workers', 'cloudflare.delete_worker'],
		['resend.create_domain', 'resend.inspect_domain', 'resend.delete_domain'],
		['resend.create_webhook', 'resend.inspect_webhooks', 'resend.delete_webhook'],
		['resend.create_sending_key', 'resend.inspect_api_keys', 'resend.revoke_api_key']
	]) {
		assert.ok(ids.has(create));
		assert.ok(ids.has(inspect));
		assert.ok(ids.has(cleanup));
	}
	assert.ok(ids.has('resend.create_domain'));
	assert.ok(ids.has('resend.verify_domain'));
	assert.ok(ids.has('resend.inspect_domain'));
	assert.ok(!ids.has('cloudflare.cleanup_resource'));
	assert.ok(!ids.has('resend.cleanup_resource'));
});

test('keeps account access, billing, terms, and authentication human-only', () => {
	assert.deepEqual(
		registry.human_handoffs.map((entry) => entry.id),
		[
			'cloudflare.account_access',
			'cloudflare.setup_credential',
			'cloudflare.revoke_setup_credential',
			'cloudflare.zone_activation',
			'cloudflare.billing',
			'resend.account_access',
			'resend.setup_credential',
			'resend.billing'
		]
	);
	for (const handoff of registry.human_handoffs.filter((entry) => entry.id.endsWith('.billing'))) {
		assert.deepEqual(handoff.classes, ['billing']);
		assert.equal(handoff.confirmation_class, 'billing');
	}
	const activation = registry.human_handoffs.find(
		(entry) => entry.id === 'cloudflare.zone_activation'
	);
	assert.deepEqual(activation.steps, ['registrar_nameserver_change', 'wait_for_zone_activation']);
	const setupCredential = registry.human_handoffs.find(
		(entry) => entry.id === 'resend.setup_credential'
	);
	assert.deepEqual(setupCredential.steps, [
		'create_temporary_full_access_key',
		'enter_key_into_native_secret_broker'
	]);
	assert.ok(registry.capabilities.some((entry) => entry.id === 'resend.revoke_setup_credential'));
});

test('Resend verification cannot replay against a live verified domain', () => {
	const verify = registry.capabilities.find((entry) => entry.id === 'resend.verify_domain');
	assert.deepEqual(verify.preconditions, {
		current_state_fingerprint_required: true,
		allowed_prior_statuses: ['not_started', 'failure', 'temporary_failure'],
		verified_behavior: 'readback_noop',
		pending_behavior: 'readback_noop',
		unknown_status_behavior: 'stop'
	});
	assert.equal(verify.rollback.mode, 'not_reversible');
});

test('binds mutable provider inputs to the approved plan and prior state', () => {
	const byId = new Map(registry.capabilities.map((entry) => [entry.id, entry]));
	assert.ok(byId.get('cloudflare.stage_worker_secret').scope_constraints.includes('secret_name'));

	for (const [id, immutableFields] of Object.entries({
		'cloudflare.create_zone': ['account_id', 'domain'],
		'cloudflare.apply_remote_migration': [
			'account_id',
			'database_id',
			'migration_ids',
			'migration_bundle_digest'
		],
		'cloudflare.deploy_worker': ['account_id', 'worker_id', 'artifact_digest', 'binding_metadata'],
		'cloudflare.enable_email_routing': [
			'account_id',
			'zone_id',
			'domain',
			'dns_record_ids',
			'routing_rule_ids',
			'routing_state'
		],
		'cloudflare.change_dns': [
			'account_id',
			'zone_id',
			'domain',
			'dns_record_ids',
			'dns_record_metadata'
		],
		'cloudflare.configure_catch_all': [
			'account_id',
			'zone_id',
			'domain',
			'routing_rule_ids',
			'worker_id',
			'routing_rule_metadata'
		]
	})) {
		assert.deepEqual(byId.get(id).approval_binding, {
			immutable_fields: immutableFields,
			prior_state_fingerprint_required: true,
			desired_state_fingerprint_required: true,
			ownership_manifest_required: true,
			mismatch_behavior: 'stop'
		});
		for (const field of immutableFields) {
			assert.ok(byId.get(id).scope_constraints.includes(field), `${id}: unbound ${field}`);
		}
		assert.ok(byId.get(id).data_handled.includes('prior_state_fingerprint'));
		assert.ok(byId.get(id).data_handled.includes('desired_state_fingerprint'));
		assert.ok(byId.get(id).data_handled.includes('ownership_manifest'));
	}
});

test('binds webhook and controlled canary values without exposing returned secrets', () => {
	const byId = new Map(registry.capabilities.map((entry) => [entry.id, entry]));
	const webhook = byId.get('resend.create_webhook');
	for (const field of ['webhook_url', 'event_types', 'secret_broker_reference']) {
		assert.ok(webhook.scope_constraints.includes(field));
	}
	assert.deepEqual(webhook.secret_output_boundary, {
		output: 'webhook_signing_secret',
		destination: 'native_secret_broker',
		model_context: 'forbidden',
		logs: 'forbidden',
		filesystem: 'forbidden',
		plaintext_return: 'forbidden'
	});
	assert.equal(webhook.execution, 'native_secret_broker');
	assert.ok(!webhook.data_handled.includes('webhook_signing_secret'));
	const sendingKey = byId.get('resend.create_sending_key');
	assert.deepEqual(sendingKey.secret_output_boundary, {
		output: 'domain_restricted_sending_secret',
		destination: 'native_secret_broker',
		model_context: 'forbidden',
		logs: 'forbidden',
		filesystem: 'forbidden',
		plaintext_return: 'forbidden'
	});
	assert.ok(!sendingKey.data_handled.includes('domain_restricted_sending_secret'));

	const canary = byId.get('resend.send_controlled_test');
	for (const field of [
		'controlled_sender',
		'controlled_recipient',
		'test_token',
		'idempotency_key'
	]) {
		assert.ok(canary.scope_constraints.includes(field));
		assert.ok(canary.data_handled.includes(field));
	}
});

test('normalizes every human handoff as a non-adapter action contract', () => {
	for (const handoff of registry.human_handoffs) {
		assert.ok(handoff.classes.length > 0, `${handoff.id}: classes`);
		assert.ok(handoff.required_scopes.length > 0, `${handoff.id}: required_scopes`);
		assert.ok(handoff.scope_constraints.length > 0, `${handoff.id}: scope_constraints`);
		assert.deepEqual(handoff.adapter_operations, [], `${handoff.id}: adapter_operations`);
		assert.equal(handoff.execution, 'human_only', `${handoff.id}: execution`);
		assert.equal(handoff.content_access, 'forbidden', `${handoff.id}: content_access`);
		assert.ok(handoff.data_handled.length > 0, `${handoff.id}: data_handled`);
		assert.ok(handoff.cost_class, `${handoff.id}: cost_class`);
		assert.ok(handoff.confirmation_class, `${handoff.id}: confirmation_class`);
		assert.ok(handoff.rollback?.mode, `${handoff.id}: rollback mode`);
	}
});

test('fails closed on collisions for every setup-created routing resource', () => {
	assert.deepEqual(registry.resource_collision.covered_resource_types, [
		'cloudflare_zone',
		'cloudflare_dns_record',
		'cloudflare_email_routing_state',
		'cloudflare_email_routing_rule',
		'cloudflare_catch_all_rule',
		'cloudflare_d1_database',
		'cloudflare_r2_bucket',
		'cloudflare_worker',
		'resend_domain',
		'resend_webhook',
		'resend_api_key'
	]);
	assert.equal(registry.resource_collision.missing_resource_id_behavior, 'stop');
	assert.equal(registry.resource_collision.prior_state_mismatch_behavior, 'stop');
	assert.equal(registry.resource_collision.ownership_mismatch_behavior, 'stop');
	const byId = new Map(registry.capabilities.map((entry) => [entry.id, entry]));
	assert.deepEqual(byId.get('cloudflare.create_zone').collision_resource_types, [
		'cloudflare_zone'
	]);
	assert.deepEqual(byId.get('cloudflare.change_dns').collision_resource_types, [
		'cloudflare_dns_record'
	]);
	assert.deepEqual(byId.get('cloudflare.enable_email_routing').collision_resource_types, [
		'cloudflare_email_routing_state',
		'cloudflare_email_routing_rule'
	]);
	assert.deepEqual(byId.get('cloudflare.configure_catch_all').collision_resource_types, [
		'cloudflare_email_routing_rule',
		'cloudflare_catch_all_rule'
	]);
	for (const [id, resourceType] of Object.entries({
		'cloudflare.create_d1': 'cloudflare_d1_database',
		'cloudflare.create_r2': 'cloudflare_r2_bucket',
		'cloudflare.create_worker': 'cloudflare_worker',
		'resend.create_domain': 'resend_domain',
		'resend.create_webhook': 'resend_webhook',
		'resend.create_sending_key': 'resend_api_key'
	})) {
		assert.ok(byId.get(id).collision_resource_types.includes(resourceType), `${id}: collision`);
	}
});

test('binds every write capability to its exact approved inputs', () => {
	assert.equal(registry.scope_constraint_behavior, 'immutable_exact_match');
	const requiredInputs = {
		'cloudflare.create_zone': ['account_id', 'domain'],
		'cloudflare.create_d1': ['account_id', 'resource_name'],
		'cloudflare.create_r2': ['account_id', 'resource_name'],
		'cloudflare.create_worker': ['account_id', 'resource_name'],
		'cloudflare.stage_worker_secret': [
			'account_id',
			'worker_id',
			'secret_name',
			'secret_broker_reference'
		],
		'cloudflare.apply_remote_migration': [
			'account_id',
			'database_id',
			'migration_ids',
			'migration_bundle_digest'
		],
		'cloudflare.deploy_worker': ['account_id', 'worker_id', 'artifact_digest', 'binding_metadata'],
		'cloudflare.enable_email_routing': [
			'account_id',
			'zone_id',
			'domain',
			'dns_record_ids',
			'routing_rule_ids',
			'routing_state'
		],
		'cloudflare.change_dns': [
			'account_id',
			'zone_id',
			'domain',
			'dns_record_ids',
			'dns_record_metadata'
		],
		'cloudflare.configure_catch_all': [
			'account_id',
			'zone_id',
			'domain',
			'routing_rule_ids',
			'worker_id',
			'routing_rule_metadata'
		],
		'cloudflare.delete_d1': ['account_id', 'database_id', 'ownership_manifest_fingerprint'],
		'cloudflare.delete_r2': ['account_id', 'bucket_name', 'ownership_manifest_fingerprint'],
		'cloudflare.delete_worker': ['account_id', 'worker_id', 'ownership_manifest_fingerprint'],
		'resend.create_domain': ['team_id', 'domain'],
		'resend.verify_domain': ['team_id', 'domain_id', 'current_state_fingerprint'],
		'resend.create_sending_key': ['team_id', 'domain_id', 'key_label', 'secret_broker_reference'],
		'resend.create_webhook': ['team_id', 'webhook_url', 'event_types', 'secret_broker_reference'],
		'resend.send_controlled_test': [
			'team_id',
			'domain_id',
			'controlled_sender',
			'controlled_recipient',
			'test_token',
			'idempotency_key'
		],
		'resend.delete_domain': ['team_id', 'domain_id', 'ownership_manifest_fingerprint'],
		'resend.delete_webhook': ['team_id', 'webhook_id', 'ownership_manifest_fingerprint'],
		'resend.revoke_api_key': ['team_id', 'api_key_id', 'ownership_manifest_fingerprint'],
		'resend.revoke_setup_credential': ['team_id', 'api_key_id']
	};
	const writes = registry.capabilities.filter((entry) => entry.classes.includes('write'));
	assert.deepEqual(writes.map((entry) => entry.id).sort(), Object.keys(requiredInputs).sort());
	for (const capability of writes) {
		assert.deepEqual(
			capability.scope_constraints,
			requiredInputs[capability.id],
			`${capability.id}: approved inputs drifted`
		);
	}
});

test('provides a complete human-only Cloudflare setup credential lifecycle', () => {
	const handoff = registry.human_handoffs.find(
		(entry) => entry.id === 'cloudflare.setup_credential'
	);
	assert.deepEqual(handoff.steps, [
		'create_or_oauth_authorize_temporary_credential',
		'enter_credential_into_native_secret_broker'
	]);
	assert.equal(handoff.execution, 'human_only');
	assert.equal(handoff.confirmation_class, 'secret_staging');
	const revoke = registry.human_handoffs.find(
		(entry) => entry.id === 'cloudflare.revoke_setup_credential'
	);
	assert.deepEqual(revoke.classes, ['destructive', 'write']);
	assert.deepEqual(revoke.scope_constraints, ['account_id', 'token_id']);
	assert.deepEqual(revoke.steps, ['revoke_temporary_credential_after_setup_or_abort']);
	assert.equal(revoke.confirmation_class, 'destructive_cleanup');
});

test('keeps every Cloudflare setup write credential temporary and broker-only', () => {
	for (const capability of registry.capabilities.filter(
		(entry) => entry.provider === 'cloudflare' && entry.classes.includes('write')
	)) {
		assert.equal(
			capability.credential_boundary,
			'temporary_broker_only',
			`${capability.id}: credential boundary`
		);
	}
});

test('records all six upstream commits as a separate QMJ-8B release dependency', () => {
	for (const commit of ['43f09b2', 'a4c065f', '49de199', '535b0c5', '1b5e967', '9519cb7']) {
		const row = upstreamLedger.split('\n').find((line) => line.includes(`\`${commit}\``));
		assert.ok(row, `missing upstream row: ${commit}`);
		assert.match(row, /Defer to QMJ-8B/);
	}
	assert.match(
		upstreamLedger,
		/No upstream feature commit is merged, cherry-picked, or represented as reconciled/
	);
});
