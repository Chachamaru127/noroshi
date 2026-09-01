#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashFile = (path) => sha256(readFileSync(path));
const gitBlob = (repository, commit, path) =>
	execFileSync('git', ['show', `${commit}:${path}`], { cwd: repository });

function exactKeys(value, expected, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const actual = Object.keys(value).sort();
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		throw new Error(`${label} fields mismatch`);
	}
}

function assertArchiveMatchesCommit(repository, archive, tag, commit) {
	const expectedName = `noroshi-mail-${tag.slice(1)}.zip`;
	if (basename(archive) !== expectedName) throw new Error('archive name does not match tag');
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-expected-archive-'));
	const expected = join(temporary, expectedName);
	try {
		execFileSync(
			'git',
			[
				'archive',
				'--format=zip',
				`--prefix=noroshi-mail-${tag.slice(1)}/`,
				`--output=${expected}`,
				commit
			],
			{ cwd: repository }
		);
		if (hashFile(archive) !== hashFile(expected)) {
			throw new Error('archive does not match the requested commit');
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function regularFile(path, label) {
	const status = lstatSync(path);
	if (!status.isFile() || status.isSymbolicLink())
		throw new Error(`${label} must be a regular file`);
}

function packagesFromBunLock(contents) {
	const packages = new Map();
	for (const match of contents.matchAll(/^\s{4}"[^"]+": \["([^"]+)"/gmu)) {
		const locator = match[1];
		const split = locator.lastIndexOf('@');
		if (split < 1) continue;
		packages.set(locator, { name: locator.slice(0, split), version: locator.slice(split + 1) });
	}
	return [...packages.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([locator, pkg], index) => ({
			SPDXID: `SPDXRef-Package-${index + 1}`,
			name: pkg.name,
			versionInfo: pkg.version,
			downloadLocation: 'NOASSERTION',
			filesAnalyzed: false,
			licenseConcluded: 'NOASSERTION',
			licenseDeclared: 'NOASSERTION',
			copyrightText: 'NOASSERTION',
			externalRefs: [
				{
					referenceCategory: 'PACKAGE-MANAGER',
					referenceType: 'purl',
					referenceLocator: `pkg:npm/${pkg.name.startsWith('@') ? `${encodeURIComponent(pkg.name.split('/')[0])}/${pkg.name.split('/')[1]}` : pkg.name}@${pkg.version}`
				}
			]
		}));
}

const TEXT_EXTENSIONS = /\.(?:css|html|js|json|md|mjs|svelte|ts|txt|yaml|yml)$/iu;
const EXTERNAL_FONT =
	/fonts\.(?:googleapis|gstatic)\.com|@import\s+url\([^)]*https?:\/\/|@font-face[^}]*https?:\/\//iu;

export function findExternalFontReferences(directory, base = directory) {
	const findings = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) findings.push(...findExternalFontReferences(path, base));
		else if (entry.isFile() && TEXT_EXTENSIONS.test(entry.name)) {
			const contents = readFileSync(path, 'utf8');
			if (EXTERNAL_FONT.test(contents)) findings.push(path.slice(base.length + 1));
		}
	}
	return findings.sort();
}

export function findUnsafeInstallReferences(repository) {
	const excluded = new Set([
		'scripts/release-supply-chain.mjs',
		'scripts/release-supply-chain.test.mjs'
	]);
	const files = execFileSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	const executableOrConfig = /(?:^|\/)(?:Dockerfile|[^/]+\.(?:js|json|jsonc|mjs|sh|ts|yaml|yml))$/u;
	const latest = new RegExp(['@', 'latest'].join(''), 'u');
	const pipeShell = new RegExp(['curl', '[^\\n|]*\\|\\s*(?:ba)?sh'].join(''), 'u');
	return files
		.filter((path) => !excluded.has(path) && executableOrConfig.test(path))
		.flatMap((path) => {
			let contents;
			try {
				contents = readFileSync(join(repository, path), 'utf8');
			} catch {
				return [];
			}
			return latest.test(contents) || pipeShell.test(contents) ? [path] : [];
		})
		.sort();
}

export function generateEvidence({ repository, archive, tag, commit, output }) {
	if (!/^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?$/u.test(tag)) throw new Error('invalid tag');
	if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('invalid commit SHA');
	regularFile(archive, 'archive');
	assertArchiveMatchesCommit(repository, archive, tag, commit);
	const packageBlob = gitBlob(repository, commit, 'package.json');
	const lockBlob = gitBlob(repository, commit, 'bun.lock');
	const pkg = JSON.parse(packageBlob.toString('utf8'));
	if (pkg.version !== tag.slice(1)) throw new Error('tag and package version mismatch');
	const lock = lockBlob.toString('utf8');
	const created = execFileSync('git', ['show', '-s', '--format=%cI', commit], {
		cwd: repository,
		encoding: 'utf8'
	}).trim();
	const archiveName = basename(archive);
	const sbomName = 'noroshi-mail.spdx.json';
	const provenanceName = 'release-provenance.json';
	const releaseEvidenceName = 'release-evidence.json';
	const checksumsName = 'SHA256SUMS';
	const sbom = {
		spdxVersion: 'SPDX-2.3',
		dataLicense: 'CC0-1.0',
		SPDXID: 'SPDXRef-DOCUMENT',
		name: `${pkg.name}-${tag.slice(1)}`,
		documentNamespace: `urn:noroshi-mail:${tag}:${commit}`,
		creationInfo: { created, creators: ['Tool: Noroshi release-supply-chain.mjs'] },
		packages: [
			{
				SPDXID: 'SPDXRef-RootPackage',
				name: pkg.name,
				versionInfo: pkg.version,
				downloadLocation: 'NOASSERTION',
				filesAnalyzed: false,
				licenseConcluded: pkg.license || 'NOASSERTION',
				licenseDeclared: pkg.license || 'NOASSERTION',
				copyrightText: 'NOASSERTION'
			},
			...packagesFromBunLock(lock)
		],
		documentDescribes: ['SPDXRef-RootPackage']
	};
	const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;
	writeFileSync(join(output, sbomName), sbomText, { flag: 'wx' });
	const provenance = {
		schemaVersion: 1,
		tag,
		commitSha: commit,
		subject: { name: archiveName, sha256: hashFile(archive) },
		materials: [
			{ path: 'package.json', sha256: sha256(packageBlob) },
			{ path: 'bun.lock', sha256: sha256(lockBlob) }
		],
		sbom: { name: sbomName, sha256: sha256(sbomText) }
	};
	const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
	writeFileSync(join(output, provenanceName), provenanceText, { flag: 'wx' });
	const releaseEvidenceText = `${JSON.stringify(
		{ tag, version: tag.slice(1), commitSha: commit, archiveSha256: hashFile(archive) },
		null,
		2
	)}\n`;
	writeFileSync(join(output, releaseEvidenceName), releaseEvidenceText, { flag: 'wx' });
	const checksums = [
		[hashFile(archive), archiveName],
		[sha256(provenanceText), provenanceName],
		[sha256(releaseEvidenceText), releaseEvidenceName],
		[sha256(sbomText), sbomName]
	]
		.sort((left, right) => left[1].localeCompare(right[1]))
		.map(([hash, name]) => `${hash}  ${name}`)
		.join('\n');
	writeFileSync(join(output, checksumsName), `${checksums}\n`, { flag: 'wx' });
	return { sbomName, provenanceName, releaseEvidenceName, checksumsName };
}

export function verifyEvidence({ repository, archive, output, tag, commit }) {
	regularFile(archive, 'archive');
	assertArchiveMatchesCommit(repository, archive, tag, commit);
	const provenance = JSON.parse(readFileSync(join(output, 'release-provenance.json'), 'utf8'));
	exactKeys(
		provenance,
		['schemaVersion', 'tag', 'commitSha', 'subject', 'materials', 'sbom'],
		'provenance'
	);
	if (provenance.tag !== tag || provenance.commitSha !== commit)
		throw new Error('provenance ref mismatch');
	if (provenance.schemaVersion !== 1) throw new Error('unsupported provenance schema');
	const packageBlob = gitBlob(repository, commit, 'package.json');
	const lockBlob = gitBlob(repository, commit, 'bun.lock');
	const pkg = JSON.parse(packageBlob.toString('utf8'));
	if (pkg.version !== tag.slice(1)) throw new Error('tag and package version mismatch');
	exactKeys(provenance.subject, ['name', 'sha256'], 'subject');
	if (
		provenance.subject.name !== basename(archive) ||
		provenance.subject.sha256 !== hashFile(archive)
	) {
		throw new Error('archive provenance mismatch');
	}
	if (!Array.isArray(provenance.materials) || provenance.materials.length !== 2) {
		throw new Error('materials must contain exactly package.json and bun.lock');
	}
	const expectedMaterials = new Map([
		['package.json', sha256(packageBlob)],
		['bun.lock', sha256(lockBlob)]
	]);
	for (const material of provenance.materials) {
		exactKeys(material, ['path', 'sha256'], 'material');
		if (!expectedMaterials.has(material.path)) throw new Error('unexpected or duplicate material');
		if (material.sha256 !== expectedMaterials.get(material.path)) {
			throw new Error(`material mismatch: ${material.path}`);
		}
		expectedMaterials.delete(material.path);
	}
	if (expectedMaterials.size > 0) throw new Error('missing material');
	exactKeys(provenance.sbom, ['name', 'sha256'], 'sbom reference');
	if (provenance.sbom.name !== 'noroshi-mail.spdx.json') throw new Error('unexpected SBOM name');
	if (provenance.sbom.sha256 !== hashFile(join(output, provenance.sbom.name))) {
		throw new Error('SBOM provenance mismatch');
	}
	const sbom = JSON.parse(readFileSync(join(output, provenance.sbom.name), 'utf8'));
	if (
		sbom.name !== `${pkg.name}-${tag.slice(1)}` ||
		sbom.documentNamespace !== `urn:noroshi-mail:${tag}:${commit}`
	) {
		throw new Error('SBOM identity mismatch');
	}
	const releaseEvidence = JSON.parse(readFileSync(join(output, 'release-evidence.json'), 'utf8'));
	exactKeys(releaseEvidence, ['tag', 'version', 'commitSha', 'archiveSha256'], 'release evidence');
	if (
		releaseEvidence.tag !== tag ||
		releaseEvidence.version !== tag.slice(1) ||
		releaseEvidence.commitSha !== commit ||
		releaseEvidence.archiveSha256 !== hashFile(archive)
	) {
		throw new Error('release evidence mismatch');
	}
	const lines = readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n');
	const expectedNames = [
		basename(archive),
		'release-evidence.json',
		'release-provenance.json',
		'noroshi-mail.spdx.json'
	].sort();
	const actualNames = lines
		.map((line) => line.match(/^[0-9a-f]{64}  ([A-Za-z0-9._-]+)$/u)?.[1])
		.sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error('checksum manifest entry mismatch');
	}
	for (const line of lines) {
		const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u);
		if (!match) throw new Error('invalid checksum manifest');
		const path = join(output, match[2]);
		regularFile(path, match[2]);
		if (hashFile(path) !== match[1]) throw new Error(`checksum mismatch: ${match[2]}`);
	}
}

if (import.meta.main) {
	const [mode, archiveArg, tag, commit, outputArg = '.'] = process.argv.slice(2);
	if (!['generate', 'verify'].includes(mode) || !archiveArg || !tag || !commit) {
		throw new Error(
			'usage: release-supply-chain.mjs <generate|verify> <archive> <tag> <commit> [output]'
		);
	}
	const repository = resolve(new URL('..', import.meta.url).pathname);
	const params = {
		repository,
		archive: resolve(archiveArg),
		tag,
		commit,
		output: resolve(outputArg)
	};
	if (mode === 'generate') generateEvidence(params);
	else verifyEvidence(params);
	console.log(`✓ Release supply-chain evidence ${mode}d.`);
}
