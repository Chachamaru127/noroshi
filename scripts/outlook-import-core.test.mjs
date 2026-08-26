import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	buildOutlookImportPlan,
	IMPORT_LOCK,
	IMPORT_QUARANTINE_PREFIX,
	IMPORT_STAGING_MARKER,
	normalizeMessageId,
	normalizeSubject,
	prepareOutlookImportDirectories
} from './outlook-import-core.mjs';

test('normalizes Outlook reply subjects and Message-IDs', () => {
	assert.equal(normalizeSubject(' Re: FW:  Hello '), 'hello');
	assert.equal(normalizeMessageId(' <message@example.net> '), 'message@example.net');
});

test('Outlook import CLI requires explicit mailbox and domain inputs', () => {
	const result = spawnSync(process.execPath, [join(import.meta.dir, 'import-outlook-backup.mjs')], {
		encoding: 'utf8'
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--source は必須/);
});

test('deduplicates exact EML files and keeps historical attachments without the live 5MB limit', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-outlook-import-'));
	const backupDir = join(root, 'outlook');
	const stagingDir = join(root, 'staging');
	try {
		for (const folder of ['archive', 'inbox', 'sent'])
			await mkdir(join(backupDir, folder), { recursive: true });
		const large = Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64');
		const eml = [
			'From: sender@example.net',
			'To: info@example.net',
			'Subject: Test',
			'Message-ID: <one@example.net>',
			'Date: Tue, 26 May 2026 09:31:55 +0000',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body',
			'--b',
			'Content-Type: application/octet-stream; name="large.bin"',
			'Content-Disposition: attachment; filename="large.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			large,
			'--b--',
			''
		].join('\r\n');
		await writeFile(join(backupDir, 'archive', 'one.eml'), eml);
		await writeFile(join(backupDir, 'sent', 'duplicate.eml'), eml);

		const plan = await buildOutlookImportPlan({
			backupDir,
			stagingDir,
			mailboxAddress: 'info@example.net',
			domainName: 'example.net'
		});
		assert.equal(plan.summary.uniqueMessages, 1);
		assert.equal(plan.summary.duplicateFiles, 1);
		assert.equal(plan.summary.attachments, 1);
		assert.ok(plan.summary.largestAttachmentBytes > 5 * 1024 * 1024);
		assert.match(plan.messages[0].providerId, /outlook-import-v1-/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects equal, nested, and symlink-overlapping source and staging paths', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-boundary-'));
	const source = join(root, 'source');
	const sourceChild = join(source, 'child');
	const stagingParent = join(root, 'staging-parent');
	const sourceLink = join(root, 'source-link');
	try {
		await mkdir(sourceChild, { recursive: true });
		await mkdir(stagingParent, { recursive: true });
		await symlink(source, sourceLink);
		for (const stagingDir of [source, sourceChild, root, sourceLink]) {
			await assert.rejects(
				prepareOutlookImportDirectories({ backupDir: source, stagingDir }),
				/同一または親子関係/
			);
		}
		await assert.rejects(
			prepareOutlookImportDirectories({
				backupDir: source,
				stagingDir: stagingParent,
				cwd: stagingParent
			}),
			/ルート、ホーム、作業ディレクトリ/
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects filesystem root and home as broad import paths', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-broad-'));
	try {
		await assert.rejects(
			prepareOutlookImportDirectories({ backupDir: root, stagingDir: '/', cwd: root }),
			/ルート、ホーム、作業ディレクトリ/
		);
		await assert.rejects(
			prepareOutlookImportDirectories({ backupDir: homedir(), stagingDir: join(root, 'staging') }),
			/ルート、ホーム、作業ディレクトリ/
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('never clears a non-empty unowned staging directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-preserve-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	const sentinel = join(staging, 'keep.txt');
	try {
		await mkdir(source);
		await mkdir(staging);
		await writeFile(sentinel, 'keep me');
		await assert.rejects(
			prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging }),
			/空、またはQuickMail-jaが作成した専用ディレクトリ/
		);
		assert.equal(await readFile(sentinel, 'utf8'), 'keep me');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('accepts a new or marked dedicated staging directory without deleting its manifest', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-owned-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	try {
		await mkdir(source);
		const first = await prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging });
		assert.equal(first.stagingDir, await realpath(staging));
		assert.match(await readFile(join(staging, IMPORT_STAGING_MARKER), 'utf8'), /QuickMail-ja/);
		await writeFile(join(staging, 'manifest.json'), '{"kept":true}');
		await prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging });
		assert.equal(await readFile(join(staging, 'manifest.json'), 'utf8'), '{"kept":true}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects a manifest symlink without changing its external target', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-manifest-link-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	const sentinel = join(root, 'external-sentinel.json');
	try {
		for (const folder of ['archive', 'inbox', 'sent']) {
			await mkdir(join(source, folder), { recursive: true });
		}
		await prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging });
		await writeFile(sentinel, '{"unchanged":true}');
		await symlink(sentinel, join(staging, 'manifest.json'));

		await assert.rejects(
			buildOutlookImportPlan({
				backupDir: source,
				stagingDir: staging,
				mailboxAddress: 'info@example.net',
				domainName: 'example.net'
			}),
			/通常ファイル/
		);
		assert.equal(await readFile(sentinel, 'utf8'), '{"unchanged":true}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects a staging marker symlink even when its target contains the valid marker', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-marker-link-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	const markerTarget = join(root, 'marker-target');
	try {
		await mkdir(source);
		await mkdir(staging);
		await writeFile(markerTarget, 'QuickMail-ja Outlook import staging v1\n');
		await symlink(markerTarget, join(staging, IMPORT_STAGING_MARKER));
		await assert.rejects(
			prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging }),
			/通常ファイル/
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects a non-regular staging marker', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-marker-special-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	try {
		await mkdir(source);
		await mkdir(join(staging, IMPORT_STAGING_MARKER), { recursive: true });
		await assert.rejects(
			prepareOutlookImportDirectories({ backupDir: source, stagingDir: staging }),
			/通常ファイル/
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects a second import while the first import holds the staging lock', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-concurrent-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	let releaseFirst;
	let notifyLocked;
	const firstCanFinish = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	const firstHasLock = new Promise((resolve) => {
		notifyLocked = resolve;
	});
	try {
		for (const folder of ['archive', 'inbox', 'sent']) {
			await mkdir(join(source, folder), { recursive: true });
		}
		const options = {
			backupDir: source,
			stagingDir: staging,
			mailboxAddress: 'info@example.net',
			domainName: 'example.net'
		};
		const first = buildOutlookImportPlan({
			...options,
			hooks: {
				afterLockAcquired: async () => {
					notifyLocked();
					await firstCanFinish;
				}
			}
		});
		await firstHasLock;
		const secondError = await buildOutlookImportPlan(options).then(
			() => null,
			(error) => error
		);
		releaseFirst();
		const firstError = await first.then(
			() => null,
			(error) => error
		);
		assert.match(secondError?.message ?? '', /取り込みロック|別のOutlook取り込み/);
		assert.equal(firstError, null);
		await assert.rejects(lstat(join(staging, IMPORT_LOCK)), { code: 'ENOENT' });
	} finally {
		releaseFirst?.();
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects an in-place manifest mutation during the scan without overwriting it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-manifest-mutation-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	const manifestPath = join(staging, 'manifest.json');
	try {
		for (const folder of ['archive', 'inbox', 'sent']) {
			await mkdir(join(source, folder), { recursive: true });
		}
		const options = {
			backupDir: source,
			stagingDir: staging,
			mailboxAddress: 'info@example.net',
			domainName: 'example.net'
		};
		await buildOutlookImportPlan(options);
		const original = await lstat(manifestPath);
		const externalContents = '{"changed-during-scan":true}';

		await assert.rejects(
			buildOutlookImportPlan({
				...options,
				hooks: {
					afterScan: async () => {
						await writeFile(manifestPath, externalContents);
						assert.equal((await lstat(manifestPath)).ino, original.ino);
					}
				}
			}),
			/manifest.jsonが取り込み中に変更/
		);
		assert.equal(await readFile(manifestPath, 'utf8'), externalContents);
		await assert.rejects(lstat(join(staging, IMPORT_LOCK)), { code: 'ENOENT' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('quarantines a replacement lock before release and keeps later imports blocked', async () => {
	const root = await mkdtemp(join(tmpdir(), 'quickmail-ja-import-lock-release-race-'));
	const source = join(root, 'source');
	const staging = join(root, 'staging');
	const replacementContents = 'replacement lock sentinel\n';
	try {
		for (const folder of ['archive', 'inbox', 'sent']) {
			await mkdir(join(source, folder), { recursive: true });
		}
		const options = {
			backupDir: source,
			stagingDir: staging,
			mailboxAddress: 'info@example.net',
			domainName: 'example.net'
		};
		const importError = await buildOutlookImportPlan({
			...options,
			hooks: {
				beforeLockRelease: async (lockPath) => {
					const replacementPath = join(staging, '.replacement-lock-sentinel');
					await writeFile(replacementPath, replacementContents);
					assert.notEqual((await lstat(replacementPath)).ino, (await lstat(lockPath)).ino);
					await rename(replacementPath, lockPath);
				}
			}
		}).then(
			() => null,
			(error) => error
		);
		assert.match(importError?.message ?? '', /隔離|ロックが変更/);

		const quarantineName = (await readdir(staging)).find((entry) =>
			entry.startsWith(IMPORT_QUARANTINE_PREFIX)
		);
		assert.ok(quarantineName);
		const quarantinePath = join(staging, quarantineName);
		assert.equal(await readFile(quarantinePath, 'utf8'), replacementContents);
		await assert.rejects(buildOutlookImportPlan(options), /隔離|取り込みロック/);
		assert.equal(await readFile(quarantinePath, 'utf8'), replacementContents);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
