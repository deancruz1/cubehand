import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  inventorySummary,
  countNearbyBlocks,
  blocksSummary,
  entitiesSummary,
  statusSummary,
  facingFromYaw
} from '../src/perception.js';

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

test('facing from yaw', () => {
  assert.equal(facingFromYaw(0), 'north');
  assert.equal(facingFromYaw(Math.PI / 2), 'west');
  assert.equal(facingFromYaw(Math.PI), 'south');
  assert.equal(facingFromYaw(-Math.PI / 2), 'east');
});
