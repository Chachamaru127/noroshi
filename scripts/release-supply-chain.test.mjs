import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	findExternalFontReferences,
	findUnsafeInstallReferences,
	generateEvidence,
	verifyEvidence
} from './release-supply-chain.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const gitArchive = (repository, archive, tag, commit) =>
	execFileSync(
		'git',
		[
			'archive',
			'--format=zip',
			`--prefix=quickmail-ja-${tag.slice(1)}/`,
			`--output=${archive}`,
			commit
		],
		{ cwd: repository }
	);

test('release and setup paths use reviewed immutable tools without pipe installers', () => {
	for (const path of [
		'.github/workflows/ci.yml',
		'.github/workflows/release.yml',
		'scripts/setup.sh'
	]) {
		const contents = read(path);
		assert.doesNotMatch(contents, /bun-version:\s*latest|@latest|curl[^\n|]*\|\s*(?:ba)?sh/u, path);
	}
	assert.match(read('.github/workflows/ci.yml'), /bun-version: 1\.3\.14/u);
	assert.match(read('scripts/setup.sh'), /bun install --frozen-lockfile/u);
});

test('release workflow generates and uploads checksums, SBOM, and provenance', () => {
	const workflow = read('.github/workflows/release.yml');
	assert.match(workflow, /release-supply-chain\.mjs generate/u);
	assert.match(workflow, /release-supply-chain\.mjs verify/u);
	assert.match(workflow, /sha256sum --check SHA256SUMS/u);
	for (const artifact of ['SHA256SUMS', 'quickmail-ja.spdx.json', 'release-provenance.json']) {
		assert.match(workflow, new RegExp(artifact.replace('.', '\\.'), 'u'));
	}
});

test('evidence is deterministic and rejects tampering', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-evidence-'));
	const second = mkdtempSync(join(tmpdir(), 'quickmail-ja-evidence-'));
	const archive = join(temporary, 'quickmail-ja-1.0.0.zip');
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	try {
		gitArchive(root, archive, 'v1.0.0', commit);
		generateEvidence({ repository: root, archive, tag: 'v1.0.0', commit, output: temporary });
		const secondArchive = join(second, 'quickmail-ja-1.0.0.zip');
		gitArchive(root, secondArchive, 'v1.0.0', commit);
		generateEvidence({
			repository: root,
			archive: secondArchive,
			tag: 'v1.0.0',
			commit,
			output: second
		});
		for (const name of [
			'SHA256SUMS',
			'quickmail-ja.spdx.json',
			'release-provenance.json',
			'release-evidence.json'
		]) {
			assert.equal(
				readFileSync(join(temporary, name), 'utf8'),
				readFileSync(join(second, name), 'utf8')
			);
		}
		verifyEvidence({ repository: root, archive, output: temporary, tag: 'v1.0.0', commit });
		const provenancePath = join(temporary, 'release-provenance.json');
		const originalProvenance = readFileSync(provenancePath, 'utf8');
		const provenance = JSON.parse(originalProvenance);
		writeFileSync(provenancePath, JSON.stringify({ ...provenance, unexpected: true }));
		assert.throws(
			() =>
				verifyEvidence({
					repository: root,
					archive,
					output: temporary,
					tag: 'v1.0.0',
					commit
				}),
			/provenance fields mismatch/u
		);
		writeFileSync(provenancePath, originalProvenance);
		provenance.materials = [provenance.materials[0]];
		writeFileSync(provenancePath, JSON.stringify(provenance));
		assert.throws(
			() =>
				verifyEvidence({
					repository: root,
					archive,
					output: temporary,
					tag: 'v1.0.0',
					commit
				}),
			/materials must contain exactly/u
		);
		writeFileSync(provenancePath, originalProvenance);
		provenance.materials = JSON.parse(originalProvenance).materials;
		provenance.materials[1] = provenance.materials[0];
		writeFileSync(provenancePath, JSON.stringify(provenance));
		assert.throws(
			() =>
				verifyEvidence({
					repository: root,
					archive,
					output: temporary,
					tag: 'v1.0.0',
					commit
				}),
			/unexpected or duplicate material/u
		);
		writeFileSync(provenancePath, originalProvenance);
		provenance.materials = JSON.parse(originalProvenance).materials;
		provenance.sbom.name = 'other.spdx.json';
		writeFileSync(provenancePath, JSON.stringify(provenance));
		assert.throws(
			() =>
				verifyEvidence({
					repository: root,
					archive,
					output: temporary,
					tag: 'v1.0.0',
					commit
				}),
			/unexpected SBOM name/u
		);
		writeFileSync(provenancePath, originalProvenance);
		writeFileSync(archive, 'tampered archive');
		assert.throws(
			() =>
				verifyEvidence({
					repository: root,
					archive,
					output: temporary,
					tag: 'v1.0.0',
					commit
				}),
			/archive does not match the requested commit/u
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
});

test('evidence reads the requested commit despite another HEAD and dirty files', () => {
	const repository = mkdtempSync(join(tmpdir(), 'quickmail-ja-git-materials-'));
	const output = join(repository, 'evidence');
	mkdirSync(output);
	const archive = join(output, 'quickmail-ja-1.0.0.zip');
	const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
	try {
		git('init', '-q');
		git('config', 'user.name', 'QuickMail-ja Test');
		git('config', 'user.email', 'test@example.invalid');
		writeFileSync(
			join(repository, 'package.json'),
			JSON.stringify({ name: 'quickmail-ja', version: '1.0.0', license: 'MIT' })
		);
		writeFileSync(join(repository, 'bun.lock'), '{\n  "lockfileVersion": 1\n}\n');
		git('add', 'package.json', 'bun.lock');
		git('commit', '-qm', 'first');
		const first = git('rev-parse', 'HEAD');
		writeFileSync(join(repository, 'note.txt'), 'second commit');
		git('add', 'note.txt');
		git('commit', '-qm', 'second');
		writeFileSync(
			join(repository, 'package.json'),
			JSON.stringify({ name: 'quickmail-ja', version: '9.9.9', license: 'MIT' })
		);
		gitArchive(repository, archive, 'v1.0.0', first);
		generateEvidence({ repository, archive, tag: 'v1.0.0', commit: first, output });
		verifyEvidence({ repository, archive, output, tag: 'v1.0.0', commit: first });
		const provenance = JSON.parse(readFileSync(join(output, 'release-provenance.json'), 'utf8'));
		assert.equal(provenance.materials[0].sha256.length, 64);
		const mismatchOutput = join(repository, 'mismatch');
		mkdirSync(mismatchOutput);
		const mismatchArchive = join(mismatchOutput, 'quickmail-ja-2.0.0.zip');
		gitArchive(repository, mismatchArchive, 'v2.0.0', first);
		assert.throws(
			() =>
				generateEvidence({
					repository,
					archive: mismatchArchive,
					tag: 'v2.0.0',
					commit: first,
					output: mismatchOutput
				}),
			/tag and package version mismatch/u
		);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test('tracked release paths contain no latest aliases or pipe installers', () => {
	assert.deepEqual(findUnsafeInstallReferences(root), []);
});

test('archive scanner rejects external font requests and permits local fonts', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-font-scan-'));
	try {
		mkdirSync(join(temporary, 'safe'));
		writeFileSync(
			join(temporary, 'safe', 'local.css'),
			'@font-face { src: url(/fonts/inter.woff2) }'
		);
		assert.deepEqual(findExternalFontReferences(temporary), []);
		writeFileSync(
			join(temporary, 'unsafe.svelte'),
			'<link href="' + ['https://fonts', 'googleapis.com/css2?family=Inter'].join('.') + '">'
		);
		assert.deepEqual(findExternalFontReferences(temporary), ['unsafe.svelte']);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
