import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(directory, 'release-tag-guard.sh');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qmj-tag-guard-'));
const fakeBin = path.join(sandbox, 'bin');
fs.mkdirSync(fakeBin);
const marker = path.join(sandbox, 'release-called');
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const tagObject = 'c'.repeat(40);
const fakeGh = path.join(fakeBin, 'gh');
fs.writeFileSync(
	fakeGh,
	`#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || { touch "$MARKER"; exit 97; }
case "$2" in
  */git/ref/tags/v1.2.3)
    if [[ "\${ANNOTATED:-0}" == 1 ]]; then
      printf '{"object":{"type":"tag","sha":"${tagObject}"}}'
    else
      printf '{"object":{"type":"commit","sha":"%s"}}' "$REMOTE_SHA"
    fi ;;
  */git/tags/${tagObject})
    printf '{"object":{"type":"commit","sha":"%s"}}' "$REMOTE_SHA" ;;
  *) exit 98 ;;
esac
`
);
fs.chmodSync(fakeGh, 0o755);

function run(remoteSha, extra = {}) {
	return spawnSync('bash', [guard, 'v1.2.3', commitA], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			GITHUB_REPOSITORY: 'owner/repo',
			REMOTE_SHA: remoteSha,
			MARKER: marker,
			...extra
		}
	});
}

try {
	const direct = run(commitA);
	assert.equal(direct.status, 0, direct.stderr);
	assert.equal(direct.stdout.trim(), commitA);
	const annotated = run(commitA, { ANNOTATED: '1' });
	assert.equal(annotated.status, 0, annotated.stderr);
	const moved = run(commitB);
	assert.notEqual(moved.status, 0);
	assert.match(moved.stderr, /Release tag moved/u);
	assert.equal(fs.existsSync(marker), false, 'guard mismatch must never invoke a release command');
} finally {
	fs.rmSync(sandbox, { recursive: true });
}

console.log('QuickMail-ja release tag immutability guard: PASS');
