import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CliConfig = {
	url: string;
	token: string;
};

function configPath(): string {
	const override = process.env.NOROSHI_CONFIG ?? process.env.QUICKMAIL_CONFIG;
	if (override) return override;
	const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
	return join(base, 'noroshi', 'config.json');
}

function legacyConfigPath(): string {
	if (process.env.NOROSHI_CONFIG || process.env.QUICKMAIL_CONFIG) return configPath();
	const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
	return join(base, 'quickmail', 'config.json');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Require http(s). HTTP is only allowed for loopback. Never echo the input. */
export function normalizeUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new Error('Noroshi URL is invalid.');
	}

	if (parsed.username || parsed.password) {
		throw new Error('Noroshi URL must not include credentials.');
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Noroshi URL must use http or https.');
	}

	if (!parsed.hostname) {
		throw new Error('Noroshi URL is invalid.');
	}

	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(host)) {
		throw new Error('HTTP is only allowed for localhost.');
	}

	return parsed.href.replace(/\/+$/, '');
}

export async function loadConfig(): Promise<CliConfig> {
	const envUrl = process.env.NOROSHI_URL ?? process.env.QUICKMAIL_URL;
	const envToken = process.env.NOROSHI_TOKEN ?? process.env.QUICKMAIL_TOKEN;
	if (envUrl && envToken) {
		return { url: normalizeUrl(envUrl), token: envToken };
	}

	let raw: Partial<CliConfig>;
	try {
		try {
			raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<CliConfig>;
		} catch {
			raw = JSON.parse(await readFile(legacyConfigPath(), 'utf8')) as Partial<CliConfig>;
		}
	} catch {
		throw new Error(
			'Not logged in. Run `noroshi login --url <instance> --token <key>` or set NOROSHI_URL and NOROSHI_TOKEN. QUICKMAIL_URL and QUICKMAIL_TOKEN remain supported aliases.'
		);
	}

	const url = envUrl ?? raw.url;
	const token = envToken ?? raw.token;
	if (!url || !token) {
		throw new Error(
			'Not logged in. Run `noroshi login --url <instance> --token <key>` or set NOROSHI_URL and NOROSHI_TOKEN. QUICKMAIL_URL and QUICKMAIL_TOKEN remain supported aliases.'
		);
	}
	return { url: normalizeUrl(url), token };
}

export async function saveConfig(config: CliConfig): Promise<string> {
	const path = configPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ url: normalizeUrl(config.url), token: config.token }, null, 2)}\n`,
		{ mode: 0o600 }
	);
	await chmod(path, 0o600);
	return path;
}

export async function clearConfig(): Promise<void> {
	for (const path of new Set([configPath(), legacyConfigPath()])) {
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

export { configPath };
