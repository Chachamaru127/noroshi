#!/usr/bin/env node
/**
 * QMJ-10 contract MCP for the portable setup plugin.
 *
 * This is intentionally dependency-free and provider-free. It implements the
 * MCP stdio envelope for local inspection/plan/approval/readback/verification
 * of non-secret snapshots. The apply operation is present so a host can show
 * the fixed contract, but it always fails closed until a separately reviewed
 * official-provider adapter is supplied outside this package.
 */
import {
	InMemoryApprovalLedger,
	SetupEngineError,
	createSetupEngine,
	verifyMutationReadback
} from './setup-engine.mjs';

const SERVER_NAME = 'noroshi-setup-engine';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const APPLY_BLOCKED_CODE = 'provider_adapter_unavailable';

const toolDefinitions = [
	{
		name: 'setup_inspect',
		description:
			'Inspect a user-provided non-secret setup snapshot locally. No Cloudflare, Resend, DNS, mailbox, or network call is made.',
		inputSchema: {
			type: 'object',
			properties: {
				target: { type: 'object', description: 'QMJ-10 target metadata.' },
				step: { type: 'object', description: 'Optional single QMJ-10 step.' },
				snapshot: { type: 'object', description: 'Non-secret provider state snapshot.' }
			},
			required: ['target', 'snapshot'],
			additionalProperties: false
		}
	},
	{
		name: 'setup_plan',
		description:
			'Create one immutable QMJ-10 setup plan from an inspection. This does not contact a provider or perform a write.',
		inputSchema: {
			type: 'object',
			properties: {
				inspection: { type: 'object' },
				target: { type: 'object' },
				step: { type: 'object' },
				desired_state: { type: 'object' },
				rollback: { type: 'object' },
				approval_id: { type: 'string' },
				expires_at: { type: 'string' },
				plan_id: { type: 'string' }
			},
			required: ['inspection', 'step', 'desired_state', 'rollback', 'approval_id', 'expires_at'],
			additionalProperties: false
		}
	},
	{
		name: 'setup_approve',
		description:
			'Record one in-memory approval for an already validated QMJ-10 plan. Approval never authorizes mailbox access or an unreviewed provider operation.',
		inputSchema: {
			type: 'object',
			properties: { plan: { type: 'object' } },
			required: ['plan'],
			additionalProperties: false
		}
	},
	{
		name: 'setup_apply',
		description:
			'Apply one QMJ-10 plan. This package has no provider adapter, so this operation always stops before any provider, DNS, deployment, secret, or email write.',
		inputSchema: {
			type: 'object',
			properties: {
				plan: { type: 'object' },
				approval_id: { type: 'string' }
			},
			required: ['plan'],
			additionalProperties: false
		}
	},
	{
		name: 'setup_readback',
		description:
			'Check a supplied non-secret readback state against a validated QMJ-10 plan before or after fingerprint. No provider call is made.',
		inputSchema: {
			type: 'object',
			properties: {
				plan: { type: 'object' },
				state: { type: 'object' },
				phase: { type: 'string', enum: ['before', 'after'] }
			},
			required: ['plan', 'state'],
			additionalProperties: false
		}
	},
	{
		name: 'setup_verify',
		description:
			'Verify a supplied non-secret readback state against a validated QMJ-10 plan. A mismatch stops without retrying or writing.',
		inputSchema: {
			type: 'object',
			properties: {
				plan: { type: 'object' },
				state: { type: 'object' },
				phase: { type: 'string', enum: ['before', 'after'] }
			},
			required: ['plan', 'state'],
			additionalProperties: false
		}
	}
];

const engine = createSetupEngine({ approvalLedger: new InMemoryApprovalLedger() });

const localSnapshotAdapter = {
	async inspect({ request }) {
		if (!request || typeof request !== 'object' || !request.state) {
			throw new SetupEngineError(
				'provider_read_failed',
				'a non-secret local snapshot is required; no provider was contacted'
			);
		}
		return { state: request.state, list_complete: true };
	},
	async applyStep() {
		throw new SetupEngineError(APPLY_BLOCKED_CODE, 'no provider adapter is installed');
	},
	async rollbackStep() {
		throw new SetupEngineError(APPLY_BLOCKED_CODE, 'no provider adapter is installed');
	}
};

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(value) {
	return {
		content: [{ type: 'text', text: JSON.stringify(value) }]
	};
}

function errorResult(code, message) {
	return {
		isError: true,
		content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }) }]
	};
}

function safeFailure(error) {
	if (error instanceof SetupEngineError) {
		return errorResult(error.code, error.message);
	}
	return errorResult(
		'setup_operation_failed',
		'The setup operation stopped safely. Inspect the non-secret input and try again.'
	);
}

async function callTool(name, args) {
	if (!isObject(args)) return errorResult('invalid_input', 'Tool arguments must be an object.');
	try {
		switch (name) {
			case 'setup_inspect':
				return result(
					await engine.inspect({
						adapter: localSnapshotAdapter,
						target: args.target,
						step: args.step,
						request: { state: args.snapshot }
					})
				);
			case 'setup_plan':
				return result(
					engine.plan({
						inspection: args.inspection,
						target: args.target,
						step: args.step,
						desiredState: args.desired_state,
						rollback: args.rollback,
						approvalId: args.approval_id,
						expiresAt: args.expires_at,
						planId: args.plan_id
					})
				);
			case 'setup_approve':
				return result(engine.approve(args.plan));
			case 'setup_apply':
				return errorResult(
					APPLY_BLOCKED_CODE,
					'No provider adapter is enabled in this plugin. The plan was not applied.'
				);
			case 'setup_readback':
			case 'setup_verify':
				return result(
					verifyMutationReadback(args.plan, args.state, {
						phase: args.phase ?? 'after'
					})
				);
			default:
				return errorResult(
					'unsupported_operation',
					'This operation is not part of the QMJ-10 setup contract.'
				);
		}
	} catch (error) {
		return safeFailure(error);
	}
}

function jsonRpcError(id, code, message) {
	return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMessage(message) {
	if (!isObject(message) || message.jsonrpc !== '2.0') {
		return jsonRpcError(null, -32600, 'Invalid JSON-RPC request.');
	}
	if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
		return null;
	}
	switch (message.method) {
		case 'initialize':
			return {
				jsonrpc: '2.0',
				id: message.id ?? null,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
				}
			};
		case 'ping':
			return { jsonrpc: '2.0', id: message.id ?? null, result: {} };
		case 'tools/list':
			return { jsonrpc: '2.0', id: message.id ?? null, result: { tools: toolDefinitions } };
		case 'tools/call': {
			const params = message.params;
			if (!isObject(params) || typeof params.name !== 'string') {
				return jsonRpcError(message.id, -32602, 'Tool name is required.');
			}
			const toolResult = await callTool(params.name, params.arguments ?? {});
			return { jsonrpc: '2.0', id: message.id ?? null, result: toolResult };
		}
		default:
			return jsonRpcError(message.id, -32601, 'Method not found.');
	}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	while (true) {
		const newline = buffer.indexOf('\n');
		if (newline < 0) break;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Invalid JSON.'))}\n`);
			continue;
		}
		void handleMessage(message).then((response) => {
			if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
		});
	}
});

process.stdin.on('error', () => {
	process.exitCode = 1;
});
