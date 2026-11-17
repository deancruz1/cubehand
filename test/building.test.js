import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { parseBlock, blockText, stateProblem, matchesState, placementOptions, itemFor } from '../src/actions/states.js';
import { EventEmitter } from 'node:events';
import { expandParts, planBuild, nearestFirst, buildSite, buildStructure, watchBuildScaffold, groupBlocks, fromHere, groundUnder, buildZone, withinStock, breakBlocks } from '../src/actions/build.js';
import { setPauseScale } from '../src/actions/util.js';
import { planHouse, buildHouse } from '../src/actions/house.js';
import { placeOne, placeBlock, findReference, inSight } from '../src/actions/blocks.js';
import { markPathfinderPlace } from '../src/actions/movement.js';
import { createRequire } from 'node:module';

// Real 26.1 blocks, loaded the way mineflayer loads them, for shapes and states.
const requireMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const realRegistry = requireMf('prismarine-registry')('26.1');
const RealBlock = requireMf('prismarine-block')(realRegistry);

const registry = {
  itemsByName: { torch: {}, oak_stairs: {}, spruce_trapdoor: {}, oak_log: {} },
  blocksByName: {
    oak_stairs: { states: [{ name: 'facing', type: 'enum', values: ['north', 'south', 'west', 'east'] }, { name: 'half', type: 'enum', values: ['top', 'bottom'] }, { name: 'shape', type: 'enum', values: ['straight'] }] },
    oak_planks: { states: [] },
    oak_log: { states: [{ name: 'axis', type: 'enum', values: ['x', 'y', 'z'] }] }
  }
};

test('block states are read the way the game writes them, and checked against the block', () => {
  assert.deepEqual(parseBlock('oak_stairs[facing=north, half=top]'), { name: 'oak_stairs', props: { facing: 'north', half: 'top' } });
  assert.deepEqual(parseBlock('minecraft:oak_planks'), { name: 'oak_planks', props: {} });
  assert.equal(blockText('oak_log', { axis: 'x' }), 'oak_log[axis=x]');
  assert.equal(stateProblem(registry, 'oak_stairs', { facing: 'north', half: 'top' }), null);
  assert.match(stateProblem(registry, 'oak_stairs', { facing: 'up' }), /can't be chosen/);
  assert.match(stateProblem(registry, 'oak_stairs', { shape: 'outer_left' }), /can't set shape/);
  assert.match(stateProblem(registry, 'oak_planks', { axis: 'x' }), /takes no state/);
  assert.match(stateProblem(registry, 'oak_log', { axis: 'w' }), /axis is one of x, y, z/);
  assert.match(stateProblem(registry, 'oak_slab', { type: 'double' }), /use the full block/);
  assert.equal(itemFor('wall_torch', registry), 'torch');
  assert.equal(itemFor('oak_stairs', registry), 'oak_stairs');
});

test('a block matches when the parts of its state that were asked for match', () => {
  const stair = { name: 'oak_stairs', getProperties: () => ({ facing: 'north', half: 'top', shape: 'outer_left' }) };
  assert.equal(matchesState(stair, 'oak_stairs', { facing: 'north', half: 'top' }), true);
  assert.equal(matchesState(stair, 'oak_stairs', { facing: 'south' }), false);
  assert.equal(matchesState(stair, 'oak_stairs', undefined), true);
  // Shutters get opened and closed, that doesn't make them wrong.
  const shutter = { name: 'spruce_trapdoor', getProperties: () => ({ facing: 'north', open: false }) };
  assert.equal(matchesState(shutter, 'spruce_trapdoor', { facing: 'north', open: 'true' }), true);
});

test('placing in a state picks which neighbor to click, where, and which way to look', () => {
  const stairs = placementOptions('oak_stairs', { facing: 'north', half: 'top' });
  assert.deepEqual(stairs[0].dir, new Vec3(0, 1, 0));
  assert.ok(stairs.every((o) => o.yaw === 0 && o.half === 'top' && o.dir.y !== -1));
  // A furnace faces back at whoever places it.
  assert.equal(placementOptions('furnace', { facing: 'north' })[0].yaw, Math.PI);
  const log = placementOptions('oak_log', { axis: 'x' });
  assert.deepEqual(log.map((o) => o.dir.x), [-1, 1]);
  // A trapdoor facing south hangs on the block north of it.
  const trapdoor = placementOptions('spruce_trapdoor', { facing: 'south', half: 'top' });
  assert.deepEqual(trapdoor[0].dir, new Vec3(0, 0, -1));
  assert.equal(trapdoor[0].half, 'top');
  assert.deepEqual(placementOptions('wall_torch', { facing: 'east' }), [{ dir: new Vec3(-1, 0, 0) }]);
  assert.deepEqual(placementOptions('lantern', { hanging: 'true' })[0].dir, new Vec3(0, 1, 0));
});

test('parts turn into blocks, later ones win, and air carves openings', () => {
  const blocks = expandParts(
    [
      { shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 4, dy: 2, dz: 4 }, block: 'cobblestone' },
      { shape: 'frame', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 4, dy: 2, dz: 4 }, block: 'oak_log' },
      { shape: 'fill', from: { dx: 2, dy: 0, dz: 0 }, to: { dx: 2, dy: 1, dz: 0 }, block: 'air' }
    ],
    [{ dx: 1, dy: 1, dz: 0, block: 'glass_pane' }]
  );
  const at = (x, y, z) => blocks.find((b) => b.dx === x && b.dy === y && b.dz === z)?.block ?? null;
  assert.equal(blocks.filter((b) => b.dy === 1).length, 15);
  assert.equal(at(2, 0, 0), null);
  assert.equal(at(2, 2, 0), 'oak_log');
  assert.equal(at(0, 1, 0), 'oak_log');
  assert.equal(at(3, 1, 0), 'cobblestone');
  assert.equal(at(1, 1, 0), 'glass_pane');
  assert.equal(at(2, 1, 2), null);
  const line = expandParts([{ shape: 'line', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 3, dy: 3, dz: 0 }, block: 'oak_log' }]);
  assert.deepEqual(line.map((b) => [b.dx, b.dy]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test('a stair roof climbs to a slab ridge from both sides and hangs over the walls', () => {
  const blocks = expandParts([{ shape: 'roof', from: { dx: 0, dy: 4, dz: 0 }, to: { dx: 6, dy: 4, dz: 4 }, block: 'spruce_stairs', fill: 'spruce_planks' }]);
  const at = (x, y, z) => blocks.find((b) => b.dx === x && b.dy === y && b.dz === z)?.block ?? null;
  assert.equal(at(-1, 4, -1), 'spruce_stairs[facing=south,half=bottom]');
  assert.equal(at(7, 4, 5), 'spruce_stairs[facing=north,half=bottom]');
  assert.equal(at(3, 5, 0), 'spruce_stairs[facing=south,half=bottom]');
  assert.equal(at(3, 7, 2), 'spruce_slab[type=bottom]');
  assert.equal(at(3, 8, 2), null);
  // The gable ends and the wall tops under the eaves are closed.
  assert.equal(at(0, 4, 2), 'spruce_planks');
  assert.equal(at(0, 6, 2), 'spruce_planks');
  assert.equal(at(3, 4, 0), 'spruce_planks');
  assert.equal(at(3, 6, 2), null);
});

test('a planned build skips blocks already turned the right way and counts wall torches as torches', () => {
  const world = { '0,64,0': { name: 'oak_stairs', getProperties: () => ({ facing: 'north', half: 'bottom' }) } };
  const plan = planBuild({
    origin: { x: 0, y: 64, z: 0 },
    blocks: [
      { dx: 0, dy: 0, dz: 0, block: 'oak_stairs[facing=north]' },
      { dx: 1, dy: 0, dz: 0, block: 'oak_stairs[facing=east]' },
      { dx: 2, dy: 0, dz: 0, block: 'wall_torch[facing=east]' }
    ],
    botPos: { x: 0, y: 64, z: 0 },
    getBlock: (x, y, z) => world[`${x},${y},${z}`] ?? { name: 'air' },
    inventory: new Map([['oak_stairs', 1], ['torch', 1]]),
    maxBlocks: 100,
    isKnownBlock: () => true
  });
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.placements.map((p) => p.props), [{ facing: 'east' }, { facing: 'east' }]);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.needed.get('torch'), 1);
  const bad = planBuild({ origin: { x: 0, y: 0, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_stairs[shape=inner_left]' }], botPos: { x: 0, y: 0, z: 0 }, getName: () => 'air', inventory: new Map(), maxBlocks: 9, isKnownBlock: () => true, checkState: (n, p) => stateProblem(registry, n, p) });
  assert.match(bad.error, /can't set shape/);
});

const materials = { walls: 'spruce_planks', floor: 'spruce_planks', roof: 'spruce_stairs', ridge: 'spruce_slab', door: 'spruce_door', windows: 'glass_pane', corners: 'spruce_log', trim: 'stripped_spruce_log', torch: null };
const find = (plan, x, y, z) => plan.blocks.find((b) => b.x === x && b.y === y && b.z === z) ?? null;

test('a detailed house: stair roof with overhang, posts through the trim, beams along the walls', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 7, depth: 5, materials });
  // Walls from y 64 to 66, roof from 67.
  assert.deepEqual(find(plan, -4, 67, -3).props, { facing: 'south', half: 'bottom' });
  assert.deepEqual(find(plan, 0, 69, -1).props, { facing: 'south', half: 'bottom' });
  assert.deepEqual(find(plan, 0, 69, 1).props, { facing: 'north', half: 'bottom' });
  assert.equal(find(plan, 0, 70, 0).block, 'spruce_slab');
  assert.equal(plan.max.y, 70);
  assert.deepEqual([plan.min.x, plan.max.x, plan.min.z, plan.max.z], [-4, 4, -3, 3]);
  assert.deepEqual([plan.walls.min.x, plan.walls.max.x], [-3, 3]);
  assert.equal(find(plan, -3, 67, -2).block, 'spruce_log');
  assert.deepEqual(find(plan, 0, 67, -2).props, { axis: 'x' });
  assert.deepEqual(find(plan, -3, 67, 0).props, { axis: 'z' });
  assert.equal(find(plan, -3, 68, 0).block, 'spruce_planks');
});

test('house details: sills, shutters beside windows but never over the door, a porch, a chimney', () => {
  const plan = planHouse({
    x: 0, y: 64, z: 0, width: 7, depth: 7, materials: {
      ...materials, sills: 'spruce_trapdoor', shutters: 'spruce_trapdoor', porch: 'spruce_slab', posts: 'spruce_fence', chimney: 'cobblestone'
    }
  });
  // A south wall window at x -1 (z 3): sill under it, shutters either side, but not at x 0,
  // which is the door.
  assert.equal(find(plan, -1, 65, 3).block, 'glass_pane');
  assert.deepEqual(find(plan, -1, 64, 4).props, { facing: 'south', half: 'top' });
  assert.deepEqual(find(plan, -2, 65, 4).props, { facing: 'south', half: 'bottom', open: 'true' });
  assert.equal(find(plan, 0, 65, 4), null);
  assert.deepEqual(find(plan, 0, 66, 4).props, { type: 'top' });
  assert.equal(find(plan, 1, 66, 5).block, 'spruce_slab');
  assert.equal(find(plan, 1, 64, 5).block, 'spruce_fence');
  assert.equal(find(plan, 0, 64, 5), null);
  // The chimney goes up the west gable end, away from the south door, with no window behind it.
  const chimney = plan.blocks.filter((b) => b.block === 'cobblestone');
  assert.ok(chimney.every((b) => b.x === -4 && b.z === 0));
  assert.equal(Math.max(...chimney.map((b) => b.y)), plan.max.y);
  assert.notEqual(find(plan, -3, 65, 0).block, 'glass_pane');
});

test('building over a site leaves the ground under the eaves alone', async () => {
  const bot = {
    inventory: { items: () => [{ name: 'spruce_planks', count: 500 }, { name: 'spruce_stairs', count: 200 }, { name: 'spruce_slab', count: 50 }] },
    registry: { blocksByName: new Proxy({}, { get: () => ({}) }) },
    blockAt: (p) => ({ name: p.y < 64 ? 'grass_block' : 'air' })
  };
  const ctx = { bot, config: { protectedBlocks: [] } };
  const result = await buildHouse(ctx, { x: 0, y: 64, z: 0, width: 5, depth: 5, materials: { walls: 'spruce_planks', roof: 'spruce_stairs', door: 'none', windows: 'none' }, dry_run: true });
  assert.equal(result.ok, true);
  assert.match(result.message, /ridge spruce_slab/);
  // Only the ground under the floor goes.
  assert.match(result.message, /and 25 natural blocks cleared first/);
  const flat = await buildHouse(ctx, { x: 0, y: 64, z: 0, roof: 'flat', materials: { walls: 'spruce_planks', roof: 'spruce_stairs' }, dry_run: true });
  assert.match(flat.message, /needs a gable roof/);
});

test('placing stairs looks the way they should face and clicks the upper half for upside down', async () => {
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  world.set('1,64,0', solid('cobblestone', new Vec3(1, 64, 0)));
  const looks = [];
  let clicked;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 2.5), height: 1.62 },
    registry,
    inventory: { items: () => [{ name: 'oak_stairs', count: 4 }] },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
    equip: async () => {},
    look: async (yaw, pitch) => looks.push(yaw),
    _placeBlockWithOptions: async (ref, face, options) => {
      clicked = { ref: ref.position, face, options };
      world.set('0,64,0', { name: 'oak_stairs', position: new Vec3(0, 64, 0), boundingBox: 'block', getProperties: () => ({ facing: 'west', half: 'top' }) });
    }
  };
  const result = await placeOne({ bot }, 'oak_stairs', new Vec3(0, 64, 0), { props: { facing: 'west', half: 'top' } });
  assert.equal(result.ok, true);
  assert.equal(result.wrong, undefined);
  assert.deepEqual(looks, [Math.PI / 2]);
  assert.deepEqual(clicked.ref, new Vec3(1, 64, 0));
  assert.ok(clicked.face.equals(new Vec3(-1, 0, 0)));
  assert.equal(clicked.options.half, 'top');
  assert.equal(clicked.options.forceLook, 'ignore');

  // If the game turned it some other way, the result says so.
  world.delete('0,64,0');
  bot._placeBlockWithOptions = async () => {
    world.set('0,64,0', { name: 'oak_stairs', position: new Vec3(0, 64, 0), boundingBox: 'block', getProperties: () => ({ facing: 'east', half: 'top' }) });
  };
  const turned = await placeOne({ bot }, 'oak_stairs', new Vec3(0, 64, 0), { props: { facing: 'west', half: 'top' } });
  assert.equal(turned.wrong, true);
  assert.match(turned.message, /came out as oak_stairs\[facing=east,half=top\]/);
});

test('inspecting a box puts runs of the same block on one line', async () => {
  const { inspectBlocks } = await import('../src/actions/blocks.js');
  const bot = { blockAt: (p) => ({ name: p.z < 2 ? 'stone' : 'air' }) };
  const result = await inspectBlocks({ bot, config: { limits: { maxInspectBlocks: 600 } } }, { x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 4 });
  assert.equal(result.message.split('\n').slice(1).join('|'), '0 64 0..1: stone|0 64 2..4: air');
  const one = await inspectBlocks({ bot, config: { limits: { maxInspectBlocks: 600 } } }, { x1: 0, y1: 64, z1: 3 });
  assert.equal(one.message, '0 64 3: air');
});

test('a box too big to list gets a summary per layer, and only a huge one is refused', async () => {
  const { inspectBlocks } = await import('../src/actions/blocks.js');
  const nameAt = (p) => (p.y === 64 ? 'stone' : p.y === 65 && p.z === 3 && p.x >= 2 && p.x <= 4 ? 'oak_planks' : 'air');
  const bot = { blockAt: (p) => ({ name: nameAt(p) }) };
  const config = { limits: { maxInspectBlocks: 600 } };
  const result = await inspectBlocks({ bot, config }, { x1: 9, y1: 70, z1: 9, x2: 0, y2: 64, z2: 0 });
  assert.equal(result.ok, true);
  const lines = result.message.split('\n');
  assert.match(lines[0], /^box is 700 blocks, more than the 600 a full listing takes, .* A box of 600 or fewer gives the full listing/);
  assert.deepEqual(lines.slice(1), ['y 64: 100 stone (x 0..9, z 0..9)', 'y 65: 3 oak_planks (x 2..4, z 3), 97 air', 'y 66..70: 100 air']);
  const huge = await inspectBlocks({ bot, config }, { x1: 0, y1: 0, z1: 0, x2: 99, y2: 9, z2: 99 });
  assert.equal(huge.ok, false);
  assert.match(huge.message, /^box is 100000 blocks, the limit is 32768 for a summary/);
});

test('eating when already full is an answer, not a failure; carrying no food still fails', async () => {
  const { eat } = await import('../src/actions/blocks.js');
  const bot = { food: 20, registry: { foodsByName: { bread: {} } }, inventory: { items: () => [{ name: 'bread', count: 3 }] } };
  assert.deepEqual(await eat({ bot }, {}), { ok: true, message: 'already full' });
  bot.inventory.items = () => [];
  assert.equal((await eat({ bot }, {})).ok, false);
});

// Walks through placements like the bot does: it only moves when the next block is out of
// reach, then stands right by it. Counts the walks and the blocks walked.
function walkThrough(order, start) {
  const at = { ...start };
  const eye = () => ({ x: at.x, y: at.y + 1.6, z: at.z });
  let walks = 0;
  let walked = 0;
  for (const p of order(eye)) {
    const e = eye();
    if (Math.hypot(p.x + 0.5 - e.x, p.y + 0.5 - e.y, p.z + 0.5 - e.z) > 4.5) {
      walks++;
      walked += Math.hypot(p.x + 0.5 - at.x, p.z + 0.5 - at.z);
      Object.assign(at, { x: p.x + 0.5, z: p.z + 1.5 });
    }
  }
  return { walks, walked };
}

test('a ring of walls goes up around the ring, not from two ends at once', () => {
  const blocks = expandParts([{ shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 10, dy: 0, dz: 10 }, block: 'oak_planks' }]);
  const start = { x: 5.5, y: 64, z: -1.5 };
  const plan = planBuild({ origin: { x: 0, y: 64, z: 0 }, blocks, botPos: { x: 5, y: 64, z: -2 }, getName: () => 'air', inventory: new Map(), maxBlocks: 500, isKnownBlock: () => true });
  const before = walkThrough(() => plan.placements, start);
  const after = walkThrough((eye) => nearestFirst(plan.placements, eye), start);
  assert.equal([...nearestFirst(plan.placements, () => start)].length, 40);
  assert.ok(after.walks <= 8, `walked ${after.walks} times`);
  assert.ok(after.walks < before.walks / 2, `${after.walks} walks against ${before.walks}`);
  assert.ok(after.walked < before.walked / 2, `${Math.round(after.walked)} blocks against ${Math.round(before.walked)}`);
});

test('everything in reach is placed before the bot walks on', () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({ x: i * 2, y: 64, z: 0 }));
  const at = { x: 0.5, y: 65.6, z: 1.5 };
  const order = [];
  for (const p of nearestFirst(blocks, () => at)) {
    const inReach = (q) => Math.hypot(q.x + 0.5 - at.x, q.y + 0.5 - at.y, q.z + 0.5 - at.z) <= 4.5;
    const left = blocks.filter((q) => !order.includes(q) && q !== p);
    if (!inReach(p)) {
      assert.ok(!left.some(inReach));
      Object.assign(at, { x: p.x + 0.5, z: 1.5 });
    }
    order.push(p);
  }
  assert.deepEqual(order.map((p) => p.x), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
});

test('blocks are grouped by what lies together: a wall with a window is one group, two gable ends are two', () => {
  const wall = expandParts([
    { shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 8, dy: 3, dz: 0 }, block: 'oak_planks' },
    { shape: 'fill', from: { dx: 3, dy: 1, dz: 0 }, to: { dx: 4, dy: 2, dz: 0 }, block: 'air' }
  ]).map((b) => ({ x: b.dx, y: b.dy, z: b.dz }));
  assert.equal(groupBlocks(wall).length, 1);
  const ends = [0, 12].flatMap((x) => [0, 1, 2, 3, 4].map((i) => ({ x, y: 80 + Math.min(i, 4 - i), z: i })));
  const groups = groupBlocks(ends);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.length === 5 && new Set(g.map((p) => p.x)).size === 1));
  // One empty block between two blocks still joins them, two don't.
  assert.equal(groupBlocks([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]).length, 1);
  assert.equal(groupBlocks([{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }]).length, 2);
});

test('a wall goes up section by section from where the bot stands, each block after the one under it', () => {
  const blocks = expandParts([{ shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 15, dy: 3, dz: 0 }, block: 'oak_planks' }]);
  const plan = planBuild({ origin: { x: 0, y: 64, z: 0 }, blocks, botPos: { x: 0, y: 64, z: 2 }, getName: () => 'air', inventory: new Map(), maxBlocks: 500, isKnownBlock: () => true });
  const start = { x: 0.5, y: 64, z: 2.5 };
  const byLayer = walkThrough((eye) => {
    const layers = [...new Set(plan.placements.map((p) => p.y))].map((y) => plan.placements.filter((p) => p.y === y));
    return layers.flatMap((layer) => [...nearestFirst(layer, eye)]);
  }, start);
  const order = [];
  const now = walkThrough((eye) => (function* () {
    for (const p of fromHere(plan.placements, eye)) {
      order.push(p);
      yield p;
    }
  })(), start);
  assert.equal(order.length, 64);
  for (const [i, p] of order.entries()) {
    if (p.y > 64) assert.ok(order.slice(0, i).some((q) => q.x === p.x && q.y === p.y - 1), `${p.x} ${p.y} before the block under it`);
  }
  assert.ok(now.walks < byLayer.walks, `${now.walks} walks against ${byLayer.walks} layer by layer`);
  assert.ok(now.walks <= 4, `walked ${now.walks} times`);
  // A ring of walls still goes round once.
  const ring = expandParts([{ shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 10, dy: 0, dz: 10 }, block: 'oak_planks' }])
    .map((b) => ({ x: b.dx, y: 64 + b.dy, z: b.dz }));
  assert.ok(walkThrough((eye) => fromHere(ring, eye), { x: 5.5, y: 64, z: -1.5 }).walks <= 8);
});

// A bot on flat stone at y 63 that places whatever it is asked to and walks by jumping to a
// spot two blocks south of the target, unless canReach(target) says no. Records each placement
// and each walk.
function builderBot({ items, canReach = () => true, start, extra = [], noRoute = false }) {
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -4; x <= 24; x++) for (let z = -4; z <= 6; z++) world.set(`${x},63,${z}`, solid('stone', new Vec3(x, 63, z)));
  for (const p of extra) world.set(`${p.x},${p.y},${p.z}`, solid('stone', new Vec3(p.x, p.y, p.z)));
  const events = [];
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: start, height: 1.62 },
    registry: { blocksByName: { oak_planks: {}, dirt: {} }, itemsByName: { oak_planks: { id: 5 }, dirt: { id: 3 } } },
    inventory: { items: () => items },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', shapes: [], getProperties: () => ({}) },
    equip: async (item) => { bot.heldItem = item; },
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      const name = bot.heldItem?.name ?? 'oak_planks';
      world.set(`${pos.x},${pos.y},${pos.z}`, solid(name, pos));
      events.push({ placed: pos, name });
    },
    dig: async (block) => {
      world.delete(`${block.position.x},${block.position.y},${block.position.z}`);
      events.push({ dug: block.position });
    },
    canDigBlock: () => true,
    pathfinder: {
      goto: async (goal) => {
        events.push({ walk: goal.pos });
        if (canReach(goal.pos)) bot.entity.position = new Vec3(goal.pos.x + 0.5, 64, goal.pos.z + 2.5);
        else if (noRoute) throw Object.assign(new Error('no route found, so nothing was dug or placed'), { name: 'NoRoute' });
      },
      setGoal: () => {},
      isMining: () => false,
      isBuilding: () => false,
      bestHarvestTool: () => null
    }
  });
  bot.world = { getBlock: (p) => bot.blockAt(p), raycast: () => null };
  const ctx = { bot, config: { limits: { maxBuildBlocks: 500, moveTimeoutSeconds: 90 } } };
  return { bot, ctx, events, world, solid };
}

test('build_structure finishes one group before walking to the next', async () => {
  setPauseScale(0);
  const { ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 64 }], start: new Vec3(1.5, 64, 2.5) });
  const wall = (dx) => ({ shape: 'fill', from: { dx, dy: 0, dz: 0 }, to: { dx: dx + 2, dy: 1, dz: 0 }, block: 'oak_planks' });
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [wall(0), wall(14)] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 12, skipped 0, failed 0$/);
  const placed = events.filter((e) => e.placed).map((e) => e.placed.x);
  // Layer by layer it would have done the bottom of both, then come back for the tops.
  assert.deepEqual(placed.map((x) => (x < 7 ? 'near' : 'far')), [...Array(6).fill('near'), ...Array(6).fill('far')]);
  assert.equal(events.filter((e) => e.walk).length, 1);
});

test('build_structure places everything it can reach before it walks', async () => {
  setPauseScale(0);
  const { bot, ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 64 }], start: new Vec3(0.5, 64, 2.5) });
  const walkedWithWorkInReach = [];
  const goto = bot.pathfinder.goto;
  bot.pathfinder.goto = async (goal) => {
    const eye = bot.entity.position.offset(0, 1.6, 0);
    for (let x = 0; x <= 11; x++) {
      for (const y of [64, 65]) {
        const free = bot.blockAt(new Vec3(x, y, 0)).name === 'air';
        const supported = y === 64 || bot.blockAt(new Vec3(x, y - 1, 0)).name !== 'air';
        if (free && supported && eye.distanceTo(new Vec3(x + 0.5, y + 0.5, 0.5)) <= 4.5) walkedWithWorkInReach.push(`${x} ${y}`);
      }
    }
    return goto(goal);
  };
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 11, dy: 1, dz: 0 }, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 24,/);
  assert.deepEqual(walkedWithWorkInReach, []);
  const walks = events.filter((e) => e.walk).length;
  assert.ok(walks >= 1 && walks <= 3, `walked ${walks} times`);
});

test('build_structure skips a group it cannot get to after a few tries, finishes the rest, and says what is left', async () => {
  setPauseScale(0);
  // Five blocks up on a ledge at y 80 the bot can't get to, and a short wall on the ground.
  const high = [0, 1, 2, 3, 4].map((i) => ({ x: 2 + i, y: 79, z: 0 }));
  const parts = [
    { shape: 'line', from: { dx: 2, dy: 16, dz: 0 }, to: { dx: 6, dy: 16, dz: 0 }, block: 'oak_planks' },
    { shape: 'line', from: { dx: 20, dy: 0, dz: 0 }, to: { dx: 22, dy: 0, dz: 0 }, block: 'oak_planks' }
  ];
  const run = async (items) => {
    const built = builderBot({ items, canReach: (p) => p.y < 70, start: new Vec3(4.5, 64, 2.5), extra: high });
    const result = await buildStructure(built.ctx, { origin: { x: 0, y: 64, z: 0 }, parts });
    return { result, events: built.events };
  };
  const { result, events } = await run([{ name: 'oak_planks', count: 64 }, { name: 'dirt', count: 20 }]);
  const bare = await run([{ name: 'oak_planks', count: 64 }]);
  setPauseScale(1);
  // The ledge is closer, so it goes first, but only three walks are spent on it.
  const walks = events.filter((e) => e.walk);
  assert.equal(walks.filter((w) => w.walk.y === 80).length, 3);
  assert.ok(walks.slice(0, 3).every((w) => w.walk.y === 80));
  assert.deepEqual(events.filter((e) => e.placed).map((e) => e.placed.x), [20, 21, 22]);
  // Part of it got built, so it counts as done, with what is left grouped.
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 3, skipped 0, failed 3\. Left to do, 5 blocks in 1 group: 5 blocks around 4 80 0 \(5 oak_planks, from 2 80 0 to 6 80 0\): couldn't get up there, the lowest is 16 blocks above where I got to \(3 tries, last: could not get close enough to \d 80 0: could not get all the way there, now at 4 64 2\); I have 20 dirt, so scaffolding up is possible\. build_structure with the same plan again skips what is already in place$/);
  assert.match(bare.result.message, /; I have no blocks to scaffold with \(dirt, cobblestone and the like\), obtain or mine some dirt or cobblestone first\./);
});

test('a group whose first block has no route is skipped after that one walk', async () => {
  setPauseScale(0);
  const high = [0, 1, 2, 3, 4].map((i) => ({ x: 2 + i, y: 79, z: 0 }));
  const parts = [
    { shape: 'line', from: { dx: 2, dy: 16, dz: 0 }, to: { dx: 6, dy: 16, dz: 0 }, block: 'oak_planks' },
    { shape: 'line', from: { dx: 20, dy: 0, dz: 0 }, to: { dx: 22, dy: 0, dz: 0 }, block: 'oak_planks' }
  ];
  const { ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 64 }], canReach: (p) => p.y < 70, start: new Vec3(4.5, 64, 2.5), extra: high, noRoute: true });
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts });
  setPauseScale(1);
  assert.equal(events.filter((e) => e.walk && e.walk.y === 80).length, 1);
  assert.deepEqual(events.filter((e) => e.placed).map((e) => e.placed.x), [20, 21, 22]);
  assert.match(result.message, /couldn't get up there, the lowest is 16 blocks above where I got to \(1 try, last: could not get close enough to \d 80 0: no route found/);
});

test('scaffolding for a build that starts high up may go up from the ground, and only the bot\'s own is claimed', () => {
  // Roof trim at y 82 on a house whose walls end at y 81, on ground at y 63.
  const solid = (p) => p.y <= 63 || (p.x >= 0 && p.x <= 4 && p.z >= 0 && p.z <= 4 && p.y <= 81);
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(-1.5, 70, 0.5) },
    registry: { itemsByName: {} },
    blockAt: (p) => ({ name: solid(p) ? 'stone' : 'air', position: p, boundingBox: solid(p) ? 'block' : 'empty' })
  });
  const site = { min: new Vec3(0, 82, 0), max: new Vec3(4, 82, 4) };
  site.ground = groundUnder(bot, site.min, site.max);
  assert.equal(site.ground, 64);
  assert.equal(buildZone(site, site.ground).min.y, 63);
  const scaffold = watchBuildScaffold(bot, site, new Set());
  const put = (x, y, z, byBot) => {
    if (byBot) markPathfinderPlace(bot, new Vec3(x, y, z));
    bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty' }, { name: 'dirt', position: new Vec3(x, y, z) });
  };
  put(-2, 69, 0, true);
  put(-2, 69, 1, false);
  scaffold.stop();
  assert.deepEqual(scaffold.leftover([]).map((p) => `${p.x} ${p.y} ${p.z}`), ['-2 69 0']);
});

test('build_structure fails when it could place nothing', async () => {
  setPauseScale(0);
  const { ctx } = builderBot({ items: [{ name: 'oak_planks', count: 64 }], canReach: () => false, start: new Vec3(0.5, 64, 12.5) });
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'line', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 7, dy: 0, dz: 0 }, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, false);
  assert.match(result.message, /^placed 0, skipped 0, failed 3\. Left to do, 8 blocks in 1 group: 8 blocks around 4 64 0 \(8 oak_planks, from 0 64 0 to 7 64 0\): couldn't get close enough \(3 tries/);
});

test('the site of a structure is the box its blocks fill', () => {
  const site = buildSite({ x: 10, y: 64, z: -5 }, [{ dx: 0, dy: 0, dz: 0 }, { dx: 3, dy: 4, dz: -2 }]);
  assert.deepEqual([site.min.x, site.min.y, site.min.z], [10, 64, -7]);
  assert.deepEqual([site.max.x, site.max.y, site.max.z], [13, 68, -5]);
  assert.ok(site.planned.has('13,68,-7'));
});

test('build_structure keeps its materials out of scaffolding and takes its scaffolding down', async () => {
  setPauseScale(0);
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -2; x <= 6; x++) for (let z = -3; z <= 3; z++) world.set(`${x},63,${z}`, solid('stone', new Vec3(x, 63, z)));
  const ids = { oak_planks: 5, cobblestone: 4 };
  const during = [];
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(1.5, 64, -1.5), height: 1.62 },
    registry: { blocksByName: { oak_planks: {}, cobblestone: {} }, itemsByName: { oak_planks: { id: 5 }, cobblestone: { id: 4 } } },
    inventory: { items: () => [{ name: 'oak_planks', count: 10, type: ids.oak_planks }] },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
    equip: async () => {},
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      world.set(`${pos.x},${pos.y},${pos.z}`, solid('oak_planks', pos));
      during.push({ zone: bot.buildZone, keep: bot.buildKeep });
      if (during.length === 1) {
        // The pathfinder pillars up on cobblestone next to the build.
        const s = new Vec3(3, 64, 1);
        const old = bot.blockAt(s);
        world.set('3,64,1', solid('cobblestone', s));
        markPathfinderPlace(bot, s);
        bot.emit('blockUpdate', old, world.get('3,64,1'));
      }
    },
    canDigBlock: () => true,
    dig: async (block) => world.delete(`${block.position.x},${block.position.y},${block.position.z}`),
    pathfinder: { bestHarvestTool: () => null, isBuilding: () => false }
  });
  const ctx = { bot, config: { limits: { maxBuildBlocks: 100 } } };
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'line', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 2, dy: 0, dz: 0 }, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /placed 3, skipped 0, failed 0, took down 1 scaffolding blocks/);
  assert.equal(during.length, 3);
  assert.deepEqual([during[0].zone.min.x, during[0].zone.min.y, during[0].zone.max.x, during[0].zone.max.y], [-2, 63, 4, 66]);
  assert.deepEqual([...during[0].keep], [5]);
  assert.equal(bot.buildZone, null);
  assert.equal(bot.buildKeep, null);
  assert.equal(bot.blockAt(new Vec3(3, 64, 1)).name, 'air');
  assert.equal(bot.listenerCount('blockUpdate'), 0);
});

test('build_structure digs its scaffolding out of planned spots and leaves blocks it did not place', async () => {
  setPauseScale(0);
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -2; x <= 6; x++) for (let z = -3; z <= 3; z++) world.set(`${x},63,${z}`, solid('stone', new Vec3(x, 63, z)));
  let placings = 0;
  const put = (name, x, y, z, byBot) => {
    const s = new Vec3(x, y, z);
    const old = bot.blockAt(s);
    world.set(`${x},${y},${z}`, solid(name, s));
    if (byBot) markPathfinderPlace(bot, s);
    bot.emit('blockUpdate', old, world.get(`${x},${y},${z}`));
  };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(1.5, 64, -1.5), height: 1.62 },
    registry: { blocksByName: { oak_planks: {}, cobblestone: {}, dirt: {} }, itemsByName: { oak_planks: { id: 5 }, cobblestone: { id: 4 }, dirt: { id: 3 } } },
    inventory: { items: () => [{ name: 'oak_planks', count: 10, type: 5 }] },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
    equip: async () => {},
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      world.set(`${pos.x},${pos.y},${pos.z}`, solid('oak_planks', pos));
      if (++placings === 1) {
        // The pathfinder leaves dirt on a spot the plan still needs, and pillars up far over the
        // build; a player puts dirt down beside it.
        put('dirt', 2, 64, 0, true);
        put('cobblestone', 2, 68, 0, true);
        put('dirt', 3, 64, 1, false);
      }
    },
    canDigBlock: () => true,
    dig: async (block) => world.delete(`${block.position.x},${block.position.y},${block.position.z}`),
    pathfinder: { bestHarvestTool: () => null, isBuilding: () => false }
  });
  const ctx = { bot, config: { limits: { maxBuildBlocks: 100 } } };
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'line', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 2, dy: 0, dz: 0 }, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /placed 3, skipped 0, failed 0$/);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0)).name, 'oak_planks');
  assert.equal(bot.blockAt(new Vec3(2, 68, 0)).name, 'cobblestone');
  assert.equal(bot.blockAt(new Vec3(3, 64, 1)).name, 'dirt');
});

test('build_house notes scaffolding on its planned spots and only claims its own blocks near the house', () => {
  const plan = planHouse({ x: 0, y: 64, z: 0, width: 5, depth: 5, roof: 'flat', materials: { walls: 'cobblestone', floor: 'oak_planks', door: 'none', windows: 'none' } });
  const planned = new Map(plan.blocks.map((b) => [`${b.x},${b.y},${b.z}`, b]));
  const world = new Map();
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(3.5, 64, 3.5) },
    registry: { itemsByName: { cobblestone: { id: 4 }, oak_planks: { id: 5 }, dirt: { id: 3 } } },
    buildKeep: new Set([4, 5]),
    blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) ?? 'air', position: p, getProperties: () => ({}) })
  });
  const scaffold = watchBuildScaffold(bot, plan, planned);
  const put = (name, x, y, z, byBot) => {
    bot.entity.position = new Vec3(x + 1.5, y + 1, z + 0.5);
    world.set(`${x},${y},${z}`, name);
    if (byBot) markPathfinderPlace(bot, new Vec3(x, y, z));
    bot.emit('blockUpdate', { boundingBox: 'empty' }, { name, position: new Vec3(x, y, z) });
  };
  const wall = plan.blocks.find((b) => b.block === 'cobblestone' && b.y === 65);
  put('dirt', wall.x, wall.y, wall.z, true);
  put('dirt', 4, 64, 4, true);
  put('dirt', 4, plan.max.y + 4, 4, true);
  put('dirt', 3, 64, 4, false);
  scaffold.stop();
  assert.deepEqual([...scaffold.strays], [`${wall.x},${wall.y},${wall.z}`]);
  assert.deepEqual(scaffold.leftover(plan.blocks).map((p) => `${p.x},${p.y},${p.z}`), ['4,64,4', `${wall.x},${wall.y},${wall.z}`]);
  world.set(`${wall.x},${wall.y},${wall.z}`, 'cobblestone');
  assert.deepEqual(scaffold.leftover(plan.blocks).map((p) => `${p.x},${p.y},${p.z}`), ['4,64,4']);
  assert.equal(bot.listenerCount('blockUpdate'), 0);
});

// A bot among real 26.1 blocks, with a server that answers a click the way the game does: a
// wooden door or trapdoor that gets clicked swings and nothing is placed, anything else gets
// the held block in the spot across the clicked face. refuse(dest, ref) turns a click down too.
function serverBot({ at, items, refuse = () => false }) {
  const blocks = new Map();
  const text = (props) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)]));
  const w = {
    set: (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, RealBlock.fromProperties(name, text(props), 0)),
    get: (p) => {
      const b = blocks.get(`${p.x},${p.y},${p.z}`);
      const out = b ? RealBlock.fromStateId(b.stateId, 0) : RealBlock.fromProperties('air', {}, 0);
      out.position = new Vec3(p.x, p.y, p.z);
      return out;
    }
  };
  const clicks = [];
  const walks = [];
  const bot = {
    entity: { position: at.clone(), height: 1.8 },
    registry: realRegistry,
    entities: {},
    inventory: { items: () => items.map(([name, count]) => ({ name, count })) },
    blockAt: (p) => w.get(p),
    equip: async (item) => { bot.heldItem = item; },
    look: async () => {},
    pathfinder: { goto: async (goal) => { walks.push(goal); }, setGoal() {}, isMining: () => false, isBuilding: () => false }
  };
  bot.world = { getBlock: (p) => w.get(p), raycast: () => null };
  const click = async (ref, face, half) => {
    const dest = ref.position.plus(face);
    clicks.push(`${ref.name} ${ref.position.x} ${ref.position.y} ${ref.position.z}`);
    const refused = new Error(`Server refused to place ${bot.heldItem.name} at ${dest}: the block is still air`);
    if (/_door$|_trapdoor$/.test(ref.name) && !ref.name.startsWith('iron_')) {
      const props = ref.getProperties();
      w.set(ref.position.x, ref.position.y, ref.position.z, ref.name, { ...props, open: String(props.open) !== 'true' });
      throw refused;
    }
    if (refuse(dest, ref)) throw refused;
    // A slab clicked on the open face of the same slab joins it, and the spot across stays.
    const open = ref.name.endsWith('_slab') && ((face.y > 0 && ref.getProperties().type === 'bottom') || (face.y < 0 && ref.getProperties().type === 'top'));
    if (open && ref.name === bot.heldItem.name) {
      w.set(ref.position.x, ref.position.y, ref.position.z, ref.name, { type: 'double' });
      throw refused;
    }
    const type = face.y < 0 || (face.y === 0 && half === 'top') ? 'top' : 'bottom';
    w.set(dest.x, dest.y, dest.z, bot.heldItem.name, bot.heldItem.name.endsWith('_slab') ? { type } : {});
  };
  bot.placeBlock = (ref, face) => click(ref, face);
  bot._placeBlockWithOptions = (ref, face, options) => click(ref, face, options.half);
  return { bot, w, clicks, walks, ctx: { bot, config: { limits: { moveTimeoutSeconds: 90 } } } };
}

test('a block is never placed against a door or trapdoor, which would swing open instead', async () => {
  setPauseScale(0);
  // Under a window: a sill trapdoor below the spot and the glass pane of the window beside it.
  const { bot, w, clicks, ctx } = serverBot({ at: new Vec3(0.5, 64, 3.5), items: [['cobblestone', 4]] });
  w.set(0, 64, 0, 'spruce_trapdoor', { facing: 'north', half: 'top', open: false });
  w.set(0, 65, -1, 'glass_pane');
  const result = await placeBlock(ctx, { block: 'cobblestone', x: 0, y: 65, z: 0 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(clicks, ['glass_pane 0 65 -1']);
  assert.equal(String(bot.blockAt(new Vec3(0, 64, 0)).getProperties().open), 'false');

  // Above a door with nothing else next to it yet: it says why instead of opening the door.
  w.set(3, 64, 0, 'spruce_door', { facing: 'north', half: 'lower', hinge: 'left', open: false });
  w.set(3, 65, 0, 'spruce_door', { facing: 'north', half: 'upper', hinge: 'left', open: false });
  const above = await placeBlock(ctx, { block: 'cobblestone', x: 3, y: 66, z: 0 });
  setPauseScale(1);
  assert.equal(above.ok, false);
  assert.match(above.message, /^no block to place against at 3 66 0: the spruce_door below would open instead of taking a block\. Something has to go next to it first/);
  assert.equal(clicks.length, 1);
  assert.equal(String(bot.blockAt(new Vec3(3, 65, 0)).getProperties().open), 'false');
});

test('a walk to place a block only ends where a face it can use is in sight', async () => {
  setPauseScale(0);
  const { w, walks, ctx } = serverBot({ at: new Vec3(0.5, 64, 12.5), items: [['cobblestone', 4]] });
  w.set(0, 64, 0, 'spruce_trapdoor', { facing: 'north', half: 'top', open: false });
  w.set(1, 65, 0, 'stone');
  await placeBlock(ctx, { block: 'cobblestone', x: 0, y: 65, z: 0 });
  setPauseScale(1);
  assert.equal(walks.length, 1);
  assert.deepEqual(walks[0].facesPos.map(([dir]) => dir.toString()), ['(1, 0, 0)']);
});

test('slabs go against the side of a slab beside them, only not onto its open half', async () => {
  setPauseScale(0);
  // A porch roof: the middle slab between two slabs already down, with nothing under it.
  const { bot, w, clicks, ctx } = serverBot({ at: new Vec3(1.5, 64, 3.5), items: [['spruce_slab', 8]] });
  w.set(0, 66, 0, 'spruce_slab', { type: 'bottom' });
  w.set(2, 66, 0, 'spruce_slab', { type: 'bottom' });
  const porch = await placeBlock(ctx, { block: 'spruce_slab', x: 1, y: 66, z: 0 });
  assert.equal(porch.ok, true, porch.message);
  assert.equal(bot.blockAt(new Vec3(1, 66, 0)).getProperties().type, 'bottom');
  // A roof ridge, a bottom slab next to the last one.
  const ridge = await placeBlock(ctx, { block: 'spruce_slab[type=bottom]', x: 1, y: 66, z: 1 });
  assert.equal(ridge.ok, true, ridge.message);
  assert.deepEqual(clicks, ['spruce_slab 2 66 0', 'spruce_slab 1 66 0']);
  // A top slab clicked on the upper half of a bottom slab's side would join it, and so would
  // any slab on top of a bottom slab.
  const top = await placeBlock(ctx, { block: 'spruce_slab[type=top]', x: 3, y: 66, z: 0 });
  assert.match(top.message, /^no block to place against at 3 66 0: the spruce_slab west would join it into a double slab/);
  w.set(5, 65, 0, 'spruce_slab', { type: 'bottom' });
  assert.equal(findReference(bot, new Vec3(5, 66, 0), 'spruce_slab'), null);
  setPauseScale(1);
});

test('a double slab goes in as one slab and a second clicked onto its open face', async () => {
  setPauseScale(0);
  const { bot, w, clicks, ctx } = serverBot({ at: new Vec3(0.5, 64, 3.5), items: [['spruce_slab', 4]] });
  w.set(0, 63, 0, 'stone');
  const result = await placeBlock(ctx, { block: 'spruce_slab[type=double]', x: 0, y: 64, z: 0 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'placed spruce_slab[type=double] at 0 64 0');
  assert.equal(bot.blockAt(new Vec3(0, 64, 0)).getProperties().type, 'double');
  assert.deepEqual(clicks, ['stone 0 63 0', 'spruce_slab 0 64 0']);
  // A top slab already there gets the second one from below.
  w.set(2, 65, 0, 'spruce_slab', { type: 'top' });
  const joined = await placeBlock(ctx, { block: 'spruce_slab[type=double]', x: 2, y: 65, z: 0 });
  setPauseScale(1);
  assert.equal(joined.ok, true, joined.message);
  assert.equal(bot.blockAt(new Vec3(2, 65, 0)).getProperties().type, 'double');
});

// A small source build: stairs, a log lying along x, a double slab, a door, water and a chest.
function copySource() {
  const built = serverBot({ at: new Vec3(5.5, 64, 5.5), items: [['oak_stairs', 1]] });
  const { w } = built;
  w.set(0, 64, 0, 'oak_stairs', { facing: 'east', half: 'bottom' });
  w.set(1, 64, 0, 'oak_log', { axis: 'x' });
  w.set(2, 64, 0, 'spruce_slab', { type: 'double' });
  w.set(0, 64, 1, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: false });
  w.set(0, 65, 1, 'oak_door', { facing: 'north', half: 'upper', hinge: 'left', open: false });
  w.set(1, 64, 1, 'water', { level: 0 });
  w.set(2, 64, 1, 'chest', { facing: 'south' });
  built.ctx.config.limits.maxBuildBlocks = 500;
  return built;
}

test('a copy reads every block with its state, keeps one half of a door, and turns it all clockwise', async () => {
  const { copyPlan } = await import('../src/actions/build.js');
  const { bot } = copySource();
  const plan = copyPlan(bot, new Vec3(0, 64, 0), new Vec3(2, 65, 1), 90);
  const at = (dx, dy, dz) => plan.blocks.find((b) => b.dx === dx && b.dy === dy && b.dz === dz)?.block;
  assert.equal(plan.blocks.length, 5);
  assert.equal(at(1, 0, 0), 'oak_stairs[facing=south,half=bottom]');
  assert.equal(at(1, 0, 1), 'oak_log[axis=z]');
  assert.equal(at(1, 0, 2), 'spruce_slab[type=double]');
  assert.equal(at(0, 0, 0), 'oak_door[facing=east,open=false]');
  assert.equal(at(0, 0, 2), 'chest[facing=west]');
  assert.deepEqual(plan.leftOut, [{ name: 'water', why: 'no item places it' }]);
  assert.deepEqual([...plan.containers], [['chest', 1]]);
  const straight = copyPlan(bot, new Vec3(0, 64, 0), new Vec3(2, 65, 1));
  assert.equal(straight.blocks.find((b) => b.dx === 0 && b.dz === 0).block, 'oak_stairs[facing=east,half=bottom]');
});

test('copy_structure plans through build_structure, says what it left out, and lists what stands where the source has air', async () => {
  const { copyStructure } = await import('../src/actions/build.js');
  const { w, ctx } = copySource();
  w.set(11, 65, 0, 'stone');
  const box = { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 1, origin: { x: 10, y: 64, z: 0 } };
  const result = await copyStructure(ctx, { ...box, clear: true, dry_run: true });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^copy of 0 64 0 to 2 65 1 at 10 64 0: Plan: 5 blocks, 0 already in place\. Needs .*2 spruce_slab.*\. Missing: /);
  assert.match(result.message, /\. Left out 1 blocks build_structure can't place: 1 water \(no item places it\)\. Containers are built empty, nothing inside them is copied: 1 chest\. 1 blocks at the copy stand where the source has air, left as they are: 1 stone \(at 11 65 0\)$/);
  ctx.config.limits.maxBuildBlocks = 2;
  const big = await copyStructure(ctx, box);
  assert.equal(big.ok, false);
  assert.match(big.message, /^the source has 5 blocks to copy, the limit is 2/);
});

test('a click the server turns down is tried again on another face', async () => {
  setPauseScale(0);
  const { bot, w, clicks, ctx } = serverBot({ at: new Vec3(0.5, 64, 3.5), items: [['cobblestone', 4]], refuse: (dest, ref) => ref.position.y < dest.y });
  w.set(0, 63, 0, 'stone');
  w.set(1, 64, 0, 'stone');
  const result = await placeBlock(ctx, { block: 'cobblestone', x: 0, y: 64, z: 0 });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(clicks, ['stone 0 63 0', 'stone 1 64 0']);
  assert.equal(bot.blockAt(new Vec3(0, 64, 0)).name, 'cobblestone');
});

test('nothing is clicked while a mob stands in the spot', async () => {
  setPauseScale(0);
  const { bot, w, clicks, ctx } = serverBot({ at: new Vec3(0.5, 64, 3.5), items: [['cobblestone', 4]] });
  w.set(0, 63, 0, 'stone');
  bot.entities = { 7: { type: 'animal', name: 'cow', position: new Vec3(0.4, 64, 0.6), width: 0.9, height: 1.4 } };
  const result = await placeBlock(ctx, { block: 'cobblestone', x: 0, y: 64, z: 0 });
  setPauseScale(1);
  assert.equal(result.ok, false);
  assert.match(result.message, /^cow is in the way at 0 64 0/);
  assert.deepEqual(clicks, []);
});

test('a face counts as in sight only with nothing solid between the eyes and it', () => {
  const { bot, w } = serverBot({ at: new Vec3(0.5, 64, 3.5), items: [] });
  w.set(0, 63, 0, 'stone');
  const ref = findReference(bot, new Vec3(0, 64, 0), 'cobblestone');
  assert.equal(inSight(bot, ref, new Vec3(0, 64, 0)), true);
  w.set(0, 65, 1, 'stone');
  w.set(0, 64, 1, 'stone');
  assert.equal(inSight(bot, ref, new Vec3(0, 64, 0)), false);
});

test('a block with nothing to place against gets a scaffolding block beside it that comes out again', async () => {
  setPauseScale(0);
  // A lintel over a gap, with nothing under its middle block.
  const { bot, ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 8 }, { name: 'dirt', count: 4 }], start: new Vec3(1.5, 64, 2.5) });
  bot.registry.itemsByName.dirt = { id: 3 };
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 0, dy: 1, dz: 0, block: 'oak_planks' }, { dx: 1, dy: 2, dz: 0, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 3, skipped 0, failed 0$/);
  assert.equal(bot.blockAt(new Vec3(1, 66, 0)).name, 'oak_planks');
  assert.equal(bot.blockAt(new Vec3(1, 65, 0)).name, 'air');
  const support = events.filter((e) => e.name === 'dirt');
  assert.equal(support.length, 1);
  assert.ok(events.some((e) => e.dug?.equals(support[0].placed)));
});

test('a block it can not hold up is left with the reason, and the call still counts what it did', async () => {
  setPauseScale(0);
  const { ctx } = builderBot({ items: [{ name: 'oak_planks', count: 8 }], start: new Vec3(1.5, 64, 2.5) });
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 3, dy: 3, dz: 0, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^placed 1, skipped 0, failed 1\. Left to do, 1 blocks in 1 group: 1 block around 3 67 0 \(1 oak_planks, at 3 67 0\): no block to place against at 3 67 0: nothing solid on any side\. Something has to go next to it first/);
});

// A chest at 5 64 5 the bot remembers holding remembered, that really holds inside. Taking
// from it moves the items into the bot's inventory.
function withChest(bot, items, remembered, inside) {
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => (p.x === 5 && p.y === 64 && p.z === 5 ? { name: 'chest', position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : blockAt(p));
  bot.lookAt = async () => {};
  bot.registry.blocksArray = [];
  bot.chestIndex = {
    list: () => [{ key: 'k', name: 'chest', parts: [{ x: 5, y: 64, z: 5 }], items: remembered }],
    prune: () => {},
    find: () => true,
    record: () => {}
  };
  bot.openContainer = async () => ({
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => items,
    containerItems: () => inside.filter((i) => i.count > 0).map((i) => ({ ...i, type: 1 })),
    withdraw: async (type, meta, n) => {
      const from = inside.find((i) => i.count > 0);
      from.count -= n;
      const to = items.find((i) => i.name === from.name);
      if (to) to.count += n;
      else items.push({ name: from.name, count: n });
    },
    close: () => {}
  });
}

test('short of items, a build takes them from a chest it remembers first, then builds it all', async () => {
  setPauseScale(0);
  const items = [{ name: 'oak_planks', count: 1 }];
  const { bot, ctx, events } = builderBot({ items, start: new Vec3(1.5, 64, 2.5) });
  withChest(bot, items, [['oak_planks', 40], ['dirt', 300]], [{ name: 'oak_planks', count: 40 }]);
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 1, dy: 0, dz: 0, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'placed 2, skipped 0, failed 0. From the chests I remember, before building: took 1 oak_planks from chest at 5 64 5');
  assert.equal(events.filter((e) => e.placed).length, 2);
});

test('still short after the chests, a build puts in what the items cover and says how many of what are missing', async () => {
  setPauseScale(0);
  const { ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 1 }], start: new Vec3(1.5, 64, 2.5) });
  const blocks = [0, 1, 2].map((dx) => ({ dx, dy: 0, dz: 0, block: 'oak_planks' }));
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'placed 1, skipped 0, failed 0. Left out 2 blocks (2 oak_planks) for want of items, short of 2 oak_planks. obtain gets each of them in one call (from chests I know, by crafting, or by mining and chopping), then build_structure with the same plan, which skips what is already in place.');
  assert.deepEqual(events.filter((e) => e.placed).map((e) => e.placed.x), [1]);
});

test('with none of the items and a remembered chest that turns out empty, nothing is placed and it says what it tried', async () => {
  setPauseScale(0);
  const items = [];
  const { bot, ctx, events } = builderBot({ items, start: new Vec3(1.5, 64, 2.5) });
  withChest(bot, items, [['oak_planks', 40]], []);
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 1, dy: 0, dz: 0, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.equal(result.ok, false);
  assert.match(result.message, /^missing items: oak_planks \(need 2, have 0, 2 more\)\. Nothing was placed\. From the chests I remember: took nothing\. still missing: 2 oak_planks\. notes: chest at 5 64 5 no longer had oak_planks\. obtain gets each of them/);
  assert.equal(events.filter((e) => e.placed).length, 0);
});

// A wall of cobblestone 3 long and 2 high at z 0, with a chest in its top row.
function wallBot(items) {
  const built = builderBot({ items, start: new Vec3(1.5, 64, 2.5) });
  const { bot, ctx, world, solid } = built;
  for (let x = 0; x <= 2; x++) for (const y of [64, 65]) world.set(`${x},${y},0`, solid('cobblestone', new Vec3(x, y, 0)));
  world.set('1,65,0', solid('chest', new Vec3(1, 65, 0)));
  Object.assign(bot.registry.blocksByName, { cobblestone: {}, stone: {}, chest: {} });
  bot.registry.itemsByName.stone = { id: 7 };
  bot.entities = {};
  const progress = [];
  Object.assign(ctx, { status: { progress: (t) => progress.push(t) }, config: { ...ctx.config, protectedBlocks: ['chest'], limits: { ...ctx.config.limits, maxDigBlocks: 1000 } } });
  return { ...built, progress };
}

test('break_blocks swaps every block of a kind bottom up and leaves the rest of the box alone', async () => {
  setPauseScale(0);
  const { bot, ctx, events, progress } = wallBot([{ name: 'stone', count: 10 }]);
  const result = await breakBlocks(ctx, { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'cobblestone', replace_with: 'stone' });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'replaced 5 cobblestone with stone from 0 64 0 to 2 65 0. Picked up nothing, now at 1 64 2');
  for (let x = 0; x <= 2; x++) assert.equal(bot.blockAt(new Vec3(x, 64, 0)).name, 'stone');
  assert.equal(bot.blockAt(new Vec3(1, 65, 0)).name, 'chest');
  const ys = events.filter((e) => e.dug).map((e) => e.dug.y);
  assert.deepEqual(ys, [64, 64, 64, 65, 65]);
  assert.equal(progress.at(-1), 'replaced 5 of 5 cobblestone');
});

test('break_blocks steps off a floor block before replacing it, onto ground that stays', async () => {
  setPauseScale(0);
  const { bot, ctx, world, solid, events } = wallBot([{ name: 'stone', count: 10 }]);
  for (let x = 0; x <= 2; x++) world.set(`${x},63,0`, solid('cobblestone', new Vec3(x, 63, 0)));
  bot.entity.position = new Vec3(1.5, 64, 0.5);
  bot.pathfinder.goto = async (goal) => {
    const to = goal.pos ? goal.pos.offset(0, 1, 2) : new Vec3(goal.x, goal.y, goal.z);
    events.push({ walk: to });
    bot.entity.position = to.offset(0.5, 0, 0.5);
  };
  const dig = bot.dig;
  const underFeet = [];
  bot.dig = async (block) => {
    const f = bot.entity.position.floored();
    if (block.position.x === f.x && block.position.z === f.z && block.position.y < f.y) underFeet.push(block.position);
    return dig(block);
  };
  const result = await breakBlocks(ctx, { x1: 0, y1: 63, z1: 0, x2: 2, y2: 63, z2: 0, block: 'cobblestone', replace_with: 'stone' });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^replaced 3 cobblestone with stone from 0 63 0 to 2 63 0\./);
  assert.deepEqual(underFeet, []);
  for (let x = 0; x <= 2; x++) assert.equal(bot.blockAt(new Vec3(x, 63, 0)).name, 'stone');
  const step = events.find((e) => e.walk);
  assert.ok(step && bot.blockAt(step.walk.offset(0, -1, 0)).name === 'stone' && step.walk.z !== 0, `stepped to ${step?.walk}`);
});

test('break_block steps off the block she stands on before breaking it, and says so when there is nowhere to stand', async () => {
  setPauseScale(0);
  const { breakBlock } = await import('../src/actions/blocks.js');
  const { bot, ctx, world, solid } = wallBot([]);
  bot.entity.position = new Vec3(1.5, 66, 0.5);
  const walks = [];
  bot.pathfinder.goto = async (goal) => {
    const to = goal.pos ? goal.pos.offset(0, 1, 2) : new Vec3(goal.x, goal.y, goal.z);
    walks.push(to);
    bot.entity.position = to.offset(0.5, 0, 0.5);
  };
  const dig = bot.dig;
  let standing = null;
  bot.dig = async (block) => {
    standing = bot.entity.position.floored();
    return dig(block);
  };
  // On top of the wall, the middle block of its top row under her.
  world.set('1,65,0', solid('cobblestone', new Vec3(1, 65, 0)));
  const result = await breakBlock(ctx, { x: 1, y: 65, z: 0 });
  assert.equal(result.ok, true, result.message);
  assert.notDeepEqual([standing.x, standing.z], [1, 0]);
  assert.equal(walks.length, 1);

  // A pillar with nothing to stand on beside it.
  world.clear();
  world.set('1,199,0', solid('cobblestone', new Vec3(1, 199, 0)));
  bot.entity.position = new Vec3(1.5, 200, 0.5);
  standing = null;
  const stuck = await breakBlock(ctx, { x: 1, y: 199, z: 0 });
  setPauseScale(1);
  assert.equal(stuck.ok, false);
  assert.match(stuck.message, /^that's the block I'm standing on at 1 199 0/);
  assert.equal(standing, null);
});

test('a stop part-way through taking down scaffolding or break_blocks says it stopped', async () => {
  setPauseScale(0);
  const { takeDownScaffold } = await import('../src/actions/blocks.js');
  const { bot, ctx, world, solid } = wallBot([]);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  bot.stopDigging = () => {};
  const pillar = [66, 67, 68].map((y) => new Vec3(5, y, 0));
  for (const p of pillar) world.set(`${p.x},${p.y},${p.z}`, solid('dirt', p));
  const dig = bot.dig;
  bot.dig = async (block) => {
    await dig(block);
    controller.abort();
  };
  const scaffold = await takeDownScaffold(ctx, pillar);
  assert.deepEqual([scaffold.removed, scaffold.left, scaffold.stopped], [1, 2, true]);
  assert.equal(scaffold.text, 'stopped taking down my scaffolding after 1, 2 still up');

  const again = new AbortController();
  ctx.signal = again.signal;
  bot.dig = async (block) => {
    await dig(block);
    again.abort();
  };
  const result = await breakBlocks(ctx, { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'cobblestone' });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^broke 1 cobblestone .*not done before it stopped.*Stopped early: stopped$/);
});

test('break_blocks keeps the protections of break_block', async () => {
  setPauseScale(0);
  const { bot, ctx, events } = wallBot([]);
  const box = { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'chest' };
  const asked = await breakBlocks(ctx, box);
  assert.equal(asked.ok, false);
  assert.match(asked.message, /^broke 0 chest from 0 64 0 to 2 65 0\. Left 1: 1 at 1 65 0: protected block: chest\. Only break it if a player clearly asked/);
  const nobody = await breakBlocks(ctx, { ...box, confirmed: true });
  assert.match(nobody.message, /Nobody asked for this job/);
  const notAdmin = await breakBlocks({ ...ctx, requester: 'Alex', config: { ...ctx.config, admins: ['Steve'] } }, { ...box, confirmed: true });
  assert.match(notAdmin.message, /Only an admin can have you break someone's chest, and Alex isn't one/);
  assert.equal(events.filter((e) => e.dug).length, 0);
  // One the bot placed itself is fine.
  const own = await breakBlocks({ ...ctx, placed: { has: (p) => p.x === 1 && p.y === 65, add() {}, remove() {} } }, box);
  setPauseScale(1);
  assert.equal(own.ok, true, own.message);
  assert.equal(bot.blockAt(new Vec3(1, 65, 0)).name, 'air');
});

test('break_blocks only swaps as many as it carries blocks for, and answers ok when there are none to break', async () => {
  setPauseScale(0);
  const { bot, ctx } = wallBot([{ name: 'stone', count: 2 }]);
  const result = await breakBlocks(ctx, { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'cobblestone', replace_with: 'stone' });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^replaced 2 cobblestone with stone .*not replaced, I only carry 2 stone/);
  assert.equal(bot.blockAt(new Vec3(0, 65, 0)).name, 'cobblestone');
  const none = await breakBlocks(ctx, { x1: 0, y1: 70, z1: 0, x2: 2, y2: 70, z2: 0, block: 'cobblestone' });
  assert.deepEqual(none, { ok: true, message: 'no cobblestone in the box from 0 70 0 to 2 70 0' });
  const big = await breakBlocks(ctx, { x1: 0, y1: 0, z1: 0, x2: 20, y2: 20, z2: 20, block: 'cobblestone' });
  assert.match(big.message, /^box is 9261 blocks, the limit is 1000/);
  setPauseScale(1);
});

test('break_blocks breaks nothing when it carries none of the new block, and breaks top down without one', async () => {
  setPauseScale(0);
  const { ctx, events } = wallBot([]);
  const none = await breakBlocks(ctx, { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'cobblestone', replace_with: 'stone' });
  assert.equal(none.ok, false);
  assert.match(none.message, /^missing item: stone, 5 needed to replace 5 cobblestone\. Nothing was broken/);
  assert.equal(events.filter((e) => e.dug).length, 0);
  const broke = await breakBlocks(ctx, { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0, block: 'cobblestone', confirmed: true });
  setPauseScale(1);
  assert.equal(broke.ok, true, broke.message);
  assert.match(broke.message, /^broke 5 cobblestone from 0 64 0 to 2 65 0\. Picked up nothing/);
  assert.deepEqual(events.filter((e) => e.dug).map((e) => e.dug.y), [65, 65, 64, 64, 64]);
});

test('the items a plan covers are taken bottom first, a double slab counting two', () => {
  const placements = [{ block: 'oak_slab', uses: 2 }, { block: 'oak_slab', uses: 1 }, { block: 'oak_slab', uses: 2 }];
  const { covered, short } = withinStock(placements, new Map([['oak_slab', 3]]));
  assert.deepEqual([covered.length, short.length], [2, 1]);
  const plan = planBuild({
    origin: { x: 0, y: 64, z: 0 },
    blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_slab[type=double]' }, { dx: 1, dy: 0, dz: 0, block: 'oak_slab[type=double]' }],
    botPos: { x: 0, y: 64, z: 0 },
    getBlock: (x) => (x === 1 ? { name: 'oak_slab', getProperties: () => ({ type: 'bottom' }) } : { name: 'air' }),
    inventory: new Map(),
    maxBlocks: 10,
    isKnownBlock: () => true
  });
  assert.equal(plan.needed.get('oak_slab'), 3);
});

test('with no blocks to climb on, a build that could not get up says which chest has some', async () => {
  setPauseScale(0);
  const high = [0, 1, 2].map((i) => ({ x: 2 + i, y: 79, z: 0 }));
  const { bot, ctx } = builderBot({ items: [{ name: 'oak_planks', count: 64 }], canReach: (p) => p.y < 70, start: new Vec3(4.5, 64, 2.5), extra: high });
  bot.chestIndex = { list: () => [{ key: 'k', name: 'chest', parts: [{ x: 5, y: 64, z: 5 }], items: [['cobblestone', 300]] }] };
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'line', from: { dx: 2, dy: 16, dz: 0 }, to: { dx: 4, dy: 16, dz: 0 }, block: 'oak_planks' }] });
  setPauseScale(1);
  assert.match(result.message, /I have no blocks to scaffold with \(dirt, cobblestone and the like\), but I remember 300 cobblestone in the chest at 5 64 5: take_items some of that first/);
});

test('trim on two gable ends: one end is finished before the other, each block after the one it sits on', async () => {
  setPauseScale(0);
  // Two gable ends 14 apart with the bot halfway between, each a triangle of planks with trim on
  // its sloping edge.
  const blocks = [];
  for (const dx of [0, 14]) {
    for (let dz = 0; dz <= 8; dz++) {
      const h = Math.min(dz, 8 - dz);
      for (let dy = 0; dy <= h; dy++) blocks.push({ dx, dy, dz, block: 'oak_planks' });
      blocks.push({ dx, dy: h + 1, dz, block: 'oak_planks' });
    }
  }
  const { ctx, events } = builderBot({ items: [{ name: 'oak_planks', count: 100 }], start: new Vec3(7.5, 64, 4.5) });
  const result = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, blocks });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  const placed = events.filter((e) => e.placed).map((e) => e.placed);
  assert.equal(placed.length, blocks.length);
  const sides = placed.map((p) => p.x);
  assert.equal(sides.filter((x, i) => i > 0 && x !== sides[i - 1]).length, 1, sides.join(' '));
  for (const [i, p] of placed.entries()) {
    if (p.y > 64) assert.ok(placed.slice(0, i).some((q) => q.x === p.x && q.y === p.y - 1 && q.z === p.z), `${p} before the block under it`);
  }
});

test('build_house that places most of the house is done, and lists what is left with the reason', async () => {
  setPauseScale(0);
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) world.set(`${x},62,${z}`, solid('stone', new Vec3(x, 62, z)));
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    registry: { blocksByName: { cobblestone: {}, oak_planks: {} }, itemsByName: { cobblestone: { id: 4 }, oak_planks: { id: 5 } } },
    inventory: { items: () => [{ name: 'cobblestone', count: 200 }, { name: 'oak_planks', count: 50 }] },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
    equip: async (item) => { bot.heldItem = item; },
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      if (pos.x === 0 && pos.y === 67 && pos.z === 0) throw new Error(`Server refused to place cobblestone at ${pos}: the block is still air`);
      world.set(`${pos.x},${pos.y},${pos.z}`, solid(bot.heldItem.name, pos));
    },
    pathfinder: { goto: async () => {}, setGoal() {}, isMining: () => false, isBuilding: () => false, bestHarvestTool: () => null }
  });
  bot.world = { getBlock: (p) => bot.blockAt(p) };
  const ctx = { bot, config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 90 } } };
  const result = await buildHouse(ctx, { x: 0, y: 64, z: 0, width: 5, depth: 5, roof: 'flat', materials: { walls: 'cobblestone', floor: 'oak_planks', roof: 'cobblestone', door: 'none', windows: 'none' } });
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /Placed 95 of 96 blocks\. Left to do, 1 blocks in 1 group: 1 block around 0 67 0 \(1 cobblestone, at 0 67 0\): could not place at 0 67 0: Server refused to place cobblestone at \(0, 67, 0\): the block is still air \(tried 3 faces\)\. build_house with the same settings again/);
});

test('build_house stopped while taking down its scaffolding says so', async () => {
  setPauseScale(0);
  const world = new Map();
  const solid = (name, pos) => ({ name, position: pos, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) world.set(`${x},62,${z}`, solid('stone', new Vec3(x, 62, z)));
  const args = { x: 0, y: 64, z: 0, width: 5, depth: 5, roof: 'flat', materials: { walls: 'cobblestone', floor: 'oak_planks', roof: 'cobblestone', door: 'none', windows: 'none' } };
  const plan = planHouse(args);
  const step = new Vec3(plan.min.x - 1, 64, plan.min.z - 1);
  const controller = new AbortController();
  let placed = 0;
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    registry: { blocksByName: { cobblestone: {}, oak_planks: {} }, itemsByName: { cobblestone: { id: 4 }, oak_planks: { id: 5 } } },
    inventory: { items: () => [{ name: 'cobblestone', count: 200 }, { name: 'oak_planks', count: 50 }] },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
    equip: async (item) => { bot.heldItem = item; },
    placeBlock: async (ref, face) => {
      const pos = ref.position.plus(face);
      world.set(`${pos.x},${pos.y},${pos.z}`, solid(bot.heldItem.name, pos));
      if (++placed !== 10) return;
      // The pathfinder steps up on a dirt block beside the house, then the build is stopped.
      markPathfinderPlace(bot, step);
      world.set(`${step.x},${step.y},${step.z}`, solid('dirt', step));
      bot.emit('blockUpdate', { boundingBox: 'empty' }, { name: 'dirt', position: step, boundingBox: 'block' });
      controller.abort();
    },
    pathfinder: { goto: async () => {}, setGoal() {}, isMining: () => false, isBuilding: () => false, bestHarvestTool: () => null }
  });
  bot.world = { getBlock: (p) => bot.blockAt(p) };
  const ctx = { bot, signal: controller.signal, config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 90 } } };
  const result = await buildHouse(ctx, args);
  setPauseScale(1);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /Stopped early: stopped taking down my scaffolding after 0, 1 still up/);
  assert.equal(world.get(`${step.x},${step.y},${step.z}`).name, 'dirt');
});
