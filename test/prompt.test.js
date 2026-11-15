import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/prompt.js';

test('system prompt is identical between calls so it can be cached', () => {
  assert.equal(systemPrompt('Clodine'), systemPrompt('Clodine'));
});

test('system prompt has no dates or times in it', () => {
  const text = systemPrompt('Clodine');
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(text, /\d{1,2}:\d{2}/);
});

test('system prompt says when to save and run skills only when skills are on', () => {
  assert.match(systemPrompt('Clodine'), /save it with skill save.*use skill run instead/);
  assert.doesNotMatch(systemPrompt('Clodine', [], { skills: false }), /skill save|skill run/);
});

test('system prompt uses the bot name', () => {
  assert.match(systemPrompt('Clodine'), /You are Clodine/);
});
