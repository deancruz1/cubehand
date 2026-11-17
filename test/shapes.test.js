import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { expandParts, expandPlan, buildStructure, turnState } from '../src/actions/build.js';
import { formName, material, mirrorState, partCopies, PlanError } from '../src/actions/shapes.js';
import { parseBlock } from '../src/actions/states.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const P = (shape, from, to, block, extra = {}) => ({ shape, from: { dx: from[0], dy: from[1], dz: from[2] }, to: { dx: to[0], dy: to[1], dz: to[2] }, block, ...extra });

// Stairs as arrows the way they climb (upside down in capitals), slabs as _, logs by their axis,
// air as a space never shown, anything else by the legend or #.
const ARROWS = { north: '^', south: 'v', east: '>', west: '<' };
const TOPS = { north: 'A', south: 'V', east: ')', west: '(' };
function charOf(text, legend) {
  const { name, props } = parseBlock(text);
  if (legend[name]) return legend[name];
  if (name.endsWith('_stairs')) return (props.half === 'top' ? TOPS : ARROWS)[props.facing] ?? 's';
  if (name.endsWith('_slab')) return '_';
  if (/_log$/.test(name)) return { x: '-', z: '|' }[props.axis] ?? 'o';
  return '#';
}

// One layer of blocks as rows of text, north at the top, west on the left. plane 'xz' is a layer
// at y = at, 'xy' a slice at z = at seen from the south (top row highest).
function picture(blocks, at, { plane = 'xz', legend = {}, box } = {}) {
  const inPlane = blocks.filter((b) => (plane === 'xz' ? b.dy : b.dz) === at);
  const all = box ?? blocks;
  const us = all.map((b) => b.dx);
  const vs = all.map((b) => (plane === 'xz' ? b.dz : b.dy));
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const at2 = new Map(inPlane.map((b) => [`${b.dx},${plane === 'xz' ? b.dz : b.dy}`, b.block]));
  const rows = [];
  for (let v = v0; v <= v1; v++) {
    let row = '';
    for (let u = u0; u <= u1; u++) row += at2.has(`${u},${v}`) ? charOf(at2.get(`${u},${v}`), legend) : '.';
    rows.push(row);
  }
  return plane === 'xy' ? rows.reverse() : rows;
}

const blockAt = (blocks, x, y, z) => blocks.find((b) => b.dx === x && b.dy === y && b.dz === z)?.block ?? null;
const keyed = (blocks) => new Map(blocks.map((b) => [`${b.dx},${b.dy},${b.dz}`, b.block]));

// expandParts as it was before the new shapes, kept here to check old plans still give exactly
// the same blocks in the same order.
function oldExpand(parts = [], blocks = [], { slabFor = (s) => s.replace(/_stairs$/, '_slab') } = {}) {
  const range = (a, b) => {
    const out = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
    return out;
  };
  const out = new Map();
  const put = (dx, dy, dz, block) => {
    const key = `${dx},${dy},${dz}`;
    if (parseBlock(block).name === 'air') out.delete(key);
    else {
      out.delete(key);
      out.set(key, { dx, dy, dz, block });
    }
  };
  const roof = (part) => {
    const { from, to } = part;
    const stairs = parseBlock(part.block).name;
    const slab = slabFor(stairs);
    const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
    const y0 = from.dy;
    const [ax0, ax1] = [Math.min(from.dx, to.dx), Math.max(from.dx, to.dx)];
    const [az0, az1] = [Math.min(from.dz, to.dz), Math.max(from.dz, to.dz)];
    const alongX = ax1 - ax0 >= az1 - az0;
    const [u0, u1, v0, v1] = alongX ? [ax0, ax1, az0, az1] : [az0, az1, ax0, ax1];
    const at = (u, y, v, block) => (alongX ? put(u, y, v, block) : put(v, y, u, block));
    const up = alongX ? ['south', 'north'] : ['east', 'west'];
    for (let k = 0; ; k++) {
      const a = v0 - o + k;
      const b = v1 + o - k;
      if (a > b) break;
      const y = y0 + k;
      for (let u = u0 - o; u <= u1 + o; u++) {
        if (a === b) at(u, y, a, slab ? `${slab}[type=bottom]` : `${stairs}[facing=${up[0]},half=bottom]`);
        else {
          at(u, y, a, `${stairs}[facing=${up[0]},half=bottom]`);
          at(u, y, b, `${stairs}[facing=${up[1]},half=bottom]`);
        }
      }
      if (part.fill) {
        for (let v = Math.max(v0, a + 1); v <= Math.min(v1, b - 1); v++) {
          at(u0, y, v, part.fill);
          at(u1, y, v, part.fill);
        }
      }
    }
    if (part.fill) {
      for (let y = y0; y < y0 + o; y++) {
        for (let u = u0; u <= u1; u++) {
          at(u, y, v0, part.fill);
          at(u, y, v1, part.fill);
        }
      }
    }
  };
  for (const part of parts) {
    const { from, to = from, block } = part;
    const xs = range(from.dx, to.dx);
    const ys = range(from.dy, to.dy);
    const zs = range(from.dz, to.dz);
    const [x0, x1, y0, y1, z0, z1] = [xs[0], xs.at(-1), ys[0], ys.at(-1), zs[0], zs.at(-1)];
    if (part.shape === 'line') {
      const steps = Math.max(Math.abs(to.dx - from.dx), Math.abs(to.dy - from.dy), Math.abs(to.dz - from.dz));
      for (let i = 0; i <= steps; i++) {
        const t = steps ? i / steps : 0;
        put(Math.round(from.dx + (to.dx - from.dx) * t), Math.round(from.dy + (to.dy - from.dy) * t), Math.round(from.dz + (to.dz - from.dz) * t), block);
      }
    } else if (part.shape === 'roof') {
      roof({ ...part, from: { dx: x0, dy: from.dy, dz: z0 }, to: { dx: x1, dy: from.dy, dz: z1 } });
    } else {
      for (const x of xs) {
        for (const y of ys) {
          for (const z of zs) {
            const sideX = x === x0 || x === x1;
            const sideZ = z === z0 || z === z1;
            const sideY = y === y0 || y === y1;
            const keep = { fill: true, hollow: sideX || sideZ || sideY, walls: sideX || sideZ, frame: (sideX && sideZ) || (sideX && sideY) || (sideZ && sideY) }[part.shape ?? 'fill'];
            if (keep) put(x, y, z, block);
          }
        }
      }
    }
  }
  for (const b of blocks) put(b.dx, b.dy, b.dz, b.block);
  return [...out.values()];
}

test('plans that only use the old shapes expand to exactly the same blocks as before', () => {
  const plans = [
    [[P('walls', [0, 0, 0], [6, 3, 4], 'cobblestone'), P('frame', [0, 0, 0], [6, 3, 4], 'oak_log'), P('fill', [3, 0, 0], [3, 1, 0], 'air'), P('hollow', [10, 0, 0], [7, 2, 3], 'stone')], [{ dx: 1, dy: 1, dz: 0, block: 'glass_pane' }, { dx: 3, dy: 0, dz: 0, block: 'oak_door[facing=north]' }]],
    [[P('line', [0, 0, 0], [5, 3, -2], 'oak_log[axis=x]'), P('line', [2, 2, 2], [2, 2, 2], 'minecraft:stone')], []],
    [[P('roof', [0, 4, 0], [6, 4, 4], 'spruce_stairs', { fill: 'spruce_planks' })], []],
    [[P('roof', [6, 4, 5], [0, 4, 0], 'oak_stairs[facing=north, half=top]', { fill: 'oak_planks', overhang: 2 })], []],
    [[P('roof', [0, 4, 0], [4, 4, 9], 'stone_brick_stairs', { overhang: 0 })], []],
    [[P('roof', [0, 4, 0], [5, 4, 5], 'spruce_stairs', { fill: 'spruce_planks', overhang: 1 }), P('fill', [0, 0, 0], [5, 3, 5], 'air')], [{ dx: 9, dy: 9, dz: 9, block: 'air' }]],
    [[{ from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 2, dy: 2, dz: 2 }, block: 'oak_planks' }], [{ dx: 0, dy: 0, dz: 0, block: 'oak_stairs[facing=east,half=bottom]' }]]
  ];
  for (const [parts, blocks] of plans) assert.deepEqual(expandParts(parts, blocks), oldExpand(parts, blocks));
  // house.js passes its own ridge slab, or none.
  const roof = [P('roof', [0, 4, 0], [6, 4, 4], 'spruce_stairs', { fill: 'spruce_planks' })];
  for (const slabFor of [() => 'spruce_slab', () => null]) assert.deepEqual(expandParts(roof, [], { slabFor }), oldExpand(roof, [], { slabFor }));
});

// What expands differently from before on purpose, each checked here: a mix comes in patches
// instead of single odd blocks; windows leave out a spot over a door, an air opening or behind a
// post; a post next to another posts part's post is left out; an arch smooths its steps with
// upside-down stairs; a stepped 3 wide arch rises 1; a field a shape doesn't use is refused.
test('the intended differences from before', () => {
  const wall = expandParts([P('fill', [0, 0, 0], [29, 11, 0], '85%stone_bricks,15%cobblestone')]);
  const odd = new Set(wall.filter((b) => b.block === 'cobblestone').map((b) => `${b.dx},${b.dy}`));
  for (const k of odd) {
    const [x, y] = k.split(',').map(Number);
    // At the wall's edge a patch can be cut down to one block.
    if (x === 0 || x === 29 || y === 0 || y === 11) continue;
    assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => odd.has(`${x + a},${y + b}`)), `lone cobblestone at ${k}`);
  }
  const door = expandParts([P('walls', [0, 0, 0], [6, 4, 6], 'oak_planks'), P('windows', [0, 2, 0], [6, 3, 6], 'glass')], [{ dx: 3, dy: 0, dz: 0, block: 'oak_door[facing=north]' }]);
  assert.equal(blockAt(door, 3, 2, 0), 'oak_planks');
  assert.equal(blockAt(door, 3, 2, 6), 'glass');
  const corner = expandParts([P('posts', [0, 0, 0], [0, 2, 6], 'oak_log', { proud: true, facing: 'west' }), P('posts', [0, 0, 0], [6, 2, 0], 'oak_log', { proud: true, facing: 'north' })]);
  assert.equal(blockAt(corner, -1, 0, 0), 'oak_log');
  assert.equal(blockAt(corner, 0, 0, -1), null);
  assert.equal(blockAt(corner, 6, 0, -1), 'oak_log');
  const arch = expandParts([P('fill', [0, 0, 0], [6, 4, 0], 'stone_bricks'), P('arch', [2, 0, 0], [4, 3, 0], 'air')]);
  assert.equal(blockAt(arch, 2, 3, 0), 'stone_brick_stairs[facing=west,half=top]');
  assert.throws(() => expandParts([P('walls', [0, 0, 0], [4, 2, 4], 'stone', { every: 2 })]), /part 1 \(walls\): every does nothing on walls \(it is for posts, windows\), take it out/);
});

test('a circle fits its box, and hollow leaves its ring; along x or z it stands upright', () => {
  const disc = expandParts([P('circle', [0, 0, 0], [6, 0, 6], 'stone')]);
  assert.deepEqual(picture(disc, 0), ['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..']);
  const ring = expandParts([P('circle', [0, 0, 0], [6, 0, 6], 'stone', { hollow: true })]);
  assert.deepEqual(picture(ring, 0), ['..###..', '.#...#.', '#.....#', '#.....#', '#.....#', '.#...#.', '..###..']);
  // A round tower: the ring on every layer, open at both ends.
  const tower = expandParts([P('circle', [0, 0, 0], [4, 5, 4], 'stone_bricks', { hollow: true })]);
  for (let y = 0; y <= 5; y++) assert.deepEqual(picture(tower, y, { box: tower }), ['.###.', '#...#', '#...#', '#...#', '.###.']);
  const window = expandParts([P('circle', [0, 0, 0], [4, 4, 0], 'glass', { axis: 'z' })]);
  assert.deepEqual(picture(window, 0, { plane: 'xy' }), ['.###.', '#####', '#####', '#####', '.###.']);
});

test('a sphere, a dome, a cone and a stepped pyramid fill their boxes, solid or as shells', () => {
  const sphere = expandParts([P('sphere', [0, 0, 0], [4, 4, 4], 'glass')]);
  assert.deepEqual(picture(sphere, 0, { box: sphere }), ['.....', '.###.', '.###.', '.###.', '.....']);
  assert.deepEqual(picture(sphere, 2), ['.###.', '#####', '#####', '#####', '.###.']);
  const shell = expandParts([P('sphere', [0, 0, 0], [4, 4, 4], 'glass', { hollow: true })]);
  assert.equal(blockAt(shell, 2, 2, 2), null);
  assert.deepEqual(picture(shell, 2), ['.###.', '#...#', '#...#', '#...#', '.###.']);
  const dome = expandParts([P('dome', [0, 0, 0], [6, 3, 6], 'stone', { hollow: true })]);
  // Open underneath: the base layer is a ring, not a floor.
  assert.deepEqual(picture(dome, 0), ['..###..', '.#...#.', '#.....#', '#.....#', '#.....#', '.#...#.', '..###..']);
  assert.deepEqual(picture(dome, 3, { box: dome }), ['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......']);
  const cone = expandParts([P('cone', [0, 0, 0], [4, 4, 4], 'spruce_planks')]);
  assert.deepEqual([0, 2, 4].map((y) => picture(cone, y, { box: cone })), [
    ['.###.', '#####', '#####', '#####', '.###.'],
    ['.....', '.###.', '.###.', '.###.', '.....'],
    ['.....', '.....', '..#..', '.....', '.....']
  ]);
  const pyramid = expandParts([P('pyramid', [0, 0, 0], [4, 9, 4], 'sandstone', { hollow: true })]);
  assert.deepEqual([0, 1, 2].map((y) => picture(pyramid, y, { box: pyramid })), [
    ['#####', '#...#', '#...#', '#...#', '#####'],
    ['.....', '.###.', '.#.#.', '.###.', '.....'],
    ['.....', '.....', '..#..', '.....', '.....']
  ]);
  assert.equal(Math.max(...pyramid.map((b) => b.dy)), 2);
});

test('an arch of air cuts an arched opening, and a hollow one is only its edge', () => {
  const wall = P('fill', [0, 0, 0], [8, 5, 0], 'stone_bricks');
  // Each step of the curve gets an upside-down stair of the wall, its low side away from the
  // middle; stepped leaves the steps square.
  const door = expandParts([wall, P('arch', [1, 0, 0], [7, 4, 0], 'air')]);
  assert.deepEqual(picture(door, 0, { plane: 'xy' }), [
    '#########',
    '##(...)##',
    '#(.....)#',
    '#.......#',
    '#.......#',
    '#.......#'
  ]);
  const square = expandParts([wall, P('arch', [1, 0, 0], [7, 4, 0], 'air', { stepped: true })]);
  assert.deepEqual(picture(square, 0, { plane: 'xy' }).slice(0, 3), ['#########', '###...###', '##.....##']);
  const edge = expandParts([P('arch', [0, 0, 0], [6, 4, 0], 'stone_bricks', { hollow: true })]);
  assert.deepEqual(picture(edge, 0, { plane: 'xy' }), [
    '..###..',
    '.(...).',
    '#.....#',
    '#.....#',
    '#.....#'
  ]);
  // 3 wide: stairs either side of the top; stepped, it rises 1 and is square-topped.
  const small = P('fill', [0, 0, 0], [4, 4, 0], 'stone_bricks');
  assert.deepEqual(picture(expandParts([small, P('arch', [1, 0, 0], [3, 3, 0], 'air')]), 0, { plane: 'xy' }), ['#####', '#(.)#', '#...#', '#...#', '#...#']);
  assert.deepEqual(picture(expandParts([small, P('arch', [1, 0, 0], [3, 3, 0], 'air', { stepped: true })]), 0, { plane: 'xy' }), ['#####', '#...#', '#...#', '#...#', '#...#']);
  // Through a wall 5 thick, an opening 3 wide still runs through the wall.
  const thick = expandParts([P('fill', [0, 0, 0], [6, 4, 4], 'stone'), P('arch', [2, 0, 0], [4, 3, 4], 'air')]);
  for (let z = 0; z <= 4; z++) assert.equal(blockAt(thick, 3, 0, z), null);
  assert.equal(blockAt(thick, 2, 3, 2), 'stone_stairs[facing=west,half=top]');
  // Along z, through x, with a given rise.
  const side = expandParts([P('arch', [0, 0, 0], [0, 3, 4], 'stone', { rise: 1 })]);
  assert.equal(blockAt(side, 0, 3, 0), null);
  assert.equal(blockAt(side, 0, 3, 2), 'stone');
  assert.equal(blockAt(side, 0, 2, 0), 'stone');
  assert.throws(() => expandParts([P('arch', [0, 0, 0], [4, 3, 0], 'stone', { axis: 'y' })]), /part 1 \(arch\): axis is y, an arch runs through x or z/);
});

test('a staircase climbs from from to to with stairs facing the way up, filled under', () => {
  const up = expandParts([P('staircase', [0, 0, 0], [3, 3, 1], 'oak_stairs', { fill: 'cobblestone' })]);
  assert.deepEqual([0, 1, 2, 3].map((y) => picture(up, y, { box: up })), [
    ['>###', '>###'],
    ['.>##', '.>##'],
    ['..>#', '..>#'],
    ['...>', '...>']
  ]);
  // Going down toward to, the stairs still face up, back toward from.
  const down = expandParts([P('staircase', [0, 4, 0], [0, 0, 4], 'stone_brick_stairs')]);
  assert.equal(blockAt(down, 0, 4, 0), 'stone_brick_stairs[facing=north,half=bottom]');
  assert.equal(blockAt(down, 0, 0, 4), 'stone_brick_stairs[facing=north,half=bottom]');
  assert.throws(() => expandParts([P('staircase', [0, 0, 0], [4, 3, 0], 'oak_stairs')]), /part 1 \(staircase\): from and to are 4 apart across but 3 apart in height/);
  assert.throws(() => expandParts([P('staircase', [0, 0, 0], [4, 0, 0], 'oak_stairs')]), /same height/);
});

test('posts go at the corners and evenly along the walls, proud ones a block out', () => {
  const flush = expandParts([P('walls', [0, 0, 0], [8, 2, 6], 'oak_planks'), P('posts', [0, 0, 0], [8, 2, 6], 'oak_log', { every: 4 })]);
  assert.deepEqual(picture(flush, 1), ['o###o###o', '#.......#', '#.......#', 'o.......o', '#.......#', '#.......#', 'o###o###o']);
  const proud = expandParts([P('walls', [0, 0, 0], [8, 2, 6], 'oak_planks'), P('posts', [0, 0, 0], [8, 2, 6], 'oak_log', { every: 4, proud: true })]);
  assert.deepEqual(picture(proud, 2), [
    'oo...o...oo',
    'oo#######oo',
    '.#.......#.',
    '.#.......#.',
    'o#.......#o',
    '.#.......#.',
    '.#.......#.',
    'oo#######oo',
    'oo...o...oo'
  ]);
  // One wall: proud needs the side to stand out to.
  assert.throws(() => expandParts([P('posts', [0, 0, 0], [8, 2, 0], 'oak_log', { proud: true })]), /part 1 \(posts\): proud on a single wall needs facing/);
  const one = expandParts([P('posts', [0, 0, 0], [8, 0, 0], 'oak_log', { every: 4, proud: true, facing: 'north' })]);
  assert.deepEqual(one.map((b) => [b.dx, b.dz]), [[0, -1], [4, -1], [8, -1]]);
});

test('windows are spaced along each wall, off the corners and the same from both ends', () => {
  const legend = { glass_pane: 'g' };
  const house = expandParts([P('walls', [0, 0, 0], [8, 3, 6], 'oak_planks'), P('windows', [0, 1, 0], [8, 2, 6], 'glass_pane', { every: 3 })]);
  assert.deepEqual(picture(house, 1, { legend }), ['##g###g##', '#.......#', '#.......#', 'g.......g', '#.......#', '#.......#', '##g###g##']);
  assert.deepEqual(picture(house, 0, { legend }), ['#########', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#########']);
  // 4 apart would leave one end longer, so they go 5 apart.
  const wide = expandParts([P('fill', [0, 0, 0], [12, 0, 0], 'stone'), P('windows', [0, 0, 0], [12, 0, 0], 'air', { width: 2, every: 4 })]);
  assert.deepEqual(picture(wide, 0, { box: [{ dx: 0, dz: 0 }, { dx: 12, dz: 0 }] }), ['###..###..###']);
  assert.throws(() => expandParts([P('windows', [0, 0, 0], [3, 0, 0], 'glass', { width: 2 })]), /too short for windows 2 wide/);
  // Mirrored about the middle of an even wall too, never a lone window off centre.
  const even = expandParts([P('windows', [0, 0, 0], [7, 0, 0], 'glass', { every: 3 })]);
  assert.deepEqual(even.map((b) => b.dx), [2, 5]);
  // A window over a door or air opening, or behind a post, is left out.
  const front = [P('walls', [0, 0, 0], [8, 3, 6], 'oak_planks'), P('posts', [0, 0, 0], [8, 3, 6], 'oak_log', { every: 4, proud: true }), P('fill', [2, 0, 6], [2, 1, 6], 'air'), P('windows', [0, 1, 0], [8, 2, 6], 'glass', { every: 2 })];
  const built = expandParts(front, [{ dx: 6, dy: 0, dz: 6, block: 'oak_door[facing=south]' }]);
  assert.deepEqual(picture(built, 2, { legend: { glass: 'g', oak_log: 'o' } }).slice(1, 8), ['oo#g###g#oo', '.#.......#.', '.g.......g.', 'o#.......#o', '.g.......g.', '.#.......#.', 'oo#######oo']);
});

test('once keeps a part or block out of the plan\'s mirror', () => {
  const plan = [P('fill', [1, 0, 1], [1, 3, 1], 'bricks', { once: true }), P('fill', [0, 0, 0], [0, 0, 0], 'stone')];
  const built = expandParts(plan, [{ dx: 2, dy: 0, dz: 0, block: 'poppy', once: true }, { dx: 3, dy: 0, dz: 0, block: 'dandelion' }], { mirror: { x: 8 } });
  assert.equal(blockAt(built, 7, 0, 1), null);
  assert.equal(blockAt(built, 8, 0, 0), 'stone');
  assert.equal(blockAt(built, 6, 0, 0), null);
  assert.equal(blockAt(built, 5, 0, 0), 'dandelion');
  assert.equal(partCopies({ once: true, repeat: { count: 2 } }, { x: 8 }), 2);
  // Its own mirror still applies.
  assert.equal(blockAt(expandParts([P('fill', [1, 0, 0], [1, 0, 0], 'stone', { once: true, mirror: { z: 4 } })], [], { mirror: { x: 8 } }), 1, 0, 4), 'stone');
});

test('a band runs round the walls with logs along each wall and stairs facing in', () => {
  const band = expandParts([P('band', [0, 0, 0], [4, 0, 3], 'stripped_oak_log'), P('band', [0, 1, 0], [4, 1, 3], 'oak_stairs', { proud: true })]);
  assert.deepEqual(picture(band, 0, { box: band }), ['.......', '.-----.', '.|...|.', '.|...|.', '.-----.', '.......']);
  assert.deepEqual(picture(band, 1), ['VVVVVVV', ').....(', ').....(', ').....(', ').....(', 'AAAAAAA']);
  // A state of its own is kept.
  const own = expandParts([P('band', [0, 0, 0], [2, 0, 2], 'oak_stairs[half=bottom]')]);
  assert.equal(blockAt(own, 1, 0, 0), 'oak_stairs[half=bottom,facing=south]');
  // half=bottom makes the upright cap of a base course, sloping up to the wall.
  const cap = expandParts([P('band', [0, 0, 0], [4, 0, 3], '@trim.stairs[half=bottom]', { proud: true })], [], { palette: { trim: 'stone_bricks' } });
  assert.equal(blockAt(cap, 2, 0, -1), 'stone_brick_stairs[half=bottom,facing=south]');
  assert.equal(blockAt(cap, 5, 0, 2), 'stone_brick_stairs[half=bottom,facing=west]');
});

test('a mix picks the same block for a spot every time and roughly keeps to its weights', () => {
  const mix = '70%stone_bricks,20%cracked_stone_bricks,10%mossy_stone_bricks';
  const parts = [P('fill', [0, 0, 0], [19, 4, 19], mix)];
  const a = expandParts(parts);
  assert.deepEqual(expandParts(parts), a);
  const counts = {};
  for (const b of a) counts[b.block] = (counts[b.block] ?? 0) + 1;
  assert.ok(Math.abs(counts.stone_bricks / a.length - 0.7) < 0.05, JSON.stringify(counts));
  assert.ok(Math.abs(counts.cracked_stone_bricks / a.length - 0.2) < 0.05, JSON.stringify(counts));
  assert.ok(Math.abs(counts.mossy_stone_bricks / a.length - 0.1) < 0.05, JSON.stringify(counts));
  // Another part before it, or the build half done, doesn't change what goes where.
  const later = keyed(expandParts([P('line', [30, 0, 0], [31, 0, 0], 'dirt'), ...parts]));
  for (const b of a) assert.equal(later.get(`${b.dx},${b.dy},${b.dz}`), b.block);
  // Each entry keeps its state, weights left out count 1, and air leaves gaps.
  const stairs = expandParts([P('line', [0, 0, 0], [40, 0, 0], 'oak_stairs[facing=north],spruce_stairs[facing=north,half=top]')]);
  assert.deepEqual(new Set(stairs.map((b) => b.block)), new Set(['oak_stairs[facing=north]', 'spruce_stairs[facing=north,half=top]']));
  const ruin = expandParts([P('fill', [0, 0, 0], [9, 0, 9], '50%cobblestone,50%air')]);
  assert.ok(ruin.length > 30 && ruin.length < 70, `${ruin.length}`);
  // A mix in a roof is picked per spot, each turned like the roof.
  const roof = expandParts([P('roof', [0, 0, 0], [8, 0, 4], '80%spruce_stairs,20%dark_oak_stairs', { style: 'hip' })]);
  assert.ok(roof.some((b) => b.block.startsWith('dark_oak_stairs[facing=')) && roof.some((b) => b.block === 'spruce_slab[type=bottom]'));
  assert.throws(() => material('70%,30%stone'), /has no block name/);
  // In patches: the lesser blocks of a wall come in clusters, a few blocks each.
  const wall = expandParts([P('fill', [0, 0, 0], [59, 29, 0], '85%stone_bricks,15%cobblestone')]);
  const odd = new Set(wall.filter((b) => b.block === 'cobblestone').map((b) => `${b.dx},${b.dy}`));
  assert.ok(Math.abs(odd.size / wall.length - 0.15) < 0.04, `${odd.size / wall.length}`);
  const sizes = [];
  const seen = new Set();
  const border = (k) => /^(0|59),|,(0|29)$/.test(k);
  for (const k of odd) {
    if (seen.has(k)) continue;
    const todo = [k];
    seen.add(k);
    let n = 0;
    while (todo.length) {
      const [x, y] = todo.pop().split(',').map(Number);
      n++;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = `${x + a},${y + b}`;
        if (odd.has(q) && !seen.has(q)) {
          seen.add(q);
          todo.push(q);
        }
      }
    }
    if (n > 1 || !border(k)) sizes.push(n);
  }
  assert.ok(sizes.every((n) => n >= 2), sizes.join(' '));
  assert.ok(sizes.filter((n) => n >= 3 && n <= 8).length >= sizes.length / 2, sizes.join(' '));
  // scatter: picks each spot on its own, lone blocks and all.
  const path = expandParts([P('fill', [0, 0, 0], [29, 0, 29], 'scatter:70%gravel,30%coarse_dirt')]);
  const coarse = path.filter((b) => b.block === 'coarse_dirt').length / path.length;
  assert.ok(Math.abs(coarse - 0.3) < 0.05, `${coarse}`);
  assert.deepEqual(expandParts([P('fill', [0, 0, 0], [1, 0, 0], 'scatter:stone')]).map((b) => b.block), ['stone', 'stone']);
});

test('palette roles and their forms resolve against the game blocks, and a missing form is refused', () => {
  const palette = { wall: 'spruce_planks', foundation: 'stone_bricks', frame: 'stripped_spruce_log', glass: 'glass', trim: '60%stone_bricks,40%mossy_stone_bricks' };
  const forms = (role, form) => material(`@${role}.${form}`, { palette }).map((e) => e.name);
  assert.deepEqual(['stairs', 'slab', 'fence', 'fence_gate', 'trapdoor', 'door', 'log'].map((f) => forms('wall', f)[0]), ['spruce_stairs', 'spruce_slab', 'spruce_fence', 'spruce_fence_gate', 'spruce_trapdoor', 'spruce_door', 'spruce_log']);
  assert.deepEqual(['stairs', 'slab', 'wall'].map((f) => forms('foundation', f)[0]), ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall']);
  assert.deepEqual(forms('frame', 'planks'), ['spruce_planks']);
  assert.deepEqual(forms('glass', 'pane'), ['glass_pane']);
  assert.deepEqual(forms('trim', 'stairs'), ['stone_brick_stairs', 'mossy_stone_brick_stairs']);
  assert.equal(formName('spruce_stairs', 'block'), 'spruce_planks');
  assert.equal(formName('quartz_stairs', 'block'), 'quartz_block');
  assert.equal(formName('bamboo_stairs', 'block'), 'bamboo_planks');
  assert.equal(formName('crimson_planks', 'log'), 'crimson_stem');
  const plan = [P('walls', [0, 0, 0], [4, 2, 4], '@wall'), P('line', [0, 3, 0], [4, 3, 0], '@foundation.stairs[facing=south,half=top]'), P('fill', [0, -1, 0], [4, -1, 4], '@trim')];
  const built = expandParts(plan, [{ dx: 2, dy: 0, dz: 0, block: '@wall.door[facing=north]' }], { palette });
  assert.equal(blockAt(built, 0, 0, 0), 'spruce_planks');
  assert.equal(blockAt(built, 2, 0, 0), 'spruce_door[facing=north]');
  assert.equal(blockAt(built, 1, 3, 0), 'stone_brick_stairs[facing=south,half=top]');
  // Swapping the palette restyles the same plan.
  const stone = expandParts(plan, [], { palette: { ...palette, wall: 'deepslate_bricks', foundation: 'cobblestone' } });
  assert.equal(blockAt(stone, 0, 0, 0), 'deepslate_bricks');
  assert.equal(blockAt(stone, 1, 3, 0), 'cobblestone_stairs[facing=south,half=top]');
  assert.throws(() => expandParts([P('walls', [0, 0, 0], [2, 2, 2], '@wall.wall')], [], { palette }), (err) => err instanceof PlanError && /part 1 \(walls\), block: @wall.wall: the wall role is spruce_planks, which has no wall form; it has .*stairs, slab, fence/.test(err.message));
  assert.throws(() => expandParts([P('walls', [0, 0, 0], [2, 2, 2], '@walls')], [], { palette }), /@walls is not a palette role; the roles are wall, frame/);
  assert.throws(() => expandParts([P('walls', [0, 0, 0], [2, 2, 2], '@accent')], [], { palette }), /part 1 \(walls\), block: @accent is used but the palette has no accent/);
  assert.throws(() => expandParts([P('walls', [0, 0, 0], [2, 2, 2], '@wall.window')], [], { palette }), /window is not a form; the forms are block, stairs/);
  assert.throws(() => expandParts([], [], { palette: { wall: '@frame' } }), /palette wall: a role can't refer to another role/);
  // A role takes a state straight on, and a stairs role still has .stairs, .slab and .block.
  const roof = { roof: 'dark_oak_stairs' };
  assert.deepEqual(material('@roof[facing=north,half=top]', { palette: roof }).map((e) => [e.name, e.props]), [['dark_oak_stairs', { facing: 'north', half: 'top' }]]);
  assert.deepEqual(['stairs', 'slab', 'block'].map((f) => material(`@roof.${f}`, { palette: roof })[0].name), ['dark_oak_stairs', 'dark_oak_slab', 'dark_oak_planks']);
  assert.equal(material('@roof.stairs', { palette: { roof: 'stone_brick_stairs' } })[0].name, 'stone_brick_stairs');
});

const facingAt = (blocks, x, y, z) => parseBlock(blockAt(blocks, x, y, z) ?? '').props.facing;

test('every roof style has its stairs climbing toward the top on each slope and at the corners', () => {
  const gable = expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'spruce_stairs', { overhang: 0 })]);
  assert.deepEqual(picture(gable, 0), ['vvvvvvv', '.......', '.......', '.......', '^^^^^^^']);
  assert.deepEqual(picture(gable, 2, { box: gable }), ['.......', '.......', '_______', '.......', '.......']);
  // Hip: each side climbs in, the corners turned like the ends so the game makes outer
  // corners, and the ridge gets slabs.
  const hip = expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'spruce_stairs', { style: 'hip', fill: 'spruce_planks' })]);
  assert.deepEqual(picture(hip, 0), ['>vvvvvvv<', '>#######<', '>#.....#<', '>#.....#<', '>#.....#<', '>#######<', '>^^^^^^^<']);
  assert.deepEqual(picture(hip, 1, { box: hip }), ['.........', '.>vvvvv<.', '.>.....<.', '.>.....<.', '.>.....<.', '.>^^^^^<.', '.........']);
  assert.deepEqual(picture(hip, 3, { box: hip }), ['.........', '.........', '.........', '...___...', '.........', '.........', '.........']);
  // Along z the ends are north and south, so the corners face those ways.
  const hipZ = expandParts([P('roof', [0, 0, 0], [4, 0, 6], 'oak_stairs', { style: 'hip', overhang: 0 })]);
  assert.deepEqual(picture(hipZ, 0), ['vvvvv', '>...<', '>...<', '>...<', '>...<', '>...<', '^^^^^']);
  // Pyramid: on a square it comes to a slab point.
  const pyramid = expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { style: 'pyramid', overhang: 0 })]);
  assert.deepEqual(picture(pyramid, 1, { box: pyramid }), ['.....', '.>v<.', '.>.<.', '.>^<.', '.....']);
  assert.equal(blockAt(pyramid, 2, 2, 2), 'spruce_slab[type=bottom]');
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'spruce_stairs', { style: 'pyramid' })]), /part 1 \(roof\): style pyramid needs a square box, this one is 7 by 5; use hip/);
  // Shed: one slope, every stair facing the way it climbs, the walls closed up to it.
  const shed = expandParts([P('roof', [0, 0, 0], [4, 0, 3], 'spruce_stairs', { style: 'shed', facing: 'north', overhang: 0, fill: 'spruce_planks' })]);
  assert.deepEqual([0, 1, 2, 3].map((y) => picture(shed, y, { box: shed })), [
    ['#####', '#...#', '#...#', '^^^^^'],
    ['#####', '#...#', '^^^^^', '.....'],
    ['#####', '^^^^^', '.....', '.....'],
    ['^^^^^', '.....', '.....', '.....']
  ]);
  const east = expandParts([P('roof', [0, 0, 0], [3, 0, 2], 'oak_stairs', { style: 'shed', facing: 'east', overhang: 1 })]);
  assert.ok(east.every((b) => b.block === 'oak_stairs[facing=east,half=bottom]'));
  assert.equal(Math.max(...east.map((b) => b.dy)), 5);
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [3, 0, 2], 'oak_stairs', { style: 'shed' })]), /style shed needs facing/);
  // Flat: a deck of the full block, upside-down stairs round it facing in, a parapet on top.
  const flat = expandParts([P('roof', [0, 0, 0], [4, 0, 3], 'spruce_stairs', { style: 'flat', fill: 'spruce_fence' })]);
  assert.deepEqual(picture(flat, 0, { legend: { spruce_planks: 'p' } }), ['VVVVVVV', ')ppppp(', ')ppppp(', ')ppppp(', ')ppppp(', 'AAAAAAA']);
  assert.deepEqual(picture(flat, 1, { legend: { spruce_fence: 'f' } }), ['fffffff', 'f.....f', 'f.....f', 'f.....f', 'f.....f', 'fffffff']);
});

test('pitch 2 climbs two for one with a full block under each stair after the eaves', () => {
  const steep = expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { pitch: 2, fill: 'spruce_planks' })]);
  // Across the slopes, top down, north on the left: at the gable end the fill closes it, at
  // the overhang it is the roof alone.
  const across = (x) => {
    const rows = [];
    for (let y = 6; y >= 0; y--) {
      let row = '';
      for (let z = -1; z <= 5; z++) {
        const b = blockAt(steep, x, y, z);
        row += b ? charOf(b, { spruce_planks: 'p' }) : '.';
      }
      rows.push(row);
    }
    return rows;
  };
  assert.deepEqual(across(0), ['..._...', '...p...', '..vp^..', '..ppp..', '.vppp^.', '.ppppp.', 'vppppp^']);
  assert.deepEqual(across(-1), ['..._...', '...p...', '..v.^..', '..p.p..', '.v...^.', '.p...p.', 'v.....^']);
  const hip = expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { style: 'hip', pitch: 2, overhang: 0 })]);
  assert.equal(facingAt(hip, 0, 0, 2), 'east');
  assert.equal(blockAt(hip, 1, 1, 2), 'spruce_planks');
  assert.equal(facingAt(hip, 1, 2, 2), 'east');
  assert.equal(blockAt(hip, 2, 4, 2), 'spruce_slab[type=bottom]');
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { pitch: 3 })]), /pitch is 3, it is 0.5, 1 or 2/);
});

test('pitch 0.5 climbs one for two in slabs, bottom then top, from the roof block\'s own slab', () => {
  const low = expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'spruce_stairs', { pitch: 0.5, overhang: 0 })]);
  const profile = (blocks, x) => {
    const rows = [];
    for (let y = 1; y >= 0; y--) {
      let row = '';
      for (let z = 0; z <= 4; z++) {
        const b = blockAt(blocks, x, y, z);
        row += b ? (parseBlock(b).props.type === 'top' ? '-' : '_') : '.';
      }
      rows.push(row);
    }
    return rows;
  };
  assert.deepEqual(profile(low, 3), ['.._..', '_-.-_']);
  assert.ok(low.every((b) => b.block.startsWith('spruce_slab[type=')));
  // Hip, pyramid and shed the same way; a full block gives its slab form.
  const shed = expandParts([P('roof', [0, 0, 0], [2, 0, 3], 'oak_planks', { style: 'shed', facing: 'south', pitch: 0.5, overhang: 0 })]);
  assert.deepEqual([0, 1, 2, 3].map((z) => blockAt(shed, 1, Math.floor(z / 2), z)), ['oak_slab[type=bottom]', 'oak_slab[type=top]', 'oak_slab[type=bottom]', 'oak_slab[type=top]']);
  const hip = expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { style: 'pyramid', pitch: 0.5, overhang: 0 })]);
  assert.equal(blockAt(hip, 0, 0, 0), 'spruce_slab[type=bottom]');
  assert.equal(blockAt(hip, 1, 0, 1), 'spruce_slab[type=top]');
  assert.equal(blockAt(hip, 2, 1, 2), 'spruce_slab[type=bottom]');
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'dirt', { pitch: 0.5 })]), /part 1 \(roof\): pitch 0.5 is made of slabs, and dirt has no slab form/);
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'spruce_stairs', { style: 'flat', pitch: 0.5 })]), /a flat roof has no pitch/);
});

test('axis sets a gable\'s ridge, and a roof field that does nothing is refused', () => {
  // A porch roof wider than deep, its ridge running out from the wall.
  const porch = expandParts([P('roof', [0, 0, 0], [4, 0, 2], 'oak_stairs', { axis: 'z', overhang: 0 })]);
  assert.ok(porch.filter((b) => b.block.includes('stairs')).every((b) => ['east', 'west'].includes(parseBlock(b.block).props.facing)));
  assert.deepEqual(picture(porch, 0), ['>...<', '>...<', '>...<']);
  const steep = expandParts([P('roof', [0, 0, 0], [4, 0, 2], 'oak_stairs', { axis: 'z', pitch: 2, overhang: 0 })]);
  assert.equal(facingAt(steep, 0, 0, 1), 'east');
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'oak_stairs', { style: 'hip', axis: 'x' })]), /axis sets the ridge of a gable roof and does nothing on a hip roof/);
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'oak_stairs', { axis: 'y' })]), /axis is y, a gable's ridge runs along x or z/);
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'oak_stairs', { facing: 'north' })]), /facing is only for style shed/);
  assert.throws(() => expandParts([P('fill', [0, 0, 0], [1, 1, 1], 'stone', { kind: 'well' })]), /kind does nothing on fill \(it is for kit\)/);
  assert.throws(() => expandParts([P('posts', [0, 0, 0], [4, 2, 4], 'oak_log', { facing: 'north' })]), /facing on posts is only for proud on a single wall/);
  assert.throws(() => expandParts([P('band', [0, 0, 0], [4, 0, 4], 'oak_log', { facing: 'north' })]), /facing on a band is only for a single wall/);
  // Left out or false is fine.
  assert.equal(expandParts([P('fill', [0, 0, 0], [1, 0, 0], 'stone', { hollow: false, every: null })]).length, 2);
});

test('edge frames a roof in a second block: eaves, gable ends, hips and ridge', () => {
  const gable = expandParts([P('roof', [0, 4, 0], [8, 4, 6], 'stone_brick_stairs', { edge: 'spruce_planks' })]);
  const kind = (x, y, z) => parseBlock(blockAt(gable, x, y, z) ?? 'air').name;
  for (let x = -1; x <= 9; x++) assert.equal(kind(x, 4, -1), 'spruce_stairs', `eave at ${x}`);
  for (let k = 0; k <= 3; k++) {
    assert.equal(kind(-1, 4 + k, -1 + k), 'spruce_stairs');
    assert.equal(kind(9, 4 + k, 7 - k), 'spruce_stairs');
  }
  assert.equal(kind(4, 8, 3), 'spruce_slab');
  assert.equal(kind(4, 5, 0), 'stone_brick_stairs');
  // Under the overhanging gable end an upside-down stair fills each step.
  assert.equal(blockAt(gable, -1, 4, 0), 'spruce_stairs[facing=north,half=top]');
  assert.equal(blockAt(gable, 9, 5, 5), 'spruce_stairs[facing=south,half=top]');
  assert.equal(blockAt(gable, 0, 4, 0), null);
  const flush = expandParts([P('roof', [0, 4, 0], [8, 4, 6], 'stone_brick_stairs', { edge: 'spruce_planks', overhang: 0 })]);
  assert.equal(flush.filter((b) => b.block.includes('half=top')).length, 0);
  // Hip: the eave ring, the hip lines and the ridge.
  const hip = expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'spruce_stairs', { style: 'hip', edge: '@trim' })], [], { palette: { trim: 'deepslate_bricks' } });
  const deep = (x, y, z) => blockAt(hip, x, y, z)?.startsWith('deepslate_brick');
  assert.ok(deep(-1, 0, 2) && deep(1, 0, -1));
  assert.ok(deep(0, 1, 0) && !deep(2, 1, 0) && !deep(0, 1, 2));
  assert.ok(deep(3, 3, 2));
  // Shed: low row, top row and both sides; flat: the outer ring.
  const shed = expandParts([P('roof', [0, 0, 0], [4, 0, 3], 'oak_stairs', { style: 'shed', facing: 'north', overhang: 0, edge: 'spruce_planks' })]);
  const sp = (x, y, z) => blockAt(shed, x, y, z)?.startsWith('spruce');
  assert.ok(sp(2, 0, 3) && sp(2, 3, 0) && sp(0, 1, 2) && sp(4, 2, 1) && !sp(2, 1, 2));
  const flat = expandParts([P('roof', [0, 0, 0], [2, 0, 2], 'oak_stairs', { style: 'flat', edge: 'spruce_planks' })]);
  assert.ok(blockAt(flat, -1, 0, 1).startsWith('spruce_stairs') && blockAt(flat, 1, 0, 1) === 'oak_planks');
  // With pitch 0.5 the frame is in slabs.
  const slabs = expandParts([P('roof', [0, 0, 0], [6, 0, 4], 'oak_stairs', { pitch: 0.5, edge: 'spruce_planks' })]);
  assert.equal(blockAt(slabs, 3, 0, -1), 'spruce_slab[type=bottom]');
  assert.equal(blockAt(slabs, 3, 0, 0), 'oak_slab[type=top]');
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [4, 0, 4], 'oak_stairs', { edge: 'dirt' })]), /edge: dirt has no stairs form/);
});

test('mirror copies a part across a plane with its stairs, doors and trapdoors turned', () => {
  assert.deepEqual(mirrorState({ facing: 'east', half: 'top' }, 'x'), { facing: 'west', half: 'top' });
  assert.deepEqual(mirrorState({ facing: 'north', axis: 'x' }, 'z'), { facing: 'south', axis: 'x' });
  assert.deepEqual(turnState({ facing: 'north', axis: 'x' }, 1), { facing: 'east', axis: 'z' });
  const stairs = expandParts([P('line', [0, 0, 0], [2, 0, 0], 'oak_stairs[facing=east]', { mirror: { x: 8 } })]);
  assert.deepEqual(stairs.map((b) => [b.dx, b.block]), [[0, 'oak_stairs[facing=east]'], [1, 'oak_stairs[facing=east]'], [2, 'oak_stairs[facing=east]'], [8, 'oak_stairs[facing=west]'], [7, 'oak_stairs[facing=west]'], [6, 'oak_stairs[facing=west]']]);
  const both = expandParts([], [{ dx: 1, dy: 0, dz: 1, block: 'spruce_trapdoor[facing=north,half=top]' }], { mirror: { x: 6, z: 4 } });
  assert.deepEqual(both.map((b) => [b.dx, b.dz, parseBlock(b.block).props.facing]), [[1, 1, 'north'], [5, 1, 'north'], [1, 3, 'south'], [5, 3, 'south']]);
  // On the plane itself the part keeps its own block.
  const middle = expandParts([P('line', [3, 0, 0], [4, 0, 0], 'oak_door[facing=east]', { mirror: { x: 6 } })]);
  assert.deepEqual(middle.map((b) => [b.dx, b.block]), [[3, 'oak_door[facing=east]'], [4, 'oak_door[facing=east]'], [2, 'oak_door[facing=west]']]);
  assert.throws(() => expandParts([P('fill', [0, 0, 0], [1, 0, 0], 'stone', { mirror: { x: 2.5 } })]), /mirror x is 2.5, it must be a whole number/);
});

test('a plan-level mirror builds the other half, doorways and windows cut on both sides', () => {
  const half = [
    P('walls', [0, 0, 0], [4, 2, 6], 'spruce_planks'),
    P('fill', [0, 1, 3], [0, 1, 3], 'air'),
    P('roof', [0, 3, 0], [4, 3, 6], 'spruce_stairs', { overhang: 0 })
  ];
  const whole = expandParts(half, [{ dx: 1, dy: 0, dz: 1, block: 'oak_stairs[facing=west]' }], { mirror: { x: 8 } });
  assert.equal(blockAt(whole, 8, 0, 0), 'spruce_planks');
  assert.equal(blockAt(whole, 0, 1, 3), null);
  assert.equal(blockAt(whole, 8, 1, 3), null);
  assert.equal(blockAt(whole, 7, 0, 1), 'oak_stairs[facing=east]');
  assert.deepEqual(picture(whole, 1), ['#########', '#...#...#', '#...#...#', '....#....', '#...#...#', '#...#...#', '#########']);
});

test('repeat lays a part again and again, each step further', () => {
  const posts = expandParts([P('line', [0, 0, 0], [0, 2, 0], 'oak_fence', { repeat: { count: 4, dx: 3 } })]);
  assert.deepEqual([...new Set(posts.map((b) => b.dx))], [0, 3, 6, 9]);
  assert.equal(posts.length, 12);
  const lamps = expandParts([P('fill', [0, 0, 0], [0, 0, 0], 'lantern[hanging=true]', { repeat: { count: 3, dz: 4 }, mirror: { x: 6 } })]);
  assert.deepEqual(lamps.map((b) => [b.dx, b.dz]), [[0, 0], [0, 4], [0, 8], [6, 0], [6, 4], [6, 8]]);
  assert.equal(partCopies({ repeat: { count: 3 } }, { x: 6, z: 2 }), 12);
  assert.throws(() => expandParts([P('fill', [0, 0, 0], [0, 0, 0], 'stone', { repeat: { count: 0, dx: 1 } })]), /part 1 \(fill\): repeat count is 0/);
});

test('a plan that cannot be read names the part and field, and build_structure says so', async () => {
  assert.throws(() => expandParts([P('fill', [0, 0, 0], [1, 1, 1], 'stone'), P('blob', [0, 0, 0], [1, 1, 1], 'stone')]), /part 2 \(blob\): shape is blob, it is one of fill, hollow/);
  assert.throws(() => expandParts([P('roof', [0, 0, 0], [1, 0, 1], 'oak_stairs', { style: 'mansard' })]), /style is mansard, it is one of gable, hip/);
  assert.throws(() => expandParts([P('windows', [0, 0, 0], [8, 0, 6], 'glass', { every: 0 })]), /part 1 \(windows\): every is 0, it must be a whole number of at least 1/);
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { spruce_planks: {}, spruce_stairs: {}, spruce_slab: {} }, itemsByName: { spruce_planks: {}, spruce_stairs: {} } },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', getProperties: () => ({}) })
  };
  const ctx = { bot, config: { limits: { maxBuildBlocks: 500 } } };
  const bad = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, palette: { wall: 'spruce_planks' }, parts: [P('walls', [0, 0, 0], [2, 2, 2], '@wall.fence')] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /part 1 \(walls\), block: @wall.fence: the wall role is spruce_planks, which has no fence form; it has stairs, slab/);
  const dry = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, palette: { wall: 'spruce_planks' }, mirror: { x: 4 }, parts: [P('walls', [0, 0, 0], [2, 1, 2], '@wall')], dry_run: true });
  assert.match(dry.message, /^Plan: 26 blocks, 0 already in place\. Needs 26 spruce_planks\./);
  // Repeats and mirrors count toward the size check before anything is expanded.
  const big = await buildStructure(ctx, { origin: { x: 0, y: 64, z: 0 }, parts: [P('fill', [0, 0, 0], [9, 9, 9], 'spruce_planks', { repeat: { count: 50, dx: 10 } })] });
  assert.match(big.message, /far too big, the limit is 500 blocks/);
  assert.equal(expandPlan(bot, { parts: [P('walls', [0, 0, 0], [2, 1, 2], '@wall')], palette: { wall: 'spruce_planks' } }).length, 16);
});

test('the trial and kit plans all expand', () => {
  for (const folder of ['trial', 'trial-opus', 'trial-fable', 'kits']) {
    const dir = fileURLToPath(new URL(`../docs/renders/${folder}/`, import.meta.url));
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const plan = JSON.parse(readFileSync(dir + file, 'utf8').replace(/^\uFEFF/, ''));
      assert.ok(expandParts(plan.parts, plan.blocks, { palette: plan.palette, mirror: plan.mirror }).length > 0, `${folder}/${file}`);
    }
  }
});