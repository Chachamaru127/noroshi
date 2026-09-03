import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import PostalMime from 'postal-mime';

export const IMPORT_PREFIX = 'outlook-import-v1-';
export const IMPORT_STAGING_MARKER = '.noroshi-outlook-import-staging';
export const IMPORT_LOCK = '.noroshi-outlook-import.lock';
export const IMPORT_QUARANTINE_PREFIX = '.noroshi-outlook-import-quarantine-';
const IMPORT_STAGING_MARKER_CONTENT = 'Noroshi Outlook import staging v1\n';

export async function buildOutlookImportPlan(options) {
	const { mailboxAddress, domainName } = options;
	const {
		sourceDir: backupDir,
		stagingDir,
		markerFingerprint,
		manifestFingerprint
	} = await prepareOutlookImportDirectories(options);
	const importLock = await acquireImportLock(stagingDir);
	try {
		await options.hooks?.afterLockAcquired?.();
		const sources = [
			{ folder: 'archive', direction: 'inbound' },
			{ folder: 'inbox', direction: 'inbound' },
			{ folder: 'sent', direction: 'outbound' }
		];
		const messages = [];
		const seenHashes = new Set();
		const duplicateFiles = [];

		for (const source of sources) {
			const directory = join(backupDir, source.folder);
			const files = (await readdir(directory)).filter((name) => name.endsWith('.eml')).sort();
			for (const filename of files) {
				const path = join(directory, filename);
				const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
				const hash = sha256Hex(raw);
				if (seenHashes.has(hash)) {
					duplicateFiles.push(path);
					continue;
				}
				seenHashes.add(hash);
				const parsed = await PostalMime.parse(raw.buffer, { attachmentEncoding: 'arraybuffer' });
				messages.push(toImportMessage({ parsed, hash, path, source, mailboxAddress }));
			}
		}
		await options.hooks?.afterScan?.();

		messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.hash.localeCompare(b.hash));
		const attachments = messages.flatMap((message) => message.attachments);
		const summary = {
			mailboxAddress,
			domainName,
			filesScanned: messages.length + duplicateFiles.length,
			uniqueMessages: messages.length,
			inboundMessages: messages.filter((message) => message.direction === 'inbound').length,
			outboundMessages: messages.filter((message) => message.direction === 'outbound').length,
			duplicateFiles: duplicateFiles.length,
			attachments: attachments.length,
			attachmentBytes: attachments.reduce((total, attachment) => total + attachment.size, 0),
			largestAttachmentBytes: Math.max(0, ...attachments.map((attachment) => attachment.size)),
			dateMin: messages[0]?.createdAt ?? null,
			dateMax: messages.at(-1)?.createdAt ?? null
		};

		await writeManifestAtomically(
			stagingDir,
			JSON.stringify(
				{
					summary,
					duplicateFiles,
					messages: messages.map((message) => ({
						providerId: message.providerId,
						sourcePath: message.sourcePath,
						sourceFolder: message.sourceFolder,
						direction: message.direction,
						createdAt: message.createdAt,
						messageId: message.messageId,
						attachments: message.attachments.length
					}))
				},
				null,
				2
			),
			{ markerFingerprint, manifestFingerprint, lockFingerprint: importLock.fingerprint }
		);
		return { summary, messages, attachments };
	} finally {
		await releaseImportLock(importLock, options.hooks);
	}
}

export async function prepareOutlookImportDirectories({
	backupDir,
	stagingDir,
	cwd = process.cwd(),
	home = homedir()
}) {
	if (!backupDir || !stagingDir) {
		throw new Error('入力元と作業用ディレクトリの両方を指定してください。');
	}

	const sourceDir = await canonicalizePath(backupDir, { mustExist: true });
	const canonicalStaging = await canonicalizePath(stagingDir, { mustExist: false });
	const canonicalHome = await canonicalizePath(home, { mustExist: true });
	const canonicalCwd = await canonicalizePath(cwd, { mustExist: true });

	await assertDirectory(sourceDir, '入力元');
	assertNotBroadPath(sourceDir, '入力元', canonicalHome, canonicalCwd);
	assertNotBroadPath(canonicalStaging, '作業用', canonicalHome, canonicalCwd);
	if (pathsOverlap(sourceDir, canonicalStaging)) {
		throw new Error('入力元と作業用ディレクトリは、同一または親子関係にできません。');
	}

	let stagingEntries = null;
	try {
		const stagingStat = await stat(canonicalStaging);
		if (!stagingStat.isDirectory()) {
			throw new Error('作業用パスにはディレクトリを指定してください。');
		}
		if (typeof process.getuid === 'function' && stagingStat.uid !== process.getuid()) {
			throw new Error('作業用ディレクトリの所有者が現在のユーザーではありません。');
		}
		stagingEntries = await readdir(canonicalStaging);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
		await mkdir(canonicalStaging, { recursive: true });
		stagingEntries = [];
	}

	if (
		stagingEntries.includes(IMPORT_LOCK) ||
		stagingEntries.some((entry) => entry.startsWith(IMPORT_QUARANTINE_PREFIX))
	) {
		throw new Error(
			'Outlook取り込みロックまたは隔離ファイルが存在します。別の取り込みの完了を待つか、前回の異常終了を確認してください。'
		);
	}
	assertAllowedStagingEntries(stagingEntries);
	if (stagingEntries.length === 0) {
		await writeExclusiveRegularFile(
			join(canonicalStaging, IMPORT_STAGING_MARKER),
			IMPORT_STAGING_MARKER_CONTENT
		);
		stagingEntries = [IMPORT_STAGING_MARKER];
	}

	const validated = await validateOwnedStaging(canonicalStaging, stagingEntries);
	return { sourceDir, stagingDir: canonicalStaging, ...validated };
}

function assertAllowedStagingEntries(entries) {
	const allowed = new Set([IMPORT_STAGING_MARKER, 'manifest.json']);
	if (entries.some((entry) => !allowed.has(entry))) {
		throw new Error(
			'作業用ディレクトリは空、またはNoroshiが作成した専用ディレクトリにしてください。'
		);
	}
}

async function validateOwnedStaging(stagingDir, expectedEntries) {
	const firstEntries = (await readdir(stagingDir)).sort();
	if (!sameEntries(firstEntries, [...expectedEntries].sort())) {
		throw new Error('作業用ディレクトリが確認中に変更されました。もう一度実行してください。');
	}
	assertAllowedStagingEntries(firstEntries);
	if (!firstEntries.includes(IMPORT_STAGING_MARKER)) {
		throw new Error('空でない作業用ディレクトリにはNoroshiの所有マーカーが必要です。');
	}

	const markerPath = join(stagingDir, IMPORT_STAGING_MARKER);
	const marker = await readRegularFileNoFollow(markerPath, '作業用ディレクトリの所有マーカー');
	if (marker.contents !== IMPORT_STAGING_MARKER_CONTENT) {
		throw new Error('作業用ディレクトリの所有マーカーを確認できません。');
	}

	const manifestFingerprint = firstEntries.includes('manifest.json')
		? await assertRegularFile(join(stagingDir, 'manifest.json'), '既存のmanifest.json')
		: null;
	const finalEntries = (await readdir(stagingDir)).sort();
	if (!sameEntries(firstEntries, finalEntries)) {
		throw new Error('作業用ディレクトリが確認中に変更されました。もう一度実行してください。');
	}
	return { markerFingerprint: marker.fingerprint, manifestFingerprint };
}

async function acquireImportLock(stagingDir) {
	const path = join(stagingDir, IMPORT_LOCK);
	let handle = null;
	let createdIdentity = null;
	let fingerprint = null;
	try {
		const flags =
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
		handle = await open(path, flags, 0o600);
		createdIdentity = fingerprintFromStats(await handle.stat({ bigint: true }));
		await handle.writeFile(`${randomBytes(16).toString('hex')}\n`, 'utf8');
		await handle.sync();
		const info = await handle.stat({ bigint: true });
		if (!info.isFile())
			throw new Error('Outlook取り込みロックを通常ファイルとして作成できません。');
		fingerprint = fingerprintFromStats(info);
		const installed = await assertRegularFile(path, 'Outlook取り込みロック');
		if (!sameFingerprint(installed, fingerprint)) {
			throw new Error('Outlook取り込みロックが作成中に変更されました。取り込みを停止します。');
		}
		await handle.close();
		handle = null;
		return { path, fingerprint };
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		if (createdIdentity) await removeExactFile(path, createdIdentity).catch(() => {});
		if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
			throw new Error(
				'Outlook取り込みロックが存在します。別の取り込みの完了を待つか、前回の異常終了を確認してください。'
			);
		}
		throw error;
	}
}

async function releaseImportLock(lock, hooks) {
	await removeExactFile(lock.path, lock.fingerprint, {
		label: 'Outlook取り込みロック',
		beforeQuarantineRename: () => hooks?.beforeLockRelease?.(lock.path)
	});
}

async function writeManifestAtomically(stagingDir, contents, expected) {
	await revalidateStagingForManifest(stagingDir, expected);
	const temporaryPath = join(stagingDir, `.manifest-${randomBytes(12).toString('hex')}.tmp`);
	let temporaryHandle = null;
	let temporaryIdentity = null;
	let temporaryFingerprint = null;
	let temporaryPresent = false;
	try {
		temporaryHandle = await open(temporaryPath, 'wx', 0o600);
		temporaryPresent = true;
		temporaryIdentity = fingerprintFromStats(await temporaryHandle.stat({ bigint: true }));
		await temporaryHandle.writeFile(contents, 'utf8');
		await temporaryHandle.sync();
		temporaryFingerprint = fingerprintFromStats(await temporaryHandle.stat({ bigint: true }));
		await temporaryHandle.close();
		temporaryHandle = null;

		await revalidateStagingForManifest(stagingDir, expected, temporaryPath);
		await rename(temporaryPath, join(stagingDir, 'manifest.json'));
		temporaryPresent = false;
		const installed = await readRegularFileNoFollow(
			join(stagingDir, 'manifest.json'),
			'新しいmanifest.json'
		);
		if (
			!sameIdentity(installed.fingerprint, temporaryFingerprint) ||
			installed.contents !== contents
		) {
			throw new Error('manifest.jsonが原子的な更新後に変更されました。取り込みを停止します。');
		}
	} finally {
		if (temporaryHandle) await temporaryHandle.close().catch(() => {});
		if (temporaryPresent && temporaryIdentity) {
			await removeExactFile(temporaryPath, temporaryIdentity);
		}
	}
}

async function revalidateStagingForManifest(stagingDir, expected, temporaryPath = null) {
	const marker = await readRegularFileNoFollow(
		join(stagingDir, IMPORT_STAGING_MARKER),
		'作業用ディレクトリの所有マーカー'
	);
	if (
		marker.contents !== IMPORT_STAGING_MARKER_CONTENT ||
		!sameFingerprint(marker.fingerprint, expected.markerFingerprint)
	) {
		throw new Error('作業用ディレクトリの所有マーカーが変更されました。取り込みを停止します。');
	}

	const entries = await readdir(stagingDir);
	const temporaryName = temporaryPath ? temporaryPath.slice(stagingDir.length + 1) : null;
	const applicationEntries = entries.filter(
		(entry) => entry !== temporaryName && entry !== IMPORT_LOCK
	);
	assertAllowedStagingEntries(applicationEntries);
	if (!entries.includes(IMPORT_LOCK)) {
		throw new Error('Outlook取り込みロックが失われました。取り込みを停止します。');
	}
	const lock = await assertRegularFile(join(stagingDir, IMPORT_LOCK), 'Outlook取り込みロック');
	if (!sameFingerprint(lock, expected.lockFingerprint)) {
		throw new Error('Outlook取り込みロックが変更されました。取り込みを停止します。');
	}
	const manifestPath = join(stagingDir, 'manifest.json');
	if (expected.manifestFingerprint) {
		const current = await assertRegularFile(manifestPath, '既存のmanifest.json');
		if (!sameFingerprint(current, expected.manifestFingerprint)) {
			throw new Error('manifest.jsonが取り込み中に変更されました。取り込みを停止します。');
		}
	} else if (applicationEntries.includes('manifest.json')) {
		throw new Error('manifest.jsonが取り込み中に作成されました。取り込みを停止します。');
	}
}

async function writeExclusiveRegularFile(path, contents) {
	let handle = null;
	try {
		handle = await open(path, 'wx', 0o600);
		await handle.writeFile(contents, 'utf8');
		await handle.sync();
	} finally {
		if (handle) await handle.close();
	}
	await assertRegularFile(path, '作業用ディレクトリの所有マーカー');
}

async function readRegularFileNoFollow(path, label) {
	const before = await assertRegularFile(path, label);
	let handle = null;
	try {
		const noFollow = constants.O_NOFOLLOW ?? 0;
		handle = await open(path, constants.O_RDONLY | noFollow);
		const opened = fingerprintFromStats(await handle.stat({ bigint: true }));
		if (!sameFingerprint(before, opened)) throw new Error(`${label}が確認中に変更されました。`);
		const contents = await handle.readFile({ encoding: 'utf8' });
		const after = await assertRegularFile(path, label);
		if (!sameFingerprint(opened, after)) throw new Error(`${label}が確認中に変更されました。`);
		return { contents, fingerprint: opened };
	} catch (error) {
		if (error?.code === 'ELOOP') throw new Error(`${label}はシンボリックリンクにできません。`);
		throw error;
	} finally {
		if (handle) await handle.close();
	}
}

async function assertRegularFile(path, label) {
	let info;
	try {
		info = await lstat(path, { bigint: true });
	} catch (error) {
		if (error?.code === 'ENOENT') throw new Error(`${label}がありません。`);
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(
			`${label}はシンボリックリンクや特殊ファイルではなく、通常ファイルにしてください。`
		);
	}
	return fingerprintFromStats(info);
}

async function removeExactFile(
	path,
	expectedIdentity,
	{ label = '一時ファイル', beforeQuarantineRename } = {}
) {
	const current = await assertRegularFile(path, label);
	if (!sameIdentity(current, expectedIdentity)) {
		throw new Error(`${label}が変更されたため、自動削除せずに停止します。`);
	}
	await beforeQuarantineRename?.();

	const quarantinePath = join(
		dirname(path),
		`${IMPORT_QUARANTINE_PREFIX}${randomBytes(24).toString('hex')}`
	);
	await rename(path, quarantinePath);
	const quarantined = await assertRegularFile(quarantinePath, `${label}の隔離ファイル`);
	if (!sameIdentity(quarantined, expectedIdentity)) {
		throw new Error(
			`${label}が削除直前に変更されました。隔離ファイルを残して取り込みを停止します。`
		);
	}
	await unlink(quarantinePath);
}

function fingerprintFromStats(info) {
	return {
		dev: info.dev,
		ino: info.ino,
		mode: info.mode,
		birthtimeNs: info.birthtimeNs,
		size: info.size,
		mtimeNs: info.mtimeNs,
		ctimeNs: info.ctimeNs
	};
}

function sameIdentity(left, right) {
	return Boolean(
		left &&
		right &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.birthtimeNs === right.birthtimeNs
	);
}

function sameFingerprint(left, right) {
	return Boolean(
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sameEntries(left, right) {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

async function canonicalizePath(input, { mustExist }) {
	if (!isAbsolute(input)) input = resolve(input);
	const absolute = resolve(input);
	try {
		return await realpath(absolute);
	} catch (error) {
		if (mustExist || error?.code !== 'ENOENT') throw error;
	}

	const missing = [];
	let current = absolute;
	while (true) {
		const parent = dirname(current);
		if (parent === current) throw new Error(`作業用パスを解決できません: ${absolute}`);
		missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		current = parent;
		try {
			return resolve(await realpath(current), ...missing);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
	}
}

async function assertDirectory(path, label) {
	const info = await stat(path);
	if (!info.isDirectory()) throw new Error(`${label}にはディレクトリを指定してください。`);
}

function assertNotBroadPath(path, label, home, cwd) {
	const root = parse(path).root;
	if (
		path === root ||
		path === home ||
		path === cwd ||
		isAncestor(path, home) ||
		isAncestor(path, cwd)
	) {
		throw new Error(
			`${label}ディレクトリにルート、ホーム、作業ディレクトリ、その親は指定できません。`
		);
	}
}

function pathsOverlap(left, right) {
	return left === right || isAncestor(left, right) || isAncestor(right, left);
}

function isAncestor(parent, child) {
	const childRelative = relative(parent, child);
	return childRelative !== '' && !childRelative.startsWith('..') && !isAbsolute(childRelative);
}

function toImportMessage({ parsed, hash, path, source, mailboxAddress }) {
	return {
		hash,
		providerId: `${IMPORT_PREFIX}${hash}`,
		sourcePath: path,
		sourceFolder: source.folder,
		direction: source.direction,
		createdAt: validDate(parsed.date)?.toISOString() ?? new Date(0).toISOString(),
		messageId: normalizeMessageId(parsed.messageId),
		attachments: (parsed.attachments ?? []).map((attachment) => ({
			filename: attachment.filename || 'attachment',
			size: attachmentBytes(attachment.content).byteLength
		})),
		mailboxAddress
	};
}

export function normalizeSubject(subject) {
	let value = String(subject || '').trim();
	const prefix = /^\s*(re|fw|fwd)\s*(\[\d+\])?\s*:\s*/i;
	for (;;) {
		const stripped = value.replace(prefix, '').trim();
		if (stripped === value) return value.toLowerCase();
		value = stripped;
	}
}

export function normalizeMessageId(value) {
	if (!value) return null;
	return String(value).trim().replace(/^<|>$/g, '') || null;
}

function attachmentBytes(content) {
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	if (typeof content === 'string') return new TextEncoder().encode(content);
	return new Uint8Array();
}

function validDate(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function sha256Hex(value) {
	return createHash('sha256').update(value).digest('hex');
}
