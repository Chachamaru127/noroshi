import type { D1Database } from '@cloudflare/workers-types';
import type { ProviderDomain } from './email-provider';
import { hashPassword } from './crypto';

export async function finalizeSetup(
	db: D1Database,
	leaseToken: string,
	input: { domain: ProviderDomain; localPart: string; name: string; password: string }
): Promise<{ userId: string; address: string }> {
	const localPart = input.localPart.trim().toLowerCase().replace(/@.*$/, '');
	if (!/^[a-z0-9._%+-]+$/i.test(localPart)) throw new Error('Invalid address');
	const address = `${localPart}@${input.domain.name.toLowerCase()}`;
	const userId = crypto.randomUUID();
	const addressId = crypto.randomUUID();
	const passwordHash = await hashPassword(input.password);
	const lease = `EXISTS (SELECT 1 FROM setup_bootstrap_claim WHERE singleton = 1
		AND lease_token = ? AND julianday(expires_at) > julianday('now'))`;
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO domains (id,name,status,region,sending_enabled,receiving_enabled,synced_at)
				 SELECT ?,CASE WHEN ${lease} THEN ? ELSE NULL END,?,?,?,?,datetime('now')`
			)
			.bind(
				input.domain.id,
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
			.bind(userId, input.domain.id, leaseToken),
		db
			.prepare(
				`INSERT INTO addresses (id,user_id,domain_id,address,is_default)
				 SELECT ?,?,?,CASE WHEN ${lease} THEN ? ELSE NULL END,1`
			)
			.bind(addressId, userId, input.domain.id, leaseToken, address)
	]);
	if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
		throw new Error('Setup lease expired');
	}
	return { userId, address };
}
