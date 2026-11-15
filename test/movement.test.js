import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setImmediate } from 'node:timers/promises';
import { setupMovements, walkTo, walkPatience, followPlayer } from '../src/actions/movement.js';
import { pause, delay, setPauseScale } from '../src/actions/util.js';

// Real 26.1 blocks, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);
const { GoalBlock, GoalNear, GoalFollow } = pathfinderPkg.goals;

function world() {
  const blocks = new Map();
  return {
    set: (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, Block.fromProperties(name, props, 0)),
    get: (p) => {
      const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const b = blocks.get(`${f.x},${f.y},${f.z}`);
      const out = b ? Block.fromStateId(b.stateId, 0) : Block.fromProperties('air', {}, 0);
      out.position = f;
      return out;
    },
    floor(y = 63) {
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) this.set(x, y, z, 'stone');
    }
  };
}

function movementsIn(w, extra = {}) {
  const bot = {
    registry, game: { minY: -64 }, entities: {}, players: {},
    entity: { position: new Vec3(0, 64, 0), effects: {} },
    inventory: { items: () => [] },
    blockAt: (p) => w.get(p),
    on: () => {},
    pathfinder: { setMovements() {}, bestHarvestTool: () => ({ type: registry.itemsByName.diamond_pickaxe.id }) },
    ...extra
  };
  setupMovements(bot);
  return bot.moveModes.noPlace;
}

function plan(w, from, goal, extra) {
  return new AStar(new Move(from.x, from.y, from.z, 0, 0), movementsIn(w, extra), goal, 5000, 10000, -1).compute();
}

const cells = (path) => path.map((n) => `${n.x},${n.y},${n.z}`);

test('a path handed out in pieces gets fresh steps each time', () => {
  const w = world();
  w.floor();
  const astar = new AStar(new Move(0, 64, -3, 0, 0), movementsIn(w), new GoalBlock(0, 64, 3), 5000, 0, -1);
  let result = astar.compute();
  assert.equal(result.status, 'partial');
  // The pathfinder moves steps in place (here: up a block). The next piece must not see that.
  while (result.status === 'partial') {
    for (const step of result.path) step.y += 1;
    result = astar.compute();
  }
  assert.equal(result.status, 'success');
  assert.ok(result.path.every((n) => n.y === 64));
});

test('a door is only walked through straight on, never from the side', () => {
  const door = (w, facing) => {
    w.set(0, 64, 0, 'spruce_door', { facing, half: 'lower', hinge: 'left', open: 'true' });
    w.set(0, 65, 0, 'spruce_door', { facing, half: 'upper', hinge: 'left', open: 'true' });
  };
  // A door in a wall, facing the way through it.
  const inWall = world();
  inWall.floor();
  for (let x = -4; x <= 4; x++) if (x !== 0) for (let y = 64; y <= 66; y++) inWall.set(x, y, 0, 'stone');
  door(inWall, 'south');
  assert.ok(cells(plan(inWall, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2)).path).includes('0,64,0'));

  // A door facing east, passed north to south: the open door is in the way, so walk around it.
  const loose = world();
  loose.floor();
  door(loose, 'east');
  const result = plan(loose, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2));
  assert.equal(result.status, 'success');
  assert.ok(!cells(result.path).includes('0,64,0'));
});

test('an open trapdoor is not something to stand on or walk through', () => {
  const w = world();
  w.floor();
  w.set(0, 64, 0, 'spruce_trapdoor', { facing: 'west', half: 'bottom', open: 'true' });
  w.set(1, 64, 0, 'spruce_trapdoor', { facing: 'west', half: 'bottom', open: 'false' });
  const m = movementsIn(w);
  const open = m.getBlock(new Vec3(0, 64, 0), 0, 0, 0);
  assert.equal(open.physical, false);
  assert.equal(open.safe, false);
  // A closed one on the ground is still a low step.
  assert.equal(m.getBlock(new Vec3(1, 64, 0), 0, 0, 0).physical, true);
});

test("the walk never digs through the bot's own blocks, even natural-looking ones", () => {
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) for (let y = 64; y <= 67; y++) w.set(x, y, 0, 'tuff');
  const wild = plan(w, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2));
  assert.equal(wild.status, 'success');
  const own = plan(w, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2), { placedLog: { has: (p, name) => name === 'tuff' && p.z === 0 } });
  assert.notEqual(own.status, 'success');
});

test('walk patience grows with the distance, from 20 s up to the configured limit', () => {
  assert.equal(walkPatience(2, 90), 20000);
  assert.equal(walkPatience(5, 90), 20000);
  assert.equal(walkPatience(10, 90), 30000);
  assert.equal(walkPatience(30, 90), 90000);
  assert.equal(walkPatience(200, 90), 90000);
});

function walker(start) {
  const state = { mining: false };
  const bot = {
    entity: { position: start },
    pathfinder: { goto: () => new Promise(() => {}), setGoal() {}, isMining: () => state.mining, isBuilding: () => false }
  };
  return { state, ctx: { bot, config: { limits: { moveTimeoutSeconds: 90 } } } };
}

async function walkFor(t, walk, seconds) {
  let result = null;
  walk.then((r) => { result = r; });
  for (let i = 0; i < seconds && !result; i++) {
    t.mock.timers.tick(1000);
    await setImmediate();
  }
  return result;
}

test('a short walk that gets nowhere gives up in seconds, a long one keeps its patience', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const short = walker(new Vec3(0, 64, 0));
  const walk = walkTo(short.ctx, new GoalNear(5, 64, 0, 1));
  assert.equal(await walkFor(t, walk, 20), null);
  const result = await walkFor(t, walk, 3);
  assert.equal(result.ok, false);
  assert.match(result.message, /^stuck, got no closer for 21s/);

  const long = walker(new Vec3(0, 64, 0));
  const far = walkTo(long.ctx, new GoalNear(60, 64, 0, 1));
  assert.equal(await walkFor(t, far, 85), null);
  assert.match((await walkFor(t, far, 10)).message, /^stuck/);
});

test('digging on a short walk does not count against it, but the old limit still holds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { state, ctx } = walker(new Vec3(0, 64, 0));
  state.mining = true;
  const walk = walkTo(ctx, new GoalNear(5, 64, 0, 1));
  assert.equal(await walkFor(t, walk, 60), null);
  assert.match((await walkFor(t, walk, 35)).message, /^stuck, got no closer for 9\ds/);
});

test('following picks the player up again after they leave view and come back', async () => {
  const first = { id: 1, position: new Vec3(3, 64, 0) };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    players: { Steve: { username: 'Steve', entity: first } },
    entities: { 1: first },
    pathfinder: { setGoal: (goal) => { bot.goal = goal; } }
  };
  assert.equal((await followPlayer({ bot }, { player: 'steve' })).ok, true);
  const goal = bot.goal;
  assert.ok(goal instanceof GoalFollow);
  assert.equal(goal.entity, first);

  // Out of view: the entity is dropped, the goal keeps the last place they were seen.
  delete bot.entities[1];
  bot.players.Steve.entity = null;
  assert.equal(goal.entity, first);
  assert.equal(goal.isValid(), true);
  assert.equal(goal.hasChanged(), false);

  // Back, as a new entity somewhere else.
  const back = { id: 9, position: new Vec3(30, 64, 4) };
  bot.entities[9] = back;
  bot.players.Steve.entity = back;
  assert.equal(goal.entity, back);
  assert.equal(goal.hasChanged(), true);
  assert.deepEqual([goal.x, goal.y, goal.z], [30, 64, 4]);
  assert.equal(bot.entities[goal.entity.id], back);
});

test('pauses scale with the setting, 0 means none', async () => {
  setPauseScale(0);
  const start = Date.now();
  await pause(2000, 3000);
  assert.ok(Date.now() - start < 500);
  setPauseScale(1);
});

test('a scale of 0 leaves the waits the bot depends on alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setPauseScale(0);
  let done = false;
  delay(300).then(() => { done = true; });
  t.mock.timers.tick(299);
  await setImmediate();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(done, true);
  setPauseScale(1);
});
