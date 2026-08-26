import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const parse = (path) => JSON.parse(read(path));

const sources = () => parse('support/knowledge/sources.json');
const patterns = () => parse('support/knowledge/patterns.json');

function compileKnowledgeSchemas() {
	const ajv = new Ajv2020({ allErrors: true, strict: true });
	addFormats(ajv);
	return {
		validateSources: ajv.compile(parse('support/knowledge/source-registry.schema.json')),
		validatePatterns: ajv.compile(parse('support/knowledge/support-patterns.schema.json'))
	};
}

function assertSchemaValid(validate, document) {
	assert.equal(validate(document), true, JSON.stringify(validate.errors, null, 2));
}

function assertSchemaInvalid(validate, document, expectedKeyword) {
	assert.equal(validate(document), false, 'negative fixture unexpectedly passed schema validation');
	assert.ok(
		validate.errors?.some(({ keyword }) => keyword === expectedKeyword),
		`expected ${expectedKeyword}: ${JSON.stringify(validate.errors, null, 2)}`
	);
}

function daysBetween(start, end) {
	return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

function walk(value, visit, path = '$') {
	visit(value, path);
	if (Array.isArray(value)) {
		value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
	} else if (value && typeof value === 'object') {
		Object.entries(value).forEach(([key, item]) => walk(item, visit, `${path}.${key}`));
	}
}

test('source registry maps the 24 researched products and configurations one-to-one', () => {
	const research = read('docs/research/japan-market-competition-2026-08-27.md');
	const researched = [
		...research.matchAll(/^\| \[([^\]]+)\]\((https:\/\/[^)]+)\)\s+\|\s*([^|]+?)\s*\|/gm)
	].map(([, name, canonicalUrl, category]) => ({ name, canonicalUrl, category: category.trim() }));
	const registry = sources();

	assert.equal(researched.length, 24);
	assert.equal(registry.entries.length, researched.length);
	assert.deepEqual(
		registry.entries.map(({ name, canonical_url: canonicalUrl, category }) => ({
			name,
			canonicalUrl,
			category
		})),
		researched
	);
	assert.equal(new Set(registry.entries.map(({ id }) => id)).size, 24);
});

test('domestic managed alternatives use the verified primary setup and FAQ sources', () => {
	const byId = new Map(sources().entries.map((entry) => [entry.id, entry]));
	assert.deepEqual(byId.get('sakura-mailbox')?.setup, {
		status: 'found',
		url: 'https://help.sakura.ad.jp/flow-mail-address/',
		source_type: 'primary'
	});
	assert.deepEqual(byId.get('sakura-mailbox')?.faq, {
		status: 'found',
		url: 'https://help.sakura.ad.jp/mail/',
		source_type: 'primary'
	});
	assert.deepEqual(byId.get('onamae-mail')?.setup, {
		status: 'found',
		url: 'https://help.onamae.com/answer/20327',
		source_type: 'primary',
		related_urls: ['https://help.onamae.com/answer/15480']
	});
	assert.deepEqual(byId.get('onamae-mail')?.faq, {
		status: 'found',
		url: 'https://help.onamae.com/answer/20538',
		source_type: 'primary'
	});
});

test('every source is primary, dated and explicit about setup and FAQ discovery', () => {
	const registry = sources();
	for (const entry of [...registry.entries, ...registry.authoritative_provider_sources]) {
		assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		assert.match(entry.canonical_url, /^https:\/\//);
		assert.match(entry.verified_at, /^\d{4}-\d{2}-\d{2}$/);
		assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(Date.parse(entry.review_by) >= Date.parse(entry.verified_at));
		assert.ok(['high', 'medium', 'low'].includes(entry.confidence));

		for (const kind of ['setup', 'faq']) {
			const discovery = entry[kind];
			assert.ok(discovery, `${entry.id}.${kind} is missing`);
			assert.ok(['found', 'not_found', 'not_applicable'].includes(discovery.status));
			if (discovery.status === 'found') {
				assert.match(discovery.url, /^https:\/\//);
				assert.equal(discovery.source_type, 'primary');
			} else {
				assert.match(discovery.searched_at, /^\d{4}-\d{2}-\d{2}$/);
				assert.ok(discovery.note.length > 0);
			}
		}
	}

	for (const source of registry.authoritative_provider_sources) {
		assert.ok(daysBetween(source.verified_at, source.review_by) <= 31);
		assert.equal(source.confidence, 'high');
	}
});

test('support patterns have the complete safety and recovery contract', () => {
	const registry = sources();
	const knowledge = patterns();
	const sourceIds = new Set([
		...registry.entries.map(({ id }) => id),
		...registry.authoritative_provider_sources.map(({ id }) => id)
	]);
	const providerIds = new Set(registry.authoritative_provider_sources.map(({ id }) => id));

	assert.ok(knowledge.patterns.length >= 10 && knowledge.patterns.length <= 15);
	assert.equal(new Set(knowledge.patterns.map(({ id }) => id)).size, knowledge.patterns.length);

	const requiredArrays = [
		'applicability',
		'diagnostic_questions',
		'safe_steps',
		'human_only',
		'prohibited',
		'rollback',
		'expected_evidence',
		'unsupported',
		'source_refs'
	];
	for (const pattern of knowledge.patterns) {
		assert.match(pattern.id, /^[a-z0-9]+(?:\.[a-z0-9]+)*$/);
		assert.ok(pattern.title_ja.length > 0);
		assert.ok(pattern.category.length > 0);
		assert.ok(pattern.stage.length > 0);
		for (const field of requiredArrays) {
			assert.ok(
				Array.isArray(pattern[field]) && pattern[field].length > 0,
				`${pattern.id}.${field}`
			);
		}
		assert.deepEqual(Object.keys(pattern.risk_gate).sort(), [
			'approval_required',
			'class',
			'trigger'
		]);
		assert.equal(typeof pattern.risk_gate.approval_required, 'boolean');
		assert.match(pattern.verified_at, /^\d{4}-\d{2}-\d{2}$/);
		assert.match(pattern.review_by, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(['high', 'medium', 'low'].includes(pattern.confidence));
		for (const ref of pattern.source_refs) assert.ok(sourceIds.has(ref), `${pattern.id}: ${ref}`);

		if (['cloudflare', 'dns', 'resend', 'storage', 'deployment'].includes(pattern.category)) {
			assert.ok(
				pattern.source_refs.some((ref) => providerIds.has(ref)),
				`${pattern.id} needs a current provider source`
			);
		}
	}
});

test('schemas require provenance, applicability, safety and evidence fields', () => {
	const sourceSchema = parse('support/knowledge/source-registry.schema.json');
	const patternSchema = parse('support/knowledge/support-patterns.schema.json');
	const sourceRequired = sourceSchema.$defs.source.required;
	const patternRequired = patternSchema.$defs.pattern.required;

	for (const field of [
		'id',
		'name',
		'category',
		'canonical_url',
		'setup',
		'faq',
		'verified_at',
		'review_by',
		'confidence'
	]) {
		assert.ok(sourceRequired.includes(field), `source schema must require ${field}`);
	}
	for (const field of [
		'applicability',
		'diagnostic_questions',
		'safe_steps',
		'human_only',
		'prohibited',
		'risk_gate',
		'rollback',
		'expected_evidence',
		'unsupported',
		'source_refs',
		'verified_at',
		'review_by',
		'confidence'
	]) {
		assert.ok(patternRequired.includes(field), `pattern schema must require ${field}`);
	}
});

test('Draft 2020-12 schemas validate the actual source and support pattern documents', () => {
	const { validateSources, validatePatterns } = compileKnowledgeSchemas();
	assertSchemaValid(validateSources, sources());
	assertSchemaValid(validatePatterns, patterns());
});

test('Draft 2020-12 schema validators are direct exact development dependencies', () => {
	const devDependencies = parse('package.json').devDependencies;
	assert.equal(devDependencies.ajv, '8.20.0');
	assert.equal(devDependencies['ajv-formats'], '3.0.1');
});

test('Draft 2020-12 schemas reject additional properties, wrong enums and invalid dates', () => {
	const { validateSources, validatePatterns } = compileKnowledgeSchemas();

	const additionalProperty = structuredClone(sources());
	additionalProperty.entries[0].unreviewed_hint = true;
	assertSchemaInvalid(validateSources, additionalProperty, 'additionalProperties');

	const wrongEnum = structuredClone(patterns());
	wrongEnum.patterns[0].category = 'unknown';
	assertSchemaInvalid(validatePatterns, wrongEnum, 'enum');

	const invalidDate = structuredClone(patterns());
	invalidDate.patterns[0].verified_at = '2026-02-30';
	assertSchemaInvalid(validatePatterns, invalidDate, 'format');
});

test('knowledge files contain no raw source body, HTML, secrets, customer values or local paths', () => {
	const documents = [sources(), patterns()];
	const forbiddenKeys = new Set([
		'body',
		'content',
		'excerpt',
		'html',
		'raw',
		'quote',
		'screenshot'
	]);
	const customerMarkers = [
		['japan', 'cannabinoid'].join('-'),
		[['can', 'ai'].join(''), 'jp'].join('.'),
		['CAN', 'AI'].join(' ')
	];
	for (const document of documents) {
		walk(document, (value, path) => {
			const key = path
				.split('.')
				.at(-1)
				?.replace(/\[\d+\]$/, '');
			assert.ok(!forbiddenKeys.has(key), `forbidden copied-source field at ${path}`);
			if (typeof value !== 'string') return;
			assert.doesNotMatch(value, /<\/?[a-z][^>]*>/i);
			assert.doesNotMatch(value, /(?:\/Users\/|[A-Za-z]:\\\\)/);
			assert.doesNotMatch(value, /re_[A-Za-z0-9_-]{16,}/);
			for (const marker of customerMarkers) {
				assert.ok(!value.toLowerCase().includes(marker.toLowerCase()));
			}
		});
	}
});
