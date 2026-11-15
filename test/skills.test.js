import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';
import { TOOLS } from '../src/tools.js';
import { Skills, SKILL_TOOL, NOT_IN_SKILLS, skillAction, validateSkill, bindSteps, substitute, checkSchema } from '../src/skills.js';

const BRAIN = [{ name: 'finish', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }];
const ALL = [...TOOLS, ...BRAIN, SKILL_TOOL];

function tempSkills() {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const path = join(dir, 'skills.json');
  return { path, skills: new Skills({ tools: ALL, path }), cleanup: () => rmSync(dir, { recursive: true }) };
}

const restock = {
  name: 'restock',
  description: 'Fetch a pickaxe, mine stone at the quarry and put it away',
  params: ['count'],
  steps: [
    { tool: 'take_items', input: { items: [{ item: 'iron_pickaxe', count: 1 }] } },
    { tool: 'move_to', input: { x: 100, y: 64, z: -20 } },
    { tool: 'mine', input: { block: 'stone', count: '{count}' } },
    { tool: 'move_to', input: { x: 0, y: 64, z: 0 } },
    { tool: 'stash', input: {} }
  ]
};

// Answers like runAction does, with a state line on the end. fails is the tools that fail.
function fakeRun(fails = new Set(), calls = []) {
  return async (ctx, tool, input) => {
    calls.push({ tool, input, requester: ctx?.requester });
    const ok = !fails.has(tool);
    return { ok, message: `${tool} ${ok ? 'went fine' : 'could not do it'}\nNow at ${calls.length} 64 0.` };
  };
}

const schemas = () => new Skills({ tools: ALL, path: join(tmpdir(), 'never-written.json') }).schemas;

test('skills survive a restart', () => {
  const { path, skills, cleanup } = tempSkills();
  const saved = skills.save({ ...restock, savedBy: 'Steve' }, 1000);
  assert.equal(saved.error, undefined);
  assert.equal(existsSync(`${path}.tmp`), false);
  const again = new Skills({ tools: ALL, path });
  const s = again.get('RESTOCK');
  assert.equal(s.savedBy, 'Steve');
  assert.equal(s.created, 1000);
  assert.equal(s.runs, 0);
  assert.deepEqual(s.steps, restock.steps);
  cleanup();
});

test('a missing or corrupt file starts empty', () => {
  const { path, cleanup } = tempSkills();
  assert.equal(new Skills({ tools: ALL, path }).skills.length, 0);
  writeFileSync(path, '{ not json');
  assert.equal(new Skills({ tools: ALL, path }).skills.length, 0);
  writeFileSync(path, '{"a": 1}');
  assert.equal(new Skills({ tools: ALL, path }).skills.length, 0);
  cleanup();
});

test('no more than 50 skills, but saving over one still works', () => {
  const { skills, cleanup } = tempSkills();
  for (let i = 0; i < 50; i++) assert.equal(skills.save({ ...restock, name: `skill_${i}` }).error, undefined);
  assert.match(skills.save({ ...restock, name: 'one_more' }).error, /50 skills/);
  assert.equal(skills.save({ ...restock, name: 'skill_3', description: 'new words' }).replaced, true);
  assert.equal(skills.skills.length, 50);
  cleanup();
});

test('saving over a skill keeps its counts only when the steps are the same', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock, 1000);
  await skills.run('restock', { count: 64 }, { runAction: fakeRun() });
  skills.save({ ...restock, description: 'Same steps, new words' }, 2000);
  assert.equal(skills.get('restock').runs, 1);
  assert.equal(skills.get('restock').created, 1000);
  assert.equal(skills.get('restock').description, 'Same steps, new words');
  skills.save({ ...restock, steps: restock.steps.slice(1) }, 3000);
  assert.equal(skills.get('restock').runs, 0);
  assert.equal(skills.get('restock').created, 3000);
  assert.equal(skills.skills.length, 1);
  cleanup();
});

test('a good skill passes and bad ones are turned down with the reason', () => {
  const s = schemas();
  assert.equal(validateSkill(restock, s), null);
  const step = (tool, input) => ({ ...restock, params: [], steps: [{ tool, input }] });
  assert.match(validateSkill(step('teleport', {}), s), /no tool called teleport/);
  assert.match(validateSkill(step('say', { message: 'hi' }), s), /say can't be in a skill, a skill does things/);
  assert.match(validateSkill(step('whisper', { player: 'a', message: 'hi' }), s), /can't be in a skill/);
  assert.match(validateSkill(step('finish', { message: 'done' }), s), /finish can't be in a skill/);
  assert.match(validateSkill(step('escalate', { to: 'normal' }), s), /escalate can't be in a skill/);
  assert.match(validateSkill(step('skill', { action: 'run', name: 'restock' }), s), /can't run other skills/);
  assert.match(validateSkill(step('open_container', {}), s), /only looks/);
  assert.match(validateSkill(step('move_to', { x: 1, y: 2, z: '{z}' }), s), /\{z\} is used but not in params/);
  assert.match(validateSkill({ ...restock, params: ['count', 'where'] }, s), /param where is never used/);
  assert.match(validateSkill(step('move_to', { x: 1, y: 2 }), s), /needs z/);
  assert.match(validateSkill(step('move_to', { x: 1, y: 2, z: 3, speed: 9 }), s), /no field speed/);
  assert.match(validateSkill(step('move_to', { x: 1.5, y: 2, z: 3 }), s), /whole number/);
  assert.match(validateSkill(step('equip', { item: 'shield', slot: 'tail' }), s), /must be one of/);
  assert.match(validateSkill(step('craft', { item: '/op Steve' }), s), /chat command/);
  assert.match(validateSkill({ ...restock, description: '/give @p diamond' }, s), /chat command/);
  assert.match(validateSkill({ ...restock, description: 'x'.repeat(121) }, s), /over 120/);
  assert.match(validateSkill({ ...restock, description: 'two\nlines' }, s), /line break/);
  assert.match(validateSkill(step('craft', { item: 'x'.repeat(201) }), s), /over 200/);
  assert.match(validateSkill(step('break_block', { x: 1, y: 2, z: 3, confirmed: true }), s), /can't set confirmed/);
  assert.match(validateSkill(step('obtain', { item: 'torch', plan_only: true }), s), /can't set plan_only/);
  assert.match(validateSkill({ ...restock, name: 'Bad Name' }, s), /name must be/);
  assert.match(validateSkill({ ...restock, steps: [] }, s), /1 to 20 steps/);
  assert.match(validateSkill({ ...restock, steps: Array(21).fill(restock.steps[0]) }, s), /1 to 20 steps/);
  assert.match(validateSkill({ ...restock, params: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, s), /at most 8/);
});

test('every tool left out of skills is a real tool or a brain tool', () => {
  const names = new Set(ALL.map((t) => t.name));
  for (const name of NOT_IN_SKILLS) assert.ok(names.has(name) || name === 'escalate', name);
});

test('placeholders keep the type of the argument, or go into text', () => {
  const input = { block: '{what}', count: '{n}', items: [{ item: '{what}_ore', count: '{n}' }], flag: '{on}' };
  assert.deepEqual(substitute(input, { what: 'iron', n: 64, on: false }), {
    block: 'iron',
    count: 64,
    items: [{ item: 'iron_ore', count: 64 }],
    flag: false
  });
  assert.equal(substitute('mine {n} of {what}', { n: 3, what: 'coal' }), 'mine 3 of coal');
});

test('args are checked against the schemas once they are filled in', () => {
  const s = schemas();
  assert.equal(bindSteps(restock, { count: 64 }, s).steps[2].input.count, 64);
  assert.match(bindSteps(restock, { count: 'lots' }, s).error, /step 3 mine\.count must be a whole number/);
  assert.match(bindSteps(restock, {}, s).error, /needs count/);
  assert.match(bindSteps(restock, { count: 1, extra: 2 }, s).error, /no param extra/);
  assert.match(bindSteps({ ...restock, params: ['what'], steps: [{ tool: 'craft', input: { item: '{what}' } }] }, { what: '/op me' }, s).error, /chat command/);
  const slot = { ...restock, params: ['slot'], steps: [{ tool: 'unequip', input: { slot: '{slot}' } }] };
  assert.equal(validateSkill(slot, s), null);
  assert.match(bindSteps(slot, { slot: 'tail' }, s).error, /must be one of/);
  assert.equal(checkSchema({ items: [{ item: 'coal' }] }, TOOLS.find((t) => t.name === 'store_items').input_schema), null);
});

test('a run where every step works', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  const calls = [];
  const seen = [];
  const result = await skills.run('restock', { count: 64 }, { runAction: fakeRun(new Set(), calls), ctx: { requester: 'Alex' }, onStep: (step, total, tool) => seen.push(`${step}/${total} ${tool}`) });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[2], { tool: 'mine', input: { block: 'stone', count: 64 }, requester: 'Alex' });
  assert.deepEqual(seen, ['1/5 take_items', '2/5 move_to', '3/5 mine', '4/5 move_to', '5/5 stash']);
  assert.match(result.message, /^Ran skill restock, all 5 steps worked: 1 take_items: take_items went fine; .*5 stash: stash went fine\.\nNow at 5 64 0\.$/);
  assert.equal(result.message.match(/Now at/g).length, 1);
  const s = skills.get('restock');
  assert.equal(s.runs, 1);
  assert.equal(s.failures, 0);
  assert.ok(s.lastRun > 0);
  cleanup();
});

test('a run stops at the step that fails and says what was and was not done', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  const calls = [];
  const result = await skills.run('restock', { count: 64 }, { runAction: fakeRun(new Set(['mine']), calls) });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 3);
  assert.match(result.message, /^Skill restock failed at step 3 of 5 \(mine\): mine could not do it\. Steps 1-2 were done: 1 take_items: take_items went fine; 2 move_to: move_to went fine\. Steps 4-5 were not run\.\nNow at 3 64 0\.$/);
  assert.equal(skills.get('restock').failures, 1);
  cleanup();
});

test('a skill that fails on its first step, or its last', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  let result = await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(['take_items'])) });
  assert.match(result.message, /step 1 of 5 .* No step before it was done\. Steps 2-5 were not run\./);
  result = await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(['stash'])) });
  assert.match(result.message, /step 5 of 5 .*Steps 1-4 were done: .*\.\nNow at/);
  assert.doesNotMatch(result.message, /not run/);
  cleanup();
});

test("a skill a non-admin saved runs as them, even on an admin's job", async () => {
  const { skills, cleanup } = tempSkills();
  const config = { admins: ['Admin'] };
  skills.save({ ...restock, savedBy: 'Guest' });
  skills.save({ ...restock, name: 'admin_restock', savedBy: 'Admin' });
  const calls = [];
  await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(), calls), ctx: { config, requester: 'Admin' } });
  await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(), calls), ctx: { config, requester: 'Other' } });
  await skills.run('admin_restock', { count: 1 }, { runAction: fakeRun(new Set(), calls), ctx: { config, requester: 'Admin' } });
  assert.deepEqual([calls[0].requester, calls[5].requester, calls[10].requester], ['Guest', 'Other', 'Admin']);
  cleanup();
});

test('a bad argument runs nothing', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  const calls = [];
  const result = await skills.run('restock', { count: 'many' }, { runAction: fakeRun(new Set(), calls) });
  assert.equal(result.ok, false);
  assert.match(result.message, /not run, nothing was done/);
  assert.equal(calls.length, 0);
  assert.match((await skills.run('nope', {}, { runAction: fakeRun() })).message, /no skill called nope \(saved: restock\)/);
  cleanup();
});

test('stopping a run partway through runs no more steps and is not held against the skill', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  const controller = new AbortController();
  const calls = [];
  const run = fakeRun(new Set(), calls);
  const result = await skills.run('restock', { count: 64 }, {
    runAction: async (ctx, tool, input) => {
      const r = await run(ctx, tool, input);
      if (calls.length === 2) controller.abort('stop');
      return r;
    },
    signal: controller.signal
  });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.match(result.message, /stopped before step 3 of 5\. Steps 1-2 were done: .* Steps 3-5 were not run\./);
  assert.equal(skills.get('restock').runs, 0);
  assert.equal(skills.get('restock').failures, 0);

  const stuck = new AbortController();
  const during = await skills.run('restock', { count: 64 }, {
    runAction: async (ctx, tool) => {
      stuck.abort('stuck');
      return { ok: false, message: `${tool}: stopped` };
    },
    signal: stuck.signal
  });
  assert.match(during.message, /was stopped during step 1 of 5 \(take_items\)/);
  assert.equal(skills.get('restock').failures, 1);
  cleanup();
});

test('the result stays inside its budget for a 20-step skill', async () => {
  const { skills, cleanup } = tempSkills();
  const steps = Array.from({ length: 20 }, (_, i) => ({ tool: 'move_to', input: { x: i, y: 64, z: 0 } }));
  skills.save({ name: 'long_walk', description: 'Walk a long way', params: [], steps });
  const wordy = (fails) => async (ctx, tool, input) => ({
    ok: !(fails && input.x === 19),
    message: `walked to ${input.x} 64 0 ${'after a long and winding way round the hills '.repeat(10)}\nNow at ${input.x} 64 0. Inventory +1 dirt.`
  });
  const good = await skills.run('long_walk', {}, { runAction: wordy(false) });
  assert.ok(good.message.length <= 1200, String(good.message.length));
  assert.match(good.message, /20 move_to/);
  assert.match(good.message, /\nNow at 19 64 0\. Inventory \+1 dirt\.$/);
  const bad = await skills.run('long_walk', {}, { runAction: wordy(true) });
  assert.ok(bad.message.length <= 1200, String(bad.message.length));
  assert.match(bad.message, /failed at step 20 of 20/);
  cleanup();
});

test('three failed runs in a row mark a skill unreliable, and a good run clears it', async () => {
  const { skills, cleanup } = tempSkills();
  skills.save(restock);
  for (let i = 0; i < 2; i++) await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(['mine'])) });
  assert.doesNotMatch(skills.summary(), /unreliable/);
  await skills.run('restock', { count: 1 }, { runAction: fakeRun(new Set(['mine'])) });
  assert.match(skills.summary(), /restock\(count\): .* \[unreliable: failed its last 3 runs\]/);
  assert.equal(skills.get('restock').runs, 3);
  await skills.run('restock', { count: 1 }, { runAction: fakeRun() });
  assert.doesNotMatch(skills.summary(), /unreliable/);
  assert.equal(skills.get('restock').failures, 3);
  cleanup();
});

test('the summary is empty with no skills, lists the most used first, and keeps to its budget', async () => {
  const { skills, cleanup } = tempSkills();
  assert.equal(skills.summary(), '');
  for (let i = 0; i < 30; i++) skills.save({ ...restock, name: `routine_${i}`, description: `Routine number ${i} that does a few useful things` });
  await skills.run('routine_7', { count: 1 }, { runAction: fakeRun() });
  const text = skills.summary();
  assert.ok(text.length <= 600, String(text.length));
  assert.match(text.split('\n')[1], /^- routine_7\(count\): Routine number 7/);
  assert.match(text, /\+\d+ more, skill list shows them all$/);
  assert.ok(skills.summary({ limit: 200 }).length <= 200);
  cleanup();
});

test('the skill tool definition is strict and in the tools.js shape', () => {
  assert.equal(SKILL_TOOL.name, 'skill');
  assert.equal(SKILL_TOOL.strict, true);
  assert.equal(SKILL_TOOL.input_schema.additionalProperties, false);
  assert.deepEqual(SKILL_TOOL.input_schema.required, ['action']);
  const objects = (schema) => (schema.type === 'object' ? [schema, ...Object.values(schema.properties).flatMap(objects)] : schema.type === 'array' ? objects(schema.items) : []);
  for (const o of objects(SKILL_TOOL.input_schema)) assert.equal(o.additionalProperties, false);
});

test('the skill action saves, runs, lists and forgets through runAction', async () => {
  const { skills, cleanup } = tempSkills();
  const calls = [];
  const progress = [];
  const action = skillAction(fakeRun(new Set(), calls));
  const ctx = { skills, requester: 'Steve', status: { progress: (t) => progress.push(t) } };
  const steps = restock.steps.map((s) => ({ tool: s.tool, input: JSON.stringify(s.input) }));

  let r = await action(ctx, { action: 'save', name: 'restock', description: restock.description, params: ['count'], steps });
  assert.deepEqual(r, { ok: true, message: 'saved skill restock: 5 steps, takes count' });
  assert.equal(skills.get('restock').savedBy, 'Steve');
  r = await action(ctx, { action: 'save', name: 'restock', description: restock.description, params: ['count'], steps });
  assert.match(r.message, /^replaced skill restock/);
  r = await action(ctx, { action: 'save', name: 'bad', description: 'x', params: [], steps: [{ tool: 'mine', input: '{oops' }] });
  assert.deepEqual(r, { ok: false, message: 'not saved: step 1 input is not valid JSON' });
  r = await action(ctx, { action: 'save', name: 'chatty', description: 'x', params: [], steps: [{ tool: 'say', input: '{"message":"hi"}' }] });
  assert.equal(r.ok, false);
  assert.match(r.message, /^not saved: step 1: say can't be in a skill/);

  r = await action(ctx, { action: 'list' });
  assert.match(r.message, /^- restock\(count\): Fetch a pickaxe/);
  r = await action(ctx, { action: 'list', name: 'restock' });
  assert.match(r.message, /\n3 mine \{"block":"stone","count":"\{count\}"\}/);

  r = await action(ctx, { action: 'run', name: 'restock', args: '{"count":32}' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 5);
  assert.equal(calls[2].input.count, 32);
  assert.ok(calls.every((c) => c.requester === 'Steve'));
  assert.doesNotMatch(r.message, /Now at/);
  assert.equal(progress[2], 'step 3 of 5 of skill restock: mine');
  r = await action(ctx, { action: 'run', name: 'restock', args: '[1]' });
  assert.deepEqual(r, { ok: false, message: 'skill restock not run: args must be a JSON object' });

  r = await action(ctx, { action: 'forget', name: 'restock' });
  assert.deepEqual(r, { ok: true, message: 'forgot skill restock' });
  r = await action(ctx, { action: 'forget', name: 'restock' });
  assert.equal(r.ok, false);
  r = await action({ ...ctx, skills: undefined }, { action: 'list' });
  assert.deepEqual(r, { ok: false, message: 'skills are turned off' });
  cleanup();
});

test('the skill tool is one of the tools, and saves, runs, lists and forgets through the real runAction', async () => {
  const { runAction, ACTIONS } = await import('../src/actions/index.js');
  assert.equal(TOOLS.filter((t) => t.name === 'skill').length, 1);
  assert.equal(typeof ACTIONS.skill, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const skills = new Skills({ tools: TOOLS, path: join(dir, 'skills.json') });
  const looked = [];
  const goals = [];
  const bot = {
    entity: { position: new Vec3(1.5, 64, -2.5) },
    health: 20,
    food: 20,
    inventory: { slots: Array(46).fill(null) },
    pathfinder: { setGoal: (goal) => goals.push(goal) },
    lookAt: async (at) => looked.push([at.x, at.y, at.z])
  };
  const ctx = { bot, config: { admins: [] }, skills, requester: 'Steve' };
  assert.equal(skills.summary(), '');

  let r = await runAction(ctx, 'skill', {
    action: 'save',
    name: 'look_east',
    description: 'Stop and look east',
    params: ['x'],
    steps: [
      { tool: 'stop_moving', input: '{}' },
      { tool: 'look_at', input: '{"x":"{x}","y":64,"z":0}' }
    ]
  });
  assert.deepEqual(r, { ok: true, message: 'saved skill look_east: 2 steps, takes x\nNow at 1 64 -3.' });
  assert.match(skills.summary(), /^Skills you saved .*\n- look_east\(x\): Stop and look east$/);

  r = await runAction(ctx, 'skill', { action: 'run', name: 'look_east', args: '{"x":10}' });
  assert.equal(r.ok, true);
  assert.match(r.message, /^Ran skill look_east, all 2 steps worked: 1 stop_moving: stopped, now at 1 64 -3; 2 look_at: looking at 10 64 0\.\nNow at 1 64 -3\.$/);
  assert.deepEqual(goals, [null]);
  assert.deepEqual(looked, [[10.5, 64.5, 0.5]]);

  r = await runAction(ctx, 'skill', { action: 'run', name: 'look_east', args: '{"x":"far"}' });
  assert.equal(r.ok, false);
  assert.match(r.message, /^skill look_east not run, nothing was done: step 2 look_at\.x must be a whole number/);

  r = await runAction(ctx, 'skill', { action: 'list' });
  assert.match(r.message, /^- look_east\(x\): Stop and look east \(run 1, failed 0\)/);
  r = await runAction(ctx, 'skill', { action: 'forget', name: 'look_east' });
  assert.match(r.message, /^forgot skill look_east\n/);
  assert.equal(skills.summary(), '');
  rmSync(dir, { recursive: true });
});
