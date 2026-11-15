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

test('gestures default to on and must be true or false', () => {
  const raw = copy();
  delete raw.bot.gestures;
  assert.equal(validateConfig(raw, env).bot.gestures, true);
  raw.bot.gestures = false;
  assert.equal(validateConfig(raw, env).bot.gestures, false);
  raw.bot.gestures = 'no';
  assert.throws(() => validateConfig(raw, env), /bot\.gestures/);
});

test('xray defaults to off and must be true or false', () => {
  const raw = copy();
  assert.equal(validateConfig(raw, env).bot.xray, false);
  delete raw.bot.xray;
  assert.equal(validateConfig(raw, env).bot.xray, false);
  raw.bot.xray = true;
  assert.equal(validateConfig(raw, env).bot.xray, true);
  raw.bot.xray = 'yes';
  assert.throws(() => validateConfig(raw, env), /bot\.xray/);
});

test('reflexes default to on and must be true or false', () => {
  const raw = copy();
  delete raw.bot.reflexes;
  assert.equal(validateConfig(raw, env).bot.reflexes, true);
  raw.bot.reflexes = false;
  assert.equal(validateConfig(raw, env).bot.reflexes, false);
  raw.bot.reflexes = 'no';
  assert.throws(() => validateConfig(raw, env), /bot\.reflexes/);
});

test('lessons and skills default to on and must be true or false', () => {
  const raw = copy();
  assert.deepEqual(validateConfig(raw, env).learning, { lessons: true, skills: true });
  delete raw.learning;
  assert.deepEqual(validateConfig(raw, env).learning, { lessons: true, skills: true });
  raw.learning = { skills: false };
  assert.deepEqual(validateConfig(raw, env).learning, { lessons: true, skills: false });
  for (const key of ['lessons', 'skills']) {
    raw.learning = { [key]: 'no' };
    assert.throws(() => validateConfig(raw, env), new RegExp(`learning\\.${key}`));
  }
});

test('warnCostUsd defaults to 2 and must be a number, 0 or more', () => {
  const raw = copy();
  assert.equal(validateConfig(raw, env).limits.warnCostUsd, 2);
  delete raw.limits.warnCostUsd;
  const config = validateConfig(raw, env);
  assert.equal(config.limits.warnCostUsd, 2);
  assert.equal(config.limits.maxSteps, 25);
  raw.limits.warnCostUsd = 0;
  assert.equal(validateConfig(raw, env).limits.warnCostUsd, 0);
  raw.limits.warnCostUsd = 0.5;
  assert.equal(validateConfig(raw, env).limits.warnCostUsd, 0.5);
  raw.limits.warnCostUsd = -1;
  assert.throws(() => validateConfig(raw, env), /warnCostUsd/);
  raw.limits.warnCostUsd = '2';
  assert.throws(() => validateConfig(raw, env), /warnCostUsd/);
});

test('streaming defaults to on and can be turned off', () => {
  const raw = copy();
  assert.equal(validateConfig(raw, env).claude.streaming, true);
  delete raw.claude.streaming;
  assert.equal(validateConfig(raw, env).claude.streaming, true);
  raw.claude.streaming = false;
  assert.equal(validateConfig(raw, env).claude.streaming, false);
});

test('empty allowlist is rejected', () => {
  const raw = copy();
  raw.allowlist = [];
  assert.throws(() => validateConfig(raw, env), /allowlist/);
});
