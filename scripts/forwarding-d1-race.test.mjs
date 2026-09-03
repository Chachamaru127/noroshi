import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const temp = mkdtempSync(join(tmpdir(), 'noroshi-forwarding-mvp-'));
const database = join(temp, 'race.sqlite');
const upgradeDatabase = join(temp, 'upgrade.sqlite');

function sqlite(input) {
	return execFileSync('sqlite3', [database], { input }).toString().trim();
}

function runProcess(sqlPath, outputPath) {
	return new Promise((resolve) => {
		const output = Bun.file(outputPath).writer();
		const child = spawn('sqlite3', ['-batch', '-cmd', '.timeout 5000', database], {
			stdio: ['pipe', 'pipe', 'ignore']
		});
		child.stdout.on('data', (chunk) => output.write(chunk));
		child.on('close', async () => {
			await output.end();
			resolve();
		});
		child.stdin.end(readFileSync(sqlPath));
	});
}

try {
	const names = readdirSync(new URL('../migrations/', import.meta.url))
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const name of names) {
		sqlite(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	}
	for (const name of names.filter((name) => name < '0015_')) {
		execFileSync('sqlite3', [upgradeDatabase], {
			input: readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
		});
	}
	execFileSync('sqlite3', [upgradeDatabase], {
		input: readFileSync(
			new URL('../migrations/0015_forwarding_delivery.sql', import.meta.url),
			'utf8'
		)
	});
	assert.equal(
		execFileSync('sqlite3', [upgradeDatabase], {
			input:
				"SELECT count(*) FROM pragma_table_info('forwarding_attempts') WHERE name='lease_token';"
		})
			.toString()
			.trim(),
		'1'
	);
	assert.equal(
		execFileSync('sqlite3', [upgradeDatabase], {
			input: "SELECT count(*) FROM pragma_table_info('forwarding_rules') WHERE name='enabled_at';"
		})
			.toString()
			.trim(),
		'1'
	);
	assert.equal(
		execFileSync('sqlite3', [upgradeDatabase], {
			input: "SELECT dflt_value FROM pragma_table_info('emails') WHERE name='attachments_ready';"
		})
			.toString()
			.trim(),
		'0'
	);

	sqlite(`
		PRAGMA foreign_keys=ON;
		INSERT INTO users (id,email,name,password_hash) VALUES ('u','owner@example.net','Owner','hash');
		INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled) VALUES ('d','noroshi.example','verified',1,1);
		INSERT INTO addresses (id,user_id,domain_id,address,is_default,created_at) VALUES ('a','u','d','info@noroshi.example',1,datetime('now'));
		INSERT INTO forwarding_destinations (id,user_id,source_address_id,destination_address,status,created_at,updated_at)
		VALUES ('dest','u','a','archive@outside.example','verified',datetime('now'),datetime('now'));
		INSERT INTO forwarding_rules (id,user_id,source_address_id,destination_id,status,created_at,updated_at)
		VALUES ('rule','u','a','dest','enabled',datetime('now'),datetime('now'));
		INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,forwarding_hop)
		VALUES ('email','u','inbound','sender@example.net','info@noroshi.example','Hello',0);
		INSERT INTO forwarding_attempts
		(id,rule_id,email_id,status,attempt_count,next_attempt_at,hop,destination_id,destination_address,created_at,updated_at)
		VALUES ('attempt','rule','email','queued',0,datetime('now'),0,'dest','archive@outside.example',datetime('now'),datetime('now'));
	`);

	const claim = (token) => `
		UPDATE forwarding_attempts
		SET status='processing', lease_token='${token}', lease_expires_at=datetime('now','+5 minutes'),
		    attempt_count=attempt_count+1, last_attempt_at=datetime('now'), updated_at=datetime('now')
		WHERE id='attempt' AND attempt_count < 4
		  AND status IN ('queued','failed') AND next_attempt_at <= datetime('now');
		SELECT changes();
	`;
	const sqlOne = join(temp, 'one.sql');
	const sqlTwo = join(temp, 'two.sql');
	const outOne = join(temp, 'one.out');
	const outTwo = join(temp, 'two.out');
	writeFileSync(sqlOne, claim('one'));
	writeFileSync(sqlTwo, claim('two'));
	await Promise.all([runProcess(sqlOne, outOne), runProcess(sqlTwo, outTwo)]);
	const outcomes = [outOne, outTwo].map((path) => Number(readFileSync(path, 'utf8').trim() || 0));
	assert.deepEqual(outcomes.sort(), [0, 1]);
	assert.equal(
		sqlite("SELECT status || '|' || attempt_count FROM forwarding_attempts WHERE id='attempt'"),
		'processing|1'
	);

	// Same provider delivery + recipient is one inbox row; another recipient is independent.
	sqlite(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
	        VALUES ('delivery-one','u','inbound','sender@example.net','first@example.net','One','provider');`);
	sqlite(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
	        VALUES ('delivery-duplicate','u','inbound','sender@example.net','FIRST@example.net','Dup','provider');`);
	sqlite(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
	        VALUES ('delivery-two','u','inbound','sender@example.net','second@example.net','Two','provider');`);
	assert.equal(sqlite("SELECT count(*) FROM emails WHERE provider_id='provider'"), '2');

	console.log('forwarding MVP fresh migrations, recipient identity, and atomic claim race: PASS');
} finally {
	rmSync(temp, { recursive: true, force: true });
}
