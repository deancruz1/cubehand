import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { ok, fail, posText } from './util.js';
import { buildStructure, expandPlan, buildSite, sweepable } from './build.js';
import { isClearable } from './house.js';
import { isAir } from './blocks.js';
import { stateText } from './states.js';
import { checklistText } from '../designguide.js';

export const VIEWS = ['south-east', 'south-west', 'north-east', 'north-west', 'top', 'south', 'north', 'east', 'west'];
// Two isometric views from opposite corners show every side once.
const CORNER_VIEWS = ['south-east', 'north-west'];
// Each picture costs tokens on every later step, so a call draws at most this many.
const MAX_VIEWS = 4;
// A top view only gets added by default when the footprint is at most this wide and deep.
const TOP_VIEW_SIDE = 32;
export const MAX_VIEW_SIDE = 48;
export const KEEP_RENDERS = 60;
// The kinds of block view_area names before it lumps the rest together.
const MAIN_KINDS = 6;
// How far the drawn ground reaches past a previewed plan, and how far the real surroundings go
// below the lowest of the plan and the ground.
const GROUND_MARGIN = 2;
const SITE_BELOW = 3;
// The most blocks of the world a preview reads round a plan, and the most of them it draws.
export const MAX_SITE_READS = 100000;
export const MAX_SITE_CELLS = 8000;

const span = (a, b) => (a === b ? `${a}` : `${a}..${b}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The views to draw, or { error }.
function pickViews(views, width, depth) {
  if (views === undefined || views === null || (Array.isArray(views) && views.length === 0)) {
    return Math.max(width, depth) <= TOP_VIEW_SIDE ? [...CORNER_VIEWS, 'top'] : [...CORNER_VIEWS];
  }
  if (!Array.isArray(views)) return { error: `views is a list of view names: ${VIEWS.join(', ')}` };
  const unknown = views.filter((v) => !VIEWS.includes(v));
  if (unknown.length) return { error: `unknown view: ${unknown.join(', ')}. The views are ${VIEWS.join(', ')}` };
  const chosen = [...new Set(views)];
  if (chosen.length > MAX_VIEWS) return { error: `at most ${MAX_VIEWS} views in one call, you asked for ${chosen.length}` };
  return chosen;
}

function viewLabel(view, cutY) {
  const where = view === 'top' ? 'from straight above' : view.includes('-') ? `from the ${view} corner, from above` : `from the ${view}, straight on`;
  return `${view} (${where}${cutY === null ? '' : `, everything above y ${cutY} left out`})`;
}

// Draws each view in turn, so a long render reports progress and can be stopped between views.
// Returns { shots, unknown } or { error }.
async function drawViews(ctx, blocks, views, maxY) {
  let renderViews = ctx.renderViews;
  if (!renderViews) {
    try {
      ({ renderViews } = await import('../render.js'));
    } catch (err) {
      ctx.log?.(`[render] couldn't load the renderer: ${err.message}`);
      return { error: `couldn't load the renderer (${err.code ?? err.message})` };
    }
  }
  const shots = [];
  const unknown = new Set();
  for (const [i, view] of views.entries()) {
    if (ctx.signal?.aborted) return { error: 'stopped before the pictures were done' };
    ctx.status?.progress(`drawing the ${view} view (${i + 1} of ${views.length})`);
    const [shot] = await renderViews(blocks, { views: [view], maxY });
    if (!shot?.png) return { error: `the renderer drew nothing for the ${view} view` };
    shots.push({ ...shot, view });
    for (const name of shot.unknown ?? []) unknown.add(name);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (ctx.signal?.aborted) return { error: 'stopped before the pictures were done' };
  return { shots, unknown: [...unknown] };
}

// Keeps the pictures in dir so the owner can see what she saw, only the newest keep of them.
// Returns the paths written.
export function saveRenders(dir, tool, shots, now = new Date(), keep = KEEP_RENDERS) {
  if (!dir) return [];
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const paths = shots.map((shot) => {
    const path = join(dir, `${stamp}-${tool}-${shot.view}.png`);
    writeFileSync(path, shot.png);
    return path;
  });
  // The names start with the time, so they sort oldest first.
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  for (const old of files.slice(0, Math.max(files.length - keep, 0))) rmSync(join(dir, old), { force: true });
  return paths;
}

// Draws blocks and returns the result with the pictures, or a failure. tail goes on lines of its
// own at the end.
async function pictures(ctx, tool, blocks, views, cutY, text, tail = '') {
  const drawn = await drawViews(ctx, blocks, views, cutY);
  if (drawn.error) return fail(`${text} No pictures: ${drawn.error}.`);
  try {
    saveRenders(ctx.renders, tool, drawn.shots);
  } catch (err) {
    ctx.log?.(`[render] couldn't save the pictures: ${err.message}`);
  }
  const unknownText = drawn.unknown.length ? ` The renderer didn't know ${drawn.unknown.join(', ')}, so ${drawn.unknown.length === 1 ? 'it' : 'they'} may not look right.` : '';
  const images = drawn.shots.map((shot) => ({ media_type: 'image/png', data: shot.png.toString('base64'), label: viewLabel(shot.view, cutY) }));
  return { ...ok(`${text} Pictures: ${views.join(', ')}.${unknownText}${tail ? `\n\n${tail}` : ''}`), images };
}

// The ground a preview stands on, for drawing only: cells (each { x, y, z, block }) plus a layer at
// groundY over the plan's footprint and margin blocks round it. Where the plan has its own block
// at groundY (a path, a sunk floor) that shows instead, and a column where the plan goes deeper
// than groundY gets no ground, so a cellar or a well stays in sight. ground(x, z) names the block
// there, or null for none. Returns a new list and leaves cells as they were.
export function withGround(cells, groundY = -1, { margin = 2, ground = () => 'grass_block' } = {}) {
  if (cells.length === 0) return [];
  let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
  const taken = new Set();
  for (const c of cells) {
    [x0, x1, z0, z1] = [Math.min(x0, c.x), Math.max(x1, c.x), Math.min(z0, c.z), Math.max(z1, c.z)];
    if (c.y <= groundY) taken.add(`${c.x},${c.z}`);
  }
  const out = [...cells];
  for (let x = x0 - margin; x <= x1 + margin; x++) {
    for (let z = z0 - margin; z <= z1 + margin; z++) {
      if (taken.has(`${x},${z}`)) continue;
      const block = ground(x, z);
      if (block) out.push({ x, y: groundY, z, block });
    }
  }
  return out;
}

// The blocks really at groundY round a site, as a ground() for withGround (air gives none), or
// null when any of it is not loaded.
function worldGround(bot, min, max, groundY, margin) {
  const found = new Map();
  for (let x = min.x - margin; x <= max.x + margin; x++) {
    for (let z = min.z - margin; z <= max.z + margin; z++) {
      const block = bot.blockAt(new Vec3(x, groundY, z), false);
      if (!block) return null;
      found.set(`${x},${z}`, isAir(block.name) ? null : stateText(block));
    }
  }
  return (x, z) => found.get(`${x},${z}`) ?? null;
}

// What really stands round a plan, for drawing only, so a bridge shows its river and a house its
// slope: below and at groundY over the footprint and margin blocks round it, from below blocks
// under the lowest of the plan and groundY; above groundY only inside the plan's box, where the
// build will meet it. plan holds the plan's cells ({ x, y, z, block }), which win where they
// overlap. read(x, y, z) gives { block, solid, sweep, natural } for a block (solid is a full
// opaque cube, sweep a plant or snow the build takes off, natural what clear digs), null for air,
// or undefined where the world is not loaded. Above groundY sweep blocks are left out, and with
// clear natural ones too. A solid cell with every neighbour solid never shows, so it is left out
// (below the drawn part counts as solid, above maxY as open). Returns { cells }, or { error }
// when part is not loaded or it would read more than maxReads or draw more than maxCells.
export function siteCells(read, plan, groundY, { margin = GROUND_MARGIN, below = SITE_BELOW, clear = false, maxY = null, maxReads = MAX_SITE_READS, maxCells = MAX_SITE_CELLS } = {}) {
  if (plan.length === 0) return { cells: [] };
  let [x0, x1, y0, y1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  const own = new Set();
  for (const c of plan) {
    [x0, x1, y0, y1, z0, z1] = [Math.min(x0, c.x), Math.max(x1, c.x), Math.min(y0, c.y), Math.max(y1, c.y), Math.min(z0, c.z), Math.max(z1, c.z)];
    own.add(`${c.x},${c.y},${c.z}`);
  }
  const bottom = Math.min(y0, groundY) - below;
  const wide = (x1 - x0 + 1 + 2 * margin) * (z1 - z0 + 1 + 2 * margin);
  const reads = wide * (groundY - bottom + 1) + (x1 - x0 + 1) * (z1 - z0 + 1) * Math.max(y1 - groundY, 0);
  if (reads > maxReads) return { error: 'too big' };
  const found = new Map();
  const look = (x, y, z, high) => {
    const key = `${x},${y},${z}`;
    if (own.has(key)) return true;
    const info = read(x, y, z);
    if (info === undefined) return false;
    if (info === null || (high && (info.sweep || (clear && info.natural)))) return true;
    found.set(key, info);
    return true;
  };
  for (let x = x0 - margin; x <= x1 + margin; x++) {
    for (let z = z0 - margin; z <= z1 + margin; z++) {
      for (let y = bottom; y <= groundY; y++) if (!look(x, y, z, false)) return { error: 'not loaded' };
    }
  }
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = groundY + 1; y <= y1; y++) if (!look(x, y, z, true)) return { error: 'not loaded' };
    }
  }
  const hides = (x, y, z) => {
    if (maxY !== null && y > maxY) return false;
    if (y < bottom) return true;
    return Boolean(found.get(`${x},${y},${z}`)?.solid);
  };
  const cells = [];
  for (const [key, info] of found) {
    const [x, y, z] = key.split(',').map(Number);
    if (info.solid && hides(x + 1, y, z) && hides(x - 1, y, z) && hides(x, y + 1, z) && hides(x, y - 1, z) && hides(x, y, z + 1) && hides(x, y, z - 1)) continue;
    cells.push({ x, y, z, block: info.block });
    if (cells.length > maxCells) return { error: 'too big' };
  }
  return { cells };
}

// What the world holds at a spot, for siteCells.
function worldReader(bot) {
  return (x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z), false);
    if (!block) return undefined;
    if (isAir(block.name)) return null;
    const s = block.shapes;
    const cube = block.boundingBox === 'block' && !block.transparent && s?.length === 1 && s[0][0] === 0 && s[0][1] === 0 && s[0][2] === 0 && s[0][3] === 1 && s[0][4] === 1 && s[0][5] === 1;
    return { block: stateText(block), solid: cube, sweep: sweepable(block), natural: block.boundingBox === 'block' && isClearable(block.name) };
  };
}

// cut_above as the highest y drawn, or { error }.
function cutHeight(cutAbove, baseY) {
  if (cutAbove === undefined || cutAbove === null) return null;
  if (!Number.isInteger(cutAbove)) return { error: 'cut_above is a whole number of blocks above the bottom' };
  return baseY + cutAbove;
}

// Draws a build_structure plan without placing anything, so it can be looked over and changed
// before it is built. Takes the same plan, plus views and cut_above.
export async function previewStructure(ctx, input) {
  const { views, cut_above, dry_run, ...plan } = input;
  const { origin } = plan;
  // Checks the plan the way build_structure does, and lists the items it needs.
  const dry = await buildStructure(ctx, { ...plan, dry_run: true });
  if (!dry.ok) return dry;
  const all = expandPlan(ctx.bot, plan);
  if (all.length === 0) return fail('the plan has no blocks to show');
  const { min, max } = buildSite(origin, all);
  const width = max.x - min.x + 1;
  const height = max.y - min.y + 1;
  const depth = max.z - min.z + 1;
  const chosen = pickViews(views, width, depth);
  if (chosen.error) return fail(chosen.error);
  const cutY = cutHeight(cut_above, origin.y);
  if (cutY?.error) return fail(cutY.error);
  const world = all.map((b) => ({ x: origin.x + b.dx, y: origin.y + b.dy, z: origin.z + b.dz, block: b.block }));
  const shown = cutY === null ? world.length : world.filter((b) => b.y <= cutY).length;
  if (shown === 0) return fail(`nothing in the plan is at or below y ${cutY} (cut_above ${cut_above}), so there is nothing to draw`);
  const size = `${width} wide (x ${span(min.x, max.x)}), ${height} high (y ${span(min.y, max.y)}), ${depth} deep (z ${span(min.z, max.z)})`;
  const cutText = cutY === null ? '' : ` Cut above dy ${cut_above} (y ${cutY}): ${shown} of the ${world.length} blocks are drawn.`;
  // The real surroundings where the site is loaded and small enough, else the real ground layer,
  // else flat grass.
  const groundY = origin.y - 1;
  ctx.status?.progress('reading the site');
  const site = siteCells(worldReader(ctx.bot), world, groundY, { clear: plan.clear === true, maxY: cutY });
  let drawn;
  let groundText;
  if (site.cells) {
    drawn = [...world, ...site.cells.map((c) => ({ ...c, muted: true }))];
    const bottom = Math.min(min.y, groundY) - SITE_BELOW;
    groundText = ` The real surroundings are drawn too, never built or counted: the world from y ${bottom} to y ${groundY} (dy -1) round the plan, and what stands in the build's box where the plan has no block${plan.clear === true ? ' (natural blocks that clear would dig left out)' : ''}.`;
  } else {
    const real = worldGround(ctx.bot, min, max, groundY, GROUND_MARGIN);
    // The ground comes after the plan's own cells and is drawn quieter.
    drawn = withGround(world, groundY, { margin: GROUND_MARGIN, ...(real ? { ground: real } : {}) }).map((c, i) => (i < world.length ? c : { ...c, muted: true }));
    const why = site.error === 'too big' ? 'the surroundings are too big to draw whole' : 'the site is not loaded';
    groundText = ` The ground at y ${groundY} (dy -1) is drawn only, never built or counted: ${real ? `the blocks really there, only that layer, since ${why}` : `flat grass, since ${why}`}.`;
  }
  const foundationText = plan.foundation ? ' The foundation is not drawn: it fills down to the real ground when building.' : '';
  return pictures(ctx, 'preview_structure', drawn, chosen, cutY, `Preview, nothing placed: ${size}. ${dry.message}${cutText}${groundText}${foundationText}`, checklistText());
}

// Draws what stands in a box of the loaded world, terrain and all, and counts what it holds.
export async function viewArea(ctx, { x1, y1, z1, x2, y2, z2, views, cut_above }) {
  const { bot } = ctx;
  const min = new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
  const max = new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  const width = max.x - min.x + 1;
  const height = max.y - min.y + 1;
  const depth = max.z - min.z + 1;
  if (Math.max(width, height, depth) > MAX_VIEW_SIDE) {
    return fail(`the box is ${width} by ${height} by ${depth} (x by y by z), the limit is ${MAX_VIEW_SIDE} on each side. Look at it in parts.`);
  }
  const chosen = pickViews(views, width, depth);
  if (chosen.error) return fail(chosen.error);
  const cutY = cutHeight(cut_above, min.y);
  if (cutY?.error) return fail(cutY.error);

  ctx.status?.progress('reading the blocks in the box');
  const blocks = [];
  const kinds = new Map();
  let air = 0;
  for (let y = min.y; y <= max.y; y++) {
    if (ctx.signal?.aborted) return fail('stopped before the box was read');
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        const p = new Vec3(x, y, z);
        const block = bot.blockAt(p, false);
        if (!block) return fail(`part of the box is not loaded, like ${posText(p)}. Get closer to it, or look at a box nearer to you.`);
        if (isAir(block.name)) {
          air++;
          continue;
        }
        kinds.set(block.name, (kinds.get(block.name) ?? 0) + 1);
        if (cutY === null || y <= cutY) blocks.push({ x, y, z, block: stateText(block) });
      }
    }
  }
  const sorted = [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const main = sorted.slice(0, MAIN_KINDS).map(([name, n]) => `${n} ${name}`);
  const others = sorted.slice(MAIN_KINDS);
  if (others.length) main.push(`${others.reduce((n, [, c]) => n + c, 0)} of ${plural(others.length, 'other kind')}`);
  const box = `The box from ${posText(min)} to ${posText(max)} (${width} by ${height} by ${depth}, x by y by z) holds`;
  if (kinds.size === 0) return ok(`${box} only air, so there is nothing to draw.`);
  const holds = `${box} ${main.join(', ')}, and ${air} air.`;
  if (blocks.length === 0) return ok(`${holds} Nothing but air is at or below y ${cutY} (cut_above ${cut_above}), so there is nothing to draw.`);
  const cutText = cutY === null ? '' : ` Cut above dy ${cut_above} (y ${cutY}): ${blocks.length} blocks are drawn.`;
  return pictures(ctx, 'view_area', blocks, chosen, cutY, `${holds}${cutText}`);
}
