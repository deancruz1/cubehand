import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.js';
import { ACTIONS } from '../src/actions/index.js';
import { splitMessage, cleanText } from '../src/actions/chat.js';
import { planBuild } from '../src/actions/build.js';
import { isProtected, matchesBlockName } from '../src/actions/blocks.js';

test('short block names match every kind', () => {
  assert.equal(matchesBlockName('spruce_log', 'log'), true);
  assert.equal(matchesBlockName('trapped_chest', 'chest'), true);
  assert.equal(matchesBlockName('oak_log', 'oak_log'), true);
  assert.equal(matchesBlockName('oak_planks', 'log'), false);
});
import { isHandDoor } from '../src/actions/movement.js';
import { isContainer, countItems } from '../src/actions/containers.js';
import { isOre, isExposed, targetScore } from '../src/actions/mining.js';
import { missingFor } from '../src/actions/crafting.js';
import { isNaturalBlock, looksNatural } from '../src/actions/movement.js';
import { defaultSlot } from '../src/actions/inventory.js';
import { Vec3 } from 'vec3';

test('only natural terrain may be dug while walking', () => {
  assert.equal(isNaturalBlock('stone'), true);
  assert.equal(isNaturalBlock('deepslate_coal_ore'), true);
  assert.equal(isNaturalBlock('oak_leaves'), true);
  assert.equal(isNaturalBlock('oak_planks'), false);
  assert.equal(isNaturalBlock('cobblestone'), false);
  assert.equal(isNaturalBlock('glass'), false);
});

test('a block touching air is exposed, a buried one is not', () => {
  const buried = () => 'stone';
  const openAbove = (p) => (p.y === 65 ? 'air' : 'stone');
  assert.equal(isExposed(buried, new Vec3(0, 64, 0)), false);
  assert.equal(isExposed(openAbove, new Vec3(0, 64, 0)), true);
});

test('mining works the visible wall before buried blocks or the floor', () => {
  const wallFar = targetScore({ distance: 8, exposed: true, dy: 1 });
  const buriedNear = targetScore({ distance: 2, exposed: false, dy: 1 });
  const floorNear = targetScore({ distance: 2, exposed: true, dy: -1 });
  assert.ok(wallFar < buriedNear);
  assert.ok(wallFar < floorNear);
});

test('mining stays near the last block, clearing one face at a time', () => {
  const nextToLast = targetScore({ distance: 4, exposed: true, dy: 0, fromLast: 1 });
  const otherSide = targetScore({ distance: 3, exposed: true, dy: 0, fromLast: 7 });
  assert.ok(nextToLast < otherSide);
});

test('armor goes on the body and tools in the hand', () => {
  assert.equal(defaultSlot('iron_helmet'), 'head');
  assert.equal(defaultSlot('diamond_chestplate'), 'torso');
  assert.equal(defaultSlot('shield'), 'off-hand');
  assert.equal(defaultSlot('wooden_pickaxe'), 'hand');
});

test('logs and scaffold blocks look natural, planks and glass do not', () => {
  assert.equal(looksNatural('spruce_log'), true);
  assert.equal(looksNatural('cobblestone'), true);
  assert.equal(looksNatural('spruce_planks'), false);
  assert.equal(looksNatural('glass'), false);
});

test('crafting works out what is still missing', () => {
  // 4 planks make one crafting table.
  const recipe = { result: { id: 1, count: 1 }, delta: [{ id: 2, count: -4 }, { id: 1, count: 1 }] };
  assert.deepEqual(missingFor(recipe, 1, () => 1), [{ id: 2, need: 3 }]);
  assert.deepEqual(missingFor(recipe, 2, () => 8), []);
});

test('ores are recognised', () => {
  assert.equal(isOre('coal_ore'), true);
  assert.equal(isOre('deepslate_iron_ore'), true);
  assert.equal(isOre('ancient_debris'), true);
  assert.equal(isOre('stone'), false);
});


test('chests, barrels and shulker boxes count as containers', () => {
  assert.equal(isContainer('chest'), true);
  assert.equal(isContainer('barrel'), true);
  assert.equal(isContainer('red_shulker_box'), true);
  assert.equal(isContainer('furnace'), false);
});

test('container items are grouped by name', () => {
  const counts = countItems([{ name: 'cobblestone', count: 64 }, { name: 'dirt', count: 3 }, { name: 'cobblestone', count: 10 }]);
  assert.equal(counts.get('cobblestone'), 74);
  assert.equal(counts.get('dirt'), 3);
});

test('wooden doors can be walked through, iron doors cannot', () => {
  assert.equal(isHandDoor('spruce_door'), true);
  assert.equal(isHandDoor('copper_door'), true);
  assert.equal(isHandDoor('iron_door'), false);
  assert.equal(isHandDoor('spruce_trapdoor'), false);
});

test('every tool has an action and every action has a tool', () => {
  const toolNames = TOOLS.map((t) => t.name).sort();
  const actionNames = Object.keys(ACTIONS).sort();
  assert.deepEqual(toolNames, actionNames);
});

test('every tool schema is strict and closed', () => {
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
  }
});

test('a 400 character reply is split into ordered messages under the limit', () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  assert.ok(text.length > 400);
  const parts = splitMessage(text, 256);
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= 256);
  assert.equal(parts.join(' '), text);
});

test('a single very long word is cut into pieces', () => {
  const parts = splitMessage('a'.repeat(600), 256);
  assert.deepEqual(parts.map((p) => p.length), [256, 256, 88]);
});

test('newlines and section signs are cleaned out', () => {
  assert.equal(cleanText('hi\nthere §cfriend'), 'hi there cfriend');
});

test('protected names match whole names and suffixes', () => {
  const list = ['chest', 'bed', 'shulker_box'];
  assert.ok(isProtected('chest', list));
  assert.ok(isProtected('trapped_chest', list));
  assert.ok(isProtected('red_bed', list));
  assert.ok(isProtected('blue_shulker_box', list));
  assert.equal(isProtected('bedrock', list), false);
  assert.equal(isProtected('dirt', list), false);
});

function basePlan(overrides = {}) {
  return {
    origin: { x: 0, y: 64, z: 0 },
    blocks: [],
    botPos: { x: 0, y: 64, z: 0 },
    getName: () => 'air',
    inventory: new Map([['oak_planks', 100], ['cobblestone', 100]]),
    maxBlocks: 500,
    isKnownBlock: (name) => ['oak_planks', 'cobblestone'].includes(name),
    ...overrides
  };
}

test('placements go bottom layer first, then nearest first', () => {
  const plan = planBuild(basePlan({
    blocks: [
      { dx: 0, dy: 1, dz: 0, block: 'oak_planks' },
      { dx: 5, dy: 0, dz: 0, block: 'oak_planks' },
      { dx: 1, dy: 0, dz: 0, block: 'cobblestone' }
    ]
  }));
  assert.deepEqual(plan.placements.map((p) => [p.x, p.y, p.z]), [[1, 64, 0], [5, 64, 0], [0, 65, 0]]);
});

test('spots that already hold the right block are skipped', () => {
  const plan = planBuild(basePlan({
    blocks: [
      { dx: 0, dy: 0, dz: 0, block: 'cobblestone' },
      { dx: 1, dy: 0, dz: 0, block: 'cobblestone' }
    ],
    getName: (x) => (x === 0 ? 'cobblestone' : 'air')
  }));
  assert.equal(plan.skipped, 1);
  assert.equal(plan.placements.length, 1);
});

test('too many blocks is rejected before anything else', () => {
  const blocks = Array.from({ length: 3 }, (_, i) => ({ dx: i, dy: 0, dz: 0, block: 'oak_planks' }));
  const plan = planBuild(basePlan({ blocks, maxBlocks: 2 }));
  assert.match(plan.error, /limit is 2/);
});

test('unknown block names are rejected', () => {
  const plan = planBuild(basePlan({ blocks: [{ dx: 0, dy: 0, dz: 0, block: 'poplar_leaves' }] }));
  assert.match(plan.error, /unknown block: poplar_leaves/);
});

test('needed blocks are counted against the inventory', () => {
  const blocks = Array.from({ length: 5 }, (_, i) => ({ dx: i, dy: 0, dz: 0, block: 'oak_planks' }));
  const plan = planBuild(basePlan({ blocks, inventory: new Map([['oak_planks', 3]]) }));
  assert.deepEqual(plan.missing, [{ block: 'oak_planks', need: 5, have: 3 }]);
});

test('duplicate positions only count once', () => {
  const plan = planBuild(basePlan({
    blocks: [
      { dx: 0, dy: 0, dz: 0, block: 'oak_planks' },
      { dx: 0, dy: 0, dz: 0, block: 'cobblestone' }
    ]
  }));
  assert.equal(plan.placements.length, 1);
  assert.equal(plan.placements[0].block, 'cobblestone');
});
