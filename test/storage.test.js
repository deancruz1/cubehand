import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';
import { ChestIndex, chestKey, contentsText, agoText, pickSource, labelFit, stashTargets, keepReason, itemCategories } from '../src/chests.js';
import { storageSummary } from '../src/perception.js';
import { takeItems, stash, stashSelection, openContainer, openWindow, isPickable } from '../src/actions/containers.js';
import { EventEmitter } from 'node:events';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);

function tempIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const path = join(dir, 'chests.json');
  const index = new ChestIndex(path);
  const cleanup = () => {
    clearTimeout(index.timer);
    rmSync(dir, { recursive: true });
  };
  return { path, index, cleanup };
}

const items = (obj) => new Map(Object.entries(obj));

test('both halves of a double chest are one entry, and it survives a restart', () => {
  const { path, index, cleanup } = tempIndex();
  index.record({ dim: 'overworld', name: 'chest', parts: [new Vec3(5, 64, 1), new Vec3(4, 64, 1)], items: items({ iron_ingot: 12, coal: 30 }), free: 50, labels: ['sign "ores"'] }, 1000);
  assert.equal(index.chests.size, 1);
  assert.equal(index.find({ x: 4, y: 64, z: 1 }, 'overworld').key, chestKey([{ x: 4, y: 64, z: 1 }], 'overworld'));
  assert.equal(index.find({ x: 5, y: 64, z: 1 }, 'overworld').items[0][0], 'coal');
  assert.equal(index.find({ x: 5, y: 64, z: 1 }, 'the_nether'), null);
  index.save();
  const reloaded = new ChestIndex(path);
  assert.deepEqual(reloaded.find({ x: 5, y: 64, z: 1 }, 'overworld').labels, ['sign "ores"']);
  assert.equal(reloaded.find({ x: 5, y: 64, z: 1 }, 'overworld').seen, 1000);
  cleanup();
});

test('a chest that grew into a double chest replaces the old entry', () => {
  const { index, cleanup } = tempIndex();
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 0, y: 64, z: 0 }], items: items({ dirt: 1 }), free: 26, labels: ['sign "dirt"'] });
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }], items: items({ dirt: 5 }), free: 53 });
  assert.equal(index.chests.size, 1);
  assert.deepEqual(index.list('overworld')[0].labels, ['sign "dirt"']);
  cleanup();
});

test('chests that are gone are dropped, unloaded ones are kept', () => {
  const { index, cleanup } = tempIndex();
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 0, y: 64, z: 0 }], items: items({ dirt: 1 }), free: 26 });
  index.record({ dim: 'overworld', name: 'barrel', parts: [{ x: 3, y: 64, z: 0 }], items: items({}), free: 27 });
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 9, y: 64, z: 0 }], items: items({}), free: 27 });
  const names = { '0,64,0': 'air', '3,64,0': 'barrel' };
  const dropped = index.prune('overworld', new Vec3(0, 64, 0), 48, (p) => names[`${p.x},${p.y},${p.z}`] ?? null);
  assert.equal(dropped, 1);
  assert.deepEqual(index.list('overworld').map((c) => c.name).sort(), ['barrel', 'chest']);
  assert.equal(index.remove({ x: 3, y: 64, z: 0 }, 'overworld'), true);
  assert.equal(index.list('overworld').length, 1);
  cleanup();
});

test('the index keeps at most 500 chests, dropping the longest unseen', () => {
  const { index, cleanup } = tempIndex();
  for (let i = 0; i < 505; i++) index.record({ dim: 'overworld', name: 'chest', parts: [{ x: i, y: 64, z: 0 }], items: items({}), free: 27 });
  assert.equal(index.chests.size, 500);
  assert.equal(index.find({ x: 0, y: 64, z: 0 }, 'overworld'), null);
  assert.ok(index.find({ x: 504, y: 64, z: 0 }, 'overworld'));
  cleanup();
});

test('remembered contents are short and say how old they are', () => {
  assert.equal(agoText(30000), 'just now');
  assert.equal(agoText(12 * 60000), '12 min ago');
  assert.equal(agoText(5 * 3600000), '5 h ago');
  assert.equal(agoText(3 * 86400000), '3 days ago');
  const entry = { items: [['cobblestone', 300], ['dirt', 40], ['iron_ingot', 3]], seen: 0 };
  assert.equal(contentsText(entry, 12 * 60000, 2), 'seen 12 min ago: cobblestone 300, dirt 40, +1 more kinds');
  assert.equal(contentsText({ items: [], seen: 0 }, 0), 'seen just now: empty');
});

test('the storage list shows what is inside only for chests the bot has seen', () => {
  const seen = { items: [['iron_ingot', 12]], seen: 0 };
  const containers = [
    { name: 'chest', parts: [new Vec3(1, 64, 0)], distance: 1, labels: ['sign "ores"'], seen },
    { name: 'barrel', parts: [new Vec3(4, 64, 0)], distance: 4, labels: [] }
  ];
  const text = storageSummary(containers, 48, 12, 60 * 60000);
  assert.match(text, /contents as you last saw them/);
  assert.match(text, /chest at 1 64 0 \(1 away\), sign "ores"; seen 60 min ago: iron_ingot 12/);
  assert.match(text, /barrel at 4 64 0 \(4 away\)$/m);
  assert.doesNotMatch(storageSummary([containers[1]], 48), /last saw/);
});

test('take_items goes to the nearest known chest with the item and skips tried ones', () => {
  const entries = [
    { key: 'a', parts: [{ x: 10, y: 64, z: 0 }], items: [['iron_ingot', 5]] },
    { key: 'b', parts: [{ x: 3, y: 64, z: 0 }], items: [['dirt', 5]] },
    { key: 'c', parts: [{ x: 20, y: 64, z: 0 }], items: [['iron_ingot', 50]] }
  ];
  const wanted = new Map([['iron_ingot', 20]]);
  const here = new Vec3(0, 64, 0);
  assert.equal(pickSource(entries, wanted, here).key, 'a');
  assert.equal(pickSource(entries, wanted, here, new Set(['a'])).key, 'c');
  assert.equal(pickSource(entries, wanted, here, new Set(['a']), 15), null);
  assert.equal(pickSource(entries, new Map([['gold_ingot', 1]]), here), null);
});

test('labels are matched on item names and kinds', () => {
  assert.equal(labelFit(['sign "Wood / Planks"'], 'spruce_log'), 'fits');
  assert.equal(labelFit(['sign "STONE"'], 'cobblestone'), 'fits');
  assert.equal(labelFit(['sign "ores"'], 'raw_iron'), 'fits');
  assert.equal(labelFit(['sign "coal"'], 'charcoal'), 'fits');
  assert.equal(labelFit(['sign "food"'], 'bread'), 'fits');
  assert.equal(labelFit(['sign "junk"'], 'rotten_flesh'), 'fits');
  assert.equal(labelFit(['sign "seeds"'], 'wheat_seeds'), 'fits');
  assert.equal(labelFit(['item frame showing oak_log'], 'birch_planks'), 'fits');
  assert.equal(labelFit(['sign "wood"'], 'cobblestone'), 'other');
  assert.equal(labelFit(['sign "misc"'], 'cobblestone'), 'open');
  assert.equal(labelFit([], 'cobblestone'), 'open');
  assert.deepEqual(itemCategories('oak_log'), ['wood']);
});

test('stash picks a chest that holds the item, then a fitting label, then the nearest unlabeled one', () => {
  const here = new Vec3(0, 64, 0);
  const at = (x) => [{ x, y: 64, z: 0 }];
  const containers = [
    { key: 'plain-near', parts: at(2), labels: [], items: null },
    { key: 'wood', parts: at(6), labels: ['sign "wood"'], items: [['oak_log', 10]] },
    { key: 'stone', parts: at(8), labels: ['sign "stone"'], items: [] },
    { key: 'plain-far', parts: at(12), labels: [], items: [['cobblestone', 64]] },
    { key: 'food', parts: at(1), labels: ['sign "food"'], items: [['cobblestone', 2]] }
  ];
  const keys = (item) => stashTargets(item, containers, here).map((c) => c.key);
  assert.deepEqual(keys('cobblestone'), ['plain-far', 'stone', 'plain-near']);
  assert.deepEqual(keys('oak_log'), ['wood', 'plain-near', 'plain-far']);
  assert.deepEqual(keys('diamond'), ['plain-near', 'plain-far']);
});

test('stash keeps tools, weapons, armor, food and torches unless told otherwise', () => {
  assert.equal(keepReason('iron_pickaxe'), 'tools');
  assert.equal(keepReason('diamond_sword'), 'weapons');
  assert.equal(keepReason('iron_boots'), 'armor');
  assert.equal(keepReason('cooked_beef'), 'food');
  assert.equal(keepReason('rotten_flesh'), null);
  assert.equal(keepReason('torch'), 'torches');
  assert.equal(keepReason('cobblestone'), null);
  const carried = new Map([['iron_pickaxe', 1], ['cobblestone', 70], ['oak_log', 20], ['bread', 4], ['dirt', 9]]);
  const all = stashSelection(carried, { keep: ['dirt'] });
  assert.deepEqual([...all.put], [['cobblestone', 70], ['oak_log', 20]]);
  assert.deepEqual(all.kept.map((k) => k.reason), ['tools', 'food', 'asked to keep']);
  const some = stashSelection(carried, { items: [{ item: 'log' }, { item: 'cobblestone', count: 64 }, { item: 'bread' }] });
  assert.deepEqual([...some.put], [['cobblestone', 64], ['oak_log', 20], ['bread', 4]]);
});

// A few chests and barrels around the bot, all within reach so nothing needs walking.
const NAMES = ['air', 'chest', 'barrel', 'oak_sign', 'iron_ingot', 'cobblestone', 'oak_log', 'iron_pickaxe', 'bread', 'dirt', 'diamond', 'trapped_chest'];
const id = (name) => NAMES.indexOf(name);
const key = (p) => `${p.x},${p.y},${p.z}`;

function fakeBot({ containers, signs = {}, inventory = [] }) {
  const blocks = new Map();
  for (const [k, c] of Object.entries(containers)) blocks.set(k, c.name);
  for (const k of Object.keys(signs)) blocks.set(k, 'oak_sign');
  const stack = (name, count) => ({ name, count, type: id(name) });
  const inv = inventory.map(([name, count]) => stack(name, count));
  const move = (from, to, type, n, room = Infinity) => {
    let moved = 0;
    for (const s of from) {
      if (s.type !== type || moved >= n || moved >= room) continue;
      const take = Math.min(s.count, n - moved, room - moved);
      s.count -= take;
      moved += take;
    }
    if (moved) {
      const there = to.find((s) => s.type === type);
      if (there) there.count += moved;
      else to.push(stack(NAMES[type], moved));
    }
    return moved;
  };
  const live = (list) => list.filter((s) => s.count > 0).map((s) => ({ ...s }));
  const bot = {
    opened: [],
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    game: { dimension: 'overworld' },
    registry: { blocksArray: NAMES.map((name, i) => ({ id: i, name })), foodsByName: { bread: {} } },
    inventory: { items: () => live(inv) },
    blockAt: (p) => {
      const name = blocks.get(key(p)) ?? 'air';
      const text = signs[key(p)];
      return { name, position: p, getProperties: () => ({ type: 'single', facing: 'north' }), blockEntity: text ? { front_text: { messages: [text] } } : undefined };
    },
    findBlocks: ({ matching, maxDistance, count }) => {
      const here = bot.entity.position;
      return [...blocks]
        .filter(([, name]) => matching.includes(id(name)))
        .map(([k]) => new Vec3(...k.split(',').map(Number)))
        .filter((p) => p.distanceTo(here) <= maxDistance)
        .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
        .slice(0, count);
    },
    lookAt: async () => {},
    openContainer: async (block) => {
      const c = containers[key(block.position)];
      bot.opened.push(key(block.position));
      // A blocked chest never sends a window.
      if (c.stuck) await new Promise(() => {});
      return {
        inventoryStart: 27,
        containerItems: () => live(c.items),
        items: () => live(inv),
        withdraw: async (type, meta, n) => {
          move(c.items, inv, type, n);
        },
        deposit: async (type, meta, n) => {
          const room = (c.room ?? Infinity) - c.items.reduce((sum, s) => sum + s.count, 0);
          const moved = move(inv, c.items, type, n, room);
          if (moved < n) throw new Error('destination full');
        },
        close: () => {}
      };
    }
  };
  for (const c of Object.values(containers)) c.items = c.items.map(([name, count]) => stack(name, count));
  return bot;
}

test('take_items takes from more than one known chest and says what came from where', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [['iron_ingot', 5]] },
    '-3,64,0': { name: 'barrel', items: [['iron_ingot', 20]] },
    '0,64,2': { name: 'chest', items: [['dirt', 64]] }
  };
  const bot = fakeBot({ containers });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 2, y: 64, z: 0 }], items: items({ iron_ingot: 5 }), free: 26 });
  index.record({ dim: 'overworld', name: 'barrel', parts: [{ x: -3, y: 64, z: 0 }], items: items({ iron_ingot: 20 }), free: 26 });
  const result = await takeItems({ bot }, { items: [{ item: 'iron_ingot', count: 12 }] });
  assert.equal(result.ok, true);
  assert.match(result.message, /5 iron_ingot from chest at 2 64 0; 7 iron_ingot from barrel at -3 64 0/);
  assert.deepEqual(bot.opened, ['2,64,0', '-3,64,0']);
  assert.deepEqual(index.find({ x: 2, y: 64, z: 0 }, 'overworld').items, []);
  assert.deepEqual(index.find({ x: -3, y: 64, z: 0 }, 'overworld').items, [['iron_ingot', 13]]);
  cleanup();
});

test('take_items corrects a chest that no longer has the item and tries the next', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [['dirt', 3]] },
    '-3,64,0': { name: 'chest', items: [['iron_ingot', 4]] }
  };
  const bot = fakeBot({ containers });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: 2, y: 64, z: 0 }], items: items({ iron_ingot: 30 }), free: 26 });
  index.record({ dim: 'overworld', name: 'chest', parts: [{ x: -3, y: 64, z: 0 }], items: items({ iron_ingot: 4 }), free: 26 });
  const result = await takeItems({ bot }, { items: [{ item: 'iron_ingot', count: 10 }] });
  assert.equal(result.ok, true);
  assert.match(result.message, /took 4 iron_ingot from chest at -3 64 0/);
  assert.match(result.message, /still missing: 6 iron_ingot/);
  assert.match(result.message, /chest at 2 64 0 no longer had iron_ingot/);
  assert.deepEqual(index.find({ x: 2, y: 64, z: 0 }, 'overworld').items, [['dirt', 3]]);
  cleanup();
});

test('take_items uses the nearest container when the index knows nothing', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [['bread', 3]] },
    '-3,64,0': { name: 'chest', items: [['iron_ingot', 4]] }
  };
  const bot = fakeBot({ containers });
  bot.chestIndex = index;
  const result = await takeItems({ bot }, { items: [{ item: 'iron_ingot' }] });
  assert.equal(result.ok, false);
  assert.deepEqual(bot.opened, ['2,64,0']);
  assert.ok(index.find({ x: 2, y: 64, z: 0 }, 'overworld'));
  cleanup();
});

test('opening a chest remembers its contents and sign label', async () => {
  const { index, cleanup } = tempIndex();
  const bot = fakeBot({ containers: { '2,64,0': { name: 'chest', items: [['oak_log', 9]] } }, signs: { '2,65,0': 'Wood' } });
  bot.chestIndex = index;
  await openContainer({ bot }, {});
  const seen = index.find({ x: 2, y: 64, z: 0 }, 'overworld');
  assert.deepEqual(seen.items, [['oak_log', 9]]);
  assert.deepEqual(seen.labels, ['sign "Wood"']);
  cleanup();
});

test('stash routes each kind, moves on from a full chest and reports what stayed', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [] },
    '-2,64,0': { name: 'chest', items: [], room: 10 },
    '0,64,3': { name: 'barrel', items: [['cobblestone', 1]], room: 20 },
    '3,64,2': { name: 'chest', items: [] }
  };
  const bot = fakeBot({
    containers,
    signs: { '-2,65,0': 'wood', '3,65,2': 'food' },
    inventory: [['cobblestone', 40], ['oak_log', 25], ['iron_pickaxe', 1], ['bread', 5], ['diamond', 2]]
  });
  bot.chestIndex = index;
  index.record({ dim: 'overworld', name: 'barrel', parts: [{ x: 0, y: 64, z: 3 }], items: items({ cobblestone: 1 }), free: 26 });
  const result = await stash({ bot }, {});
  assert.equal(result.ok, true);
  const contents = (k) => Object.fromEntries(containers[k].items.filter((s) => s.count).map((s) => [s.name, s.count]));
  assert.deepEqual(contents('0,64,3'), { cobblestone: 20 });
  assert.deepEqual(contents('-2,64,0'), { oak_log: 10 });
  assert.deepEqual(contents('2,64,0'), { cobblestone: 21, oak_log: 15, diamond: 2 });
  assert.deepEqual(contents('3,64,2'), {});
  assert.match(result.message, /kept 1 iron_pickaxe \(tools\); 5 bread \(food\)/);
  assert.match(result.message, /in chest at -2 64 0/);
  cleanup();
});

test('stash with nowhere fitting keeps the items and says why', async () => {
  const { index, cleanup } = tempIndex();
  const containers = { '2,64,0': { name: 'chest', items: [] } };
  const bot = fakeBot({ containers, signs: { '2,65,0': 'food' }, inventory: [['cobblestone', 8]] });
  bot.chestIndex = index;
  const result = await stash({ bot }, {});
  assert.equal(result.ok, false);
  assert.match(result.message, /still carrying 8 cobblestone \(every container nearby is labeled for something else\)/);
  cleanup();
});

test('trapped chests are only opened when their x y z is given', async () => {
  assert.equal(isPickable('chest'), true);
  assert.equal(isPickable('trapped_chest'), false);
  const here = new Vec3(0, 64, 0);
  const entries = [
    { key: 't', name: 'trapped_chest', parts: [{ x: 1, y: 64, z: 0 }], items: [['iron_ingot', 5]] },
    { key: 'c', name: 'chest', parts: [{ x: 9, y: 64, z: 0 }], items: [['iron_ingot', 5]] }
  ];
  assert.equal(pickSource(entries, new Map([['iron_ingot', 1]]), here).key, 'c');

  const { index, cleanup } = tempIndex();
  const containers = {
    '1,64,0': { name: 'trapped_chest', items: [['iron_ingot', 4]] },
    '-3,64,0': { name: 'chest', items: [['iron_ingot', 2]] }
  };
  const bot = fakeBot({ containers, inventory: [['cobblestone', 8]] });
  bot.chestIndex = index;
  const took = await takeItems({ bot }, { items: [{ item: 'iron_ingot' }] });
  assert.match(took.message, /took 2 iron_ingot \(chest at -3 64 0\)/);
  await stash({ bot }, {});
  assert.deepEqual(bot.opened, ['-3,64,0', '-3,64,0']);
  const asked = await takeItems({ bot }, { x: 1, y: 64, z: 0, items: [{ item: 'iron_ingot' }] });
  assert.match(asked.message, /took 4 iron_ingot \(trapped_chest at 1 64 0\)/);
  cleanup();
});

test('a container that never opens is given up on, and stash moves on to the next one', async () => {
  const { index, cleanup } = tempIndex();
  const containers = {
    '2,64,0': { name: 'chest', items: [], stuck: true },
    '-3,64,0': { name: 'chest', items: [] }
  };
  const bot = fakeBot({ containers, inventory: [['cobblestone', 8]] });
  bot.chestIndex = index;
  const result = await stash({ bot, openMs: 50 }, {});
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.opened, ['2,64,0', '-3,64,0']);
  assert.match(result.message, /put away 8 cobblestone in chest at -3 64 0/);
  assert.match(result.message, /the chest at 2 64 0 wouldn't open, something is probably blocking it/);
  cleanup();
});

test('opening gives up after the time limit or on stop, and closes a window that comes late', async () => {
  const bot = new EventEmitter();
  const late = () => {
    let send;
    const promise = new Promise((resolve) => { send = resolve; });
    return { promise, send };
  };
  const window = () => ({ closed: false, close() { this.closed = true; } });

  const slow = late();
  await assert.rejects(openWindow({ bot }, () => slow.promise, 20), /timed out/);
  const first = window();
  slow.send(first);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(first.closed, true);

  const controller = new AbortController();
  const stopped = late();
  const opening = openWindow({ bot, signal: controller.signal }, () => stopped.promise, 5000);
  controller.abort();
  await assert.rejects(opening, /stopped/);

  // Something opened since then, so the late window is left alone.
  const next = window();
  assert.equal(await openWindow({ bot }, async () => next, 1000), next);
  const second = window();
  stopped.send(second);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(second.closed, false);
});
