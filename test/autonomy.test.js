import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { outlineFrom, inArea, areaBounds, AreaRecorder, TravelLog } from '../src/areas.js';
import { Memory } from '../src/memory.js';
import { recordArea } from '../src/actions/memory.js';
import { smeltOutput, inputFor, pickFuel } from '../src/actions/furnace.js';
import { pickFood, needsFood, preyNear } from '../src/survival.js';
import { canSleepNow } from '../src/actions/bed.js';
import { craft } from '../src/actions/crafting.js';
import { Brain } from '../src/brain.js';

// A walk around a 20 x 10 field, a little wobbly.
function fieldWalk() {
  const points = [];
  for (let x = 0; x <= 20; x++) points.push({ x, y: 64, z: (x % 2) * 0.3 });
  for (let z = 0; z <= 10; z++) points.push({ x: 20, y: 64, z });
  for (let x = 20; x >= 0; x--) points.push({ x, y: 65, z: 10 });
  for (let z = 10; z >= 0; z--) points.push({ x: 0, y: 64, z });
  return points;
}

const tempPath = (name) => join(tmpdir(), `cubehand-${name}-${process.pid}-${Date.now()}.json`);

test('a walk around a field becomes its corners, and inside means inside', () => {
  const area = outlineFrom(fieldWalk());
  assert.deepEqual(area.corners, [[0, 0], [20, 0], [20, 10], [0, 10]]);
  assert.deepEqual(areaBounds(area), { width: 20, depth: 10, center: { x: 10, y: 64, z: 5 } });
  assert.equal(inArea(area, { x: 10, y: 64, z: 5 }), true);
  assert.equal(inArea(area, { x: 25, y: 64, z: 5 }), false);
  assert.equal(inArea(area, { x: 10, y: 20, z: 5 }), false);
});

test('a few steps or a straight line is not an outline', () => {
  assert.equal(outlineFrom([{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]), null);
  assert.equal(outlineFrom(Array.from({ length: 20 }, (_, i) => ({ x: i, y: 64, z: 0 }))), null);
});

test('an area between two corners is remembered, and the summary says when you are in it', () => {
  const path = tempPath('box');
  try {
    const memory = new Memory(path);
    memory.remember({ name: 'farm', note: 'wheat', x: 10, y: 64, z: 10, x2: 19, y2: 66, z2: 14 });
    assert.match(memory.summary({ x: 15.5, y: 64, z: 12.5 }), /farm \(area about 10 x 5 blocks around 15 64 12, you are inside it\): wheat/);
    assert.doesNotMatch(memory.summary({ x: 30, y: 64, z: 12 }), /inside/);
    assert.deepEqual(memory.areasAt({ x: 19.9, y: 65, z: 14.9 }), ['farm']);
  } finally {
    rmSync(path, { force: true });
  }
});

test('record_area tracks a player and saves the loop they walked', async () => {
  const path = tempPath('walk');
  try {
    const memory = new Memory(path);
    const areas = new AreaRecorder();
    const bot = { players: { Steve: { username: 'Steve', entity: { position: new Vec3(0, 64, 0) } } }, entities: {} };
    const ctx = { bot, memory, areas };
    const started = await recordArea(ctx, { action: 'start', name: 'sheep pen', player: 'Steve' });
    assert.equal(started.ok, true);
    assert.match(areas.status(), /sheep pen, tracking Steve/);
    areas.active.points.push(...fieldWalk());
    const saved = await recordArea(ctx, { action: 'save', note: 'keep the gate shut' });
    assert.equal(saved.ok, true);
    assert.match(saved.message, /saved sheep pen: about 20 x 10 blocks around 10 64 5, 4 corners/);
    assert.equal(areas.active, null);
    assert.equal(memory.notes.at(-1).area.corners.length, 4);
    assert.equal((await recordArea(ctx, { action: 'save', name: 'x' })).ok, false);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the travel log keeps places, not every step', () => {
  const log = new TravelLog();
  log.record({ x: 0, y: 64, z: 0 }, 0);
  log.record({ x: 5, y: 64, z: 0 }, 60000);
  log.record({ x: 100, y: 70, z: 0 }, 120000);
  log.record({ x: 101, y: 70, z: 2 }, 180000);
  assert.equal(log.points.length, 2);
  assert.equal(log.summary(360000), "Where you've been lately (newest first): 0 64 0 (5 min ago)");
  assert.equal(new TravelLog().summary(), null);
});

test('smelting works out what goes in from what should come out', () => {
  assert.equal(smeltOutput('raw_iron'), 'iron_ingot');
  assert.equal(smeltOutput('oak_log'), 'charcoal');
  assert.equal(smeltOutput('crimson_stem'), null);
  assert.equal(inputFor('iron_ingot', ['dirt', 'raw_iron']), 'raw_iron');
  assert.equal(inputFor('raw_iron', ['raw_iron']), 'raw_iron');
  assert.equal(inputFor('stone', ['cobblestone']), 'cobblestone');
  assert.equal(inputFor('stone', ['stone', 'cobblestone']), 'stone');
  assert.equal(inputFor('glass', ['dirt']), null);
});

test('fuel: coal first and just enough of it, wood when there is no coal', () => {
  const counts = new Map([['oak_planks', 10], ['coal', 3], ['stick', 4]]);
  assert.deepEqual(pickFuel(counts, 12), { name: 'coal', count: 2 });
  assert.deepEqual(pickFuel(counts, 30), { name: 'coal', count: 3 });
  assert.deepEqual(pickFuel(new Map([['oak_planks', 10], ['stick', 4]]), 6), { name: 'oak_planks', count: 4 });
  assert.deepEqual(pickFuel(new Map([['oak_log', 5], ['coal', 1]]), 4, { exclude: 'coal' }), { name: 'oak_log', count: 3 });
  assert.deepEqual(pickFuel(counts, 4, { only: 'stick' }), { name: 'stick', count: 4 });
  assert.equal(pickFuel(new Map([['dirt', 5]]), 1), null);
});

const FOODS = {
  cooked_beef: { foodPoints: 8, saturation: 12.8, effectiveQuality: 20.8 },
  bread: { foodPoints: 5, saturation: 6, effectiveQuality: 11 },
  rotten_flesh: { foodPoints: 4, saturation: 0.8, effectiveQuality: 4.8 },
  golden_apple: { foodPoints: 4, saturation: 9.6, effectiveQuality: 13.6 },
  pufferfish: { foodPoints: 1, saturation: 0.2, effectiveQuality: 1.2 }
};
const carrying = (...names) => names.map((name) => ({ name, count: 1 }));

test('food: the best first, risky food only when starving, golden apples only when dying', () => {
  assert.equal(pickFood(FOODS, carrying('bread', 'cooked_beef')).name, 'cooked_beef');
  assert.equal(pickFood(FOODS, carrying('rotten_flesh', 'pufferfish')), null);
  assert.equal(pickFood(FOODS, carrying('rotten_flesh', 'pufferfish'), { starving: true }).name, 'rotten_flesh');
  assert.equal(pickFood(FOODS, carrying('golden_apple', 'bread')).name, 'bread');
  assert.equal(pickFood(FOODS, carrying('golden_apple', 'bread'), { critical: true }).name, 'golden_apple');
  assert.equal(pickFood(FOODS, carrying('dirt')), null);
});

test('eat when hungry, or when hurt and the food bar is too low to heal', () => {
  assert.equal(needsFood({ food: 14, health: 20 }), true);
  assert.equal(needsFood({ food: 17, health: 20 }), false);
  assert.equal(needsFood({ food: 17, health: 10 }), true);
  assert.equal(needsFood({ food: 18, health: 10 }), false);
  assert.equal(needsFood({ food: 20, health: 2 }), false);
});

test('hunting skips penned and named animals, and the last two of a kind', () => {
  const fence = new Vec3(22, 64, 20);
  const animal = (name, x, z, extra = {}) => ({ name, position: new Vec3(x, 64, z), metadata: [], ...extra });
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: animal('cow', 7, 0),
      2: animal('cow', 5, 0),
      3: animal('cow', 6, 0),
      4: animal('pig', 3, 0),
      5: animal('cow', 20, 20),
      6: animal('cow', 4, 0, { metadata: { 2: 'tag' }, getCustomName: () => 'Bessie' })
    },
    blockAt: (p) => ({ name: p.equals(fence) ? 'oak_fence' : 'grass_block' })
  };
  assert.deepEqual(preyNear(bot, 40).map((e) => e.position.x), [5, 6, 7]);
});

test('beds work at night or in a thunderstorm', () => {
  assert.equal(canSleepNow({ time: { timeOfDay: 13000 }, isRaining: false }), true);
  assert.equal(canSleepNow({ time: { timeOfDay: 6000 }, isRaining: false }), false);
  assert.equal(canSleepNow({ time: { timeOfDay: 6000 }, isRaining: true, thunderState: 1 }), true);
});

// Just enough of a bot for planks from logs in the inventory grid.
function craftingBot({ logs, failOnce = false }) {
  const log = { id: 1, name: 'spruce_log', stackSize: 64 };
  const planks = { id: 2, name: 'spruce_planks', stackSize: 64 };
  const recipe = { result: { id: 2, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], requiresTable: false };
  const state = { logs, planks: 0, batches: [], closes: 0, fail: failOnce };
  const bot = {
    registry: { itemsByName: { spruce_log: log, spruce_planks: planks }, items: { 1: log, 2: planks } },
    inventory: {
      inventoryStart: 9,
      inventoryEnd: 45,
      selectedItem: null,
      get slots() {
        const s = new Array(46).fill(null);
        if (state.logs) s[9] = { type: 1, name: 'spruce_log', count: state.logs };
        if (state.planks) s[10] = { type: 2, name: 'spruce_planks', count: state.planks };
        return s;
      },
      items() {
        return this.slots.filter(Boolean);
      }
    },
    currentWindow: null,
    recipesAll: () => [recipe],
    recipesFor: (id, meta, count) => (state.logs >= Math.ceil(count / 4) ? [recipe] : []),
    craft: async (r, times) => {
      if (state.fail) {
        state.fail = false;
        throw new Error('missing ingredient');
      }
      state.batches.push(times);
      state.logs -= times;
      state.planks += times * 4;
    },
    closeWindow: () => state.closes++,
    _syncWindow: async () => {},
    emit: () => {}
  };
  return { bot, state };
}

test('crafting goes in small batches and resyncs the inventory grid after each', async () => {
  const { bot, state } = craftingBot({ logs: 20 });
  const result = await craft({ bot }, { item: 'spruce_planks', count: 40 });
  assert.equal(result.ok, true);
  assert.equal(result.message, 'crafted 40 spruce_planks');
  assert.deepEqual(state.batches, [8, 2]);
  assert.equal(state.closes, 3);
});

test('a craft that fails is retried after a resync, and the real count is reported', async () => {
  const { bot, state } = craftingBot({ logs: 3, failOnce: true });
  const result = await craft({ bot }, { item: 'spruce_planks', count: 12 });
  assert.equal(result.ok, true);
  assert.equal(result.message, 'crafted 12 spruce_planks');
  assert.deepEqual(state.batches, [3]);
});

const brainConfig = {
  bot: { username: 'Clodine' },
  claude: { model: 'claude-opus-5-5', effort: 'low', fallback: false, strictTools: true, maxTokens: 16000, busyReplies: false },
  limits: { maxSteps: 25, maxSeconds: 60, queueSize: 3 },
  idle: { freeTimeSteps: 8, freeTimeSeconds: 60 }
};

const answer = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } });

// The first request waits until it's aborted, the later ones answer with text.
function slowThenClient(text) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: (params, opts) => {
          calls.push(params);
          if (calls.length > 1) return Promise.resolve(answer(text));
          return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
      }
    }
  };
}

function brainWith(client) {
  const said = [];
  const brain = new Brain({
    client,
    config: brainConfig,
    runTool: async () => ({ ok: true, message: 'done' }),
    snapshot: () => 'SNAPSHOT',
    say: (text) => said.push(text),
    log: () => {}
  });
  return { brain, said };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('free time with nothing to do stays quiet', async () => {
  const client = { calls: [], beta: { messages: { create: async (params) => (client.calls.push(params), answer('Nothing.')) } } };
  const { brain, said } = brainWith(client);
  assert.equal(brain.freeTime(), true);
  await brain.current.done;
  assert.deepEqual(said, []);
  assert.match(client.calls[0].messages[0].content, /free time/);
  assert.equal(brain.freeTime(), true);
  await brain.current.done;
});

test('a player request stops free time and runs right away', async () => {
  const client = slowThenClient('On my way.');
  const { brain, said } = brainWith(client);
  brain.freeTime();
  await settle();
  const free = brain.current;
  brain.enqueue('Steve', 'come here');
  await free.done;
  await brain.current.done;
  assert.deepEqual(said, ['On my way.']);
  assert.match(client.calls[1].messages[0].content, /Request from Steve: come here/);
});

test('a job paused for safety waits in the queue and carries on after resume', async () => {
  const client = slowThenClient('Done.');
  const { brain, said } = brainWith(client);
  brain.start({ player: 'Steve', text: 'mine some stone' });
  await settle();
  await brain.pause();
  assert.equal(brain.busy, false);
  brain.enqueue('Alex', 'hi');
  assert.deepEqual(said, ["Alex, got it. I'll do that once I'm safe."]);
  assert.deepEqual(brain.queue.map((r) => r.player), ['Steve', 'Alex']);
  brain.resume();
  await brain.current.done;
  assert.match(client.calls[1].messages[0].content, /mine some stone\n\(You stopped this job earlier/);
  await brain.current?.done;
  assert.deepEqual(said.slice(1), ['Done.', 'Done.']);
});
