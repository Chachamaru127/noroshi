import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const AGENT_PLUGIN_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_MCP_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const OFFICIAL_SCHEMA_FILES = Object.freeze({
	plugin: Object.freeze({
		uri: AGENT_PLUGIN_SCHEMA_URI,
		path: new URL('../docs/setup/vendor/agent-plugins/1.0.0/plugin.schema.json', import.meta.url),
		sha256: '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883'
	}),
	mcp: Object.freeze({
		uri: AGENT_MCP_SCHEMA_URI,
		path: new URL('../docs/setup/vendor/agent-plugins/1.0.0/mcp.schema.json', import.meta.url),
		sha256: '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb'
	})
});

export const OFFICIAL_SCHEMA_PROVENANCE = Object.freeze({
	version: 'Agent Plugins 1.0.0',
	observed_at: '2026-08-29',
	license: 'Apache-2.0',
	plugin: Object.freeze({
		uri: AGENT_PLUGIN_SCHEMA_URI,
		sha256: OFFICIAL_SCHEMA_FILES.plugin.sha256
	}),
	mcp: Object.freeze({
		uri: AGENT_MCP_SCHEMA_URI,
		sha256: OFFICIAL_SCHEMA_FILES.mcp.sha256
	})
});

export function verifyOfficialSchemaBytes(bytes, entry) {
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (actual !== entry.sha256) {
		throw new Error(`official Agent Plugins schema checksum mismatch: ${entry.uri}`);
	}
	return actual;
}

function loadOfficialSchema(entry) {
	const bytes = readFileSync(entry.path);
	verifyOfficialSchemaBytes(bytes, entry);
	return JSON.parse(bytes.toString('utf8'));
}

// These values are loaded from the committed bytes above. The loader never
// retrieves a schema while a plugin is loading.
export const AGENT_PLUGIN_SCHEMA = loadOfficialSchema(OFFICIAL_SCHEMA_FILES.plugin);
export const AGENT_MCP_SCHEMA = loadOfficialSchema(OFFICIAL_SCHEMA_FILES.mcp);
