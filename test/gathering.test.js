import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { mine, chopTree, isTerrain, isBuildTerrain, looksBuilt, buildGrid, nearBuilds, nextToBuild, notTerrainText, saplingFor, canPlantOn, treeLogTest, dropsOnto } from '../src/actions/mining.js';
import { collectDrops, skippedDrop } from '../src/actions/items.js';
import { isTarget, leftAlone, sparedText } from '../src/actions/combat.js';
import { setPauseScale } from '../src/actions/util.js';
import { PlacedLog } from '../src/placed.js';

setPauseScale(0);

const NAMES = [
  'air', 'stone', 'smooth_stone', 'cobblestone', 'oak_planks', 'glass', 'dirt', 'grass_block', 'coal_ore', 'lava', 'oak_log',
  'oak_leaves', 'oak_sapling', 'sand', 'sandstone', 'smooth_sandstone', 'obsidian', 'oak_door', 'torch', 'cactus',
  'birch_log', 'birch_leaves', 'stripped_oak_log', 'gravel'
];
const key = (p) => `${p.x},${p.y},${p.z}`;
const boxOf = (name) => (name === 'air' || name === 'torch' ? 'empty' : 'block');

// A tiny world: blocks set in the map, dirt below y 64 and air above.
function fakeBot(blocks, { items = [] } = {}) {
  const world = new Map(Object.entries(blocks));
  const nameAt = (p) => world.get(key(p)) ?? (p.y < 64 ? 'dirt' : 'air');
  const ids = new Map(NAMES.map((n, i) => [n, i]));
  const bot = {
    world,
    scans: 0,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    registry: {
      blocksArray: NAMES.map((name, id) => ({ id, name, boundingBox: boxOf(name) })),
      itemsByName: Object.fromEntries(NAMES.map((name, id) => [name, { id, name }]))
    },
    inventory: { items: () => items },
    heldItem: null,
    pathfinder: { bestHarvestTool: () => null },
    blockAt: (p) => {
      const name = nameAt(p);
      return { name, position: p, boundingBox: boxOf(name), getProperties: () => ({}) };
    },
    findBlocks: ({ matching, maxDistance, count }) => {
      bot.scans++;
      const here = bot.entity.position;
      return [...world]
        .filter(([, name]) => matching.includes(ids.get(name)))
        .map(([k]) => new Vec3(...k.split(',').map(Number)))
        .filter((p) => p.distanceTo(here) <= maxDistance)
        .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
        .slice(0, count);
    },
    equip: async () => {},
    dig: async (block) => world.set(key(block.position), 'air'),
    placeBlock: async (ref, face) => world.set(key(ref.position.plus(face)), items[0].name),
    on: () => {},
    removeListener: () => {}
  };
  return bot;
}

function fakeCtx(bot, own = new Set()) {
  const progress = [];
  return {
    bot,
    progress,
    config: { protectedBlocks: ['chest'], limits: { moveTimeoutSeconds: 5 } },
    placed: { has: (p) => own.has(key(p)), add: () => {}, remove: () => {} },
    status: { progress: (text) => progress.push(text) }
  };
}

test('mine only takes terrain: natural blocks and ores', () => {
  assert.equal(isTerrain('stone'), true);
  assert.equal(isTerrain('deepslate_iron_ore'), true);
  assert.equal(isTerrain('ancient_debris'), true);
  assert.equal(isTerrain('smooth_stone'), false);
  assert.equal(isTerrain('oak_planks'), false);
  assert.equal(isTerrain('cobblestone'), false);
});

test('a block touching planks or glass is next to a build, one in plain rock is not', () => {
  const bot = fakeBot({ '1,64,0': 'oak_planks', '5,64,0': 'stone', '9,64,9': 'glass' });
  const getBlock = (p) => bot.blockAt(p);
  assert.equal(nextToBuild(getBlock, new Vec3(0, 64, 0)), true);
  assert.equal(nextToBuild(getBlock, new Vec3(1, 64, 0)), true);
  assert.equal(nextToBuild(getBlock, new Vec3(5, 64, 0)), false);
  assert.equal(nextToBuild(getBlock, new Vec3(8, 65, 8)), true);
});

test('cobblestone, stripped logs and torches count as built, unless the bot put the cobblestone there', () => {
  const blocks = { '0,64,0': 'cobblestone', '0,64,10': 'stripped_oak_log', '10,64,0': 'torch', '-10,64,0': 'oak_log' };
  const getBlock = (p) => {
    const name = blocks[key(p)] ?? (p.y < 64 ? 'dirt' : 'air');
    return { name, position: p, boundingBox: name === 'air' || name === 'torch' ? 'empty' : 'block' };
  };
  assert.equal(nextToBuild(getBlock, new Vec3(1, 64, 0)), true);
  assert.equal(nextToBuild(getBlock, new Vec3(0, 63, 10)), true);
  assert.equal(nextToBuild(getBlock, new Vec3(10, 63, 0)), true);
  assert.equal(nextToBuild(getBlock, new Vec3(-10, 63, 0)), false);
  assert.equal(nextToBuild(getBlock, new Vec3(5, 63, 5)), false);
  const own = (p, name) => name === 'cobblestone' && key(p) === '0,64,0';
  assert.equal(nextToBuild(getBlock, new Vec3(1, 64, 0), own), false);
});

test('mine leaves its own blocks, blocks next to a build and non-terrain matches alone, and searches once', async () => {
  const bot = fakeBot({
    '2,64,0': 'stone',
    '-2,64,0': 'stone',
    '-3,64,0': 'oak_planks',
    '0,64,2': 'stone',
    '0,65,2': 'stone',
    '1,64,-2': 'stone',
    '6,65,-6': 'smooth_stone'
  });
  const ctx = fakeCtx(bot, new Set(['2,64,0']));
  const result = await mine(ctx, { count: 5 });
  assert.equal(result.ok, true);
  assert.match(result.message, /mined 3 stone/);
  assert.match(result.message, /no more stone/);
  assert.equal(bot.world.get('2,64,0'), 'stone');
  assert.equal(bot.world.get('-2,64,0'), 'stone');
  assert.equal(bot.world.get('6,65,-6'), 'smooth_stone');
  assert.equal(bot.world.get('0,64,2'), 'air');
  // One search for the three blocks, and one more to make sure none are left.
  assert.equal(bot.scans, 2);
  assert.deepEqual(ctx.progress, ['mined 1 of 5 stone', 'mined 2 of 5 stone', 'mined 3 of 5 stone']);
});

test('mine refuses building blocks and says what to do instead', async () => {
  const bot = fakeBot({ '2,64,0': 'oak_planks' });
  const planks = await mine(fakeCtx(bot), { block: 'oak_planks' });
  assert.equal(planks.ok, false);
  assert.match(planks.message, /isn't natural terrain/);
  assert.match(planks.message, /break_block/);
  assert.equal(bot.world.get('2,64,0'), 'oak_planks');
  assert.match(notTerrainText('cobblestone'), /mine stone/);
  assert.match(notTerrainText('log'), /chop_tree/);
});

test('natural build materials are a second kind of terrain, crafted blocks are not', () => {
  for (const name of ['sandstone', 'red_sandstone', 'obsidian', 'packed_ice', 'basalt', 'terracotta', 'orange_terracotta', 'glowstone']) {
    assert.equal(isBuildTerrain(name), true, name);
  }
  for (const name of ['smooth_sandstone', 'cobblestone', 'oak_planks', 'bricks', 'blue_terracotta', 'white_glazed_terracotta']) {
    assert.equal(isBuildTerrain(name) || isTerrain(name), false, name);
  }
  assert.equal(looksBuilt('oak_door', 'block'), true);
  assert.equal(looksBuilt('wall_torch', 'empty'), true);
  assert.equal(looksBuilt('cobblestone', 'block'), true);
  assert.equal(looksBuilt('sandstone', 'block'), false);
  assert.equal(looksBuilt('cactus', 'block'), false);
  assert.equal(looksBuilt('spruce_log', 'block'), false);
  assert.equal(looksBuilt('short_grass', 'empty'), false);
  const grid = buildGrid([new Vec3(5, 64, 3)]);
  assert.equal(nearBuilds(grid, new Vec3(2, 64, 0)), true);
  assert.equal(nearBuilds(grid, new Vec3(11, 64, 0)), false);
  assert.equal(nearBuilds(grid, new Vec3(5, 70, 3)), false);
});

test('sandstone in open desert is mined, sandstone a few blocks from a door or glass is not', async () => {
  const desert = fakeBot({ '2,64,0': 'sandstone', '2,65,0': 'sandstone', '2,64,1': 'sandstone', '3,64,1': 'cactus' });
  const open = await mine(fakeCtx(desert), { block: 'sandstone', count: 3 });
  assert.equal(open.ok, true);
  assert.match(open.message, /mined 3 sandstone/);

  const town = fakeBot({
    '2,64,0': 'sandstone',
    '5,64,3': 'oak_door',
    '0,64,-3': 'sandstone',
    '-2,65,-6': 'glass',
    '12,64,0': 'sandstone',
    '-12,64,0': 'smooth_sandstone'
  });
  town.entity.position = new Vec3(10.5, 64, 0.5);
  const result = await mine(fakeCtx(town), { block: 'sandstone', count: 5 });
  assert.match(result.message, /mined 1 sandstone/);
  assert.equal(town.world.get('12,64,0'), 'air');
  assert.equal(town.world.get('2,64,0'), 'sandstone');
  assert.equal(town.world.get('0,64,-3'), 'sandstone');
  assert.equal(town.world.get('-12,64,0'), 'smooth_sandstone');
});

test('obsidian can be mined as a type, cobblestone is still refused', async () => {
  const bot = fakeBot({ '2,64,0': 'obsidian', '-9,64,0': 'cobblestone' });
  const obsidian = await mine(fakeCtx(bot), { block: 'obsidian', count: 1 });
  assert.equal(obsidian.ok, true);
  assert.equal(bot.world.get('2,64,0'), 'air');
  const cobble = await mine(fakeCtx(bot), { block: 'cobblestone' });
  assert.equal(cobble.ok, false);
  assert.match(cobble.message, /isn't natural terrain/);
  assert.match(cobble.message, /mine stone/);
  assert.equal(bot.world.get('-9,64,0'), 'cobblestone');
});

test('chop_tree leaves logs the bot placed alone, even next to leaves', async () => {
  const bot = fakeBot({ '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_leaves' });
  const ctx = fakeCtx(bot, new Set(['2,64,0', '2,65,0']));
  const given = await chopTree(ctx, { x: 2, y: 64, z: 0 });
  assert.equal(given.ok, false);
  assert.match(given.message, /one I placed/);
  const nearest = await chopTree(ctx, {});
  assert.equal(nearest.ok, false);
  assert.match(nearest.message, /no more trees/);
  assert.equal(bot.world.get('2,64,0'), 'oak_log');
});

test('after a tree is down a sapling of its wood goes back where the trunk stood', async () => {
  const bot = fakeBot(
    { '2,63,0': 'grass_block', '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_leaves' },
    { items: [{ name: 'oak_sapling', count: 3, type: 12 }] }
  );
  const result = await chopTree(fakeCtx(bot), {});
  assert.equal(result.ok, true);
  assert.match(result.message, /2 logs at 2 64 0 and planted oak_sapling in its place/);
  assert.equal(bot.world.get('2,64,0'), 'oak_sapling');
  assert.equal(bot.world.get('2,65,0'), 'air');
});

// Gives the logs at the keys in axes a sideways axis.
function withAxes(bot, axes) {
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => {
    const b = blockAt(p);
    return axes[key(p)] && b.name.endsWith('_log') ? { ...b, getProperties: () => ({ axis: axes[key(p)] }) } : b;
  };
}

test('chop_tree takes branch logs high up, but not sideways logs near the ground or touching a build', async () => {
  const blocks = { '2,72,0': 'oak_leaves', '3,69,1': 'oak_leaves', '1,64,0': 'oak_log', '1,69,-1': 'oak_log', '0,70,-1': 'oak_planks' };
  for (let y = 64; y < 72; y++) blocks[`2,${y},0`] = 'oak_log';
  blocks['3,68,0'] = 'oak_log';
  blocks['4,69,0'] = 'oak_log';
  const bot = fakeBot(blocks);
  withAxes(bot, { '3,68,0': 'x', '4,69,0': 'x', '1,64,0': 'z', '1,69,-1': 'x' });
  bot.pathfinder.setGoal = () => {};
  bot.pathfinder.isMining = () => false;
  bot.pathfinder.isBuilding = () => false;
  // Every walk ends right below the log, but reports no path, so the goal is never checked.
  bot.pathfinder.goto = async (goal) => {
    bot.entity.position = goal.pos.offset(0.5, -1, 1.5);
    const err = new Error('no path');
    err.name = 'NoPath';
    throw err;
  };
  const result = await chopTree(fakeCtx(bot), {});
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /chopped 10 logs at 2 64 0/);
  assert.equal(bot.world.get('3,68,0'), 'air');
  assert.equal(bot.world.get('4,69,0'), 'air');
  assert.equal(bot.world.get('1,64,0'), 'oak_log');
  assert.equal(bot.world.get('1,69,-1'), 'oak_log');
});

test('chop_tree leaves a sideways log at the foot of the tree and a log wall touching it alone', async () => {
  const bot = fakeBot({
    '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_log', '2,67,0': 'oak_log', '2,68,0': 'oak_leaves',
    '3,65,0': 'oak_log',
    '3,66,1': 'oak_log', '4,66,1': 'oak_planks'
  });
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => {
    const b = blockAt(p);
    return key(p) === '3,65,0' && b.name === 'oak_log' ? { ...b, getProperties: () => ({ axis: 'x' }) } : b;
  };
  const ctx = fakeCtx(bot);
  const wall = await chopTree(ctx, { x: 3, y: 66, z: 1 });
  assert.equal(wall.ok, false);
  assert.match(wall.message, /look like part of a build/);
  const result = await chopTree(ctx, {});
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /chopped 4 logs at 2 64 0/);
  assert.equal(bot.world.get('2,67,0'), 'air');
  assert.equal(bot.world.get('3,65,0'), 'oak_log');
  assert.equal(bot.world.get('3,66,1'), 'oak_log');

  const stripped = fakeBot({ '2,64,0': 'stripped_oak_log', '2,65,0': 'oak_leaves' });
  assert.equal(treeLogTest(fakeCtx(stripped))(new Vec3(2, 64, 0)), false);
});

test('chop_tree with a log name sticks to that wood for later trees', async () => {
  const bot = fakeBot({
    '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_leaves',
    '-1,64,-1': 'birch_log', '-1,65,-1': 'birch_log', '-1,66,-1': 'birch_leaves',
    '0,64,3': 'oak_log', '0,65,3': 'oak_log', '0,66,3': 'oak_leaves'
  });
  const result = await chopTree(fakeCtx(bot), { trees: 2, log: 'oak_log' });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /chopped 2 logs at 2 64 0, 2 logs at 0 64 3/);
  assert.equal(bot.world.get('-1,64,-1'), 'birch_log');
  assert.equal((await chopTree(fakeCtx(bot), { log: 'stripped_oak_log' })).ok, false);
});

test('mine skips the block it stands on, the roof of a cave and a block with gravel on it overhead', async () => {
  const bot = fakeBot({
    '1,63,0': 'stone',
    '3,64,0': 'stone', '3,63,0': 'air', '3,62,0': 'air', '3,61,0': 'air',
    '0,66,0': 'stone', '0,67,0': 'gravel',
    '-2,64,0': 'stone'
  });
  bot.entity.position = new Vec3(0.9, 64, 0.5);
  bot.pathfinder.setGoal = () => {};
  bot.pathfinder.isMining = () => false;
  bot.pathfinder.isBuilding = () => false;
  bot.pathfinder.goto = async () => {
    const err = new Error('no path');
    err.name = 'NoPath';
    throw err;
  };
  const result = await mine(fakeCtx(bot), { count: 4 });
  assert.match(result.message, /mined 1 stone/);
  assert.equal(bot.world.get('-2,64,0'), 'air');
  assert.equal(bot.world.get('1,63,0'), 'stone');
  assert.equal(bot.world.get('3,64,0'), 'stone');
  assert.equal(bot.world.get('0,66,0'), 'stone');
  assert.equal(dropsOnto(bot.entity.position, new Vec3(0, 66, 0), (p) => bot.blockAt(p).name), true);
  assert.equal(dropsOnto(bot.entity.position, new Vec3(-2, 66, 0), (p) => bot.blockAt(p).name), false);
});

test('saplings match the wood and only go on soil', () => {
  assert.equal(saplingFor('oak_log'), 'oak_sapling');
  assert.equal(saplingFor('dark_oak_log'), 'dark_oak_sapling');
  assert.equal(saplingFor('mangrove_log'), 'mangrove_propagule');
  assert.equal(saplingFor('crimson_stem'), 'crimson_fungus');
  assert.equal(canPlantOn('grass_block', 'oak_sapling'), true);
  assert.equal(canPlantOn('stone', 'oak_sapling'), false);
  assert.equal(canPlantOn('crimson_nylium', 'crimson_fungus'), true);
  assert.equal(canPlantOn('crimson_nylium', 'oak_sapling'), false);
});

test('a drop with no path to it stays skipped across pickups, one just picked up late does not', async () => {
  const bot = fakeBot({});
  let walks = 0;
  bot.pathfinder.goto = async () => {
    walks++;
    const err = new Error('no path');
    err.name = 'NoPath';
    throw err;
  };
  bot.pathfinder.setGoal = () => {};
  bot.entities = {
    7: { id: 7, name: 'item', position: new Vec3(4.5, 64, 0.5) },
    8: { id: 8, name: 'item', position: new Vec3(0.5, 64, 0.5) }
  };
  const ctx = fakeCtx(bot);
  await collectDrops(ctx);
  assert.equal(walks, 1);
  assert.equal(skippedDrop(bot, 7), true);
  assert.equal(skippedDrop(bot, 8), false);
  await collectDrops(ctx);
  assert.equal(walks, 1);
  bot.skippedDrops.set(7, Date.now() - 1);
  await collectDrops(ctx);
  assert.equal(walks, 2);
});

test('any hostile mob leaves creepers and neutral mobs alone unless they are named', () => {
  const zombie = { type: 'hostile', name: 'zombie', metadata: [] };
  const creeper = { type: 'hostile', name: 'creeper', metadata: [] };
  const enderman = { type: 'hostile', name: 'enderman', metadata: [] };
  const piglin = { type: 'hostile', name: 'zombified_piglin', metadata: [] };
  assert.equal(isTarget(zombie), true);
  assert.equal(isTarget(creeper), false);
  assert.equal(isTarget(enderman, 'monster'), false);
  assert.equal(isTarget(piglin, 'hostile'), false);
  assert.equal(isTarget(creeper, 'creeper'), true);
  assert.equal(isTarget(enderman, 'endermen'), false);
  assert.equal(isTarget(enderman, 'enderman'), true);
  assert.equal(leftAlone(creeper), true);
  assert.equal(leftAlone(creeper, 'creeper'), false);
  assert.equal(leftAlone(zombie), false);
  const text = sparedText(new Map([[1, 'creeper'], [2, 'creeper'], [3, 'enderman']]));
  assert.match(text, /Left 2 creeper, 1 enderman alone/);
  assert.equal(sparedText(new Map()), '');
});

test('any hostile mob leaves the warden, the creaking and the bosses alone unless they are named', () => {
  const mobs = [
    { type: 'hostile', name: 'warden', metadata: [] },
    { type: 'hostile', name: 'wither', metadata: [] },
    { type: 'mob', name: 'ender_dragon', metadata: [] },
    { type: 'hostile', name: 'creaking', metadata: [] }
  ];
  for (const mob of mobs) {
    assert.equal(isTarget(mob), false, mob.name);
    assert.equal(isTarget(mob, 'hostile'), false, mob.name);
    assert.equal(isTarget(mob, mob.name), true, mob.name);
    assert.equal(leftAlone(mob), true, mob.name);
  }
  assert.match(sparedText(new Map([[1, 'warden']])), /Left 1 warden alone: .*wardens/);
});

test('the placed log keeps far more than one big build and saves it whole', async () => {
  const path = join(tmpdir(), `placed-cap-test-${process.pid}.json`);
  rmSync(path, { force: true });
  const log = new PlacedLog(path);
  for (let i = 0; i < 20000; i++) log.add('oak_planks', { x: i % 100, y: 64 + Math.floor(i / 10000), z: Math.floor(i / 100) % 100 });
  assert.equal(log.has({ x: 0, y: 64, z: 0 }, 'oak_planks'), true);
  assert.equal(log.blocks.size, 20000);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 20000);
  rmSync(path, { force: true });
});
