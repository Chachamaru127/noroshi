#!/usr/bin/env bun
import { buildOutlookImportPlan } from './outlook-import-core.mjs';

const backupDir = requiredArg('--source', '例: --source /path/to/outlook-export');
const stagingDir = requiredArg('--staging', '例: --staging /path/to/import-staging');
const mailboxAddress = requiredArg('--mailbox', '例: --mailbox info@example.com');
const domainName = requiredArg('--domain', '例: --domain example.com');

const plan = await buildOutlookImportPlan({ backupDir, stagingDir, mailboxAddress, domainName });
console.log(JSON.stringify(plan.summary, null, 2));
console.log(`\nドライランです。監査用manifestを ${stagingDir} に生成しました。`);
console.log('本番反映はQuickMail-jaの管理画面から行います。');

function readArg(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArg(name, hint) {
	const value = readArg(name)?.trim();
	if (!value) {
		console.error(`${name} は必須です（${hint}）`);
		process.exit(2);
	}
	return value;
}
