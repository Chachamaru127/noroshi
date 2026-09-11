import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readMaskedSecret, resolveLoginToken } from './secret-prompt.ts';

function ttyStreams() {
	const input = new PassThrough() as PassThrough & {
		isTTY: boolean;
		isRaw: boolean;
		setRawMode(value: boolean): void;
	};
	input.isTTY = true;
	input.isRaw = false;
	input.setRawMode = (value) => {
		input.isRaw = value;
	};
	const output = new PassThrough() as PassThrough & { isTTY: boolean };
	output.isTTY = true;
	let visible = '';
	output.on('data', (chunk) => {
		visible += chunk.toString('utf8');
	});
	return { input, output, visible: () => visible };
}

test('masked token prompt accepts edits without echoing the token', async () => {
	const streams = ttyStreams();
	const reading = readMaskedSecret({
		input: streams.input,
		output: streams.output,
		prompt: 'API token: '
	});
	streams.input.write('nr_live_abx');
	streams.input.write('\u007f');
	streams.input.write('c\n');
	assert.equal(await reading, 'nr_live_abc');
	assert.doesNotMatch(streams.visible(), /nr_live|abc|abx/u);
	assert.match(streams.visible(), /^API token: \*+/u);
	assert.equal(streams.input.isRaw, false);
});

test('login token resolution rejects argv and fails closed without an interactive TTY', async () => {
	await assert.rejects(
		() => resolveLoginToken({ argumentToken: 'must-not-echo', environmentToken: undefined }),
		(error: Error) =>
			!error.message.includes('must-not-echo') && /command line/u.test(error.message)
	);
	await assert.rejects(
		() =>
			resolveLoginToken({
				argumentToken: undefined,
				environmentToken: undefined,
				input: new PassThrough(),
				output: new PassThrough()
			}),
		/interactive TTY/u
	);
});

test('environment token bypasses the prompt', async () => {
	assert.equal(
		await resolveLoginToken({
			argumentToken: undefined,
			environmentToken: 'nr_live_environment_fixture'
		}),
		'nr_live_environment_fixture'
	);
});
