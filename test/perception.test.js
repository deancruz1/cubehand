import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  inventorySummary,
  usesLeft,
  takeStock,
  stateLine,
  countNearbyBlocks,
  blocksSummary,
  entitiesSummary,
  statusSummary,
  facingFromYaw,
  scaffoldSummary,
  standingSummary
} from '../src/perception.js';

test('the standing job gets one line, cut short, and nothing when there is none', () => {
  assert.equal(standingSummary(null), null);
  const job = { task: `Strip mine at y -59, ${'one tunnel every 3 blocks, '.repeat(10)}`, by: 'Steve', progress: 'Tunnel at z 3 dug; next is z 6.', rounds: 2, state: 'active', reason: null };
  const line = standingSummary(job);
  assert.match(line, /^Standing job \(active; from Steve, 2 rounds so far\): Strip mine at y -59, one tunnel/);
  assert.match(line, /\.\.\. Progress: Tunnel at z 3 dug; next is z 6\.$/);
  assert.ok(line.length < 400);
  assert.equal(line.includes('\n'), false);
  assert.match(standingSummary({ ...job, state: 'paused', reason: 'Steve said stop' }), /^Standing job \(paused: Steve said stop; from Steve/);
});

test('inventory groups items by name', () => {
  const items = [
    { name: 'oak_planks', count: 64 },
    { name: 'oak_planks', count: 20 },
    { name: 'bread', count: 3 }
  ];
  const text = inventorySummary(items, { name: 'bread' });
  assert.match(text, /oak_planks: 84/);
  assert.match(text, /bread: 3/);
  assert.match(text, /Holding: bread/);
});

test('empty inventory says empty', () => {
  const text = inventorySummary([], null);
  assert.match(text, /Inventory: empty/);
  assert.match(text, /Holding: nothing/);
});

const pickaxe = (used, max = 250) => ({ name: 'iron_pickaxe', count: 1, maxDurability: max, durabilityUsed: used });

test('tools show their uses left, with what is worn, the off hand, free slots and level', () => {
  const items = [{ name: 'cobblestone', count: 30 }, pickaxe(70), pickaxe(0), { name: 'cobblestone', count: 2 }];
  const text = inventorySummary(items, pickaxe(70), {
    armor: [{ name: 'iron_helmet', count: 1, maxDurability: 165, durabilityUsed: 15 }],
    offHand: { name: 'shield', count: 1, maxDurability: 336, durabilityUsed: 0 },
    freeSlots: 33,
    level: 7
  });
  assert.equal(
    text,
    'Inventory (33 slots free): cobblestone: 32, iron_pickaxe (180 uses left), iron_pickaxe (250 uses left)\n' +
      'Holding: iron_pickaxe. Off hand: shield (336 uses left). Wearing: iron_helmet (150 uses left). Experience level 7'
  );
  assert.equal(inventorySummary([], null, { freeSlots: 36, level: 0 }), 'Inventory: empty\nHolding: nothing');
});

test('uses left reads a changed maximum from the item components, and items that never wear out have none', () => {
  const custom = { ...pickaxe(10), componentMap: new Map([['max_damage', { type: 'max_damage', data: 100 }]]) };
  assert.equal(usesLeft(custom), 90);
  assert.equal(usesLeft({ name: 'dirt', count: 1, maxDurability: undefined }), null);
  const broken = { name: 'bow', maxDurability: 384, get durabilityUsed() { throw new Error('unknown durability location'); } };
  assert.equal(usesLeft(broken), 384);
});

function stockBot({ slots = {}, health = 20, food = 20, at = new Vec3(1.5, 64, -2.5) } = {}) {
  const all = Array(46).fill(null);
  for (const [slot, item] of Object.entries(slots)) all[slot] = item;
  return { entity: { position: at }, health, food, inventory: { slots: all } };
}

test('a tool result ends with where the bot is, and only adds what changed', () => {
  const before = takeStock(stockBot({ slots: { 36: pickaxe(200), 9: { name: 'oak_planks', count: 8 } } }));
  const quiet = takeStock(stockBot({ slots: { 36: pickaxe(200), 9: { name: 'oak_planks', count: 8 } } }));
  assert.equal(stateLine(before, quiet), 'Now at 1 64 -3.');

  const after = takeStock(stockBot({ slots: { 36: pickaxe(232), 9: { name: 'oak_planks', count: 5 }, 10: { name: 'cobblestone', count: 12 } }, health: 13.6, food: 17, at: new Vec3(10.2, 60, 4.9) }));
  assert.equal(stateLine(before, after), 'Now at 10 60 4, health 14/20, food 17/20. Inventory -3 oak_planks, +12 cobblestone. iron_pickaxe is nearly worn out (18 uses left).');
  assert.equal(stateLine(null, null), '');
  assert.equal(takeStock({ entity: null }), null);
});

test('every tool result gets the state line, failures too', async () => {
  const { runAction } = await import('../src/actions/index.js');
  const bot = stockBot({ food: 12 });
  const forgot = await runAction({ bot, memory: { forget: () => true } }, 'forget', { name: 'quarry' });
  assert.deepEqual(forgot, { ok: true, message: 'forgot quarry\nNow at 1 64 -3, health 20/20, food 12/20.' });
  bot.chat = () => {
    throw new Error('not connected');
  };
  const failed = await runAction({ bot }, 'say', { message: 'hi' });
  assert.deepEqual(failed, { ok: false, message: 'say failed: not connected\nNow at 1 64 -3, health 20/20, food 12/20.' });
  assert.deepEqual(await runAction({ bot: null, memory: { forget: () => false } }, 'forget', { name: 'x' }), { ok: false, message: 'no memory called x' });
});

test('a worn tool is only mentioned when the call wore it down', () => {
  const worn = { slots: { 36: pickaxe(245) } };
  assert.equal(stateLine(takeStock(stockBot(worn)), takeStock(stockBot(worn))), 'Now at 1 64 -3.');
  // Armor moved onto the body is no inventory change.
  const helmet = { name: 'iron_helmet', count: 1, maxDurability: 165, durabilityUsed: 0 };
  assert.equal(stateLine(takeStock(stockBot({ slots: { 12: helmet } })), takeStock(stockBot({ slots: { 5: helmet } }))), 'Now at 1 64 -3.');
});

test('nearby blocks only counts within the radius and skips air', () => {
  const world = (x, y, z) => {
    if (y === -1) return 'dirt';
    if (x === 3 && y === 0 && z === 0) return 'oak_log';
    if (x === 9 && y === 0 && z === 0) return 'diamond_ore';
    return 'air';
  };
  const counts = countNearbyBlocks(world, new Vec3(0, 0, 0), 8);
  const names = counts.map(([name]) => name);
  assert.ok(names.includes('dirt'));
  assert.ok(names.includes('oak_log'));
  assert.ok(!names.includes('diamond_ore'));
  assert.ok(!names.includes('air'));
});

test('unloaded positions are skipped', () => {
  const counts = countNearbyBlocks(() => null, new Vec3(0, 0, 0), 2);
  assert.deepEqual(counts, []);
  assert.match(blocksSummary(counts, 'grass_block', 2), /Blocks within 2: none/);
});

test('nearby entities are sorted, limited and show distance', () => {
  const origin = new Vec3(0, 64, 0);
  const entities = [
    { name: 'Steve', kind: 'player', position: new Vec3(5, 64, 0) },
    { name: 'Zombie', kind: 'zombie', position: new Vec3(2, 64, 0) },
    { name: 'Far', kind: 'player', position: new Vec3(40, 64, 0) }
  ];
  const text = entitiesSummary(entities, origin, 16, 10);
  assert.match(text, /Steve \(player\) at 5 64 0, 5\.0 away/);
  assert.ok(text.indexOf('Zombie') < text.indexOf('Steve'));
  assert.ok(!text.includes('Far'));
  assert.ok(!entitiesSummary(entities, origin, 16, 1).includes('Steve'));
});

test('status shows whole-number position and labels', () => {
  const text = statusSummary({
    position: new Vec3(10.7, 64, -3.2),
    yaw: 0,
    health: 18.5,
    food: 17,
    dimension: 'overworld',
    gameMode: 'survival',
    timeOfDay: 14000
  });
  assert.match(text, /Position: 10 64 -4/);
  assert.match(text, /Health: 19\/20, Food: 17\/20/);
  assert.match(text, /Time: night/);
});

test('walk scaffolding left standing gets a line, and none when there is none', () => {
  const here = new Vec3(0.5, 64, 0.5);
  assert.equal(scaffoldSummary([], here), null);
  const entries = [{ x: 10, y: 64, z: 0, name: 'cobblestone' }, { x: 3, y: 65, z: 0, name: 'dirt' }];
  assert.equal(scaffoldSummary(entries, here), 'Scaffolding left standing from walks: 2 blocks, nearest dirt at 3 65 0 (3 away). It comes down in free time.');
  assert.match(scaffoldSummary(entries.slice(0, 1), here), /: 1 block, nearest cobblestone at 10 64 0 \(10 away\)/);
});

test('facing from yaw', () => {
  assert.equal(facingFromYaw(0), 'north');
  assert.equal(facingFromYaw(Math.PI / 2), 'west');
  assert.equal(facingFromYaw(Math.PI), 'south');
  assert.equal(facingFromYaw(-Math.PI / 2), 'east');
});
