import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Gestures } from '../src/gestures.js';
import { setPauseScale } from '../src/actions/util.js';

function setup(t, { gestures = true, speaker = new Vec3(3, 64, 0) } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 1000000 });
  const calls = [];
  const controls = {};
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 1, pitch: 0, onGround: true },
    players: { Steve: { username: 'Steve', entity: speaker ? { position: speaker, height: 1.8 } : null } },
    entities: {},
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false, setGoal: record('setGoal') },
    currentWindow: null,
    lookAt: async (point, force) => calls.push(['lookAt', point, force]),
    look: async (yaw, pitch, force) => {
      calls.push(['look', yaw, pitch, force]);
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
    },
    swingArm: record('swing'),
    setControlState: (control, state) => {
      calls.push(['control', control, state]);
      controls[control] = state;
    },
    getControlState: (control) => Boolean(controls[control]),
    dig: record('dig'),
    placeBlock: record('placeBlock'),
    activateItem: record('activateItem'),
    activateBlock: record('activateBlock')
  };
  const brain = { busy: true, paused: false, current: null };
  const survival = { recovering: false };
  const idle = { running: null };
  const state = { tool: false };
  const g = new Gestures({ getBot: () => bot, brain, survival, idle, config: { bot: { gestures } }, toolRunning: () => state.tool });
  return { g, bot, calls, controls, brain, survival, idle, state };
}

// The mock clock only fires timers that were already set when it moves, so it moves in steps.
function advance(t, ms) {
  for (let left = ms; left > 0; left -= 10) t.mock.timers.tick(Math.min(10, left));
}

const onlyHead =(calls) => calls.every(([name]) => name === 'look' || name === 'lookAt');

test('she turns to the speaker the moment they speak', (t) => {
  const { g, calls } = setup(t);
  t.mock.method(Math, 'random', () => 0.1);
  g.notice('Steve');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'lookAt');
  assert.deepEqual(calls[0][1], new Vec3(3, 65.8, 0));
});

test('sometimes a nod after turning, and the crouch is let go again', (t) => {
  const { g, calls, controls } = setup(t);
  t.mock.method(Math, 'random', () => 0.47);
  g.notice('Steve');
  advance(t, 600);
  assert.deepEqual(calls[1], ['control', 'sneak', true]);
  advance(t, 400);
  assert.equal(controls.sneak, false);
  assert.equal(g.timers.size, 0);
});

test('or an arm swing, and not again right away', (t) => {
  const { g, calls } = setup(t);
  t.mock.method(Math, 'random', () => 0.9);
  g.notice('Steve');
  advance(t, 1000);
  assert.deepEqual(calls.map(([name]) => name), ['lookAt', 'swing']);
  g.notice('Steve');
  advance(t, 1000);
  assert.deepEqual(calls.map(([name]) => name), ['lookAt', 'swing', 'lookAt']);
});

test('nothing when the speaker is not in view', (t) => {
  const { g, calls } = setup(t, { speaker: null });
  t.mock.method(Math, 'random', () => 0.9);
  g.notice('Steve');
  g.notice('Alex');
  advance(t, 2000);
  assert.deepEqual(calls, []);
});

test('nothing when the speaker is far off', (t) => {
  const { g, calls } = setup(t, { speaker: new Vec3(40, 64, 0) });
  g.notice('Steve');
  assert.deepEqual(calls, []);
});

const blockers = {
  'a tool is running': (s) => (s.state.tool = true),
  'the pathfinder is moving': (s) => (s.bot.pathfinder.isMoving = () => true),
  'the pathfinder is placing': (s) => (s.bot.pathfinder.isBuilding = () => true),
  'she is digging': (s) => (s.bot.targetDigBlock = {}),
  'a window is open': (s) => (s.bot.currentWindow = {}),
  'survival has taken over': (s) => (s.survival.recovering = true),
  'jobs are on hold': (s) => (s.brain.paused = true),
  'a chore is running': (s) => (s.idle.running = {}),
  'she is riding': (s) => (s.bot.vehicle = {}),
  'she is in bed': (s) => (s.bot.isSleeping = true),
  'there is no bot entity': (s) => (s.bot.entity = null)
};

for (const [why, block] of Object.entries(blockers)) {
  test(`no gestures while ${why}`, (t) => {
    const s = setup(t);
    t.mock.method(Math, 'random', () => 0.47);
    block(s);
    s.g.notice('Steve');
    s.g.think(true, { player: 'Steve' });
    advance(t, 30000);
    s.g.think(false);
    s.g.said({ player: 'Steve' });
    s.brain.current = null;
    advance(t, 10);
    assert.deepEqual(s.calls, []);
  });
}

test('while thinking she only moves her head, and stops the moment she acts', (t) => {
  const { g, calls, bot } = setup(t);
  g.think(true, { player: 'Steve' });
  advance(t, 30000);
  assert.ok(calls.length >= 5);
  assert.ok(onlyHead(calls));
  g.think(false);
  // Her head lands back where it was at once, with a forced look.
  assert.deepEqual(calls.at(-1), ['look', 1, 0, true]);
  assert.equal(bot.entity.yaw, 1);
  const count = calls.length;
  assert.equal(g.thinkTimer, null);
  assert.equal(g.timers.size, 0);
  advance(t, 60000);
  assert.equal(calls.length, count);
});

test('thinking glances include the player who asked when they are close', (t) => {
  const { g, calls } = setup(t);
  t.mock.method(Math, 'random', () => 0.1);
  g.think(true, { player: 'Steve' });
  advance(t, 2000);
  assert.equal(calls[0][0], 'lookAt');
  assert.deepEqual(calls[0][1], new Vec3(3, 65.8, 0));
});

test('a tool starting mid-thought gets no gestures in its way', (t) => {
  const s = setup(t);
  s.g.think(true, { player: 'Steve' });
  advance(t, 5000);
  const count = s.calls.length;
  s.state.tool = true;
  advance(t, 20000);
  assert.equal(s.calls.length, count);
});

test('a false during a nod lets go of the crouch at once', (t) => {
  const { g, controls } = setup(t);
  t.mock.method(Math, 'random', () => 0.47);
  g.notice('Steve');
  g.think(true, { player: 'Steve' });
  advance(t, 600);
  assert.equal(controls.sneak, true);
  g.think(false);
  assert.equal(controls.sneak, false);
  assert.equal(g.timers.size, 0);
  assert.equal(g.thinkTimer, null);
});

test('a request that never says it ended stops gesturing at the ceiling', (t) => {
  const { g, calls } = setup(t);
  g.think(true, { player: 'Steve' });
  advance(t, 85000);
  assert.ok(g.thinking);
  advance(t, 10000);
  assert.equal(g.thinking, null);
  assert.equal(g.thinkTimer, null);
  const count = calls.length;
  advance(t, 60000);
  assert.equal(calls.length, count);
});

test('thinking stops when the job is gone', (t) => {
  const { g, brain } = setup(t);
  g.think(true, { player: 'Steve' });
  brain.busy = false;
  advance(t, 3000);
  assert.equal(g.thinking, null);
  assert.equal(g.thinkTimer, null);
});

test('with gestures off she still turns to the speaker but does nothing else', (t) => {
  const { g, calls, brain } = setup(t, { gestures: false });
  t.mock.method(Math, 'random', () => 0.47);
  g.notice('Steve');
  g.think(true, { player: 'Steve' });
  advance(t, 30000);
  g.think(false);
  const job = { player: 'Steve' };
  brain.current = job;
  g.said(job);
  brain.current = null;
  advance(t, 10);
  assert.deepEqual(calls.map(([name]) => name), ['lookAt']);
});

test('she faces the player with her last word on a job', (t) => {
  const { g, calls, brain } = setup(t);
  const job = { player: 'Steve' };
  brain.current = job;
  g.said(job);
  advance(t, 10);
  assert.deepEqual(calls, []);
  g.said(job);
  brain.current = null;
  advance(t, 10);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], new Vec3(3, 65.8, 0));
  g.said({ player: null, self: true });
  advance(t, 10);
  assert.equal(calls.length, 1);
});

test('pauseScale 0 does not speed thinking gestures up', (t) => {
  const { g, calls } = setup(t);
  setPauseScale(0);
  try {
    g.think(true, { player: 'Steve' });
    advance(t, 10000);
    assert.ok(calls.length >= 2 && calls.length <= 11);
  } finally {
    setPauseScale(1);
  }
});
