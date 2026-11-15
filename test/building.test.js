import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { parseBlock, blockText, stateProblem, matchesState, placementOptions, itemFor } from '../src/actions/states.js';
import { EventEmitter } from 'node:events';
import { expandParts, planBuild, nearestFirst, buildSite, buildStructure, watchBuildScaffold } from '../src/actions/build.js';
import { setPauseScale } from '../src/actions/util.js';
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
  let building = false;
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
        building = true;
        bot.emit('blockUpdate', old, world.get('3,64,1'));
        building = false;
      }
    },
    canDigBlock: () => true,
    dig: async (block) => world.delete(`${block.position.x},${block.position.y},${block.position.z}`),
    pathfinder: { bestHarvestTool: () => null, isBuilding: () => building }
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
  let building = false;
  let placings = 0;
  const put = (name, x, y, z, byBot) => {
    const s = new Vec3(x, y, z);
    const old = bot.blockAt(s);
    world.set(`${x},${y},${z}`, solid(name, s));
    building = byBot;
    bot.emit('blockUpdate', old, world.get(`${x},${y},${z}`));
    building = false;
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
    pathfinder: { bestHarvestTool: () => null, isBuilding: () => building }
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
  let building = false;
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(3.5, 64, 3.5) },
    registry: { itemsByName: { cobblestone: { id: 4 }, oak_planks: { id: 5 }, dirt: { id: 3 } } },
    buildKeep: new Set([4, 5]),
    blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) ?? 'air', position: p, getProperties: () => ({}) }),
    pathfinder: { isBuilding: () => building }
  });
  const scaffold = watchBuildScaffold(bot, plan, planned);
  const put = (name, x, y, z, byBot) => {
    bot.entity.position = new Vec3(x + 1.5, y + 1, z + 0.5);
    world.set(`${x},${y},${z}`, name);
    building = byBot;
    bot.emit('blockUpdate', { boundingBox: 'empty' }, { name, position: new Vec3(x, y, z) });
    building = false;
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
