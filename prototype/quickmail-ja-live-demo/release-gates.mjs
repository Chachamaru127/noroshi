import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, '../..');
const baselineDirectory = path.join(directory, 'baselines', 'playwright-1.59.1-noble');
const approvalsDirectory = path.join(directory, 'approvals');
const baselineVersion = 'playwright-1.59.1-noble-linux-amd64';
const imageDigest = 'sha256:eac9b0a5312cdab40ee8c2429df5bf19bffdccf8f3bf3c42268e173f97541645';
const containerImage = `mcr.microsoft.com/playwright@${imageDigest}`;
const profiles = ['calm', 'command', 'classic'];
const themes = ['light', 'dark'];
const viewports = ['desktop', 'tablet', 'mobile'];

function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function exactKeys(value, required, optional = []) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value));
	const keys = Object.keys(value);
	for (const key of required) assert.ok(keys.includes(key), `missing required field: ${key}`);
	assert.deepEqual(
		keys.filter((key) => !required.includes(key) && !optional.includes(key)),
		[],
		'unknown receipt fields are not allowed'
	);
}

function nonEmpty(value, label) {
	assert.equal(typeof value, 'string', `${label} must be a string`);
	assert.ok(value.trim().length > 0, `${label} must not be empty`);
}

function reviewedCommit(value) {
	assert.match(value, /^[0-9a-f]{40}$/u, 'reviewedCommit must be a full Git commit');
}

function reviewedAt(value) {
	assert.ok(Number.isFinite(Date.parse(value)), 'reviewedAt must be an ISO date-time');
	assert.ok(Date.parse(value) <= Date.now(), 'reviewedAt must not be in the future');
}

function assertGitReviewBoundary(commit, paths) {
	execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
		cwd: repoRoot,
		stdio: 'ignore'
	});
	execFileSync('git', ['diff', '--quiet', `${commit}..HEAD`, '--', ...paths], {
		cwd: repoRoot,
		stdio: 'ignore'
	});
}

function assertReviewNotBeforeCommit(commit, reviewDate) {
	const commitTime = Number(
		execFileSync('git', ['show', '-s', '--format=%ct', commit], {
			cwd: repoRoot,
			encoding: 'utf8'
		}).trim()
	);
	assert.ok(Number.isFinite(commitTime), 'reviewedCommit must have a valid committer time');
	assert.ok(
		Date.parse(reviewDate) >= commitTime * 1000,
		'reviewedAt must not predate reviewedCommit'
	);
}

export function expectedBaselineScreenshots() {
	return profiles
		.flatMap((profile) =>
			themes.flatMap((theme) => viewports.map((viewport) => `${profile}-${theme}-${viewport}.png`))
		)
		.sort();
}

export function validateBaselineReceipt(receipt, { checkGit = true } = {}) {
	exactKeys(
		receipt,
		[
			'reviewedCommit',
			'baselineVersion',
			'containerImage',
			'imageDigest',
			'reviewedAt',
			'reviewer',
			'decision',
			'screenshots'
		],
		['notes']
	);
	reviewedCommit(receipt.reviewedCommit);
	assert.equal(receipt.baselineVersion, baselineVersion);
	assert.equal(receipt.containerImage, containerImage);
	assert.equal(receipt.imageDigest, imageDigest);
	reviewedAt(receipt.reviewedAt);
	assertReviewNotBeforeCommit(receipt.reviewedCommit, receipt.reviewedAt);
	nonEmpty(receipt.reviewer, 'reviewer');
	assert.equal(receipt.decision, 'APPROVE');
	assert.ok(Array.isArray(receipt.screenshots));
	assert.equal(receipt.screenshots.length, 18);
	const actualNames = receipt.screenshots.map((item) => item.file).sort();
	assert.deepEqual(
		actualNames,
		expectedBaselineScreenshots(),
		'receipt must name each baseline once'
	);
	for (const item of receipt.screenshots) {
		exactKeys(item, ['file', 'sha256']);
		assert.match(item.sha256, /^[0-9a-f]{64}$/u);
		assert.equal(
			item.sha256,
			sha256(path.join(baselineDirectory, item.file)),
			`${item.file} hash must match the committed baseline`
		);
	}
	if (checkGit) {
		assertGitReviewBoundary(receipt.reviewedCommit, [
			'prototype/quickmail-ja-live-demo/index.html',
			'prototype/quickmail-ja-live-demo/baselines'
		]);
	}
	return true;
}

export function validateVoiceOverReceipt(receipt, { checkGit = true } = {}) {
	exactKeys(receipt, [
		'reviewedCommit',
		'contentSha256',
		'checklistSha256',
		'reviewedAt',
		'reviewer',
		'decision',
		'environment',
		'profiles'
	]);
	reviewedCommit(receipt.reviewedCommit);
	assert.equal(receipt.contentSha256, sha256(path.join(directory, 'index.html')));
	assert.equal(receipt.checklistSha256, sha256(path.join(directory, 'VOICEOVER-CHECKLIST.md')));
	reviewedAt(receipt.reviewedAt);
	assertReviewNotBeforeCommit(receipt.reviewedCommit, receipt.reviewedAt);
	nonEmpty(receipt.reviewer, 'reviewer');
	assert.equal(receipt.decision, 'APPROVE');
	exactKeys(receipt.environment, ['macosVersion', 'safariVersion', 'voiceOverVersion']);
	for (const [key, value] of Object.entries(receipt.environment)) nonEmpty(value, key);
	assert.ok(Array.isArray(receipt.profiles));
	assert.equal(receipt.profiles.length, 3);
	assert.deepEqual(
		receipt.profiles.map((item) => item.profile).sort(),
		[...profiles].sort(),
		'VoiceOver receipt must include each profile once'
	);
	for (const item of receipt.profiles) {
		exactKeys(item, ['profile', 'status', 'heardText', 'notes']);
		assert.ok(profiles.includes(item.profile));
		assert.equal(item.status, 'PASS');
		nonEmpty(item.heardText, `${item.profile}.heardText`);
		assert.equal(typeof item.notes, 'string');
	}
	if (checkGit) {
		assertGitReviewBoundary(receipt.reviewedCommit, [
			'prototype/quickmail-ja-live-demo/index.html',
			'prototype/quickmail-ja-live-demo/VOICEOVER-CHECKLIST.md'
		]);
	}
	return true;
}

function readCommittedReceipt(file) {
	const resolved = path.resolve(file);
	assert.equal(
		path.dirname(resolved),
		approvalsDirectory,
		'approval receipt must be in approvals/'
	);
	assert.ok(fs.existsSync(resolved), `required human approval receipt is missing: ${resolved}`);
	const stat = fs.lstatSync(resolved);
	assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${resolved} must be a regular file`);
	const relative = path.relative(repoRoot, resolved);
	execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], {
		cwd: repoRoot,
		stdio: 'ignore'
	});
	execFileSync('git', ['diff', '--quiet', 'HEAD', '--', relative], {
		cwd: repoRoot,
		stdio: 'ignore'
	});
	return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const baselinePath =
		process.argv[2] || path.join(approvalsDirectory, 'baseline-review-receipt.json');
	const voiceOverPath =
		process.argv[3] || path.join(approvalsDirectory, 'voiceover-review-receipt.json');
	validateBaselineReceipt(readCommittedReceipt(baselinePath));
	validateVoiceOverReceipt(readCommittedReceipt(voiceOverPath));
	console.log('Noroshi human release gates: APPROVE');
}
