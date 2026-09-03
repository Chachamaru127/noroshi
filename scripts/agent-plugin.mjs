#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { SETUP_STEP_CAPABILITY_CONTRACT } from './setup-engine.mjs';
import {
	AGENT_MCP_SCHEMA,
	AGENT_MCP_SCHEMA_URI,
	AGENT_PLUGIN_SCHEMA,
	AGENT_PLUGIN_SCHEMA_URI
} from './agent-plugin-schemas.mjs';

export const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PLUGIN_PACKAGE_FILES = Object.freeze([
	'plugin.json',
	'mcp.json',
	'skills/noroshi-operations/SKILL.md',
	// Keep the canonical BYOK guidance Skill and its reviewed references
	// inside the Agent Plugin so the plugin is useful without the repository.
	'skills/noroshi-setup/SKILL.md',
	'skills/noroshi-setup/agents/openai.yaml',
	'skills/noroshi-setup/references/browser-and-byok.md',
	'skills/noroshi-setup/references/cloudflare-resend.md',
	'skills/noroshi-setup/references/gmail-byok.md',
	'skills/noroshi-setup/references/setup-patterns.json',
	'scripts/setup-engine.mjs',
	'scripts/setup-plugin-mcp.mjs',
	'setup/capabilities.json',
	'setup/plugin-capabilities.json',
	'LICENSE.md'
]);
export const ENGINE_OPERATIONS = Object.freeze([
	'inspect',
	'plan',
	'approve',
	'apply',
	'readback',
	'verify'
]);
export const MCP_SERVER_NAME = 'noroshi-setup-engine';
export const MCP_TOOL_NAMES = Object.freeze([
	'setup_inspect',
	'setup_plan',
	'setup_approve',
	'setup_apply',
	'setup_readback',
	'setup_verify'
]);

const registryPath = join(REPOSITORY_ROOT, 'setup/capabilities.json');
const projectionPath = join(REPOSITORY_ROOT, 'setup/plugin-capabilities.json');
function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function readPluginFile(root, relativePath, treeish = null) {
	if (treeish === null || treeish === undefined) {
		return readFileSync(join(root, relativePath), 'utf8');
	}
	const result = spawnSync('git', ['show', `${treeish}:${relativePath}`], {
		cwd: root,
		encoding: 'utf8'
	});
	if (result.status !== 0) {
		throw new Error(`committed Agent Plugin file is missing: ${relativePath}`);
	}
	return result.stdout;
}

function hasPluginFile(root, relativePath, treeish = null) {
	if (treeish === null || treeish === undefined) return existsSync(join(root, relativePath));
	return (
		spawnSync('git', ['cat-file', '-e', `${treeish}:${relativePath}`], {
			cwd: root,
			encoding: 'utf8'
		}).status === 0
	);
}

function readPluginJson(root, relativePath, treeish = null) {
	return JSON.parse(readPluginFile(root, relativePath, treeish));
}

function canonical(value) {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function schemaValidator(schema) {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	return ajv.compile(schema);
}

export function pluginCapabilityProjection(registry) {
	if (!registry || registry.schema_version !== 'noroshi.setup-capabilities.v1') {
		throw new Error('unsupported setup capability registry');
	}
	const registryCapabilities = new Map(
		(registry.capabilities ?? []).map((entry) => [entry.id, entry])
	);
	const stepContract = Object.entries(SETUP_STEP_CAPABILITY_CONTRACT)
		.flatMap(([kind, entries]) =>
			entries.map(({ capability_id, operation }) => {
				const capability = registryCapabilities.get(capability_id);
				if (!capability || !capability.adapter_operations.includes(operation)) {
					throw new Error(`setup contract drift: ${capability_id}/${operation}`);
				}
				return { kind, capability_id, operation };
			})
		)
		.sort((left, right) =>
			`${left.kind}:${left.capability_id}:${left.operation}`.localeCompare(
				`${right.kind}:${right.capability_id}:${right.operation}`
			)
		);
	return {
		schema_version: 'noroshi.setup-plugin-capabilities.v1',
		source_schema_version: registry.schema_version,
		source: 'setup/capabilities.json',
		exposed_capability_ids: [],
		mailbox_permissions: { read: false, send: false, admin: false },
		provider_email_access: false,
		engine_operations: [...ENGINE_OPERATIONS],
		provider_operations: [],
		step_contract: stepContract
	};
}

export function assertMcpConfiguration(mcp, { pluginRoot = REPOSITORY_ROOT, treeish = null } = {}) {
	const validate = schemaValidator(AGENT_MCP_SCHEMA);
	if (!validate(mcp)) throw new Error(`mcp schema invalid: ${ajvErrors(validate)}`);
	const servers = mcp.mcpServers;
	if (Object.keys(servers).length !== 1 || !servers[MCP_SERVER_NAME]) {
		throw new Error('MCP must expose exactly the QMJ-10 setup engine server');
	}
	const server = servers[MCP_SERVER_NAME];
	if (server.type !== 'stdio' || server.command !== 'node') {
		throw new Error('setup MCP must use the dependency-free node stdio transport');
	}
	if (
		JSON.stringify(server.args ?? []) !==
		JSON.stringify(['${PLUGIN_ROOT}/scripts/setup-plugin-mcp.mjs'])
	) {
		throw new Error('setup MCP command arguments must remain plugin-rooted');
	}
	if (server.cwd !== '${PLUGIN_ROOT}') throw new Error('setup MCP cwd must remain plugin-rooted');
	if (server.env && Object.keys(server.env).length > 0) {
		throw new Error('setup MCP must not configure environment credentials');
	}
	const script = readPluginFile(pluginRoot, 'scripts/setup-plugin-mcp.mjs', treeish);
	if (/\b(?:fetch|WebSocket|http:|https:|net\.|dns\.)/u.test(script)) {
		throw new Error('setup MCP must not contain a network/provider transport');
	}
	return true;
}

export function validateAgentPlugin({ root = REPOSITORY_ROOT, treeish = null } = {}) {
	const manifest = readPluginJson(root, 'plugin.json', treeish);
	const validateManifest = schemaValidator(AGENT_PLUGIN_SCHEMA);
	if (!validateManifest(manifest)) {
		throw new Error(`plugin schema invalid: ${ajvErrors(validateManifest)}`);
	}
	if (manifest.$schema !== AGENT_PLUGIN_SCHEMA_URI) throw new Error('plugin schema URI drift');
	const hasMcp = hasPluginFile(root, 'mcp.json', treeish);
	if (hasMcp) {
		const mcp = readPluginJson(root, 'mcp.json', treeish);
		if (mcp.$schema !== AGENT_MCP_SCHEMA_URI) throw new Error('MCP schema URI drift');
		assertMcpConfiguration(mcp, { pluginRoot: root, treeish });
	}
	const registry = readPluginJson(root, 'setup/capabilities.json', treeish);
	const expectedProjection = pluginCapabilityProjection(registry);
	const projection = readPluginJson(root, 'setup/plugin-capabilities.json', treeish);
	deepStrictEqual(projection, expectedProjection);
	if (
		manifest.extensions?.['com.noroshi.setup']?.capability_registry !==
		'setup/plugin-capabilities.json'
	) {
		throw new Error('plugin manifest must point to the generated capability projection');
	}
	if (
		JSON.stringify(manifest.extensions?.['com.noroshi.setup']?.mailbox_permissions) !==
		JSON.stringify({ read: false, send: false, admin: false })
	) {
		throw new Error('plugin manifest mailbox permissions must remain disabled');
	}
	const extension = manifest.extensions?.['com.noroshi.setup'];
	if (!extension || extension.provider_adapter_status !== 'not-enabled') {
		throw new Error('plugin manifest must keep provider adapters disabled');
	}
	if (
		JSON.stringify(extension.exposed_capability_ids ?? []) !== JSON.stringify([]) ||
		extension.provider_email_access !== false
	) {
		throw new Error('plugin manifest must expose no provider capabilities or email access');
	}
	const skill = readPluginFile(root, 'skills/noroshi-operations/SKILL.md', treeish);
	if (!/^---\nname: noroshi-operations\n/mu.test(skill)) {
		throw new Error('operations Skill frontmatter is missing');
	}
	const setupSkillPath = 'skills/noroshi-setup/SKILL.md';
	const setupSkill = readPluginFile(root, setupSkillPath, treeish);
	if (!/^---\nname: noroshi-setup\n/mu.test(setupSkill)) {
		throw new Error('BYOK setup Skill frontmatter is missing');
	}
	const packagedSetupFiles = PLUGIN_PACKAGE_FILES.filter((path) =>
		path.startsWith('skills/noroshi-setup/')
	);
	for (const relativePath of packagedSetupFiles.filter((path) => path !== setupSkillPath)) {
		if (!hasPluginFile(root, relativePath, treeish)) {
			throw new Error(`BYOK setup Skill file is missing: ${relativePath}`);
		}
	}
	if (PLUGIN_PACKAGE_FILES.includes('scripts/setup.mjs')) {
		throw new Error('interactive scripts/setup.mjs must stay outside the Agent Plugin');
	}
	const mcpScript = readPluginFile(root, 'scripts/setup-plugin-mcp.mjs', treeish);
	for (const forbidden of [
		'list_threads',
		'get_thread',
		'send_message',
		'reply',
		'attachments',
		'admin',
		'mailbox_content'
	]) {
		if (new RegExp(`name\\s*:\\s*['"]${forbidden}['"]`, 'u').test(mcpScript)) {
			throw new Error(`setup MCP must not expose mailbox/provider tool ${forbidden}`);
		}
	}
	return { manifest, mcp: hasMcp ? readPluginJson(root, 'mcp.json', treeish) : null, projection };
}

function ajvErrors(validate) {
	return (validate.errors ?? [])
		.map((error) => `${error.instancePath} ${error.message}`)
		.join('; ');
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim()
		);
	}
	return result;
}

function parseTreeListing(listing) {
	return listing
		.split('\0')
		.filter(Boolean)
		.map((entry) => {
			const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
			if (!match) throw new Error('plugin tree contains an unreadable entry');
			return { mode: match[1], type: match[2], path: match[4] };
		});
}

export function validatePluginTreeListing(listing, { expected = PLUGIN_PACKAGE_FILES } = {}) {
	const entries = parseTreeListing(listing);
	for (const entry of entries) {
		if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
			throw new Error(`plugin package contains a non-file entry: ${entry.path}`);
		}
		if (
			entry.path.split('/').includes('..') ||
			entry.path.startsWith('/') ||
			entry.path.includes('\\')
		) {
			throw new Error(`plugin package contains an unsafe path: ${entry.path}`);
		}
	}
	const actual = entries.map((entry) => entry.path).sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		throw new Error(`plugin package file allowlist mismatch: ${actual.join(', ')}`);
	}
	return entries;
}

export function validatePackageOutput(
	outputPath,
	{ outputRoot = join(REPOSITORY_ROOT, 'out') } = {}
) {
	const resolvedOutput = resolve(outputPath);
	if (
		dirname(resolvedOutput) !== resolve(outputRoot) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/u.test(basename(resolvedOutput))
	) {
		throw new Error('Agent Plugin output must be a direct .zip file under repository out');
	}
	if (existsSync(outputRoot)) {
		const status = lstatSync(outputRoot);
		if (!status.isDirectory() || status.isSymbolicLink())
			throw new Error('plugin output root is unsafe');
	}
	if (existsSync(resolvedOutput)) {
		const status = lstatSync(resolvedOutput);
		if (!status.isFile() || status.isSymbolicLink())
			throw new Error('plugin output must be a regular file');
	}
	return resolvedOutput;
}

export function packageAgentPlugin({
	treeish = 'HEAD',
	output = join(REPOSITORY_ROOT, 'out', 'noroshi-agent-plugin.zip')
} = {}) {
	validateAgentPlugin({ root: REPOSITORY_ROOT, treeish });
	const outputPath = validatePackageOutput(output);
	mkdirSync(dirname(outputPath), { recursive: true });
	rmSync(outputPath, { force: true });
	const listing = run('git', [
		'ls-tree',
		'-r',
		'-z',
		treeish,
		'--',
		...PLUGIN_PACKAGE_FILES
	]).stdout;
	const entries = validatePluginTreeListing(listing);
	run('git', [
		'archive',
		'--format=zip',
		'--prefix=noroshi-setup-plugin/',
		`--output=${outputPath}`,
		treeish,
		'--',
		...PLUGIN_PACKAGE_FILES
	]);
	const status = lstatSync(outputPath);
	if (!status.isFile() || status.isSymbolicLink() || status.size === 0) {
		throw new Error('Agent Plugin archive is not a non-empty regular file');
	}
	return { output: outputPath, files: entries.map((entry) => entry.path) };
}

export function writePluginCapabilityProjection({ root = REPOSITORY_ROOT } = {}) {
	const source = readJson(join(root, 'setup/capabilities.json'));
	const output = canonical(pluginCapabilityProjection(source));
	writeFileSync(join(root, 'setup/plugin-capabilities.json'), output);
	return output;
}

if (import.meta.main) {
	const [command = 'check'] = process.argv.slice(2);
	if (command === 'write') {
		writePluginCapabilityProjection();
		console.log('✓ Agent Plugin capability projection generated.');
	} else if (command === 'package') {
		const result = packageAgentPlugin();
		console.log(`✓ Agent Plugin package: ${result.output} (${result.files.length} files)`);
	} else if (command === 'check') {
		validateAgentPlugin();
		const expected = canonical(pluginCapabilityProjection(readJson(registryPath)));
		if (readFileSync(projectionPath, 'utf8') !== expected) {
			throw new Error(
				'setup/plugin-capabilities.json is stale; run bun scripts/agent-plugin.mjs write'
			);
		}
		console.log('✓ Agent Plugins 1.0 manifest, MCP, Skill, and capability projection validated.');
	} else {
		throw new Error(`unknown agent-plugin command: ${command}`);
	}
}
