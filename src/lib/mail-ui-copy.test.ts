import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { displayMailSubject } from './mail-ui-copy';

describe('displayMailSubject', () => {
	test('localizes empty and stored no-subject sentinels', () => {
		assert.equal(displayMailSubject(''), '（件名なし）');
		assert.equal(displayMailSubject('  '), '（件名なし）');
		assert.equal(displayMailSubject('(no subject)'), '（件名なし）');
		assert.equal(displayMailSubject(null), '（件名なし）');
	});

	test('preserves a user subject', () => {
		assert.equal(displayMailSubject(' Project update '), 'Project update');
	});
});
