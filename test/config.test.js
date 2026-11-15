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

test('pauseScale defaults to 1 and must be a number, 0 or more', () => {
  const raw = copy();
  delete raw.bot.pauseScale;
  const config = validateConfig(raw, env);
  assert.equal(config.bot.pauseScale, 1);
  assert.equal(config.bot.username, 'Clodine');
  raw.bot.pauseScale = 0;
  assert.equal(validateConfig(raw, env).bot.pauseScale, 0);
  raw.bot.pauseScale = -1;
  assert.throws(() => validateConfig(raw, env), /pauseScale/);
});

test('empty allowlist is rejected', () => {
  const raw = copy();
  raw.allowlist = [];
  assert.throws(() => validateConfig(raw, env), /allowlist/);
});
