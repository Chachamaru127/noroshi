#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
	AGENT_MCP_SCHEMA,
	AGENT_MCP_SCHEMA_URI,
	AGENT_PLUGIN_SCHEMA,
	AGENT_PLUGIN_SCHEMA_URI,
	OFFICIAL_SCHEMA_PROVENANCE,
	verifyOfficialSchemaBytes
} from './agent-plugin-schemas.mjs';
import {
	ENGINE_OPERATIONS,
	MCP_SERVER_NAME,
	MCP_TOOL_NAMES,
	PLUGIN_PACKAGE_FILES,
	assertMcpConfiguration,
	packageAgentPlugin,
	pluginCapabilityProjection,
	validateAgentPlugin,
	validatePackageOutput,
	validatePluginTreeListing
} from './agent-plugin.mjs';
import { SETUP_STEP_CAPABILITY_CONTRACT } from './setup-engine.mjs';

const root = new URL('..', import.meta.url);
const repositoryRoot = fileURLToPath(root);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readBytes = (path) => readFileSync(new URL(`../${path}`, import.meta.url));

function compile(schema) {
	return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

function regular(path, mode = '100644') {
	return `${mode} blob ${'0'.repeat(40)}\t${path}\0`;
}

function rpcLines(lines) {
	const result = spawnSync(process.execPath, ['scripts/setup-plugin-mcp.mjs'], {
		cwd: new URL('..', import.meta.url),
		input: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '', 'MCP server must keep stdout/stderr protocol-only');
	return result.stdout
		.trim()
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test('portable root manifest and MCP use the published Agent Plugins 1.0 schemas', () => {
	const manifest = JSON.parse(read('plugin.json'));
	const mcp = JSON.parse(read('mcp.json'));
	const validateManifest = compile(AGENT_PLUGIN_SCHEMA);
	const validateMcp = compile(AGENT_MCP_SCHEMA);
	assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
	assert.equal(validateMcp(mcp), true, JSON.stringify(validateMcp.errors));
	assert.equal(manifest.$schema, AGENT_PLUGIN_SCHEMA_URI);
	assert.equal(mcp.$schema, AGENT_MCP_SCHEMA_URI);
	assert.deepEqual(OFFICIAL_SCHEMA_PROVENANCE, {
		version: 'Agent Plugins 1.0.0',
		observed_at: '2026-08-29',
		license: 'Apache-2.0',
		plugin: {
			uri: AGENT_PLUGIN_SCHEMA_URI,
			sha256: '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883'
		},
		mcp: {
			uri: AGENT_MCP_SCHEMA_URI,
			sha256: '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb'
		}
	});
	for (const [path, expected] of [
		[
			'docs/setup/vendor/agent-plugins/1.0.0/plugin.schema.json',
			OFFICIAL_SCHEMA_PROVENANCE.plugin.sha256
		],
		['docs/setup/vendor/agent-plugins/1.0.0/mcp.schema.json', OFFICIAL_SCHEMA_PROVENANCE.mcp.sha256]
	]) {
		assert.equal(createHash('sha256').update(readBytes(path)).digest('hex'), expected);
	}
	assert.equal(validateManifest({ ...manifest, unknown: true }), false);
	assert.equal(validateManifest({ ...manifest, name: 'QuickMail-ja' }), false);
	assert.equal(validateMcp({ ...mcp, extra: true }), false);
	assert.equal(
		validateMcp({
			...mcp,
			mcpServers: {
				[`${MCP_SERVER_NAME}-other`]: mcp.mcpServers[MCP_SERVER_NAME]
			}
		}),
		true
	);
});

test('official schema checksum fixture rejects tampered bytes', () => {
	const source = readBytes('docs/setup/vendor/agent-plugins/1.0.0/plugin.schema.json');
	const tampered = Buffer.from(source);
	tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b;
	assert.throws(
		() =>
			verifyOfficialSchemaBytes(tampered, {
				uri: AGENT_PLUGIN_SCHEMA_URI,
				sha256: OFFICIAL_SCHEMA_PROVENANCE.plugin.sha256
			}),
		/official Agent Plugins schema checksum mismatch/
	);
});

test('repository plugin passes the bounded manifest, generated projection, and MCP checks', () => {
	const checked = validateAgentPlugin();
	assert.equal(checked.manifest.name, 'quickmail-ja-setup');
	assert.deepEqual(checked.mcp.mcpServers[MCP_SERVER_NAME].args, [
		'${PLUGIN_ROOT}/scripts/setup-plugin-mcp.mjs'
	]);
	assert.deepEqual(checked.projection.engine_operations, ENGINE_OPERATIONS);
	assert.deepEqual(checked.projection.provider_operations, []);
	assert.deepEqual(checked.projection.exposed_capability_ids, []);
	assert.deepEqual(checked.projection.mailbox_permissions, {
		read: false,
		send: false,
		admin: false
	});
	assert.equal(checked.projection.provider_email_access, false);
	assert.match(read('skills/quickmail-ja-setup/SKILL.md'), /^---\nname: quickmail-ja-setup\n/u);
	assert.deepEqual(
		PLUGIN_PACKAGE_FILES.filter((path) => path.startsWith('skills/')),
		[
			'skills/quickmail-ja-operations/SKILL.md',
			'skills/quickmail-ja-setup/SKILL.md',
			'skills/quickmail-ja-setup/agents/openai.yaml',
			'skills/quickmail-ja-setup/references/browser-and-byok.md',
			'skills/quickmail-ja-setup/references/cloudflare-resend.md',
			'skills/quickmail-ja-setup/references/gmail-byok.md',
			'skills/quickmail-ja-setup/references/setup-patterns.json'
		]
	);
	assert.doesNotMatch(
		JSON.stringify(PLUGIN_PACKAGE_FILES),
		/scripts\/setup\.mjs/u,
		'interactive repository setup CLI must not be in the Agent Plugin'
	);
	assert.match(read('skills/quickmail-ja-setup/SKILL.md'), /BYOK/u);
	assert.match(read('skills/quickmail-ja-setup/SKILL.md'), /公式ドキュメントを実際に開き/u);
	assert.match(
		read('skills/quickmail-ja-setup/SKILL.md'),
		/ログイン、アカウント切替、MFA、CAPTCHA、規約同意、支払い/u
	);
});

test('capability projection is exact and registry drift fails closed', () => {
	const registry = JSON.parse(read('setup/capabilities.json'));
	const projection = pluginCapabilityProjection(registry);
	const expectedStepCount = Object.values(SETUP_STEP_CAPABILITY_CONTRACT).reduce(
		(total, entries) => total + entries.length,
		0
	);
	assert.equal(projection.step_contract.length, expectedStepCount);
	assert.notDeepEqual(
		{ ...projection, engine_operations: ['apply'] },
		projection,
		'a stale projection must not be equivalent to the generated projection'
	);
	const drifted = structuredClone(registry);
	const first = SETUP_STEP_CAPABILITY_CONTRACT.resource_creation[0];
	drifted.capabilities = drifted.capabilities.filter(
		(capability) => capability.id !== first.capability_id
	);
	assert.throws(() => pluginCapabilityProjection(drifted), /setup contract drift/);
	const invalidVersion = structuredClone(registry);
	invalidVersion.schema_version = 'unknown';
	assert.throws(
		() => pluginCapabilityProjection(invalidVersion),
		/unsupported setup capability registry/
	);
});

test('MCP rejects non-stdio or network/provider transport configuration', () => {
	const mcp = JSON.parse(read('mcp.json'));
	const server = mcp.mcpServers[MCP_SERVER_NAME];
	assert.throws(
		() =>
			assertMcpConfiguration({
				...mcp,
				mcpServers: {
					[MCP_SERVER_NAME]: { type: 'streamable-http', url: 'https://provider.invalid/mcp' }
				}
			}),
		/stdio/
	);
	const script = read('scripts/setup-plugin-mcp.mjs');
	assert.doesNotMatch(script, /\b(?:fetch|WebSocket|http:|https:|net\.|dns\.)/u);
	assert.equal(server.command, 'node');
	assert.deepEqual(server.env, undefined);
});

test('MCP tools/list exposes exactly QMJ-10 operations and no mailbox/provider tools', () => {
	const [initialize, listed] = rpcLines([
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
	]);
	assert.equal(initialize.result.serverInfo.name, MCP_SERVER_NAME);
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name),
		[...MCP_TOOL_NAMES]
	);
	assert.match(
		listed.result.tools.find((tool) => tool.name === 'setup_readback').description,
		/validated QMJ-10 plan/u
	);
	assert.match(
		listed.result.tools.find((tool) => tool.name === 'setup_verify').description,
		/validated QMJ-10 plan/u
	);
	const toolText = JSON.stringify(listed.result.tools);
	for (const forbidden of [
		'list_threads',
		'get_thread',
		'send_message',
		'reply',
		'attachments',
		'admin'
	]) {
		assert.doesNotMatch(toolText, new RegExp(`\\b${forbidden}\\b`, 'u'));
	}
});

test('MCP notifications produce no response, including unknown notification names', () => {
	assert.deepEqual(
		rpcLines([
			{ jsonrpc: '2.0', id: 10, method: 'notifications/initialized' },
			{ jsonrpc: '2.0', method: 'notifications/custom', params: { ignored: true } },
			{ jsonrpc: '2.0', id: 11, method: 'notifications/cancelled' }
		]),
		[]
	);
});

test('MCP inspects only a non-secret local snapshot and never applies a provider write', () => {
	const responses = rpcLines([
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'setup_inspect',
				arguments: {
					target: {
						provider: 'cloudflare',
						resource_type: 'zone',
						account_id: 'account-fixture'
					},
					snapshot: { resources: [], observed_at: '2026-08-29T00:00:00Z' }
				}
			}
		},
		{
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'setup_inspect',
				arguments: {
					target: {
						provider: 'resend',
						resource_type: 'domain',
						team_id: 'team-fixture'
					},
					snapshot: { api_key: 'must-be-rejected' }
				}
			}
		},
		{
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'setup_apply', arguments: { plan: { plan_id: 'fixture' } } }
		},
		{
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'unknown_tool', arguments: {} }
		}
	]);
	assert.equal(responses.length, 4);
	const responseFor = (id) => responses.find((response) => response.id === id);
	const inspectedResponse = responseFor(1);
	const rejectedResponse = responseFor(2);
	const appliedResponse = responseFor(3);
	const unknownResponse = responseFor(4);
	assert.ok(inspectedResponse);
	assert.ok(rejectedResponse);
	assert.ok(appliedResponse);
	assert.ok(unknownResponse);
	const inspected = JSON.parse(inspectedResponse.result.content[0].text);
	assert.equal(inspected.schema_version, 'quickmail-ja.setup-engine.v1');
	assert.equal(inspected.state.observed_at, '2026-08-29T00:00:00Z');
	assert.match(inspected.current_state_fingerprint, /^[0-9a-f]{64}$/u);
	const rejected = JSON.parse(rejectedResponse.result.content[0].text);
	assert.equal(rejectedResponse.result.isError, true);
	assert.equal(rejected.error.code, 'unsafe_plan_data');
	assert.equal(appliedResponse.result.isError, true);
	assert.match(appliedResponse.result.content[0].text, /provider_adapter_unavailable/);
	assert.equal(unknownResponse.result.isError, true);
	assert.match(unknownResponse.result.content[0].text, /unsupported_operation/);
});

test('package allowlist rejects special files, unsafe paths, and additions', () => {
	const listing = PLUGIN_PACKAGE_FILES.map((path) => regular(path)).join('');
	assert.doesNotThrow(() => validatePluginTreeListing(listing));
	assert.throws(
		() => validatePluginTreeListing(`${listing}${regular('setup/../escape')}`),
		/unsafe path|allowlist mismatch/
	);
	assert.throws(
		() => validatePluginTreeListing(`${listing}${regular('outside.txt')}`),
		/allowlist mismatch/
	);
	assert.throws(
		() => validatePluginTreeListing(`${listing}${regular('links/escape', '120000')}`),
		/non-file entry/
	);
	assert.throws(
		() => validatePluginTreeListing(`${listing}${regular('/absolute')}`),
		/unsafe path/
	);
});

test('package output path rejects outside paths and symlinks without touching targets', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-agent-plugin-'));
	const outside = join(temporary, 'outside.zip');
	const out = join(repositoryRoot, 'out');
	const output = join(out, `agent-plugin-symlink-${process.pid}.zip`);
	writeFileSync(outside, 'preserve');
	mkdirSync(out, { recursive: true });
	symlinkSync(outside, output);
	try {
		assert.throws(() => validatePackageOutput(outside), /direct \.zip file under repository out/);
		assert.throws(() => validatePackageOutput(output), /regular file/);
		assert.equal(readFileSync(outside, 'utf8'), 'preserve');
	} finally {
		rmSync(output, { force: true });
		rmSync(temporary, { recursive: true, force: true });
	}
});

test('committed Agent Plugin archive passes exact-entry, traversal, symlink, and secret-canary checks', () => {
	const out = join(repositoryRoot, 'out');
	const output = join(out, `agent-plugin-archive-${process.pid}.zip`);
	const canary = join(out, `secret-canary-${process.pid}.txt`);
	mkdirSync(out, { recursive: true });
	writeFileSync(canary, 'secret-canary-do-not-include');
	try {
		const packaged = packageAgentPlugin({ output });
		assert.deepEqual([...packaged.files].sort(), [...PLUGIN_PACKAGE_FILES].sort());
		const expectedEntries = [
			'quickmail-ja-setup-plugin/',
			'quickmail-ja-setup-plugin/LICENSE.md',
			'quickmail-ja-setup-plugin/mcp.json',
			'quickmail-ja-setup-plugin/plugin.json',
			'quickmail-ja-setup-plugin/scripts/',
			'quickmail-ja-setup-plugin/scripts/setup-engine.mjs',
			'quickmail-ja-setup-plugin/scripts/setup-plugin-mcp.mjs',
			'quickmail-ja-setup-plugin/setup/',
			'quickmail-ja-setup-plugin/setup/capabilities.json',
			'quickmail-ja-setup-plugin/setup/plugin-capabilities.json',
			'quickmail-ja-setup-plugin/skills/',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-operations/',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-operations/SKILL.md',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/SKILL.md',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/agents/',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/agents/openai.yaml',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/references/',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/references/browser-and-byok.md',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/references/cloudflare-resend.md',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/references/gmail-byok.md',
			'quickmail-ja-setup-plugin/skills/quickmail-ja-setup/references/setup-patterns.json'
		];
		const listing = spawnSync('unzip', ['-Z1', output], { encoding: 'utf8' });
		assert.equal(listing.status, 0, listing.stderr);
		assert.deepEqual(listing.stdout.trim().split(/\r?\n/u), expectedEntries);
		for (const entry of listing.stdout.trim().split(/\r?\n/u)) {
			assert.doesNotMatch(entry, /(?:^|\/)\.\.(?:\/|$)|\\/u);
		}
		const integrity = spawnSync('unzip', ['-t', output], { encoding: 'utf8' });
		assert.equal(integrity.status, 0, integrity.stderr);
		const contents = spawnSync('unzip', ['-p', output], { encoding: 'utf8' });
		assert.equal(contents.status, 0, contents.stderr);
		assert.doesNotMatch(contents.stdout, /secret-canary-do-not-include/u);
		assert.doesNotMatch(contents.stdout, /re_[A-Za-z0-9_-]{20,}/u);
	} finally {
		rmSync(output, { force: true });
		rmSync(canary, { force: true });
	}
});

test('Claude adapter is generated from the portable Skill and stays truthful about host support', () => {
	const generator = spawnSync(
		process.execPath,
		['scripts/generate-claude-adapter.mjs', '--check'],
		{
			cwd: new URL('..', import.meta.url),
			encoding: 'utf8'
		}
	);
	assert.equal(generator.status, 0, generator.stderr);
	const portable = read('skills/quickmail-ja-operations/SKILL.md');
	const claude = read('adapters/claude/skills/quickmail-ja-operations/SKILL.md');
	assert.match(claude, /^---\nname: quickmail-ja-operations\n/u);
	assert.match(claude, /Generated from skills\/quickmail-ja-operations\/SKILL\.md/);
	assert.match(read('adapters/claude/README.md'), /確認していない|対応済みとは扱わない/);
	assert.match(read('adapters/openai/README.md'), /cloneだけでインストールされる/);
	assert.doesNotMatch(portable, /resend_api_key|api_key_value|password:/u);
});
