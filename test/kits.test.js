import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { KITS, KIT_KINDS, kitLines, kitShape, expandKit, kitSize, planToKit } from '../src/actions/kits.js';
import { material, turnState, PlanError } from '../src/actions/shapes.js';
import { parseBlock, blockText, stateProblem, itemFor } from '../src/actions/states.js';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { buildStructure, expandParts, expandPlan } from '../src/actions/build.js';
import { previewStructure } from '../src/actions/preview.js';
import { setPauseScale } from '../src/actions/util.js';

// Real 26.1 blocks and items, loaded the way mineflayer loads them.
const requireMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = requireMf('prismarine-registry')('26.1');

const O = (dx, dy, dz) => ({ dx, dy, dz });
const K = (kind, from, to, block, extra = {}) => ({ kind, from: O(...from), to: O(...to), block, ...extra });

// Parts for each kit as if it faced south (its front toward +z), for every variant.
const SAMPLES = {
  window: () => [K('window', [0, 2, 0], [2, 4, 0], 'spruce_planks', { fill: 'stripped_spruce_log' }), K('window', [0, 2, 0], [1, 3, 0], 'spruce_planks', { extra: true })],
  bay_window: () => [K('bay_window', [0, 2, 0], [2, 4, 0], 'spruce_planks', { fill: 'dark_oak_planks' })],
  dormer: () => [K('dormer', [0, 6, 0], [0, 7, 0], 'spruce_planks', { fill: 'dark_oak_planks' }), K('dormer', [0, 6, 0], [2, 6, 0], 'spruce_planks', { pitch: 2 })],
  door: () => [K('door', [0, 1, 0], [0, 2, 0], 'oak_planks', { fill: 'stripped_oak_log' }), K('door', [0, 1, 0], [1, 3, 0], 'spruce_planks', { fill: 'stone_bricks', extra: true })],
  porch: () => [K('porch', [0, 0, 0], [4, 3, 2], 'spruce_planks', { fill: 'stripped_spruce_log', extra: true }), K('porch', [0, 0, 0], [5, 4, 3], 'oak_planks')],
  archway: () => [K('archway', [0, 1, 0], [3, 4, 1], 'stone_bricks', { fill: 'chiseled_stone_bricks' }), K('archway', [0, 1, 0], [4, 6, 0], 'cobblestone')],
  chimney: () => [K('chimney', [0, 0, 0], [1, 8, 0], 'bricks', { fill: 'stone_bricks', extra: true }), K('chimney', [0, 5, 0], [0, 9, 0], 'cobblestone')],
  battlements: (v) => (v === 3 ? [K('battlements', [0, 6, 0], [6, 6, 6], 'stone_bricks'), K('battlements', [0, 6, 0], [8, 6, 6], 'stone_bricks')] : [K('battlements', [0, 4, 0], [8, 4, 0], 'stone_bricks'), K('battlements', [0, 6, 0], [6, 6, 4], 'stone_bricks', { extra: true }), K('battlements', [0, 4, 0], [5, 4, 0], 'stone_bricks', { extra: true })]),
  buttress: () => [K('buttress', [0, 0, 0], [1, 9, 0], 'stone_bricks', { fill: 'cobblestone' }), K('buttress', [0, 0, 0], [0, 4, 0], 'stone_bricks', { width: 1 })],
  balcony: (v) => [K('balcony', [0, 4, 0], [3, 4, 1], 'spruce_planks', { fill: 'dark_oak_planks', extra: true }), K('balcony', [0, 4, 0], [2, 4, 0], v === 2 ? 'oak_planks' : 'stone_bricks')],
  eave_brackets: () => [K('eave_brackets', [0, 3, 0], [8, 3, 0], 'spruce_planks', { fill: 'stripped_spruce_log' })],
  awning: (v) => [K('awning', [0, 1, 0], [2, 2, 0], v === 1 ? 'red_wool' : 'spruce_planks', { fill: 'white_wool' }), K('awning', [0, 1, 0], [1, 2, 0], v === 1 ? 'blue_wool' : 'oak_planks', { width: 3 })],
  facade: () => [K('facade', [0, 0, 0], [8, 4, 0], 'stone_bricks', { fill: 'spruce_planks', width: 1 }), K('facade', [0, 0, 0], [4, 3, 0], 'cobblestone', { every: 3 })],
  path: () => [K('path', [0, 0, 0], [9, 0, 4], 'gravel', { fill: 'stone_bricks' }), K('path', [0, 0, 0], [0, 0, 8], 'cobblestone', { width: 2 })],
  lamp_post: () => [K('lamp_post', [0, 0, 0], [0, 0, 0], 'spruce_planks', { fill: 'stone_bricks' }), K('lamp_post', [0, 0, 0], [0, 4, 0], 'stone_bricks', { extra: true })],
  fence_run: () => [K('fence_run', [0, 0, 0], [10, 0, 0], 'spruce_planks', { fill: 'stripped_spruce_log', width: 1, extra: true }), K('fence_run', [0, 0, 0], [6, 0, 4], 'oak_planks', { fill: 'oak_log', width: 2 }), K('fence_run', [0, 0, 0], [0, 0, 6], 'cobblestone')],
  planter: (v) => [K('planter', [0, 0, 0], [4, 0, 3], 'spruce_planks'), K('planter', [0, 0, 0], [3, 0, 3], v === 1 ? 'oak_planks' : 'stone_bricks', { fill: 'poppy' })],
  well: () => [K('well', [0, 0, 0], [2, 5, 2], 'cobblestone', { fill: 'spruce_planks' }), K('well', [0, 0, 0], [4, 6, 4], 'stone_bricks')],
  bench: () => [K('bench', [0, 0, 0], [2, 0, 0], 'spruce_planks'), K('bench', [0, 0, 0], [0, 0, 0], 'oak_planks', { fill: 'birch_planks' })],
  market_stall: () => [K('market_stall', [0, 0, 0], [4, 2, 2], 'spruce_planks'), K('market_stall', [0, 0, 0], [3, 3, 3], 'oak_planks', { fill: 'blue_wool,white_wool,yellow_wool' })],
  tree: () => [K('tree', [0, 0, 0], [6, 7, 6], 'oak_log'), K('tree', [0, 0, 0], [4, 9, 3], 'spruce_log', { fill: 'azalea_leaves' })],
  fireplace: () => [K('fireplace', [0, 0, 0], [4, 3, 1], 'bricks', { fill: 'stone_bricks' }), K('fireplace', [0, 0, 0], [2, 2, 0], 'stone_bricks')],
  table_and_chairs: () => [K('table_and_chairs', [0, 0, 0], [2, 0, 1], 'spruce_planks', { fill: 'dark_oak_planks', extra: true }), K('table_and_chairs', [0, 0, 0], [0, 0, 1], 'oak_planks')],
  bed_nook: () => [K('bed_nook', [0, 0, 0], [3, 2, 1], 'spruce_planks', { fill: 'blue_wool' }), K('bed_nook', [0, 0, 0], [4, 0, 1], 'oak_planks', { fill: 'red_bed' })],
  storage_wall: () => [K('storage_wall', [0, 0, 0], [4, 2, 0], 'spruce_planks'), K('storage_wall', [0, 0, 0], [2, 1, 0], 'oak_planks')],
  kitchen: () => [K('kitchen', [0, 0, 0], [6, 3, 0], 'spruce_planks', { fill: 'bricks' }), K('kitchen', [0, 0, 0], [2, 2, 0], 'oak_planks')],
  bookshelf_wall: () => [K('bookshelf_wall', [0, 0, 0], [6, 3, 0], 'spruce_planks', { fill: 'stripped_spruce_log' }), K('bookshelf_wall', [0, 0, 0], [1, 1, 0], 'oak_planks')],
  rug: () => [K('rug', [0, 0, 0], [4, 0, 3], 'red_wool', { fill: 'yellow_carpet' }), K('rug', [0, 0, 0], [1, 0, 5], 'moss_block')],
  ceiling_light: (v) => (v === 1 ? [K('ceiling_light', [0, 0, 0], [0, 3, 0], 'spruce_planks'), K('ceiling_light', [0, 3, 0], [0, 3, 0], 'oak_planks', { fill: 'soul_lantern' })] : [K('ceiling_light', [0, 0, 0], [2, 3, 2], 'spruce_planks')])
};

// A quarter turn clockwise seen from above, about the plan's origin.
const turnSpot = (dx, dz) => [-dz, dx];
const NEXT = { south: 'west', west: 'north', north: 'east', east: 'south' };
function turnPart(part) {
  const t = (o) => {
    const [dx, dz] = turnSpot(o.dx, o.dz);
    return O(dx, o.dy, dz);
  };
  return { ...part, from: t(part.from), to: t(part.to), facing: NEXT[part.facing ?? 'south'] };
}
function turnBlocks(blocks) {
  return blocks.map((b) => {
    const [dx, dz] = turnSpot(b.dx, b.dz);
    const { name, props } = parseBlock(b.block);
    return { dx, dy: b.dy, dz, block: blockText(name, turnState(props, 1)) };
  });
}
const keyed = (blocks) => new Map(blocks.map((b) => [`${b.dx},${b.dy},${b.dz}`, b.block]));

// Every sample in every variant and facing.
function* everyCase() {
  for (const kit of KITS) {
    for (let variant = 1; variant <= kit.variants.length; variant++) {
      for (const sample of SAMPLES[kit.kind](variant)) {
        let part = { ...sample, variant };
        for (const facing of ['south', 'west', 'north', 'east']) {
          yield { kit, variant, facing, part };
          part = turnPart(part);
        }
      }
    }
  }
}

// Other forms of the same block family a plan might name instead.
const KIN = {
  spruce_planks: ['spruce_stairs', 'spruce_slab', 'spruce_fence', 'spruce_trapdoor', 'spruce_door', 'spruce_fence_gate'],
  oak_planks: ['oak_stairs', 'oak_slab', 'oak_fence', 'oak_trapdoor', 'oak_door', 'oak_pressure_plate'],
  dark_oak_planks: ['dark_oak_stairs', 'dark_oak_trapdoor', 'dark_oak_door'],
  birch_planks: ['birch_slab', 'birch_fence'],
  stone_bricks: ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall'],
  cobblestone: ['cobblestone_stairs', 'cobblestone_slab', 'cobblestone_wall'],
  bricks: ['brick_stairs', 'brick_slab', 'brick_wall']
};

test('a material given as another form of its family builds the same as the block itself', () => {
  let count = 0;
  for (const { kit, variant, facing, part } of everyCase()) {
    if (facing !== 'south') continue;
    const base = expandKit(part);
    for (const field of ['block', 'fill']) {
      for (const kin of KIN[part[field]] ?? []) {
        const label = `${kit.kind} variant ${variant}, ${field} ${kin}`;
        let blocks;
        assert.doesNotThrow(() => { blocks = expandKit({ ...part, [field]: kin }); }, label);
        assert.deepEqual(keyed(blocks), keyed(base), label);
        count++;
      }
    }
  }
  assert.ok(count > 200);
  // A material that truly has no such form is still a plain error.
  assert.throws(() => expandKit(K('bench', [0, 0, 0], [2, 0, 0], 'stone_bricks')), /kit bench needs the trapdoor of block \("stone_bricks", which is stone_bricks\)/);
});

test('every kit has samples, a line and variants, and the kinds are unique', () => {
  assert.equal(new Set(KIT_KINDS).size, KIT_KINDS.length);
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...KIT_KINDS].sort());
  const lines = kitLines();
  assert.equal(lines.length, KITS.length);
  for (const k of KITS) {
    assert.ok(k.variants.length >= 1 && k.variants.length <= 3, k.kind);
    assert.ok(k.line.length > 20, k.kind);
  }
});

test('every kit and variant expands for each facing, into real blocks with items and valid states', () => {
  let count = 0;
  for (const { kit, variant, facing, part } of everyCase()) {
    const label = `${kit.kind} variant ${variant} facing ${facing}`;
    const blocks = expandKit(part);
    assert.ok(blocks.length > 0, `${label}: no blocks`);
    for (const b of blocks) {
      const { name, props } = parseBlock(b.block);
      assert.ok(registry.blocksByName[name], `${label}: ${name} is not a block`);
      assert.ok(registry.itemsByName[itemFor(name, registry)], `${label}: no item places ${name}`);
      assert.equal(stateProblem(registry, name, props), null, `${label}: ${b.block}`);
      assert.ok(!/_door$/.test(name) || !props.half, `${label}: a door is placed by its lower half only`);
      assert.ok(!/_bed$/.test(name) || !props.part, `${label}: a bed is placed by its foot only`);
    }
    count++;
  }
  assert.ok(count > 200);
});

test('a kit turned to another facing is the turned image of itself', () => {
  for (const { kit, variant, facing, part } of everyCase()) {
    if (facing === 'east') continue;
    const turned = turnPart(part);
    const want = keyed(turnBlocks(expandKit(part, { keepAir: true })));
    const got = keyed(expandKit(turned, { keepAir: true }));
    assert.deepEqual(got, want, `${kit.kind} variant ${variant} from ${facing} to ${turned.facing}`);
  }
});

test('kits stay inside their box plus the reach each one states', () => {
  for (const { kit, variant, facing, part } of everyCase()) {
    const size = kitSize(part);
    const r = kit.reach({ ...size, variant, extra: part.extra === true, part });
    const b = {
      x0: Math.min(part.from.dx, part.to.dx), x1: Math.max(part.from.dx, part.to.dx),
      z0: Math.min(part.from.dz, part.to.dz), z1: Math.max(part.from.dz, part.to.dz)
    };
    for (const c of expandKit(part, { keepAir: true })) {
      const [u, w] = planToKit(b, part.facing ?? 'south', c.dx, c.dz);
      const where = `${kit.kind} variant ${variant} facing ${facing}: ${c.block} at ${c.dx} ${c.dy} ${c.dz} (u ${u}, w ${w})`;
      assert.ok(u >= -r.left && u <= size.W - 1 + r.right, `${where} is past its sides`);
      assert.ok(w >= -r.back && w <= size.D - 1 + r.out, `${where} is past its front or back`);
      assert.ok(c.dy >= size.y0 - r.down && c.dy <= size.y1 + r.up, `${where} is past its top or bottom`);
    }
  }
});

test('a window has its glass in the box and its sill, shutters and hood outside the wall', () => {
  const at = (blocks) => keyed(blocks);
  const plain = at(expandKit(K('window', [0, 2, 0], [1, 3, 0], 'spruce_planks', { fill: 'stripped_spruce_log' })));
  assert.equal(plain.get('0,2,0'), 'glass_pane');
  // Sill and head sit in the wall itself.
  assert.equal(plain.get('0,1,0'), 'spruce_stairs[facing=north,half=bottom]');
  assert.equal(plain.get('0,4,0'), 'spruce_stairs[facing=north,half=top]');
  assert.equal(plain.get('0,1,1'), undefined);
  const pair = at(expandKit(K('window', [0, 2, 0], [2, 3, 0], 'spruce_planks', { every: 2 })));
  assert.deepEqual([0, 1, 2].map((dx) => pair.get(`${dx},2,0`)), ['glass_pane', undefined, 'glass_pane']);
  const shut = at(expandKit(K('window', [0, 2, 0], [1, 3, 0], 'spruce_planks', { variant: 2, facing: 'east' })));
  // Facing east the front is +x: shutters stand one out, beside the window along z.
  const shutters = [...shut].filter(([, b]) => b.startsWith('spruce_trapdoor') && b.includes('open=true'));
  assert.ok(shutters.length === 4 && shutters.every(([, b]) => b === 'spruce_trapdoor[facing=east,open=true,half=bottom]'));
});

test('a door is its lower half, with the spot over it cleared, and a double door is two doors', () => {
  const blocks = expandKit(K('door', [0, 1, 0], [1, 2, 0], 'oak_planks', { facing: 'north' }), { keepAir: true });
  const m = keyed(blocks);
  assert.equal(m.get('0,1,0'), 'oak_door[facing=north]');
  assert.equal(m.get('1,1,0'), 'oak_door[facing=north]');
  assert.equal(m.get('0,2,0'), 'air');
  assert.ok(!blocks.some((b) => b.block.includes('stairs')), 'no step without extra');
});

test('role materials and their forms resolve, and a palette light is used when it is a lantern', () => {
  const palette = { trim: 'spruce_planks', frame: 'stripped_spruce_log', glass: 'white_stained_glass_pane', wall: '70%stone_bricks,30%cracked_stone_bricks', light: 'soul_lantern' };
  const win = expandKit(K('window', [0, 2, 0], [1, 3, 0], '@trim', { fill: '@frame', variant: 3 }), { palette }).map((b) => b.block);
  assert.ok(win.includes('white_stained_glass_pane'));
  assert.ok(win.includes('spruce_stairs[facing=north,half=top]'));
  assert.ok(win.includes('stripped_spruce_log[axis=x]'));
  // A mix gives the forms of the blocks that have them.
  const arch = expandKit(K('archway', [0, 0, 0], [2, 3, 0], '@wall'), { palette }).map((b) => parseBlock(b.block).name);
  assert.ok(arch.includes('stone_brick_stairs'));
  // The door's frame falls back on @frame.
  const door = expandKit(K('door', [0, 1, 0], [0, 2, 0], 'spruce_planks'), { palette }).map((b) => b.block);
  assert.ok(door.includes('stripped_spruce_log[axis=y]'));
  const lamp = expandKit(K('lamp_post', [0, 0, 0], [0, 0, 0], 'spruce_planks'), { palette }).map((b) => b.block);
  assert.ok(lamp.includes('soul_lantern[hanging=true]'));
});

test('a missing form is a plain error naming the kit and the field', () => {
  assert.throws(() => expandKit(K('window', [0, 2, 0], [1, 3, 0], 'glass')), (err) => err instanceof PlanError && /kit window needs the stairs of block \("glass", which is glass\)/.test(err.message));
  assert.throws(() => expandKit(K('bench', [0, 0, 0], [2, 0, 0], '@accent'), { palette: { accent: 'white_wool' } }), (err) => err instanceof PlanError && /kit bench needs the stairs of block \("@accent", which is white_wool\)/.test(err.message));
  // Through the shape maker's own call, the message starts with the part.
  const ctx = { palette: {} };
  const part = { shape: 'kit', ...K('porch', [0, 0, 0], [4, 3, 2], 'glass') };
  const mat = (field) => material(part[field], ctx, `part 3 (kit), ${field}`);
  assert.throws(() => kitShape(part, () => {}, mat, ctx, 'part 3 (kit)'), (err) => err instanceof PlanError && /^part 3 \(kit\): kit porch needs the fence of block/.test(err.message));
});

test('a wrong kind, variant or size is a plain error', () => {
  assert.throws(() => expandKit(K('gazebo', [0, 0, 0], [2, 2, 2], 'oak_planks')), /kind is gazebo, a kit is one of window, bay_window/);
  assert.throws(() => expandKit(K('rug', [0, 0, 0], [3, 0, 3], 'red_wool', { variant: 4 })), /kit rug has variants 1 to 3/);
  assert.throws(() => expandKit(K('fireplace', [0, 0, 0], [1, 2, 0], 'bricks')), /kit fireplace needs a front at least 3 wide/);
  assert.throws(() => expandKit(K('window', [0, 0, 0], [1, 1, 0], 'oak_planks', { facing: 'up' })), /facing is up/);
  assert.throws(() => expandKit(K('archway', [0, 0, 0], [2, 4, 0], 'stone_bricks', { variant: 2 })), /pointed\) needs an opening at least 4 wide/);
  assert.throws(() => expandKit(K('dormer', [0, 6, 0], [0, 7, 0], 'spruce_planks', { pitch: 0.5 })), /a dormer goes on a roof of pitch 1 or 2 only/);
  assert.throws(() => expandKit(K('chimney', [0, 0, 0], [0, 6, 0], 'bricks', { width: 4 })), /width 1 to 3 across/);
});

test('cloth is carpet on a thin support, a winding path keeps its width, and a roof chimney stays in its stack', () => {
  const awning = expandKit(K('awning', [0, 1, 0], [2, 2, 0], 'red_wool', { width: 3 }));
  assert.equal(awning.filter((b) => b.block === 'red_wool' || b.block === 'white_wool').length, 5);
  assert.ok(awning.filter((b) => b.dy === 4).every((b) => b.block.endsWith('_carpet')));
  // A stall stays low however tall its box: 3 by 3 is 4 high in all, banners round the canopy.
  const stall = expandKit(K('market_stall', [0, 0, 0], [2, 9, 2], 'spruce_planks'));
  assert.equal(Math.max(...stall.map((b) => b.dy)), 3);
  assert.ok(stall.filter((b) => b.block.endsWith('_wool')).every((b) => b.dy === 3));
  assert.equal(stall.filter((b) => b.block.includes('_wall_banner')).length, 12);
  const path = expandKit(K('path', [0, 0, 0], [30, 0, 0], 'dirt_path', { width: 3 }));
  const ground = path.filter((b) => b.dy === 0);
  const across = new Map();
  for (const b of ground) across.set(b.dx, (across.get(b.dx) ?? 0) + 1);
  // A ragged edge: 3 to 5 wide, and not the same width all along.
  assert.ok([...across.values()].every((n) => n >= 3 && n <= 5));
  assert.ok(new Set(across.values()).size > 1);
  assert.ok(ground.filter((b) => b.block === 'dirt_path').length > ground.length * 0.7);
  // Stones and bushes stand along its edges.
  assert.ok(path.filter((b) => b.dy === 1).length >= 5);
  const chimney = expandKit(K('chimney', [0, 5, 0], [1, 9, 1], 'bricks', { variant: 2 }));
  assert.ok(chimney.every((b) => b.dx >= 0 && b.dx <= 1 && b.dz >= 0 && b.dz <= 1));
  // A one-block box still makes a stack 2 across unless width says 1.
  const stackAt = (part) => new Set(expandKit(part).filter((b) => b.dy === 5).map((b) => b.dx));
  assert.deepEqual([...stackAt(K('chimney', [0, 0, 0], [0, 8, 0], 'bricks'))].sort(), [0, 1]);
  assert.deepEqual([...stackAt(K('chimney', [0, 0, 0], [0, 8, 0], 'bricks', { width: 1 }))], [0]);
  assert.deepEqual([...stackAt(K('chimney', [0, 0, 0], [0, 8, 0], 'bricks', { width: 3 }))].sort(), [0, 1, 2]);
  // A deck or floor given as a log is laid in its planks.
  const porch = expandKit(K('porch', [0, 0, 0], [4, 3, 2], 'oak_log'));
  assert.ok(porch.filter((b) => b.dy === 0 && b.dz === 0).every((b) => b.block === 'oak_planks'));
  // The door kit takes the door itself, a log or a stair of its wood.
  for (const block of ['oak_door', 'oak_log', 'stripped_oak_log', 'oak_stairs']) {
    assert.ok(expandKit(K('door', [0, 1, 0], [0, 2, 0], block)).some((b) => b.block === 'oak_door[facing=south]'), block);
  }
});

test('blocks this game lacks are left out rather than named', () => {
  const known = (name) => Boolean(registry.blocksByName[name]) && name !== 'campfire';
  const blocks = expandKit(K('chimney', [0, 0, 0], [0, 6, 0], 'bricks', { extra: true }), { isKnownBlock: known }).map((b) => b.block);
  assert.ok(!blocks.some((b) => b.startsWith('campfire')));
  assert.ok(expandKit(K('chimney', [0, 0, 0], [0, 6, 0], 'bricks', { extra: true })).some((b) => b.block.startsWith('campfire')));
});

// A bot among the real 26.1 blocks on flat stone at y 63 that places whatever it holds where it
// clicks, and walks by jumping there.
function kitBot(items) {
  const world = new Map();
  const make = (name, pos) => ({ name, position: pos, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  for (let x = -6; x <= 12; x++) for (let z = -6; z <= 12; z++) world.set(`${x},63,${z}`, make('stone', new Vec3(x, 63, z)));
  const placed = [];
  const put = (ref, face) => {
    const pos = ref.position.plus(face);
    world.set(`${pos.x},${pos.y},${pos.z}`, make(bot.heldItem.name, pos));
    placed.push(bot.heldItem.name);
  };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(3.5, 64, 9.5), height: 1.62 },
    entities: {},
    registry,
    inventory: { items: () => items },
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? make('air', p),
    equip: async (item) => { bot.heldItem = item; },
    look: async () => {},
    placeBlock: async (ref, face) => put(ref, face),
    _placeBlockWithOptions: async (ref, face) => put(ref, face),
    dig: async (block) => { world.delete(`${block.position.x},${block.position.y},${block.position.z}`); },
    canDigBlock: () => true,
    pathfinder: {
      goto: async (goal) => { bot.entity.position = new Vec3(goal.pos.x + 0.5, 64, goal.pos.z + 2.5); },
      setGoal: () => {},
      isMining: () => false,
      isBuilding: () => false,
      bestHarvestTool: () => null
    }
  });
  bot.world = { getBlock: (p) => bot.blockAt(p), raycast: () => null };
  return { ctx: { bot, config: { limits: { maxBuildBlocks: 500, moveTimeoutSeconds: 90 } } }, placed };
}

const P = (kind, from, to, block, extra = {}) => ({ shape: 'kit', ...K(kind, from, to, block, extra) });
const origin = { x: 0, y: 64, z: 0 };

test('kits go through build_structure: the dry run counts a door, a bed and chests as items, and a kit gets built', async () => {
  const plan = {
    origin,
    parts: [
      { shape: 'fill', from: O(0, 0, 0), to: O(6, 3, 0), block: 'spruce_planks' },
      P('door', [1, 0, 0], [1, 1, 0], 'oak_planks', { fill: 'stripped_oak_log' }),
      P('bed_nook', [3, 0, -2], [5, 0, -1], 'spruce_planks', { fill: 'red_bed' }),
      P('storage_wall', [0, 0, -3], [2, 1, -3], 'spruce_planks', { facing: 'north' })
    ]
  };
  const dry = await buildStructure(kitBot([]).ctx, { ...plan, dry_run: true });
  assert.equal(dry.ok, true, dry.message);
  const needs = /Needs (.*?)\. /.exec(dry.message)[1];
  assert.match(needs, /(^|, )1 oak_door(,|$)/);
  assert.match(needs, /(^|, )1 red_bed(,|$)/);
  assert.match(needs, /(^|, )1 chest(,|$)/);
  assert.match(needs, /(^|, )2 torch(,|$)/);
  assert.doesNotMatch(needs, /wall_torch/);

  const { ctx, placed } = kitBot(['spruce_fence', 'stone_bricks', 'stone_brick_wall', 'lantern', 'spruce_trapdoor', 'iron_chain'].map((name) => ({ name, count: 16 })));
  setPauseScale(0);
  const built = await buildStructure(ctx, { origin, parts: [P('lamp_post', [2, 0, 2], [2, 3, 2], 'spruce_planks', { variant: 2, fill: 'stone_bricks', mirror: { x: 6 } })] });
  setPauseScale(1);
  assert.equal(built.ok, true, built.message);
  const want = expandParts([P('lamp_post', [2, 0, 2], [2, 3, 2], 'spruce_planks', { variant: 2, fill: 'stone_bricks', mirror: { x: 6 } })]);
  assert.match(built.message, new RegExp(`^placed ${want.length}, skipped 0, failed 0`));
  assert.deepEqual(placed.sort(), want.map((b) => parseBlock(b.block).name).sort());
});

test('a plan with kits previews like any other plan', async () => {
  const drawn = [];
  const bot = { registry, entity: { position: new Vec3(500.5, 64, 500.5) }, inventory: { items: () => [] }, blockAt: () => null };
  const ctx = { bot, config: { limits: { maxBuildBlocks: 500 } }, renderViews: async (blocks, opts) => { drawn.push(blocks); return opts.views.map((view) => ({ view, png: Buffer.from('png'), width: 1, height: 1, unknown: [] })); } };
  const plan = { origin, palette: { trim: 'spruce_planks' }, mirror: { x: 8 }, parts: [{ shape: 'fill', from: O(0, 0, 0), to: O(4, 3, 0), block: 'white_terracotta' }, P('window', [1, 1, 0], [2, 2, 0], '@trim', { variant: 2, repeat: { count: 2, dx: 0 } })] };
  const result = await previewStructure(ctx, plan);
  assert.equal(result.ok, true, result.message);
  const expected = expandPlan(bot, plan);
  assert.ok(expected.some((b) => b.dx === 8 && b.block.startsWith('spruce_trapdoor')));
  assert.equal(drawn[0].filter((b) => b.y >= 64).length, expected.length);
});