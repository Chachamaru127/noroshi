import type { D1Database } from '@cloudflare/workers-types';
import type { ProviderDomain } from './email-provider';
import { hashPassword } from './crypto';

export async function finalizeSetup(
	db: D1Database,
	leaseToken: string,
	input: { domain: ProviderDomain; localPart: string; name: string; password: string }
): Promise<{ userId: string; address: string }> {
	const domainName = input.domain.name.trim().toLowerCase();
	const [userCount, domainCount, existingByName, existingById] = await Promise.all([
		db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>(),
		db.prepare('SELECT COUNT(*) AS count FROM domains').first<{ count: number }>(),
		db
			.prepare('SELECT id,name FROM domains WHERE name = ? COLLATE NOCASE')
			.bind(domainName)
			.first<{ id: string; name: string }>(),
		db
			.prepare('SELECT id,name FROM domains WHERE id = ?')
			.bind(input.domain.id)
			.first<{ id: string; name: string }>()
	]);
	if ((userCount?.count ?? 0) !== 0) throw new Error('Setup already completed');
	if ((domainCount?.count ?? 0) > 1 || ((domainCount?.count ?? 0) === 1 && !existingByName)) {
		throw new Error('Existing setup domain does not match');
	}
	if (existingById && existingById.name.toLowerCase() !== domainName) {
		throw new Error('Provider domain id collision');
	}
	if (existingByName && existingById && existingByName.id !== existingById.id) {
		throw new Error('Ambiguous setup domain');
	}
	const domainId = existingByName?.id ?? input.domain.id;
	const localPart = input.localPart.trim().toLowerCase().replace(/@.*$/, '');
	if (!/^[a-z0-9._%+-]+$/i.test(localPart)) throw new Error('Invalid address');
	const address = `${localPart}@${domainName}`;
	const userId = crypto.randomUUID();
	const addressId = crypto.randomUUID();
	const passwordHash = await hashPassword(input.password);
	const lease = `EXISTS (SELECT 1 FROM setup_bootstrap_claim WHERE singleton = 1
		AND lease_token = ? AND julianday(expires_at) > julianday('now'))`;
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO domains (id,name,status,region,sending_enabled,receiving_enabled,synced_at)
				 SELECT ?,CASE WHEN ${lease} THEN ? ELSE NULL END,?,?,?,?,datetime('now')
				 ON CONFLICT(name) DO UPDATE SET
				  name=excluded.name,
				  status=excluded.status,
				  region=excluded.region,
				  sending_enabled=excluded.sending_enabled,
				  receiving_enabled=excluded.receiving_enabled,
				  synced_at=excluded.synced_at`
			)
			.bind(
				domainId,
				leaseToken,
				input.domain.name.toLowerCase(),
				input.domain.status,
				input.domain.region ?? null,
				input.domain.sendingEnabled ? 1 : 0,
				input.domain.receivingEnabled ? 1 : 0
			),
		db
			.prepare(
				`INSERT INTO users (id,email,name,password_hash,is_admin)
				 SELECT ?,CASE WHEN ${lease} THEN ? ELSE NULL END,?,?,1
				 WHERE NOT EXISTS (SELECT 1 FROM users)`
			)
			.bind(userId, leaseToken, address, input.name.trim(), passwordHash),
		db
			.prepare(`UPDATE domains SET catchall_user_id = ? WHERE id = ? AND ${lease}`)
			.bind(userId, domainId, leaseToken),
		db
			.prepare(
				`INSERT INTO addresses (id,user_id,domain_id,address,is_default)
				 SELECT ?,?,?,CASE WHEN ${lease} THEN ? ELSE NULL END,1`
			)
			.bind(addressId, userId, domainId, leaseToken, address)
	]);
	if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
		throw new Error('Setup lease expired');
	}
	return { userId, address };
}
