import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { parseBlock, blockText, stateProblem, matchesState, placementOptions, itemFor } from '../src/actions/states.js';
import { expandParts, planBuild } from '../src/actions/build.js';
import { planHouse, buildHouse } from '../src/actions/house.js';
import { placeOne } from '../src/actions/blocks.js';

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
