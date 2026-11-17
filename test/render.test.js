import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { renderViews, encodePng } from '../src/render.js';
import { blockStyle, shapeOf } from '../src/blockcolors.js';

// Reads back the PNGs this renderer writes: 8-bit RGBA, no filtering.
function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, pixels, at: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)] };
}

const one = (block, view = 'south-east', opts = {}) => renderViews([{ x: 0, y: 0, z: 0, block }], { views: [view], ...opts })[0];

// The average colour of a small square around a point given as fractions of the picture.
function sample(img, fx, fy) {
  const cx = Math.round(img.width * fx);
  const cy = Math.round(img.height * fy);
  const sum = [0, 0, 0];
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) img.at(x, y).forEach((v, i) => (sum[i] += v / 9));
  return sum;
}

test('encodePng writes a PNG that decodes back to the same pixels', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 255, 10, 20, 30, 255, 1, 2, 3, 255]);
  const img = decodePng(encodePng(rgba, 2, 2));
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.deepEqual([...img.pixels], [...rgba]);
});

test('renderViews gives one PNG per view with the stated size', () => {
  const out = renderViews([{ x: 5, y: 64, z: -3, block: 'stone' }, { x: 6, y: 64, z: -3, block: 'air' }], { views: ['south-east', 'top', 'north'] });
  assert.deepEqual(out.map((r) => r.view), ['south-east', 'top', 'north']);
  for (const r of out) {
    const img = decodePng(r.png);
    assert.equal(img.width, r.width);
    assert.equal(img.height, r.height);
    assert.ok(r.width <= 900 && r.height <= 900);
    assert.deepEqual(r.unknown, []);
  }
  assert.throws(() => renderViews([], { views: ['sideways'] }), /unknown view/);
});

test('a big build fits in maxSize and a small one is drawn large', () => {
  const wall = [];
  for (let x = 0; x < 200; x++) wall.push({ x, y: 0, z: 0, block: 'stone' });
  const big = renderViews(wall, { views: ['south'], maxSize: 400 })[0];
  assert.ok(big.width <= 400 && big.height <= 400);
  const small = one('stone', 'south');
  assert.ok(small.width >= 40, `one block is ${small.width} wide`);
});

test('one wool block shows its top and two sides in three shades of its colour', () => {
  const img = decodePng(one('red_wool').png);
  const top = sample(img, 0.5, 0.22);
  const left = sample(img, 0.27, 0.6);
  const right = sample(img, 0.73, 0.6);
  for (const c of [top, left, right]) assert.ok(c[0] > 2 * c[1] && c[0] > 2 * c[2], `not red: ${c}`);
  assert.ok(top[0] > left[0] + 8 && top[0] > right[0] + 8);
  assert.ok(Math.abs(left[0] - right[0]) > 8);
});

test('a bottom slab is drawn about half as tall as a full block', () => {
  const img = decodePng(renderViews([{ x: 0, y: 0, z: 0, block: 'stone' }, { x: 2, y: 0, z: 0, block: 'stone_slab[type=bottom]' }], { views: ['south'] })[0].png);
  const rows = (fx) => {
    const x = Math.round(img.width * fx);
    let n = 0;
    for (let y = 0; y < img.height; y++) if (img.at(x, y)[0] < 180) n++;
    return n;
  };
  const ratio = rows(5 / 6) / rows(1 / 6);
  assert.ok(ratio > 0.4 && ratio < 0.6, `slab to block ratio ${ratio}`);
});

test('stairs facing east and west look different from the same side', () => {
  const east = one('oak_stairs[facing=east,half=bottom]');
  const west = one('oak_stairs[facing=west,half=bottom]');
  assert.equal(east.width, west.width);
  assert.notDeepEqual(decodePng(east.png).pixels, decodePng(west.png).pixels);
  const upsideDown = one('oak_stairs[facing=east,half=top]');
  assert.notDeepEqual(decodePng(east.png).pixels, decodePng(upsideDown.png).pixels);
});

test('a block shut in on every side does not change the picture', () => {
  const cube = (middle) => {
    const out = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) out.push({ x, y, z, block: x === 1 && y === 1 && z === 1 ? middle : 'stone' });
    return out;
  };
  for (const view of ['south-east', 'top', 'west']) {
    const [a] = renderViews(cube('stone'), { views: [view] });
    const [b] = renderViews(cube('gold_block'), { views: [view] });
    assert.ok(a.png.equals(b.png), view);
  }
});

test('unknown block names are drawn grey and reported', () => {
  const [r] = renderViews([{ x: 0, y: 0, z: 0, block: 'mystery_block' }, { x: 1, y: 0, z: 0, block: 'oak_planks' }], { views: ['top'] });
  assert.deepEqual(r.unknown, ['mystery_block']);
  assert.equal(blockStyle('mystery_block').known, false);
});

test('maxY leaves out everything above it', () => {
  const tower = [0, 1, 2, 3, 4].map((y) => ({ x: 0, y, z: 0, block: y % 2 ? 'bricks' : 'stone' }));
  const [cut] = renderViews(tower, { views: ['south-east'], maxY: 1 });
  const [low] = renderViews(tower.slice(0, 2), { views: ['south-east'] });
  const [all] = renderViews(tower, { views: ['south-east'] });
  assert.ok(cut.png.equals(low.png));
  assert.ok(all.height / all.width > cut.height / cut.width);
});

test('the plan and the elevations have the build\'s proportions', () => {
  const blocks = [];
  for (let x = 0; x < 10; x++) for (let z = 0; z < 2; z++) blocks.push({ x, y: 0, z, block: 'cobblestone' });
  const [top] = renderViews(blocks, { views: ['top'] });
  const plan = (top.width - 28) / (top.height - 28);
  assert.ok(plan > 4.6 && plan < 5.4, `plan ratio ${plan}`);
  const wall = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 3; y++) wall.push({ x, y, z: 0, block: 'stone_bricks' });
  const [south, east] = renderViews(wall, { views: ['south', 'east'] });
  const front = (south.width - 28) / (south.height - 28);
  assert.ok(front > 1.8 && front < 2.1, `south ratio ${front}`);
  assert.ok(east.width < south.width / 3);
});

test('derived blocks take their base colour and similar blocks stay apart', () => {
  assert.deepEqual(blockStyle('oak_stairs').color, blockStyle('oak_planks').color);
  assert.deepEqual(blockStyle('stone_brick_wall').color, blockStyle('stone_bricks').color);
  assert.deepEqual(blockStyle('cobblestone_slab').color, blockStyle('cobblestone').color);
  assert.deepEqual(blockStyle('light_blue_carpet').color, blockStyle('light_blue_wool').color);
  assert.notDeepEqual(blockStyle('mossy_stone_bricks'), blockStyle('stone_bricks'));
  assert.notDeepEqual(blockStyle('cracked_stone_bricks'), blockStyle('stone_bricks'));
  for (const name of ['spruce_log', 'deepslate_tile_stairs', 'weathered_cut_copper_slab', 'deepslate_diamond_ore', 'cyan_glazed_terracotta', 'soul_wall_torch', 'cherry_leaves', 'iron_door']) {
    assert.equal(blockStyle(name).known, true, name);
  }
  assert.equal(shapeOf('oak_fence_gate'), 'gate');
  assert.equal(shapeOf('cobblestone_wall'), 'wall');
  assert.equal(shapeOf('oak_wall_sign'), 'wall_sign');
  assert.equal(shapeOf('wall_torch'), 'wall_torch');
  assert.equal(shapeOf('sea_lantern'), 'cube');
});

const BACKGROUND = [240, 238, 232];
const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('muted cells are drawn nearer the background and never reported unknown', () => {
  const plain = decodePng(one('stone').png);
  const quiet = decodePng(renderViews([{ x: 0, y: 0, z: 0, block: 'stone', muted: true }], { views: ['south-east'] })[0].png);
  const a = sample(plain, 0.5, 0.22);
  const b = sample(quiet, 0.5, 0.22);
  assert.ok(distance(b, BACKGROUND) < distance(a, BACKGROUND) * 0.7, `${a} against ${b}`);
  const [r] = renderViews([{ x: 0, y: 0, z: 0, block: 'mystery_block', muted: true }, { x: 1, y: 0, z: 0, block: 'other_mystery' }], { views: ['top'] });
  assert.deepEqual(r.unknown, ['other_mystery']);
});

test('a planned block keeps its outline against the same block in the muted world', () => {
  const row = (muted) => decodePng(renderViews([{ x: 0, y: 0, z: 0, block: 'stone' }, { x: 1, y: 0, z: 0, block: 'stone', muted }], { views: ['south'] })[0].png);
  // Two blocks, 64 px each after a 14 px margin: the line between them is at x 78.
  const darkest = (img) => Math.min(...[75, 76, 77, 78, 79, 80].map((x) => img.at(x, 46)[0]));
  assert.ok(darkest(row(true)) < darkest(row(false)) * 0.7);
  // Culling is the same: a muted block on top still hides the planned block's top.
  const covered = renderViews([{ x: 0, y: 0, z: 0, block: 'gold_block' }, { x: 0, y: 1, z: 0, block: 'stone', muted: true }], { views: ['top'] })[0];
  const img = decodePng(covered.png);
  const c = sample(img, 0.5, 0.5);
  assert.ok(Math.abs(c[0] - c[2]) < 20, `gold shows through: ${c}`);
});

test('every potted plant draws as a pot, and only technical blocks of the game are unknown', () => {
  assert.equal(shapeOf('potted_red_tulip'), 'pot');
  assert.equal(blockStyle('potted_red_tulip').known, true);
  assert.deepEqual(renderViews([{ x: 0, y: 0, z: 0, block: 'potted_red_tulip' }], { views: ['top'] })[0].unknown, []);
  const requireMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
  const names = Object.keys(requireMf('minecraft-data')('26.1').blocksByName);
  for (const name of names.filter((n) => n.startsWith('potted_'))) {
    assert.equal(shapeOf(name), 'pot', name);
    assert.equal(blockStyle(name).known, true, name);
  }
  const unknown = names.filter((n) => !blockStyle(n).known);
  assert.ok(unknown.length <= 20, unknown.join(', '));
  for (const name of ['white_tulip', 'oak_sapling', 'cherry_shelf', 'infested_stone_bricks', 'dragon_wall_head', 'brain_coral_fan', 'oxidized_lightning_rod', 'water_cauldron', 'candle_cake']) {
    assert.ok(!unknown.includes(name), name);
  }
});

test('mossy and cracked stone bricks stay close to plain ones and join them without a hard line', () => {
  // The average colour over the middle of the front face.
  const face = (block) => {
    const img = decodePng(one(block, 'south').png);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 24; y < 70; y++) {
      for (let x = 24; x < 70; x++) {
        img.at(x, y).forEach((v, i) => (sum[i] += v));
        n++;
      }
    }
    return sum.map((v) => v / n);
  };
  const plain = face('stone_bricks');
  for (const block of ['mossy_stone_bricks', 'cracked_stone_bricks']) assert.ok(distance(face(block), plain) < 16, block);
  // Mossy cobblestone is greener than cobblestone in game too, by about this much.
  assert.ok(distance(face('mossy_cobblestone'), face('cobblestone')) < 28);
  const img = decodePng(renderViews([{ x: 0, y: 0, z: 0, block: 'stone_bricks' }, { x: 1, y: 0, z: 0, block: 'mossy_stone_bricks' }], { views: ['south'] })[0].png);
  // Partway up the upper brick row, away from the mortar, the join is only a faint line.
  const y = 14 + Math.round(64 * 0.3);
  const around = [60, 64, 92, 96].map((x) => img.at(x, y)[0]);
  const mean = around.reduce((s, v) => s + v, 0) / around.length;
  const join = Math.min(...[76, 77, 78, 79].map((x) => img.at(x, y)[0]));
  assert.ok(join > mean * 0.8, `join ${join} against ${mean}`);
});

test('chests have a latch and a lid line, unlike barrels, and two side by side join', () => {
  const latched = (block) => {
    const img = decodePng(one(block, 'south').png);
    let n = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const [r, g, b] = img.at(i % img.width, Math.floor(i / img.width));
      if (r > 150 && r < 205 && Math.abs(r - g) < 6 && r - b > 4 && r - b < 20) n++;
    }
    return n;
  };
  assert.ok(latched('chest[facing=south]') > 10);
  assert.equal(latched('barrel'), 0);
  const pair = (second) => decodePng(renderViews([{ x: 0, y: 0, z: 0, block: 'chest[facing=south]' }, { x: 1, y: 0, z: 0, block: second }], { views: ['south'] })[0].png);
  // Low down at the join (x 78), so the latch is not in the way.
  const gap = (img) => img.at(78, img.height - 24);
  assert.ok(distance(gap(pair('chest[facing=south]')), BACKGROUND) > 40);
  assert.ok(distance(gap(pair('chest[facing=north]')), BACKGROUND) < 10);
});

test('see-through blocks let what is behind show', () => {
  const behind = [{ x: 0, y: 0, z: 0, block: 'red_wool' }];
  const [plain] = renderViews(behind, { views: ['south'] });
  const [glassed] = renderViews([...behind, { x: 0, y: 0, z: 1, block: 'glass' }], { views: ['south'] });
  const c = sample(decodePng(glassed.png), 0.5, 0.5);
  assert.ok(c[0] > c[1] + 40, `red not seen through glass: ${c}`);
  assert.equal(plain.width, glassed.width);
});
