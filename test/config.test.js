import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults for an empty config', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test('normalizeConfig trims the token', () => {
  const config = normalizeConfig({ telegram_api_token: '  123456:ABC-DEF  ' });
  assert.equal(config.telegram_api_token, '123456:ABC-DEF');
});

test('normalizeConfig keeps unknown keys (forward compatibility)', () => {
  const config = normalizeConfig({ telegram_api_token: 't', GLADYS_PREFER_LOCAL: false });
  assert.equal(config.GLADYS_PREFER_LOCAL, false);
});
