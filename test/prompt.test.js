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

test('system prompt says to answer a question about her thinking as a status report', () => {
  assert.match(systemPrompt('Clodine'), /asks what you're thinking or why you did something, answer in your own words like a status report: .*Don't narrate or quote your reasoning\./);
});

test('system prompt says when to start a standing job only when standing jobs are on', () => {
  assert.match(systemPrompt('Clodine'), /work to go on until told to stop.*standing_job, but never for a one-off job/);
  assert.doesNotMatch(systemPrompt('Clodine', [], { standing: false }), /standing_job|standing job/);
});

test('system prompt uses the bot name', () => {
  assert.match(systemPrompt('Clodine'), /You are Clodine/);
});
