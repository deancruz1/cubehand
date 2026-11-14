import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { planHouse, pickMaterials, isClearable, buildHouse } from '../src/actions/house.js';
import { otherChestHalf, signText, entitiesSummary, droppedItemsSummary, surroundingsSummary } from '../src/perception.js';
import { isGate, isHandTrapdoor, deepSnow, fixPassageSteps, insidePartialBlock } from '../src/actions/movement.js';
import { assignSigns } from '../src/perception.js';
import { bestWeapon, isTarget } from '../src/actions/combat.js';
import { treeLogs, isLogName } from '../src/actions/mining.js';
import { findLevels } from '../src/actions/survey.js';
import { isBuildRequest } from '../src/brain.js';
import { PlacedLog } from '../src/placed.js';

const materials = { walls: 'cobblestone', floor: 'oak_planks', roof: 'oak_planks', door: 'oak_door', windows: null, corners: null, torch: null };
const at = (plan, x, y, z) => plan.blocks.find((b) => b.x === x && b.y === y && b.z === z)?.block ?? null;

test('a small flat-roofed house has a floor, walls with a door, and a roof', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 5, depth: 5, roof: 'flat', materials });
  assert.equal(plan.counts.get('oak_planks'), 50);
  assert.equal(plan.counts.get('cobblestone'), 46);
  assert.equal(plan.counts.get('oak_door'), 1);
  assert.equal(at(plan, 0, 64, 2), 'oak_door');
  assert.equal(at(plan, 0, 65, 2), null);
  assert.equal(at(plan, 0, 63, 0), 'oak_planks');
  assert.equal(at(plan, 0, 67, 0), 'oak_planks');
});

test('a two-floor house has a ladder up through a hole in the upper floor', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 5, depth: 5, floors: 2, roof: 'flat', materials });
  const ladders = plan.blocks.filter((b) => b.block === 'ladder');
  assert.equal(ladders.length, 4);
  // The door faces south, so the ladder goes against the north wall.
  assert.ok(ladders.every((l) => l.x === -1 && l.z === -1 && l.attach.z === -1));
  assert.equal(at(plan, -1, 67, -1), 'ladder');
  assert.equal(at(plan, 0, 67, 0), 'oak_planks');
});

test('a gable roof steps up to a ridge along the longer side', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 7, depth: 5, materials });
  assert.equal(at(plan, 0, 67, -2), 'oak_planks');
  assert.equal(at(plan, 0, 68, -1), 'oak_planks');
  assert.equal(at(plan, 0, 69, 0), 'oak_planks');
  assert.equal(plan.max.y, 69);
  assert.equal(at(plan, -3, 67, 0), 'cobblestone');
});

test('windows go in the walls at eye level, away from the corners', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 7, depth: 7, roof: 'flat', materials: { ...materials, windows: 'glass_pane' } });
  const windows = plan.blocks.filter((b) => b.block === 'glass_pane');
  assert.equal(windows.length, 8);
  assert.ok(windows.every((w) => w.y === 65));
  assert.ok(windows.every((w) => Math.abs(w.x) !== 3 || Math.abs(w.z) !== 3));
});

test('house materials default to what the bot carries most of', () => {
  const inventory = new Map([['cobblestone', 200], ['oak_planks', 64], ['glass_pane', 16], ['oak_door', 1], ['dirt', 300]]);
  const m = pickMaterials(inventory);
  assert.equal(m.walls, 'cobblestone');
  assert.equal(m.floor, 'oak_planks');
  assert.equal(m.windows, 'glass_pane');
  assert.equal(m.door, 'oak_door');
  assert.equal(pickMaterials(inventory, { windows: 'none' }).windows, null);
  assert.equal(m.foundation, null);
  assert.equal(pickMaterials(inventory, { foundation: 'cobblestone', trim: 'stripped_oak_log' }).trim, 'stripped_oak_log');
});

test('a basement is a storey dug out under the ground floor, with the ladder going down', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 5, depth: 5, basement: true, roof: 'flat', materials });
  assert.equal(plan.min.y, 59);
  assert.equal(at(plan, 0, 59, 0), 'oak_planks');
  assert.equal(at(plan, -2, 61, 0), 'cobblestone');
  assert.equal(at(plan, 0, 61, 0), null);
  const ladders = plan.blocks.filter((b) => b.block === 'ladder');
  assert.deepEqual(ladders.map((l) => l.y).sort((a, b) => a - b), [60, 61, 62, 63]);
  assert.ok(ladders.every((l) => l.x === -1 && l.z === -1));
});

test('an attic gets a floor under the roof and a ladder up a gable end, away from the door', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 9, depth: 8, attic: true, materials: { ...materials, windows: 'glass_pane', torch: 'torch' } });
  assert.equal(at(plan, 0, 67, 0), 'oak_planks');
  const ladders = plan.blocks.filter((b) => b.block === 'ladder');
  assert.ok(ladders.every((l) => l.x === -3 && l.z === 0 && l.attach.x === -1));
  assert.deepEqual(ladders.map((l) => l.y).sort((a, b) => a - b), [64, 65, 66, 67]);
  // No window where the ladder hangs, but the other gable end keeps its window.
  assert.equal(at(plan, -4, 65, 0), 'cobblestone');
  assert.equal(at(plan, 4, 65, 0), 'glass_pane');
  assert.equal(at(plan, 3, 68, 0), 'torch');
});

test("a house can be rebuilt over the bot's own blocks, but not its bed or anyone else's blocks", async () => {
  const world = new Map([['0,65,0', 'oak_planks']]);
  const bot = {
    inventory: { items: () => [{ name: 'cobblestone', count: 300 }, { name: 'oak_planks', count: 300 }] },
    registry: { blocksByName: new Proxy({}, { get: () => ({}) }) },
    blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 64 ? 'dirt' : 'air') })
  };
  const mine = new Set(['0,65,0', '1,65,0']);
  const ctx = { bot, config: { protectedBlocks: ['chest', 'bed'] }, placed: { has: (p) => mine.has(`${p.x},${p.y},${p.z}`) } };
  const input = { x: 0, y: 64, z: 0, width: 5, depth: 5, roof: 'flat', materials: { walls: 'cobblestone', floor: 'oak_planks', door: 'none', windows: 'none' }, dry_run: true };

  const own = await buildHouse(ctx, input);
  assert.equal(own.ok, true);
  assert.match(own.message, /1 of my own blocks that don't fit the plan cleared first/);

  world.set('1,65,0', 'red_bed');
  world.set('-1,65,0', 'stone_bricks');
  const blocked = await buildHouse(ctx, input);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /red_bed at 1 65 0/);
  assert.match(blocked.message, /stone_bricks at -1 65 0/);
});

test('accents: a foundation along the bottom of the walls, trim at the floor lines and the top', () => {
  const plan = planHouse({
    x: 0, y: 64, z: 0, width: 5, depth: 5, floors: 2, roof: 'flat',
    materials: { ...materials, foundation: 'stone_bricks', trim: 'stripped_oak_log' }
  });
  assert.equal(at(plan, -2, 63, 0), 'stone_bricks');
  assert.equal(at(plan, -2, 64, 0), 'stone_bricks');
  assert.equal(at(plan, 0, 64, 2), 'oak_door');
  assert.equal(at(plan, -2, 65, 0), 'cobblestone');
  assert.equal(at(plan, -2, 67, 0), 'stripped_oak_log');
  assert.equal(at(plan, -2, 71, 0), 'stripped_oak_log');
  assert.equal(at(plan, 0, 71, 0), 'oak_planks');
  assert.equal(at(plan, 0, 63, 0), 'oak_planks');
});

test('natural blocks and plants can be cleared for a house, logs and builds cannot', () => {
  assert.equal(isClearable('grass_block'), true);
  assert.equal(isClearable('poppy'), true);
  assert.equal(isClearable('oak_sapling'), true);
  assert.equal(isClearable('oak_log'), false);
  assert.equal(isClearable('oak_planks'), false);
});

test('the other half of a double chest', () => {
  const p = new Vec3(10, 64, 10);
  assert.deepEqual(otherChestHalf(p, { type: 'left', facing: 'north' }), new Vec3(11, 64, 10));
  assert.deepEqual(otherChestHalf(p, { type: 'right', facing: 'north' }), new Vec3(9, 64, 10));
  assert.deepEqual(otherChestHalf(p, { type: 'left', facing: 'east' }), new Vec3(10, 64, 11));
  assert.equal(otherChestHalf(p, { type: 'single', facing: 'north' }), null);
});

test('sign text joins the lines on both sides and skips empty ones', () => {
  const entity = {
    front_text: { messages: ['Wood', '', { text: 'logs ', extra: [{ text: 'and planks' }] }, '""'] },
    back_text: { messages: ['', '', '', ''] }
  };
  assert.equal(signText(entity), 'Wood / logs and planks');
  assert.equal(signText(undefined), '');
});

test('mobs of one kind share a line, named mobs and players get their own', () => {
  const origin = new Vec3(0, 64, 0);
  const entities = [
    { name: 'Cow', kind: 'cow', position: new Vec3(3, 64, 0) },
    { name: 'Cow', kind: 'cow', position: new Vec3(6, 64, 0) },
    { name: 'Bessie', kind: 'cow', position: new Vec3(4, 64, 0), named: true },
    { name: 'Steve', kind: 'player', position: new Vec3(2, 64, 0) }
  ];
  const text = entitiesSummary(entities, origin, 64, 10);
  assert.match(text, /- 2 cow, nearest at 3 64 0/);
  assert.match(text, /Bessie \(cow with a name tag\)/);
  assert.match(text, /Steve \(player\)/);
});

test('dropped items are grouped by name with the nearest spot', () => {
  const origin = new Vec3(0, 64, 0);
  const items = [
    { name: 'oak_log', count: 2, position: new Vec3(5, 64, 0) },
    { name: 'oak_log', count: 1, position: new Vec3(2, 64, 0) },
    { name: 'stick', count: 1, position: new Vec3(50, 64, 0) }
  ];
  const text = droppedItemsSummary(items, origin, 16);
  assert.match(text, /3 oak_log \(nearest at 2 64 0/);
  assert.doesNotMatch(text, /stick/);
});

test('surroundings: open sky, a built roof with floors below, rock, or trees', () => {
  const feet = new Vec3(0, 68, 0);
  const world = (blocks) => (p) => ({ name: blocks[p.y] ?? 'air', boundingBox: blocks[p.y] ? 'block' : 'empty' });
  assert.match(surroundingsSummary(world({ 67: 'grass_block' }), feet), /outdoors, open sky/);
  const upstairs = world({ 72: 'oak_planks', 67: 'oak_planks', 63: 'oak_planks', 62: 'dirt' });
  assert.match(surroundingsSummary(upstairs, feet), /indoors.*floor 2/);
  assert.match(surroundingsSummary(world({ 75: 'stone', 67: 'stone' }), feet), /underground/);
  assert.match(surroundingsSummary(world({ 74: 'oak_leaves', 67: 'grass_block' }), feet), /under trees/);
});

test('gates and wooden trapdoors are passages, iron trapdoors are not', () => {
  assert.equal(isGate('oak_fence_gate'), true);
  assert.equal(isGate('oak_fence'), false);
  assert.equal(isHandTrapdoor('spruce_trapdoor'), true);
  assert.equal(isHandTrapdoor('iron_trapdoor'), false);
});

test('steps through doors and gates are put back on the floor', () => {
  const blocks = { '10,64,20': 'spruce_door', '12,64,20': 'oak_fence_gate', '11,63,20': 'stone' };
  const getBlock = (p) => ({ name: blocks[`${p.x},${p.y},${p.z}`] ?? 'air' });
  const path = [
    { x: 10.5, y: 65, z: 20.297 },
    { x: 11.5, y: 64, z: 20.5 },
    { x: 12.5, y: 65.5, z: 20.5 }
  ];
  fixPassageSteps(path, getBlock);
  assert.deepEqual(path, [
    { x: 10.5, y: 64, z: 20.5 },
    { x: 11.5, y: 64, z: 20.5 },
    { x: 12.5, y: 64, z: 20.5 }
  ]);
});

test('a hitbox pushed into the high step of a stair is noticed, standing on it is not', () => {
  const stair = { name: 'spruce_stairs', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 1, 1, 0.5]] };
  const getBlock = (p) => (p.x === 0 && p.y === 64 && p.z === 0 ? stair : { name: 'air', shapes: [] });
  assert.equal(insidePartialBlock(new Vec3(0.5, 64.5, 0.8), getBlock), null);
  assert.equal(insidePartialBlock(new Vec3(0.5, 64.5, 0.5), getBlock), stair);
  assert.equal(insidePartialBlock(new Vec3(0.5, 65, 0.3), getBlock), null);
});

test('a sign labels only the chest it is on, not its neighbour', () => {
  const double = { parts: [new Vec3(7, 64, -23), new Vec3(7, 64, -24)], labels: [] };
  const single = { parts: [new Vec3(8, 64, -24)], labels: [] };
  const signs = [{ pos: new Vec3(7, 65, -24), name: 'spruce_wall_sign', facing: 'south', text: 'WOOD / PRODUCTS' }];
  assignSigns(signs, [double, single]);
  assert.deepEqual(double.labels, ['sign "WOOD / PRODUCTS"']);
  assert.deepEqual(single.labels, []);
  assert.equal(signs[0].used, true);
});

test('snow deeper than five layers has to be dug through', () => {
  assert.equal(deepSnow(1), false);
  assert.equal(deepSnow(5), false);
  assert.equal(deepSnow(6), true);
});

test('the best weapon is picked, swords over axes of the same tier', () => {
  assert.equal(bestWeapon(['wooden_sword', 'iron_sword', 'stone_axe'])[0], 'iron_sword');
  assert.equal(bestWeapon(['diamond_axe', 'diamond_sword'])[0], 'diamond_sword');
  assert.equal(bestWeapon(['dirt']), null);
});

test('attack never targets players, and named mobs only by name', () => {
  const zombie = { type: 'hostile', name: 'zombie', metadata: [] };
  const cow = { type: 'animal', name: 'cow', metadata: [] };
  const player = { type: 'player', name: 'player', username: 'Steve' };
  const bessie = { type: 'animal', name: 'cow', metadata: [null, null, 'tag'], getCustomName: () => ({ toString: () => 'Bessie' }) };
  assert.equal(isTarget(zombie), true);
  assert.equal(isTarget(cow), false);
  assert.equal(isTarget(cow, 'cow'), true);
  assert.equal(isTarget(cow, 'cows'), true);
  assert.equal(isTarget(player, 'player'), false);
  assert.equal(isTarget(bessie, 'cow'), false);
  assert.equal(isTarget(bessie, 'Bessie'), true);
});

test('tree logs are found through corners, within a tree-sized box', () => {
  const logs = new Set(['0,64,0', '0,65,0', '0,66,0', '1,67,1', '9,64,0']);
  const getName = (p) => (logs.has(`${p.x},${p.y},${p.z}`) ? 'oak_log' : 'air');
  assert.equal(treeLogs(getName, new Vec3(0, 64, 0)).length, 4);
  assert.equal(isLogName('crimson_stem'), true);
  assert.equal(isLogName('oak_planks'), false);
});

test('levels are floor heights with enough standing room', () => {
  const counts = new Map([[64, 30], [65, 3], [68, 25], [69, 6]]);
  assert.deepEqual(findLevels(counts), [64, 68]);
});

test('build requests are recognised', () => {
  assert.equal(isBuildRequest('can you build a house here'), true);
  assert.equal(isBuildRequest('make me a small hut'), true);
  assert.equal(isBuildRequest('come here'), false);
  assert.equal(isBuildRequest('mine some stone'), false);
});

test('placed blocks are remembered by position and kind', () => {
  const log = new PlacedLog(join(tmpdir(), `placed-test-${process.pid}.json`));
  const pos = { x: 1, y: 64, z: 2 };
  log.add('crafting_table', pos);
  assert.equal(log.has(pos, 'crafting_table'), true);
  assert.equal(log.has(pos, 'chest'), false);
  log.remove(pos);
  assert.equal(log.has(pos, 'crafting_table'), false);
  clearTimeout(log.timer);
});
