// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// index.js is read as text rather than imported: importing it would open the
// WebSocket connection to Gladys.
const entryPoint = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      entryPoint.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler in index.js`,
    );
  }
});

test('every config_schema key that stores a value is known to the code', () => {
  for (const field of manifest.config_schema ?? []) {
    if (field.type === 'section') {
      // A section stores NO value: its key must never leak into the config.
      assert.ok(
        !(field.key in DEFAULT_CONFIG),
        `section "${field.key}" stores no value and must not appear in DEFAULT_CONFIG`,
      );
      continue;
    }
    assert.ok(field.key in DEFAULT_CONFIG, `DEFAULT_CONFIG is missing the key "${field.key}"`);
  }
});

test('the manifest declares a bidirectional communication channel', () => {
  // Contract B.15: `messaging` is mandatory for a communication integration,
  // and `contact_schema` is forbidden when messages can be received — the
  // linking happens by code in the channel, not through per-user credentials.
  assert.equal(manifest.type, 'communication');
  assert.deepEqual(manifest.messaging, { receive: true });
  assert.equal(manifest.contact_schema, undefined);
});

test('the manifest version matches the docker image tag', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image "${manifest.docker_image}" must be tagged with the manifest version`,
  );
});

test('the config_schema sections follow the rules Gladys enforces', () => {
  // A section breaking these rules rejects the whole manifest (indexer and
  // server): only the known config field keys, en label, plain-text
  // description of 1-1000 characters per language, 1-5 https links made of
  // url + label only, and none of the value-related properties.
  // Mirrors CONFIG_FIELD_FIELDS / SECTION_LINK_FIELDS of the core validator.
  const configFieldKeys = [
    'key',
    'type',
    'label',
    'description',
    'placeholder',
    'required',
    'default',
    'min',
    'max',
    'options',
    'source',
    'display',
    'links',
  ];
  for (const field of (manifest.config_schema ?? []).filter((f) => f.type === 'section')) {
    for (const property of Object.keys(field)) {
      assert.ok(
        configFieldKeys.includes(property),
        `section "${field.key}" has an unknown key "${property}"`,
      );
    }
    assert.equal(typeof field.label?.en, 'string', `section "${field.key}" needs an en label`);
    for (const text of Object.values(field.description ?? {})) {
      assert.ok(
        text.length >= 1 && text.length <= 1000,
        `section "${field.key}" description must be 1-1000 characters`,
      );
    }
    for (const property of ['required', 'default', 'placeholder']) {
      assert.ok(!(property in field), `section "${field.key}" must not declare "${property}"`);
    }
    if (field.links !== undefined) {
      assert.ok(
        Array.isArray(field.links) && field.links.length >= 1 && field.links.length <= 5,
        `section "${field.key}" links must be a list of 1-5 links`,
      );
    }
    for (const link of field.links ?? []) {
      for (const property of Object.keys(link)) {
        assert.ok(
          ['url', 'label'].includes(property),
          `section "${field.key}" link has an unknown key "${property}"`,
        );
      }
      assert.match(link.url, /^https:\/\//, `section "${field.key}" link must be https`);
      assert.equal(
        typeof link.label?.en,
        'string',
        `section "${field.key}" link needs an en label`,
      );
    }
  }
});
