import { stdin, stderr } from 'node:process';

type TtyInput = NodeJS.ReadableStream & {
	isTTY?: boolean;
	isRaw?: boolean;
	isPaused?(): boolean;
	setRawMode?(value: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
};

type TtyOutput = NodeJS.WritableStream & {
	isTTY?: boolean;
	write(chunk: string): boolean;
};

export async function readMaskedSecret({
	input = stdin,
	output = stderr,
	prompt = 'Noroshi API token: '
}: {
	input?: TtyInput;
	output?: TtyOutput;
	prompt?: string;
} = {}): Promise<string> {
	if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
		throw new Error(
			'Token entry requires an interactive TTY. Run the login command in a terminal or provide NOROSHI_TOKEN through a secret input broker.'
		);
	}

	return new Promise<string>((resolve, reject) => {
		let value = '';
		const previousRaw = Boolean(input.isRaw);
		const wasPaused = input.isPaused?.() ?? false;
		let settled = false;

		const cleanup = () => {
			input.off('data', onData);
			input.off('error', onError);
			input.setRawMode?.(previousRaw);
			if (wasPaused) input.pause();
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			output.write('\n');
			cleanup();
			if (!value) reject(new Error('Noroshi API token is required.'));
			else resolve(value);
		};
		const abort = () => {
			if (settled) return;
			settled = true;
			output.write('\n');
			cleanup();
			reject(new Error('Token entry was cancelled.'));
		};
		const onError = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error('Token entry failed.'));
		};
		const onData = (chunk: string | Buffer) => {
			for (const character of chunk.toString()) {
				if (character === '\r' || character === '\n') {
					finish();
					return;
				}
				if (character === '\u0003') {
					abort();
					return;
				}
				if (character === '\u007f' || character === '\b') {
					if (value.length > 0) {
						value = value.slice(0, -1);
						output.write('\b \b');
					}
					continue;
				}
				if (/^[\x20-\x7e]$/u.test(character)) {
					value += character;
					output.write('*');
				}
			}
		};

		output.write(prompt);
		input.setRawMode?.(true);
		input.resume();
		input.on('data', onData);
		input.on('error', onError);
	});
}

export async function resolveLoginToken({
	argumentToken,
	environmentToken,
	input = stdin,
	output = stderr
}: {
	argumentToken?: string;
	environmentToken?: string;
	input?: TtyInput;
	output?: TtyOutput;
}): Promise<string> {
	if (argumentToken !== undefined) {
		throw new Error(
			'Tokens are not accepted on the command line. Omit --token and enter it at the masked prompt.'
		);
	}
	if (environmentToken) return environmentToken;
	return readMaskedSecret({ input, output });
}
