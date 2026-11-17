import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  filterJobs,
  findSequences,
  firstWords,
  formatReport,
  main,
  normaliseFailure,
  parseArgs,
  parseLog,
  quantile,
  standOut
} from '../src/report.js';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

const tool = (name, ok = true, ms = 100, extra = {}) => ({ name, ok, ms, ...extra });

function step(model, tools = [], { ms = 1000, firstMs, cacheRead = 100, cacheWrite = 0, cost = 0.01 } = {}) {
  return { model, ms, ...(firstMs === undefined ? {} : { firstMs }), tokens: { input: 1, cacheRead, cacheWrite, output: 5 }, cost, tools };
}

function job({ start = '2026-11-10T12:00:00.000Z', player = 'Steve', request = 'bot build a hut', tier = 'complex', model = OPUS, end = 'done', ms = 10000, steps = [], ...rest } = {}) {
  const tools = steps.flatMap((s) => s.tools);
  return {
    start,
    player,
    request,
    freeTime: false,
    holds: 0,
    heldMs: 0,
    costWarnings: 0,
    tier,
    model,
    effort: 'low',
    end,
    ms,
    calls: [],
    steps,
    totals: {
      steps: steps.length,
      modelMs: steps.reduce((t, s) => t + s.ms, 0),
      toolMs: tools.reduce((t, x) => t + x.ms, 0),
      tokens: {},
      cost: steps.reduce((t, s) => t + s.cost, 0)
    },
    ...rest
  };
}

const log = (...jobs) => jobs.map((j) => JSON.stringify(j)).join('\n') + '\n';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// Four jobs over three days: a quick job, two handed up from the quick model and a build that
// starts on the main model. The one handed to the everyday model is in the old format.
function routed() {
  const quick = job({
    start: '2026-11-10T12:00:00.000Z',
    request: 'bot hi',
    tier: 'simple',
    model: HAIKU,
    ms: 1500,
    steps: [step(HAIKU, [tool('finish', true, 0)], { ms: 1000, firstMs: 400, cacheRead: 0, cacheWrite: 500, cost: 0.001 })]
  });
  const roof = job({
    start: '2026-11-10T13:00:00.000Z',
    request: 'Bot, fix the roof please',
    ms: 8000,
    steps: [
      step(HAIKU, [tool('escalate', true, 0, { to: 'complex' })], { ms: 800, cacheRead: 100, cacheWrite: 50, cost: 0.0005 }),
      step(OPUS, [tool('move_to', true, 2000)], { ms: 3000, firstMs: 1000, cacheRead: 0, cacheWrite: 2000, cost: 0.05 }),
      step(OPUS, [tool('place_block', true, 300)], { ms: 2000, firstMs: 500, cacheRead: 2000, cacheWrite: 100, cost: 0.01 })
    ]
  });
  const door = job({
    start: '2026-11-11T12:00:00.000Z',
    request: 'fix the door bot',
    tier: 'normal',
    model: SONNET,
    ms: 5000,
    steps: [
      step(HAIKU, [tool('escalate', true, 0, { to: 'normal' })], { ms: 1200, cacheRead: 100, cost: 0.0004 }),
      step(SONNET, [tool('chop_tree', true, 1500)], { ms: 1500, cacheRead: 0, cacheWrite: 1000, cost: 0.004 })
    ]
  });
  delete door.costWarnings;
  const build = job({
    start: '2026-11-12T12:00:00.000Z',
    request: 'bot build a tower',
    ms: 20000,
    steps: [1, 2, 3].map(() => step(OPUS, [], { ms: 4000, cacheRead: 1000, cost: 0.02 }))
  });
  return [quick, roof, door, build];
}

test('quantile interpolates between the nearest values', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  near(quantile([100, 200, 300, 400], 0.9), 370);
});

test('a broken line or one that is not a job is counted and skipped, and old records still load', () => {
  const [quick, roof, door] = routed();
  const old = { start: '2026-11-09T12:00:00.000Z', player: 'Alex', request: 'mine', tier: 'normal', model: SONNET, end: 'done', ms: 900, steps: [{ model: SONNET, ms: 700, tokens: { cacheRead: 5 }, cost: 0.002, tools: [{ name: 'mine', ok: false, ms: 200 }] }] };
  const text = `${JSON.stringify(roof)}\n{"start":"2026-11-1\n42\n\n${JSON.stringify(old)}\n${JSON.stringify(quick)}\n${JSON.stringify(door).slice(0, 80)}`;
  const { jobs, bad } = parseLog(text);
  assert.equal(bad, 3);
  assert.deepEqual(jobs.map((j) => j.request), ['mine', 'bot hi', 'Bot, fix the roof please']);
  const loaded = jobs[0];
  assert.equal(loaded.cost, 0.002);
  assert.equal(loaded.modelMs, 700);
  assert.equal(loaded.toolMs, 200);
  assert.equal(loaded.costWarnings, 0);
  assert.equal(loaded.nudges, 0);
  assert.equal(loaded.steps[0].firstMs, null);
});

const sideLine = (end, kind, cost, extra = {}) => ({
  ...job({ start: '2026-11-11T13:00:00.000Z', tier: null, model: null, end, ms: 0, steps: [] }),
  calls: [{ kind, model: HAIKU, ms: 2000, tokens: { input: 500, output: 60 }, cost }],
  totals: { steps: 0, modelMs: 2000, toolMs: 0, tokens: {}, cost },
  ...extra
});

test('lesson lines are counted apart and are not jobs', () => {
  const lesson = sideLine('lesson', 'lesson', 0.0001);
  const parsed = parseLog(log(...routed(), lesson));
  assert.equal(parsed.jobs.length, 4);
  assert.equal(parsed.lessons.length, 1);
  assert.equal(parsed.bad, 0);
  const report = buildReport(parsed.jobs, parsed);
  assert.equal(report.lessons.reviews, 1);
  assert.equal(report.totals.ends.lesson, undefined);
  assert.match(formatReport(report), /\nLeft out 1 lesson line, which is not a job\.\n/);
  const both = parseLog(log(...routed(), lesson, sideLine('busy_reply', 'busy', 0.0007)));
  assert.match(formatReport(buildReport(both.jobs, both)), /\nLeft out 1 lesson line and 1 busy reply line, which are not jobs\.\n/);
});

test('busy reply lines are not jobs, and their cost is in the cost in all', () => {
  const busy = [1, 2].map(() => sideLine('busy_reply', 'busy', 0.0007));
  const parsed = parseLog(log(...routed(), ...busy));
  assert.equal(parsed.jobs.length, 4);
  assert.equal(parsed.busyReplies.length, 2);
  const { totals } = buildReport(parsed.jobs, parsed);
  assert.equal(totals.jobs, 4);
  assert.deepEqual(totals.ends, { done: 4 });
  assert.equal(totals.busyReplies, 2);
  near(totals.busyCost, 0.0014);
  near(totals.cost, 0.001 + 0.0605 + 0.0044 + 0.06 + 0.0014);
  near(totals.medianCost, (0.0044 + 0.06) / 2);
  assert.equal(totals.sideCalls, 0);
  const text = formatReport(buildReport(parsed.jobs, parsed));
  assert.match(text, /\nLeft out 2 busy reply lines, which are not jobs\.\n/);
  assert.match(text, /\n {2}Busy replies 2 on lines of their own, \$0\.0014, in the cost above but not jobs\n/);
});

test('lessons count reviews and kept lessons, and list the five most recent', () => {
  const lessons = Array.from({ length: 7 }, (_, i) =>
    sideLine('lesson', 'lesson', 0.0001, {
      start: `2026-11-11T1${i}:00:00.000Z`,
      ...(i === 3 ? {} : { lesson: i === 6 ? `Check for lava first. ${'y'.repeat(200)}` : `lesson ${i}` })
    })
  );
  const parsed = parseLog(log(...routed(), ...lessons));
  const report = buildReport(parsed.jobs, parsed);
  assert.equal(report.lessons.reviews, 7);
  assert.equal(report.lessons.kept, 6);
  near(report.lessons.cost, 0.0007);
  near(report.totals.lessonCost, 0.0007);
  near(report.totals.cost, 0.001 + 0.0605 + 0.0044 + 0.06 + 0.0007);
  near(report.totals.medianCost, (0.0044 + 0.06) / 2);
  assert.deepEqual(report.lessons.recent.map((l) => l.lesson.slice(0, 8)), ['Check fo', 'lesson 5', 'lesson 4', 'lesson 2', 'lesson 1']);
  const text = formatReport(report);
  for (const line of text.split('\n')) assert.ok(line.length <= 100, `too wide: ${line}`);
  assert.match(text, /\nLessons\n {2}Reviews {6}7 ran, 6 kept a lesson, \$0\.0007, in the cost under Totals\n/);
  assert.match(text, /\n {2}\d\d-\d\d \d\d:\d\d {2}Check for lava first\. y+\.\.\.\n/);
  assert.doesNotMatch(text, /lesson 0/);
  assert.doesNotMatch(formatReport(buildReport(parsed.jobs)), /\nLessons\n/);
});

test('skills count runs, their failures, saves and forgets, and only runs count as failures', () => {
  const skill = (action, ok = true) => tool('skill', ok, 100, { action });
  const jobs = [
    job({ steps: [step(OPUS, [skill('run'), skill('run', false), skill('save')])] }),
    job({ steps: [step(OPUS, [skill('run'), skill('list'), skill('forget'), skill('save', false)])] }),
    job({ steps: [step(OPUS, [skill('list'), skill('forget', false)])] })
  ];
  const report = buildReport(parseLog(log(...jobs)).jobs);
  assert.deepEqual(report.skills, { calls: 9, jobs: 2, runs: 3, failed: 1, failRate: 1 / 3, saves: 1, forgets: 1, lists: 2 });
  const row = report.tools.find((r) => r.name === 'skill');
  assert.equal(row.calls, 9);
  assert.equal(row.failed, 1);
  assert.equal(row.failRate, 1 / 3);
  const text = formatReport(report);
  assert.match(text, /\nSkills\n {2}Runs {9}3 in 2 jobs, 1 failed \(33%\)\n {2}Saved {8}1, forgot 1, listed 2\n/);
  assert.doesNotMatch(formatReport(buildReport(parseLog(log(...routed())).jobs)), /\nSkills\n/);
});

test('reflex jobs are counted by kind', () => {
  const jobs = [
    ...routed(),
    job({ reflex: 'come', steps: [step(HAIKU)] }),
    job({ reflex: 'come', steps: [step(HAIKU)] }),
    job({ reflex: 'stay', steps: [step(HAIKU)] })
  ];
  const report = buildReport(parseLog(log(...jobs)).jobs);
  assert.deepEqual(report.totals.reflex, { come: 2, stay: 1 });
  assert.match(formatReport(report), /\n {2}Reflex jobs {2}come 2, stay 1\n/);
  assert.doesNotMatch(formatReport(buildReport(parseLog(log(...routed())).jobs)), /Reflex jobs/);
});

test('rounds of standing jobs are counted with their cost, and old records still load', () => {
  const jobs = [
    ...routed(),
    job({ standing: true, tier: 'normal', model: SONNET, steps: [step(SONNET, [tool('dig_area'), tool('standing_job'), tool('finish')], { cost: 0.2 })] }),
    job({ standing: true, tier: 'normal', model: SONNET, steps: [step(SONNET, [], { cost: 0.3 })] })
  ];
  const report = buildReport(parseLog(log(...jobs)).jobs);
  assert.equal(report.totals.rounds, 2);
  near(report.totals.roundCost, 0.5);
  assert.match(formatReport(report), /\n {2}Rounds {7}2 of standing jobs, \$0\.500\n/);
  const old = buildReport(parseLog(log(...routed())).jobs);
  assert.equal(old.totals.rounds, 0);
  assert.equal(parseLog(log(...routed())).jobs.every((j) => j.standing === false), true);
  assert.doesNotMatch(formatReport(old), /Rounds/);
});

test('totals count jobs, ends, cost, time and jobs a day', () => {
  const jobs = parseLog(log(...routed())).jobs;
  const { totals } = buildReport(jobs);
  assert.equal(totals.jobs, 4);
  assert.deepEqual(totals.ends, { done: 4 });
  near(totals.cost, 0.001 + 0.0605 + 0.0044 + 0.06);
  near(totals.medianCost, (0.0044 + 0.06) / 2);
  assert.equal(totals.modelMs, 1000 + 5800 + 2700 + 12000);
  assert.equal(totals.toolMs, 0 + 2300 + 1500 + 0);
  // Three calendar days from the first job to the last.
  near(totals.perDay, 4 / 3);
  assert.equal(totals.days.length, 3);
});

test('by model splits each job into the steps each model ran', () => {
  const { byModel } = buildReport(parseLog(log(...routed())).jobs);
  assert.deepEqual(byModel.map((r) => r.model), [OPUS, HAIKU, SONNET]);
  const [opus, haiku, sonnet] = byModel;
  assert.equal(opus.jobs, 2);
  assert.equal(opus.stepsMedian, 2.5);
  near(opus.stepsP90, 2.9);
  near(opus.costPerJob, 0.06);
  assert.equal(opus.stepMsMedian, 4000);
  assert.equal(opus.firstMsMedian, 750);
  assert.equal(opus.cacheHit, 0.8);
  assert.equal(opus.cacheHitAfterFirst, 1);
  assert.equal(opus.cacheWrite, 2100);
  assert.equal(opus.cacheRead, 5000);

  assert.equal(haiku.jobs, 3);
  assert.equal(haiku.stepsMedian, 1);
  near(haiku.costPerJob, 0.0019 / 3);
  assert.equal(haiku.stepMsMedian, 1000);
  assert.equal(haiku.firstMsMedian, 400);
  near(haiku.cacheHit, 2 / 3);
  assert.equal(haiku.cacheHitAfterFirst, 1);

  assert.equal(sonnet.jobs, 1);
  assert.equal(sonnet.firstMsMedian, null);
  assert.equal(sonnet.cacheHitAfterFirst, null);
});

test('by starting tier puts handed up jobs under the quick tier they started on', () => {
  const { byTier } = buildReport(parseLog(log(...routed())).jobs);
  assert.deepEqual(byTier.map((r) => [r.tier, r.jobs]), [['simple', 3], ['complex', 1]]);
  assert.equal(byTier[0].stepsMedian, 2);
  near(byTier[0].costPerJob, (0.001 + 0.0605 + 0.0044) / 3);
  assert.equal(byTier[1].stepsMedian, 3);
});

test('handovers count escalations, the first step and how escalated requests begin', () => {
  const { handovers } = buildReport(parseLog(log(...routed())).jobs, { botName: 'Bot' });
  assert.equal(handovers.quickJobs, 3);
  assert.equal(handovers.escalated, 2);
  near(handovers.rate, 2 / 3);
  assert.deepEqual(handovers.to, { complex: 1, normal: 1 });
  assert.equal(handovers.firstStepMsMedian, 1000);
  assert.equal(handovers.firstStepMsTotal, 2000);
  near(handovers.firstStepCost, 0.0009);
  assert.equal(handovers.nextStepMsMedian, 2250);
  assert.deepEqual(handovers.words, [{ words: 'fix the', count: 2 }]);
});

test('the reasons the quick model gave are grouped by count, and old records without one still report', () => {
  const [quick, roof, door] = routed();
  const handed = (request, to, reason) =>
    job({
      request,
      tier: to,
      steps: [step(HAIKU, [tool('escalate', true, 0, { to, reason })], { ms: 900 }), step(to === 'normal' ? SONNET : OPUS, [tool('mine', true, 500)])]
    });
  const jobs = [quick, roof, door, handed('patch the wall', 'complex', 'Fixing a build.'), handed('fill the holes', 'complex', 'fixing a build'), handed('dig it out', 'normal', 'tunnel work')];
  const report = buildReport(parseLog(log(...jobs)).jobs, { botName: 'Bot' });
  assert.deepEqual(report.handovers.reasons, [
    { reason: 'fixing a build', count: 2 },
    { reason: 'tunnel work', count: 1 }
  ]);
  assert.equal(report.handovers.noReason, 2);
  const text = formatReport(report);
  assert.match(text, /Quick model jobs +6, 5 escalated .*\n +Reasons given for escalating:\n/);
  assert.match(text, /\n +fixing a build +2\n/);
  assert.match(text, /\n +\(none given\) +2\n/);

  const old = buildReport(parseLog(log(quick, roof, door)).jobs, { botName: 'Bot' });
  assert.deepEqual(old.handovers.reasons, []);
  assert.equal(old.handovers.escalated, 2);
  assert.doesNotMatch(formatReport(old), /Reasons given/);
});

test('first words leave out the bot name and punctuation', () => {
  assert.equal(firstWords('Clodine, build me a house', 'Clodine'), 'build me');
  assert.equal(firstWords('do that then clodine', 'Clodine'), 'do that');
  assert.equal(firstWords("i don't know", null), "i don't");
  assert.equal(firstWords(null, 'Bot'), '');
});

test('failure text loses numbers and coordinates and keeps only its first line', () => {
  assert.equal(normaliseFailure('could not get close enough to 12 64 -5\nNow at 1 2 3.'), 'could not get close enough to N N N');
  assert.equal(normaliseFailure('Server refused to place at (2802, 68, -5030)'), 'Server refused to place at (N, N, N)');
  assert.equal(normaliseFailure('only crafted 6 of 18 in 2.5s'), 'only crafted N of N in Ns');
});

test('by tool counts calls, failures, times and the commonest failure texts', () => {
  const tools = [
    tool('place_block', true, 100),
    tool('place_block', false, 200, { error: 'could not get close enough to 12 64 -5\nNow at 1 2 3.' }),
    tool('place_block', false, 300, { error: 'could not get close enough to 100 70 -200' }),
    tool('place_block', false, 400, { error: 'no block to place against at 1 2 3' }),
    tool('move_to', true, 1000),
    tool('move_to', false, 500),
    ...['a 1', 'b 2', 'b 3', 'c', 'd'].map((error) => tool('craft', false, 10, { error }))
  ];
  const { tools: rows } = buildReport(parseLog(log(job({ steps: [step(OPUS, tools)] }))).jobs);
  const place = rows.find((r) => r.name === 'place_block');
  assert.equal(place.calls, 4);
  assert.equal(place.failed, 3);
  assert.equal(place.failRate, 0.75);
  assert.equal(place.msMedian, 250);
  near(place.msP90, 370);
  assert.equal(place.msTotal, 1000);
  assert.deepEqual(place.failures, [
    { text: 'could not get close enough to N N N', count: 2 },
    { text: 'no block to place against at N N N', count: 1 }
  ]);
  const move = rows.find((r) => r.name === 'move_to');
  assert.equal(move.failRate, 0.5);
  assert.deepEqual(move.failures, []);
  const craft = rows.find((r) => r.name === 'craft');
  assert.equal(craft.failures.length, 3);
  assert.deepEqual(craft.failures[0], { text: 'b N', count: 2 });
});

test('calls stopped from outside are counted apart and left out of failure rates and common failures', () => {
  const stopped = { interrupted: true, error: 'dug 29 blocks. Stopped early: stopped' };
  const tools = [
    tool('dig_area', true, 60000),
    tool('dig_area', false, 30000, stopped),
    tool('dig_area', false, 20000, stopped),
    tool('dig_area', false, 5000, { error: 'dug 0 blocks. Left 3 blocks that would not break' }),
    tool('skill', false, 100, { action: 'run', ...stopped }),
    tool('skill', true, 100, { action: 'run' })
  ];
  const report = buildReport(parseLog(log(job({ steps: [step(OPUS, tools)] }))).jobs);
  const dig = report.tools.find((r) => r.name === 'dig_area');
  assert.deepEqual([dig.calls, dig.interrupted, dig.failed, dig.failRate, dig.msTotal], [4, 2, 1, 0.5, 115000]);
  assert.deepEqual(dig.failures, [{ text: 'dug N blocks. Left N blocks that would not break', count: 1 }]);
  const skill = report.tools.find((r) => r.name === 'skill');
  assert.deepEqual([skill.calls, skill.interrupted, skill.failed, skill.failRate], [2, 1, 0, 0]);
  assert.deepEqual([report.skills.runs, report.skills.failed, report.skills.failRate], [2, 0, 0]);
  const text = formatReport(report);
  assert.match(text, /\n {2}tool +calls +interrupted +failed +med s +p90 s +total s\n/);
  assert.match(text, /\n {2}dig_area +4 +2 +50% /);
  assert.match(text, /\n {2}skill +2 +1 +- /);

  // Lines from before the mark go by what the tool said.
  const old = tools.map(({ interrupted, ...rest }) => rest);
  const before = buildReport(parseLog(log(job({ steps: [step(OPUS, old)] }))).jobs).tools.find((r) => r.name === 'dig_area');
  assert.deepEqual([before.interrupted, before.failed, before.failRate], [2, 1, 0.5]);
  assert.match(formatReport(buildReport(parseLog(log(job({ steps: [step(OPUS, old)] }))).jobs)), /\n {2}dig_area +4 +2 +50% /);

  // Since the mark, a call stopped for being stuck or too slow says the same and is a failure.
  const after = buildReport(parseLog(log(job({ start: '2026-11-16T09:00:00.000Z', steps: [step(OPUS, old)] }))).jobs).tools.find((r) => r.name === 'dig_area');
  assert.deepEqual([after.interrupted, after.failed, after.failRate], [0, 3, 0.75]);
});

test('older lines count a call as stopped from outside by the brain note or the tool saying it was stopped', () => {
  const tools = [
    tool('dig_area', false, 100, { error: 'dug 3 blocks. Stopped early: stopped\nNow at 1 2 3. (Stopped because a player just changed the instructions, see below.)' }),
    tool('dig_area', false, 100, { error: 'dug 3 blocks. Stopped early: stopped\nNow at 1 2 3. Inventory +3 cobbled_deepslate, +1 tuff. (Stoppe' }),
    tool('move_to', false, 100, { error: 'stopped (Stopped because the connection to the server dropped, see below.)' }),
    tool('break_block', false, 100, { error: 'stopped before breaking stone' }),
    tool('dig_area', false, 100, { error: 'dug 3 blocks. Stopped early: stopped (I stopped this myself: nothing was changing. Work out what\'s in the way before trying the same thing again.)' }),
    tool('dig_area', false, 100, { error: 'dug 3 blocks. Stopped early: stopped (Stopped because one call can run for at most 5 minutes.)' }),
    tool('break_block', false, 100, { error: 'stopped breaking stone: Digging aborted' }),
    tool('dig_area', false, 100, { error: 'dug 0 blocks. Stopped early: kept failing to reach or dig blocks' })
  ];
  const [line] = parseLog(log(job({ start: '2026-11-15T09:00:00.000Z', steps: [step(OPUS, tools)] }))).jobs;
  assert.deepEqual(line.tools.map((t) => t.interrupted), [true, true, true, true, false, false, false, false]);
  const later = parseLog(log(job({ start: '2026-11-15T12:00:00.000Z', steps: [step(OPUS, tools)] }))).jobs[0];
  assert.deepEqual(later.tools.map((t) => t.interrupted), [true, false, true, false, false, false, false, false]);
});

test('trouble lists jobs that ended badly, were nudged, held or warned, and the dearest and slowest', () => {
  const jobs = Array.from({ length: 12 }, (_, i) =>
    job({ start: `2026-11-10T${String(i + 1).padStart(2, '0')}:00:00.000Z`, request: `job ${i}`, ms: i * 1000, steps: [step(OPUS, [], { cost: i / 100 })] })
  );
  jobs[0].end = 'time';
  jobs[1].end = 'crash';
  jobs[2].end = 'stop';
  jobs[3].end = 'max_tokens';
  jobs[4].nudges = 2;
  jobs[5].holds = 1;
  jobs[5].heldMs = 3000;
  jobs[6].costWarnings = 1;
  const { trouble } = buildReport(parseLog(log(...jobs)).jobs);
  assert.deepEqual(trouble.ended.map((j) => [j.request, j.end]), [['job 0', 'time'], ['job 1', 'crash'], ['job 3', 'max_tokens']]);
  assert.deepEqual(trouble.nudged.map((j) => j.request), ['job 4']);
  assert.deepEqual(trouble.held.map((j) => j.request), ['job 5']);
  assert.deepEqual(trouble.warned.map((j) => j.request), ['job 6']);
  assert.equal(trouble.expensive.length, 10);
  assert.equal(trouble.expensive[0].request, 'job 11');
  assert.equal(trouble.expensive[0].cost, 0.11);
  assert.equal(trouble.slowest[0].seconds, 11);
  assert.deepEqual(Object.keys(trouble.slowest[0]), ['start', 'player', 'freeTime', 'request', 'model', 'steps', 'seconds', 'cost', 'end']);
});

test('sequences find runs of successful tools that recur across jobs', () => {
  const names = (...list) => list.map((n) => (typeof n === 'string' ? tool(n) : n));
  const steps = (...list) => [step(OPUS, names(...list))];
  const jobs = [
    // Twice in one job, with a repeated tool counted once.
    job({ steps: steps('move_to', 'place_block', 'place_block', 'inspect_blocks', 'move_to', 'place_block', 'inspect_blocks') }),
    // Control tools are left out.
    job({ steps: steps('escalate', 'move_to', 'place_block', 'inspect_blocks', 'finish') }),
    // A failure breaks the run.
    job({ steps: steps('move_to', tool('place_block', false), 'inspect_blocks') }),
    // Three times, but in one job only.
    job({ steps: steps('dig', 'mine', 'eat', 'dig', 'mine', 'eat', 'dig', 'mine', 'eat') }),
    ...[1, 2, 3].map(() => job({ steps: steps('find_block', 'move_to', 'break_block', 'collect_items') }))
  ];
  const found = findSequences(parseLog(log(...jobs)).jobs);
  assert.deepEqual(found, [
    { tools: ['find_block', 'move_to', 'break_block', 'collect_items'], count: 3, jobs: 3 },
    { tools: ['move_to', 'place_block', 'inspect_blocks'], count: 3, jobs: 2 }
  ]);
});

test('runs that span steps join up', () => {
  const jobs = [1, 2, 3].map(() => job({ steps: [step(OPUS, [tool('a'), tool('b')]), step(OPUS, [tool('c')])] }));
  assert.deepEqual(findSequences(parseLog(log(...jobs)).jobs), [{ tools: ['a', 'b', 'c'], count: 3, jobs: 3 }]);
});

test('stand out rules trip on their limits and show the number', () => {
  const report = {
    tools: [
      { name: 'mine', calls: 10, failRate: 0.3 },
      { name: 'eat', calls: 2, failRate: 1 },
      { name: 'move_to', calls: 20, failRate: 0.25 }
    ],
    byModel: [
      { model: 'm1', cacheHitAfterFirst: 0.5 },
      { model: 'm2', cacheHitAfterFirst: null },
      { model: 'm3', cacheHitAfterFirst: 0.9 }
    ],
    handovers: { quickJobs: 10, rate: 0.5 },
    byTier: [
      { tier: 'complex', stepsMedian: 12 },
      { tier: 'simple', stepsMedian: 10 }
    ]
  };
  const found = standOut(report);
  assert.deepEqual(found.map((s) => [s.subject, s.value]), [['mine', 0.3], ['m1', 0.5], ['quick model', 0.5], ['complex', 12]]);
  assert.equal(found[0].text, 'mine: failure rate 30% (over 25%)');
  assert.equal(found[3].text, 'complex: median steps per job 12 (over 10)');
  assert.deepEqual(standOut({ handovers: { quickJobs: 0, rate: null } }), []);
  const custom = standOut(report, [{ section: 'tools', key: 'name', field: 'calls', label: 'calls', over: 15 }]);
  assert.deepEqual(custom.map((s) => s.text), ['move_to: calls 20 (over 15)']);
});

test('filters pick by date, time, days back and player', () => {
  const jobs = parseLog(
    log(
      job({ start: '2026-11-10T12:00:00.000Z', player: 'Steve' }),
      job({ start: '2026-11-14T12:00:00.000Z', player: 'Alex' }),
      job({ start: '2026-11-15T12:00:00.000Z', player: 'Steve' })
    )
  ).jobs;
  const args = (...list) => parseArgs(list);
  assert.equal(filterJobs(jobs, args('--since', '2026-11-14')).length, 2);
  assert.equal(filterJobs(jobs, args('--since', '2026-11-15T00:00:00Z')).length, 1);
  assert.equal(filterJobs(jobs, { ...args('--days', '2'), now: Date.parse('2026-11-15T13:00:00Z') }).length, 2);
  assert.deepEqual(filterJobs(jobs, args('--player', 'steve')).map((j) => j.start.slice(0, 10)), ['2026-11-10', '2026-11-15']);
});

test('arguments take a path, filters and --json, and say what is wrong', () => {
  const args = parseArgs(['logs/other.jsonl', '--days', '3', '--player', 'Alex', '--json', '--bot', 'Bot']);
  assert.equal(args.path, 'logs/other.jsonl');
  assert.equal(args.days, 3);
  assert.equal(args.player, 'Alex');
  assert.equal(args.bot, 'Bot');
  assert.equal(args.json, true);
  assert.equal(parseArgs([]).path, 'jobs.jsonl');
  assert.match(parseArgs(['--since', 'soon']).error, /--since/);
  assert.match(parseArgs(['--days']).error, /needs a value/);
  assert.match(parseArgs(['--colour']).error, /Unknown option/);
});

test('the text report fits 100 columns and skips sections with nothing in them', () => {
  const jobs = routed();
  jobs[1].request = 'x'.repeat(200);
  jobs[1].end = 'time';
  const text = formatReport(buildReport(parseLog(log(...jobs)).jobs, { botName: 'Bot' }));
  for (const line of text.split('\n')) assert.ok(line.length <= 100, `too wide: ${line}`);
  assert.match(text, /^Job report for jobs\.jsonl: 4 jobs/);
  assert.match(text, /What stands out\n {2}- quick model: escalation rate 67% \(over 40%\)/);
  assert.match(text, /\nBy model\n/);
  assert.match(text, /haiku-5-5 +3 +1 +1 +\$0\.0006 +1\.0 +0\.4 /);
  assert.match(text, /\nHandovers\n/);
  assert.match(text, /\nEnded early\n/);
  assert.match(text, new RegExp(`\\n {6}${'x'.repeat(60)}\\n`));
  assert.doesNotMatch(text, /\nSequences\n/);
  assert.doesNotMatch(text, /\nNudged\n/);

  const old = job({ tier: 'normal', model: SONNET, steps: [step(SONNET, [tool('mine')])] });
  const plain = formatReport(buildReport(parseLog(log(old)).jobs));
  assert.match(plain, /Nothing crossed a rule\./);
  assert.doesNotMatch(plain, /\nHandovers\n/);
  assert.match(plain, /sonnet-5-5 +1 +1 +1 +\$0\.010 +1\.0 +- /);
});

test('the command prints a clear line for a missing, empty or unreadable log and exits 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...argv) => {
    const out = [];
    const code = main(argv, { out: (line) => out.push(line), configPath: join(dir, 'none.json') });
    return { code, out };
  };
  const missing = run(join(dir, 'none.jsonl'));
  assert.equal(missing.code, 0);
  assert.equal(missing.out.length, 1);
  assert.match(missing.out[0], /^No job log at .*none\.jsonl, so nothing to report\.$/);

  writeFileSync(join(dir, 'empty.jsonl'), '');
  const empty = run(join(dir, 'empty.jsonl'));
  assert.equal(empty.code, 0);
  assert.deepEqual(empty.out.length, 1);
  assert.match(empty.out[0], /^No jobs in .*empty\.jsonl, so nothing to report\.$/);

  writeFileSync(join(dir, 'broken.jsonl'), '{"start":\n');
  assert.match(run(join(dir, 'broken.jsonl')).out[0], /\(1 line could not be read\)/);

  writeFileSync(join(dir, 'jobs.jsonl'), log(...routed()));
  const none = run(join(dir, 'jobs.jsonl'), '--player', 'Nobody');
  assert.equal(none.code, 0);
  assert.deepEqual(none.out, [`No jobs in ${join(dir, 'jobs.jsonl')} match those filters.`]);
  assert.equal(run('--days', '0').code, 1);
});

test('--json prints the numbers as data, with the bot name from the config', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lesson = sideLine('lesson', 'lesson', 0.0001, { lesson: 'Look before digging down.' });
  const early = sideLine('lesson', 'lesson', 0.0001, { start: '2026-11-01T12:00:00.000Z', lesson: 'Too old.' });
  const busy = sideLine('busy_reply', 'busy', 0.0007);
  writeFileSync(join(dir, 'jobs.jsonl'), log(...routed(), lesson, early, busy) + 'not json\n');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ bot: { username: 'Bot' } }));
  const out = [];
  const argv = [join(dir, 'jobs.jsonl'), '--json', '--since', '2026-11-05'];
  assert.equal(main(argv, { out: (line) => out.push(line), configPath: join(dir, 'config.json') }), 0);
  assert.equal(out.length, 1);
  const data = JSON.parse(out[0]);
  assert.deepEqual(Object.keys(data), ['standOut', 'jobs', 'badLines', 'lessons', 'totals', 'byModel', 'byTier', 'handovers', 'tools', 'skills', 'trouble', 'sequences']);
  assert.equal(data.jobs, 4);
  assert.equal(data.badLines, 1);
  assert.deepEqual(data.lessons, {
    reviews: 1,
    kept: 1,
    cost: 0.0001,
    recent: [{ start: lesson.start, request: lesson.request, lesson: 'Look before digging down.' }]
  });
  assert.equal(data.totals.busyReplies, 1);
  near(data.totals.lessonCost, 0.0001);
  near(data.totals.cost, data.totals.jobCost + data.totals.busyCost + data.totals.lessonCost);
  near(data.totals.jobCost, 0.001 + 0.0605 + 0.0044 + 0.06);
  assert.deepEqual(Object.keys(data.skills), ['calls', 'jobs', 'runs', 'failed', 'failRate', 'saves', 'forgets', 'lists']);
  assert.deepEqual(Object.keys(data.trouble), ['ended', 'nudged', 'held', 'warned', 'expensive', 'slowest']);
  assert.deepEqual(data.handovers.words, [{ words: 'fix the', count: 2 }]);
  assert.equal(data.standOut[0].rule, 'escalation rate');
});

test('note tidy lines are counted apart and are not jobs, and their cost is in the cost in all', () => {
  const tidy = sideLine('tidy', 'tidy', 0.004, { freeTime: true, merged: 2 });
  const parsed = parseLog(log(...routed(), tidy));
  assert.equal(parsed.jobs.length, 4);
  assert.equal(parsed.tidies.length, 1);
  const report = buildReport(parsed.jobs, parsed);
  assert.equal(report.totals.ends.tidy, undefined);
  assert.equal(report.totals.tidies, 1);
  near(report.totals.tidyCost, 0.004);
  near(report.totals.cost, 0.001 + 0.0605 + 0.0044 + 0.06 + 0.004);
  const text = formatReport(report);
  assert.match(text, /\nLeft out 1 note tidy line, which is not a job\.\n/);
  assert.match(text, /\n {2}Note tidies {2}1, \$0\.0040, in the cost above but not jobs\n/);
});

test('sequences can keep stretches inside longer ones and ask for more jobs', () => {
  const jobs = [1, 2, 3].map(() => job({ steps: [step(OPUS, ['a', 'b', 'c', 'd'].map((n) => tool(n)))] }));
  const parsed = parseLog(log(...jobs)).jobs;
  assert.deepEqual(findSequences(parsed), [{ tools: ['a', 'b', 'c', 'd'], count: 3, jobs: 3 }]);
  assert.equal(findSequences(parsed, { keepInside: true, top: Infinity }).length, 3);
  assert.deepEqual(findSequences(parsed, { minJobs: 4 }), []);
});
