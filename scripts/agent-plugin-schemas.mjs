export const AGENT_PLUGIN_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_MCP_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

// Vendored copies of the published 1.0.0 machine schemas. The URLs and the
// retrieval date are recorded in docs/setup/qmj11b-plugin.md; validation does
// not fetch a schema while a plugin is loading.
export const AGENT_PLUGIN_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: AGENT_PLUGIN_SCHEMA_URI,
	type: 'object',
	properties: {
		$schema: { const: AGENT_PLUGIN_SCHEMA_URI },
		name: {
			type: 'string',
			minLength: 1,
			maxLength: 64,
			pattern: '^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
		},
		version: { type: 'string' },
		description: { type: 'string' },
		author: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				email: { type: 'string' },
				url: { type: 'string' }
			},
			additionalProperties: false
		},
		homepage: { type: 'string' },
		repository: { type: 'string' },
		license: { type: 'string' },
		keywords: { type: 'array', items: { type: 'string' } },
		extensions: {
			type: 'object',
			additionalProperties: { type: 'object' }
		}
	},
	required: ['$schema', 'name'],
	additionalProperties: false
};

const headers = {
	type: 'object',
	additionalProperties: { type: 'string' }
};

const stdioServer = {
	type: 'object',
	properties: {
		type: { const: 'stdio' },
		command: { type: 'string', minLength: 1 },
		args: { type: 'array', items: { type: 'string' } },
		env: {
			type: 'object',
			propertyNames: { not: { enum: ['PLUGIN_ROOT', 'PLUGIN_DATA'] } },
			additionalProperties: { type: 'string' }
		},
		cwd: {
			type: 'string',
			pattern: '^(?:\\./|\\$\\{PLUGIN_ROOT\\}(?:/|$)|\\$\\{PLUGIN_DATA\\}(?:/|$))'
		}
	},
	required: ['type', 'command'],
	additionalProperties: false
};

const streamableHttpServer = {
	type: 'object',
	properties: {
		type: { const: 'streamable-http' },
		url: { type: 'string', minLength: 1 },
		headers
	},
	required: ['type', 'url'],
	additionalProperties: false
};

const sseServer = {
	type: 'object',
	properties: {
		type: { const: 'sse' },
		url: { type: 'string', minLength: 1 },
		headers
	},
	required: ['type', 'url'],
	additionalProperties: false
};

export const AGENT_MCP_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: AGENT_MCP_SCHEMA_URI,
	type: 'object',
	properties: {
		$schema: { const: AGENT_MCP_SCHEMA_URI },
		mcpServers: {
			type: 'object',
			additionalProperties: {
				oneOf: [stdioServer, streamableHttpServer, sseServer]
			}
		}
	},
	required: ['$schema', 'mcpServers'],
	additionalProperties: false
};
