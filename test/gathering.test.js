import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { mine, chopTree, isTerrain, isBuildTerrain, looksBuilt, buildGrid, nearBuilds, nextToBuild, notTerrainText, saplingFor, canPlantOn, treeLogTest, dropsOnto, isDark, holdsLight } from '../src/actions/mining.js';
import { findBlock } from '../src/actions/blocks.js';
import { collectDrops, collectItems, skippedDrop } from '../src/actions/items.js';
import { isTarget, leftAlone, sparedText } from '../src/actions/combat.js';
import { setPauseScale } from '../src/actions/util.js';
import { PlacedLog } from '../src/placed.js';

setPauseScale(0);

const NAMES = [
  'air', 'stone', 'smooth_stone', 'cobblestone', 'oak_planks', 'glass', 'dirt', 'grass_block', 'coal_ore', 'lava', 'oak_log',
  'oak_leaves', 'oak_sapling', 'sand', 'sandstone', 'smooth_sandstone', 'obsidian', 'oak_door', 'torch', 'cactus',
  'birch_log', 'birch_leaves', 'stripped_oak_log', 'gravel', 'diamond_ore', 'deepslate_diamond_ore'
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

test('mine stops after the same thrown error twice, says what it was and counts the failures', async () => {
  const bot = fakeBot({ '2,64,0': 'stone', '-2,64,0': 'stone', '0,64,2': 'stone', '1,64,-2': 'stone' });
  let tries = 0;
  bot.dig = async () => {
    tries++;
    throw new TypeError('enchantments.concat is not a function');
  };
  const ctx = fakeCtx(bot);
  const result = await mine(ctx, { count: 4 });
  assert.equal(result.ok, false);
  assert.equal(tries, 2);
  assert.match(result.message, /mined 0 stone, .*\. breaking failed twice in a row with the same error: enchantments.concat is not a function$/);
  assert.deepEqual(ctx.progress, ['mined 0 of 4 stone, 1 failed', 'mined 0 of 4 stone, 2 failed']);
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

// Walks stand next to a block to dig (the cell west of it, a block up) or on the spot asked for.
function walking(bot) {
  bot.walks = [];
  bot.pathfinder.setGoal = () => {};
  bot.pathfinder.isMining = () => false;
  bot.pathfinder.isBuilding = () => false;
  bot.pathfinder.goto = async (goal) => {
    const to = goal.pos ? goal.pos.offset(-1, 1, 0) : new Vec3(goal.x, goal.y, goal.z);
    bot.walks.push(`${to.x},${to.y},${to.z}`);
    bot.entity.position = to.offset(0.5, 0, 0.5);
  };
  return bot;
}

test('mine leaves ore buried in the rock and says how a player would find some', async () => {
  const bot = walking(fakeBot({ '3,60,0': 'diamond_ore' }));
  const result = await mine(fakeCtx(bot), { block: 'diamond_ore', count: 4 });
  assert.equal(result.ok, false);
  assert.match(result.message, /mined 0 diamond_ore.*no exposed diamond_ore in reach on foot, only 1 buried in rock where no player could see them\. To find some, a player digs a 2-high tunnel or strip mine with dig_area \(diamond is most common around y -59\)/);
  assert.equal(bot.world.get('3,60,0'), 'diamond_ore');
  assert.deepEqual(bot.walks, []);

  // None in sight is an answer, not a failure, so the rest of the batch still runs.
  const found = await findBlock(fakeCtx(bot), { block: 'diamond_ore' });
  assert.equal(found.ok, true);
  assert.match(found.message, /no exposed diamond_ore/);
});

test('find_block answers ok when there is none in range, and fails on a name that is no block', async () => {
  const bot = fakeBot({});
  const none = await findBlock(fakeCtx(bot), { block: 'oak_log' });
  assert.deepEqual([none.ok, none.message], [true, 'no oak_log within 64 blocks']);
  const unknown = await findBlock(fakeCtx(bot), { block: 'poplar_log' });
  assert.deepEqual([unknown.ok, unknown.message], [false, 'unknown block: poplar_log']);
});

test('mine takes an exposed ore with the rest of its vein, then walks back to where the vein began', async () => {
  const bot = walking(fakeBot({
    '2,63,0': 'diamond_ore', '2,62,0': 'deepslate_diamond_ore', '3,62,0': 'diamond_ore', '4,61,0': 'stone', '5,62,0': 'diamond_ore', '4,62,0': 'diamond_ore',
    '9,60,9': 'diamond_ore'
  }));
  const result = await mine(fakeCtx(bot), { block: 'diamond_ore', count: 1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^mined 5 diamond_ore, .*now at 0 64 0/);
  for (const k of ['2,63,0', '2,62,0', '3,62,0', '4,62,0', '5,62,0']) assert.equal(bot.world.get(k), 'air', k);
  assert.equal(bot.world.get('9,60,9'), 'diamond_ore');
  assert.equal(bot.walks.at(-1), '0,64,0');
});

test('bot.xray on lets mine and find_block go for ore through the rock again', async () => {
  const bot = walking(fakeBot({ '3,60,0': 'diamond_ore' }));
  const ctx = { ...fakeCtx(bot), config: { protectedBlocks: [], bot: { xray: true }, limits: { moveTimeoutSeconds: 5 } } };
  const found = await findBlock(ctx, { block: 'diamond_ore' });
  assert.match(found.message, /diamond_ore at 3 60 0/);
  const result = await mine(ctx, { block: 'diamond_ore', count: 1 });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.world.get('3,60,0'), 'air');
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

test('picking up drops walks on foot only, and collect_items says which drops it could not get to that way', async () => {
  const bot = fakeBot({});
  const movements = [];
  bot.moveModes = { follow: 'on foot' };
  bot.pathfinder.setMovements = (m) => movements.push(m);
  bot.pathfinder.setGoal = () => {};
  bot.pathfinder.goto = async () => {
    const err = new Error('no path');
    err.name = 'NoPath';
    throw err;
  };
  bot.entities = { 9: { id: 9, name: 'item', position: new Vec3(6.5, 64, 0.5) } };
  const result = await collectItems(fakeCtx(bot), {});
  assert.deepEqual(movements, ['on foot']);
  assert.deepEqual(result, { ok: false, message: "picked up nothing, 1 I couldn't get to without digging or building my way there" });
});

test('a pickup cut short by a stop says so', async () => {
  const bot = fakeBot({});
  bot.entities = { 9: { id: 9, name: 'item', position: new Vec3(6.5, 64, 0.5) } };
  const controller = new AbortController();
  controller.abort();
  const run = await collectDrops({ ...fakeCtx(bot), signal: controller.signal });
  assert.deepEqual(run, { walked: 0, unreachable: 0, stopped: true });
  const result = await collectItems({ ...fakeCtx(bot), signal: controller.signal }, {});
  assert.deepEqual(result, { ok: false, message: 'picked up nothing, 1 still on the ground (not got to before I stopped). Stopped part-way' });
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

test('it is dark only with no sky light, little block light and a roof, and light the server never sent is not dark', () => {
  const lights = new Map([['0,64,0', { light: 0, skyLight: 0 }], ['1,64,0', { light: 6, skyLight: 0 }], ['2,64,0', { light: 7, skyLight: 0 }], ['3,64,0', { light: 0, skyLight: 4 }]]);
  const names = { '0,70,0': 'stone', '1,70,0': 'stone', '2,70,0': 'stone', '3,70,0': 'stone' };
  const bot = { blockAt: (p) => ({ name: names[key(p)] ?? 'air', boundingBox: names[key(p)] ? 'block' : 'empty', ...lights.get(key(p)) }) };
  assert.equal(isDark(bot, new Vec3(0, 64, 0)), true);
  assert.equal(isDark(bot, new Vec3(1, 64, 0)), true);
  assert.equal(isDark(bot, new Vec3(2, 64, 0)), false);
  assert.equal(isDark(bot, new Vec3(3, 64, 0)), false);
  assert.equal(isDark(bot, new Vec3(5, 64, 0)), false);
  lights.set('4,64,0', { light: 0, skyLight: 0 });
  assert.equal(isDark(bot, new Vec3(4, 64, 0)), false);
});

test('a torch or lantern holds the block it stands or hangs on', () => {
  const blocks = { '2,65,0': ['torch', {}], '5,65,1': ['wall_torch', { facing: 'north' }], '8,63,0': ['lantern', { hanging: 'true' }] };
  const getBlock = (p) => {
    const [name, props] = blocks[key(p)] ?? ['stone', {}];
    return { name, getProperties: () => props };
  };
  assert.equal(holdsLight(getBlock, new Vec3(2, 64, 0)), true);
  assert.equal(holdsLight(getBlock, new Vec3(3, 65, 0)), false);
  assert.equal(holdsLight(getBlock, new Vec3(5, 65, 2)), true);
  assert.equal(holdsLight(getBlock, new Vec3(5, 65, 0)), false);
  assert.equal(holdsLight(getBlock, new Vec3(8, 64, 0)), true);
  assert.equal(holdsLight(getBlock, new Vec3(8, 62, 0)), false);
});

test('mine puts a torch on the wall where it is dark underground, and leaves the block her own torch stands on', async () => {
  const roof = {};
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) roof[`${x},66,${z}`] = 'dirt';
  const bot = walking(fakeBot({ ...roof, '2,64,0': 'stone', '0,65,-2': 'dirt' }, { items: [{ name: 'torch', count: 3 }] }));
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => ({ ...blockAt(p), light: 0, skyLight: 0 });
  const result = await mine(fakeCtx(bot), { count: 1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^mined 1 stone, .*\. Put up 1 torches where it was dark$/);
  assert.equal(bot.world.get('0,65,-1'), 'torch');

  const own = walking(fakeBot({ ...roof, '2,64,0': 'stone', '3,64,0': 'stone', '2,65,0': 'torch' }));
  const ownBlockAt = own.blockAt;
  own.blockAt = (p) => ({ ...ownBlockAt(p), light: 0, skyLight: 0 });
  const left = await mine(fakeCtx(own, new Set(['2,65,0'])), { count: 5 });
  assert.equal(left.ok, true, left.message);
  // The torch is near, so no other is wanted, and with none at all she would say so.
  assert.match(left.message, /^mined 1 stone, .*\. Stopped early: no more stone/);
  assert.doesNotMatch(left.message, /torches/);
  assert.equal(own.world.get('2,64,0'), 'stone');
  assert.equal(own.world.get('3,64,0'), 'air');
});

// Stacks of 64 for a full inventory, each with a type so a chest can take them.
const stacks = (name, n) => Array.from({ length: n }, () => ({ name, count: 64, type: NAMES.indexOf(name) }));

// A chest at pos the bot remembers, holding up to room stacks, for stash to empty the inventory into.
function withChest(bot, items, pos, { room = 1000, free = 27 } = {}) {
  const CHEST = 100;
  bot.world.set(key(pos), 'chest');
  bot.registry.blocksArray.push({ id: CHEST, name: 'chest', boundingBox: 'block' });
  const find = bot.findBlocks;
  bot.findBlocks = (q) => (q.matching.includes(CHEST) ? [pos] : find(q));
  bot.lookAt = async () => {};
  const stored = [];
  const entry = { key: 'c', dim: 'overworld', name: 'chest', parts: [{ x: pos.x, y: pos.y, z: pos.z }], items: [], free, labels: [] };
  bot.chestIndex = {
    list: () => [entry],
    find: (p) => (p.x === pos.x && p.y === pos.y && p.z === pos.z ? entry : null),
    record: (r) => Object.assign(entry, { items: [...r.items], free: r.free }),
    remove: () => {}
  };
  bot.openContainer = async () => ({
    inventoryStart: 27,
    inventoryEnd: 63,
    selectedItem: null,
    containerItems: () => stored.filter((s) => s.count > 0),
    items: () => items.filter((i) => i.count > 0),
    deposit: async (type, meta, n) => {
      let left = n;
      for (const i of items) {
        if (i.type !== type || !left || room <= 0) continue;
        const t = Math.min(i.count, left);
        i.count -= t;
        left -= t;
        const there = stored.find((s) => s.type === type);
        if (there) there.count += t;
        else stored.push({ name: i.name, count: t, type });
      }
      if (left) throw new Error('destination full');
    },
    close: () => {}
  });
  bot.inventory.items = () => items.filter((i) => i.count > 0);
  return stored;
}

test('mine stops when the inventory is full and no chest she knows has room, and says what is left and lying', async () => {
  const items = stacks('dirt', 35);
  const bot = fakeBot({ '2,64,0': 'stone', '-2,64,0': 'stone', '0,64,2': 'stone' }, { items });
  bot.inventory.items = () => items.filter((i) => i.count > 0);
  bot.entities = { 7: { id: 7, name: 'item', position: new Vec3(0.5, 64, 0.5), getDroppedItem: () => ({ name: 'stone', count: 1 }) } };
  bot.dig = async (block) => {
    bot.world.set(key(block.position), 'air');
    items.push({ name: 'stone', count: 64, type: NAMES.indexOf('stone') });
  };
  const result = await mine(fakeCtx(bot), { count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^mined 1 stone, picked up 64 stone, now at 0 64 0\. Stopped early: my inventory is full, with no room for stone and I know of no chest with room within 32 blocks\. 2 of 3 stone still to mine; 1 dropped item is lying on the ground around 0 64 0\. stash, or a chest with room within 32 blocks, would let me go on$/);
});

test('mine empties a full inventory into a chest she remembers, keeps her pickaxe and torches, and carries on', async () => {
  const items = [...stacks('dirt', 33), { name: 'stone', count: 64, type: NAMES.indexOf('stone') }, { name: 'iron_pickaxe', count: 1, type: 50 }, { name: 'torch', count: 10, type: NAMES.indexOf('torch') }];
  const bot = fakeBot({ '2,64,0': 'stone', '-2,64,0': 'stone', '0,64,2': 'stone' }, { items });
  const stored = withChest(bot, items, new Vec3(0, 65, -2));
  bot.dig = async (block) => {
    bot.world.set(key(block.position), 'air');
    items.push({ name: 'stone', count: 1, type: NAMES.indexOf('stone') });
  };
  const ctx = fakeCtx(bot);
  const result = await mine(ctx, { count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'mined 3 stone, picked up 3 stone, now at 0 64 0. Emptied my inventory once, into the chest at 0 65 -2');
  // A stack of dirt stays with her for scaffolding.
  assert.equal(stored.reduce((sum, s) => sum + s.count, 0), 32 * 64 + 64);
  assert.equal(items.filter((i) => i.name === 'dirt').reduce((n, i) => n + i.count, 0), 64);
  assert.ok(items.some((i) => i.name === 'iron_pickaxe' && i.count === 1));
  assert.ok(items.some((i) => i.name === 'torch' && i.count === 10));
  assert.ok(ctx.progress.includes('inventory full, putting things away (trip 1 of 3), starting with the chest at 0 65 -2'));
  assert.ok(ctx.progress.includes('emptied my inventory (1 of 3), walking back to 0 64 0'));
});

test('mine empties the inventory at most three times in one call, then stops and says so', async () => {
  const items = stacks('dirt', 36);
  const blocks = { '2,64,0': 'stone', '-2,64,0': 'stone', '0,64,2': 'stone', '1,64,-2': 'stone', '2,64,2': 'stone' };
  const bot = fakeBot(blocks, { items });
  withChest(bot, items, new Vec3(0, 65, -2));
  bot.dig = async (block) => {
    bot.world.set(key(block.position), 'air');
    items.push(...stacks('stone', 36 - items.filter((i) => i.count > 0).length));
  };
  const result = await mine(fakeCtx(bot), { count: 5 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^mined 3 stone, .*\. Emptied my inventory 3 times, into the chest at 0 65 -2\. Stopped early: my inventory is full, with no room for stone again after emptying it 3 times\. 2 of 5 stone still to mine; /);
});

test('mine stops when putting things away frees nothing', async () => {
  const items = stacks('dirt', 36);
  const bot = fakeBot({ '2,64,0': 'stone' }, { items });
  withChest(bot, items, new Vec3(0, 65, -2), { room: 0 });
  const result = await mine(fakeCtx(bot), { count: 1 });
  assert.equal(result.ok, false);
  assert.match(result.message, /my inventory is full, with no room for stone, and putting things away freed nothing \(put nothing away/);
  assert.equal(bot.world.get('2,64,0'), 'stone');
});
