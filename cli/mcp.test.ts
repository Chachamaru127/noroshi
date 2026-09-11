import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCurrentClient, READ_ONLY_TOOL_NAMES } from './mcp.ts';

function listTools(mode: 'read-only' | 'full'): string[] {
	const args = ['cli/main.ts', 'mcp'];
	if (mode === 'read-only') args.push('--read-only');
	const result = spawnSync(process.execPath, args, {
		cwd: new URL('..', import.meta.url),
		input:
			`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n` +
			`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	const responses = result.stdout
		.trim()
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);
}

test('read-only Mailbox MCP exposes identity and reads but no write surface', () => {
	assert.deepEqual(READ_ONLY_TOOL_NAMES, [
		'whoami',
		'list_threads',
		'get_thread',
		'search_mail',
		'list_attachments'
	]);
	assert.deepEqual(listTools('read-only'), READ_ONLY_TOOL_NAMES);
});

test('full MCP keeps explicit send and reply tools for separately authorized operation', () => {
	const names = listTools('full');
	for (const name of READ_ONLY_TOOL_NAMES) assert.ok(names.includes(name));
	assert.ok(names.includes('send_message'));
	assert.ok(names.includes('reply'));
});

test('Mailbox MCP reloads the local credential config for every tool call', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-mcp-config-'));
	const path = join(directory, 'config.json');
	const previousConfig = process.env.NOROSHI_CONFIG;
	const previousUrl = process.env.NOROSHI_URL;
	const previousToken = process.env.NOROSHI_TOKEN;
	try {
		process.env.NOROSHI_CONFIG = path;
		delete process.env.NOROSHI_URL;
		delete process.env.NOROSHI_TOKEN;
		await writeFile(path, JSON.stringify({ url: 'https://first.example', token: 'first-token' }));
		const first = await loadCurrentClient();
		await writeFile(path, JSON.stringify({ url: 'https://second.example', token: 'second-token' }));
		const second = await loadCurrentClient();
		assert.equal(first.url, 'https://first.example');
		assert.equal(first.token, 'first-token');
		assert.equal(second.url, 'https://second.example');
		assert.equal(second.token, 'second-token');
	} finally {
		if (previousConfig === undefined) delete process.env.NOROSHI_CONFIG;
		else process.env.NOROSHI_CONFIG = previousConfig;
		if (previousUrl === undefined) delete process.env.NOROSHI_URL;
		else process.env.NOROSHI_URL = previousUrl;
		if (previousToken === undefined) delete process.env.NOROSHI_TOKEN;
		else process.env.NOROSHI_TOKEN = previousToken;
		await rm(directory, { recursive: true, force: true });
	}
});
