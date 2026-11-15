import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meters, costOf, JobRecord, JobLog, summaryLine } from '../src/joblog.js';

test('meters keep the cache write split when the API gives one', () => {
  assert.deepEqual(meters({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 }), {
    input: 1,
    cacheRead: 2,
    cacheWrite: 3,
    output: 4
  });
  const split = meters({ input_tokens: 1, cache_creation_input_tokens: 30, output_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } });
  assert.equal(split.cacheRead, 0);
  assert.equal(split.cacheWrite5m, 10);
  assert.equal(split.cacheWrite1h, 20);
  assert.deepEqual(meters(undefined), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});

test('cost uses the price of each meter', () => {
  const million = { input: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, output: 1e6 };
  // 4 + 0.20 + 5 + 8 + 20
  assert.equal(costOf('claude-opus-5-5', million), 37.2);
  // 2 + 0.10 + 2.50 + 4 + 10
  assert.equal(costOf('claude-sonnet-5-5', million), 18.6);
  // Writes without a split are priced as 5 minute writes.
  assert.equal(costOf('claude-opus-5-5', { input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }), 5);
});

test('Haiku 5.5 switches to its long prompt prices over 100K tokens', () => {
  assert.equal(costOf('claude-haiku-5-5', { input: 1e5, cacheRead: 0, cacheWrite: 0, output: 0 }), 0.01);
  assert.equal(costOf('claude-haiku-5-5', { input: 2e5, cacheRead: 0, cacheWrite: 0, output: 0 }), 0.1);
});

test('a model with no known price gets a null cost but keeps its tokens', () => {
  const record = new JobRecord({ player: 'Steve', text: 'hi' });
  record.step('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }, 5);
  record.step('some-other-model', { input_tokens: 10, output_tokens: 1 }, 5);
  const line = record.finish('done');
  assert.equal(line.steps[1].cost, null);
  assert.equal(line.totals.cost, null);
  assert.equal(line.totals.tokens.input, 20);
});

test('totals add up model and tool time across calls', () => {
  const record = new JobRecord({ self: true });
  record.call('router', 'claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }, 100);
  const step = record.step('claude-sonnet-5-5', { input_tokens: 10, output_tokens: 2 }, 400);
  step.tools.push({ name: 'mine', ok: true, ms: 1500 }, { name: 'craft', ok: false, ms: 500 });
  const line = record.finish('replaced');
  assert.equal(line.freeTime, true);
  assert.equal(line.player, null);
  assert.equal(line.end, 'replaced');
  assert.equal(line.totals.modelMs, 500);
  assert.equal(line.totals.toolMs, 2000);
  assert.equal(line.totals.steps, 1);
  assert.equal(record.finished, true);
  assert.match(summaryLine(line), /^\[job\] replaced: 1 steps, model 0\.5s, tools 2\.0s, tokens in 15, cache read 0, cache write 0, out 3, \$0\.\d{4}$/);
});

test('a held job records its holds, and the summary says how long it was held', () => {
  const record = new JobRecord({ player: 'Steve', text: 'mine' });
  record.step('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }, 5);
  assert.equal(record.finish('done').holds, 0);
  record.holds = 2;
  record.heldMs = 12500;
  const line = record.finish('done');
  assert.equal(line.holds, 2);
  assert.equal(line.heldMs, 12500);
  assert.equal('resumed' in line, false);
  assert.match(summaryLine(line), /, held 12\.5s$/);
});

test('the cost so far adds up every call, and turns unknown once any call has no price', () => {
  const record = new JobRecord({ player: 'Steve', text: 'mine' });
  assert.equal(record.cost, 0);
  record.step('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0 }, 5);
  record.call('busy', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0 }, 5);
  assert.equal(record.cost, 6);
  record.step('some-other-model', { input_tokens: 10, output_tokens: 1 }, 5);
  assert.equal(record.cost, null);
});

test('cost warnings go in the line, and the summary counts them', () => {
  const record = new JobRecord({ player: 'Steve', text: 'mine' });
  record.step('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }, 5);
  const quiet = record.finish('done');
  assert.equal(quiet.costWarnings, 0);
  assert.doesNotMatch(summaryLine(quiet), /cost warnings/);
  record.costWarnings = 2;
  assert.match(summaryLine(record.finish('done')), /, cost warnings 2$/);
});

test('the job log appends one JSON line per job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joblog-'));
  try {
    const path = join(dir, 'jobs.jsonl');
    const log = new JobLog(path, () => {});
    log.write({ end: 'done' });
    log.write({ end: 'stop' });
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ end: 'done' }, { end: 'stop' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file error is logged instead of thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joblog-'));
  try {
    const logged = [];
    const log = new JobLog(join(dir, 'missing', 'jobs.jsonl'), (text) => logged.push(text));
    assert.doesNotThrow(() => log.write({ end: 'done' }));
    assert.match(logged[0], /couldn't write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
