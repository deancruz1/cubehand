import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { setupMovements, walkTo, walkPatience, followPlayer, planRoute, centreRawSteps, playerPlaced, ladderEntrySteps, doorOpener, underBot, watchScaffold } from '../src/actions/movement.js';
import { DigSpot } from '../src/actions/mining.js';
import { placeOne, removeScaffold } from '../src/actions/blocks.js';
import { watchBuildScaffold, buildZone } from '../src/actions/build.js';
import { Idle } from '../src/idle.js';
import { pause, delay, setPauseScale } from '../src/actions/util.js';
import { ScaffoldLog } from '../src/placed.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Real 26.1 blocks, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);
const { Physics, PlayerState } = require('prismarine-physics');
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

// A bot with the real pathfinder plugged in, standing in w. The pathfinder only searches here:
// nothing emits physicsTick, so it never walks.
function liveBot(w, { at = new Vec3(0.5, 64, 0.5), items = [], ...extra } = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry, game: { minY: -64 }, entities: {}, players: {},
    entity: { position: at.clone(), velocity: new Vec3(0, 0, 0), onGround: true, effects: {} },
    inventory: { items: () => items.map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    blockAt: (p) => w.get(p),
    controlState: {},
    clearControlStates() {},
    setControlState() {},
    ...extra
  });
  // First solid block along the ray, for look goals.
  bot.world = {
    raycast: (start, dir, range) => {
      for (let t = 0; t <= range; t += 0.05) {
        const b = w.get(start.plus(dir.scaled(t)));
        if (b.boundingBox === 'block') return Object.assign(b, { face: 1 });
      }
      return null;
    }
  };
  pathfinderPkg.pathfinder(bot);
  setupMovements(bot);
  return bot;
}

function slab(w, x0, x1, z0, z1, y = 63, name = 'stone') {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) w.set(x, y, z, name);
}

const steps = (path) => path.map((n) => `${Math.floor(n.x)},${Math.floor(n.y)},${Math.floor(n.z)}`);
const builds = (path) => path.some((n) => n.toBreak.length > 0 || n.toPlace.length > 0);

test('a wall with a door further along: the plan goes through the door, not the wall', async () => {
  const w = world();
  slab(w, -10, 10, -4, 4);
  for (let x = -10; x <= 10; x++) for (let y = 64; y <= 66; y++) w.set(x, y, 0, 'dirt');
  w.set(8, 64, 0, 'oak_door', { facing: 'south', half: 'lower', hinge: 'left', open: 'false' });
  w.set(8, 65, 0, 'oak_door', { facing: 'south', half: 'upper', hinge: 'left', open: 'false' });
  const bot = liveBot(w, { at: new Vec3(0.5, 64, -2.5), items: [['iron_shovel', 1]] });
  const goal = new GoalBlock(0, 64, 2);
  // At the old dig cost of 3, digging straight through with a shovel was cheaper than the door.
  const old = bot.moveModes.climb;
  const greedy = bot.pathfinder.getPathFromTo(old, bot.entity.position, goal, { tickTimeout: 10000 }).next().value.result;
  assert.equal(greedy.status, 'success');
  assert.ok(greedy.path.some((n) => n.toBreak.length > 0));

  const plan = await planRoute(bot, goal, true);
  assert.equal(plan.status, 'success');
  // The pathfinder lifts the doorway step onto the door's shape, fixPassageSteps puts it back later.
  assert.ok(steps(plan.path).some((c) => c.startsWith('8,') && c.endsWith(',0')), steps(plan.path).join(' '));
  assert.equal(builds(plan.path), false);
});

test('a roof with stairs round the back: the plan takes the stairs, not a pillar', async () => {
  const w = world();
  slab(w, -6, 10, -6, 10);
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) for (let y = 64; y <= 68; y++) w.set(x, y, z, 'oak_planks');
  for (let x = 0; x <= 4; x++) for (let y = 64; y <= 64 + x; y++) w.set(x, y, 5, 'cobblestone');
  const bot = liveBot(w, { at: new Vec3(2.5, 64, -3.5), items: [['dirt', 20]], buildZone: { min: new Vec3(-2, 63, -2), max: new Vec3(6, 70, 7) } });
  const goal = new GoalNear(2, 69, 2, 1);
  // Searched straight away with cheap scaffolding, a pillar at the front wins.
  const climb = bot.pathfinder.getPathFromTo(bot.planModes.climb, bot.entity.position, goal, { tickTimeout: 10000 }).next().value.result;
  assert.equal(climb.status, 'success');
  assert.ok(climb.path.some((n) => n.toPlace.length > 0));

  const plan = await planRoute(bot, goal, 'climb');
  assert.equal(plan.status, 'success');
  assert.equal(builds(plan.path), false);
  assert.ok(steps(plan.path).some((c) => c.endsWith(',5')));
});

test('no way up and no blocks: the walk fails, says what it tried, and digs nothing', async () => {
  const w = world();
  w.floor();
  for (let y = 64; y <= 69; y++) w.set(3, y, 0, 'oak_planks');
  const bot = liveBot(w);
  const updates = [];
  bot.on('path_update', (r) => updates.push(r));
  const ctx = { bot, config: { limits: { moveTimeoutSeconds: 90 } } };
  const result = await walkTo(ctx, new GoalNear(3, 70, 0, 0));
  assert.equal(result.ok, false);
  assert.match(result.message, /^no route found, so nothing was dug or placed/);
  assert.match(result.message, /on foot \(no way within \d+ blocks of walking\), then digging and placing \(no way at all\)/);
  assert.match(result.message, /no spare dirt/);
  assert.ok(updates.every((r) => !builds(r.path)));
  assert.equal(bot.pathfinder.goal, null);
});

test('no way up but dirt in the inventory: the plan pillars up', async () => {
  const w = world();
  w.floor();
  for (let y = 64; y <= 69; y++) w.set(3, y, 0, 'stone');
  const bot = liveBot(w, { items: [['dirt', 20]] });
  const goal = new GoalNear(3, 70, 0, 0);
  const plan = await planRoute(bot, goal, true);
  assert.equal(plan.status, 'success');
  assert.ok(plan.path.reduce((sum, n) => sum + n.toPlace.length, 0) >= 6);
  assert.ok(goal.isEnd(new Vec3(...steps(plan.path).at(-1).split(',').map(Number))));
});

test('a search that runs out of time never hands out a way that digs or places', async () => {
  const w = world();
  slab(w, -4, 70, -4, 4);
  for (let y = 64; y <= 93; y++) w.set(64, y, 0, 'stone');
  const goal = new GoalNear(64, 94, 0, 0);
  const budget = { onFootMs: 10, buildMs: 10 };

  // Right at the foot of the column, the pathfinder's first answer is to start a pillar.
  const below = liveBot(w, { at: new Vec3(63.5, 64, 0.5), items: [['dirt', 64]] });
  const first = below.pathfinder.getPathFromTo(below.moveModes.walk, below.entity.position, goal, { timeout: 10 }).next().value.result;
  assert.notEqual(first.status, 'success');
  assert.ok(first.path.some((n) => n.toPlace.length > 0));
  const stuck = await planRoute(below, goal, true, budget);
  assert.equal(stuck.status, 'none');
  assert.match(stuck.message, /nothing complete after 0.01s/);

  // Far off, it may walk part of the way, on foot only.
  const far = liveBot(w, { at: new Vec3(0.5, 64, 0.5), items: [['dirt', 64]] });
  const part = await planRoute(far, goal, true, { onFootMs: 30, buildMs: 30 });
  assert.equal(part.status, 'partial');
  assert.equal(builds(part.path), false);
  assert.ok(part.path.at(-1).x > 2);
});

test("a planned walk keeps its steps after its own digging, and plans again after anyone else's", async () => {
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) for (let y = 64; y <= 66; y++) w.set(x, y, 0, 'dirt');
  const bot = liveBot(w, { at: new Vec3(0.5, 64, -2.5) });
  const goal = new GoalBlock(0, 64, 2);
  const walk = walkTo({ bot, config: { limits: { moveTimeoutSeconds: 90 } } }, goal);
  const ready = async () => {
    while (!bot.plannedWalk?.ready) await setImmediate();
  };
  await ready();
  const handed = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal);
  assert.equal(handed.status, 'success');
  const dig = handed.path.find((n) => n.toBreak.length > 0);
  assert.ok(dig);

  // The wall block it was meant to dig goes: the pathfinder resets and gets the same steps back.
  const block = dig.toBreak[0];
  bot.emit('path_reset', 'block_updated');
  bot.emit('blockUpdate', w.get(block), Block.fromProperties('air', {}, 0));
  assert.equal(bot.pathfinder.getPathTo(bot.pathfinder.movements, goal).path, handed.path);

  // Someone else changes a block next to the way: stand still and plan again.
  const beside = w.get(new Vec3(1, 64, -1));
  bot.emit('path_reset', 'block_updated');
  bot.emit('blockUpdate', beside, Object.assign(Block.fromProperties('dirt', {}, 0), { position: beside.position }));
  const held = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal);
  assert.equal(held.status, 'planning');
  assert.deepEqual(held.path, []);
  await ready();

  bot.pathfinder.setGoal(null);
  assert.match((await walk).message, /^movement was interrupted/);
});

// Solid name everywhere except the open cells.
function rock(name, open = []) {
  const holes = new Set(open.map(cellKey));
  const solid = Block.fromProperties(name, {}, 0).stateId;
  const air = Block.fromProperties('air', {}, 0).stateId;
  const extra = new Map();
  return {
    set: (x, y, z, block) => extra.set(`${x},${y},${z}`, Block.fromProperties(block, {}, 0).stateId),
    get: (p) => {
      const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const k = cellKey(f);
      const out = Block.fromStateId(extra.get(k) ?? (holes.has(k) ? air : solid), 0);
      out.position = f;
      return out;
    }
  };
}
const cellKey = (p) => `${p.x},${p.y},${p.z}`;
const dugNames = (w, path) => path.flatMap((n) => n.toBreak.map((b) => w.get(b).name));

test('a buried block gets dug to on a dig walk, and only on one', async () => {
  const w = rock('deepslate', [new Vec3(0, 64, 0), new Vec3(0, 65, 0)]);
  const bot = liveBot(w, { items: [['stone_pickaxe', 1]] });
  const target = new Vec3(15, 54, 0);
  const goal = new DigSpot(target, bot.world, { reach: 4 });
  // A look goal raycasts the rock as it is, so a plain walk never finds a spot to end on.
  const plain = await planRoute(bot, goal, false, { onFootMs: 200, buildMs: 300 });
  assert.equal(plain.status, 'none');

  const plan = await planRoute(bot, goal, false, { dig: true });
  assert.equal(plan.status, 'success');
  const end = plan.path.at(-1);
  assert.ok(new Vec3(Math.floor(end.x), Math.floor(end.y), Math.floor(end.z)).distanceTo(target) <= 2);
  assert.ok(dugNames(w, plan.path).length >= 30);
});

test('a dig walk goes round what it may not dig, and out of time it may hand out a way that digs terrain', async () => {
  const w = rock('stone', [new Vec3(0, 64, 0), new Vec3(0, 65, 0)]);
  for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) w.set(8, y, z, 'oak_planks');
  const bot = liveBot(w, { items: [['iron_pickaxe', 1]] });
  const goal = new DigSpot(new Vec3(200, 64, 0), bot.world, { reach: 4 });
  const plan = await planRoute(bot, goal, false, { dig: true });
  assert.equal(plan.status, 'success');
  assert.ok(dugNames(w, plan.path).every((n) => n === 'stone'));

  const part = await planRoute(bot, goal, false, { dig: true, onFootMs: 10, buildMs: 10 });
  assert.equal(part.status, 'partial');
  assert.ok(dugNames(w, part.path).length > 0);
  assert.ok(dugNames(w, part.path).every((n) => n === 'stone'));
});

test('a dig walk to a block lying open still walks the way round, not through the hill', async () => {
  const w = world();
  slab(w, -8, 8, -4, 8);
  for (let x = -3; x <= 3; x++) for (let z = 1; z <= 2; z++) for (let y = 64; y <= 66; y++) w.set(x, y, z, 'dirt');
  w.set(0, 64, 5, 'stone');
  const bot = liveBot(w, { at: new Vec3(0.5, 64, -2.5), items: [['iron_pickaxe', 1], ['iron_shovel', 1]] });
  const plan = await planRoute(bot, new DigSpot(new Vec3(0, 64, 5), bot.world, { reach: 4 }), false, { dig: true });
  assert.equal(plan.status, 'success');
  assert.equal(builds(plan.path), false);
});

test('a block a player just put down is not dug through on a walk, for an hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) for (let y = 64; y <= 66; y++) if (!(x === 0 && y < 66)) w.set(x, y, 0, 'dirt');
  const steve = { position: new Vec3(1.5, 64, -1.5) };
  const bot = liveBot(w, { at: new Vec3(0.5, 64, -2.5), players: { Steve: { username: 'Steve', entity: steve } } });
  // Steve patches the hole in the wall.
  for (const y of [64, 65]) {
    const old = w.get(new Vec3(0, y, 0));
    w.set(0, y, 0, 'dirt');
    bot.emit('blockUpdate', old, w.get(new Vec3(0, y, 0)));
  }
  assert.equal(playerPlaced(bot, new Vec3(0, 64, 0)), true);
  const goal = new GoalBlock(0, 64, 2);
  const plan = await planRoute(bot, goal, true);
  assert.equal(plan.status, 'success');
  const dug = plan.path.flatMap((n) => n.toBreak.map(cellKey));
  assert.ok(dug.length > 0);
  assert.ok(!dug.includes('0,64,0') && !dug.includes('0,65,0'), dug.join(' '));
  t.mock.timers.tick(3600001);
  assert.equal(playerPlaced(bot, new Vec3(0, 64, 0)), false);
});

test('steps after a dig or place aim at the middle of their block, not its corner', () => {
  const path = [
    new Move(1, 64, 0, 0, 1),
    new Move(2, 64, 0, 0, 20, [new Vec3(2, 64, 0)]),
    new Move(3, 63, 0, 0, 1)
  ];
  path[0].x = 1.5;
  path[0].z = 0.5;
  centreRawSteps(path);
  assert.deepEqual(path.map((n) => [n.x, n.y, n.z]), [[1.5, 64, 0.5], [2.5, 64, 0.5], [3.5, 63, 0.5]]);
});

test('walking after a moving goal is left to the pathfinder', async () => {
  const w = world();
  w.floor();
  const bot = liveBot(w);
  const went = [];
  bot.pathfinder.goto = async (goal) => {
    went.push(goal);
    bot.entity.position = new Vec3(2.5, 64, 0.5);
  };
  const mob = { position: new Vec3(3, 64, 0) };
  const result = await walkTo({ bot, config: { limits: { moveTimeoutSeconds: 90 } } }, new GoalFollow(mob, 1.5), { place: false });
  assert.equal(result.ok, true);
  assert.equal(went.length, 1);
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

// A bot moved by the real physics, one tick per turn of the event loop, with the real
// pathfinder walking it. press(block) stands in for the server when a button, lever or door
// is used, and later(ticks, fn) runs fn that many ticks on. With building set, blocks it places
// and digs really change in w, as the server would answer.
function physicsBot(w, at, { items = [], press = () => {}, building = false } = {}) {
  const bot = new EventEmitter();
  bot.setMaxListeners(50);
  const controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const timers = [];
  let ticks = 0;
  Object.assign(bot, {
    version: '26.1', registry, game: { minY: -64 }, entities: {}, players: {},
    entity: { position: at.clone(), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0 },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { items: () => items.map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })), slots: [] },
    blockAt: (p) => w.get(p),
    controlState,
    setControlState: (k, v) => { controlState[k] = v; },
    clearControlStates: () => { for (const k of Object.keys(controlState)) controlState[k] = false; },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    lookAt: async (p) => {
      const d = p.minus(bot.entity.position.offset(0, 1.62, 0));
      bot.entity.yaw = Math.atan2(-d.x, -d.z);
      bot.entity.pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
    },
    equip: async () => {},
    stopDigging() {},
    dug: [],
    pressed: [],
    dig: async (b) => { bot.dug.push(b.position.toString()); },
    activateBlock: async (b) => { bot.pressed.push(b.name); press(b); },
    later: (n, fn) => timers.push({ at: ticks + n, fn })
  });
  if (building) {
    const change = (p, name) => {
      const old = w.get(p);
      w.set(p.x, p.y, p.z, name);
      bot.emit('blockUpdate', old, w.get(p));
    };
    Object.assign(bot, {
      placed: [],
      equip: async (item) => { bot.heldItem = item; },
      canDigBlock: () => true,
      placeBlock: async (ref, face) => {
        const p = ref.position.plus(face);
        bot.placed.push(p.toString());
        change(p, bot.heldItem.name);
      },
      dig: async (b) => {
        bot.dug.push(b.position.toString());
        change(b.position, 'air');
      }
    });
  }
  bot.world = {
    raycast: (start, dir, range) => {
      for (let t = 0; t <= range; t += 0.05) {
        const b = w.get(start.plus(dir.scaled(t)));
        if (b.boundingBox === 'block') return b;
      }
      return null;
    }
  };
  const blocks = { getBlock: (p) => w.get(p) };
  bot.physics = Physics(registry, blocks);
  pathfinderPkg.pathfinder(bot);
  setupMovements(bot);
  bot.tick = () => {
    ticks++;
    for (const t of timers.filter((t) => t.at <= ticks)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    bot.physics.simulatePlayer(new PlayerState(bot, controlState), blocks).apply(bot);
    bot.emit('physicsTick');
  };
  return bot;
}

async function run(bot, walk, ticks = 800) {
  let done = null;
  walk.then((r) => { done = r; });
  for (let i = 0; i < ticks && !done; i++) {
    await setImmediate();
    bot.tick();
  }
  if (!done) {
    bot.pathfinder.setGoal(null);
    done = await walk;
  }
  return done;
}

const limits = { limits: { moveTimeoutSeconds: 90 } };

// A tunnel with its floor at y 55, a ladder at (0, 56..59, 0) on a wall behind it, and the
// way out on the grass at y 60.
function ladderShaft(facing, snow) {
  const w = world();
  const back = { east: [-1, 0], west: [1, 0], south: [0, -1], north: [0, 1] }[facing];
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      w.set(x, 55, z, 'stone');
      w.set(x, 58, z, 'stone');
      w.set(x, 59, z, 'grass_block');
      if (snow) w.set(x, 56, z, 'snow', { layers: 1 });
    }
  }
  for (let y = 56; y <= 59; y++) {
    w.set(0, y, 0, 'ladder', { facing, waterlogged: 'false' });
    w.set(back[0], y, back[1], 'stone');
  }
  return { w, out: new GoalBlock(-back[0], 60, -back[1]) };
}

test('a ladder is climbed from in front and from either side, with snow at the feet or not', async () => {
  for (const [facing, from] of [['east', [1, 0]], ['east', [0, 1]], ['east', [0, -1]], ['north', [1, 0]], ['south', [-1, 0]]]) {
    for (const snow of [false, true]) {
      const { w, out } = ladderShaft(facing, snow);
      const bot = physicsBot(w, new Vec3(0.5 + from[0], 56, 0.5 + from[1]));
      const result = await run(bot, walkTo({ bot, config: limits }, out, { place: false }));
      assert.equal(result.ok, true, `${facing} ladder from ${from}${snow ? ' on snow' : ''}: ${result.message}`);
    }
  }
});

test('a step up a ladder from the side gets a step into the ladder block first, once', () => {
  const { w } = ladderShaft('east', true);
  const up = new Move(0, 56, 0, 0, 1);
  up.x = 0.3;
  up.y = 57;
  up.z = 0.5;
  const path = [up];
  const from = new Vec3(0.5, 56, 1.3);
  ladderEntrySteps(path, from, (p) => w.get(p));
  assert.deepEqual(path.map((n) => [n.x, n.y, n.z]), [[0.5, 56, 0.5], [0.3, 57, 0.5]]);
  ladderEntrySteps(path, from, (p) => w.get(p));
  assert.equal(path.length, 2);
});

// A wall of deepslate bricks along z = 0 with an iron door at x 0, natural stone right beside
// and over the door, and the bot to the north.
function ironDoorWall(opener) {
  const w = world();
  slab(w, -6, 6, -6, 6);
  for (let x = -6; x <= 6; x++) for (let y = 64; y <= 67; y++) w.set(x, y, 0, x === 1 || x === -1 || y === 66 ? 'stone' : 'deepslate_bricks');
  const door = (open) => {
    for (const [y, half] of [[64, 'lower'], [65, 'upper']]) w.set(0, y, 0, 'iron_door', { facing: 'south', half, hinge: 'left', open: String(open), powered: String(open) });
  };
  door(false);
  if (opener === 'button') w.set(1, 65, -1, 'stone_button', { face: 'wall', facing: 'north', powered: 'false' });
  if (opener === 'far button') w.set(1, 65, 1, 'stone_button', { face: 'wall', facing: 'south', powered: 'false' });
  if (opener === 'lever') w.set(-1, 65, -1, 'lever', { face: 'wall', facing: 'north', powered: 'false' });
  if (opener === 'plate') w.set(0, 64, -1, 'stone_pressure_plate', { powered: 'false' });
  return { w, door };
}

// The server's side of it: a stone button holds the door open for 20 ticks, a lever until it
// is switched back, a plate while someone stands on it and 20 ticks after.
function ironDoorBot(opener) {
  const { w, door } = ironDoorWall(opener);
  let bot;
  const setDoor = (open) => {
    const old = [w.get(new Vec3(0, 64, 0)), w.get(new Vec3(0, 65, 0))];
    door(open);
    for (const b of old) bot.emit('blockUpdate', b, w.get(b.position));
  };
  bot = physicsBot(w, new Vec3(0.5, 64, -3.5), {
    items: [['iron_pickaxe', 1]],
    press: (b) => {
      if (b.name === 'stone_button') {
        setDoor(true);
        bot.later(20, () => setDoor(false));
      } else if (b.name === 'lever') {
        const on = String(b.getProperties().powered) !== 'true';
        w.set(b.position.x, b.position.y, b.position.z, 'lever', { face: 'wall', facing: 'north', powered: String(on) });
        setDoor(on);
      }
    }
  });
  if (opener === 'plate') {
    let on = false;
    bot.on('physicsTick', () => {
      const p = bot.entity.position;
      const onPlate = Math.floor(p.x) === 0 && Math.floor(p.z) === -1 && Math.abs(p.y - 64) < 0.1;
      if (onPlate && !on) setDoor(true);
      if (!onPlate && on) bot.later(20, () => setDoor(false));
      on = onPlate;
    });
  }
  return { w, bot };
}

const through = new GoalBlock(0, 64, 3);

test('an iron door with a button on this side: she presses it and goes through, digging nothing', async () => {
  const { bot } = ironDoorBot('button');
  const plan = await planRoute(bot, through, true);
  assert.equal(plan.status, 'success');
  assert.ok(steps(plan.path).some((c) => c.startsWith('0,') && c.endsWith(',0')));
  assert.equal(builds(plan.path), false);
  const result = await run(bot, walkTo({ bot, config: limits }, through, { place: false }));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.pressed, ['stone_button']);
  assert.deepEqual(bot.dug, []);
});

test('an iron door with a pressure plate in front opens by walking onto it', async () => {
  const { bot } = ironDoorBot('plate');
  const result = await run(bot, walkTo({ bot, config: limits }, through, { place: false }));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.pressed, []);
});

test('an iron door with a lever: she switches it on, and says so when it is out of reach on the far side', async () => {
  const { w, bot } = ironDoorBot('lever');
  const result = await run(bot, walkTo({ bot, config: limits }, through, { place: false }));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.pressed, ['lever']);
  assert.match(result.message, /I left the lever at -1 65 -1 on, so the iron door at 0 64 0 stays open/);
  assert.equal(String(w.get(new Vec3(-1, 65, -1)).getProperties().powered), 'true');
});

test('an iron door that only opens from the far side: no digging round it, and the walk says why', async () => {
  for (const opener of [null, 'far button']) {
    const { w, bot } = ironDoorBot(opener);
    assert.equal(doorOpener(bot, new Vec3(0, 64, 0), new Vec3(0, 64, -1)), null);
    // The stone beside the door is terrain the walk could dig, but it touches the door.
    const beside = w.get(new Vec3(1, 64, 0));
    const m = bot.planModes.walk;
    assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(m)).safeToBreak.call(m, beside), true);
    assert.equal(m.safeToBreak(beside), false);
    const result = await run(bot, walkTo({ bot, config: limits }, through));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_route');
    assert.match(result.message, /There is an iron door at 0 64 0 with no button, lever or pressure plate on this side/);
    assert.deepEqual(bot.dug, []);
  }
});

test('following never digs: through an iron door with a button, and behind one without, she waits', async () => {
  const player = { position: new Vec3(0.5, 64, 3.5) };
  const follow = async (opener) => {
    const { bot } = ironDoorBot(opener);
    bot.pathfinder.setGoal(new GoalFollow(player, 1), true);
    let caught = false;
    for (let i = 0; i < 400 && !caught; i++) {
      await setImmediate();
      bot.tick();
      caught = bot.entity.position.distanceTo(player.position) <= 1.5;
    }
    assert.equal(bot.pathfinder.movements.canDig, false);
    assert.equal(bot.moveMode, 'follow');
    bot.pathfinder.setGoal(null);
    return { bot, caught };
  };
  const open = await follow('button');
  assert.equal(open.caught, true);
  assert.deepEqual(open.bot.pressed, ['stone_button']);
  const shut = await follow(null);
  assert.equal(shut.caught, false);
  assert.deepEqual(shut.bot.dug, []);
  assert.ok(shut.bot.entity.position.z < 0);

  // Out in the open with only a dirt wall between, a follow search hands out nothing that digs.
  const w = world();
  slab(w, -8, 8, -4, 4);
  for (let x = -8; x <= 8; x++) for (let y = 64; y <= 66; y++) w.set(x, y, 0, 'dirt');
  const bot = liveBot(w, { at: new Vec3(0.5, 64, -2.5) });
  bot.players.Steve = { username: 'Steve', entity: { position: new Vec3(0.5, 64, 2.5) } };
  followPlayer({ bot }, { player: 'Steve' });
  const result = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, bot.pathfinder.goal, { tickTimeout: 10000 }).next().value.result;
  assert.equal(builds(result.path), false);
});

let logs = 0;
// A ScaffoldLog in a temp file, removed again by done().
function tempLog() {
  const path = join(tmpdir(), `scaffold-test-${process.pid}-${logs++}.json`);
  const log = new ScaffoldLog(path);
  log.done = () => {
    log.save();
    rmSync(path, { force: true });
  };
  return log;
}

const logged = (log) => [...log.blocks.values()].map((e) => new Vec3(e.x, e.y, e.z).toString());

// A wall three blocks high at x 3 the whole way across, with no way up but a pillar.
function wallWorld() {
  const w = world();
  w.floor();
  for (let z = -4; z <= 4; z++) for (let y = 64; y <= 66; y++) w.set(3, y, z, 'stone');
  return w;
}

test('a walk that pillars up keeps note of its own blocks only, and takes down the ones in reach once there', async () => {
  const w = wallWorld();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  bot.walkScaffold = tempLog();
  try {
    // Someone else's block turns up while she is putting hers down.
    const other = new Vec3(-3, 64, -3);
    bot.on('physicsTick', () => {
      if (!bot.pathfinder.isBuilding() || w.get(other).name !== 'air') return;
      const old = w.get(other);
      w.set(other.x, other.y, other.z, 'cobblestone');
      bot.emit('blockUpdate', old, w.get(other));
    });
    const result = await run(bot, walkTo({ bot, config: limits }, new GoalNear(3, 67, 0, 0)));
    assert.equal(result.ok, true, result.message);
    assert.equal(w.get(other).name, 'cobblestone');
    assert.ok(bot.placed.length >= 3, bot.placed.join(' '));
    // Every block she put down was either taken down, top first, or is still on the list.
    const left = logged(bot.walkScaffold);
    assert.deepEqual([...bot.dug, ...left].sort(), [...bot.placed].sort());
    assert.ok(bot.dug.length > 0);
    const ys = bot.dug.map((s) => Number(s.split(', ')[1]));
    assert.deepEqual(ys, [...ys].sort((a, b) => b - a));
    // What's left is out of reach or under her, and is still the dirt she put down.
    const eye = bot.entity.position.offset(0, 1.6, 0);
    for (const e of bot.walkScaffold.blocks.values()) {
      const p = new Vec3(e.x, e.y, e.z);
      assert.ok(eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5 || underBot(bot, p), p.toString());
      assert.equal(e.name, 'dirt');
      assert.equal(e.around.length, 6);
    }
  } finally {
    bot.walkScaffold.done();
  }
});

// A platform three blocks high from x 3 to 6, to be climbed onto and walked across.
function platformWorld() {
  const w = world();
  slab(w, -4, 8, -4, 4);
  for (let x = 3; x <= 6; x++) for (let z = -4; z <= 4; z++) for (let y = 64; y <= 66; y++) w.set(x, y, z, 'stone');
  return w;
}

test('a walk stopped for something else leaves its scaffolding for later', async () => {
  const w = platformWorld();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  bot.walkScaffold = tempLog();
  try {
    const stop = new AbortController();
    // Stopped once she is up, with her pillar right behind her.
    bot.on('physicsTick', () => {
      const p = bot.entity.position;
      if (p.x >= 3 && p.y >= 66.9 && !stop.signal.aborted) stop.abort();
    });
    const result = await run(bot, walkTo({ bot, config: limits, signal: stop.signal }, new GoalNear(6, 67, 0, 0)));
    assert.equal(result.reason, 'stopped');
    assert.ok(bot.placed.length > 0);
    assert.deepEqual(bot.dug, []);
    assert.deepEqual(logged(bot.walkScaffold).sort(), [...bot.placed].sort());
  } finally {
    bot.walkScaffold.done();
  }
});

test("blocks the place tool puts down or a build's watcher claims are no walk scaffolding", async () => {
  const w = wallWorld();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  bot.walkScaffold = tempLog();
  try {
    const placed = await placeOne({ bot, config: limits }, 'dirt', new Vec3(-2, 64, 0));
    assert.equal(placed.ok, true, placed.message);
    assert.equal(w.get(new Vec3(-2, 64, 0)).name, 'dirt');
    assert.equal(bot.walkScaffold.blocks.size, 0);

    bot.buildZone = { min: new Vec3(-4, 60, -4), max: new Vec3(4, 72, 4) };
    const watch = watchScaffold(bot, () => true);
    const result = await run(bot, walkTo({ bot, config: limits }, new GoalNear(3, 67, 0, 0)));
    watch.stop();
    bot.buildZone = null;
    assert.equal(result.ok, true, result.message);
    assert.ok(watch.placed.length >= 3);
    assert.equal(bot.walkScaffold.blocks.size, 0);
    assert.deepEqual(bot.dug, []);
    assert.equal(bot.scaffoldClaims.size, 0);
  } finally {
    bot.walkScaffold.done();
  }
});

test('with a player close by, her pillar is not taken for theirs, and a block they put down is', async () => {
  const w = wallWorld();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  bot.players.Steve = { username: 'Steve', entity: { position: new Vec3(-2.5, 64, 2.5) } };
  const theirs = new Vec3(-3, 64, 3);
  bot.on('physicsTick', () => {
    if (!bot.pathfinder.isBuilding() || w.get(theirs).name !== 'air') return;
    const old = w.get(theirs);
    w.set(theirs.x, theirs.y, theirs.z, 'dirt');
    bot.emit('blockUpdate', old, w.get(theirs));
  });
  const result = await run(bot, walkTo({ bot, config: limits }, new GoalNear(3, 67, 0, 0)));
  assert.equal(result.ok, true, result.message);
  assert.ok(bot.placed.length >= 3);
  for (const s of bot.placed) {
    const p = new Vec3(...s.slice(1, -1).split(', ').map(Number));
    assert.equal(w.get(p).name, 'dirt');
    assert.equal(playerPlaced(bot, p), false, s);
  }
  assert.equal(playerPlaced(bot, theirs), true);
});

test("a build's watcher claims the scaffolding its walks put down, and the builder takes it down", async () => {
  const w = wallWorld();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  bot.walkScaffold = tempLog();
  try {
    const site = { min: new Vec3(2, 64, -1), max: new Vec3(4, 66, 1), ground: 64 };
    bot.buildZone = buildZone(site, site.ground);
    const scaffold = watchBuildScaffold(bot, site, new Set());
    const result = await run(bot, walkTo({ bot, config: limits }, new GoalNear(3, 67, 0, 0)));
    scaffold.stop();
    bot.buildZone = null;
    assert.equal(result.ok, true, result.message);
    const claimed = scaffold.leftover([]).map((p) => p.toString());
    assert.equal(claimed.length, 3);
    assert.deepEqual(claimed.sort(), [...bot.placed].sort());
    assert.equal(bot.walkScaffold.blocks.size, 0);
    assert.deepEqual(bot.dug, []);

    const removed = await run(bot, removeScaffold({ bot, config: limits }, scaffold.leftover([])), 1500);
    assert.equal(removed, 3);
    for (const s of bot.placed) assert.equal(w.get(new Vec3(...s.slice(1, -1).split(', ').map(Number))).name, 'air', s);
  } finally {
    bot.walkScaffold.done();
  }
});

test('the walk scaffolding list survives a restart, and lets go of blocks that changed or are old', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
  const log = tempLog();
  let back = null;
  try {
    log.add('dirt', new Vec3(1, 64, 0), 'overworld', ['air', 'air', 'air', 'stone', 'air', 'air']);
    log.add('cobblestone', new Vec3(1, 65, 0), 'overworld');
    log.add('dirt', new Vec3(2, 64, 0), 'overworld');
    log.add('netherrack', new Vec3(1, 64, 0), 'the_nether');
    log.save();
    back = new ScaffoldLog(log.path);
    assert.equal(back.blocks.size, 4);
    assert.deepEqual(back.get(new Vec3(1, 64, 0), 'overworld').around, ['air', 'air', 'air', 'stone', 'air', 'air']);
    assert.equal(back.has(new Vec3(1, 64, 0), 'netherrack', 'overworld'), false);
    assert.equal(back.has(new Vec3(1, 64, 0), 'netherrack', 'the_nether'), true);

    // The cobblestone was broken; grass has grown over one dirt block; another chunk isn't loaded.
    const now = { '1,64,0': 'grass_block', '1,65,0': 'air', '2,64,0': null };
    const standing = back.standing('overworld', (e) => now[`${e.x},${e.y},${e.z}`]);
    assert.deepEqual(standing.map((e) => `${e.x},${e.y},${e.z}`), ['1,64,0', '2,64,0']);
    assert.equal(back.blocks.size, 3);
    back.check(new Vec3(2, 64, 0), 'overworld', 'oak_planks');
    assert.equal(back.get(new Vec3(2, 64, 0), 'overworld'), null);

    t.mock.timers.tick(8 * 24 * 3600000);
    assert.deepEqual(back.standing('overworld', () => 'dirt'), []);

    // At most 500, the oldest go first.
    for (let i = 0; i < 501; i++) back.add('dirt', new Vec3(i, 70, 0), 'overworld');
    assert.equal(back.blocks.size, 500);
    assert.equal(back.get(new Vec3(0, 70, 0), 'overworld'), null);
  } finally {
    back?.save();
    log.done();
  }
});

// Her dirt at each cell in w, noted as walk scaffolding with what was round it then.
function leaveScaffold(w, log, cells) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const c of cells) {
    const around = faces.map(([dx, dy, dz]) => w.get(c.offset(dx, dy, dz)).name);
    w.set(c.x, c.y, c.z, 'dirt');
    log.add('dirt', c, undefined, around);
  }
}

const idleFor = (bot, log) => new Idle({ getBot: () => bot, brain: {}, survival: {}, config: {}, makeCtx: () => ({ bot }), log: () => {}, scaffold: log });

test('in free time she walks over on foot and takes her pillar down from the top', async () => {
  const w = world();
  slab(w, -6, 9, -4, 4);
  const bot = physicsBot(w, new Vec3(-3.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  const log = tempLog();
  bot.walkScaffold = log;
  try {
    leaveScaffold(w, log, [64, 65, 66, 67].map((y) => new Vec3(6, y, 0)));
    const idle = idleFor(bot, log);
    const tops = idle.scaffoldTops(bot);
    assert.deepEqual(tops.map((e) => e.y), [67]);
    let built = false;
    bot.on('physicsTick', () => {
      const m = bot.pathfinder.movements;
      if (bot.pathfinder.isMoving() && (m.canDig || m.allow1by1towers)) built = true;
    });
    await run(bot, idle.tidy({ bot, config: limits }, tops).then(() => true), 1500);
    assert.equal(built, false);
    assert.deepEqual(bot.placed, []);
    assert.deepEqual(bot.dug, ['(6, 67, 0)', '(6, 66, 0)', '(6, 65, 0)', '(6, 64, 0)']);
    assert.equal(log.blocks.size, 0);
    assert.ok(bot.entity.position.x > 0);
  } finally {
    log.done();
  }
});

test("a pillar with a player's torch on top stays up, and is let go", async () => {
  const w = world();
  w.floor();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { building: true });
  const log = tempLog();
  bot.walkScaffold = log;
  try {
    leaveScaffold(w, log, [new Vec3(2, 64, 0), new Vec3(2, 65, 0)]);
    w.set(2, 66, 0, 'torch');
    const idle = idleFor(bot, log);
    await run(bot, idle.tidy({ bot, config: limits }, idle.scaffoldTops(bot)).then(() => true));
    assert.deepEqual(bot.dug, []);
    assert.equal(log.blocks.size, 0);
    assert.equal(w.get(new Vec3(2, 65, 0)).name, 'dirt');
  } finally {
    log.done();
  }
});

test('her own place-tool block next to her pillar, put down with a player close by, does not keep it up', async () => {
  const w = world();
  w.floor();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['oak_planks', 4]], building: true });
  bot.players.Steve = { username: 'Steve', entity: { position: new Vec3(-1.5, 64, 2.5) } };
  const log = tempLog();
  bot.walkScaffold = log;
  const own = new Map();
  bot.placedLog = { has: (p, name) => own.get(p.toString()) === name, add: (name, p) => own.set(p.toString(), name), remove: (p) => own.delete(p.toString()) };
  try {
    leaveScaffold(w, log, [new Vec3(2, 64, 0)]);
    const placed = await placeOne({ bot, config: limits, placed: bot.placedLog }, 'oak_planks', new Vec3(2, 64, 1));
    assert.equal(placed.ok, true, placed.message);
    assert.equal(playerPlaced(bot, new Vec3(2, 64, 1)), true);
    const idle = idleFor(bot, log);
    await run(bot, idle.tidy({ bot, config: limits }, idle.scaffoldTops(bot)).then(() => true));
    assert.deepEqual(bot.dug, ['(2, 64, 0)']);
    assert.equal(w.get(new Vec3(2, 64, 1)).name, 'oak_planks');
    assert.equal(log.blocks.size, 0);
  } finally {
    log.done();
  }
});

test('a pillar too high to reach on foot gets a try a day, and is let go after three', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
  const w = world();
  w.floor();
  const bot = physicsBot(w, new Vec3(0.5, 64, 0.5), { items: [['dirt', 20]], building: true });
  const log = tempLog();
  bot.walkScaffold = log;
  try {
    leaveScaffold(w, log, [64, 65, 66, 67, 68, 69, 70, 71].map((y) => new Vec3(3, y, 0)));
    const idle = idleFor(bot, log);
    for (let i = 1; i <= 3; i++) {
      const tops = idle.scaffoldTops(bot);
      assert.deepEqual(tops.map((e) => e.y), [71], `try ${i}`);
      await run(bot, idle.tidy({ bot, config: limits }, tops).then(() => true));
      assert.deepEqual(bot.placed, []);
      assert.deepEqual(bot.dug, []);
      assert.deepEqual(idle.scaffoldTops(bot), []);
      t.mock.timers.tick(24 * 3600000 + 1);
    }
    assert.equal(log.blocks.size, 0);
    assert.equal(w.get(new Vec3(3, 71, 0)).name, 'dirt');
  } finally {
    log.done();
  }
});

// A house's foundation course, one block high along z 0, with the door standing in it at x 0
// facing east, so its panel is across the way along the wall.
function foundationWithDoor() {
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) if (x !== 0) w.set(x, 64, 0, 'stone');
  w.set(0, 64, 0, 'spruce_door', { facing: 'east', half: 'lower', hinge: 'left', open: 'false' });
  w.set(0, 65, 0, 'spruce_door', { facing: 'east', half: 'upper', hinge: 'left', open: 'false' });
  return w;
}

test('a walk along the top of a wall never jumps through a door standing in it', async () => {
  const w = foundationWithDoor();
  const result = plan(w, new Vec3(-2, 65, 0), new GoalBlock(2, 65, 0));
  assert.equal(result.status, 'success');
  const over = result.path.filter((n) => n.parkour);
  assert.deepEqual(over.map((n) => `${n.x},${n.y},${n.z}`), []);
  // With the real physics she gets there by stepping down off the wall, not stuck at the door.
  const bot = physicsBot(foundationWithDoor(), new Vec3(-1.5, 65, 0.5));
  const walked = await run(bot, walkTo({ bot, config: limits }, new GoalBlock(2, 65, 0), { place: false }), 600);
  assert.equal(walked.ok, true, walked.message);
});

test('a walk never digs the block a door stands on, not even a dig walk', () => {
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) w.set(x, 63, z, 'dirt');
  w.set(0, 64, 0, 'oak_door', { facing: 'south', half: 'lower', hinge: 'left', open: 'false' });
  w.set(0, 65, 0, 'oak_door', { facing: 'south', half: 'upper', hinge: 'left', open: 'false' });
  const bot = liveBot(w);
  const under = w.get(new Vec3(0, 63, 0));
  const away = w.get(new Vec3(3, 63, 3));
  for (const mode of ['walk', 'noPlace', 'digNoPlace', 'digClimb']) {
    assert.equal(bot.planModes[mode].safeToBreak(under), false, mode);
    assert.equal(bot.planModes[mode].safeToBreak(away), true, mode);
  }
});
