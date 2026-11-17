import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Idle } from '../src/idle.js';
import { Tended } from '../src/tended.js';

const FOODS = { bread: { foodPoints: 5, saturation: 6, effectiveQuality: 11 } };

// A bot standing about with nothing near, and walk scaffolding she left close by.
function setup({ food = 20, health = 20 } = {}) {
  const bot = {
    health,
    food,
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    players: {},
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    isRaining: false,
    pathfinder: { goal: null, setGoal: () => {} },
    registry: { foodsByName: FOODS },
    inventory: { items: () => [{ name: 'bread', count: 3 }] },
    world: { raycast: () => null },
    blockAt: (p) => ({ name: 'air', position: p }),
    equip: async () => {},
    consume: async () => {
      bot.food = 20;
    }
  };
  const brain = { busy: false, paused: false, queue: [], lastJobEnd: Date.now(), lastFreeTime: Date.now() };
  const lines = [];
  const idle = new Idle({
    getBot: () => bot,
    brain,
    survival: { recovering: false },
    config: { idle: { enabled: true, freeTimeMinutes: 15, defendRadius: 12 }, survival: { eatAtFood: 14 }, allowlist: [] },
    makeCtx: (signal) => ({ bot, signal }),
    log: (line) => lines.push(line),
    smeltJobs: new Map()
  });
  idle.scaffoldTops = () => [{ x: 4, y: 64, z: 0 }];
  idle.tidy = async () => {};
  return { bot, idle, lines };
}

test('a hold keeps chores off until it is released, and by default for ten minutes', async () => {
  const { idle, lines } = setup();
  idle.hold();
  assert.ok(idle.holdUntil - Date.now() > 9 * 60000);
  idle.tick();
  assert.equal(idle.running, null);
  idle.release();
  idle.tick();
  assert.ok(idle.running);
  await idle.running.done;
  assert.deepEqual(lines, ['[idle] take down scaffolding I left']);
});

test('a hold runs out on its own', () => {
  const { idle } = setup();
  idle.hold(60000);
  idle.holdUntil = Date.now() - 1;
  idle.tick();
  assert.ok(idle.running);
});

test('eating and backing off from danger still happen during a hold', async () => {
  const hungry = setup({ food: 8 });
  hungry.idle.hold();
  hungry.idle.tick();
  assert.deepEqual(hungry.lines, ['[idle] eat']);
  await hungry.idle.running.done;

  const near = setup();
  near.bot.entities = { 1: { id: 1, name: 'warden', type: 'hostile', position: new Vec3(8, 64, 0) } };
  near.bot.pathfinder.goto = async () => {};
  near.idle.hold();
  near.idle.tick();
  assert.deepEqual(near.lines, ['[idle] back away from warden']);
});

test('a hold stops a chore under way but leaves one that keeps her alive going', () => {
  const { idle } = setup();
  let aborts = 0;
  idle.interrupt = async () => aborts++;
  idle.running = { survival: false, follow: {} };
  idle.hold();
  assert.equal(aborts, 1);
  assert.equal(idle.running.follow, null);
  idle.running = { survival: true, follow: {} };
  idle.hold();
  assert.equal(aborts, 1);
  assert.equal(idle.running.follow, null);
});

test('a drop sunk in water or lying in lava does not start the pickup chore', () => {
  const { bot, idle } = setup();
  bot.entities = { 5: { id: 5, name: 'item', position: new Vec3(2.5, 64.2, 0.5) } };
  let liquid = 'water';
  bot.blockAt = (p) => (p.x === 2 && p.z === 0 && p.y <= 65 ? { name: liquid, position: p, boundingBox: 'empty' } : { name: 'air', position: p, boundingBox: 'empty' });
  assert.equal(idle.pick(bot)?.name, 'take down scaffolding I left');
  liquid = 'lava';
  assert.equal(idle.pick(bot)?.name, 'take down scaffolding I left');
  liquid = 'air';
  assert.equal(idle.pick(bot)?.name, 'pick up items');
});

// A wheat field next to her, ripe or not, in the store, and walk scaffolding out of the way.
function farmSetup({ age = 7 } = {}) {
  const s = setup();
  const { bot, idle } = s;
  const blocks = new Map([['1,63,1', ['farmland', {}]], ['1,64,1', ['wheat', { age }]]]);
  bot.blocks = blocks;
  bot.blockAt = (p) => {
    const [name, props] = blocks.get(`${p.x},${p.y},${p.z}`) ?? ['air', {}];
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => props };
  };
  bot.pathfinder.bestHarvestTool = () => null;
  bot.canDigBlock = () => true;
  bot.dig = async (block) => blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, ['air', {}]);
  bot.lookAt = async () => {};
  idle.scaffoldTops = () => [];
  idle.later('stroll', 1e9);
  idle.tended = new Tended();
  idle.tended.add('fields', { x: 1, y: 63, z: 1, x2: 1, y2: 63, z2: 1, dimension: 'overworld' });
  return s;
}

test('a ripe field she was asked to look after is tended as a chore, then not again for ten minutes', async () => {
  const { bot, idle, lines } = farmSetup();
  idle.hold();
  idle.tick();
  assert.equal(idle.running, null);
  idle.release();
  idle.brain.standingActive = true;
  idle.brain.standingRound = () => {};
  assert.equal(idle.pick(bot), null);
  idle.brain.standingActive = false;

  idle.tick();
  assert.ok(idle.running);
  await idle.running.done;
  assert.equal(lines[0], '[idle] tend the fields');
  assert.match(lines[1], /^\[idle\] tend the fields: harvested 1 in the box from 1 63 1 to 1 63 1/);
  assert.equal(lines.length, 2);
  assert.equal(bot.blocks.get('1,64,1')[0], 'air');
  assert.ok(idle.until.get('fields') - Date.now() > 9 * 60000);
  bot.blocks.set('1,64,1', ['wheat', { age: 7 }]);
  assert.equal(idle.pick(bot), null);
});

test('an unripe field is looked at again only after a minute', () => {
  const { bot, idle } = farmSetup({ age: 3 });
  assert.equal(idle.pick(bot), null);
  const wait = idle.until.get('fields') - Date.now();
  assert.ok(wait > 50000 && wait <= 60000);
  bot.blocks.set('1,64,1', ['wheat', { age: 7 }]);
  assert.equal(idle.pick(bot), null);
  idle.until.delete('fields');
  assert.equal(idle.pick(bot)?.name, 'tend the fields');
});

test('a pen that is due is tended as a chore, held by a stop, and its next visit is saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-pens-'));
  try {
    const { bot, idle, lines } = farmSetup({ age: 3 });
    const path = join(dir, 'tended.json');
    idle.tended = new Tended(path);
    idle.tended.add('pens', { x: 2, y: 64, z: 2, dimension: 'overworld', lastTended: 0, nextAt: 0 });
    idle.hold();
    idle.tick();
    assert.equal(idle.running, null);
    idle.release();
    assert.equal(idle.pick(bot)?.name, 'tend the pens');
    idle.tick();
    await idle.running.done;
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '[idle] tend the pens');
    assert.match(lines[1], /^\[idle\] tend the pens: no farm animals in the pen around 2 61 2, nothing to do$/);
    const saved = new Tended(path).list('pens', 'overworld')[0];
    assert.ok(saved.nextAt > Date.now() + 19 * 60000);
    assert.ok(idle.until.get('pens') - Date.now() > 9 * 60000);
    assert.equal(idle.pick(bot), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with chores off, a hold keeps standing rounds off too', () => {
  const { idle } = setup();
  let rounds = 0;
  idle.config.idle.enabled = false;
  idle.brain.standingActive = true;
  idle.brain.standingRound = () => rounds++;
  idle.hold();
  idle.tick();
  assert.equal(rounds, 0);
  idle.release();
  idle.tick();
  assert.equal(rounds, 1);
});
