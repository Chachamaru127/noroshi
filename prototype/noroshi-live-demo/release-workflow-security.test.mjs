import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const publishSection = workflow.slice(workflow.indexOf('  publish:'));
assert.doesNotMatch(publishSection, /actions\/checkout/u);
assert.doesNotMatch(publishSection, /release-tag-guard|\b(?:bash|bun|node|source|eval)\b/u);

const lines = workflow.split('\n');
const publishName = lines.findIndex((line) => line.trim() === '- name: Publish release');
const runLine = lines.findIndex((line, index) => index > publishName && line.trim() === 'run: |');
assert.ok(publishName >= 0 && runLine > publishName);
const scriptLines = [];
for (let index = runLine + 1; index < lines.length; index += 1) {
	const line = lines[index];
	if (line && !line.startsWith('          ')) break;
	scriptLines.push(line.startsWith('          ') ? line.slice(10) : '');
}
const publishScript = `${scriptLines.join('\n')}\n`;
assert.match(publishScript, /jq -e/u);
assert.match(publishScript, /sha256sum/u);
assert.match(publishScript, /gh api/u);
assert.match(publishScript, /gh release create/u);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qmj-release-workflow-'));
const fakeBin = path.join(sandbox, 'bin');
fs.mkdirSync(fakeBin);
const fakeGh = path.join(fakeBin, 'gh');
const fakeSha = path.join(fakeBin, 'sha256sum');
fs.writeFileSync(
	fakeGh,
	`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == api ]]; then
  printf '{"object":{"type":"commit","sha":"%s"}}' "$REMOTE_SHA"
elif [[ "$1" == release && "$2" == create ]]; then
  touch "$PUBLISH_MARKER"
else
  exit 98
fi
`
);
fs.writeFileSync(fakeSha, '#!/usr/bin/env bash\nprintf "%s  %s\\n" "$ACTUAL_ARCHIVE_SHA" "$1"\n');
fs.chmodSync(fakeGh, 0o755);
fs.chmodSync(fakeSha, 0o755);

const tag = 'v1.2.3';
const version = '1.2.3';
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const archiveSha = crypto.createHash('sha256').update('verified archive').digest('hex');

function run(name, { remoteSha = commitA, evidence = {} } = {}) {
	const working = path.join(sandbox, name);
	fs.mkdirSync(working);
	const marker = path.join(working, 'published');
	fs.writeFileSync(path.join(working, `noroshi-${version}.zip`), 'verified archive');
	fs.writeFileSync(
		path.join(working, 'release-evidence.json'),
		JSON.stringify({ tag, version, commitSha: commitA, archiveSha256: archiveSha, ...evidence })
	);
	const result = spawnSync('bash', ['-c', publishScript], {
		cwd: working,
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			TAG: tag,
			VERSION: version,
			EXPECTED_SHA: commitA,
			REMOTE_SHA: remoteSha,
			ACTUAL_ARCHIVE_SHA: archiveSha,
			PUBLISH_MARKER: marker,
			GITHUB_REPOSITORY: 'owner/repo'
		}
	});
	return { result, published: fs.existsSync(marker) };
}

try {
	const valid = run('valid');
	assert.equal(valid.result.status, 0, valid.result.stderr);
	assert.equal(valid.published, true);
	const moved = run('moved', { remoteSha: commitB });
	assert.notEqual(moved.result.status, 0);
	assert.equal(moved.published, false, 'a moved tag must fail before release creation');
	const tampered = run('tampered', { evidence: { archiveSha256: '0'.repeat(64) } });
	assert.notEqual(tampered.result.status, 0);
	assert.equal(tampered.published, false, 'a mismatched archive must fail before release creation');
	const extraKey = run('extra-key', { evidence: { executable: 'artifact-script.sh' } });
	assert.notEqual(extraKey.result.status, 0);
	assert.equal(extraKey.published, false, 'unexpected evidence keys must fail closed');
} finally {
	fs.rmSync(sandbox, { recursive: true });
}

console.log('Noroshi trusted release workflow boundary: PASS');
