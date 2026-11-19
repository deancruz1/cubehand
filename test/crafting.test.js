import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { craft, CRAFT_TIMING } from '../src/actions/crafting.js';
import { obtain } from '../src/actions/obtain.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);
Object.assign(CRAFT_TIMING, { batchMs: 300, quietMs: 30, settleMs: 200, drainMs: 300, progressMs: 100, tickMs: 10, calmMs: 40 });

// Real 26.1 items and recipes, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const { Recipe } = require('prismarine-recipe')(registry);

const TABLE = new Vec3(1, 64, 0);
const id = (name) => registry.itemsByName[name].id;
const copy = (list) => list.map((s) => s && { ...s });
const countIn = (list, type, from = 9, to = 45) => list.slice(from, to).reduce((sum, s) => (s?.type === type ? sum + s.count : sum), 0);

// Adds or removes n of type in the 36 slots of list from start on.
function move(list, start, type, n) {
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
}

const apply = (list, r, times, start = 9) => {
  for (const d of r.delta) move(list, start, d.id, d.count * times);
};

// A bot with a real inventory layout and recipes and a crafting table next to it, plus the server's
// copy of the inventory. bot.inventory only matches the server after a resync, the way it goes
// over the proxy. Like mineflayer, a table craft works in the table window, and what it does there
// reaches bot.inventory when the window closes.
// - lag: the last lag crafts of a batch happen on the server but their updates never arrive.
// - hang: the first table craft makes partial crafts and then waits. A resync of its window wakes
//   it when wakeOnSync is set. Once its window is closed it gives up after dieMs and closes the
//   window again, unless stubborn. A 2x2 craft that hangs leaves items in the grid and on the
//   cursor and gives up dieMs after it started.
function tableBot(inventory, { hang = false, partial = 0, lag = 0, lost = 0, wakeOnSync = false, stubborn = false, dieMs = 100 } = {}) {
  const slots = new Array(46).fill(null);
  inventory.forEach(([name, count], i) => {
    slots[9 + i] = { name, count, type: id(name), stackSize: registry.itemsByName[name].stackSize };
  });
  const server = { slots: copy(slots), cursor: null };
  const tableWindow = { id: 3, type: 'minecraft:crafting', inventoryStart: 10, inventoryEnd: 46, selectedItem: null, slots: [] };
  const state = { crafts: [], syncs: 0, hungSyncs: 0, hanging: false, wake: null, server };
  const main = () => slots.slice(9, 45).filter(Boolean);
  const resync = () => {
    copy(server.slots).forEach((s, i) => {
      slots[i] = s;
    });
    bot.inventory.selectedItem = server.cursor && { ...server.cursor };
  };
  // What mineflayer's closeWindow does with a table window: its inventory part becomes bot.inventory.
  const copyBack = () => {
    tableWindow.slots.slice(10, 46).forEach((s, i) => {
      slots[9 + i] = s && { ...s };
    });
  };
  const tableCraft = async (r, times) => {
    tableWindow.slots = [...new Array(10).fill(null), ...copy(server.slots.slice(9, 45))];
    bot.currentWindow = tableWindow;
    const hangs = hang && !state.crafts.some((c) => c[3]);
    state.crafts[state.crafts.length - 1][3] = hangs;
    if (!hangs) {
      apply(server.slots, r, times);
      apply(tableWindow.slots, r, times - lag, 10);
      copyBack();
      bot.currentWindow = null;
      return;
    }
    apply(server.slots, r, partial + lost);
    apply(tableWindow.slots, r, partial, 10);
    state.hanging = true;
    try {
      await new Promise((resolve, reject) => {
        state.wake = () => {
          state.wake = null;
          apply(server.slots, r, times - partial - lost);
          apply(tableWindow.slots, r, times - partial - lost, 10);
          resolve();
        };
        tableWindow.onClose = () => {
          if (!stubborn) setTimeout(() => reject(new Error('Event updateSlot:0 did not fire within timeout of 20000ms')), dieMs);
        };
      });
      copyBack();
      bot.currentWindow = null;
    } catch (err) {
      bot.closeWindow(tableWindow);
      throw new Error(err);
    } finally {
      state.hanging = false;
    }
  };
  const gridCraft = async (r, times) => {
    if (!hang || state.crafts.length > 1) {
      apply(server.slots, r, times);
      apply(slots, r, times - lag);
      return;
    }
    const input = r.delta.find((d) => d.count < 0).id;
    apply(server.slots, r, partial);
    apply(slots, r, partial);
    // The next craft's ingredients are in the grid and some more are on the cursor.
    for (const list of [server.slots, slots]) {
      move(list, 9, input, -6);
      for (let i = 1; i <= 4; i++) list[i] = { name: registry.items[input].name, count: 1, type: input, stackSize: 64 };
    }
    server.cursor = { name: registry.items[input].name, count: 2, type: input, stackSize: 64 };
    bot.inventory.selectedItem = { ...server.cursor };
    state.hanging = true;
    await new Promise((resolve, reject) => setTimeout(() => reject(new Error('Event updateSlot:0 did not fire within timeout of 20000ms')), dieMs)).finally(() => {
      state.hanging = false;
    });
  };
  const bot = {
    registry,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    game: { dimension: 'overworld' },
    entities: {},
    inventory: { inventoryStart: 9, inventoryEnd: 45, selectedItem: null, slots, items: main },
    currentWindow: null,
    count: (name) => countIn(slots, id(name)),
    recipesAll: (itemId, meta, table) => Recipe.find(itemId).filter((r) => !r.requiresTable || table),
    recipesFor: (itemId, meta, min, table) => Recipe.find(itemId).filter((r) => (!r.requiresTable || table)
      && r.delta.every((d) => d.count >= 0 || countIn(slots, d.id) >= -d.count * Math.ceil((min ?? 1) / r.result.count))),
    craft: async (r, times, table) => {
      state.crafts.push([registry.items[r.result.id].name, times, Boolean(table)]);
      return table ? tableCraft(r, times) : gridCraft(r, times);
    },
    findBlocks: ({ matching }) => (matching.includes(registry.blocksByName.crafting_table.id) ? [TABLE] : []),
    blockAt: (p) => {
      const name = p.equals(TABLE) ? 'crafting_table' : 'air';
      return { name, position: p, boundingBox: registry.blocksByName[name].boundingBox, getProperties: () => ({}) };
    },
    lookAt: async () => {},
    closeWindow: (w) => {
      if (w === bot.inventory) {
        // The server puts what is left in the grid and on the cursor back into the inventory.
        for (let i = 1; i <= 4; i++) {
          const s = server.slots[i];
          server.slots[i] = null;
          if (s) move(server.slots, 9, s.type, s.count);
        }
        if (server.cursor) move(server.slots, 9, server.cursor.type, server.cursor.count);
        server.cursor = null;
      } else {
        copyBack();
        w.onClose?.();
      }
      bot.currentWindow = null;
    },
    _syncWindow: async (w) => {
      state.syncs++;
      if (state.hanging) state.hungSyncs++;
      if (w === bot.inventory) return resync();
      if (wakeOnSync) state.wake?.();
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

test('a craft cut short by a stop says it stopped and how many it made', async () => {
  const { bot } = tableBot([['oak_planks', 8]]);
  const controller = new AbortController();
  controller.abort();
  const result = await craft({ bot, signal: controller.signal }, { item: 'stick', count: 8 });
  assert.deepEqual(result, { ok: false, message: "couldn't craft stick: stopped after making 0" });
});

test('obtain makes a spruce fence with the real craft action when only the oak planks can go into sticks', async () => {
  const { bot, state } = tableBot([['spruce_planks', 4], ['oak_planks', 2]]);
  const result = await obtain({ bot }, { item: 'spruce_fence', count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('spruce_fence'), 3);
  assert.deepEqual(state.crafts.map((c) => c.slice(0, 3)), [['stick', 1, false], ['spruce_fence', 1, true]]);
});

test('a table craft that goes quiet is woken with a resync and finishes', async () => {
  const { bot, state } = tableBot([['spruce_planks', 12]], { hang: true, wakeOnSync: true });
  const result = await craft({ bot }, { item: 'spruce_trapdoor', count: 4 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'crafted 4 spruce_trapdoor');
  assert.ok(state.syncs >= 1);
  assert.equal(bot.count('spruce_trapdoor'), 4);
});

test('a table craft whose last updates were lost counts what the server says it made', async () => {
  const { bot, state } = tableBot([['spruce_planks', 36]], { lag: 1 });
  const result = await craft({ bot }, { item: 'spruce_trapdoor', count: 12 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'crafted 12 spruce_trapdoor');
  assert.equal(state.crafts.length, 1);
  assert.equal(bot.count('spruce_trapdoor'), 12);
  assert.equal(bot.count('spruce_planks'), 0);
});

test('a table craft that never finishes is stopped, recounted from the server, and frees the table', async () => {
  // The server finished one more craft than the window showed before it went quiet.
  const { bot, state } = tableBot([['spruce_planks', 36]], { hang: true, partial: 1, lost: 1 });
  const first = await craft({ bot }, { item: 'spruce_trapdoor', count: 6 });
  assert.equal(first.ok, false);
  assert.equal(first.message, 'only crafted 4 of 6 spruce_trapdoor: the crafting table stopped responding');
  assert.equal(bot.currentWindow, null);
  assert.equal(state.hanging, false);
  assert.equal(bot.count('spruce_trapdoor'), countIn(state.server.slots, id('spruce_trapdoor')));
  assert.equal(bot.count('spruce_planks'), 24);
  const second = await craft({ bot }, { item: 'spruce_trapdoor', count: 2 });
  assert.equal(second.ok, true, second.message);
  assert.equal(state.crafts.length, 2);
  assert.equal(bot.count('spruce_trapdoor'), 6);
});

test('a table craft that will not stop keeps the next craft off the table, and the waits count as progress', async () => {
  const { bot, state } = tableBot([['spruce_planks', 36]], { hang: true, partial: 1, stubborn: true });
  const said = [];
  const first = await craft({ bot, status: { progress: (text) => said.push(text) } }, { item: 'spruce_trapdoor', count: 6 });
  // One line for the settle, then one about every progressMs of the 300 ms drain.
  assert.equal(said[0], 'waiting for a slow craft to finish');
  assert.ok(said.filter((t) => t === 'waiting for a stuck craft to end').length >= 2, said.join(' | '));
  assert.equal(first.ok, false);
  assert.equal(first.message, 'only crafted 2 of 6 spruce_trapdoor: the crafting table stopped responding');
  assert.equal(bot.currentWindow, null);
  assert.equal(state.hanging, true);
  const second = await craft({ bot }, { item: 'spruce_trapdoor', count: 2 });
  assert.equal(second.ok, false);
  assert.equal(second.message, "couldn't craft spruce_trapdoor: my last craft at the crafting table never finished, so the table is still busy");
  assert.equal(state.crafts.length, 1);
});

test('a 2x2 craft that gets stuck is left to end before the inventory is resynced, and nothing stays in the grid', async () => {
  const { bot, state } = tableBot([['cobbled_deepslate', 40]], { hang: true, partial: 1, dieMs: 600 });
  const first = await craft({ bot }, { item: 'polished_deepslate', count: 16 });
  assert.equal(first.ok, false);
  assert.equal(first.message, 'only crafted 4 of 16 polished_deepslate: crafting got stuck');
  assert.equal(state.hanging, false);
  // Only the one nudge the timed-out batch gets, never a resync while it is being stopped.
  assert.equal(state.hungSyncs, 1);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(bot.count('polished_deepslate'), 4);
  assert.equal(bot.count('cobbled_deepslate'), 36);
  const second = await craft({ bot }, { item: 'polished_deepslate', count: 12 });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.message, 'crafted 12 polished_deepslate');
  assert.equal(bot.count('polished_deepslate'), 16);
});

test('obtain counts a table craft that stopped responding from the resync, so reaching the count is ok', async () => {
  const { bot } = tableBot([['spruce_planks', 6]], { hang: true, partial: 1 });
  const result = await obtain({ bot }, { item: 'spruce_trapdoor', count: 2 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'now carrying 2 spruce_trapdoor. did: crafted 2 spruce_trapdoor');
  assert.equal(bot.currentWindow, null);
});

test('obtain never reports a negative amount for a step that lost items', async () => {
  const { bot } = tableBot([['spruce_trapdoor', 1], ['spruce_planks', 6]]);
  const lose = async () => {
    move(bot.inventory.slots, 9, id('spruce_trapdoor'), -1);
    return { ok: false, message: 'the table broke' };
  };
  const result = await obtain({ bot }, { item: 'spruce_trapdoor', count: 2 }, { craft: lose });
  assert.equal(result.ok, false);
  assert.match(result.message, /did: crafted 0 spruce_trapdoor \(craft: the table broke\)/);
  assert.doesNotMatch(result.message, /-\d/);
});

test('after a 2x2 batch that lost its ingredient, an old answer still on the way is not taken for the inventory', async () => {
  const { bot, state } = tableBot([['oak_log', 8]]);
  const events = new EventEmitter();
  const slots = bot.inventory.slots;
  bot.inventory.id = 0;
  bot.on = (name, fn) => events.on(name, fn);
  bot.removeListener = (name, fn) => events.removeListener(name, fn);
  const answer = (list) => {
    list.forEach((s, i) => {
      slots[i] = s;
    });
    events.emit('setWindowItems:0');
  };
  // The real resync ends on the next whole-inventory answer, whichever click it answers.
  bot._syncWindow = () => {
    setTimeout(() => answer(copy(state.server.slots)), 30);
    return new Promise((resolve) => events.once('setWindowItems:0', resolve));
  };
  const gridCraft = bot.craft;
  let first = true;
  bot.craft = async (r, times, table) => {
    if (!first) return gridCraft(r, times, table);
    first = false;
    await gridCraft(r, 3, table);
    // The answer to a click made while the logs were on the cursor is still on the way.
    const old = copy(state.server.slots).map((s) => (s?.type === id('oak_log') ? null : s));
    setTimeout(() => answer(old), 10);
    throw new Error('Error: missing ingredient');
  };
  const result = await craft({ bot }, { item: 'oak_planks', count: 32 });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.count('oak_planks'), 32);
  assert.equal(bot.count('oak_log'), 0);
});