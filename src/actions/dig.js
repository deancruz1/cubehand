import { Vec3 } from 'vec3';
import { ok, fail, posText, pause, delay } from './util.js';
import { walkTo, watchScaffold } from './movement.js';
import { isTerrain, isBuildTerrain, isLogName, isWild, looksBuilt, nextToBuild, buildGrid, nearBuilds, CLEAR_ZONE, falls, dropBelow, holdsUp, DigSpot } from './mining.js';
import { digBlock, inReach, isProtected, isReplaceable, removeScaffold, needsBetterTool } from './blocks.js';
import { collectDrops, gainedText } from './items.js';
import { nearestFirst } from './build.js';

export { falls, dropBelow, holdsUp };

const AIR = new Set(['air', 'cave_air', 'void_air']);
// Passes over one layer while sand or gravel keeps falling in from above.
const MAX_PASSES = 8;
const FACES = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];
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

function inventoryCounts(bot) {
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
}

// Digs out a box top layer first, each layer nearest block first, like a player clearing
// ground: terrain and plants only, never the block it stands on, nothing next to lava or over
// a cave. Everything else stays and is listed with the reason.
export async function digArea(ctx, { x1, y1, z1, x2, y2, z2 }) {
  const { bot, config, signal } = ctx;
  const min = new Vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
  const max = new Vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const limit = config.limits.maxDigBlocks ?? 1000;
  if (volume > limit) return fail(`box is ${volume} blocks, the limit is ${limit}. Dig it in parts.`);

  const getBlock = (p) => bot.blockAt(p, false);
  const getName = (p) => getBlock(p)?.name;
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;
  const inBox = (p) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z;
  const layer = (y) => {
    const cells = [];
    for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) cells.push(new Vec3(x, y, z));
    return cells;
  };
  for (let y = max.y; y >= min.y; y--) {
    if (layer(y).some((p) => !getBlock(p))) return fail(`part of the box is not loaded (around y ${y}), walk closer first`);
  }

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

  const before = inventoryCounts(bot);
  const dugNames = new Map();
  let dug = 0;
  let sinceCollect = 0;
  let failures = 0;
  let stopReason = '';
  scaffold = watchScaffold(bot, (p) => p.x >= min.x - 3 && p.x <= max.x + 3 && p.z >= min.z - 3 && p.z <= max.z + 3 && p.y >= min.y - 2 && p.y <= max.y + 6);

  // Walks to a spot in reach that isn't on top of the block, then digs it. Returns a reason
  // when the block stays.
  const digOne = async (p) => {
    if (holdsUp(bot.entity.position, p, getName) || !inReach(bot, p)) {
      await walkTo(ctx, new DigSpot(p, bot.world, { reach: 4 }), { place: 'climb' });
      if (signal?.aborted) return 'stopped';
      if (holdsUp(bot.entity.position, p, getName)) return 'standing on it';
      if (!inReach(bot, p)) return 'out of reach';
    }
    const result = await digBlock(ctx, p);
    if (signal?.aborted) return 'stopped';
    if (!result.ok) return result.message.startsWith('need a better tool') ? 'need a better tool' : 'dig failed';
    return null;
  };

  try {
    outer: for (let y = max.y; y >= min.y; y--) {
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
          if (signal?.aborted) {
            stopReason = 'stopped';
            break outer;
          }
          // The world changes as it digs: sand falls, water flows, a neighbour turns out to be lava.
          const reason = reasonAt(p);
          if (reason !== null) {
            if (reason) left.set(keyOf(p), reason);
            continue;
          }
          const name = getName(p);
          const sandAbove = falls(getName(p.offset(0, 1, 0)));
          const problem = await digOne(p);
          if (problem === 'stopped') {
            stopReason = 'stopped';
            break outer;
          }
          if (problem) {
            failed.set(keyOf(p), problem);
            if (++failures >= 8) {
              stopReason = `kept failing to reach or dig blocks, last at ${posText(p)}`;
              break outer;
            }
            continue;
          }
          failures = 0;
          dug++;
          dugNames.set(name, (dugNames.get(name) ?? 0) + 1);
          if (sandAbove) wait = true;
          ctx.status?.progress(`dug ${dug} of about ${total} blocks, layer ${max.y - y + 1} of ${max.y - min.y + 1}`);
          if (++sinceCollect >= 8) {
            await collectDrops(ctx);
            sinceCollect = 0;
          }
          await pause(80, 200);
        }
        if (wait) await delay(600);
      }
      for (const p of cells) if (reasonAt(p) === null) left.set(keyOf(p), 'still falling in');
    }
  } finally {
    scaffold.stop();
  }
  const removed = await removeScaffold(ctx, scaffold.placed);
  const center = new Vec3((min.x + max.x) / 2 + 0.5, (min.y + max.y) / 2, (min.z + max.z) / 2 + 0.5);
  if (!signal?.aborted) await collectDrops(ctx, { center, radius: Math.max(max.x - min.x, max.z - min.z) / 2 + 4, max: 24 });

  for (const [key, reason] of failed) left.set(key, reason);
  const what = dugNames.size ? ` (${[...dugNames].map(([n, c]) => `${c} ${n}`).join(', ')})` : '';
  let message = `dug ${dug} blocks from ${posText(min)} to ${posText(max)}${what}`;
  if (left.size) message += `. Left ${leftText(left)}`;
  if (removed) message += `. Took down ${removed} scaffolding blocks`;
  message += `. Picked up ${gainedText(before, inventoryCounts(bot)) || 'nothing'}, now at ${posText(bot.entity.position)}`;
  if (stopReason) message += `. Stopped early: ${stopReason}`;
  if (dug > 0) return ok(message);
  if (!stopReason && !left.size) return ok(`nothing to dig: ${message}`);
  return fail(message);
}
