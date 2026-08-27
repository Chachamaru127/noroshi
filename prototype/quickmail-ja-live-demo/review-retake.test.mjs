import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
const qa = fs.readFileSync(path.join(directory, 'qa.mjs'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

assert.match(html, /class="demo-profile-switcher"[^>]*role="group"/u);
assert.match(html, /data-action="offline-toggle"/u);
assert.match(qa, /seriousIncomplete/u);
assert.match(qa, /activeStar/u);
assert.match(qa, /baseline-staging/u);
assert.match(qa, /incompleteMeasurements/u);
assert.doesNotMatch(qa, /allowedTargetFragments/u);
assert.match(qa, /cleanupBaselineStaging/u);
assert.ok(fs.existsSync(path.join(directory, 'release-gates.mjs')));
assert.ok(fs.existsSync(path.join(directory, 'release-workflow-security.test.mjs')));
assert.ok(fs.existsSync(path.join(directory, 'voiceover-review-receipt.schema.json')));
assert.match(release, /^permissions:\n  contents: read$/mu);
assert.match(release, /persist-credentials: false/u);
assert.match(release, /node prototype\/quickmail-ja-live-demo\/release-gates\.mjs/u);
assert.match(release, /commit_sha: \$\{\{ steps\.version\.outputs\.commit_sha \}\}/u);
assert.ok(
	(release.match(/ref: \$\{\{ needs\.preflight\.outputs\.commit_sha \}\}/gu) || []).length >= 2,
	'QA and package checkouts must use the immutable commit SHA'
);
assert.doesNotMatch(release, /release-tag-guard\.sh/u);
assert.match(release, /keys == \["archiveSha256", "commitSha", "tag", "version"\]/u);
assert.match(release, /ACTUAL_ARCHIVE_SHA/u);
assert.match(release, /EXPECTED_SHA: \$\{\{ needs\.preflight\.outputs\.commit_sha \}\}/u);
assert.doesNotMatch(release, /uses:\s+[^\s]+@(v\d+|main|master)/u);

const rejectedRoot = path.join(root, `.qmj12c-rejected-${process.pid}`);
const rejected = spawnSync('node', [path.join(directory, 'qa.mjs')], {
	cwd: root,
	encoding: 'utf8',
	env: { ...process.env, QMJ12C_ARTIFACT_DIR: rejectedRoot }
});
assert.notEqual(rejected.status, 0, 'an artifact override outside the OS temp directory must fail');
assert.equal(
	fs.existsSync(rejectedRoot),
	false,
	'a rejected artifact override must not be created'
);
assert.match(`${rejected.stdout}\n${rejected.stderr}`, /QMJ12C_ARTIFACT_DIR/u);

console.log('QMJ-12C review retake source contract: PASS');
