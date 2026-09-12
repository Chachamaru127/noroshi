import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { READ_ONLY_TOOL_NAMES } from './mcp.ts';

function listTools(mode: 'default' | 'read-only-alias' | 'read-write'): string[] {
	const args = ['cli/main.ts', 'mcp'];
	if (mode === 'read-only-alias') args.push('--read-only');
	if (mode === 'read-write') args.push('--read-write');
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
	assert.deepEqual(listTools('default'), READ_ONLY_TOOL_NAMES);
	assert.deepEqual(listTools('read-only-alias'), READ_ONLY_TOOL_NAMES);
});

test('read-write MCP exposes send and reply only after an explicit flag', () => {
	const names = listTools('read-write');
	assert.deepEqual(names.toSorted(), [...READ_ONLY_TOOL_NAMES, 'send_message', 'reply'].toSorted());
});

test('MCP CLI documents the safe default and rejects conflicting mode flags', () => {
	const help = spawnSync(process.execPath, ['cli/main.ts', '--help'], {
		cwd: new URL('..', import.meta.url),
		encoding: 'utf8'
	});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /noroshi mcp\s+Read-only mailbox MCP/u);
	assert.match(help.stdout, /noroshi mcp --read-write/u);

	const conflict = spawnSync(
		process.execPath,
		['cli/main.ts', 'mcp', '--read-only', '--read-write'],
		{
			cwd: new URL('..', import.meta.url),
			encoding: 'utf8'
		}
	);
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.stderr, /cannot be used together/u);
});

test('Mailbox MCP reloads replaced credential config between JSON-RPC tool calls', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-mcp-config-'));
	const path = join(directory, 'config.json');
	const requestUrls: string[] = [];
	const server = createServer((request, response) => {
		requestUrls.push(request.url ?? '');
		const identities: Record<string, string> = {
			'Bearer fixture-first': 'first',
			'Bearer fixture-second': 'second'
		};
		const identity = identities[request.headers.authorization ?? ''];
		if (!identity) {
			response.writeHead(401, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: 'unauthorized' }));
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		if (request.url?.startsWith('/api/mail/thread-1')) {
			response.end(
				JSON.stringify({
					threadId: 'thread-1',
					subject: 'Subject',
					messages: [
						{
							id: 'message-1',
							from_addr: 'sender@example.test',
							subject: 'Subject',
							attachments: []
						}
					]
				})
			);
			return;
		}
		response.end(
			JSON.stringify({
				user: { id: identity, email: `${identity}@example.test`, name: identity, is_admin: false }
			})
		);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const url = `http://127.0.0.1:${address.port}`;
	const environment = { ...process.env, NOROSHI_CONFIG: path };
	delete environment.NOROSHI_URL;
	delete environment.NOROSHI_TOKEN;
	const child = spawn(process.execPath, ['cli/main.ts', 'mcp'], {
		cwd: new URL('..', import.meta.url),
		env: environment,
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const lines = createInterface({ input: child.stdout });
	const responses = new Map<number, (response: Record<string, unknown>) => void>();
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});
	lines.on('line', (line) => {
		const response = JSON.parse(line) as { id?: number };
		if (response.id !== undefined) responses.get(response.id)?.(response);
	});
	let nextId = 0;
	const rpc = (method: string, params: Record<string, unknown>) => {
		const id = ++nextId;
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`MCP response timed out: ${stderr}`)),
				5_000
			);
			responses.set(id, (response) => {
				clearTimeout(timeout);
				responses.delete(id);
				resolve(response);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	};
	try {
		await writeFile(path, JSON.stringify({ url, token: 'fixture-first' }), { mode: 0o600 });
		await rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1' }
		});
		const first = await rpc('tools/call', { name: 'whoami', arguments: {} });
		await writeFile(path, JSON.stringify({ url, token: 'fixture-second' }), { mode: 0o600 });
		const second = await rpc('tools/call', { name: 'whoami', arguments: {} });
		await rpc('tools/call', { name: 'get_thread', arguments: { id: 'thread-1' } });
		await rpc('tools/call', { name: 'list_attachments', arguments: { id: 'thread-1' } });
		const identity = (response: Record<string, unknown>) => {
			const result = response.result as { content: { text: string }[] };
			return JSON.parse(result.content[0].text).email;
		};
		assert.equal(identity(first), 'first@example.test');
		assert.equal(identity(second), 'second@example.test');
		assert.deepEqual(
			requestUrls.filter((requestUrl) => requestUrl.startsWith('/api/mail/thread-1')),
			['/api/mail/thread-1?markRead=false', '/api/mail/thread-1?markRead=false']
		);
	} finally {
		child.stdin.end();
		if (child.exitCode === null) await once(child, 'exit');
		lines.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await rm(directory, { recursive: true, force: true });
	}
});
