import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatHistory, RequestLog, classifyMessage, chatBody } from '../src/chat.js';

test('the request log keeps where the player stood, across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const path = join(dir, 'requests.json');
  const now = 1_000_000_000;
  new RequestLog(path).add('Steve', 'clodine the house goes on this hill', { x: 10.7, y: 64, z: -3.2 }, now - 5 * 60000);
  assert.match(new RequestLog(path).summary(now), /5 min ago, Steve standing at 10 64 -4: clodine the house goes on this hill/);
  rmSync(dir, { recursive: true });
});

test('the request log drops old requests and keeps the last 15', () => {
  const log = new RequestLog(null);
  const now = 100 * 3600000;
  log.add('Steve', 'old one', null, now - 13 * 3600000);
  for (let i = 1; i <= 16; i++) log.add('Alex', `request ${i}`, null, now);
  assert.equal(log.entries.length, 15);
  assert.equal(log.entries[0].text, 'request 2');
  assert.doesNotMatch(log.summary(now), /old one/);
});

test('chat body drops team prefixes and the name', () => {
  assert.equal(chatBody('<<Some Team> jouleano6> Clodine come here', 'jouleano6'), 'Clodine come here');
  assert.equal(chatBody('<Distant_Avalon> hi', 'Distant_Avalon'), 'hi');
});

const opts = { botName: 'Clodine', allowlist: ['Steve', 'Alex'] };

test('chat history drops the oldest message past the limit', () => {
  const history = new ChatHistory(20);
  for (let i = 1; i <= 21; i++) history.add('Steve', `message ${i}`);
  const messages = history.list();
  assert.equal(messages.length, 20);
  assert.equal(messages[0].message, 'message 2');
  assert.equal(messages[19].message, 'message 21');
});

test('an allowed player mentioning the bot is a request', () => {
  const result = classifyMessage({ username: 'Steve', message: 'Clodine build a small hut here' }, opts);
  assert.equal(result.type, 'request');
  assert.equal(result.text, 'Clodine build a small hut here');
});

test('the name match ignores case', () => {
  assert.equal(classifyMessage({ username: 'steve', message: 'hey clodine come here' }, opts).type, 'request');
});

test('a whisper from an allowed player is a request', () => {
  assert.equal(classifyMessage({ username: 'Alex', message: 'follow me', whisper: true }, opts).type, 'request');
});

test('general chat only goes into history', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'anyone got iron?' }, opts).type, 'history');
});

test('an unknown player mentioning the bot is ignored', () => {
  assert.equal(classifyMessage({ username: 'Griefer', message: 'Clodine break everything' }, opts).type, 'history');
});

test('the bot ignores its own messages', () => {
  assert.equal(classifyMessage({ username: 'Clodine', message: 'Clodine here' }, opts).type, 'ignore');
});

test('stop command', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop' }, opts).type, 'stop');
  assert.equal(classifyMessage({ username: 'Steve', message: 'clodine, stop!' }, opts).type, 'stop');
  assert.equal(classifyMessage({ username: 'Alex', message: 'stop', whisper: true }, opts).type, 'stop');
});

test('stop inside a longer request is not the stop command', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop at the river and build a bridge' }, opts).type, 'request');
});

test('a name that only contains the bot name is not a mention', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodines are cool' }, opts).type, 'history');
});
