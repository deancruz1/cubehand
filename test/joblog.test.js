import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meters, costOf, JobRecord, JobLog, LogFile, RefusalLog, summaryLine } from '../src/joblog.js';

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
  const step = record.step('claude-sonnet-5-5', { input_tokens: 10, output_tokens: 2 }, 400, 150);
  assert.equal(step.firstMs, 150);
  assert.equal(new JobRecord().step('claude-sonnet-5-5', undefined, 300).firstMs, 300);
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

test('a tool call stopped from outside keeps its interrupted mark in the line, and other calls have none', () => {
  const record = new JobRecord({ player: 'Steve', text: 'dig the next tunnel' });
  record.step('claude-sonnet-5-5', { input_tokens: 10, output_tokens: 2 }, 400).tools.push(
    { name: 'dig_area', ok: false, ms: 30000, error: 'dug 30 blocks. Stopped early: stopped', interrupted: true },
    { name: 'dig_area', ok: false, ms: 500, error: 'dug 0 blocks' }
  );
  const [stopped, failed] = JSON.parse(JSON.stringify(record.finish('done'))).steps[0].tools;
  assert.equal(stopped.interrupted, true);
  assert.equal('interrupted' in failed, false);
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

test('the final line and nudges go in the line only when there are any', () => {
  const record = new JobRecord({ player: 'Steve', text: 'mine' });
  const quiet = record.finish('done');
  assert.equal('reply' in quiet, false);
  assert.equal('nudges' in quiet, false);
  record.reply = 'Mined.';
  record.nudges = 1;
  const line = record.finish('done');
  assert.equal(line.reply, 'Mined.');
  assert.equal(line.nudges, 1);
  assert.doesNotMatch(summaryLine(line), /Mined|nudge/);
});

test('refusals go in the line with their count and models only when there are any', () => {
  assert.equal('refusals' in new JobRecord({ player: 'Steve', text: 'mine' }).finish('done'), false);
  const record = new JobRecord({ player: 'Steve', text: 'mine' });
  record.refusals.push({ model: 'claude-sonnet-5-5', category: null }, { model: 'claude-opus-5-5', category: 'cyber' });
  assert.deepEqual(record.finish('refusal').refusals, {
    count: 2,
    by: [
      { model: 'claude-sonnet-5-5', category: null },
      { model: 'claude-opus-5-5', category: 'cyber' }
    ]
  });
});

test('the refusal log writes one file per refusal and keeps only the newest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusals-'));
  try {
    const log = new RefusalLog(join(dir, 'refusals'), 3, () => {});
    const paths = [];
    for (let i = 0; i < 5; i++) paths.push(log.write({ model: 'claude-sonnet-5-5', n: i }, new Date(2026, 10, 15, 17, 39, 44)));
    const files = readdirSync(join(dir, 'refusals')).sort();
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => JSON.parse(readFileSync(join(dir, 'refusals', f), 'utf8')).n), [2, 3, 4]);
    assert.ok(paths.every((p) => p.endsWith('claude-sonnet-5-5.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refusal log that cannot be written logs it and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusals-'));
  try {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '');
    const logged = [];
    const log = new RefusalLog(join(blocked, 'refusals'), 20, (text) => logged.push(text));
    assert.equal(log.write({ model: 'x' }), null);
    assert.match(logged[0], /couldn't save the refused request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reflex job is marked with its kind, and other jobs are not', () => {
  assert.equal('reflex' in new JobRecord({ player: 'Steve', text: 'mine' }).finish('done'), false);
  assert.equal(new JobRecord({ player: 'Steve', text: 'come here', reflex: 'come' }).finish('done').reflex, 'come');
});

test('a round of a standing job is marked, and other jobs are not', () => {
  assert.equal('standing' in new JobRecord({ player: 'Steve', text: 'mine' }).finish('done'), false);
  assert.equal(new JobRecord({ player: 'Steve', text: 'strip mine at y -59', standing: true }).finish('done').standing, true);
});

test('the log file keeps every line with a full timestamp and starts over past its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logfile-'));
  try {
    const path = join(dir, 'logs', 'bot.log');
    const file = new LogFile(path, 100);
    file.write('[brain] first', new Date(2026, 10, 15, 14, 58, 13));
    assert.equal(readFileSync(path, 'utf8'), '2026-11-15 14:58:13 [brain] first\n');
    file.write('x'.repeat(80));
    assert.match(readFileSync(`${path}.1`, 'utf8'), /^\S+ \S+ \[brain\] first\n$/);
    assert.match(readFileSync(path, 'utf8'), /^\S+ \S+ x{80}\n$/);
    // Only one old file is kept.
    file.write('[brain] third');
    assert.match(readFileSync(`${path}.1`, 'utf8'), /^\S+ \S+ x{80}\n$/);
    assert.match(readFileSync(path, 'utf8'), /^\S+ \S+ \[brain\] third\n$/);
    // Picks up the size of a file that's already there.
    assert.equal(new LogFile(path, 100).size, readFileSync(path).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log file that cannot be written never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logfile-'));
  try {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '');
    const file = new LogFile(join(blocked, 'bot.log'));
    assert.doesNotThrow(() => file.write('hello'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('the job log keeps its newest lines for recent(), reading the end of the file only once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joblog-recent-'));
  try {
    const path = join(dir, 'jobs.jsonl');
    const old = Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(50) })).join('\n');
    writeFileSync(path, `${old}\nnot json\n`);
    const jobLog = new JobLog(path, () => {}, { keep: 3, tailBytes: 250 });
    assert.deepEqual(jobLog.recent().map((l) => l.n), [2, 3, 4]);
    writeFileSync(path, '');
    jobLog.write({ n: 5 });
    jobLog.write({ n: 6 });
    assert.deepEqual(jobLog.recent().map((l) => l.n), [4, 5, 6]);
    assert.deepEqual(new JobLog(join(dir, 'none.jsonl')).recent(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
