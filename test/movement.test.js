import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { setupMovements, walkTo, walkPatience, followPlayer, planRoute, centreRawSteps, playerPlaced } from '../src/actions/movement.js';
import { DigSpot } from '../src/actions/mining.js';
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
