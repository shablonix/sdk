const test = require('node:test');
const assert = require('node:assert/strict');

const sdk = require('../dist/index.cjs');

test('CommonJS build exposes the same public API', () => {
  assert.equal(typeof sdk.Shablonix, 'function');
  assert.equal(sdk.Shablonix, sdk.ShablonixClient);
  assert.equal(typeof sdk.ShablonixApiError, 'function');
  assert.equal(typeof sdk.constructWebhookEvent, 'function');
  assert.equal(typeof sdk.verifyWebhookSignature, 'function');
  assert.ok(new sdk.ShablonixApiError('boom', 500) instanceof sdk.ShablonixError);
});
