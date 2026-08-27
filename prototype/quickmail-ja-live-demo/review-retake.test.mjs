import assert from 'node:assert/strict';
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
assert.ok(fs.existsSync(path.join(directory, 'release-gates.mjs')));
assert.ok(fs.existsSync(path.join(directory, 'voiceover-review-receipt.schema.json')));
assert.match(release, /^permissions:\n  contents: read$/mu);
assert.match(release, /persist-credentials: false/u);
assert.match(release, /node prototype\/quickmail-ja-live-demo\/release-gates\.mjs/u);
assert.doesNotMatch(release, /uses:\s+[^\s]+@(v\d+|main|master)/u);

console.log('QMJ-12C review retake source contract: PASS');
