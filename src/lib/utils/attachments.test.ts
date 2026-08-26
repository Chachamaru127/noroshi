import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPreviewableInline, remainingAttachmentSlots } from './attachments';

test('counts forwarded and newly uploaded files against one attachment limit', () => {
	assert.equal(remainingAttachmentSlots(0, 5), 0);
	assert.equal(remainingAttachmentSlots(0, 4), 1);
	assert.equal(remainingAttachmentSlots(1, 4), 0);
	assert.equal(remainingAttachmentSlots(0, 3), 2);
});

test('only safe raster images are previewed inline', () => {
	assert.equal(isPreviewableInline('image/png'), true);
	assert.equal(isPreviewableInline('image/jpeg; charset=binary'), true);
	assert.equal(isPreviewableInline('image/svg+xml'), false);
	assert.equal(isPreviewableInline('text/html'), false);
	assert.equal(isPreviewableInline('application/pdf'), false);
});
