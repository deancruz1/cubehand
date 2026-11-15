import { Vec3 } from 'vec3';
import { ok, fail, posText } from './util.js';
import { placeOne, removeScaffold, digBlock, findReference } from './blocks.js';
import { watchScaffold, SCAFFOLD_BLOCKS } from './movement.js';
import { parseBlock, itemFor, matchesState, stateProblem, placementOptions } from './states.js';

// As in blocks.js: how far from the eyes a block can be placed without walking.
const REACH = 4.5;
// Walks in a row that fail to get near a group's blocks before the rest of that group is skipped.
const GIVE_UP_AFTER = 3;

const range = (a, b) => {
  const out = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
  return out;
};

// A gable roof of stairs over the walls from..to (outer wall corners, dy is the layer just above
// the wall tops), with the ridge along the longer side and an overhang all round. The ridge row
// gets slabs when the span is odd. fill closes the gable ends and the wall tops under the eaves.
function roofBlocks(part, put, slabFor) {
  const { from, to } = part;
  const stairs = parseBlock(part.block).name;
  const slab = slabFor(stairs);
  const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
  const y0 = from.dy;
  const [ax0, ax1] = [Math.min(from.dx, to.dx), Math.max(from.dx, to.dx)];
  const [az0, az1] = [Math.min(from.dz, to.dz), Math.max(from.dz, to.dz)];
  const alongX = ax1 - ax0 >= az1 - az0;
  // Work in (u, v): u runs along the ridge, v across it.
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
}

// Turns shapes into single blocks, in order, so later parts win where they overlap. A part of
// "air" takes out what came before it there (doorways, windows).
export function expandParts(parts = [], blocks = [], { slabFor = (s) => s.replace(/_stairs$/, '_slab') } = {}) {
  const out = new Map();
  const put = (dx, dy, dz, block) => {
    const key = `${dx},${dy},${dz}`;
    if (parseBlock(block).name === 'air') out.delete(key);
    else {
      out.delete(key);
      out.set(key, { dx, dy, dz, block });
    }
  };
  for (const part of parts) {
    const { from, to = from, block } = part;
    const xs = range(from.dx, to.dx);
    const ys = range(from.dy, to.dy);
    const zs = range(from.dz, to.dz);
    const [x0, x1, y0, y1, z0, z1] = [xs[0], xs.at(-1), ys[0], ys.at(-1), zs[0], zs.at(-1)];
    switch (part.shape) {
      case 'line': {
        const steps = Math.max(Math.abs(to.dx - from.dx), Math.abs(to.dy - from.dy), Math.abs(to.dz - from.dz));
        for (let i = 0; i <= steps; i++) {
          const t = steps ? i / steps : 0;
          put(Math.round(from.dx + (to.dx - from.dx) * t), Math.round(from.dy + (to.dy - from.dy) * t), Math.round(from.dz + (to.dz - from.dz) * t), block);
        }
        break;
      }
      case 'roof':
        roofBlocks({ ...part, from: { dx: x0, dy: from.dy, dz: z0 }, to: { dx: x1, dy: from.dy, dz: z1 } }, put, slabFor);
        break;
      default:
        for (const x of xs) {
          for (const y of ys) {
            for (const z of zs) {
              const sideX = x === x0 || x === x1;
              const sideZ = z === z0 || z === z1;
              const sideY = y === y0 || y === y1;
              const keep = {
                fill: true,
                hollow: sideX || sideZ || sideY,
                walls: sideX || sideZ,
                frame: (sideX && sideZ) || (sideX && sideY) || (sideZ && sideY)
              }[part.shape ?? 'fill'];
              if (keep) put(x, y, z, block);
            }
          }
        }
    }
  }
  for (const b of blocks) put(b.dx, b.dy, b.dz, b.block);
  return [...out.values()];
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

  const needed = new Map();
  for (const p of placements) {
    const item = itemName(p.block);
    needed.set(item, (needed.get(item) ?? 0) + 1);
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

// Places blocks one y layer at a time, in the order given, or with nearest set, all as one
// batch handed out by fromHere. Blocks with nothing to place against yet are retried once the
// rest of their layer is down, then with the layers above (a hanging lantern needs the block
// over it). Afterwards every block is checked once more, and the ones that are missing or
// turned the wrong way get one more go. strays holds the keys of planned spots where
// scaffolding went up; it is dug out before the block goes there. With giveUpAfter, that many
// failed walks in a row stop it early and gaveUp says why. all is the whole build, when these
// placements are only part of it, for the progress line and the count of items still needed.
export async function placeAll(ctx, placements, { nearest = false, strays, giveUpAfter, all = placements } = {}) {
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
        if (!dug.ok) return dug;
      }
      strays.delete(key);
    }
    const result = await placeOne(ctx, p.block, pos, { attach: p.attach, props: p.props });
    if (result.ok) p.done = true;
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
  for (const p of carried) failures.push(`no block to place against at ${p.x} ${p.y} ${p.z}`);

  const wrong = [];
  if (!stoppedReason) {
    const bot = ctx.bot;
    const off = placements.filter((p) => p.done && !matchesState(bot.blockAt(new Vec3(p.x, p.y, p.z), false), p.block, p.props));
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
async function placeGroups(ctx, groups, { strays }) {
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
    const result = await placeAll(ctx, group, { nearest: true, strays, all, giveUpAfter: GIVE_UP_AFTER });
    placed += result.placed;
    failures.push(...result.failures);
    wrong.push(...result.wrong);
    stoppedReason = result.stoppedReason;
    const left = group.filter((p) => !p.done);
    if (left.length > 0) report.push({ left, failures: result.failures, gaveUp: result.gaveUp });
  }
  for (const group of todo) report.push({ left: group, failures: [], notStarted: true });
  return { placed, failures, wrong, stoppedReason, report };
}

// "8 blocks around 2781 83 -5022 (8 deepslate_bricks, from 2781 80 -5025 to 2781 85 -5019):
// couldn't get up there ...", for one group of a build that didn't get finished.
function leftText({ left, failures, gaveUp, notStarted }, climbText) {
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
  else why = failures.length ? failures.slice(0, 3).join('; ') : 'not finished';
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

function slabFinder(bot) {
  return (stairs) => {
    const slab = stairs.replace(/_stairs$/, '_slab');
    return bot.registry.blocksByName[slab] ? slab : null;
  };
}

export async function buildStructure(ctx, { origin, blocks = [], parts = [], dry_run }) {
  const { bot, config } = ctx;
  const box = (p) => {
    const to = p.to ?? p.from;
    return (Math.abs(to.dx - p.from.dx) + 3) * (Math.abs(to.dy - p.from.dy) + 1) * (Math.abs(to.dz - p.from.dz) + 3);
  };
  if (parts.reduce((sum, p) => sum + box(p), 0) > config.limits.maxBuildBlocks * 20) {
    return fail(`those parts are far too big, the limit is ${config.limits.maxBuildBlocks} blocks`);
  }
  const all = expandParts(parts, blocks, { slabFor: slabFinder(bot) });
  const plan = planBuild({
    origin,
    blocks: all,
    botPos: bot.entity.position.floored(),
    getBlock: (x, y, z) => bot.blockAt(new Vec3(x, y, z), false),
    inventory: inventoryCounts(bot.inventory.items()),
    maxBlocks: config.limits.maxBuildBlocks,
    isKnownBlock: (name) => Boolean(bot.registry.blocksByName[name]),
    checkState: (name, props) => stateProblem(bot.registry, name, props),
    itemName: (name) => itemFor(name, bot.registry)
  });

  if (plan.error) return fail(plan.error);
  const needText = [...plan.needed].map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing';
  const missingText = plan.missing.map((m) => `${m.block} (need ${m.need}, have ${m.have}, ${m.need - m.have} more)`).join(', ');
  if (dry_run) {
    return ok(`Plan: ${all.length} blocks, ${plan.skipped} already in place. Needs ${needText}.${missingText ? ` Missing: ${missingText}.` : ' I have everything.'}`);
  }
  if (plan.missing.length > 0) return fail(`missing items: ${missingText}. Nothing was placed.`);

  // Like build_house: scaffolding may go up next to its own blocks, never made of the build's
  // materials, and comes down again afterwards.
  const site = buildSite(origin, all);
  site.ground = groundUnder(bot, site.min, site.max);
  bot.buildZone = buildZone(site, site.ground);
  bot.buildKeep = new Set([...plan.needed.keys()].map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined));
  const scaffold = watchBuildScaffold(bot, site, site.planned);
  let result;
  try {
    result = await placeGroups(ctx, groupBlocks(plan.placements), { strays: scaffold.strays });
  } finally {
    scaffold.stop();
    bot.buildZone = null;
    bot.buildKeep = null;
  }
  const removed = await removeScaffold(ctx, scaffold.leftover(plan.placements));

  const { placed, failures, wrong, stoppedReason, report } = result;
  const tried = failures.length + report.reduce((n, r) => n + (r.gaveUp?.tries ?? 0), 0);
  let message = `placed ${placed}, skipped ${plan.skipped}, failed ${tried}`;
  if (removed) message += `, took down ${removed} scaffolding blocks`;
  if (wrong.length > 0) message += `. ${wrong.length} came out turned the wrong way, first: ${wrong.slice(0, 3).join('; ')}`;
  if (report.length > 0) {
    const climb = [...inventoryCounts(bot.inventory.items())].filter(([n]) => SCAFFOLD_BLOCKS.includes(n) && !plan.needed.has(n));
    const climbText = climb.length ? `I have ${climb.map(([n, c]) => `${c} ${n}`).join(', ')}, so scaffolding up is possible` : 'I have no blocks to scaffold with (dirt, cobblestone and the like)';
    const count = report.reduce((n, r) => n + r.left.length, 0);
    message += `. Left to do, ${count} blocks in ${report.length} group${report.length === 1 ? '' : 's'}: ${report.map((r) => leftText(r, climbText)).join('. ')}`;
  }
  if (stoppedReason) message += `. Stopped early: ${stoppedReason}`;
  if (report.length > 0) message += '. build_structure with the same plan again skips what is already in place';
  if (placed > 0) return ok(message);
  return stoppedReason || report.length > 0 || failures.length > 0 ? fail(message) : ok(message);
}
