import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay, reasonText, isPermanentKick } from '../src/connection.js';

test('reconnect delay doubles from 5s and caps at 60s', () => {
  const delays = [0, 1, 2, 3, 4, 5].map((attempt) => nextDelay(attempt, 5, 60));
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('kick reason text from a JSON chat component', () => {
  const reason = JSON.stringify({ translate: 'multiplayer.disconnect.not_whitelisted' });
  assert.equal(reasonText(reason), 'multiplayer.disconnect.not_whitelisted');
});

test('kick reason text from plain text with extra parts', () => {
  assert.equal(reasonText({ text: 'You are ', extra: [{ text: 'banned' }] }), 'You are banned');
});

test('kick reason text from an NBT chat component', () => {
  const reason = {
    type: 'compound',
    value: {
      translate: { type: 'string', value: 'multiplayer.disconnect.not_whitelisted' }
    }
  };
  assert.equal(reasonText(reason), 'multiplayer.disconnect.not_whitelisted');
});

test('whitelist, ban and outdated kicks are permanent', () => {
  assert.ok(isPermanentKick('multiplayer.disconnect.not_whitelisted'));
  assert.ok(isPermanentKick('You are not white-listed on this server!'));
  assert.ok(isPermanentKick('You are banned from this server.'));
  assert.ok(isPermanentKick('Outdated client! Please use 26.3'));
});

test('a normal disconnect is not permanent', () => {
  assert.equal(isPermanentKick('Server closed'), false);
  assert.equal(isPermanentKick('Timed out'), false);
});
