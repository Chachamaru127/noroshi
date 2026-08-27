import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
	expectedBaselineScreenshots,
	validateBaselineReceipt,
	validateVoiceOverReceipt
} from './release-gates.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const baselineDirectory = path.join(directory, 'baselines', 'playwright-1.59.1-noble');
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateBaselineSchema = ajv.compile(
	JSON.parse(fs.readFileSync(path.join(directory, 'baseline-review-receipt.schema.json'), 'utf8'))
);
const validateVoiceOverSchema = ajv.compile(
	JSON.parse(fs.readFileSync(path.join(directory, 'voiceover-review-receipt.schema.json'), 'utf8'))
);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commit = 'a'.repeat(40);
const reviewedAt = '2026-08-27T00:00:00.000Z';
const baseline = {
	reviewedCommit: commit,
	baselineVersion: 'playwright-1.59.1-noble-linux-amd64',
	containerImage:
		'mcr.microsoft.com/playwright@sha256:eac9b0a5312cdab40ee8c2429df5bf19bffdccf8f3bf3c42268e173f97541645',
	imageDigest: 'sha256:eac9b0a5312cdab40ee8c2429df5bf19bffdccf8f3bf3c42268e173f97541645',
	reviewedAt,
	reviewer: '人による確認者',
	decision: 'APPROVE',
	screenshots: expectedBaselineScreenshots().map((file) => ({
		file,
		sha256: sha256(path.join(baselineDirectory, file))
	}))
};
assert.equal(validateBaselineSchema(baseline), true, JSON.stringify(validateBaselineSchema.errors));
assert.equal(validateBaselineReceipt(baseline, { checkGit: false }), true);
assert.equal(validateBaselineSchema({ ...baseline, decision: 'PENDING_HUMAN_REVIEW' }), false);
assert.throws(() =>
	validateBaselineReceipt({ ...baseline, decision: 'PENDING_HUMAN_REVIEW' }, { checkGit: false })
);
assert.throws(() =>
	validateBaselineReceipt(
		{
			...baseline,
			screenshots: baseline.screenshots.map((item, index) =>
				index ? item : { ...item, sha256: '0'.repeat(64) }
			)
		},
		{ checkGit: false }
	)
);
assert.throws(() =>
	validateBaselineReceipt(
		{
			...baseline,
			screenshots: baseline.screenshots.map((item, index) =>
				index === 1 ? baseline.screenshots[0] : item
			)
		},
		{ checkGit: false }
	)
);

const voiceOver = {
	reviewedCommit: commit,
	contentSha256: sha256(path.join(directory, 'index.html')),
	checklistSha256: sha256(path.join(directory, 'VOICEOVER-CHECKLIST.md')),
	reviewedAt,
	reviewer: 'VoiceOver確認者',
	decision: 'APPROVE',
	environment: {
		macosVersion: 'macOS version',
		safariVersion: 'Safari version',
		voiceOverVersion: 'VoiceOver version'
	},
	profiles: ['calm', 'command', 'classic'].map((profile) => ({
		profile,
		status: 'PASS',
		heardText: '実際に聞こえた文言',
		notes: ''
	}))
};
assert.equal(
	validateVoiceOverSchema(voiceOver),
	true,
	JSON.stringify(validateVoiceOverSchema.errors)
);
assert.equal(validateVoiceOverReceipt(voiceOver, { checkGit: false }), true);
assert.equal(validateVoiceOverSchema({ ...voiceOver, decision: 'PENDING_HUMAN_REVIEW' }), false);
assert.throws(() =>
	validateVoiceOverReceipt({ ...voiceOver, decision: 'PENDING_HUMAN_REVIEW' }, { checkGit: false })
);
assert.throws(() =>
	validateVoiceOverReceipt(
		{ ...voiceOver, profiles: voiceOver.profiles.map((item) => ({ ...item, status: 'FAIL' })) },
		{ checkGit: false }
	)
);

console.log('QuickMail-ja release receipt validators: PASS');
