import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay } from './util.js';
import { walkTo, watchScaffold, SCAFFOLD_BLOCKS } from './movement.js';
import { isTerrain, isBuildTerrain, isLogName, isWild, looksBuilt, nextToBuild, buildGrid, nearBuilds, CLEAR_ZONE, falls, dropBelow, holdsUp, DigSpot, isOre, mineVein } from './mining.js';
import { digBlock, inReach, isProtected, isReplaceable, removeScaffold, needsBetterTool, isOpenBlock, fixToolMaterials, blockReader, placeOne } from './blocks.js';
import { collectDrops, gainedText } from './items.js';
import { nearestFirst } from './build.js';

export { falls, dropBelow, holdsUp };

const { GoalNear } = pathfinderPkg.goals;

const AIR = new Set(['air', 'cave_air', 'void_air']);
// Passes over one layer while sand or gravel keeps falling in from above, and times one block
// is dug again as it does.
const MAX_PASSES = 8;
// A player digging from the floor reaches four blocks over her feet, so boxes up to 5 high are
// dug face by face from the floor.
const FACE_HEIGHT = 5;
// How far round she walks to get to the box before she may dig her way in: steps of walking and
// cells looked at.
const WALK_STEPS = 300;
const WALK_CELLS = 20000;
const FACES = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];
const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const CLIMB = new Set(['ladder', 'vine', 'twisting_vines', 'twisting_vines_plant', 'weeping_vines', 'weeping_vines_plant', 'cave_vines', 'cave_vines_plant']);
// Plants dug like clutter. Other wild blocks (bee nests, eggs, sculk, amethyst, pumpkins) stay.
const PLANT = /^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|brown_mushroom|red_mushroom|sugar_cane|cactus|cactus_flower|bamboo|sweet_berry_bush|kelp|kelp_plant|lily_pad|moss_carpet|azalea|flowering_azalea|bush|firefly_bush|hanging_roots|crimson_roots|warped_roots|nether_sprouts)$|_tulip$/;

// Grass, snow layers, vines and the like, which any player clears without a thought.
function isClutter(name) {
  return isReplaceable(name) && !AIR.has(name) && name !== 'water' && name !== 'lava';
}

export function isPlant(name) {
  return PLANT.test(name);
}

export function lavaNext(getName, pos) {
  return FACES.some((f) => getName(pos.plus(f)) === 'lava');
}

// Why a block in the box is left alone, or null to dig it. '' means there is nothing to dig.
// The tests that look around (touchesBuild, nearBuilt, canHarvest) are functions, so they only
// run when they matter.
export function digReason(name, { own = false, protectedBlocks = [], touchesBuild = () => false, nearBuilt = () => false, canHarvest = () => true } = {}) {
  if (!name || AIR.has(name)) return '';
  if (name === 'water' || name === 'bubble_column') return 'water';
  if (name === 'lava') return 'lava';
  if (own) return 'placed by me';
  if (isProtected(name, protectedBlocks)) return 'protected';
  if (isClutter(name)) return null;
  const terrain = isTerrain(name) || isBuildTerrain(name);
  if (!terrain && !isPlant(name)) return isLogName(name) ? 'logs' : isWild(name) ? 'wild' : 'not natural terrain';
  if (touchesBuild()) return 'touching something built';
  if (isBuildTerrain(name) && nearBuilt()) return 'build material near a build';
  if (!canHarvest()) return 'need a better tool';
  return null;
}

const REASON_TEXT = {
  water: 'water',
  lava: 'lava',
  'placed by me': 'blocks I placed',
  protected: 'protected blocks (break_block with confirmed, if a player asked)',
  logs: 'logs (use chop_tree)',
  wild: 'natural blocks I leave alone (nests, eggs, sculk, amethyst, pumpkins and the like)',
  'not natural terrain': 'not natural terrain, maybe built (break_block once a player confirms)',
  'touching something built': 'terrain touching something built',
  'build material near a build': `build materials within ${CLEAR_ZONE} blocks of a build`,
  'need a better tool': "blocks my tools can't harvest",
  'lava next to it': 'blocks with lava next to them',
  'opens into a cave': 'blocks over a drop of 3 or more (a cave below)',
  'holds up sand I left': 'blocks holding up sand or gravel I left',
  'standing on it': 'the block under me, with nowhere else to stand',
  'out of reach': 'blocks I could not reach',
  'one high': "blocks of a 1-high run, which I can't walk into (a tunnel to walk in is 2 high: y to y+1)",
  'dig failed': 'blocks that would not break',
  'still falling in': 'sand or gravel that kept falling in from above'
};

// "4 blocks with lava next to them (at 1 2 3; 1 2 4), 2 water (...)", first three spots each.
export function leftText(left) {
  const byReason = new Map();
  for (const [key, reason] of left) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(key.replaceAll(',', ' '));
  }
  return [...byReason]
    .map(([reason, spots]) => `${spots.length} ${REASON_TEXT[reason] ?? reason} (at ${spots.slice(0, 3).join('; ')}${spots.length > 3 ? '; ...' : ''})`)
    .join(', ');
}

// "2 deepslate_diamond_ore (at 1 2 3; 1 2 4)", every spot up to five of each.
function oreText(spots, getName) {
  const byName = new Map();
  for (const p of spots) {
    const name = getName(p);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(posText(p));
  }
  return [...byName].map(([name, at]) => `${at.length} ${name} (at ${at.slice(0, 5).join('; ')}${at.length > 5 ? '; ...' : ''})`).join(', ');
}

function inventoryCounts(bot) {
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
}

const cellKey = (p) => `${p.x},${p.y},${p.z}`;

// Where the bot can walk from start without breaking or placing anything, nearest first by
// steps: cells it can stand in (stand) joined by steps, one-block step ups, drops of up to three
// and climbs on ladders (climb). Each cell keeps its steps and the cell it came from. With goal,
// the search stops at the first step count that turns up cells goal accepts, and found holds them.
export function walkMap(start, stand, open, { climb = () => false, within = () => true, maxSteps = WALK_STEPS, cap = WALK_CELLS, goal = null } = {}) {
  const first = { pos: start, steps: 0, prev: null };
  const map = new Map([[cellKey(start), first]]);
  const queue = [first];
  const found = [];
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    if (found.length && cell.steps > found[0].steps) break;
    if (goal?.(cell.pos)) {
      found.push(cell);
      continue;
    }
    if (cell.steps >= maxSteps || map.size >= cap) continue;
    const p = cell.pos;
    const next = [];
    for (const d of DIRS) {
      const n = p.plus(d);
      if (stand(n)) {
        next.push(n);
        continue;
      }
      const up = n.offset(0, 1, 0);
      if (stand(up) && open(p.offset(0, 2, 0))) {
        next.push(up);
        continue;
      }
      if (!open(n) || !open(up)) continue;
      for (let k = 1; k <= 3; k++) {
        const down = n.offset(0, -k, 0);
        if (stand(down)) {
          next.push(down);
          break;
        }
        if (!open(down)) break;
      }
    }
    if (climb(p) && stand(p.offset(0, 1, 0))) next.push(p.offset(0, 1, 0));
    if (climb(p.offset(0, -1, 0)) && stand(p.offset(0, -1, 0))) next.push(p.offset(0, -1, 0));
    for (const n of next) {
      const key = cellKey(n);
      if (map.has(key) || !within(n)) continue;
      const c = { pos: n, steps: cell.steps + 1, prev: cell };
      map.set(key, c);
      queue.push(c);
    }
  }
  return { map, found };
}

// While dig_area runs, the pathfinder may only break what mayBreak allows: it never breaks a
// block whose break exclusion is 100 or more.
function limitBreaks(bot, mayBreak) {
  const modes = [...Object.values(bot.planModes ?? {}), ...Object.values(bot.moveModes ?? {})].filter((m) => Array.isArray(m?.exclusionAreasBreak));
  const rule = (block) => (block?.position && mayBreak(block.position) ? 0 : 100);
  for (const m of modes) m.exclusionAreasBreak.push(rule);
  return () => {
    for (const m of modes) {
      const i = m.exclusionAreasBreak.indexOf(rule);
      if (i >= 0) m.exclusionAreasBreak.splice(i, 1);
    }
  };
}

// Digs out exactly the box, the way a player would. First she finds a way to it on foot through
// space that is already open, however far round (up to WALK_STEPS); only when there is none does
// she dig her way in, and says so. A box up to FACE_HEIGHT high that she can walk up to at its
// floor level (a tunnel, a room) is dug face by face from inside: standing on the floor under its
// lowest layer, the head-high block in front first, then the one at her feet, then any above,
// stepping forward into the space she made, nearest face to where she stands next, so a tunnel
// goes from the end she came in by to the other. Anything else (a pit or ground she gets to from
// above, a hill, the part of a tall room over her reach) goes top layer first, each layer nearest
// block first, as before. Walks break nothing outside the box, only terrain and plants are dug,
// never the block she stands on, nothing next to lava or over a cave. Everything else stays and is
// listed with the reason. Ore the dig uncovers in the walls is mined out with its vein when ores
// is set, else listed with where it is.
export async function digArea(ctx, { x1, y1, z1, x2, y2, z2, ores = false }) {
  const { bot, config, signal } = ctx;
  const min = new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
  const max = new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const limit = config.limits.maxDigBlocks ?? 1000;
  if (volume > limit) return fail(`box is ${volume} blocks, the limit is ${limit}. Dig it in parts.`);
  fixToolMaterials(bot.registry);

  const getBlock = (p) => bot.blockAt(p, false);
  const getName = (p) => getBlock(p)?.name;
  const keyOf = cellKey;
  const inBox = (p) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z;
  const layer = (y) => {
    const cells = [];
    for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) cells.push(new Vec3(x, y, z));
    return cells;
  };
  for (let y = max.y; y >= min.y; y--) {
    if (layer(y).some((p) => !getBlock(p))) return fail(`part of the box is not loaded (around y ${y}), walk closer first`);
  }
  const height = max.y - min.y + 1;
  const faceTop = Math.min(max.y, min.y + FACE_HEIGHT - 1);

  // Built blocks around the box, only looked for when there are build materials in it.
  let grid = null;
  const nearBuilt = (p) => {
    if (!grid) {
      const built = [];
      for (let x = min.x - CLEAR_ZONE; x <= max.x + CLEAR_ZONE; x++) {
        for (let y = min.y - CLEAR_ZONE; y <= max.y + CLEAR_ZONE; y++) {
          for (let z = min.z - CLEAR_ZONE; z <= max.z + CLEAR_ZONE; z++) {
            const b = getBlock(new Vec3(x, y, z));
            if (b && looksBuilt(b.name, b.boundingBox)) built.push(b.position ?? new Vec3(x, y, z));
          }
        }
      }
      grid = buildGrid(built);
    }
    return nearBuilds(grid, p, CLEAR_ZONE);
  };

  const left = new Map();
  const failed = new Map();
  const stuck = new Map();
  let scaffold = null;
  const ownAt = (q, name) => Boolean(ctx.placed?.has(q, name)) || Boolean(scaffold?.placed.some((s) => s.equals(q)));
  const reasonAt = (p) => {
    const block = getBlock(p);
    const reason = digReason(block?.name, {
      own: Boolean(block && ctx.placed?.has(p, block.name)),
      protectedBlocks: config.protectedBlocks,
      touchesBuild: () => nextToBuild(getBlock, p, ownAt),
      nearBuilt: () => nearBuilt(p),
      canHarvest: () => !block.harvestTools || !needsBetterTool(block, bot.pathfinder.bestHarvestTool(block)?.type ?? null)
    });
    if (reason !== null) return reason;
    if (lavaNext(getName, p)) return 'lava next to it';
    if (dropBelow(getName, p) >= 3) return 'opens into a cave';
    const above = p.offset(0, 1, 0);
    if (falls(getName(above)) && inBox(above) && left.has(keyOf(above))) return 'holds up sand I left';
    return null;
  };

  let total = 0;
  for (let y = max.y; y >= min.y; y--) for (const p of layer(y)) if (reasonAt(p) === null) total++;

  // Standing room as a walk sees it: feet and head open, something under the feet, or water or a
  // ladder. strict also rules out standing on a block of the box still to be dug.
  const read = blockReader(bot);
  const open = (p) => isOpenBlock(read(p));
  const climb = (p) => CLIMB.has(read(p)?.name);
  const toDig = (p) => inBox(p) && !failed.has(keyOf(p)) && !stuck.has(keyOf(p)) && reasonAt(p) === null;
  const roomAt = (p, strict) => {
    if (!open(p) || !open(p.offset(0, 1, 0))) return false;
    const feet = read(p).name;
    if (feet === 'water' || CLIMB.has(feet)) return true;
    const under = p.offset(0, -1, 0);
    const below = read(under);
    if (!below || (below.boundingBox !== 'block' && !CLIMB.has(below.name))) return false;
    return !(strict && toDig(under));
  };
  // The box blocks a player standing at s digs without moving: in the next column on each side
  // the head-high block, then the one at her feet, then once the block under it is open up to
  // four over her feet, and over her head in her own column. Never the block she stands on.
  const workFrom = (s, top = max.y) => {
    const cells = [];
    const add = (c) => {
      if (c.y <= top && toDig(c)) cells.push(c);
    };
    for (const d of DIRS) {
      const col = s.plus(d);
      add(col.offset(0, 1, 0));
      add(col);
      for (let k = 2; k <= 4 && open(col.offset(0, k - 1, 0)); k++) add(col.offset(0, k, 0));
    }
    for (let k = 2; k <= 4 && open(s.offset(0, k - 1, 0)); k++) add(s.offset(0, k, 0));
    return cells;
  };
  const feetCell = () => bot.entity.position.floored();
  const local = (p) => p.x >= min.x - 2 && p.x <= max.x + 2 && p.z >= min.z - 2 && p.z <= max.z + 2 && p.y >= min.y - 4 && p.y <= max.y + 2;
  const badSpots = new Set();
  // The nearest spot on the box's floor level with blocks to dig from it, by steps through open
  // space; between spots as near, the one with the most to dig.
  const nextSpot = (s, top) => {
    const { found } = walkMap(s, (p) => roomAt(p, true), open, {
      climb,
      within: local,
      maxSteps: 4 * (max.x - min.x + max.z - min.z + 2) + 40,
      goal: (p) => p.y === min.y && !badSpots.has(keyOf(p)) && workFrom(p, top).length > 0
    });
    return found.map((c) => ({ pos: c.pos, work: workFrom(c.pos, top).length })).sort((a, b) => b.work - a.work)[0]?.pos ?? null;
  };
  // A box block she could dig standing at s: in reach and in sight.
  const reachesBox = (s) => {
    const eye = s.offset(0.5, 1.62, 0.5);
    const lo = (v, a, b) => Math.max(a, Math.min(b, v));
    const nearest = new Vec3(lo(eye.x, min.x, max.x + 1), lo(eye.y, min.y, max.y + 1), lo(eye.z, min.z, max.z + 1));
    if (nearest.distanceTo(eye) > 4.5) return false;
    for (let x = Math.max(min.x, Math.floor(eye.x - 5)); x <= Math.min(max.x, Math.floor(eye.x + 5)); x++) {
      for (let y = Math.max(min.y, Math.floor(eye.y - 5)); y <= Math.min(max.y, Math.floor(eye.y + 5)); y++) {
        for (let z = Math.max(min.z, Math.floor(eye.z - 5)); z <= Math.min(max.z, Math.floor(eye.z + 5)); z++) {
          const c = new Vec3(x, y, z);
          const centre = c.offset(0.5, 0.5, 0.5);
          if (centre.distanceTo(eye) > 4.5 || !toDig(c)) continue;
          if (!bot.world?.raycast) return true;
          const dir = centre.minus(eye);
          const hit = bot.world.raycast(eye, dir.normalize(), dir.norm() + 0.5);
          if (!hit || hit.position.equals(c)) return true;
        }
      }
    }
    return false;
  };
  // How she gets to the box on foot: a spot at its floor level with a face to dig (face by face),
  // else any spot with a box block in reach and in sight (top layer first). Null when there is no
  // such spot within reach of a walk.
  const findWay = () => {
    const here = feetCell();
    const lowX = Math.min(min.x, here.x) - 48;
    const highX = Math.max(max.x, here.x) + 48;
    const lowZ = Math.min(min.z, here.z) - 48;
    const highZ = Math.max(max.z, here.z) + 48;
    const lowY = Math.min(min.y, here.y) - 8;
    const highY = Math.max(max.y, here.y) + 8;
    const within = (p) => p.x >= lowX && p.x <= highX && p.z >= lowZ && p.z <= highZ && p.y >= lowY && p.y <= highY;
    const { map } = walkMap(here, (p) => roomAt(p, false), open, { climb, within });
    for (const cell of map.values()) {
      if (cell.pos.y === min.y && roomAt(cell.pos, true) && workFrom(cell.pos, faceTop).length) return { mode: 'face', cell };
    }
    for (const cell of map.values()) if (reachesBox(cell.pos)) return { mode: 'layers', cell };
    return null;
  };

  const before = inventoryCounts(bot);
  const dugNames = new Map();
  const digs = new Map();
  let dug = 0;
  let sinceCollect = 0;
  let failures = 0;
  // The error the library threw on the last try, if it threw one. The same one twice in a row
  // won't go away by trying more blocks.
  let thrown = null;
  let lastThrown = null;
  let stopReason = '';
  let face = false;
  const progressText = (y) => {
    const where = face || y === undefined ? '' : `, layer ${max.y - y + 1} of ${max.y - min.y + 1}`;
    return `dug ${dug} of about ${total} blocks${where}${failed.size ? `, ${failed.size} failed` : ''}`;
  };
  scaffold = watchScaffold(bot, (p) => p.x >= min.x - 3 && p.x <= max.x + 3 && p.z >= min.z - 3 && p.z <= max.z + 3 && p.y >= min.y - 2 && p.y <= max.y + 6);
  let mayBreak = () => false;
  const unlimit = limitBreaks(bot, (p) => mayBreak(p));
  const stepTo = (p) => walkTo(ctx, new GoalNear(p.x, p.y, p.z, 0), { place: false });

  // Ore in the walls, floor and ceiling the dig has uncovered.
  const uncovered = new Map();
  const took = new Map();
  let veinTrouble = '';
  let patched = 0;
  const noteOres = (p) => {
    for (const f of FACES) {
      const n = p.plus(f);
      if (inBox(n)) continue;
      const name = getName(n);
      if (name && isOre(name) && !ctx.placed?.has(n, name)) uncovered.set(keyOf(n), n);
    }
  };
  // With ores set, mines out every uncovered vein, nearest first, and comes back to back.
  const takeOres = async (back) => {
    if (!ores) return '';
    for (;;) {
      const eye = bot.entity.position.offset(0, 1.6, 0);
      const next = [...uncovered.values()].filter((p) => isOre(getName(p) ?? '')).sort((a, b) => a.distanceTo(eye) - b.distanceTo(eye))[0];
      if (!next) return '';
      uncovered.delete(keyOf(next));
      const rule = mayBreak;
      mayBreak = () => true;
      const veinCells = [];
      const vein = await mineVein(ctx, [next], {
        onDug: (p, name) => {
          took.set(name, (took.get(name) ?? 0) + 1);
          uncovered.delete(keyOf(p));
          veinCells.push(p);
        }
      });
      mayBreak = rule;
      if (vein.problem === 'stopped' || signal?.aborted) return 'stopped';
      if (vein.problem) veinTrouble = vein.problem;
      if (!feetCell().equals(back)) await stepTo(back);
      if (signal?.aborted) return 'stopped';
      // Ore taken out of the floor leaves a hole she can't walk over, so it gets a block put back,
      // as a player would.
      for (const p of veinCells) {
        if (p.y !== min.y - 1 || !inBox(p.offset(0, 1, 0)) || !open(p)) continue;
        const item = bot.inventory.items().find((i) => SCAFFOLD_BLOCKS.includes(i.name));
        if (!item) break;
        if ((await placeOne(ctx, item.name, p)).ok) patched++;
        if (signal?.aborted) return 'stopped';
      }
    }
  };

  // Counts a dig that worked, or a block that stays. Returns a reason to stop, or ''.
  const afterDig = async (p, name, problem, y) => {
    if (problem) {
      failed.set(keyOf(p), problem);
      ctx.status?.progress(progressText(y));
      if (thrown && thrown === lastThrown) return `breaking failed twice in a row with the same error: ${thrown}`;
      lastThrown = thrown;
      if (++failures >= 8) return `kept failing to reach or dig blocks, last at ${posText(p)}`;
      return '';
    }
    failures = 0;
    lastThrown = null;
    dug++;
    digs.set(keyOf(p), (digs.get(keyOf(p)) ?? 0) + 1);
    dugNames.set(name, (dugNames.get(name) ?? 0) + 1);
    noteOres(p);
    ctx.status?.progress(progressText(y));
    if (++sinceCollect >= 8) {
      await collectDrops(ctx);
      sinceCollect = 0;
    }
    await pause(80, 200);
    return '';
  };
  const digResult = (result) => {
    thrown = result.error ?? null;
    if (result.ok) return null;
    return result.message.startsWith('need a better tool') ? 'need a better tool' : 'dig failed';
  };

  // Face by face from the floor, for the layers up to top.
  const faceDig = async (top) => {
    face = true;
    let walkFails = 0;
    for (;;) {
      if (signal?.aborted) return 'stopped';
      const s = feetCell();
      const work = s.y === min.y ? workFrom(s, top).filter((c) => !holdsUp(bot.entity.position, c, getName)) : [];
      if (work.length) {
        for (const c of work) {
          if (signal?.aborted) return 'stopped';
          if (reasonAt(c) !== null) continue;
          if ((digs.get(keyOf(c)) ?? 0) >= MAX_PASSES) {
            stuck.set(keyOf(c), 'still falling in');
            continue;
          }
          if (!inReach(bot, c)) {
            failed.set(keyOf(c), 'out of reach');
            continue;
          }
          const name = getName(c);
          const sandAbove = falls(getName(c.offset(0, 1, 0)));
          const result = await digBlock(ctx, c);
          // A block that broke just as she was stopped still counts.
          const stop = !signal?.aborted || result.ok ? await afterDig(c, name, digResult(result)) : '';
          if (signal?.aborted) return 'stopped';
          if (stop) return stop;
          if (sandAbove && result.ok) await delay(600);
        }
        const stop = await takeOres(s);
        if (stop) return stop;
        continue;
      }
      const spot = nextSpot(s, top);
      if (!spot) return '';
      const walked = await stepTo(spot);
      if (signal?.aborted) return 'stopped';
      if (!feetCell().equals(spot) || spot.equals(s)) {
        badSpots.add(keyOf(spot));
        if (!feetCell().equals(spot) && ++walkFails >= 4) return `kept failing to walk inside the box, last to ${posText(spot)}: ${walked.message}`;
      } else {
        walkFails = 0;
      }
    }
  };

  // Walks to a spot and digs it, from a spot in reach that isn't on top of it. Returns a reason
  // when the block stays.
  const digOne = async (p) => {
    thrown = null;
    if (holdsUp(bot.entity.position, p, getName) || !inReach(bot, p)) {
      await walkTo(ctx, new DigSpot(p, bot.world, { reach: 4 }), { place: 'climb', dig: true });
      if (signal?.aborted) return 'stopped';
      if (holdsUp(bot.entity.position, p, getName)) return 'standing on it';
      if (!inReach(bot, p)) return 'out of reach';
    }
    const result = await digBlock(ctx, p);
    if (signal?.aborted) return 'stopped';
    return digResult(result);
  };

  // Top layer first, each layer nearest block first, from top down to bottom.
  const layerDig = async (top, bottom) => {
    face = false;
    for (let y = top; y >= bottom; y--) {
      let cells = [];
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        cells = [];
        for (const p of layer(y)) {
          const key = keyOf(p);
          if (failed.has(key)) continue;
          const reason = reasonAt(p);
          if (reason === null) {
            left.delete(key);
            cells.push(p);
          } else if (reason) left.set(key, reason);
          else left.delete(key);
        }
        if (!cells.length) break;

        let wait = false;
        for (const p of nearestFirst(cells, () => bot.entity.position.offset(0, 1.6, 0))) {
          if (signal?.aborted) return 'stopped';
          // The world changes as it digs: sand falls, water flows, a neighbour turns out to be lava.
          const reason = reasonAt(p);
          if (reason !== null) {
            if (reason) left.set(keyOf(p), reason);
            continue;
          }
          const name = getName(p);
          const sandAbove = falls(getName(p.offset(0, 1, 0)));
          const problem = await digOne(p);
          if (problem === 'stopped') return 'stopped';
          const stop = await afterDig(p, name, problem, y);
          if (stop) return stop;
          if (problem) continue;
          if (sandAbove) wait = true;
          const veins = await takeOres(feetCell());
          if (veins) return veins;
        }
        if (wait) await delay(600);
      }
      for (const p of cells) if (reasonAt(p) === null) stuck.set(keyOf(p), 'still falling in');
    }
    return '';
  };

  let dugIn = '';
  try {
    if (total > 0) {
      let way = findWay();
      if (!way && !signal?.aborted) {
        // No open way in: tunnel to the middle of the end of the box nearest her, at its floor.
        const cx = Math.floor((min.x + max.x) / 2);
        const cz = Math.floor((min.z + max.z) / 2);
        const ends = max.x - min.x >= max.z - min.z
          ? [new Vec3(min.x - 1, min.y, cz), new Vec3(max.x + 1, min.y, cz)]
          : [new Vec3(cx, min.y, min.z - 1), new Vec3(cx, min.y, max.z + 1)];
        const here = bot.entity.position;
        const end = ends.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0];
        const from = feetCell();
        let broke = 0;
        const onBreak = (oldBlock, newBlock) => {
          if (oldBlock?.boundingBox === 'block' && newBlock?.boundingBox === 'empty' && newBlock.position && !inBox(newBlock.position) && newBlock.position.distanceTo(bot.entity.position) < 6) broke++;
        };
        bot.on('blockUpdate', onBreak);
        mayBreak = () => true;
        let walked;
        try {
          walked = await walkTo(ctx, new GoalNear(end.x, end.y, end.z, 0), { place: false, dig: true });
        } finally {
          mayBreak = () => false;
          bot.removeListener('blockUpdate', onBreak);
        }
        if (broke) dugIn = `. There was no open way to the box on foot, so I dug my way in: ${broke} blocks from ${posText(from)} to ${posText(feetCell())}`;
        if (!signal?.aborted) way = findWay();
        if (!way && !signal?.aborted) stopReason = `could not get to the box: no open way on foot, and digging in failed: ${walked.message}`;
      }
      if (way && !signal?.aborted) {
        if (way.cell.steps > 0) {
          await stepTo(way.cell.pos);
          // A long way round goes in legs along the path found, in case the walk's own search
          // gives up on it.
          if (!feetCell().equals(way.cell.pos) && !signal?.aborted) {
            const path = [];
            for (let c = way.cell; c; c = c.prev) path.unshift(c.pos);
            for (let i = 10; i < path.length + 9 && !signal?.aborted; i += 10) {
              const p = path[Math.min(i, path.length - 1)];
              await stepTo(p);
              if (!feetCell().equals(p)) break;
            }
          }
        }
        if (signal?.aborted) stopReason = 'stopped';
        else if (way.mode === 'face') {
          if (!feetCell().equals(way.cell.pos)) stopReason = `could not walk to the box at ${posText(way.cell.pos)}, ${posText(bot.entity.position)}`;
          else {
            stopReason = await faceDig(faceTop);
            if (!stopReason && max.y > faceTop) {
              mayBreak = inBox;
              stopReason = await layerDig(max.y, faceTop + 1);
            }
          }
        } else {
          mayBreak = inBox;
          stopReason = await layerDig(max.y, min.y);
        }
      }
    }
    if (signal?.aborted) stopReason = 'stopped';
    mayBreak = () => false;
    // End on the floor of the box once any of it is dug.
    if (!signal?.aborted && dug > 0 && feetCell().y !== min.y) {
      const { found } = walkMap(feetCell(), (p) => roomAt(p, true), open, { climb, within: local, goal: (p) => p.y === min.y && inBox(p) });
      if (found[0]) await stepTo(found[0].pos);
    }
  } finally {
    scaffold.stop();
  }
  let removed = 0;
  try {
    removed = await removeScaffold(ctx, scaffold.placed);
    const center = new Vec3((min.x + max.x) / 2 + 0.5, (min.y + max.y) / 2, (min.z + max.z) / 2 + 0.5);
    if (!signal?.aborted) await collectDrops(ctx, { center, radius: Math.max(max.x - min.x, max.z - min.z) / 2 + 4, max: 24 });
  } finally {
    unlimit();
  }

  // What stays in the box and why, top down so sand on a block left is known.
  left.clear();
  for (let y = max.y; y >= min.y; y--) {
    for (const p of layer(y)) {
      const key = keyOf(p);
      if (failed.has(key)) {
        left.set(key, failed.get(key));
        continue;
      }
      const reason = reasonAt(p);
      if (reason === '') continue;
      if (reason !== null) left.set(key, reason);
      else if (stuck.has(key)) left.set(key, stuck.get(key));
      else if (!stopReason) left.set(key, height === 1 && !open(p.offset(0, 1, 0)) ? 'one high' : 'out of reach');
    }
  }

  const what = dugNames.size ? ` (${[...dugNames].map(([n, c]) => `${c} ${n}`).join(', ')})` : '';
  let message = `dug ${dug} blocks from ${posText(min)} to ${posText(max)}${what}${dugIn}`;
  if (left.size) message += `. Left ${leftText(left)}`;
  if (took.size) {
    const notes = [veinTrouble, patched ? `put ${patched} blocks back in the floor where ore came out` : ''].filter(Boolean).join('; ');
    message += `. Mined out the ore I uncovered: ${[...took].map(([n, c]) => `${c} ${n}`).join(', ')}${notes ? ` (${notes})` : ''}`;
  }
  const showing = [...uncovered.values()].filter((p) => isOre(getName(p) ?? ''));
  if (showing.length) message += `. Ore showing in the walls, left in place: ${oreText(showing, getName)}`;
  if (removed) message += `. Took down ${removed} scaffolding blocks`;
  message += `. Picked up ${gainedText(before, inventoryCounts(bot)) || 'nothing'}, now at ${posText(bot.entity.position)}`;
  if (stopReason) message += `. Stopped early: ${stopReason}`;
  if (dug > 0) return ok(message);
  if (!stopReason && !left.size) return ok(`nothing to dig: ${message}`);
  return fail(message);
}
