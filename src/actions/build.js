import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText } from './util.js';
import { placeOne, takeDownScaffold, digBlock, findReference, referenceWays, isReplaceable, isDoubleSlab, blockStateProblem, protectedReason, inReach, stepOff, isAir, isProtected } from './blocks.js';
import { watchScaffold, walkTo, underBot, playerPlaced, SCAFFOLD_BLOCKS } from './movement.js';
import { parseBlock, blockText, stateText, itemFor, matchesState, placementOptions } from './states.js';
import { takeItems } from './containers.js';
import { collectDrops, gainedText } from './items.js';
import { pickSource } from '../chests.js';
import { expandShapes, partCopies, PlanError, turnState, material, blockFor } from './shapes.js';
import { isClearable } from './house.js';
import { isBuiltBlock } from './mining.js';

export { turnState };

const { GoalLookAtBlock } = pathfinderPkg.goals;

// As in blocks.js: how far from the eyes a block can be placed without walking.
const REACH = 4.5;
// Walks in a row that fail to get near a group's blocks before the rest of that group is skipped.
const GIVE_UP_AFTER = 3;

// Turns shapes into single blocks, in order, so later parts win where they overlap. A part of
// "air" takes out what came before it there (doorways, windows). opts can carry the plan's
// palette and mirror, slabFor and isKnownBlock; see shapes.js. Throws a PlanError for a plan
// it can't read.
export function expandParts(parts = [], blocks = [], opts = {}) {
  return expandShapes(parts, blocks, opts);
}

// A whole build_structure plan as single blocks, with the bot's own block names for slabs and
// derived forms. The spots the plan marks as air are in the result's air.
export function expandPlan(bot, { parts = [], blocks = [], palette, mirror } = {}) {
  return expandShapes(parts, blocks, { palette, mirror, slabFor: slabFinder(bot), isKnownBlock: (name) => Boolean(bot.registry.blocksByName[name]) });
}

// How far down a foundation goes to reach the ground.
const FOUNDATION_DEPTH = 6;
// The most blocks of a build's box that get looked over for clearing and sweeping.
const SITE_BOX_MAX = 65536;
// Rounds of checking a finished build for what got disturbed while it went up.
const CHECK_ROUNDS = 3;

const keyOf = (p) => `${p.x},${p.y},${p.z}`;

// A block she placed herself, as build_house counts them: a torch that went on a wall and the
// top half of her door count too.
function ownBlock(ctx, pos, name) {
  if (ctx.placed?.has(pos, name)) return true;
  if (name === 'wall_torch' && ctx.placed?.has(pos, 'torch')) return true;
  return name.endsWith('_door') && Boolean(ctx.placed?.has(pos.offset(0, -1, 0), name));
}

// Snow layers, grass, flowers, leaf litter and the like: what may always be taken off a site.
export function sweepable(block) {
  if (!block || isAir(block.name) || ['water', 'lava', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'].includes(block.name)) return false;
  return block.name === 'snow' || isReplaceable(block.name) || (isClearable(block.name) && block.boundingBox !== 'block');
}

// Blocks that keep something in them (items, text, a pattern), which never come out for a build.
const KEEPS_THINGS = /sign$|_bed$|banner$|_head$|_skull$|^beacon$|^spawner$|^trial_spawner$|^vault$|^enchanting_table$|campfire$|^bell$|^conduit$|bee_nest$|^beehive$|^ender_chest$|^sculk_|^creaking_heart$|command_block$|^structure_block$|^jigsaw$|^comparator$|^daylight_detector$|^end_gateway$|^end_portal$|^suspicious_/;
// Blocks not hers and not natural that one build_structure call may take out of its own spots
// without a player saying to build over them.
export const FOREIGN_LIMIT = 32;

// Why a block in the way of a build may not come out, or how it may: { kind } is natural, own
// or foreign, { why } says what it is and why it stays. Never anything protected or with
// something in it. In a spot the plan names (planned), a block that is neither hers nor natural
// (a player's patch of dirt, a plank dropped in) comes out as foreign; anywhere else only
// natural ones and hers do. Never one that something built leans on or stands on, unless that
// is hers or in a spot of the plan too (isPlanned).
export function clearVerdict(ctx, pos, block, { planned = false, isPlanned = () => false } = {}) {
  const { bot } = ctx;
  const name = block.name;
  if (isProtected(name, ctx.config?.protectedBlocks ?? [])) return { why: `${name}, a protected block` };
  if (HOLDS_ITEMS.test(name) || KEEPS_THINGS.test(name) || block.blockEntity) return { why: `${name}, it has something in it` };
  let kind;
  if (ownBlock(ctx, pos, name)) kind = 'own';
  else if (isClearable(name) && !playerPlaced(bot, pos)) kind = 'natural';
  else if (planned) kind = 'foreign';
  else return { why: playerPlaced(bot, pos) ? `${name}, put there by a player` : `${name}, not mine and not natural` };
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
    const at = pos.offset(dx, dy, dz);
    const next = bot.blockAt(at, false);
    if (!next || isAir(next.name) || isClearable(next.name) || ownBlock(ctx, at, next.name) || isPlanned(keyOf(at)) || !isBuiltBlock(next)) continue;
    if (dy === 1 || NEEDS_SUPPORT.test(next.name)) return { why: `${name}, it holds up ${next.name} at ${posText(at)}` };
  }
  return { kind };
}

// Looks over a build's site before anything is placed: blocks to dig out first (natural ones and
// her own that don't fit in planned spots; natural ones and her own in spots the plan leaves as
// air; in the rest of the build's box plants and snow layers, or with clear every natural
// block), what stands in the way and stays, and with foundation the blocks that fill down from
// the bottom layer to the ground, at most FOUNDATION_DEPTH deep. footing has relative blocks
// like the plan's; deep has the columns where the ground is further down. Others' blocks in
// the plan's spots come out too, but past FOREIGN_LIMIT of them, unless replace, none do: they
// go in held instead.
export function surveySite(ctx, { origin, blocks, air = [], clear = false, foundation, palette, replace = false }) {
  const { bot } = ctx;
  const at = (r) => new Vec3(origin.x + r.dx, origin.y + r.dy, origin.z + r.dz);
  const planned = new Map(blocks.map((b) => [keyOf(at(b)), { ...b, ...parseBlock(b.block) }]));
  const holes = new Map(air.map((r) => [keyOf(at(r)), at(r)]));
  const isPlanned = (key) => planned.has(key) || holes.has(key);
  const dig = [];
  const blocked = [];
  const taken = new Set();
  const add = (pos, block, kind, box = false, inPlan = false) => {
    if (taken.has(keyOf(pos))) return;
    taken.add(keyOf(pos));
    dig.push({ pos, name: block.name, kind, box, planned: inPlan });
  };
  const judge = (pos, block, sweep = false) => {
    if (sweep && sweepable(block)) return add(pos, block, 'sweep');
    const verdict = clearVerdict(ctx, pos, block, { planned: true, isPlanned });
    if (verdict.kind) add(pos, block, verdict.kind, false, true);
    else blocked.push({ pos, name: block.name, why: verdict.why });
  };

  for (const want of planned.values()) {
    const pos = at(want);
    const block = bot.blockAt(pos, false);
    if (!block || matchesState(block, want.name, want.props) || isAir(block.name) || isReplaceable(block.name)) continue;
    judge(pos, block);
  }
  for (const pos of holes.values()) {
    const block = bot.blockAt(pos, false);
    if (!block || isAir(block.name) || ['water', 'lava'].includes(block.name)) continue;
    judge(pos, block, true);
  }
  let held = [];
  const foreign = dig.filter((d) => d.kind === 'foreign');
  if (foreign.length > FOREIGN_LIMIT && !replace) {
    held = foreign;
    dig.splice(0, dig.length, ...dig.filter((d) => d.kind !== 'foreign'));
  }

  const cells = [...planned.keys(), ...holes.keys()].map((k) => k.split(',').map(Number));
  const min = new Vec3(Math.min(...cells.map((c) => c[0])), Math.min(...cells.map((c) => c[1])), Math.min(...cells.map((c) => c[2])));
  const max = new Vec3(Math.max(...cells.map((c) => c[0])), Math.max(...cells.map((c) => c[1])), Math.max(...cells.map((c) => c[2])));
  const volume = cells.length ? (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1) : 0;
  const boxTooBig = volume > SITE_BOX_MAX;
  if (cells.length && !boxTooBig) {
    for (let y = max.y; y >= min.y; y--) {
      for (let x = min.x; x <= max.x; x++) {
        for (let z = min.z; z <= max.z; z++) {
          const pos = new Vec3(x, y, z);
          const key = keyOf(pos);
          if (planned.has(key) || holes.has(key)) continue;
          const block = bot.blockAt(pos, false);
          if (!block || isAir(block.name)) continue;
          if (sweepable(block)) add(pos, block, 'sweep');
          else if (clear && block.boundingBox === 'block' && isClearable(block.name)) {
            const verdict = clearVerdict(ctx, pos, block, { isPlanned });
            if (verdict.kind === 'natural') add(pos, block, 'natural', true);
          }
        }
      }
    }
  }

  const footing = [];
  const deep = [];
  if (foundation && blocks.length) {
    const mat = material(foundation, { palette, known: (n) => Boolean(bot.registry.blocksByName[n]) }, 'foundation');
    const bottom = Math.min(...blocks.map((b) => b.dy));
    const lowest = new Map();
    for (const b of blocks) {
      const key = `${b.dx},${b.dz}`;
      if (!lowest.has(key) || lowest.get(key) > b.dy) lowest.set(key, b.dy);
    }
    for (const [key, low] of lowest) {
      if (low !== bottom) continue;
      const [dx, dz] = key.split(',').map(Number);
      const column = [];
      let ground = false;
      let why = null;
      for (let dy = low - 1; dy >= low - 1 - FOUNDATION_DEPTH; dy--) {
        const pos = at({ dx, dy, dz });
        const block = bot.blockAt(pos, false);
        if (!block) {
          why = 'not loaded';
          break;
        }
        if (block.boundingBox === 'block' && !isReplaceable(block.name)) {
          ground = true;
          break;
        }
        if (!isAir(block.name) && !isReplaceable(block.name) && !sweepable(block)) {
          why = `${block.name} in the way at ${posText(pos)}`;
          break;
        }
        column.push({ dx, dy, dz, block: blockFor(mat, dx, dy, dz), pos, under: block });
      }
      if (ground) {
        for (const c of column) {
          if (sweepable(c.under) && !isReplaceable(c.under.name)) add(c.pos, c.under, 'sweep');
          footing.push({ dx: c.dx, dy: c.dy, dz: c.dz, block: c.block });
        }
      } else deep.push({ x: origin.x + dx, z: origin.z + dz, why: why ?? `the ground is more than ${FOUNDATION_DEPTH} blocks down` });
    }
  }
  return { dig, blocked, held, footing, deep, box: cells.length ? { min, max } : null, boxTooBig, isPlanned };
}

// Digs what surveySite found, top down. Each block is judged again first, as the world may have
// changed; the block she stands on she steps off first. counts has how many of each kind came
// out (and foreignNames which of others' blocks), left what stayed and why. room says how many
// more of others' blocks may come out.
export async function clearSite(ctx, dig, { counts = siteCounts(), left = [], isPlanned = () => false, room = () => Infinity } = {}) {
  const { bot, signal } = ctx;
  const todo = new Set(dig.map((d) => keyOf(d.pos)));
  const stays = (ground) => !todo.has(keyOf(ground));
  let streak = 0;
  for (const d of [...dig].sort((a, b) => b.pos.y - a.pos.y)) {
    if (signal?.aborted) break;
    todo.delete(keyOf(d.pos));
    const block = bot.blockAt(d.pos, false);
    if (!block || isAir(block.name)) continue;
    if ((d.kind === 'sweep' || d.box) && block.name !== d.name && !sweepable(block)) continue;
    const verdict = d.kind === 'sweep' && sweepable(block) ? { kind: 'sweep' } : clearVerdict(ctx, d.pos, block, { planned: d.planned, isPlanned });
    const kind = verdict.kind;
    if (!kind) {
      left.push({ pos: d.pos, name: block.name, why: verdict.why });
      continue;
    }
    if (kind === 'foreign' && room() <= 0) {
      left.push({ pos: d.pos, name: block.name, why: `${block.name}, not mine, and I take out at most ${FOREIGN_LIMIT} of those unless a player says to build over them` });
      continue;
    }
    ctx.status?.progress(`clearing the site: ${block.name} at ${posText(d.pos)}`);
    if (underBot(bot, d.pos) && !(await stepOff(ctx, d.pos, stays))) {
      left.push({ pos: d.pos, name: block.name, why: `${block.name}, the block I'm standing on, with nowhere beside it to stand` });
      continue;
    }
    const dug = await digBlock(ctx, d.pos, { anyTool: !d.box });
    if (dug.ok) {
      counts[kind]++;
      if (kind === 'foreign') counts.foreignNames.set(block.name, (counts.foreignNames.get(block.name) ?? 0) + 1);
      streak = 0;
    } else {
      left.push({ pos: d.pos, name: block.name, why: `${block.name}: ${dug.message}` });
      if (++streak >= 8) break;
    }
  }
  return { counts, left };
}

// "2 (grass_block at 1 64 0, put there by a player; chest at ...)", the first few.
function standingText(left) {
  const shown = left.slice(0, 4).map((l) => (l.why.startsWith(l.name) ? `${l.why.replace(l.name, `${l.name} at ${posText(l.pos)}`)}` : `${l.name} at ${posText(l.pos)}: ${l.why}`));
  return `${left.length} (${shown.join('; ')}${left.length > 4 ? '; ...' : ''})`;
}

export const siteCounts = () => ({ natural: 0, own: 0, foreign: 0, sweep: 0, foreignNames: new Map() });

// What clearing, swapping, the foundation and sweeping did or would do, for the result line.
function siteText(counts, footing, would = false) {
  const say = (word, done) => (would ? word : done);
  const names = [...counts.foreignNames].map(([n, c]) => `${c} ${n}`).join(', ');
  return [
    counts.natural && `${say('clear', 'cleared')} ${counts.natural} natural block${counts.natural === 1 ? '' : 's'}`,
    counts.own && `${say('swap', 'swapped')} ${counts.own} of my own`,
    counts.foreign && `${say('take out', 'took out')} ${counts.foreign} block${counts.foreign === 1 ? '' : 's'} that ${counts.foreign === 1 ? 'isn\'t' : 'aren\'t'} mine (${names})`,
    footing && `${say('put in', 'put in')} ${footing} foundation block${footing === 1 ? '' : 's'}`,
    counts.sweep && `${say('sweep off', 'swept off')} ${counts.sweep} snow layer${counts.sweep === 1 ? '' : 's'} and plant${counts.sweep === 1 ? '' : 's'}`
  ].filter(Boolean).join(', ');
}

// Others' blocks left in the plan's spots because there were more than FOREIGN_LIMIT of them.
function heldText(held, would = false) {
  if (!held.length) return '';
  const min = held.reduce((m, h) => new Vec3(Math.min(m.x, h.pos.x), Math.min(m.y, h.pos.y), Math.min(m.z, h.pos.z)), held[0].pos);
  const max = held.reduce((m, h) => new Vec3(Math.max(m.x, h.pos.x), Math.max(m.y, h.pos.y), Math.max(m.z, h.pos.z)), held[0].pos);
  const at = held.slice(0, 3).map((h) => `${h.name} at ${posText(h.pos)}`).join('; ');
  return `${held.length} blocks that aren't mine stand in the plan's spots (${at}; all within ${posText(min)} to ${posText(max)}), more than the ${FOREIGN_LIMIT} I take out unasked, so I ${would ? 'would break' : 'broke'} none of them and ${would ? 'build' : 'built'} around them. A player has to say to build over them (replace)`;
}

// Pure planning step so it can be tested without a server. Blocks are text with an optional
// state, like "oak_stairs[facing=north,half=top]".
export function planBuild({ origin, blocks, botPos, getName, getBlock, inventory, maxBlocks, isKnownBlock, checkState = () => null, itemName = (n) => itemFor(n) }) {
  if (blocks.length > maxBlocks) {
    return { error: `structure has ${blocks.length} blocks, the limit is ${maxBlocks}` };
  }
  const parsed = blocks.map((b) => ({ ...b, ...parseBlock(b.block) }));
  const unknown = [...new Set(parsed.map((b) => b.name).filter((name) => !isKnownBlock(name)))];
  if (unknown.length > 0) return { error: `unknown block: ${unknown.join(', ')}` };
  const problems = [...new Set(parsed.map((b) => checkState(b.name, b.props)).filter(Boolean))];
  if (problems.length > 0) return { error: problems.slice(0, 3).join('; ') };

  const byPos = new Map();
  for (const b of parsed) {
    const x = origin.x + b.dx;
    const y = origin.y + b.dy;
    const z = origin.z + b.dz;
    const props = Object.keys(b.props).length ? b.props : undefined;
    byPos.set(`${x},${y},${z}`, { x, y, z, block: b.name, props });
  }

  const blockAt = getBlock ?? ((x, y, z) => ({ name: getName(x, y, z) }));
  const placements = [];
  let skipped = 0;
  for (const p of byPos.values()) {
    if (matchesState(blockAt(p.x, p.y, p.z), p.block, p.props)) skipped++;
    else placements.push(p);
  }

  const dist = (p) => (p.x - botPos.x) ** 2 + (p.y - botPos.y) ** 2 + (p.z - botPos.z) ** 2;
  placements.sort((a, b) => a.y - b.y || dist(a) - dist(b));

  // A double slab takes two slabs, or one where half of it is in already.
  const needed = new Map();
  for (const p of placements) {
    const item = itemName(p.block);
    p.uses = isDoubleSlab(p.block, p.props) && blockAt(p.x, p.y, p.z)?.name !== p.block ? 2 : 1;
    needed.set(item, (needed.get(item) ?? 0) + p.uses);
  }
  const missing = [];
  for (const [block, need] of needed) {
    const have = inventory.get(block) ?? 0;
    if (have < need) missing.push({ block, need, have });
  }

  return { placements, skipped, needed, missing };
}

export function inventoryCounts(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

// Splits a plan's placements into the ones the carried items cover, taken in plan order (bottom
// layer first, nearest first), and the ones left for want of items.
export function withinStock(placements, inventory, itemName = (n) => itemFor(n)) {
  const left = new Map(inventory);
  const covered = [];
  const short = [];
  for (const p of placements) {
    const item = itemName(p.block);
    const uses = p.uses ?? 1;
    if ((left.get(item) ?? 0) >= uses) {
      left.set(item, left.get(item) - uses);
      covered.push(p);
    } else short.push(p);
  }
  return { covered, short };
}

// Hands out blocks one at a time, always the one closest to here() at that moment. The bot
// doesn't move while something is still in reach, so it places all of that before walking on,
// then walks to the nearest of the rest instead of back and forth between two ends.
export function* nearestFirst(blocks, here) {
  const left = [...blocks];
  const dist = (p, at) => (p.x + 0.5 - at.x) ** 2 + (p.y + 0.5 - at.y) ** 2 + (p.z + 0.5 - at.z) ** 2;
  while (left.length > 0) {
    const at = here();
    let best = 0;
    for (let i = 1; i < left.length; i++) if (dist(left[i], at) < dist(left[best], at)) best = i;
    yield left.splice(best, 1)[0];
  }
}

// Splits blocks into groups that lie together: two blocks are in one group when they are at
// most gap blocks apart on every axis, so a window or a skipped block doesn't split a wall,
// but the two gable ends of a roof are two groups. Each group keeps the order blocks came in.
export function groupBlocks(blocks, gap = 2) {
  const index = new Map(blocks.map((p, i) => [`${p.x},${p.y},${p.z}`, i]));
  const seen = new Array(blocks.length).fill(false);
  const groups = [];
  for (let i = 0; i < blocks.length; i++) {
    if (seen[i]) continue;
    seen[i] = true;
    const members = [];
    const queue = [i];
    while (queue.length > 0) {
      const j = queue.pop();
      members.push(j);
      const p = blocks[j];
      for (let dx = -gap; dx <= gap; dx++) {
        for (let dy = -gap; dy <= gap; dy++) {
          for (let dz = -gap; dz <= gap; dz++) {
            const k = index.get(`${p.x + dx},${p.y + dy},${p.z + dz}`);
            if (k !== undefined && !seen[k]) {
              seen[k] = true;
              queue.push(k);
            }
          }
        }
      }
    }
    groups.push(members.sort((a, b) => a - b).map((j) => blocks[j]));
  }
  return groups;
}

// Hands out a group's blocks so everything that can go in from where the bot stands goes in
// before it walks. Only blocks with no block of the group still to come right under them are
// up next. Of those, the closest one in reach that placeable(p) says has something to place
// against comes first, otherwise the closest one, which means a walk. here() is the eye position.
export function* fromHere(blocks, here, placeable = () => true) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const left = new Map(blocks.map((p) => [key(p.x, p.y, p.z), p]));
  const under = new Map(blocks.map((p) => [p, key(p.x, p.y - 1, p.z)]));
  const dist = (p, at) => (p.x + 0.5 - at.x) ** 2 + (p.y + 0.5 - at.y) ** 2 + (p.z + 0.5 - at.z) ** 2;
  while (left.size > 0) {
    const at = here();
    let nearest = null;
    const near = [];
    for (const p of left.values()) {
      if (left.has(under.get(p))) continue;
      const d = dist(p, at);
      if (!nearest || d < nearest.d) nearest = { p, d };
      if (d <= REACH ** 2) near.push({ p, d });
    }
    near.sort((a, b) => a.d - b.d);
    const next = near.find((n) => placeable(n.p)) ?? nearest;
    left.delete(key(next.p.x, next.p.y, next.p.z));
    yield next.p;
  }
}

// Blocks that drop or pop off when what they stand on or hang from goes, so a support that comes
// out again is no use to them.
const NEEDS_SUPPORT = /torch|lantern|ladder|_door$|sign$|banner$|button$|lever$|pressure_plate$|rail$|carpet$|_bed$|redstone|repeater$|comparator$|sapling$|candle|sand$|gravel$|concrete_powder$|anvil$|^scaffolding$|pointed_dripstone|^snow$|vine|lichen|chain$|^bell$|_head$|_skull$|flower_pot$|cake$|_coral|_fan$|mushroom$|fungus$|_roots$|dripleaf|^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower)$|_tulip$/;

// A player's trick for a block with nothing to place against: put dirt or cobblestone (never
// the build's own materials) in a free spot next to it on a side it can go against, place it,
// and break the dirt again. Null when there is nothing to do it with or nowhere to do it.
async function withSupport(ctx, p, place, all) {
  const { bot } = ctx;
  if (NEEDS_SUPPORT.test(p.block)) return null;
  const keep = bot.buildKeep;
  const item = bot.inventory.items().find((i) => SCAFFOLD_BLOCKS.includes(i.name) && !keep?.has(bot.registry.itemsByName[i.name]?.id));
  if (!item) return null;
  const planned = new Set(all.filter((q) => !q.done).map((q) => `${q.x},${q.y},${q.z}`));
  const pos = new Vec3(p.x, p.y, p.z);
  const options = p.props && Object.keys(p.props).length ? placementOptions(p.block, p.props) : undefined;
  const tried = new Set();
  for (const how of referenceWays(p.block, p.attach, options)) {
    const cell = pos.plus(how.dir);
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (tried.has(key) || planned.has(key)) continue;
    tried.add(key);
    const here = bot.blockAt(cell, false);
    if (!here || !isReplaceable(here.name) || !findReference(bot, cell, item.name)) continue;
    const put = await placeOne(ctx, item.name, cell);
    if (!put.ok) continue;
    const result = await place(p);
    const dug = await digBlock(ctx, cell, { anyTool: true });
    if (!dug.ok) return { ...result, message: `${result.message}; the ${item.name} I put at ${posText(cell)} to hold it is still there: ${dug.message}` };
    return result;
  }
  return null;
}

// Places blocks one y layer at a time, in the order given, or with nearest set, all as one
// batch handed out by fromHere. Blocks with nothing to place against yet are retried once the
// rest of their layer is down, then with the layers above (a hanging lantern needs the block
// over it). Afterwards every block is checked once more, and the ones that are missing or
// turned the wrong way get one more go. strays holds the keys of planned spots where
// scaffolding went up; it is dug out before the block goes there. With giveUpAfter, that many
// failed walks in a row stop it early and gaveUp says why. all is the whole build, when these
// placements are only part of it, for the progress line and the count of items still needed.
// With leaveTaken that last check passes over spots something else has filled since, for the
// caller to clear first.
export async function placeAll(ctx, placements, { nearest = false, strays, giveUpAfter, all = placements, leaveTaken = false } = {}) {
  const { signal } = ctx;
  let placed = 0;
  const failures = [];
  let stoppedReason = null;
  let gaveUp = null;
  let streak = [];
  const before = all.filter((p) => p.done).length;

  const layers = new Map();
  for (const p of placements) {
    const layer = nearest ? 'all' : p.y;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(p);
  }
  const placeable = (p) => {
    const options = p.props && Object.keys(p.props).length ? placementOptions(p.block, p.props) : undefined;
    return Boolean(findReference(ctx.bot, new Vec3(p.x, p.y, p.z), p.block, p.attach, options));
  };

  const place = async (p) => {
    const pos = new Vec3(p.x, p.y, p.z);
    const key = `${p.x},${p.y},${p.z}`;
    if (strays?.has(key)) {
      const here = ctx.bot.blockAt(pos, false);
      if (here && SCAFFOLD_BLOCKS.includes(here.name) && !matchesState(here, p.block, p.props)) {
        const dug = await digBlock(ctx, pos, { anyTool: true });
        if (!dug.ok) {
          p.why = dug.message;
          return dug;
        }
      }
      strays.delete(key);
    }
    const result = await placeOne(ctx, p.block, pos, { attach: p.attach, props: p.props });
    if (result.ok) {
      p.done = true;
      p.why = undefined;
    } else p.why = result.message;
    return result;
  };
  const ranOut = (p) => `ran out of ${itemFor(p.block, ctx.bot.registry)}, need ${all.filter((q) => q.block === p.block && !q.done).length} more`;

  let carried = [];
  outer: for (const layer of [...layers.values(), []]) {
    let pending = [...carried, ...layer];
    carried = [];
    while (pending.length > 0) {
      const retry = [];
      let progress = false;
      const order = nearest ? fromHere(pending, () => ctx.bot.entity.position.offset(0, 1.6, 0), placeable) : pending;
      for (const p of order) {
        if (signal?.aborted) {
          stoppedReason = 'stopped';
          break outer;
        }
        const result = await place(p);
        if (result.ok) {
          placed++;
          progress = true;
          failures.push(...streak);
          streak = [];
          ctx.status?.progress(`placed ${before + placed} of ${all.length} blocks`);
        } else if (result.message.startsWith('missing item')) {
          stoppedReason = ranOut(p);
          break outer;
        } else if (result.message.startsWith('no block to place against')) {
          retry.push(p);
        } else if (/Server refused/.test(result.message) && !p.refused) {
          // Once more after the rest of the layer, from wherever she is then and with more
          // neighbors down to click.
          p.refused = true;
          retry.push(p);
        } else if (giveUpAfter && result.reason) {
          streak.push(result.message);
          // A planned walk that found no way to the group's first block won't find one on a
          // second try either.
          if (streak.length >= giveUpAfter || (result.reason === 'no_route' && placed === 0)) {
            gaveUp = { message: result.message, tries: streak.length, from: ctx.bot.entity.position.floored() };
            break outer;
          }
        } else {
          failures.push(result.message);
        }
      }
      if (!progress) {
        carried = retry;
        break;
      }
      pending = retry;
    }
  }
  if (!gaveUp) failures.push(...streak);
  // What still has nothing to place against gets a block of scaffolding beside it for as long
  // as it takes to put it in, bottom up. Each one that goes in may hold up the next.
  let unsupported = carried;
  if (!gaveUp && !stoppedReason) {
    unsupported = [...carried].sort((a, b) => a.y - b.y);
    while (unsupported.length > 0 && !signal?.aborted) {
      const still = [];
      for (const p of unsupported) {
        if (signal?.aborted) {
          still.push(p);
          continue;
        }
        let result = await place(p);
        if (!result.ok && result.message.startsWith('no block to place against')) result = (await withSupport(ctx, p, place, all)) ?? result;
        if (result.ok) {
          placed++;
          ctx.status?.progress(`placed ${before + placed} of ${all.length} blocks`);
        } else still.push(p);
      }
      if (still.length === unsupported.length) break;
      unsupported = still;
    }
  }
  for (const p of unsupported) failures.push(p.why ?? `no block to place against at ${p.x} ${p.y} ${p.z}`);

  const wrong = [];
  if (!stoppedReason) {
    const bot = ctx.bot;
    const off = placements.filter((p) => {
      const here = bot.blockAt(new Vec3(p.x, p.y, p.z), false);
      return p.done && !matchesState(here, p.block, p.props) && !(leaveTaken && here && here.name !== p.block && !isReplaceable(here.name));
    });
    for (const p of off) {
      if (signal?.aborted) break;
      ctx.status?.progress(`checking the build: fixing ${off.indexOf(p) + 1} of ${off.length} blocks`);
      const result = await place(p);
      if (result.wrong) wrong.push(result.message);
      else if (!result.ok) failures.push(result.message);
    }
  }
  return { placed, failures, wrong, stoppedReason, gaveUp };
}

// Builds a structure group by group, always the closest group to the bot next, each finished
// before walking to the next. A group the bot can't get to is skipped and the next one goes on.
// report has what is left of each group and why.
async function placeGroups(ctx, groups, { strays, leaveTaken = false }) {
  const all = groups.flat();
  const todo = [...groups];
  const dist = (p, at) => (p.x + 0.5 - at.x) ** 2 + (p.y + 0.5 - at.y) ** 2 + (p.z + 0.5 - at.z) ** 2;
  let placed = 0;
  const failures = [];
  const wrong = [];
  const report = [];
  let stoppedReason = null;
  while (todo.length > 0 && !stoppedReason) {
    const at = ctx.bot.entity.position.offset(0, 1.6, 0);
    const closest = (g) => g.reduce((m, p) => Math.min(m, dist(p, at)), Infinity);
    let best = 0;
    for (let i = 1; i < todo.length; i++) if (closest(todo[i]) < closest(todo[best])) best = i;
    const group = todo.splice(best, 1)[0];
    const result = await placeAll(ctx, group, { nearest: true, strays, all, giveUpAfter: GIVE_UP_AFTER, leaveTaken });
    placed += result.placed;
    failures.push(...result.failures);
    wrong.push(...result.wrong);
    stoppedReason = result.stoppedReason;
    const left = group.filter((p) => !p.done);
    if (left.length > 0) report.push({ left, gaveUp: result.gaveUp });
  }
  for (const group of todo) report.push({ left: group, notStarted: true });
  return { placed, failures, wrong, stoppedReason, report };
}

// The reasons the blocks of a group are still missing, the same reason once with how many
// blocks it holds up.
function whyText(left) {
  const kinds = new Map();
  for (const p of left) {
    const why = p.why ?? 'not tried before it stopped';
    const kind = why.replace(/-?\d+/g, 'N');
    const k = kinds.get(kind);
    if (k) k.count++;
    else kinds.set(kind, { why, count: 1 });
  }
  const shown = [...kinds.values()].slice(0, 3).map(({ why, count }) => (count > 1 ? `${why} (${count} blocks like this)` : why));
  return `${shown.join('; ')}${kinds.size > 3 ? `; and ${kinds.size - 3} other reasons` : ''}`;
}

// "8 blocks around 2781 83 -5022 (8 deepslate_bricks, from 2781 80 -5025 to 2781 85 -5019):
// couldn't get up there ...", for one group of a build that didn't get finished.
export function leftText({ left, gaveUp, notStarted }, climbText) {
  const min = { x: Math.min(...left.map((p) => p.x)), y: Math.min(...left.map((p) => p.y)), z: Math.min(...left.map((p) => p.z)) };
  const max = { x: Math.max(...left.map((p) => p.x)), y: Math.max(...left.map((p) => p.y)), z: Math.max(...left.map((p) => p.z)) };
  const mid = { x: Math.round((min.x + max.x) / 2), y: Math.round((min.y + max.y) / 2), z: Math.round((min.z + max.z) / 2) };
  const names = new Map();
  for (const p of left) names.set(p.block, (names.get(p.block) ?? 0) + 1);
  const what = [...names].map(([n, c]) => `${c} ${n}`).join(', ');
  const where = left.length <= 3 ? `at ${left.map(posText).join('; ')}` : `from ${posText(min)} to ${posText(max)}`;
  let why;
  if (gaveUp) {
    const rise = min.y - gaveUp.from.y;
    why = rise >= 2 ? `couldn't get up there, the lowest is ${rise} blocks above where I got to` : "couldn't get close enough";
    why += ` (${gaveUp.tries} ${gaveUp.tries === 1 ? 'try' : 'tries'}, last: ${gaveUp.message}); ${climbText}`;
  } else if (notStarted) why = 'not started';
  else why = whyText(left);
  return `${left.length} block${left.length === 1 ? '' : 's'} around ${posText(mid)} (${what}, ${where}): ${why}`;
}

// The box a structure fills, and the spots its blocks go.
export function buildSite(origin, blocks) {
  const planned = new Set();
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const b of blocks) {
    const p = new Vec3(origin.x + b.dx, origin.y + b.dy, origin.z + b.dz);
    planned.add(`${p.x},${p.y},${p.z}`);
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max, planned };
}

// The lowest ground in the 2 blocks round a site (and under it), as the y of the feet of
// someone standing on it, at most 32 blocks below the site. Scaffolding to high blocks like
// roof trim starts there.
export function groundUnder(bot, min, max) {
  let ground = min.y;
  for (let x = min.x - 2; x <= max.x + 2; x++) {
    for (let z = min.z - 2; z <= max.z + 2; z++) {
      let y = min.y - 1;
      while (y > min.y - 32) {
        const b = bot.blockAt(new Vec3(x, y, z), false);
        if (!b || b.boundingBox === 'block') break;
        y--;
      }
      ground = Math.min(ground, y + 1);
    }
  }
  return ground;
}

// The area a build may put scaffolding in (bot.buildZone): round the site and over it, and
// down to the ground beside it.
export function buildZone(site, ground) {
  return { min: new Vec3(site.min.x - 2, Math.min(site.min.y, ground) - 1, site.min.z - 2), max: site.max.offset(2, 2, 2) };
}

// Where a build's scaffolding may be: next to the build (min..max), a few blocks over it, and
// down to the ground beside it (site.ground) for a build that starts high up.
function scaffoldInSite(site, p) {
  const bottom = Math.min(site.min.y, site.ground ?? site.min.y) - 2;
  return p.x >= site.min.x - 2 && p.x <= site.max.x + 2 && p.z >= site.min.z - 2 && p.z <= site.max.z + 2 && p.y >= bottom && p.y <= site.max.y + 3;
}

// Notes the bot's scaffolding around a build until stop(): only blocks the pathfinder put down
// (see watchScaffold), so anything a player or the world puts there stays. strays gets the keys
// of planned spots (planned.has(key)) it went on, for placeAll to dig out first. leftover(blocks) is what
// to take down afterwards: the scaffolding beside the build, and any still on the spot of one
// of blocks that didn't get placed.
export function watchBuildScaffold(bot, site, planned) {
  const strays = new Set();
  const { placed, stop } = watchScaffold(bot, (p) => {
    if (!scaffoldInSite(site, p)) return false;
    const key = `${p.x},${p.y},${p.z}`;
    if (!planned.has(key)) return true;
    if (!bot.buildKeep?.has(bot.registry.itemsByName[bot.blockAt(p, false)?.name]?.id)) strays.add(key);
    return false;
  });
  const leftover = (blocks) => {
    const wanted = new Map(blocks.map((b) => [`${b.x},${b.y},${b.z}`, b]));
    const on = [...strays].map((k) => wanted.get(k)).filter((b) => b && !matchesState(bot.blockAt(new Vec3(b.x, b.y, b.z), false), b.block, b.props));
    return [...placed, ...on.map((b) => new Vec3(b.x, b.y, b.z))];
  };
  return { strays, stop, leftover };
}

// "40 spruce_planks in the chest at 2807 64 -5121", for each of names the nearest chest the bot
// remembers holding it, within 64 blocks.
export function chestStock(bot, names) {
  const out = [];
  for (const name of names) {
    const chest = rememberedChest(bot, name);
    if (chest) out.push(`${chest.items.find(([n]) => n === name)[1]} ${name} in the ${chest.name} at ${posText(chest.parts[0])}`);
  }
  return out;
}

function rememberedChest(bot, name) {
  const index = bot.chestIndex;
  if (!index?.list || !bot.entity) return null;
  return pickSource(index.list(bot.game?.dimension), new Set([name]), bot.entity.position, new Set(), 64);
}

// Takes what a build is short of out of the chests the bot remembers holding it. Null when no
// chest it knows of has any.
async function fetchMissing(ctx, missing) {
  const known = missing.filter((m) => rememberedChest(ctx.bot, m.block));
  if (known.length === 0) return null;
  return takeItems(ctx, { items: known.map((m) => ({ item: m.block, count: m.need - m.have })) });
}

// What to do about items a build is short of, so the bot gets them itself before asking anyone.
export function missingHelp(bot, names, again) {
  const stock = chestStock(bot, names);
  const where = stock.length ? ` I remember ${stock.join(', ')}.` : '';
  return `obtain gets each of them in one call (from chests I know, by crafting, or by mining and chopping), then ${again}.${where}`;
}

export function slabFinder(bot) {
  return (stairs) => {
    const slab = stairs.replace(/_stairs$/, '_slab');
    return bot.registry.blocksByName[slab] ? slab : null;
  };
}

// The build_structure tool. Before placing, natural blocks and her own blocks that don't fit are
// dug out of the planned spots and of the spots the plan leaves as air, plants and snow (with
// clear every natural block) out of the rest of the build's box, and with foundation the gaps
// under the bottom layer are filled down to the ground. Others' blocks in the plan's spots come
// out too, at most FOREIGN_LIMIT a call unless replace. Afterwards up to CHECK_ROUNDS rounds put
// back what got knocked out or grown over, and snow and plants on and in the build are swept off.
export async function buildStructure(ctx, { origin, blocks = [], parts = [], palette, mirror, clear = false, foundation, replace = false, dry_run }) {
  const { bot, config, signal } = ctx;
  const box = (p) => {
    const to = p.to ?? p.from;
    return (Math.abs(to.dx - p.from.dx) + 3) * (Math.abs(to.dy - p.from.dy) + 1) * (Math.abs(to.dz - p.from.dz) + 3) * partCopies(p, mirror);
  };
  if (parts.reduce((sum, p) => sum + box(p), 0) > config.limits.maxBuildBlocks * 20) {
    return fail(`those parts are far too big, the limit is ${config.limits.maxBuildBlocks} blocks`);
  }
  let all;
  let survey;
  try {
    all = expandPlan(bot, { parts, blocks, palette, mirror });
    survey = surveySite(ctx, { origin, blocks: all, air: all.air, clear, foundation: foundation || null, palette, replace });
  } catch (err) {
    if (err instanceof PlanError) return fail(err.message);
    throw err;
  }
  const absKey = (b) => `${origin.x + b.dx},${origin.y + b.dy},${origin.z + b.dz}`;
  const blockedKeys = new Set([...survey.blocked, ...survey.held].map((l) => keyOf(l.pos)));
  const buildBlocks = [...all.filter((b) => !blockedKeys.has(absKey(b))), ...survey.footing];
  const itemName = (name) => itemFor(name, bot.registry);
  const makePlan = () => {
    const inventory = inventoryCounts(bot.inventory.items());
    const made = planBuild({
      origin,
      blocks: buildBlocks,
      botPos: bot.entity.position.floored(),
      getBlock: (x, y, z) => bot.blockAt(new Vec3(x, y, z), false),
      inventory,
      maxBlocks: config.limits.maxBuildBlocks,
      isKnownBlock: (name) => Boolean(bot.registry.blocksByName[name]),
      checkState: (name, props) => blockStateProblem(bot.registry, name, props),
      itemName
    });
    return { ...made, inventory };
  };
  let plan = makePlan();

  if (plan.error) return fail(plan.error);
  const would = siteCounts();
  for (const d of survey.dig) {
    would[d.kind]++;
    if (d.kind === 'foreign') would.foreignNames.set(d.name, (would.foreignNames.get(d.name) ?? 0) + 1);
  }
  const deepText = survey.deep.length ? `. No foundation where ${survey.deep.slice(0, 4).map((d) => `${d.x} ${d.z} (${d.why})`).join('; ')}${survey.deep.length > 4 ? `; and ${survey.deep.length - 4} more columns` : ''}` : '';
  const boxText = survey.boxTooBig ? '. The build\'s box is too big to look over, so only its own spots were cleared' : '';
  if (dry_run) {
    const needText = [...plan.needed].map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing';
    const missingText = plan.missing.map((m) => `${m.block} (need ${m.need}, have ${m.have}, ${m.need - m.have} more)`).join(', ');
    const work = siteText(would, survey.footing.length, true);
    const standing = survey.blocked.length ? ` Would be left standing in the way: ${standingText(survey.blocked)}.` : '';
    const heldNote = survey.held.length ? ` ${heldText(survey.held, true)}.` : '';
    return ok(`Plan: ${all.length} blocks, ${plan.skipped} already in place. Needs ${needText}.${missingText ? ` Missing: ${missingText}.` : ' I have everything.'}${work ? ` On the site I would ${work}.` : ''}${standing}${heldNote}${deepText ? ` ${deepText.slice(2)}.` : ''}${boxText ? ` ${boxText.slice(2)}.` : ''}`);
  }
  // Short of something: first it comes out of the chests the bot remembers, then whatever is
  // still short is left out and the rest gets built.
  let fetched = null;
  if (plan.missing.length > 0) {
    fetched = await fetchMissing(ctx, plan.missing);
    if (fetched) plan = makePlan();
  }
  const fetchedText = fetched ? ` From the chests I remember: ${fetched.message}.` : '';
  const again = 'build_structure with the same plan, which skips what is already in place';
  if (plan.missing.length > 0 && withinStock(plan.placements, plan.inventory, itemName).covered.length === 0) {
    const stillText = plan.missing.map((m) => `${m.block} (need ${m.need}, have ${m.have}, ${m.need - m.have} more)`).join(', ');
    return fail(`missing items: ${stillText}. Nothing was placed.${fetchedText} ${missingHelp(bot, plan.missing.map((m) => m.block), again)}`);
  }

  // Like build_house: scaffolding may go up next to its own blocks, never made of the build's
  // materials, and comes down again afterwards.
  const site = buildSite(origin, buildBlocks);
  site.ground = groundUnder(bot, site.min, site.max);
  bot.buildZone = buildZone(site, site.ground);
  bot.buildKeep = new Set([...plan.needed.keys()].map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined));
  const scaffold = watchBuildScaffold(bot, site, site.planned);
  const counts = siteCounts();
  const room = () => (replace ? Infinity : FOREIGN_LIMIT - survey.held.length - counts.foreign);
  const standing = [...survey.blocked];
  const sweepLeft = [];
  const hits = new Map();
  let putBack = 0;
  let footingIn = 0;
  let result;
  let short = [];
  try {
    if (survey.dig.length) {
      await clearSite(ctx, survey.dig, { counts, left: standing, isPlanned: survey.isPlanned, room });
      if ((counts.natural || counts.own || counts.foreign) && !signal?.aborted) {
        const mid = site.min.plus(site.max).scaled(0.5);
        await collectDrops(ctx, { center: mid.offset(0.5, 0.5, 0.5), radius: Math.max(site.max.x - site.min.x, site.max.z - site.min.z) / 2 + 4, max: 48 });
      }
      plan = makePlan();
    }
    const stillIn = new Set(standing.map((l) => keyOf(l.pos)));
    const placements = plan.placements.filter((p) => !stillIn.has(keyOf(p)));
    const split = withinStock(placements, plan.inventory, itemName);
    short = split.short;
    result = signal?.aborted ? { placed: 0, failures: [], wrong: [], stoppedReason: 'stopped', report: [] } : await placeGroups(ctx, groupBlocks(split.covered), { strays: scaffold.strays, leaveTaken: true });
    const footingKeys = new Set(survey.footing.map(absKey));
    footingIn = plan.placements.filter((p) => p.done && footingKeys.has(keyOf(p))).length;

    // What was in place by the end, checked again: knocked out, grown over or turned, it goes
    // back in, natural blocks and her own in the way coming out first.
    const spots = new Map(buildBlocks.map((b) => {
      const { name, props } = parseBlock(b.block);
      return [absKey(b), { x: origin.x + b.dx, y: origin.y + b.dy, z: origin.z + b.dz, block: name, props: Object.keys(props).length ? props : undefined }];
    }));
    const placedKeys = new Set(plan.placements.map(keyOf));
    const inPlace = new Set([...spots.keys()].filter((k) => !placedKeys.has(k) && !stillIn.has(k)));
    for (const p of plan.placements) if (p.done) inPlace.add(keyOf(p));
    for (let round = 0; round < CHECK_ROUNDS && !signal?.aborted && !result.stoppedReason; round++) {
      const off = [];
      const intruders = [];
      let queued = 0;
      for (const key of inPlace) {
        const s = spots.get(key);
        const pos = new Vec3(s.x, s.y, s.z);
        const here = bot.blockAt(pos, false);
        if (!here || matchesState(here, s.block, s.props)) continue;
        if (!isAir(here.name) && !isReplaceable(here.name)) {
          // A foundation spot stays natural-only, like the survey under it.
          const inPlan = !footingKeys.has(key);
          const verdict = clearVerdict(ctx, pos, here, { planned: inPlan, isPlanned: survey.isPlanned });
          let why = verdict.why;
          if (verdict.kind === 'foreign' && room() - queued <= 0) why = `${here.name}, not mine, and I take out at most ${FOREIGN_LIMIT} of those unless a player says to build over them`;
          if (!verdict.kind || why) {
            standing.push({ pos, name: here.name, why });
            inPlace.delete(key);
            continue;
          }
          if (verdict.kind === 'foreign') queued++;
          intruders.push({ pos, name: here.name, kind: verdict.kind, planned: inPlan });
        }
        off.push({ ...s });
        hits.set(key, (hits.get(key) ?? 0) + 1);
      }
      if (off.length === 0) break;
      ctx.status?.progress(`checking the build, round ${round + 1}: ${off.length} blocks to put back`);
      if (intruders.length) await clearSite(ctx, intruders, { counts, left: standing, isPlanned: survey.isPlanned, room });
      const fixed = await placeAll(ctx, off, { nearest: true, strays: scaffold.strays, giveUpAfter: GIVE_UP_AFTER, leaveTaken: true });
      putBack += fixed.placed;
      result.failures.push(...fixed.failures);
      result.wrong.push(...fixed.wrong);
      if (fixed.stoppedReason) result.stoppedReason = fixed.stoppedReason;
    }

    // Snow, plants and leaf litter that came down on the build or grew inside it come off.
    if (!signal?.aborted && !result.stoppedReason) {
      const sweep = [];
      const seen = new Set();
      const look = (pos) => {
        const key = keyOf(pos);
        if (spots.has(key) || seen.has(key)) return;
        seen.add(key);
        const here = bot.blockAt(pos, false);
        if (sweepable(here)) sweep.push({ pos, name: here.name, kind: 'sweep' });
      };
      for (const s of spots.values()) look(new Vec3(s.x, s.y + 1, s.z));
      if (survey.box && !survey.boxTooBig) {
        const { min, max } = survey.box;
        for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) look(new Vec3(x, y, z));
      }
      if (sweep.length) await clearSite(ctx, sweep, { counts, left: sweepLeft });
    }
  } finally {
    scaffold.stop();
    bot.buildZone = null;
    bot.buildKeep = null;
  }
  const takeDown = await takeDownScaffold(ctx, scaffold.leftover(plan.placements));

  const { placed, failures, wrong, stoppedReason, report } = result;
  const tried = failures.length + report.reduce((n, r) => n + (r.gaveUp?.tries ?? 0), 0);
  let message = `placed ${placed}, skipped ${plan.skipped}, failed ${tried}`;
  const work = siteText(counts, footingIn);
  if (work) message += `, ${work}`;
  if (takeDown.text) message += `, ${takeDown.text}`;
  if (putBack > 0) message += `. Put back ${putBack} block${putBack === 1 ? '' : 's'} disturbed while building`;
  const restless = [...hits].filter(([, n]) => n >= CHECK_ROUNDS).map(([k]) => k.replace(/,/g, ' '));
  if (restless.length) message += `. Disturbed again in every one of ${CHECK_ROUNDS} checks, so I stopped checking: ${restless.slice(0, 4).join('; ')}${restless.length > 4 ? `; and ${restless.length - 4} more` : ''}`;
  if (fetched) message += `. From the chests I remember, before building: ${fetched.message}`;
  if (wrong.length > 0) message += `. ${wrong.length} came out turned the wrong way, first: ${wrong.slice(0, 3).join('; ')}`;
  if (standing.length) message += `. Left standing in the way: ${standingText(standing)}`;
  if (survey.held.length) message += `. ${heldText(survey.held)}`;
  if (sweepLeft.length) message += `. Couldn't sweep off ${standingText(sweepLeft)}`;
  message += deepText + boxText;
  if (report.length > 0) {
    const climb = [...inventoryCounts(bot.inventory.items())].filter(([n]) => SCAFFOLD_BLOCKS.includes(n) && !plan.needed.has(n));
    const stock = climb.length ? [] : chestStock(bot, SCAFFOLD_BLOCKS).slice(0, 2);
    const fetch = stock.length ? `, but I remember ${stock.join(' and ')}: take_items some of that first` : ', obtain or mine some dirt or cobblestone first';
    const climbText = climb.length ? `I have ${climb.map(([n, c]) => `${c} ${n}`).join(', ')}, so scaffolding up is possible` : `I have no blocks to scaffold with (dirt, cobblestone and the like)${fetch}`;
    const count = report.reduce((n, r) => n + r.left.length, 0);
    message += `. Left to do, ${count} blocks in ${report.length} group${report.length === 1 ? '' : 's'}: ${report.map((r) => leftText(r, climbText)).join('. ')}`;
  }
  if (stoppedReason) message += `. Stopped early: ${stoppedReason}`;
  if (report.length > 0 && short.length === 0) message += '. build_structure with the same plan again skips what is already in place';
  if (short.length > 0) {
    const names = new Map();
    for (const p of short) names.set(p.block, (names.get(p.block) ?? 0) + 1);
    const what = [...names].map(([n, c]) => `${c} ${n}`).join(', ');
    const missing = plan.missing.map((m) => `${m.need - m.have} ${m.block}`).join(', ');
    message += `. Left out ${short.length} blocks (${what}) for want of items, short of ${missing}. ${missingHelp(bot, plan.missing.map((m) => m.block), again)}`;
  }
  if (placed > 0 || putBack > 0) return ok(message);
  return stoppedReason || report.length > 0 || failures.length > 0 || short.length > 0 || standing.length > 0 || survey.held.length > 0 ? fail(message) : ok(message);
}

// Blocks that hold items, which a copy can't bring along.
const HOLDS_ITEMS = /(^|_)chest$|^barrel$|shulker_box$|furnace$|^smoker$|^hopper$|^dispenser$|^dropper$|^brewing_stand$|^crafter$|^chiseled_bookshelf$|^decorated_pot$|^lectern$|^jukebox$|_shelf$/;
const NOT_PLACED = new Set(['water', 'lava', 'bubble_column', 'fire', 'soul_fire']);

// Reads the box min..max into blocks for build_structure, offsets from the lowest north-west
// corner of the copy, turned rotate degrees clockwise. The upper half of a door or tall plant
// and the head of a bed come with the other half, so only that one is kept. Blocks no item
// places, or in a state build_structure can't make, go in leftOut. air has the offsets of the
// source's air, for what stands in the way at the destination.
export function copyPlan(bot, min, max, rotate = 0) {
  const registry = bot.registry;
  const turns = (((rotate / 90) % 4) + 4) % 4;
  const cells = [];
  const air = [];
  const leftOut = [];
  const containers = new Map();
  for (let y = min.y; y <= max.y; y++) {
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        const p = new Vec3(x, y, z);
        const b = bot.blockAt(p, false);
        if (!b) return { error: `part of the source box is not loaded (around ${posText(p)}), walk closer first` };
        const rel = { dx: x - min.x, dy: y - min.y, dz: z - min.z };
        if (isAir(b.name)) {
          air.push(rel);
          continue;
        }
        const raw = b.getProperties?.() ?? {};
        if (raw.half === 'upper' || raw.part === 'head') continue;
        const { name, props } = parseBlock(stateText(b));
        if (props.half === 'lower') delete props.half;
        if (NOT_PLACED.has(name) || !registry.itemsByName?.[itemFor(name, registry)]) {
          leftOut.push({ name, why: 'no item places it' });
          continue;
        }
        let problem = blockStateProblem(registry, name, props);
        if (problem && (props.facing === 'up' || props.facing === 'down')) {
          delete props.facing;
          problem = blockStateProblem(registry, name, props);
        }
        if (problem) {
          leftOut.push({ name, why: problem });
          continue;
        }
        if (HOLDS_ITEMS.test(name)) containers.set(name, (containers.get(name) ?? 0) + 1);
        cells.push({ ...rel, block: blockText(name, turnState(props, turns)) });
      }
    }
  }
  const turn = ({ dx, dy, dz }) => {
    for (let i = 0; i < turns; i++) [dx, dz] = [-dz, dx];
    return { dx, dy, dz };
  };
  // Shifted so the turned box starts at 0 0 0 again.
  const corners = [[0, 0], [max.x - min.x, 0], [0, max.z - min.z], [max.x - min.x, max.z - min.z]].map(([dx, dz]) => turn({ dx, dy: 0, dz }));
  const sx = Math.min(...corners.map((c) => c.dx));
  const sz = Math.min(...corners.map((c) => c.dz));
  const place = (r) => {
    const t = turn(r);
    return { ...r, dx: t.dx - sx, dz: t.dz - sz };
  };
  return { blocks: cells.map(place), air: air.map(place), leftOut, containers };
}

const countsText = (names) => {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => `${c} ${n}`).join(', ');
};

// The copy_structure tool: build_structure with the plan read from a box in the world.
export async function copyStructure(ctx, { x1, y1, z1, x2, y2, z2, origin, rotate = 0, clear = false, dry_run }) {
  const { bot, config } = ctx;
  if (![0, 90, 180, 270].includes(rotate)) return fail('rotate is 0, 90, 180 or 270');
  const min = new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
  const max = new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const limit = config.limits.maxBuildBlocks;
  if (volume > limit * 20) return fail(`source box is ${volume} blocks, the limit is ${limit * 20} for the box and ${limit} blocks to copy. Copy it in parts.`);
  const copy = copyPlan(bot, min, max, rotate);
  if (copy.error) return fail(copy.error);
  if (copy.blocks.length > limit) return fail(`the source has ${copy.blocks.length} blocks to copy, the limit is ${limit}. Copy it in parts.`);

  const notes = [];
  if (copy.leftOut.length) {
    const kinds = new Map();
    for (const { name, why } of copy.leftOut) {
      const key = `${name}: ${why}`;
      kinds.set(key, { name, why, count: (kinds.get(key)?.count ?? 0) + 1 });
    }
    notes.push(`Left out ${copy.leftOut.length} blocks build_structure can't place: ${[...kinds.values()].map((k) => `${k.count} ${k.name} (${k.why})`).join(', ')}`);
  }
  if (copy.containers.size) notes.push(`Containers are built empty, nothing inside them is copied: ${[...copy.containers].map(([n, c]) => `${c} ${n}`).join(', ')}`);
  if (clear) {
    const inWay = [];
    for (const r of copy.air) {
      const p = new Vec3(origin.x + r.dx, origin.y + r.dy, origin.z + r.dz);
      const b = bot.blockAt(p, false);
      if (b && !isAir(b.name)) inWay.push({ p, name: b.name });
    }
    if (inWay.length) {
      const at = inWay.slice(0, 3).map((w) => posText(w.p)).join('; ');
      notes.push(`${inWay.length} blocks at the copy stand where the source has air, left as they are: ${countsText(inWay.map((w) => w.name))} (at ${at}${inWay.length > 3 ? '; ...' : ''})`);
    } else notes.push('nothing at the copy stands where the source has air');
  }
  const head = `copy of ${posText(min)} to ${posText(max)}${rotate ? `, turned ${rotate} degrees clockwise,` : ''} at ${posText(origin)}`;
  const tail = notes.length ? `. ${notes.join('. ')}` : '';
  if (copy.blocks.length === 0) return ok(`${head}: nothing in the source to copy${tail}`);
  const built = await buildStructure(ctx, { origin, blocks: copy.blocks, dry_run });
  return { ...built, message: `${head}: ${built.message}${tail}` };
}

// Spots in a row break_blocks can't break before it stops.
const BREAK_GIVE_UP = 5;

// "3 at 1 64 0; 2 64 0; 3 64 0: protected block: chest ...", one line per reason, the first
// three spots each.
function reasonsText(left) {
  const kinds = new Map();
  for (const { p, why } of left) {
    const kind = why.replace(/-?\d+/g, 'N');
    if (!kinds.has(kind)) kinds.set(kind, { why, at: [] });
    kinds.get(kind).at.push(posText(p));
  }
  return [...kinds.values()].map(({ why, at }) => `${at.length} at ${at.slice(0, 3).join('; ')}${at.length > 3 ? '; ...' : ''}: ${why}`).join('. ');
}

// The break_blocks tool: breaks every block of one kind in the box, with the protections of
// break_block (see protectedReason), and with replace_with puts that block in each spot right
// after breaking it. Replacing goes bottom layer first, so each new block has the one under it
// to go against, and with too few of it only the lowest spots are done. Breaking goes top layer
// first. Each layer nearest first.
export async function breakBlocks(ctx, { x1, y1, z1, x2, y2, z2, block, replace_with, confirmed }) {
  const { bot, config, signal } = ctx;
  const min = new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
  const max = new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const limit = config.limits.maxDigBlocks ?? 1000;
  if (volume > limit) return fail(`box is ${volume} blocks, the limit is ${limit}. Do it in parts.`);
  const { name } = parseBlock(block);
  if (!bot.registry.blocksByName[name]) return fail(`unknown block: ${name}`);
  let put = null;
  if (replace_with) {
    put = parseBlock(replace_with);
    if (!bot.registry.blocksByName[put.name]) return fail(`unknown block: ${put.name}`);
    const problem = blockStateProblem(bot.registry, put.name, put.props);
    if (problem) return fail(problem);
    if (put.name === name && !Object.keys(put.props).length) return fail(`replace_with is ${name} too, so nothing would change`);
  }
  const props = put && Object.keys(put.props).length ? put.props : undefined;

  const spots = [];
  for (let y = min.y; y <= max.y; y++) {
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        const p = new Vec3(x, y, z);
        const here = bot.blockAt(p, false);
        if (!here) return fail(`part of the box is not loaded (around y ${y}), walk closer first`);
        if (here.name === name) spots.push(p);
      }
    }
  }
  const where = `from ${posText(min)} to ${posText(max)}`;
  if (spots.length === 0) return ok(`no ${name} in the box ${where}`);

  const left = [];
  const todo = [];
  for (const p of spots) {
    const refused = protectedReason(ctx, bot.blockAt(p, false), p, confirmed);
    if (refused) left.push({ p, why: refused });
    else todo.push(p);
  }
  todo.sort((a, b) => (put ? a.y - b.y : b.y - a.y));
  if (put && todo.length) {
    const item = itemFor(put.name, bot.registry);
    const uses = isDoubleSlab(put.name, put.props) ? 2 : 1;
    const have = inventoryCounts(bot.inventory.items()).get(item) ?? 0;
    const can = Math.floor(have / uses);
    if (can === 0) return fail(`missing item: ${item}, ${todo.length * uses} needed to replace ${todo.length} ${name}. Nothing was broken. ${missingHelp(bot, [item], 'break_blocks again')}`);
    for (const p of todo.splice(can)) left.push({ p, why: `not replaced, I only carry ${have} ${item}` });
  }

  const before = inventoryCounts(bot.inventory.items());
  const total = todo.length;
  const center = new Vec3((min.x + max.x) / 2 + 0.5, (min.y + max.y) / 2, (min.z + max.z) / 2 + 0.5);
  const radius = Math.max(max.x - min.x, max.z - min.z) / 2 + 4;
  const dist = (p, at) => (p.x + 0.5 - at.x) ** 2 + (p.y + 0.5 - at.y) ** 2 + (p.z + 0.5 - at.z) ** 2;
  // Ground that is still to be broken won't hold her.
  const stays = (ground) => !todo.some((q) => q.equals(ground));
  let broke = 0;
  let placed = 0;
  let streak = 0;
  let stopReason = null;
  while (todo.length > 0) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    const y = todo[0].y;
    const at = bot.entity.position.offset(0, 1.6, 0);
    let best = 0;
    const sooner = (a, b) => (a.deferred ?? false) - (b.deferred ?? false) || dist(a, at) - dist(b, at);
    for (let i = 1; i < todo.length && todo[i].y === y; i++) if (sooner(todo[i], todo[best]) < 0) best = i;
    const p = todo.splice(best, 1)[0];
    if (bot.blockAt(p, false)?.name === name) {
      if (!inReach(bot, p)) await walkTo(ctx, new GoalLookAtBlock(p, bot.world, { reach: 4 }), { place: 'climb', dig: true });
      // The block she stands on: off it first, or once the rest of the layer is done.
      if (underBot(bot, p) && !(await stepOff(ctx, p, stays))) {
        if (!p.deferred) {
          p.deferred = true;
          const end = todo.findIndex((q) => q.y !== y);
          todo.splice(end === -1 ? todo.length : end, 0, p);
        } else left.push({ p, why: 'the block under me, with no ground that stays to step onto' });
        continue;
      }
      const dug = await digBlock(ctx, p);
      if (!dug.ok) {
        left.push({ p, why: dug.message });
        if (++streak >= BREAK_GIVE_UP) {
          stopReason = `${streak} blocks in a row would not break, last: ${dug.message}`;
          break;
        }
        continue;
      }
      broke++;
      streak = 0;
      if (put) {
        const result = await placeOne(ctx, put.name, p, { props });
        if (result.ok) placed++;
        else {
          left.push({ p, why: `broken, but nothing put back: ${result.message}` });
          if (result.message.startsWith('missing item')) {
            stopReason = `ran out of ${itemFor(put.name, bot.registry)}`;
            break;
          }
        }
      }
      ctx.status?.progress(put ? `replaced ${placed} of ${total} ${name}` : `broke ${broke} of ${total} ${name}`);
    }
    if (todo.length > 0 && todo[0].y !== y && !signal?.aborted) await collectDrops(ctx, { center, radius, max: 8 });
  }
  if (signal?.aborted && !stopReason) stopReason = 'stopped';
  for (const p of todo) left.push({ p, why: 'not done before it stopped' });
  if (!signal?.aborted) await collectDrops(ctx, { center, radius, max: 24 });

  let message = put ? `replaced ${placed} ${name} with ${blockText(put.name, put.props)} ${where}` : `broke ${broke} ${name} ${where}`;
  if (put && broke > placed) message += ` (broke ${broke})`;
  if (left.length) message += `. Left ${left.length}: ${reasonsText(left)}`;
  message += `. Picked up ${gainedText(before, inventoryCounts(bot.inventory.items())) || 'nothing'}, now at ${posText(bot.entity.position)}`;
  if (stopReason) message += `. Stopped early: ${stopReason}`;
  return broke > 0 ? ok(message) : fail(message);
}
