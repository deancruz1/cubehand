import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'node:events';
import { buildStructure, copyStructure, FOREIGN_LIMIT } from '../src/actions/build.js';
import { setPauseScale } from '../src/actions/util.js';

const NAMES = ['oak_planks', 'dirt', 'cobblestone', 'stone', 'grass_block', 'chest', 'oak_sign', 'wall_torch', 'torch', 'snow', 'short_grass'];
const THIN = new Set(['oak_sign', 'wall_torch', 'torch', 'snow', 'short_grass']);
const key = (p) => `${p.x},${p.y},${p.z}`;

// A bot on flat stone at y 63, like building.test.js's builderBot, with what a site needs: a
// log of her own blocks, blocks a player put down (players), and onPlace to change the world
// while she builds.
function siteBot({ items = [{ name: 'oak_planks', count: 64 }], start = new Vec3(5.5, 64, 2.5), onPlace = () => {} } = {}) {
  const world = new Map();
  const make = (name, pos, props = {}) => ({
    name,
    position: pos,
    boundingBox: THIN.has(name) ? 'empty' : 'block',
    shapes: THIN.has(name) ? [] : [[0, 0, 0, 1, 1, 1]],
    getProperties: () => props
  });
  const set = (x, y, z, name, props) => world.set(key({ x, y, z }), make(name, new Vec3(x, y, z), props));
  for (let x = -4; x <= 24; x++) for (let z = -4; z <= 6; z++) set(x, 63, z, 'stone');
  const events = [];
  const players = new Map();
  const own = new Map();
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: start, height: 1.62 },
    entities: {},
    registry: {
      blocksByName: Object.fromEntries(NAMES.map((n) => [n, {}])),
      itemsByName: Object.fromEntries(NAMES.map((n, i) => [n, { id: i + 1 }]))
    },
    inventory: { items: () => items },
    playerBlocks: players,
    blockAt: (p) => world.get(key(p)) ?? make('air', p),
    equip: async (item) => { bot.heldItem = item; },
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      const name = bot.heldItem?.name ?? 'oak_planks';
      world.set(key(pos), make(name, pos));
      events.push({ placed: pos, name });
      onPlace(pos, events.filter((e) => e.placed).length);
    },
    dig: async (block) => {
      world.delete(key(block.position));
      events.push({ dug: block.position, name: block.name });
    },
    canDigBlock: () => true,
    stopDigging: () => {},
    pathfinder: {
      goto: async (goal) => {
        events.push({ walk: goal.pos });
        bot.entity.position = new Vec3(goal.pos.x + 0.5, 64, goal.pos.z + 2.5);
      },
      setGoal: () => {},
      isMining: () => false,
      isBuilding: () => false,
      bestHarvestTool: () => null
    }
  });
  bot.world = { getBlock: (p) => bot.blockAt(p), raycast: () => null };
  const placed = {
    has: (pos, name) => own.get(key(pos)) === name,
    add: (name, pos) => own.set(key(pos), name),
    remove: (pos) => own.delete(key(pos))
  };
  const ctx = { bot, placed, config: { protectedBlocks: ['chest', 'furnace'], limits: { maxBuildBlocks: 500, moveTimeoutSeconds: 90 } } };
  // A block a player put down: playerPlaced remembers it for a while.
  const byPlayer = (x, y, z, name) => {
    set(x, y, z, name);
    players.set(key({ x, y, z }), Date.now() + 600000);
  };
  const mine = (x, y, z, name) => {
    set(x, y, z, name);
    own.set(key({ x, y, z }), name);
  };
  const at = (x, y, z) => world.get(key({ x, y, z }))?.name ?? 'air';
  return { bot, ctx, events, world, set, byPlayer, mine, at };
}

const origin = { x: 0, y: 64, z: 0 };
const row = (to, block = 'oak_planks', dy = 0) => ({ shape: 'fill', from: { dx: 0, dy, dz: 0 }, to: { dx: to, dy, dz: 0 }, block });
const dug = (events) => events.filter((e) => e.dug);

async function build(ctx, plan) {
  setPauseScale(0);
  try {
    return await buildStructure(ctx, { origin, ...plan });
  } finally {
    setPauseScale(1);
  }
}

test('a grass block in a planned spot is dug out and built over, and so is a player\'s patch of dirt', async () => {
  const { ctx, events, set, byPlayer, at } = siteBot();
  set(0, 64, 0, 'grass_block');
  for (const x of [2, 3, 4]) byPlayer(x, 64, 0, 'dirt');
  const result = await build(ctx, { parts: [row(5)] });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 6, skipped 0, failed 0, cleared 1 natural block, took out 3 blocks that aren't mine \(3 dirt\)/);
  for (let x = 0; x <= 5; x++) assert.equal(at(x, 64, 0), 'oak_planks');
  assert.deepEqual(dug(events).map((e) => e.name).sort(), ['dirt', 'dirt', 'dirt', 'grass_block']);
});

test('her own block that doesn\'t fit is swapped, and an air spot is cleared of dirt', async () => {
  const { ctx, mine, set, at } = siteBot();
  mine(1, 64, 0, 'dirt');
  set(2, 64, 0, 'dirt');
  const result = await build(ctx, { parts: [row(3), { shape: 'fill', from: { dx: 2, dy: 0, dz: 0 }, to: { dx: 2, dy: 0, dz: 0 }, block: 'air' }] });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 3, skipped 0, failed 0, cleared 1 natural block, swapped 1 of my own$/);
  assert.equal(at(1, 64, 0), 'oak_planks');
  assert.equal(at(2, 64, 0), 'air');
});

test('a chest and a sign in planned spots stay and are reported, and so does a block a player\'s torch hangs on', async () => {
  const { ctx, set, at } = siteBot();
  set(0, 64, 0, 'chest');
  set(1, 64, 0, 'oak_sign');
  set(3, 64, 0, 'cobblestone');
  set(3, 64, -1, 'wall_torch');
  const result = await build(ctx, { parts: [row(4)] });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 2, skipped 0, failed 0\. Left standing in the way: 3 \(/);
  assert.match(result.message, /chest at 0 64 0, a protected block/);
  assert.match(result.message, /oak_sign at 1 64 0, it has something in it/);
  assert.match(result.message, /cobblestone at 3 64 0, it holds up wall_torch at 3 64 -1/);
  assert.deepEqual([0, 1, 2, 3, 4].map((x) => at(x, 64, 0)), ['chest', 'oak_sign', 'oak_planks', 'cobblestone', 'oak_planks']);
});

test('more than the limit of others\' blocks: none is broken unless replace says to build over them', async () => {
  const wall = [0, 1, 2].map((dy) => row(10, 'oak_planks', dy));
  const fill = (byPlayer) => {
    for (let x = 0; x <= 10; x++) for (let y = 64; y <= 66; y++) byPlayer(x, y, 0, 'cobblestone');
  };
  assert.equal(FOREIGN_LIMIT, 32);
  const first = siteBot();
  fill(first.set);
  const held = await build(first.ctx, { parts: wall });
  assert.equal(held.ok, false, held.message);
  assert.match(held.message, /33 blocks that aren't mine stand in the plan's spots \(cobblestone at 0 64 0; .*all within 0 64 0 to 10 66 0\), more than the 32 I take out unasked, so I broke none of them/);
  assert.match(held.message, /A player has to say to build over them \(replace\)/);
  assert.equal(dug(first.events).length, 0);

  const dry = await build(first.ctx, { parts: wall, dry_run: true });
  assert.match(dry.message, /33 blocks that aren't mine .*so I would break none of them/);

  const second = siteBot({ items: [{ name: 'oak_planks', count: 64 }] });
  fill(second.set);
  const done = await build(second.ctx, { parts: wall, replace: true });
  assert.equal(done.ok, true, done.message);
  assert.match(done.message, /^placed 33, skipped 0, failed 0, took out 33 blocks that aren't mine \(33 cobblestone\)/);
  assert.equal(dug(second.events).length, 33);
});

test('clear hollows a build set into a slope but leaves a chest and a player\'s blocks alone', async () => {
  const { ctx, set, byPlayer, at } = siteBot();
  // A slope of dirt inside a 5 by 3 by 2 room of walls.
  for (let x = 0; x <= 4; x++) for (let y = 64; y <= 65; y++) for (let z = -2; z <= 0; z++) set(x, y, z, 'dirt');
  set(2, 64, -1, 'chest');
  byPlayer(1, 65, -1, 'dirt');
  const walls = { shape: 'walls', from: { dx: 0, dy: 0, dz: -2 }, to: { dx: 4, dy: 1, dz: 0 }, block: 'oak_planks' };
  const plain = siteBot();
  for (let x = 1; x <= 3; x++) plain.set(x, 64, -1, 'dirt');
  const kept = await build(plain.ctx, { parts: [walls] });
  assert.equal(kept.ok, true, kept.message);
  assert.equal(plain.at(2, 64, -1), 'dirt', 'without clear the inside stays');

  const result = await build(ctx, { parts: [walls], clear: true });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /cleared 28 natural blocks/);
  assert.equal(at(2, 64, -1), 'chest');
  assert.equal(at(1, 65, -1), 'dirt');
  assert.equal(at(3, 64, -1), 'air');
  assert.equal(at(1, 64, -1), 'air');
  assert.equal(at(0, 65, -2), 'oak_planks');
});

test('foundation fills down to the ground, says which column is too deep, and leaves a player\'s block alone', async () => {
  const { ctx, world, byPlayer, at } = siteBot({ items: [{ name: 'oak_planks', count: 64 }, { name: 'cobblestone', count: 64 }] });
  world.delete(key({ x: 3, y: 63, z: 0 }));
  byPlayer(1, 64, 0, 'oak_planks');
  const plan = { parts: [row(3)], foundation: 'cobblestone' };
  setPauseScale(0);
  const dry = await buildStructure(ctx, { origin: { x: 0, y: 66, z: 0 }, ...plan, dry_run: true });
  assert.match(dry.message, /On the site I would put in 5 foundation blocks\./);
  assert.match(dry.message, /No foundation where 3 0 \(the ground is more than 6 blocks down\)/);
  const result = await buildStructure(ctx, { origin: { x: 0, y: 66, z: 0 }, ...plan });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 9, skipped 0, failed 0, put in 5 foundation blocks/);
  assert.match(result.message, /No foundation where 3 0/);
  assert.deepEqual([64, 65].map((y) => at(0, y, 0)), ['cobblestone', 'cobblestone']);
  assert.deepEqual([64, 65].map((y) => at(1, y, 0)), ['oak_planks', 'cobblestone']);
  assert.equal(at(3, 64, 0), 'air');
});

test('snow that lands mid-build is gone at the end, and a player\'s plank dropped in is caught and replaced', async () => {
  const first = [];
  const { ctx, set, byPlayer, at } = siteBot({
    items: [{ name: 'cobblestone', count: 64 }],
    onPlace: (pos, n) => {
      first.push(pos);
      if (n === 2) set(first[0].x, 65, 0, 'snow', { layers: 1 });
      if (n === 3) byPlayer(first[1].x, 64, 0, 'oak_planks');
    }
  });
  const result = await build(ctx, { parts: [row(4, 'cobblestone')] });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 5, skipped 0, failed 0, took out 1 block that isn't mine \(1 oak_planks\), swept off 1 snow layer/);
  assert.match(result.message, /Put back 1 block disturbed while building/);
  assert.equal(at(first[0].x, 65, 0), 'air');
  for (let x = 0; x <= 4; x++) assert.equal(at(x, 64, 0), 'cobblestone');
});

test('a spot disturbed in every round ends the check after three rounds with a report', async () => {
  const { ctx, events, set } = siteBot({ onPlace: (pos) => { if (pos.x === 2) set(2, 64, 0, 'grass_block'); } });
  const result = await build(ctx, { parts: [row(4)] });
  assert.match(result.message, /Disturbed again in every one of 3 checks, so I stopped checking: 2 64 0/);
  assert.equal(dug(events).filter((e) => e.dug.x === 2).length, 3);
});

test('dry_run touches nothing and says what it would do on the site', async () => {
  const { ctx, events, set, byPlayer, mine, world } = siteBot();
  set(0, 64, 0, 'grass_block');
  mine(1, 64, 0, 'dirt');
  byPlayer(2, 64, 0, 'dirt');
  set(3, 65, 0, 'short_grass');
  set(4, 64, 0, 'chest');
  const before = [...world.keys()].sort();
  const result = await build(ctx, { parts: [row(4), row(4, 'air', 1)], dry_run: true });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^Plan: 5 blocks, 0 already in place\. Needs 4 oak_planks\. I have everything\. On the site I would clear 1 natural block, swap 1 of my own, take out 1 block that isn't mine \(1 dirt\), sweep off 1 snow layer and plant\. Would be left standing in the way: 1 \(chest at 4 64 0, a protected block\)\.$/);
  assert.deepEqual(events, []);
  assert.deepEqual([...world.keys()].sort(), before);
});

test('copy_structure clears a natural block at the copy and builds it', async () => {
  const { ctx, set, at } = siteBot();
  set(0, 64, 0, 'oak_planks');
  set(1, 64, 0, 'oak_planks');
  set(11, 64, 0, 'grass_block');
  setPauseScale(0);
  const result = await copyStructure(ctx, { x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 0, origin: { x: 10, y: 64, z: 0 } });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^copy of 0 64 0 to 1 64 0 at 10 64 0: placed 2, skipped 0, failed 0, cleared 1 natural block$/);
  assert.equal(at(10, 64, 0), 'oak_planks');
  assert.equal(at(11, 64, 0), 'oak_planks');
});
