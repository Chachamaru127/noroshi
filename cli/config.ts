import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CliConfig = {
	url: string;
	token: string;
};

function configPath(): string {
	const override = process.env.NOROSHI_CONFIG;
	if (override) return override;
	const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
	return join(base, 'noroshi', 'config.json');
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
	const canonicalUrl = process.env.NOROSHI_URL;
	const canonicalToken = process.env.NOROSHI_TOKEN;
	if (canonicalUrl !== undefined || canonicalToken !== undefined) {
		if (!canonicalUrl || !canonicalToken) {
			throw new Error('NOROSHI_URL and NOROSHI_TOKEN must be set together.');
		}
		return { url: normalizeUrl(canonicalUrl), token: canonicalToken };
	}

	let raw: Partial<CliConfig>;
	try {
		raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<CliConfig>;
	} catch {
		throw new Error(
			'Not logged in. Run `noroshi login --url <instance>` and enter the token at the masked prompt, or set NOROSHI_URL and NOROSHI_TOKEN through a secret input broker.'
		);
	}

	const url = raw.url;
	const token = raw.token;
	if (!url || !token) {
		throw new Error(
			'Not logged in. Run `noroshi login --url <instance>` and enter the token at the masked prompt, or set NOROSHI_URL and NOROSHI_TOKEN through a secret input broker.'
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
	for (const path of new Set([configPath()])) {
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

export { configPath };
