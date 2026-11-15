import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo, watchScaffold, SCAFFOLD_BLOCKS, isNaturalBlock } from './movement.js';
import { matchesBlockName, inReach, isProtected, findNearest, removeScaffold, placeOne, isReplaceable, openSpace, buriedText, fixToolMaterials, settle } from './blocks.js';
import { collectDrops, gainedText } from './items.js';

const { GoalLookAtBlock, GoalNear } = pathfinderPkg.goals;

const SEARCH_RANGE = 32;
const MAX_BLOCKS = 64;
// The most blocks one vein gives before she goes back.
const VEIN_MAX = 32;
// The block list from one search is reused until the bot has moved this far from where it
// searched, or it is this old.
const RESCAN_DISTANCE = 6;
const RESCAN_MS = 30000;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const OPEN = new Set([...AIR, 'water']);
const FACES = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);

export function falls(name) {
  return Boolean(name) && (GRAVITY.has(name) || name.endsWith('_concrete_powder'));
}

// Open blocks straight under pos, up to max.
export function dropBelow(getName, pos, max = 3) {
  let n = 0;
  while (n < max && AIR.has(getName(pos.offset(0, -1 - n, 0)))) n++;
  return n;
}

// Whether the bot's body, 0.6 wide with its feet at position, is over the column of pos. It can
// stand over four blocks at once.
function inColumn(position, pos) {
  const xs = [Math.floor(position.x - 0.3), Math.floor(position.x + 0.3)];
  const zs = [Math.floor(position.z - 0.3), Math.floor(position.z + 0.3)];
  return xs.includes(pos.x) && zs.includes(pos.z);
}

// True when the bot stands on pos, or on sand or gravel resting on it, so digging pos would
// drop it.
export function holdsUp(position, pos, getName) {
  const support = Math.floor(position.y - 0.01);
  if (pos.y > support) return false;
  for (let y = pos.y + 1; y <= support; y++) if (!falls(getName(new Vec3(pos.x, y, pos.z)))) return false;
  return inColumn(position, pos);
}

// True when pos is above the bot's head with sand or gravel on it, so digging it would drop
// that onto the bot.
export function dropsOnto(position, pos, getName) {
  if (pos.y < Math.floor(position.y) + 2 || !falls(getName(pos.offset(0, 1, 0)))) return false;
  return inColumn(position, pos);
}

// A spot within reach of the block that isn't on top of it.
export class DigSpot extends GoalLookAtBlock {
  isEnd(node) {
    if (node.x === this.pos.x && node.z === this.pos.z && node.y > this.pos.y) return false;
    return super.isEnd(node);
  }
}

export function isOre(name) {
  return name.endsWith('_ore') || name === 'ancient_debris';
}

// Deepslate and stone versions of an ore belong to the same vein.
export function oreKind(name) {
  return name.replace(/^deepslate_/, '');
}

// Whether mine may go for the block at p: in non-xray mode, only one with a face on open space
// the bot can get to, which is what a player sees.
export function mineableTest(ctx, range = SEARCH_RANGE) {
  if (ctx.config?.bot?.xray === true) return { space: null, sees: () => true };
  const space = openSpace(ctx.bot, { range });
  return { space, sees: (p) => space.exposes(p) };
}

// Of blocks found through the rock, the ones mine would end up taking: those in sight, the rest
// of the vein behind an ore in sight, and for other terrain all of it once any is in sight, since
// every block dug opens up the next.
export function mineableBlocks(ctx, found) {
  if (ctx.config?.bot?.xray === true || !found.length) return found;
  const { sees } = mineableTest(ctx);
  const nameAt = (p) => ctx.bot.blockAt(p, false)?.name ?? '';
  const seen = found.filter(sees);
  const keep = new Set();
  if (seen.some((p) => !isOre(nameAt(p)))) for (const p of found) if (!isOre(nameAt(p))) keep.add(String(p));
  const byKey = new Map(found.map((p) => [String(p), p]));
  const queue = seen.filter((p) => isOre(nameAt(p)));
  for (const p of queue) keep.add(String(p));
  for (let i = 0; i < queue.length; i++) {
    const kind = oreKind(nameAt(queue[i]));
    for (const f of FACES) {
      const n = byKey.get(String(queue[i].plus(f)));
      if (!n || keep.has(String(n)) || !isOre(nameAt(n)) || oreKind(nameAt(n)) !== kind) continue;
      keep.add(String(n));
      queue.push(n);
    }
  }
  return found.filter((p) => keep.has(String(p)));
}

// What mine takes: the natural blocks the pathfinder may dig through, and ores. Anything else
// could be part of something a player built.
export function isTerrain(name) {
  return isNaturalBlock(name) || isOre(name);
}

// Natural blocks that generate in bulk but are also common building materials. mine takes
// them too, but only well away from anything that looks built (see CLEAR_ZONE).
const BUILD_TERRAIN = new Set([
  'sandstone', 'red_sandstone', 'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta',
  'brown_terracotta', 'red_terracotta', 'light_gray_terracotta', 'obsidian', 'crying_obsidian',
  'ice', 'packed_ice', 'blue_ice', 'basalt', 'smooth_basalt', 'blackstone', 'gilded_blackstone',
  'glowstone', 'magma_block', 'amethyst_block', 'crimson_nylium', 'warped_nylium'
]);
export const CLEAR_ZONE = 5;

export function isBuildTerrain(name) {
  return BUILD_TERRAIN.has(name);
}

// Things that grow or generate in the wild around those blocks, so they don't count as built.
export const WILD = new Set([
  'cactus', 'bamboo', 'pumpkin', 'melon', 'cocoa', 'lily_pad', 'sea_pickle', 'moss_carpet', 'azalea', 'flowering_azalea',
  'big_dripleaf', 'small_dripleaf', 'mangrove_roots', 'bee_nest', 'pointed_dripstone', 'budding_amethyst',
  'amethyst_cluster', 'large_amethyst_bud', 'medium_amethyst_bud', 'small_amethyst_bud', 'chorus_plant', 'chorus_flower',
  'nether_wart_block', 'warped_wart_block', 'shroomlight', 'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem',
  'sculk', 'sculk_vein', 'sculk_sensor', 'sculk_shrieker', 'sculk_catalyst', 'suspicious_sand', 'suspicious_gravel', 'bedrock',
  'muddy_mangrove_roots', 'frosted_ice', 'turtle_egg', 'sniffer_egg', 'pale_moss_block', 'pale_moss_carpet', 'creaking_heart',
  'infested_stone', 'infested_deepslate'
]);
export const isWild = (name) => WILD.has(name) || name.endsWith('coral_block');
// Crafted blocks with no full hitbox that still give a build away.
const CRAFTED_THIN = /(^|_)(torch|lantern|sign|rail|ladder|banner|button|lever|pressure_plate|candle|chain|hook|head|skull)$|redstone_wire|flower_pot|^potted_/;

// Whether a kind of block looks like part of a build for the wider test around BUILD_TERRAIN:
// anything solid that isn't terrain, logs, leaves or a wild plant, and crafted thin blocks.
export function looksBuilt(name, boundingBox) {
  if (isTerrain(name) || BUILD_TERRAIN.has(name) || isLogName(name) || isWild(name)) return false;
  return boundingBox === 'block' || CRAFTED_THIN.test(name);
}

// Logs as trees grow them. Stripped logs only come from a player's axe.
const isNaturalLog = (name) => isLogName(name) && !name.startsWith('stripped_');

// True when pos or any block touching it (corners included) looks like part of a build: a solid
// block that isn't terrain, a natural log or a wild plant, or a crafted thin block like a torch
// or rail. Cobblestone and cobbled deepslate count unless own(pos, name) says the bot put them
// there. Natural cobblestone only shows up in structures and where lava met water, so the most
// that costs is a block of stone around it.
export function nextToBuild(getBlock, pos, own = () => false) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const p = pos.offset(dx, dy, dz);
        const b = getBlock(p);
        if (!b) continue;
        const built = CRAFTED_THIN.test(b.name) ||
          (b.boundingBox === 'block' && !isNaturalBlock(b.name) && !isNaturalLog(b.name) && !BUILD_TERRAIN.has(b.name) && !isWild(b.name));
        if (built && !own(p, b.name)) return true;
      }
    }
  }
  return false;
}

// Built blocks sorted into 8-block cells, so checking a position only looks at the cells around it.
const cellKey = (x, y, z) => `${Math.floor(x / 8)},${Math.floor(y / 8)},${Math.floor(z / 8)}`;

export function buildGrid(builds) {
  const grid = new Map();
  for (const p of builds) {
    const key = cellKey(p.x, p.y, p.z);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  return grid;
}

// True when a built block is within radius of pos along every axis.
export function nearBuilds(grid, pos, radius = CLEAR_ZONE) {
  const [cx, cy, cz] = cellKey(pos.x, pos.y, pos.z).split(',').map(Number);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (Math.abs(p.x - pos.x) <= radius && Math.abs(p.y - pos.y) <= radius && Math.abs(p.z - pos.z) <= radius) return true;
        }
      }
    }
  }
  return false;
}

export function notTerrainText(query) {
  let instead = '';
  if (query === 'cobblestone') instead = ' To get cobblestone, mine stone.';
  else if (query === 'cobbled_deepslate') instead = ' To get cobbled_deepslate, mine deepslate.';
  else if (isLogName(query) || query === 'log' || query === 'stem') instead = ' For logs, use chop_tree.';
  return `${query} isn't natural terrain, so it may be part of something a player built, and mine only takes terrain.${instead} ` +
    `To take particular ${query} blocks, use break_block on each one, and only once a player has confirmed which.`;
}

// A block a player can see: at least one side touches air or water.
export function isExposed(getName, pos) {
  return FACES.some((f) => OPEN.has(getName(pos.plus(f))));
}

// Lower is better. Like a player in a quarry: work the visible wall in front of you, from
// your feet up to a little above your head, close to where you last mined so you clear one
// face at a time. Digging into the floor makes pits, so it comes last. Hidden blocks cost a
// lot because reaching them means digging through others.
// dy is the block's height relative to the bot's feet.
export function targetScore({ distance, exposed, dy, fromLast }) {
  let score = distance + (exposed ? 0 : 12);
  if (dy < 0) score += 10 + 3 * -dy;
  else if (dy > 3) score += 2 * (dy - 3);
  if (fromLast !== undefined) score += 0.5 * fromLast;
  return score;
}

function inventoryCounts(bot) {
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
}

function lavaNext(getName, pos) {
  return FACES.some((f) => getName(pos.plus(f)) === 'lava');
}

async function harvest(bot, block) {
  fixToolMaterials(bot.registry);
  const fresh = bot.blockAt(block.position, false) ?? block;
  const tool = bot.pathfinder.bestHarvestTool(fresh);
  if (tool) await bot.equip(tool, 'hand');
  if (fresh.harvestTools && !fresh.canHarvest(bot.heldItem?.type ?? null)) return 'need a better tool';
  await settle(bot);
  await bot.dig(fresh);
  return null;
}

// Mines the ore blocks in start and every block of the same ore joined to them face to face,
// which come into view one by one as she digs, then walks back to back. Reaching a block of the
// vein may mean digging a step or two, as a player following a vein would. onDug(pos, name) hears
// of each block. Gives { taken: name to count, problem }.
export async function mineVein(ctx, start, { back, onDug } = {}) {
  const { bot, config, signal } = ctx;
  const getName = (p) => bot.blockAt(p, false)?.name;
  const first = getName(start[0]);
  const taken = new Map();
  if (!first || !isOre(first)) return { taken, problem: '' };
  const kind = oreKind(first);
  const sameOre = (p) => {
    const name = getName(p);
    return Boolean(name) && isOre(name) && oreKind(name) === kind;
  };
  const seen = new Set(start.map(String));
  const todo = [...start];
  let total = 0;
  let problem = '';
  while (todo.length && total < VEIN_MAX) {
    if (signal?.aborted) {
      problem = 'stopped';
      break;
    }
    const eye = bot.entity.position.offset(0, 1.6, 0);
    todo.sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(eye) - b.offset(0.5, 0.5, 0.5).distanceTo(eye));
    const p = todo.shift();
    if (!sameOre(p)) continue;
    const name = getName(p);
    // A drop under a block over her head is just the space she dug; under one at her feet or
    // lower it is a cave she could fall into.
    const low = p.y <= Math.floor(bot.entity.position.y);
    if (isProtected(name, config.protectedBlocks) || ctx.placed?.has(p, name) || lavaNext(getName, p) || (low && dropBelow(getName, p) >= 3)) continue;
    if (holdsUp(bot.entity.position, p, getName) || !inReach(bot, p)) {
      await walkTo(ctx, new DigSpot(p, bot.world, { reach: 4 }), { place: false, dig: true });
      if (signal?.aborted) {
        problem = 'stopped';
        break;
      }
    }
    const at = bot.entity.position;
    if (!inReach(bot, p) || holdsUp(at, p, getName) || dropsOnto(at, p, getName)) continue;
    let result;
    try {
      result = await harvest(bot, bot.blockAt(p, false));
    } catch {
      continue;
    }
    if (result) {
      problem = `${result} for ${name}`;
      break;
    }
    total++;
    taken.set(name, (taken.get(name) ?? 0) + 1);
    onDug?.(p, name);
    for (const f of FACES) {
      const n = p.plus(f);
      if (seen.has(String(n))) continue;
      seen.add(String(n));
      if (sameOre(n)) todo.push(n);
    }
    await pause(100, 300);
  }
  if (back && !signal?.aborted && bot.entity.position.distanceTo(back.offset(0.5, 0, 0.5)) > 1) {
    const walked = await walkTo(ctx, new GoalNear(back.x, back.y, back.z, 0), { place: false });
    if (!walked.ok && bot.entity.position.distanceTo(back.offset(0.5, 0, 0.5)) > 1) {
      problem = problem || `could not walk back to ${posText(back)} after the vein: ${walked.message}`;
    }
  }
  return { taken, problem };
}

// Mines like a player would: picks the easiest visible blocks nearby, walks around to reach
// them, mines ores it comes across with the rest of their vein, and picks up the drops as it
// goes. Only blocks with a face on open space she can get to, unless bot.xray is on. Only
// terrain: never its own blocks, and nothing that is part of or right next to a build.
export async function mine(ctx, { block, count }) {
  const { bot, config, signal } = ctx;
  const xray = config?.bot?.xray === true;
  const query = block ?? 'stone';
  const target = Math.min(count ?? 16, MAX_BLOCKS);
  if (!bot.registry.blocksArray.some((b) => matchesBlockName(b.name, query))) return fail(`unknown block: ${query}`);
  const matches = (name) => matchesBlockName(name, query) && (isTerrain(name) || BUILD_TERRAIN.has(name));
  if (!bot.registry.blocksArray.some((b) => matches(b.name))) return fail(notTerrainText(query));
  const wanted = (name) => matches(name) || isOre(name);
  const ids = bot.registry.blocksArray.filter((b) => wanted(b.name)).map((b) => b.id);
  const builtIds = bot.registry.blocksArray.filter((b) => looksBuilt(b.name, b.boundingBox)).map((b) => b.id);
  const getBlock = (p) => bot.blockAt(p, false);
  const getName = (p) => getBlock(p)?.name;
  const own = (p, name) => Boolean(ctx.placed?.has(p, name));

  const before = inventoryCounts(bot);
  let last;
  let mined = 0;
  let sinceCollect = 0;
  let failures = 0;
  let failed = 0;
  let lastThrown = null;
  const ores = new Map();
  const skip = new Set();
  let stopReason = '';
  const progressText = () => `mined ${mined} of ${target} ${query}${failed ? `, ${failed} failed` : ''}`;

  // Searching the whole sphere is slow, so the blocks found are kept and checked again each
  // time, and the search only runs again when they run out or go stale.
  let pool = [];
  let scanned = null;
  let sight = null;
  const scan = () => {
    scanned = { at: Date.now(), from: bot.entity.position.clone() };
    sight = mineableTest(ctx);
    const found = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RANGE, count: 300 }).filter((p) => !nextToBuild(getBlock, p, own));
    const strict = (p) => BUILD_TERRAIN.has(getName(p));
    if (!found.some(strict)) {
      pool = found;
      return;
    }
    // The box around a block at the edge of the search reaches about 9 blocks further out.
    const grid = buildGrid(bot.findBlocks({ matching: builtIds, maxDistance: SEARCH_RANGE + 2 * CLEAR_ZONE, count: 10000 }));
    pool = found.filter((p) => !strict(p) || !nearBuilds(grid, p));
  };
  const stale = () => !scanned || Date.now() - scanned.at > RESCAN_MS || bot.entity.position.distanceTo(scanned.from) > RESCAN_DISTANCE;

  let buried = 0;
  let veinTrouble = '';
  while (mined < target) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    const here = bot.entity.position;
    const feet = here.floored();
    const under = feet.offset(0, -1, 0);
    let reused = !stale();
    if (!reused) scan();
    let bonus;
    let main;
    for (;;) {
      pool = pool.filter((p) => {
        const name = getName(p);
        return name && wanted(name);
      });
      const seen = pool
        .filter((p) => !skip.has(p.toString()) && !p.equals(under) && !lavaNext(getName, p) && dropBelow(getName, p) < 3)
        .map((p) => ({ pos: p, name: getName(p), exposed: xray ? isExposed(getName, p) : sight.sees(p) }))
        .filter((c) => !isProtected(c.name, config.protectedBlocks) && !ctx.placed?.has(c.pos, c.name));
      const candidates = xray ? seen : seen.filter((c) => c.exposed);
      buried = seen.filter((c) => !c.exposed && matches(c.name)).length;

      // Ores a player would notice and grab on the way: visible and within reach.
      bonus = candidates.filter((c) => !matches(c.name) && isOre(c.name) && c.exposed && inReach(bot, c.pos));
      main = candidates
        .filter((c) => matches(c.name))
        .map((c) => ({
          ...c,
          score: targetScore({ distance: c.pos.distanceTo(here), exposed: c.exposed, dy: c.pos.y - feet.y, fromLast: last ? c.pos.distanceTo(last) : undefined })
        }))
        .sort((a, b) => a.score - b.score);
      if (bonus.length || main.length || !reused) break;
      scan();
      reused = false;
    }
    const pick = bonus[0] ?? main[0];
    if (!pick) {
      stopReason = !xray && buried ? `${buriedText(query, buried)} (within ${SEARCH_RANGE} blocks)` : `no more ${query} within ${SEARCH_RANGE} blocks`;
      break;
    }

    if (holdsUp(bot.entity.position, pick.pos, getName) || !inReach(bot, pick.pos)) {
      const walked = await walkTo(ctx, new DigSpot(pick.pos, bot.world, { reach: 4 }), { place: false, dig: xray });
      if (!walked.ok && !inReach(bot, pick.pos)) {
        skip.add(pick.pos.toString());
        failed++;
        ctx.status?.progress(progressText());
        if (++failures >= 5) {
          stopReason = `kept failing to reach blocks, last at ${posText(pick.pos)}`;
          break;
        }
        continue;
      }
    }
    // Where the walk ended decides these: not the block holding the bot up, and not one with
    // sand or gravel on it right overhead.
    const at = bot.entity.position;
    if (holdsUp(at, pick.pos, getName) || dropsOnto(at, pick.pos, getName)) {
      skip.add(pick.pos.toString());
      continue;
    }

    const fresh = bot.blockAt(pick.pos, false);
    if (!fresh || fresh.name !== pick.name) continue;
    let problem;
    let thrown = null;
    try {
      problem = await harvest(bot, fresh);
    } catch (err) {
      problem = thrown = err.message;
    }
    if (problem) {
      skip.add(pick.pos.toString());
      if (matches(pick.name) && problem === 'need a better tool') {
        stopReason = `I need a better tool to mine ${pick.name}`;
        break;
      }
      failed++;
      ctx.status?.progress(progressText());
      if (thrown && thrown === lastThrown) {
        stopReason = `breaking failed twice in a row with the same error: ${thrown}`;
        break;
      }
      lastThrown = thrown;
      continue;
    }

    failures = 0;
    lastThrown = null;
    last = pick.pos;
    const took = (p, name) => {
      sight?.space?.add(p);
      if (matches(name)) mined++;
      else ores.set(name, (ores.get(name) ?? 0) + 1);
      ctx.status?.progress(progressText());
    };
    took(pick.pos, pick.name);
    if (isOre(pick.name)) {
      const next = FACES.map((f) => pick.pos.plus(f)).filter((n) => {
        const name = getName(n);
        return name && isOre(name) && oreKind(name) === oreKind(pick.name);
      });
      if (next.length) {
        const vein = await mineVein(ctx, next, { back: bot.entity.position.floored(), onDug: took });
        if (vein.problem === 'stopped') {
          stopReason = 'stopped';
          break;
        }
        if (vein.problem) veinTrouble = vein.problem;
      }
    }
    if (++sinceCollect >= 4) {
      await collectDrops(ctx);
      sinceCollect = 0;
    }
    await pause(100, 300);
  }
  await collectDrops(ctx);

  const oreText = ores.size ? `, plus ${[...ores].map(([n, c]) => `${c} ${n}`).join(', ')}` : '';
  const gained = [...inventoryCounts(bot)].map(([n, c]) => [n, c - (before.get(n) ?? 0)]).filter(([, c]) => c > 0);
  const pickedUp = gained.length ? gained.map(([n, c]) => `${c} ${n}`).join(', ') : 'nothing';
  const summary = `mined ${mined} ${query}${oreText}, picked up ${pickedUp}, now at ${posText(bot.entity.position)}${veinTrouble ? `. In a vein: ${veinTrouble}` : ''}`;
  if (mined >= target) return ok(summary);
  return mined > 0 || ores.size ? ok(`${summary}. Stopped early: ${stopReason}`) : fail(`${summary}. ${stopReason}`);
}

export function isLogName(name) {
  return name.endsWith('_log') || name.endsWith('_stem');
}

// Logs joined to start (corners count), within a tree-sized box around it. joins(pos) can turn
// away logs that are there but don't belong to a tree.
export function treeLogs(getName, start, joins = () => true, max = 200) {
  const seen = new Set([start.toString()]);
  const queue = [start];
  const logs = [];
  while (queue.length > 0 && logs.length < max) {
    const p = queue.shift();
    logs.push(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const n = p.offset(dx, dy, dz);
          const key = n.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          if (Math.abs(n.x - start.x) > 6 || Math.abs(n.z - start.z) > 6 || n.y < start.y - 2 || n.y > start.y + 32) continue;
          if (isLogName(getName(n) ?? '') && joins(n)) queue.push(n);
        }
      }
    }
  }
  return logs;
}

// Real trees have leaves that can decay. Leaves a player placed are persistent, and log
// walls have none, so builds are left alone.
function hasNaturalLeaves(bot, logs) {
  for (const p of logs) {
    for (const f of FACES) {
      const b = bot.blockAt(p.plus(f), false);
      if (!b) continue;
      if (b.name.endsWith('wart_block')) return true;
      if (b.name.endsWith('_leaves') && String(b.getProperties().persistent) !== 'true') return true;
    }
  }
  return false;
}

// Sideways logs this far above the bottom of the trunk are branches.
const BRANCH_HEIGHT = 3;

// Whether the log at a position can be part of a tree: not one the bot placed, not stripped, and
// not touching anything built. It also has to stand upright, unless base (the y of the trunk's
// lowest log) is given and it is high enough to be a branch. Log cabin walls and fallen trees
// lie sideways near the ground, or touch planks and glass.
export function treeLogTest(ctx) {
  const { bot } = ctx;
  const getBlock = (p) => bot.blockAt(p, false);
  const own = (p, name) => Boolean(ctx.placed?.has(p, name));
  return (p, base) => {
    const b = getBlock(p);
    if (!b || !isNaturalLog(b.name) || own(p, b.name)) return false;
    const axis = b.getProperties?.().axis;
    if (axis && axis !== 'y' && (base === undefined || p.y < base + BRANCH_HEIGHT)) return false;
    return !nextToBuild(getBlock, p, own);
  };
}

const BELOW = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// The lowest upright log under start, following a leaning trunk (acacia) down too.
function trunkBase(start, isTreeLog) {
  let p = start;
  for (;;) {
    const next = BELOW.map(([dx, dz]) => p.offset(dx, -1, dz)).find((q) => isTreeLog(q));
    if (!next) return p;
    p = next;
  }
}

// The logs of the tree start is part of, lowest first, and whether they have the leaves of a
// real tree.
export function treeAt(ctx, start, isTreeLog = treeLogTest(ctx)) {
  const getName = (p) => ctx.bot.blockAt(p, false)?.name;
  const base = trunkBase(start, isTreeLog);
  const logs = treeLogs(getName, base, (p) => isTreeLog(p, base.y)).sort((a, b) => a.y - b.y);
  return { logs, tree: hasNaturalLeaves(ctx.bot, logs) };
}

export function saplingFor(logName) {
  const wood = logName.replace(/^stripped_/, '').replace(/_(log|stem|wood|hyphae)$/, '');
  if (wood === 'mangrove') return 'mangrove_propagule';
  if (wood === 'crimson' || wood === 'warped') return `${wood}_fungus`;
  return `${wood}_sapling`;
}

const SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'pale_moss_block', 'mud', 'muddy_mangrove_roots', 'farmland']);
const FUNGUS_SOIL = new Set([...SOIL, 'mycelium', 'crimson_nylium', 'warped_nylium', 'soul_soil']);

export function canPlantOn(ground, sapling) {
  return (sapling.endsWith('_fungus') ? FUNGUS_SOIL : SOIL).has(ground);
}

// Puts a sapling of the tree's wood back where the trunk stood, if the bot carries one and the
// ground takes it. Returns the sapling's name, or null.
async function replant(ctx, pos, logName) {
  const { bot } = ctx;
  const sapling = saplingFor(logName);
  if (!bot.inventory.items().some((i) => i.name === sapling)) return null;
  const spot = bot.blockAt(pos, false);
  const ground = bot.blockAt(pos.offset(0, -1, 0), false);
  if (!spot || !ground || !isReplaceable(spot.name) || spot.name === 'water' || spot.name === 'lava') return null;
  if (!canPlantOn(ground.name, sapling)) return null;
  const placed = await placeOne(ctx, sapling, pos);
  return placed.ok ? sapling : null;
}

function hasScaffoldItems(bot) {
  return bot.inventory.items().some((i) => SCAFFOLD_BLOCKS.includes(i.name));
}

// Chops one tree from the bottom up, climbing on scaffolding for the high logs, then takes
// the scaffolding down again and picks up the logs.
async function chopOne(ctx, logs) {
  const { bot, signal } = ctx;
  const base = logs[0];
  const scaffold = watchScaffold(bot, (p) => Math.abs(p.x - base.x) <= 7 && Math.abs(p.z - base.z) <= 7 && p.y >= base.y - 2 && p.y <= base.y + 34);
  const left = [...logs];
  let chopped = 0;
  let failures = 0;
  let problem = '';
  try {
    while (left.length > 0) {
      if (signal?.aborted) {
        problem = 'stopped';
        break;
      }
      left.sort((a, b) => a.y - b.y);
      const pick = left.find((p) => inReach(bot, p)) ?? left[0];
      left.splice(left.indexOf(pick), 1);
      if (!isLogName(bot.blockAt(pick, false)?.name ?? '')) continue;

      if (!inReach(bot, pick)) {
        const walked = await walkTo(ctx, new GoalLookAtBlock(pick, bot.world, { reach: 4 }), { place: 'climb', dig: true });
        if (!walked.ok && !inReach(bot, pick)) {
          if (++failures >= 4) {
            const hint = hasScaffoldItems(bot) ? '' : ', I have no dirt or cobblestone to climb on';
            problem = `couldn't reach the last ${left.length + 1} logs${hint}`;
            break;
          }
          continue;
        }
      }
      try {
        await harvest(bot, bot.blockAt(pick, false));
        chopped++;
        failures = 0;
        ctx.status?.progress(`chopped ${chopped} of ${logs.length} logs from this tree`);
      } catch (err) {
        if (++failures >= 4) {
          problem = `kept failing: ${err.message}`;
          break;
        }
      }
      await pause(100, 250);
    }
  } finally {
    scaffold.stop();
  }
  await removeScaffold(ctx, scaffold.placed);
  await collectDrops(ctx, { radius: 8, center: base, max: 12 });
  return { chopped, problem };
}

// Chops whole trees: the one at x y z, or the nearest ones. trees is how many (default 1), and
// log (like birch_log) keeps it to trees of that wood. Logs the bot placed itself are never part
// of a tree, and neither are stripped logs, logs lying sideways or logs touching a build.
// Replants a sapling when it has one.
export async function chopTree(ctx, { x, y, z, trees, log }) {
  const { bot } = ctx;
  const wanted = Math.min(Math.max(trees ?? 1, 1), 5);
  const getName = (p) => bot.blockAt(p, false)?.name;
  const own = (p) => {
    const name = getName(p);
    return Boolean(name && ctx.placed?.has(p, name));
  };
  const isTreeLog = treeLogTest(ctx);
  const before = inventoryCounts(bot);
  const handled = new Set();
  const done = [];
  let stopReason = '';

  if (log && !isNaturalLog(log)) return fail(`not a log a tree grows: ${log}`);
  let given = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : null;
  if (given && !isLogName(getName(given) ?? '')) return fail(`no log at ${posText(given)}`);
  if (given && own(given)) return fail(`the log at ${posText(given)} is one I placed, not a tree`);
  const buildText = () => `the logs at ${posText(given)} look like part of a build, not a tree`;
  if (given && !isTreeLog(given)) return fail(buildText());
  const ofWood = (name) => (log ? name === log : isLogName(name));

  while (done.length < wanted) {
    if (ctx.signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    const start = given ?? findNearest(bot, ofWood, SEARCH_RANGE, 300).find((p) => !handled.has(p.toString()) && isTreeLog(p));
    if (!start) {
      stopReason = `no more ${log ? `${log} ` : ''}trees within ${SEARCH_RANGE} blocks`;
      break;
    }
    const { logs, tree } = treeAt(ctx, start, isTreeLog);
    for (const p of logs) handled.add(p.toString());
    if (!tree) {
      if (given) return fail(buildText());
      continue;
    }
    given = null;
    const wood = getName(logs[0]);
    const result = await chopOne(ctx, logs);
    if (result.chopped) {
      const planted = ctx.signal?.aborted ? null : await replant(ctx, logs[0], wood);
      done.push(`${result.chopped} logs at ${posText(logs[0])}${planted ? ` and planted ${planted} in its place` : ''}`);
    }
    if (result.problem) {
      stopReason = result.problem;
      break;
    }
  }

  const got = gainedText(before, inventoryCounts(bot)) || 'nothing';
  const summary = `chopped ${done.length ? done.join(', ') : 'nothing'}, picked up ${got}, now at ${posText(bot.entity.position)}`;
  if (!stopReason) return ok(summary);
  return done.length ? ok(`${summary}. Stopped early: ${stopReason}`) : fail(`${summary}. ${stopReason}`);
}
