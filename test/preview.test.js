import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { previewStructure, viewArea, saveRenders } from '../src/actions/preview.js';
import { buildStructure, expandPlan } from '../src/actions/build.js';
import { withGround, siteCells, MAX_SITE_CELLS, MAX_SITE_READS } from '../src/actions/preview.js';
import { checklistText } from '../src/designguide.js';

const requireMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = requireMf('prismarine-registry')('26.1');

// A renderer that records what it was asked to draw.
function fakeRenderer(unknown = []) {
  const calls = [];
  const renderViews = async (blocks, opts) => {
    calls.push({ blocks, opts });
    return opts.views.map((view) => ({ view, png: Buffer.from(`png of ${view}`), width: 10, height: 10, unknown }));
  };
  return { renderViews, calls };
}

// A bot far from anything, with world blocks from world (key "x,y,z" to a block), air elsewhere,
// and unloaded outside loaded(p) when given.
function makeCtx({ items = [], world = new Map(), loaded = () => true, renderer = fakeRenderer(), renders = null, signal } = {}) {
  const progress = [];
  const bot = {
    registry,
    entity: { position: new Vec3(500.5, 64, 500.5) },
    inventory: { items: () => items },
    blockAt: (p) => (loaded(p) ? (world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', getProperties: () => ({}) }) : null)
  };
  const ctx = { bot, config: { limits: { maxBuildBlocks: 500 } }, renderViews: renderer.renderViews, renders, signal, status: { progress: (text) => progress.push(text) } };
  return { ctx, renderer, progress };
}

const block = (name, props = {}) => ({ name, getProperties: () => props });
const cube = (name) => ({ ...block(name), boundingBox: 'block', transparent: false, shapes: [[0, 0, 0, 1, 1, 1]] });
const liquid = (name) => ({ ...block(name), boundingBox: 'empty', transparent: true, shapes: [] });

const walls = { shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 4, dy: 2, dz: 4 }, block: 'oak_planks' };
const door = { dx: 2, dy: 0, dz: 0, block: 'air' };
const plan = { origin: { x: 10, y: 64, z: 20 }, parts: [walls], blocks: [door] };

test('a preview draws the expanded plan and says its size, block count and items', async () => {
  const { ctx, renderer, progress } = makeCtx({ items: [{ name: 'oak_planks', count: 10 }] });
  const result = await previewStructure(ctx, plan);
  assert.equal(result.ok, true);
  const expected = expandPlan(ctx.bot, plan).map((b) => ({ x: 10 + b.dx, y: 64 + b.dy, z: 20 + b.dz, block: b.block }));
  assert.deepEqual(renderer.calls.map((c) => c.opts.views[0]), ['south-east', 'north-west', 'top']);
  for (const call of renderer.calls) {
    assert.deepEqual(call.blocks, expected);
    assert.equal(call.opts.maxY, null);
  }
  assert.match(result.message, /^Preview, nothing placed: 5 wide \(x 10\.\.14\), 3 high \(y 64\.\.66\), 5 deep \(z 20\.\.24\)\. /);
  assert.match(result.message, new RegExp(`Plan: ${expected.length} blocks, 0 already in place\\. Needs ${expected.length} oak_planks\\. Missing: oak_planks \\(need ${expected.length}, have 10`));
  assert.deepEqual(result.images.map((i) => i.label.split(' ')[0]), ['south-east', 'north-west', 'top']);
  assert.equal(result.images[0].media_type, 'image/png');
  assert.equal(Buffer.from(result.images[0].data, 'base64').toString(), 'png of south-east');
  assert.equal(progress.length, 4);
});

test('a preview passes views and cut_above on to the renderer', async () => {
  const { ctx, renderer } = makeCtx();
  const result = await previewStructure(ctx, { ...plan, views: ['north', 'east'], cut_above: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(renderer.calls.map((c) => c.opts), [{ views: ['north'], maxY: 65 }, { views: ['east'], maxY: 65 }]);
  assert.match(result.images[0].label, /everything above y 65 left out/);
  assert.match(result.message, /Cut above dy 1 \(y 65\): \d+ of the \d+ blocks are drawn/);
});

test('a big plan gets no top view unless asked for', async () => {
  const { ctx, renderer } = makeCtx();
  const long = { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'line', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 40, dy: 0, dz: 0 }, block: 'oak_planks' }] };
  await previewStructure(ctx, long);
  assert.deepEqual(renderer.calls.map((c) => c.opts.views[0]), ['south-east', 'north-west']);
});

test('a bad plan fails the way build_structure does, and nothing is drawn', async () => {
  for (const bad of [
    { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'poplar_planks' }] },
    { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_stairs[facing=up]' }] },
    { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 99, dy: 99, dz: 99 }, block: 'stone' }] }
  ]) {
    const { ctx, renderer } = makeCtx();
    const result = await previewStructure(ctx, bad);
    const built = await buildStructure(ctx, { ...bad, dry_run: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result, built);
    assert.equal(renderer.calls.length, 0);
  }
});

test('a preview refuses unknown views and too many of them', async () => {
  const { ctx } = makeCtx();
  assert.match((await previewStructure(ctx, { ...plan, views: ['up'] })).message, /unknown view: up/);
  assert.match((await previewStructure(ctx, { ...plan, views: ['north', 'south', 'east', 'west', 'top'] })).message, /at most 4 views/);
});

test('a stopped preview says so and hands back no pictures', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  const { ctx } = makeCtx({ signal: controller.signal });
  const result = await previewStructure(ctx, plan);
  assert.equal(result.ok, false);
  assert.equal(result.images, undefined);
  assert.match(result.message, /stopped before the pictures were done/);
});

test('blocks the renderer does not know are named', async () => {
  const { ctx } = makeCtx({ renderer: fakeRenderer(['oak_planks']) });
  const result = await previewStructure(ctx, plan);
  assert.match(result.message, /The renderer didn't know oak_planks, so it may not look right\./);
});

test('view_area reads the box, counts what it holds and draws it', async () => {
  const world = new Map();
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) world.set(`${x},63,${z}`, block('grass_block'));
  world.set('1,64,1', block('oak_stairs', { facing: 'east', half: 'top', shape: 'straight', waterlogged: false }));
  const { ctx, renderer } = makeCtx({ world });
  const result = await viewArea(ctx, { x1: 2, y1: 65, z1: 2, x2: 0, y2: 63, z2: 0 });
  assert.equal(result.ok, true);
  assert.match(result.message, /^The box from 0 63 0 to 2 65 2 \(3 by 3 by 3, x by y by z\) holds 9 grass_block, 1 oak_stairs, and 17 air\./);
  const drawn = renderer.calls[0].blocks;
  assert.equal(drawn.length, 10);
  assert.deepEqual(drawn.find((b) => b.y === 64), { x: 1, y: 64, z: 1, block: 'oak_stairs[facing=east,half=top]' });
  assert.equal(result.images.length, 3);

  const cut = makeCtx({ world });
  await viewArea(cut.ctx, { x1: 0, y1: 63, z1: 0, x2: 2, y2: 65, z2: 2, views: ['south'], cut_above: 0 });
  assert.deepEqual(cut.renderer.calls[0].opts, { views: ['south'], maxY: 63 });
});

test('view_area lumps the rarer kinds together', async () => {
  const world = new Map();
  const names = ['stone', 'dirt', 'sand', 'gravel', 'clay', 'oak_log', 'oak_leaves', 'glass'];
  names.forEach((name, i) => {
    for (let n = 0; n <= names.length - i; n++) world.set(`${n},${i},0`, block(name));
  });
  const { ctx } = makeCtx({ world });
  const result = await viewArea(ctx, { x1: 0, y1: 0, z1: 0, x2: 9, y2: 7, z2: 0 });
  assert.match(result.message, /holds 9 stone, 8 dirt, 7 sand, 6 gravel, 5 clay, 4 oak_log, 5 of 2 other kinds, and \d+ air\./);
});

test('view_area refuses a box that is too big or not all loaded', async () => {
  const { ctx, renderer } = makeCtx({ loaded: (p) => p.x < 5 });
  const big = await viewArea(ctx, { x1: 0, y1: 0, z1: 0, x2: 48, y2: 10, z2: 10 });
  assert.equal(big.ok, false);
  assert.match(big.message, /49 by 11 by 11 .*the limit is 48 on each side/);
  const far = await viewArea(ctx, { x1: 0, y1: 64, z1: 0, x2: 8, y2: 64, z2: 0 });
  assert.equal(far.ok, false);
  assert.match(far.message, /part of the box is not loaded, like 5 64 0/);
  assert.equal(renderer.calls.length, 0);
});

test('view_area of only air draws nothing', async () => {
  const { ctx, renderer } = makeCtx();
  const result = await viewArea(ctx, { x1: 0, y1: 100, z1: 0, x2: 2, y2: 101, z2: 2 });
  assert.equal(result.ok, true);
  assert.match(result.message, /holds only air/);
  assert.equal(result.images, undefined);
  assert.equal(renderer.calls.length, 0);
});

test('the pictures are saved to the renders folder, keeping the newest 60', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'renders-'));
  try {
    for (let i = 0; i < 59; i++) writeFileSync(join(dir, `2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z-view_area-top.png`), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'kept');
    const { ctx } = makeCtx({ renders: dir });
    await previewStructure(ctx, plan);
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    assert.equal(files.length, 60);
    assert.equal(files.filter((f) => f.includes('-preview_structure-')).length, 3);
    assert.ok(files.every((f) => !f.startsWith('2000-01-01T00-00-00') && !f.startsWith('2000-01-01T00-00-01')));
    assert.ok(readdirSync(dir).includes('notes.txt'));

    const paths = saveRenders(dir, 'view_area', [{ view: 'top', png: Buffer.from('x') }], new Date('2030-01-01T00:00:00Z'), 2);
    assert.deepEqual(paths, [join(dir, '2030-01-01T00-00-00-000Z-view_area-top.png')]);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.png')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a preview ends with the checklist on lines of its own, and view_area does not', async () => {
  const { ctx } = makeCtx();
  const result = await previewStructure(ctx, plan);
  assert.ok(result.message.endsWith(`\n\n${checklistText()}`));
  const world = new Map([['0,64,0', block('stone')]]);
  const looked = await viewArea(makeCtx({ world }).ctx, { x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1 });
  assert.equal(looked.ok, true);
  assert.ok(!looked.message.includes(checklistText().split('\n')[0]));
});

test('an unloaded site gets flat grass round the plan, drawn but not counted, and a plan block at dy -1 shows instead', async () => {
  const path = { origin: { x: 10, y: 64, z: 20 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 1, dy: -1, dz: 0, block: 'dirt_path' }] };
  const { ctx, renderer } = makeCtx({ loaded: () => false });
  const result = await previewStructure(ctx, path);
  assert.equal(result.ok, true);
  const drawn = renderer.calls[0].blocks;
  // The plan spans x 10..11 and z 20, so the ground is 6 by 5 with the path's cell left out.
  const grass = drawn.filter((b) => b.block === 'grass_block');
  assert.equal(grass.length, 6 * 5 - 1);
  assert.ok(grass.every((b) => b.y === 63));
  assert.ok(!grass.some((b) => b.x === 11 && b.z === 20));
  assert.deepEqual(drawn.slice(0, 2), [{ x: 10, y: 64, z: 20, block: 'oak_planks' }, { x: 11, y: 63, z: 20, block: 'dirt_path' }]);
  assert.match(result.message, /Plan: 2 blocks, 0 already in place\. Needs 1 dirt_path, 1 oak_planks\./);
  assert.match(result.message, /The ground at y 63 \(dy -1\) is drawn only, never built or counted: flat grass, since the site is not loaded\./);
  assert.doesNotMatch(result.message, /grass_block/);
});

test('a loaded site gets the blocks really there as its ground, air left out, and a foundation is not drawn', async () => {
  const world = new Map();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x !== 2) world.set(`${x},63,${z}`, cube('stone'));
  const { ctx, renderer } = makeCtx({ world });
  const one = { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }], foundation: 'cobblestone' };
  const result = await previewStructure(ctx, one);
  const ground = renderer.calls[0].blocks.slice(1);
  assert.equal(ground.length, 20);
  assert.ok(ground.every((b) => b.block === 'stone' && b.y === 63 && b.x !== 2));
  assert.match(result.message, /The real surroundings are drawn too, never built or counted: the world from y 60 to y 63 \(dy -1\) round the plan/);
  assert.match(result.message, /The foundation is not drawn: it fills down to the real ground when building\./);
});

test('real terrain below the ground and water are drawn, hidden stone is left out, and none of it is counted', async () => {
  // A pier going down into a river three deep, on stone.
  const world = new Map();
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 61; y <= 63; y++) world.set(`${x},${y},${z}`, liquid('water'));
      for (let y = 55; y <= 60; y++) world.set(`${x},${y},${z}`, cube('stone'));
    }
  }
  const { ctx, renderer } = makeCtx({ world });
  const pier = { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 0, dy: -3, dz: 0, block: 'cobblestone' }] };
  const result = await previewStructure(ctx, pier);
  assert.equal(result.ok, true);
  const drawn = renderer.calls[0].blocks;
  assert.deepEqual(drawn.slice(0, 2), [{ x: 0, y: 64, z: 0, block: 'oak_planks' }, { x: 0, y: 61, z: 0, block: 'cobblestone' }]);
  const water = drawn.filter((b) => b.block === 'water');
  // Three layers of 5 by 5, less the pier's own cell.
  assert.equal(water.length, 74);
  assert.ok(!water.some((b) => b.x === 0 && b.y === 61 && b.z === 0));
  const stone = drawn.filter((b) => b.block === 'stone');
  // Drawn from y 58: the top layer whole, then only the outside of the two below it.
  assert.equal(stone.length, 25 + 16 + 16);
  assert.ok(stone.every((b) => b.y >= 58 && b.y <= 60));
  assert.ok(!stone.some((b) => b.y < 60 && Math.abs(b.x) < 2 && Math.abs(b.z) < 2));
  assert.match(result.message, /Plan: 2 blocks, 0 already in place\./);
  assert.match(result.message, /the world from y 58 to y 63 \(dy -1\)/);
  assert.doesNotMatch(result.message, /water/);
});

test('a real block inside the build\'s box above the ground is drawn unless the plan has a block there, and clear leaves natural ones out', async () => {
  const world = new Map([
    ['12,64,22', cube('dirt')],
    ['12,65,22', cube('oak_planks')],
    ['12,64,21', block('short_grass')],
    ['16,64,20', cube('stone')],
    ['10,65,20', cube('oak_log')]
  ]);
  const above = (input) => {
    const { ctx, renderer } = makeCtx({ world });
    return previewStructure(ctx, input).then((result) => ({ result, terrain: renderer.calls[0].blocks.slice(expandPlan(ctx.bot, plan).length) }));
  };
  const plain = await above({ ...plan, replace: true });
  assert.equal(plain.result.ok, true);
  assert.deepEqual(plain.terrain, [{ x: 12, y: 64, z: 22, block: 'dirt', muted: true }, { x: 12, y: 65, z: 22, block: 'oak_planks', muted: true }]);
  const cleared = await above({ ...plan, clear: true });
  assert.equal(cleared.result.ok, true);
  assert.deepEqual(cleared.terrain, [{ x: 12, y: 65, z: 22, block: 'oak_planks', muted: true }]);
  assert.match(cleared.result.message, /\(natural blocks that clear would dig left out\)/);
});

test('siteCells gives up past its caps, and a preview then falls back to the ground layer', async () => {
  const read = () => ({ block: 'water', solid: false, sweep: false, natural: false });
  const one = [{ x: 0, y: 0, z: 0, block: 'oak_planks' }];
  assert.equal(siteCells(read, one, -1).cells.length, 25 * 4);
  assert.deepEqual(siteCells(read, one, -1, { maxCells: 99 }), { error: 'too big' });
  assert.deepEqual(siteCells(read, one, -1, { maxReads: 99 }), { error: 'too big' });
  assert.deepEqual(siteCells(() => undefined, one, -1), { error: 'not loaded' });
  assert.ok(MAX_SITE_CELLS > 0 && MAX_SITE_READS > MAX_SITE_CELLS);

  // Two posts far apart make a site too big to read whole, so only the layer at dy -1 is drawn.
  const world = new Map([['0,63,0', cube('stone')], ['0,62,0', cube('stone')]]);
  const { ctx, renderer } = makeCtx({ world });
  const far = { origin: { x: 0, y: 64, z: 0 }, blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }, { dx: 200, dy: 0, dz: 200, block: 'oak_planks' }] };
  const result = await previewStructure(ctx, far);
  assert.equal(result.ok, true);
  assert.deepEqual(renderer.calls[0].blocks.slice(2), [{ x: 0, y: 63, z: 0, block: 'stone', muted: true }]);
  assert.ok(renderer.calls[0].blocks.slice(0, 2).every((b) => !b.muted));
  assert.match(result.message, /The ground at y 63 \(dy -1\) is drawn only, never built or counted: the blocks really there, only that layer, since the surroundings are too big to draw whole\./);
});

test('withGround leaves its input alone and keeps deeper columns in sight', () => {
  const cells = [
    { x: 0, y: 0, z: 0, block: 'oak_planks' },
    { x: 1, y: -3, z: 0, block: 'cobblestone' },
    { x: 2, y: -1, z: 0, block: 'gravel' }
  ];
  const before = structuredClone(cells);
  const first = withGround(cells, -1, { margin: 1 });
  assert.deepEqual(cells, before);
  assert.deepEqual(withGround(cells, -1, { margin: 1 }), first);
  assert.deepEqual(first.slice(0, 3), before);
  const grass = first.slice(3);
  // x -1..3 by z -1..1 is 15 columns, less the cellar column and the gravel.
  assert.equal(grass.length, 13);
  assert.ok(!grass.some((b) => b.z === 0 && (b.x === 1 || b.x === 2)));
  assert.deepEqual(withGround([], -1), []);
  assert.deepEqual(withGround(cells, -1, { margin: 0, ground: (x) => (x === 0 ? 'sand' : null) }).slice(3), [{ x: 0, y: -1, z: 0, block: 'sand' }]);
});
