import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { craft, CRAFT_TIMING } from '../src/actions/crafting.js';
import { obtain } from '../src/actions/obtain.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);
Object.assign(CRAFT_TIMING, { batchMs: 300, quietMs: 30, settleMs: 200, tickMs: 10 });

// Real 26.1 items and recipes, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const { Recipe } = require('prismarine-recipe')(registry);

const TABLE = new Vec3(1, 64, 0);

// A bot with a real inventory layout and recipes, a crafting table next to it, and a craft that
// moves items the way a finished craft would. hang makes a table craft open the table window and
// wait until wake() is called; like mineflayer, what it makes there only reaches bot.inventory
// when the window closes.
function tableBot(inventory, { hang = false, partial = 0 } = {}) {
  const id = (name) => registry.itemsByName[name].id;
  const slots = new Array(46).fill(null);
  inventory.forEach(([name, count], i) => {
    slots[9 + i] = { name, count, type: id(name), stackSize: registry.itemsByName[name].stackSize };
  });
  const main = () => slots.slice(9, 45).filter(Boolean);
  const countId = (type) => main().reduce((sum, s) => (s.type === type ? sum + s.count : sum), 0);
  // Adds or removes n of type in the 36 slots of list from start on.
  const move = (list, start, type, n) => {
    if (n < 0) {
      let left = -n;
      for (let i = start; i < start + 36 && left > 0; i++) {
        const s = list[i];
        if (s?.type !== type) continue;
        const t = Math.min(s.count, left);
        s.count -= t;
        left -= t;
        if (!s.count) list[i] = null;
      }
      return;
    }
    const item = registry.items[type];
    const there = list.slice(start, start + 36).find((s) => s?.type === type && s.count < item.stackSize);
    if (there) there.count += n;
    else list[list.indexOf(null, start)] = { name: item.name, count: n, type, stackSize: item.stackSize };
  };
  const apply = (r, times, list = slots, start = 9) => {
    for (const d of r.delta) move(list, start, d.id, d.count * times);
  };
  const tableWindow = { id: 3, type: 'minecraft:crafting', inventoryStart: 10, inventoryEnd: 46, selectedItem: null, slots: [] };
  const state = { crafts: [], syncs: 0, wake: null };
  const bot = {
    registry,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    game: { dimension: 'overworld' },
    entities: {},
    inventory: { inventoryStart: 9, inventoryEnd: 45, selectedItem: null, slots, items: main },
    currentWindow: null,
    count: (name) => countId(id(name)),
    recipesAll: (itemId, meta, table) => Recipe.find(itemId).filter((r) => !r.requiresTable || table),
    recipesFor: (itemId, meta, min, table) => Recipe.find(itemId).filter((r) => (!r.requiresTable || table)
      && r.delta.every((d) => d.count >= 0 || countId(d.id) >= -d.count * Math.ceil((min ?? 1) / r.result.count))),
    craft: async (r, times, table) => {
      state.crafts.push([registry.items[r.result.id].name, times, Boolean(table)]);
      if (!hang || !table) return apply(r, times);
      tableWindow.slots = [...new Array(10).fill(null), ...slots.slice(9, 45).map((s) => s && { ...s })];
      bot.currentWindow = tableWindow;
      if (partial) apply(r, partial, tableWindow.slots, 10);
      await new Promise((resolve) => {
        state.wake = () => {
          apply(r, times - partial, tableWindow.slots, 10);
          tableWindow.slots.slice(10, 46).forEach((s, i) => {
            slots[9 + i] = s;
          });
          bot.currentWindow = null;
          resolve();
        };
      });
    },
    findBlocks: ({ matching }) => (matching.includes(registry.blocksByName.crafting_table.id) ? [TABLE] : []),
    blockAt: (p) => {
      const name = p.equals(TABLE) ? 'crafting_table' : 'air';
      return { name, position: p, boundingBox: registry.blocksByName[name].boundingBox, getProperties: () => ({}) };
    },
    lookAt: async () => {},
    closeWindow: () => {},
    _syncWindow: async () => {
      state.syncs++;
    },
    emit: () => {}
  };
  return { bot, state };
}

test('craft makes sticks from the planks the plan names, not the first wood it finds', async () => {
  const { bot } = tableBot([['spruce_planks', 4], ['oak_planks', 2]]);
  const result = await craft({ bot }, { item: 'stick', count: 4, ingredients: ['oak_planks'] });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('oak_planks'), 0);
  assert.equal(bot.count('spruce_planks'), 4);
  // Without the plan's choice, spruce comes first in the recipe list.
  const other = tableBot([['spruce_planks', 4], ['oak_planks', 2]]).bot;
  await craft({ bot: other }, { item: 'stick', count: 4 });
  assert.equal(other.count('spruce_planks'), 2);
});

test('obtain makes a spruce fence with the real craft action when only the oak planks can go into sticks', async () => {
  const { bot, state } = tableBot([['spruce_planks', 4], ['oak_planks', 2]]);
  const result = await obtain({ bot }, { item: 'spruce_fence', count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('spruce_fence'), 3);
  assert.deepEqual(state.crafts, [['stick', 1, false], ['spruce_fence', 1, true]]);
});

test('a table craft that goes quiet is woken with a resync and finishes', async () => {
  const { bot, state } = tableBot([['spruce_planks', 12]], { hang: true });
  bot._syncWindow = async () => {
    state.syncs++;
    state.wake?.();
  };
  const result = await craft({ bot }, { item: 'spruce_trapdoor', count: 4 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'crafted 4 spruce_trapdoor');
  assert.ok(state.syncs >= 1);
  assert.equal(bot.count('spruce_trapdoor'), 4);
});

test('a table craft that never finishes reports what came out and keeps the next craft off the table', async () => {
  const { bot, state } = tableBot([['spruce_planks', 36]], { hang: true, partial: 1 });
  const first = await craft({ bot }, { item: 'spruce_trapdoor', count: 6 });
  assert.equal(first.ok, false);
  // The two that came out are still in the open table window, and they count.
  assert.equal(first.message, 'only crafted 2 of 6 spruce_trapdoor: the crafting table stopped responding');
  const second = await craft({ bot }, { item: 'spruce_trapdoor', count: 2 });
  assert.equal(second.ok, false);
  assert.equal(second.message, "couldn't craft spruce_trapdoor: my last craft at the crafting table never finished, so the table is still busy");
  assert.equal(state.crafts.length, 1);
});

test('obtain counts what is in a table window that is still open, so reaching the count is ok', async () => {
  const { bot } = tableBot([['spruce_planks', 6]], { hang: true, partial: 1 });
  const result = await obtain({ bot }, { item: 'spruce_trapdoor', count: 2 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'now carrying 2 spruce_trapdoor. did: crafted 2 spruce_trapdoor');
});
