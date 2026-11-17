import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';
import { planObtain, recipeShape, smeltSources, harvestToolNames, planText, stepText, obtain, readWorld } from '../src/actions/obtain.js';
import { ChestIndex } from '../src/chests.js';
import { ok, fail, setPauseScale } from '../src/actions/util.js';

setPauseScale(0);

// Real 26.1 items and recipes, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const { Recipe } = require('prismarine-recipe')(registry);

const recipes = (name) => Recipe.find(registry.itemsByName[name].id).map((r) => recipeShape(registry, r));
const toolsFor = (block) => harvestToolNames(registry, registry.blocksByName[block]);
const TERRAIN = {
  oak_log: { action: 'chop', block: 'oak_log', found: 40, distance: 6 },
  cobblestone: { action: 'mine', block: 'stone', found: 100, distance: 3, tools: toolsFor('stone') },
  raw_iron: { action: 'mine', block: 'iron_ore', found: 10, distance: 9, tools: toolsFor('iron_ore') }
};

function world(extra = {}) {
  return {
    have: new Map(),
    stored: new Map(),
    recipes,
    smeltsFrom: smeltSources(registry),
    gather: (name) => TERRAIN[name] ?? null,
    logs: ['oak_log'],
    ...extra
  };
}

const actions = (plan) => plan.steps.map(stepText);

test('obtain plans nothing when the item is already carried', () => {
  const plan = planObtain(world({ have: new Map([['iron_ingot', 5]]) }), 'iron_ingot', 3);
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.steps, []);
});

test('obtain takes a stored item before making it', () => {
  const plan = planObtain(world({ stored: new Map([['stick', 10]]) }), 'stick', 3);
  assert.deepEqual(actions(plan), ['take 3 stick from chests']);
});

test('obtain crafts two levels deep from stored and carried parts', () => {
  const have = new Map([['oak_log', 2]]);
  const plan = planObtain(world({ have, stored: new Map([['cobblestone', 3]]), table: true }), 'stone_pickaxe', 1);
  assert.equal(plan.complete, true);
  assert.deepEqual(actions(plan), ['take 3 cobblestone from chests', 'craft 4 oak_planks', 'craft 4 stick', 'craft 1 stone_pickaxe']);
});

test('obtain makes a stone pickaxe from an empty inventory, wooden pickaxe first', () => {
  const plan = planObtain(world(), 'stone_pickaxe', 1);
  assert.equal(plan.complete, true);
  assert.deepEqual(actions(plan), [
    'chop 1 tree for oak_log',
    'craft 12 oak_planks',
    'craft 4 stick',
    'craft 1 crafting_table',
    'craft 1 wooden_pickaxe (putting down a crafting table)',
    'mine 3 stone for cobblestone',
    'craft 1 stone_pickaxe'
  ]);
});

test('obtain smelts iron from a chest with stored coal', () => {
  const stored = new Map([['raw_iron', 20], ['coal', 5]]);
  const plan = planObtain(world({ stored, furnaces: ['furnace'] }), 'iron_ingot', 10);
  assert.deepEqual(actions(plan), ['take 10 raw_iron, 2 coal from chests', 'smelt 10 raw_iron into iron_ingot']);
  assert.match(planText(plan), /^plan for 10 iron_ingot: 1\. take 10 raw_iron, 2 coal from chests; 2\. smelt/);
});

test('obtain gets fuel the way the furnace will burn it, without eating planks it needs', () => {
  const noFuel = planObtain(world({ stored: new Map([['raw_iron', 10]]), furnaces: ['furnace'] }), 'iron_ingot', 10);
  assert.deepEqual(actions(noFuel), ['take 10 raw_iron from chests', 'chop 2 trees for oak_log', 'smelt 10 raw_iron into iron_ingot']);
  // The furnace would burn the two sticks carried for the pickaxe, so it makes two more.
  const have = new Map([['raw_iron', 1], ['stick', 2], ['iron_ingot', 2], ['oak_log', 1]]);
  const both = planObtain(world({ have, furnaces: ['furnace'], table: true }), 'iron_pickaxe', 1);
  assert.equal(both.complete, true);
  assert.deepEqual(actions(both), ['smelt 1 raw_iron into iron_ingot', 'craft 4 oak_planks', 'craft 4 stick', 'craft 1 iron_pickaxe']);
  assert.deepEqual(both.steps[0].uses, [['raw_iron', 1], ['stick', 2]]);
  // With planks carried the furnace burns a plank instead, and the sticks are left for the pickaxe.
  const planks = planObtain(world({ have: new Map([...have, ['oak_planks', 2]]), furnaces: ['furnace'], table: true }), 'iron_pickaxe', 1);
  assert.deepEqual(actions(planks), ['smelt 1 raw_iron into iron_ingot', 'craft 1 iron_pickaxe']);
  assert.deepEqual(planks.steps[0].uses, [['raw_iron', 1], ['oak_planks', 1]]);
});

test('obtain gets a better pickaxe before mining iron', () => {
  const plan = planObtain(world({ have: new Map([['wooden_pickaxe', 1]]) }), 'raw_iron', 3);
  const steps = actions(plan);
  assert.equal(plan.complete, true);
  assert.ok(steps.indexOf('mine 3 stone for cobblestone') < steps.indexOf('craft 1 stone_pickaxe (putting down a crafting table)'));
  assert.equal(steps.at(-1), 'mine 3 iron_ore for raw_iron');
});

test('obtain goes through the whole chain for an iron pickaxe, with one chop and one furnace', () => {
  const plan = planObtain(world(), 'iron_pickaxe', 1);
  assert.equal(plan.complete, true);
  const steps = actions(plan);
  assert.equal(steps.filter((s) => s.startsWith('chop')).length, 1);
  assert.equal(steps.filter((s) => s.startsWith('craft 1 furnace')).length, 1);
  assert.ok(steps.indexOf('craft 1 stone_pickaxe') < steps.indexOf('mine 3 iron_ore for raw_iron'));
  assert.equal(steps.at(-1), 'craft 1 iron_pickaxe');
});

test('obtain breaks up a stored iron block rather than looping between blocks, ingots and nuggets', () => {
  const plan = planObtain(world({ stored: new Map([['iron_block', 2]]), table: true, gather: () => null }), 'iron_ingot', 9);
  assert.deepEqual(actions(plan), ['take 1 iron_block from chests', 'craft 9 iron_ingot']);
  const nuggets = planObtain(world({ gather: () => null }), 'iron_nugget', 2);
  assert.equal(nuggets.complete, false);
  assert.deepEqual(nuggets.steps, []);
  assert.deepEqual(nuggets.missing.map((m) => [m.item, m.count]), [['iron_nugget', 2]]);
});

test('obtain stops on a recipe loop it is given', () => {
  const loop = { a: [{ count: 1, needs: [['b', 1]], table: false }], b: [{ count: 1, needs: [['a', 1]], table: false }] };
  const plan = planObtain({ have: new Map(), recipes: (n) => loop[n] ?? [] }, 'a', 1);
  assert.equal(plan.complete, false);
  assert.equal(plan.missing.length, 1);
});

test('obtain caps the depth of a long chain', () => {
  const chain = (n) => (n.startsWith('x') && Number(n.slice(1)) < 40 ? [{ count: 1, needs: [[`x${Number(n.slice(1)) + 1}`, 1]], table: false }] : []);
  const plan = planObtain({ have: new Map([['x40', 1]]), recipes: chain }, 'x0', 1);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.steps, []);
});

test('obtain says what is missing and why when nothing gives it', () => {
  const plan = planObtain(world(), 'string', 2);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.steps, []);
  assert.match(planText(plan), /can't get any more string\. Would still be missing 2 string \(none carried or in chests I know of, and it can't be mined, chopped, crafted or smelted\)/);
  const noOre = planObtain(world({ gather: (n) => (n === 'raw_iron' ? { action: 'mine', block: 'iron_ore', found: 0, reason: 'no iron_ore within 32 blocks away from builds' } : TERRAIN[n] ?? null) }), 'iron_ingot', 2);
  assert.match(planText(noOre), /2 raw_iron for iron_ingot \(no iron_ore within 32 blocks away from builds\)/);
  const bow = planObtain(world({ table: true }), 'bow', 1);
  assert.deepEqual(bow.missing.map((m) => [m.item, m.count, m.for]), [['string', 3, 'bow']]);
});

test('obtain plans for what it can get and lists the rest as missing', () => {
  const plan = planObtain(world({ stored: new Map([['iron_ingot', 4]]), gather: () => null }), 'iron_ingot', 10);
  assert.equal(plan.complete, false);
  assert.equal(plan.count, 4);
  assert.deepEqual(actions(plan), ['take 4 iron_ingot from chests']);
  assert.deepEqual(plan.missing.map((m) => [m.item, m.count]), [['iron_ingot', 6]]);
});

test('obtain leaves out a source that came up short before and says why', () => {
  const blocked = new Map([['gather:cobblestone', 'mine: no more stone within 32 blocks']]);
  const plan = planObtain(world({ have: new Map([['wooden_pickaxe', 1]]), blocked }), 'cobblestone', 3);
  assert.deepEqual(plan.steps, []);
  assert.match(planText(plan), /3 cobblestone \(mine: no more stone within 32 blocks\)/);
});

// A bot in a small world, with real items and recipes. give and takeOut change its inventory.
const key = (p) => `${p.x},${p.y},${p.z}`;

function fakeBot({ inventory = [], blocks = {}, containers = {} } = {}) {
  const id = (name) => registry.itemsByName[name].id;
  const inv = inventory.map(([name, count]) => ({ name, count, type: id(name) }));
  const map = new Map(Object.entries(blocks));
  for (const [k, c] of Object.entries(containers)) {
    map.set(k, c.name);
    c.items = c.items.map(([name, count]) => ({ name, count, type: id(name) }));
  }
  const live = (list) => list.filter((s) => s.count > 0).map((s) => ({ ...s }));
  const move = (from, to, type, n) => {
    let moved = 0;
    for (const s of from) {
      if (s.type !== type || moved >= n) continue;
      const t = Math.min(s.count, n - moved);
      s.count -= t;
      moved += t;
    }
    const there = to.find((s) => s.type === type);
    if (there) there.count += moved;
    else if (moved) to.push({ name: registry.items[type].name, count: moved, type });
  };
  const bot = {
    registry,
    opened: [],
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    inventory: { items: () => live(inv) },
    give: (name, n) => move([{ type: id(name), count: n }], inv, id(name), n),
    takeOut: (name, n) => move(inv, [], id(name), n),
    count: (name) => inv.reduce((sum, s) => (s.name === name ? sum + s.count : sum), 0),
    blockAt: (p) => {
      const name = map.get(key(p)) ?? 'air';
      return { name, position: p, boundingBox: registry.blocksByName[name].boundingBox, getProperties: () => ({ type: 'single', facing: 'north', lit: false }) };
    },
    findBlocks: ({ matching, maxDistance, count }) => [...map]
      .filter(([, name]) => matching.includes(registry.blocksByName[name].id))
      .map(([k]) => new Vec3(...k.split(',').map(Number)))
      .filter((p) => p.distanceTo(bot.entity.position) <= maxDistance)
      .slice(0, count),
    recipesAll: (itemId, meta, table) => Recipe.find(itemId).filter((r) => !r.requiresTable || table),
    lookAt: async () => {},
    openContainer: async (block) => {
      const c = containers[key(block.position)];
      bot.opened.push(key(block.position));
      return {
        inventoryStart: 27,
        containerItems: () => live(c.items),
        items: () => live(inv),
        withdraw: async (type, meta, n) => move(c.items, inv, type, n),
        close: () => {}
      };
    }
  };
  return bot;
}

function tempIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const index = new ChestIndex(join(dir, 'chests.json'));
  return { index, cleanup: () => { clearTimeout(index.timer); rmSync(dir, { recursive: true }); } };
}

// Crafts with the real recipes from what the fake bot carries, putting a table down like craft does.
function fakeCraft(bot, calls, state = { table: false }) {
  return async (ctx, { item, count }) => {
    calls.push(`craft ${count} ${item}`);
    const r = Recipe.find(registry.itemsByName[item].id).find((rec) => {
      const times = Math.ceil(count / rec.result.count);
      return rec.delta.every((d) => d.count >= 0 || bot.count(registry.items[d.id].name) >= -d.count * times);
    });
    if (!r) return fail(`missing ingredients for ${item}`);
    if (r.requiresTable && !state.table) {
      if (!bot.count('crafting_table')) return fail('no crafting table');
      bot.takeOut('crafting_table', 1);
      state.table = true;
    }
    const times = Math.ceil(count / r.result.count);
    for (const d of r.delta) if (d.count < 0) bot.takeOut(registry.items[d.id].name, -d.count * times);
    bot.give(item, times * r.result.count);
    return ok(`crafted ${times * r.result.count} ${item}`);
  };
}

test('obtain fetches iron, plans again when a chest had less than it remembered, and never repeats a step', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [['iron_ingot', 4]] },
    '-3,64,0': { name: 'barrel', items: [['raw_iron', 10], ['coal', 2]] }
  };
  const bot = fakeBot({ containers, blocks: { '0,64,3': 'furnace' } });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 2, y: 64, z: 0 }], items: new Map([['iron_ingot', 10]]), free: 26 });
  index.record({ dim: 'overworld', name: 'barrel', parts: [{ x: -3, y: 64, z: 0 }], items: new Map([['raw_iron', 10], ['coal', 2]]), free: 25 });
  const smelted = [];
  const smelt = async (ctx, input) => {
    smelted.push(input);
    bot.takeOut(input.item, input.count);
    bot.takeOut('coal', 1);
    bot.give('iron_ingot', input.count);
    return ok(`smelted ${input.count} iron_ingot`);
  };
  const progress = [];
  const result = await obtain({ bot, status: { progress: (t) => progress.push(t) } }, { item: 'iron_ingot', count: 10 }, { smelt });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('iron_ingot'), 10);
  assert.match(result.message, /^now carrying 10 iron_ingot\. did: took 4 iron_ingot; took 6 raw_iron, 1 coal; smelted 6 iron_ingot$/);
  assert.deepEqual(bot.opened, ['2,64,0', '-3,64,0']);
  assert.deepEqual(smelted, [{ item: 'raw_iron', count: 6, wait: true }]);
  assert.equal(progress[0], 'iron_ingot, step 1 of 1: take 10 iron_ingot from chests');
  assert.ok(progress.includes('iron_ingot, step 2 of 2: smelt 6 raw_iron into iron_ingot'));
  cleanup();
});

test('items in a trapped chest are not counted as stored', () => {
  const { index, cleanup } = tempIndex();
  const bot = fakeBot({ containers: { '2,64,0': { name: 'trapped_chest', items: [['iron_ingot', 5]] }, '-2,64,0': { name: 'chest', items: [['iron_ingot', 3]] } } });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'trapped_chest', parts: [{ x: 2, y: 64, z: 0 }], items: new Map([['iron_ingot', 5]]), free: 26 });
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: -2, y: 64, z: 0 }], items: new Map([['iron_ingot', 3]]), free: 26 });
  assert.equal(readWorld({ bot }).stored.get('iron_ingot'), 3);
  cleanup();
});

function forestBot(inventory = [], extra = {}) {
  const blocks = { ...extra };
  for (let y = 64; y < 70; y++) blocks[`6,${y},0`] = 'oak_log';
  blocks['6,70,0'] = 'oak_leaves';
  for (let x = -6; x < 0; x++) blocks[`${x},63,4`] = 'stone';
  return fakeBot({ inventory, blocks });
}

test('obtain runs the whole chain for a stone pickaxe from an empty inventory', async () => {
  const bot = forestBot();
  const calls = [];
  const runners = {
    chop: async (ctx, input) => {
      calls.push(`chop ${input.x} ${input.y} ${input.z}`);
      bot.give('oak_log', 5);
      return ok('chopped 5 logs');
    },
    craft: fakeCraft(bot, calls),
    mine: async (ctx, { block, count }) => {
      calls.push(`mine ${count} ${block}`);
      if (!bot.count('wooden_pickaxe')) return fail('I need a better tool to mine stone');
      bot.give('cobblestone', count);
      return ok(`mined ${count} ${block}`);
    }
  };
  const result = await obtain({ bot }, { item: 'stone_pickaxe' }, runners);
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('stone_pickaxe'), 1);
  assert.deepEqual(calls, [
    'chop 6 64 0', 'craft 12 oak_planks', 'craft 4 stick', 'craft 1 crafting_table', 'craft 1 wooden_pickaxe', 'mine 3 stone', 'craft 1 stone_pickaxe'
  ]);
});

test('obtain with plan_only lists the steps and does nothing', async () => {
  const bot = forestBot();
  const busy = async () => assert.fail('nothing should run');
  const result = await obtain({ bot }, { item: 'stone_pickaxe', plan_only: true }, { chop: busy, craft: busy, mine: busy, take: busy, smelt: busy });
  assert.equal(result.ok, true);
  assert.match(result.message, /^plan for 1 stone_pickaxe: 1\. chop 1 tree for oak_log at 6 64 0; 2\. craft 12 oak_planks/);
});

test('obtain chops a real tree, not the nearer log wall, and asks chop_tree for that wood', async () => {
  // A wall of logs and planks with leaves on it, nearer than the tree.
  const bot = forestBot([], { '2,64,0': 'oak_log', '2,65,0': 'oak_log', '3,64,0': 'oak_planks', '2,66,0': 'oak_leaves' });
  const busy = async () => assert.fail('nothing should run');
  const plan = await obtain({ bot }, { item: 'stone_pickaxe', plan_only: true }, { chop: busy, craft: busy, mine: busy, take: busy, smelt: busy });
  assert.match(plan.message, /^plan for 1 stone_pickaxe: 1\. chop 1 tree for oak_log at 6 64 0;/);

  const inputs = [];
  const controller = new AbortController();
  const chop = async (ctx, input) => {
    inputs.push(input);
    controller.abort();
    return ok('chopped');
  };
  await obtain({ bot, signal: controller.signal }, { item: 'stone_pickaxe' }, { chop });
  assert.deepEqual(inputs, [{ x: 6, y: 64, z: 0, trees: 1, log: 'oak_log' }]);
});

test('obtain stops cleanly when the job is stopped', async () => {
  const bot = forestBot();
  const controller = new AbortController();
  const calls = [];
  const runners = {
    chop: async () => {
      calls.push('chop');
      bot.give('oak_log', 5);
      controller.abort();
      return ok('chopped');
    },
    craft: fakeCraft(bot, calls)
  };
  const result = await obtain({ bot, signal: controller.signal }, { item: 'stone_pickaxe' }, runners);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['chop']);
  assert.match(result.message, /^carrying 0 of 1 stone_pickaxe\. did: chopped 5 oak_log\. stopped$/);
});

test('obtain reports a mine that came up empty and does not try it again', async () => {
  const bot = forestBot([['wooden_pickaxe', 1]]);
  let mined = 0;
  const mine = async () => {
    mined++;
    return fail('mined 0 stone, picked up nothing. no more stone within 32 blocks');
  };
  const result = await obtain({ bot }, { item: 'cobblestone', count: 3 }, { mine });
  assert.equal(result.ok, false);
  assert.equal(mined, 1);
  assert.match(result.message, /carrying 0 of 3 cobblestone\. did: mined stone for 0 cobblestone \(mine: mined 0 stone/);
  assert.match(result.message, /missing 3 cobblestone \(mine: mined 0 stone, picked up nothing\. no more stone within 32 blocks\)/);
});

test('obtain only counts ore mine would take: in sight, with the vein behind it, not ore buried in rock', () => {
  const blocks = {};
  const encase = (x, y, z) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) blocks[`${x + dx},${y + dy},${z + dz}`] ??= 'stone';
  };
  blocks['10,60,10'] = 'iron_ore';
  encase(10, 60, 10);
  const buried = readWorld({ bot: fakeBot({ blocks }) }).gather('raw_iron');
  assert.equal(buried.found, 0);
  assert.match(buried.reason, /no exposed iron_ore in reach on foot, only 1 buried in rock.*iron is most common around y 16/);

  // One face of it open, and a second ore joined behind it.
  blocks['-10,60,10'] = 'iron_ore';
  blocks['-11,60,10'] = 'deepslate_iron_ore';
  encase(-10, 60, 10);
  encase(-11, 60, 10);
  delete blocks['-9,60,10'];
  const seen = readWorld({ bot: fakeBot({ blocks }) }).gather('raw_iron');
  assert.equal(seen.found, 2);
});

test('obtain answers at once when the item is already carried or unknown', async () => {
  const bot = fakeBot({ inventory: [['torch', 12]] });
  assert.deepEqual(await obtain({ bot }, { item: 'torch', count: 10 }), ok('already carrying 12 torch'));
  assert.equal((await obtain({ bot }, { item: 'banana' })).ok, false);
});

test('obtain plans no craft that would have no room to come out, and says so', () => {
  const room = (stacks) => world({
    have: new Map([['spruce_planks', 6], ['cobblestone', stacks * 64]]),
    table: true,
    slots: { total: 36, waste: 0 },
    stackSize: (n) => registry.itemsByName[n].stackSize
  });
  const full = planObtain(room(35), 'spruce_slab', 12);
  assert.equal(full.complete, false);
  assert.deepEqual(full.steps, []);
  assert.match(planText(full), /missing 12 spruce_slab \(no room left in my inventory for them\)/);
  const fits = planObtain(room(34), 'spruce_slab', 12);
  assert.deepEqual(actions(fits), ['craft 12 spruce_slab']);
  assert.deepEqual(fits.steps[0].ingredients, ['spruce_planks']);
});

test('obtain looks in a chest she never opened before planning to go without, then takes from it', async () => {
  const { index, cleanup } = tempIndex();
  const bot = fakeBot({ containers: { '2,64,0': { name: 'chest', items: [['iron_ingot', 5]] } } });
  bot.chestIndex = index;
  const result = await obtain({ bot }, { item: 'iron_ingot', count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'now carrying 3 iron_ingot. did: looked in chest at 2 64 0; took 3 iron_ingot');
  assert.deepEqual(bot.opened, ['2,64,0', '2,64,0']);
  cleanup();
});

test('obtain looks once per call in at most four unknown containers, never a trapped or known one', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '0,64,1': { name: 'trapped_chest', items: [['iron_ingot', 5]] },
    '2,64,0': { name: 'chest', items: [['dirt', 9]] },
    '2,64,2': { name: 'chest', items: [] },
    '0,64,-2': { name: 'chest', items: [['dirt', 3]] },
    '-2,64,2': { name: 'barrel', items: [] },
    '3,64,3': { name: 'chest', items: [] },
    '-3,64,-2': { name: 'chest', items: [['iron_ingot', 2]] }
  };
  const bot = fakeBot({ containers });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 2, y: 64, z: 0 }], items: new Map([['dirt', 9]]), free: 26 });
  const first = await obtain({ bot }, { item: 'iron_ingot', count: 2 });
  assert.equal(first.ok, false);
  assert.match(first.message, /^carrying 0 of 2 iron_ingot\. did: looked in chest at 2 64 2, chest at 0 64 -2, barrel at -2 64 2, chest at 3 64 3\. missing 2 raw_iron for iron_ingot/);
  assert.deepEqual(bot.opened, ['2,64,2', '0,64,-2', '-2,64,2', '3,64,3']);

  const second = await obtain({ bot }, { item: 'iron_ingot', count: 2 });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.message, 'now carrying 2 iron_ingot. did: looked in chest at -3 64 -2; took 2 iron_ingot');

  // Every container nearby is known now, so the message is the same as without any.
  const third = await obtain({ bot }, { item: 'iron_ingot', count: 4 });
  assert.equal(third.ok, false);
  assert.doesNotMatch(third.message, /looked in/);
  assert.match(third.message, /^carrying 2 of 4 iron_ingot\. did nothing\. missing 2 raw_iron for iron_ingot/);
  assert.equal(bot.opened.length, 6);
  assert.ok(!bot.opened.includes('0,64,1'));
  cleanup();
});
