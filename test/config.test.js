import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfig, ConfigError } from '../src/config.js';

const example = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
const env = { ANTHROPIC_API_KEY: 'test-key' };

function copy() {
  return structuredClone(example);
}

test('example config passes', () => {
  const config = validateConfig(copy(), env);
  assert.equal(config.bot.username, 'Clodine');
  assert.equal(config.server.version, '26.1');
});

test('missing API key is rejected', () => {
  assert.throws(() => validateConfig(copy(), {}), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /ANTHROPIC_API_KEY/);
    return true;
  });
});

test('missing version is rejected', () => {
  const raw = copy();
  delete raw.server.version;
  assert.throws(() => validateConfig(raw, env), /server\.version/);
});

test('missing username is rejected', () => {
  const raw = copy();
  raw.bot.username = '';
  assert.throws(() => validateConfig(raw, env), /bot\.username/);
});

test('empty allowlist is rejected', () => {
  const raw = copy();
  raw.allowlist = [];
  assert.throws(() => validateConfig(raw, env), /allowlist/);
});
