import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { enchant, repair, enchantsOf, customNameOf, ENCHANT_TIMING } from '../src/actions/enchant.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);
Object.assign(ENCHANT_TIMING, { offersMs: 200, resultMs: 200, actionMs: 300 });

// Real 26.1 items, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Item = require('prismarine-item')(registry);

const TABLE = new Vec3(1, 64, 0);
const ANVIL = new Vec3(-1, 64, 0);
const enchId = (name) => registry.enchantmentsByName[name].id;

function copy(it, count = it.count) {
  const n = new Item(it.type, count);
  n.componentMap = new Map([...it.componentMap].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return n;
}

// An item with 26.1 components: damage, enchantments (or stored ones on a book) and a name.
function make(name, count = 1, { damage, enchants, stored, customName } = {}) {
  const it = new Item(registry.itemsByName[name].id, count);
  it.componentMap = new Map();
  if (damage !== undefined) it.componentMap.set('damage', { type: 'damage', data: damage });
  const list = (l) => ({ enchantments: l.map(([n, level]) => ({ id: enchId(n), level })) });
  if (enchants) it.componentMap.set('enchantments', { type: 'enchantments', data: list(enchants) });
  if (stored) it.componentMap.set('stored_enchantments', { type: 'stored_enchantments', data: list(stored) });
  if (customName) it.componentMap.set('custom_name', { type: 'custom_name', data: { type: 'string', value: customName } });
  return it;
}

// A bot with an enchanting table and an anvil next to it. Their windows hold a copy of the
// inventory while open and give it back on close, along with whatever is left in their own
// slots, the way the server does.
// - offers: the level each enchanting offer needs, or null for a table that never shows any.
// - gives: the enchantments the table puts on.
// - anvilCost: what the anvil asks instead of working it out.
function benchBot(inventory, { level = 0, offers = [3, 12, 30], gives = [['efficiency', 4], ['unbreaking', 3]], anvilCost } = {}) {
  const slots = new Array(46).fill(null);
  inventory.forEach((it, i) => {
    it.slot = 9 + i;
    slots[9 + i] = it;
  });
  const client = new EventEmitter();
  const state = { names: [], opened: 0, closed: 0 };
  client.write = (packet, data) => {
    if (packet === 'name_item') {
      state.names.push(data.name);
      bot.currentWindow?.changed();
    }
  };

  function openWindow(type, start, size, changed) {
    const w = new EventEmitter();
    Object.assign(w, { id: 5, type, inventoryStart: start, inventoryEnd: start + 36, selectedItem: null, slots: new Array(size).fill(null) });
    for (let i = 9; i < 45; i++) {
      if (slots[i]) {
        w.slots[i - 9 + start] = copy(slots[i]);
        w.slots[i - 9 + start].slot = i - 9 + start;
      }
    }
    w.items = () => w.slots.slice(start, start + 36).filter(Boolean);
    w.changed = () => changed(w);
    w.updateSlot = (i, it) => {
      if (it) it.slot = i;
      const old = w.slots[i];
      w.slots[i] = it;
      w.emit(`updateSlot:${i}`, old, it);
    };
    w.close = () => {
      state.closed++;
      for (let i = 9; i < 45; i++) slots[i] = w.slots[i - 9 + start] ? copy(w.slots[i - 9 + start]) : null;
      const back = [...w.slots.slice(0, start).filter((s, i) => s && !(type === 'minecraft:anvil' && i === 2)), w.selectedItem].filter(Boolean);
      for (const it of back) slots[slots.indexOf(null, 9)] = copy(it);
      slots.forEach((s, i) => {
        if (s) s.slot = i;
      });
      bot.currentWindow = null;
    };
    state.opened++;
    bot.currentWindow = w;
    return w;
  }

  const tableChanged = (w) => {
    const target = w.slots[0];
    const show = target && offers && !enchantsOf(bot, target).length;
    w.enchantments.forEach((o, i) => {
      o.level = show ? offers[i] : -1;
      o.expected = show ? { enchant: enchId(gives[0][0]), level: gives[0][1] } : { enchant: -1, level: -1 };
    });
  };

  // What the anvil makes: diamonds repair a quarter each, a book adds its enchantments, and a
  // new name costs a level.
  const anvilChanged = (w) => {
    const [a, b] = w.slots;
    let cost = 0;
    let out = null;
    w.uses = 0;
    if (a) {
      out = copy(a, 1);
      if (b?.name === 'diamond') {
        const dmg = a.componentMap.get('damage')?.data ?? 0;
        const per = Math.floor(a.maxDurability / 4);
        w.uses = Math.min(b.count, Math.ceil(dmg / per));
        out.componentMap.set('damage', { type: 'damage', data: Math.max(0, dmg - w.uses * per) });
        cost += w.uses;
      }
      if (b?.name === 'enchanted_book') {
        const have = a.componentMap.get('enchantments')?.data.enchantments ?? [];
        out.componentMap.set('enchantments', { type: 'enchantments', data: { enchantments: [...have, ...b.componentMap.get('stored_enchantments').data.enchantments] } });
        w.uses = 1;
        cost += 2;
      }
      const name = state.names.at(-1);
      if (name !== undefined && name !== '' && name !== customNameOf(a)) {
        out.componentMap.set('custom_name', { type: 'custom_name', data: { type: 'string', value: name } });
        cost += 1;
      }
    }
    if (anvilCost !== undefined && cost) cost = anvilCost;
    if (!cost || cost >= 40) out = null;
    w.cost = cost;
    w.updateSlot(2, out);
    client.emit('craft_progress_bar', { windowId: w.id, property: 0, value: cost });
  };

  const bot = {
    registry,
    _client: client,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    game: { dimension: 'overworld', gameMode: 'survival' },
    experience: { level },
    inventory: { inventoryStart: 9, inventoryEnd: 45, selectedItem: null, slots, items: () => slots.slice(9, 45).filter(Boolean) },
    currentWindow: null,
    count: (name) => slots.slice(9, 45).reduce((sum, s) => (s?.name === name ? sum + s.count : sum), 0),
    findBlocks: ({ matching }) => [TABLE, ANVIL].filter((p) => matching.includes(registry.blocksByName[bot.blockAt(p).name].id)),
    blockAt: (p) => {
      const name = p.equals(TABLE) ? 'enchanting_table' : p.equals(ANVIL) ? 'anvil' : 'air';
      return { name, position: p, boundingBox: registry.blocksByName[name].boundingBox };
    },
    lookAt: async () => {},
    openEnchantmentTable: async () => {
      const w = openWindow('minecraft:enchantment', 2, 38, tableChanged);
      w.enchantments = [0, 1, 2].map(() => ({ level: -1, expected: { enchant: -1, level: -1 } }));
      w.enchant = async (choice) => {
        const it = copy(w.slots[0]);
        it.componentMap.set('enchantments', { type: 'enchantments', data: { enchantments: gives.map(([n, l]) => ({ id: enchId(n), level: l })) } });
        w.slots[1].count -= choice + 1;
        if (!w.slots[1].count) w.slots[1] = null;
        bot.experience.level -= choice + 1;
        w.updateSlot(0, it);
        tableChanged(w);
        return it;
      };
      return w;
    },
    openAnvil: async () => openWindow('minecraft:anvil', 3, 39, anvilChanged),
    clickWindow: async (slot, button) => {
      const w = bot.currentWindow;
      const s = w.slots[slot];
      const c = w.selectedItem;
      if (c && button === 1) {
        if (s) s.count++;
        else w.slots[slot] = copy(c, 1);
        c.count--;
        if (!c.count) w.selectedItem = null;
      } else if (c && s && s.type === c.type) {
        s.count += c.count;
        w.selectedItem = null;
      } else {
        w.slots[slot] = c;
        w.selectedItem = s;
      }
      if (w.slots[slot]) w.slots[slot].slot = slot;
      w.changed();
    },
    putAway: async (slot) => {
      const w = bot.currentWindow;
      const free = w.slots.indexOf(null, w.inventoryStart);
      w.slots[free] = w.slots[slot];
      w.slots[free].slot = free;
      w.slots[2] = null;
      w.slots[0] = null;
      if (w.slots[1]) {
        w.slots[1].count -= w.uses;
        if (!w.slots[1].count) w.slots[1] = null;
      }
      bot.experience.level -= w.cost;
    },
    closeWindow: () => {},
    _syncWindow: async () => {}
  };
  return { bot, state };
}

test('enchant lists the three offers and spends nothing without a choice', async () => {
  const { bot, state } = benchBot([make('diamond_pickaxe', 1, { damage: 0 }), make('lapis_lazuli', 5)], { level: 20 });
  const result = await enchant({ bot }, { item: 'diamond_pickaxe' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'offers for diamond_pickaxe: 1) needs level 3, costs 1 level and 1 lapis, efficiency 4 and maybe more; 2) needs level 12, costs 2 levels and 2 lapis, efficiency 4 and maybe more; 3) needs level 30, costs 3 levels and 3 lapis, efficiency 4 and maybe more. I have 20 levels and 5 lapis');
  assert.equal(bot.experience.level, 20);
  assert.equal(bot.count('lapis_lazuli'), 5);
  assert.equal(bot.count('diamond_pickaxe'), 1);
  assert.equal(bot.currentWindow, null);
  assert.equal(state.closed, 1);
});

test('enchant takes the chosen offer and reports what the item has now', async () => {
  const { bot } = benchBot([make('diamond_pickaxe', 1, { damage: 0 }), make('lapis_lazuli', 5)], { level: 35 });
  const progress = [];
  const result = await enchant({ bot, status: { progress: (t) => progress.push(t) } }, { item: 'diamond_pickaxe', choice: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'enchanted diamond_pickaxe: durability 1561/1561, enchantments: efficiency 4, unbreaking 3 (spent 3 levels, 32 left)');
  assert.equal(bot.count('lapis_lazuli'), 2);
  assert.deepEqual(enchantsOf(bot, bot.inventory.items().find((i) => i.name === 'diamond_pickaxe')), [{ name: 'efficiency', level: 4 }, { name: 'unbreaking', level: 3 }]);
  assert.ok(progress.includes('enchanting the diamond_pickaxe with offer 3'));
});

test('enchant says how many levels or lapis are missing and gives everything back', async () => {
  const low = benchBot([make('diamond_pickaxe', 1, { damage: 0 }), make('lapis_lazuli', 5)], { level: 10 }).bot;
  const levels = await enchant({ bot: low }, { item: 'diamond_pickaxe', choice: 3 });
  assert.equal(levels.ok, false);
  assert.equal(levels.message, 'offer 3 needs level 30, I have 10');
  assert.equal(low.count('lapis_lazuli'), 5);
  assert.equal(low.count('diamond_pickaxe'), 1);
  assert.equal(low.experience.level, 10);

  const poor = benchBot([make('book', 3), make('lapis_lazuli', 1)], { level: 30 }).bot;
  const lapis = await enchant({ bot: poor }, { item: 'book', choice: 2 });
  assert.equal(lapis.message, 'offer 2 needs 2 lapis, I have 1');
  assert.equal(poor.count('book'), 3);
  assert.equal(poor.count('lapis_lazuli'), 1);
  assert.equal(poor.currentWindow, null);
});

test('enchant refuses an item that is already enchanted, and stops cleanly when the table shows nothing', async () => {
  const done = benchBot([make('diamond_sword', 1, { enchants: [['sharpness', 2]] })], { level: 30 }).bot;
  assert.match((await enchant({ bot: done }, { item: 'diamond_sword' })).message, /already enchanted/);

  const { bot, state } = benchBot([make('diamond_sword', 1, { damage: 0 }), make('lapis_lazuli', 3)], { level: 30, offers: null });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const stopped = await enchant({ bot, signal: controller.signal }, { item: 'diamond_sword', choice: 1 });
  assert.equal(stopped.message, 'stopped');
  assert.equal(state.closed, 1);
  assert.equal(bot.count('diamond_sword'), 1);
  assert.equal(bot.count('lapis_lazuli'), 3);
});

test('repair fixes the most worn copy with diamonds and measures it afterwards', async () => {
  const { bot } = benchBot([make('diamond_pickaxe', 1, { damage: 200 }), make('diamond_pickaxe', 1, { damage: 1000 }), make('diamond', 5)], { level: 10 });
  const result = await repair({ bot }, { item: 'diamond_pickaxe', with: 'diamond' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'diamond_pickaxe now: durability 1561/1561 (was: durability 561/1561). The anvil costs 3 levels, spent 3, 7 left');
  assert.equal(bot.count('diamond'), 2);
  assert.equal(bot.count('diamond_pickaxe'), 2);
});

test('repair says what it costs and spends nothing when she is short of levels or it is too expensive', async () => {
  const { bot } = benchBot([make('diamond_pickaxe', 1, { damage: 1000 }), make('diamond', 5)], { level: 3, anvilCost: 7 });
  const short = await repair({ bot }, { item: 'diamond_pickaxe', with: 'diamond' });
  assert.equal(short.ok, false);
  assert.equal(short.message, 'that costs 7 levels: needs 7 levels, has 3');
  assert.equal(bot.count('diamond'), 5);
  assert.equal(bot.count('diamond_pickaxe'), 1);
  assert.equal(bot.experience.level, 3);
  assert.equal(bot.currentWindow, null);

  const dear = benchBot([make('diamond_pickaxe', 1, { damage: 1000 }), make('diamond', 5)], { level: 50, anvilCost: 41 }).bot;
  const refused = await repair({ bot: dear }, { item: 'diamond_pickaxe', with: 'diamond' });
  assert.equal(refused.message, 'too expensive: the anvil wants 41 levels, and it refuses anything from 40 up');
  assert.equal(dear.experience.level, 50);
});

test('repair applies an enchanted book, keeps an old name, and renames when asked', async () => {
  const { bot, state } = benchBot([make('diamond_pickaxe', 1, { damage: 0, customName: 'Old' }), make('enchanted_book', 1, { stored: [['mending', 1]] })], { level: 10 });
  const book = await repair({ bot }, { item: 'diamond_pickaxe', with: 'enchanted_book' });
  assert.equal(book.ok, true, book.message);
  assert.equal(book.message, 'diamond_pickaxe now: durability 1561/1561, enchantments: mending 1, named "Old" (was: durability 1561/1561, named "Old"). The anvil costs 2 levels, spent 2, 8 left');
  assert.deepEqual(state.names, ['Old']);
  assert.equal(bot.count('enchanted_book'), 0);

  const renamed = await repair({ bot }, { item: 'diamond_pickaxe', name: 'Digger' });
  assert.equal(renamed.ok, true, renamed.message);
  assert.match(renamed.message, /named "Digger" \(was: .*named "Old"\)\. The anvil costs 1 level, spent 1, 7 left$/);
});

test('repair asks what to use when given neither a second item nor a name', async () => {
  const { bot } = benchBot([make('diamond_pickaxe', 1, { damage: 10 })]);
  const result = await repair({ bot }, { item: 'diamond_pickaxe' });
  assert.equal(result.message, 'say what to put with the diamond_pickaxe (with: diamond, diamond_pickaxe or enchanted_book) or give it a name');
  assert.equal((await repair({ bot }, { item: 'diamond_pickaxe', with: 'diamond' })).message, "I'm not carrying any diamond");
});
