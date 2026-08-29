#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	nativeAdapterFiles,
	nativePackageFiles,
	syncNativeAdapter
} from './generate-codex-native-adapter.mjs';
import { PLUGIN_PACKAGE_FILES } from './agent-plugin.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const nativeRoot = join(repositoryRoot, '.agents/plugins/quickmail-ja-setup');
const nativeManifestPath = join(nativeRoot, '.codex-plugin/plugin.json');
const nativeMcpPath = join(nativeRoot, '.mcp.json');
const marketplacePath = join(repositoryRoot, '.agents/plugins/marketplace.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const read = (path) => readFileSync(path, 'utf8');

function rpcLines(scriptPath, lines) {
	const result = spawnSync(process.execPath, [scriptPath], {
		cwd: nativeRoot,
		input: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '', 'native MCP must keep stdout/stderr protocol-only');
	return result.stdout
		.trim()
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test('Codex native marketplace and plugin manifests stay in the official shape', () => {
	const marketplace = readJson(marketplacePath);
	const plugin = readJson(nativeManifestPath);
	const mcp = readJson(nativeMcpPath);

	assert.equal(marketplace.name, 'quickmail-ja');
	assert.equal(marketplace.interface.displayName, 'QuickMail-ja');
	assert.equal(marketplace.plugins.length, 1);
	const entry = marketplace.plugins[0];
	assert.equal(entry.name, 'quickmail-ja-setup');
	assert.deepEqual(entry.source, {
		source: 'local',
		path: './.agents/plugins/quickmail-ja-setup'
	});
	assert.deepEqual(entry.policy, {
		installation: 'AVAILABLE',
		authentication: 'ON_INSTALL'
	});
	assert.equal(entry.category, 'Productivity');

	assert.equal(plugin.name, 'quickmail-ja-setup');
	assert.equal(plugin.version, '1.0.0');
	assert.equal(plugin.license, 'MIT');
	assert.equal(plugin.skills, './skills/');
	assert.equal(plugin.mcpServers, './.mcp.json');
	assert.deepEqual(Object.keys(plugin).sort(), [
		'author',
		'description',
		'keywords',
		'license',
		'mcpServers',
		'name',
		'skills',
		'version'
	]);

	assert.deepEqual(Object.keys(mcp), ['quickmail-ja-setup-engine']);
	assert.deepEqual(mcp['quickmail-ja-setup-engine'], {
		command: 'node',
		args: ['scripts/setup-plugin-mcp.mjs'],
		cwd: '.'
	});
});

test('Codex native distribution keeps one exact generated file allowlist', () => {
	const files = nativePackageFiles();
	assert.deepEqual(files, [
		'.agents/plugins/marketplace.json',
		'.agents/plugins/quickmail-ja-setup/.codex-plugin/plugin.json',
		'.agents/plugins/quickmail-ja-setup/.mcp.json',
		'.agents/plugins/quickmail-ja-setup/LICENSE.md',
		'.agents/plugins/quickmail-ja-setup/scripts/setup-engine.mjs',
		'.agents/plugins/quickmail-ja-setup/scripts/setup-plugin-mcp.mjs',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-operations/SKILL.md',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/SKILL.md',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/agents/openai.yaml',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/references/browser-and-byok.md',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/references/cloudflare-resend.md',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/references/gmail-byok.md',
		'.agents/plugins/quickmail-ja-setup/skills/quickmail-ja-setup/references/setup-patterns.json'
	]);
	for (const path of files) {
		assert.equal(path.startsWith('/'), false);
		assert.equal(path.includes('\\'), false);
		assert.equal(path.split('/').includes('..'), false);
	}
});

test('Codex native adapter mirrors the canonical Skill, MCP, and safety runtime', () => {
	syncNativeAdapter({ check: true });
	for (const { source, destination } of nativeAdapterFiles()) {
		assert.equal(
			read(join(nativeRoot, destination)),
			read(join(repositoryRoot, source)),
			`${destination} must be copied from ${source}`
		);
	}
	assert.equal(statSync(join(nativeRoot, '.codex-plugin')).isDirectory(), true);
	assert.equal(read('skills/quickmail-ja-setup/SKILL.md').includes('BYOK'), true);
	assert.equal(read(join(nativeRoot, 'skills/quickmail-ja-setup/SKILL.md')).includes('BYOK'), true);

	const mcpScript = read(join(nativeRoot, 'scripts/setup-plugin-mcp.mjs'));
	assert.doesNotMatch(mcpScript, /\b(?:fetch|WebSocket|http:|https:|net\.|dns\.)/u);
});

test('Codex native MCP discovers only setup tools and blocks setup_apply', () => {
	const [initialize, listed, applied] = rpcLines(join(nativeRoot, 'scripts/setup-plugin-mcp.mjs'), [
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
		{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'setup_apply', arguments: {} } }
	]);

	assert.equal(initialize.result.serverInfo.name, 'quickmail-ja-setup-engine');
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name),
		[
			'setup_inspect',
			'setup_plan',
			'setup_approve',
			'setup_apply',
			'setup_readback',
			'setup_verify'
		]
	);
	assert.equal(applied.result.isError, true);
	assert.match(applied.result.content[0].text, /provider_adapter_unavailable/u);
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

test('native MCP manifest exposes no provider credentials or mailbox capabilities', () => {
	const plugin = read(nativeManifestPath);
	const mcp = read(nativeMcpPath);
	assert.doesNotMatch(`${plugin}\n${mcp}`, /(?:api[_-]?key|password|secret|token|credential)/iu);
	assert.doesNotMatch(
		`${plugin}\n${mcp}`,
		/(?:mailbox|send_message|list_threads|get_thread|admin)/iu
	);
});

test('Codex-only marketplace metadata stays outside the portable Agent Plugin archive', () => {
	assert.doesNotMatch(JSON.stringify(PLUGIN_PACKAGE_FILES), /\.agents\/plugins|\.codex-plugin/u);
});
