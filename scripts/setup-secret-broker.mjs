import { inspect } from 'node:util';

const values = new WeakMap();
const allowedSecretNames = new Set([
	'BOOTSTRAP_SECRET',
	'AUTH_RATE_LIMIT_SECRET',
	'RESEND_API_KEY',
	'RESEND_WEBHOOK_SECRET'
]);

class OpaqueSecret {
	constructor(value) {
		values.set(this, value);
		Object.freeze(this);
	}

	toString() {
		return '[REDACTED]';
	}

	toJSON() {
		return '[REDACTED]';
	}

	[inspect.custom]() {
		return 'OpaqueSecret [REDACTED]';
	}
}

export function createOpaqueSecret(value) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError('secret value must be a non-empty string');
	}
	return new OpaqueSecret(value);
}

export function isOpaqueSecret(value) {
	return values.has(value);
}

export function withOpaqueSecret(secret, callback) {
	if (!isOpaqueSecret(secret)) throw new TypeError('expected an opaque secret');
	if (typeof callback !== 'function') throw new TypeError('secret callback is required');
	return callback(values.get(secret));
}

export function opaqueSecretsEqual(left, right) {
	return withOpaqueSecret(left, (leftValue) =>
		withOpaqueSecret(right, (rightValue) => leftValue === rightValue)
	);
}

export function putOpaqueSecret({ name, secret, put }) {
	if (!allowedSecretNames.has(name)) {
		throw new Error(`許可されていないWorkerシークレット名です: ${name}`);
	}
	if (!isOpaqueSecret(secret)) throw new TypeError('expected an opaque secret');
	if (typeof put !== 'function') throw new TypeError('native secret put callback is required');
	return withOpaqueSecret(secret, (value) => put(name, value));
}

// Local development only: injects the key into one child process's memory.
export function withLocalBootstrapEnvironment({
	secret,
	authRateLimitSecret,
	environment = process.env,
	launch
}) {
	if (!isOpaqueSecret(secret) || !isOpaqueSecret(authRateLimitSecret)) {
		throw new TypeError('expected opaque local runtime secrets');
	}
	if (typeof launch !== 'function') throw new TypeError('local dev launcher is required');
	const {
		QUICKMAIL_BOOTSTRAP_SECRET: _setupInput,
		QUICKMAIL_AUTH_RATE_LIMIT_SECRET: _rateInput,
		...safeEnvironment
	} = environment;
	return withOpaqueSecret(secret, (bootstrapValue) =>
		withOpaqueSecret(authRateLimitSecret, (authValue) =>
			launch({
				...safeEnvironment,
				BOOTSTRAP_SECRET: bootstrapValue,
				AUTH_RATE_LIMIT_SECRET: authValue
			})
		)
	);
}
