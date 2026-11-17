import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay, customName } from './util.js';
import { walkTo } from './movement.js';
import { inReach, isProtected, isReplaceable } from './blocks.js';
import { canPlantOn, isTerrain, isBuildTerrain } from './mining.js';
import { isTarget } from './combat.js';
import { collectDrops, dropsNear, gainedText } from './items.js';
import { nearestFirst } from './build.js';
import { stateText } from './states.js';
import { isAdmin } from '../guard.js';
import { fieldRecord } from '../tended.js';

const { GoalLookAtBlock, GoalNear, GoalFollow } = pathfinderPkg.goals;

const AIR = new Set(['air', 'cave_air', 'void_air']);
const UP = new Vec3(0, 1, 0);
const TOP = new Vec3(0.5, 1, 0.5);
const SEARCH_RANGE = 32;
export const MAX_AREA = 512;
const MOB_REACH = 3;

const BANNED = new Set(['tnt', 'tnt_minecart', 'end_crystal']);
const FIRE_ITEMS = new Set(['flint_and_steel', 'fire_charge']);
const DANGER = new Set([...BANNED, ...FIRE_ITEMS, 'lava_bucket']);
const FULL_BUCKETS = { water_bucket: 'water', lava_bucket: 'lava', powder_snow_bucket: 'powder_snow' };
const DRINKS = new Set(['potion', 'milk_bucket', 'honey_bottle', 'ominous_bottle']);
const ANY_TIME_DRINKS = new Set(['honey_bottle', 'ominous_bottle']);
const THROWN = new Set(['snowball', 'egg', 'blue_egg', 'brown_egg', 'ender_pearl', 'splash_potion', 'lingering_potion', 'experience_bottle', 'wind_charge']);
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);
const CROPS = {
  wheat_seeds: 'wheat', beetroot_seeds: 'beetroots', carrot: 'carrots', potato: 'potatoes', pumpkin_seeds: 'pumpkin_stem',
  melon_seeds: 'melon_stem', torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop'
};
// Seeds whose plants the harvest chore can take, unlike saplings.
const FIELD_SEEDS = new Set([...Object.keys(CROPS), 'nether_wart', 'sweet_berries']);
const BERRY_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud', 'muddy_mangrove_roots', 'farmland']);
const GROWS = new Set([...Object.values(CROPS), 'sweet_berry_bush', 'cocoa']);
// Clicking these opens a trade window instead of using the item.
const NO_USE = new Set(['villager', 'wandering_trader']);
const MOUNTS = /(_boat|_raft)$|^(minecart|horse|donkey|mule|camel|pig|strider|skeleton_horse|zombie_horse|llama|trader_llama)$/;
const LIGHTABLE = /^(soul_)?campfire$|(^|_)candle(_cake)?$/;
const FIRE_GROUND = new Set(['netherrack', 'soul_sand', 'soul_soil', 'obsidian']);
const FIRE_OK = new Set([...AIR, 'water', 'lava', 'fire', 'soul_fire', 'nether_portal', 'obsidian', 'crying_obsidian', 'netherrack', 'soul_sand', 'soul_soil', 'bedrock', 'magma_block', 'grass_block']);
const USE_BLOCK = /(_door|_trapdoor|_fence_gate|_button|^lever)$/;

export function plantFor(item) {
  if (CROPS[item]) return { block: CROPS[item], fits: (g) => g === 'farmland', ground: 'farmland' };
  if (item === 'nether_wart') return { block: 'nether_wart', fits: (g) => g === 'soul_sand', ground: 'soul sand' };
  if (item === 'sweet_berries') return { block: 'sweet_berry_bush', fits: (g) => BERRY_GROUND.has(g), ground: 'grass or dirt' };
  if (item.endsWith('_sapling') || item === 'mangrove_propagule' || item === 'crimson_fungus' || item === 'warped_fungus') {
    return { block: item, fits: (g) => canPlantOn(g, item), ground: item.endsWith('_fungus') ? 'nylium or soil' : 'grass or dirt' };
  }
  return null;
}

export function useKind(item) {
  if (BANNED.has(item)) return 'banned';
  if (item === 'bucket') return 'fill';
  if (FULL_BUCKETS[item]) return 'pour';
  if (item.endsWith('_hoe')) return 'till';
  if (item === 'bone_meal') return 'grow';
  if (FIRE_ITEMS.has(item)) return 'fire';
  if (plantFor(item)) return 'plant';
  if (THROWN.has(item)) return 'throw';
  if (DRINKS.has(item)) return 'drink';
  return 'other';
}

// Blocks fire can't catch on or be carried to: air, fluids, obsidian, netherrack and stone-like
// terrain. Anything else (wood, leaves, grass, wool, anything built) counts as unsafe.
export function fireSafe(name) {
  if (!name) return false;
  if (FIRE_OK.has(name)) return true;
  return (isTerrain(name) || isBuildTerrain(name)) && !/(grass|fern|bush|leaves)$/.test(name);
}

// The first block around spot that isn't fireSafe: dx and dz within r, dy from down to up.
export function unsafeNear(getName, spot, r, down, up) {
  for (let dy = down; dy <= up; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = spot.offset(dx, dy, dz);
        const name = getName(p);
        if (!fireSafe(name)) return { name: name ?? 'an unloaded block', pos: p };
      }
    }
  }
  return null;
}

// Whether fire or lava may go at spot, null when it may, else why not. clicked is the block
// clicked (lit its lit state). Lighting a campfire or candle, a nether portal, and fire on
// netherrack or soul sand are fine for anyone when nothing that burns or was built is close.
// Any other fire, and all lava, only for an admin, with the same check, lava over a wider area
// and with no player close. TNT is never lit.
export function dangerProblem({ item, clicked, lit, spot, getName, admin, playerNear }) {
  if (BANNED.has(item)) return `I never use ${item}`;
  if (item === 'lava_bucket') {
    if (!admin) return 'only an admin can have me pour lava';
    const bad = unsafeNear(getName, spot, 6, -2, 4);
    if (bad) return `${bad.name} at ${posText(bad.pos)} could catch fire or is built, too close to the lava`;
    if (playerNear(spot, 6)) return 'a player is within 6 blocks of the spot';
    return null;
  }
  if (!FIRE_ITEMS.has(item)) return null;
  if (clicked === 'tnt') return 'I never light TNT';
  if (LIGHTABLE.test(clicked)) return String(lit) === 'false' ? null : `the ${clicked} is already lit`;
  const bad = unsafeNear(getName, spot, 2, -1, 5);
  if (bad) return `${bad.name} at ${posText(bad.pos)} could catch fire or is built, too close to the fire`;
  if (playerNear(spot, 2)) return 'a player is standing right there';
  if (!FIRE_GROUND.has(clicked) && !admin) {
    return `only an admin can have me start a fire on ${clicked}. For anyone I light campfires, candles, nether portals and fire on netherrack or soul sand`;
  }
  return null;
}

// Mobs to use an item on, nearest first: never players or traders, and mobs with name tags
// only when target is that name.
export function pickMobs(entities, self, here, target, range = SEARCH_RANGE) {
  return entities
    .filter((e) => e !== self && e.position && e.position.distanceTo(here) <= range && !NO_USE.has(e.name) && isTarget(e, target))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
}

// A boat, minecart or saddle mob called target (a type like boat, or a name tag).
export function isMount(entity, target) {
  if (entity.type === 'player' || !MOUNTS.test(entity.name ?? '')) return false;
  const wanted = target.toLowerCase();
  const tag = customName(entity)?.toLowerCase();
  if (tag) return tag === wanted;
  return entity.name === wanted || entity.name.endsWith(`_${wanted}`);
}

// Growth that bone meal can still push on: crops below their last age, and saplings.
export function growable(name, age, maxAge) {
  if (GROWS.has(name)) return age === undefined || maxAge === undefined || age < maxAge;
  return name.endsWith('_sapling') || name === 'mangrove_propagule' || name === 'crimson_fungus' || name === 'warped_fungus';
}

// The item to use: the exact name, or a short one (hoe, seeds, sapling). A query that is an
// item name itself (bucket, potion) only matches that item. Fire, lava and TNT are only taken
// by their full name.
export function findItem(items, query, itemsByName) {
  const exact = items.find((i) => i.name === query);
  if (exact || itemsByName?.[query]) return exact;
  return items.find((i) => i.name.endsWith(`_${query}`) && !DANGER.has(i.name));
}

const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
const inventoryKey = (bot) => bot.inventory.items().map((i) => `${i.name}:${i.count}`).sort().join(',');

function inventoryCounts(bot) {
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
}

function usedText(before, after) {
  const used = [...before].map(([n, c]) => [n, c - (after.get(n) ?? 0)]).filter(([, c]) => c > 0);
  return used.map(([n, c]) => `${c} ${n}`).join(', ');
}

export async function waitFor(test, ms = 1200) {
  const end = Date.now() + ms;
  for (;;) {
    if (test()) return true;
    if (Date.now() > end) return false;
    await delay(100);
  }
}

function playerNear(bot) {
  return (spot, r) => Object.values(bot.players ?? {}).some((p) => p.entity && p.entity !== bot.entity && p.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) <= r);
}

// A player within 6 blocks of aim, or within 4 of the line from the bot to it.
function playersOnThrow(bot, aim) {
  const from = bot.entity.position;
  const to = aim.offset(0.5, 0.5, 0.5);
  const line = to.minus(from);
  const length2 = line.dot(line) || 1;
  return Object.values(bot.players ?? {}).some(({ entity: e }) => {
    if (!e || e === bot.entity) return false;
    if (e.position.distanceTo(to) <= 6) return true;
    const t = Math.min(Math.max(e.position.minus(from).dot(line) / length2, 0), 1);
    return e.position.distanceTo(from.plus(line.scaled(t))) <= 4;
  });
}

// A spot that sees the block and has the feet at minY or higher.
class Higher extends GoalLookAtBlock {
  constructor(pos, world, minY) {
    super(pos, world, { reach: 4 });
    this.minY = minY;
  }

  isEnd(node) {
    return node.y >= this.minY && super.isEnd(node);
  }
}

async function getInReach(ctx, pos, { minY, goal } = {}) {
  const { bot } = ctx;
  const fine = () => inReach(bot, pos) && (minY === undefined || Math.floor(bot.entity.position.y) >= minY);
  if (fine()) return null;
  const walked = await walkTo(ctx, goal ?? (minY === undefined ? new GoalLookAtBlock(pos, bot.world, { reach: 4 }) : new Higher(pos, bot.world, minY)), { place: false });
  if (fine()) return null;
  return `could not get close enough to ${posText(pos)}: ${walked.message}`;
}

export async function hold(bot, name) {
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return false;
  if (bot.heldItem?.name !== name) await bot.equip(item, 'hand');
  return true;
}

export function ageOf(bot, block) {
  const age = block.getProperties?.().age;
  const state = bot.registry.blocksByName?.[block.name]?.states?.find((s) => s.name === 'age');
  return { age: age === undefined ? undefined : Number(age), maxAge: state?.num_values ? state.num_values - 1 : undefined };
}

function growthText(bot, block) {
  if (!block) return 'nothing';
  const { age, maxAge } = ageOf(bot, block);
  if (age === undefined || maxAge === undefined) return block.name;
  return `${block.name} at age ${age} of ${maxAge}${age >= maxAge ? ' (fully grown)' : ''}`;
}

// The jobs that work on one block at a time and can take a whole box: what fits, and the use.
function blockJob(ctx, item, kind, single) {
  const { bot } = ctx;
  const getBlock = (p) => bot.blockAt(p, false);
  const getName = (p) => getBlock(p)?.name;
  if (kind === 'till') {
    return {
      verb: 'tilled',
      why: (p) => (TILLABLE.has(getName(p)) ? (AIR.has(getName(p.offset(0, 1, 0))) ? null : 'something is on top of it') : `${getName(p)} can't be tilled, only dirt and grass`),
      act: async (p) => {
        const before = getName(p);
        await bot.activateBlock(getBlock(p), UP, TOP);
        return (await waitFor(() => getName(p) !== before)) ? `${before} at ${posText(p)} is now ${getName(p)}` : null;
      }
    };
  }
  if (kind === 'plant') {
    const plant = plantFor(item);
    // The block given can be the ground or the empty spot on it.
    const groundOf = (p) => (isReplaceable(getName(p)) && !['water', 'lava'].includes(getName(p)) ? p.offset(0, -1, 0) : p);
    return {
      verb: 'planted',
      at: groundOf,
      why: (p) => {
        const g = groundOf(p);
        const spot = getName(g.offset(0, 1, 0));
        if (!plant.fits(getName(g))) return `${item} only grows on ${plant.ground}, not ${getName(g)}`;
        if (!isReplaceable(spot) || spot === 'water' || spot === 'lava') return `${spot} is in the way on top`;
        return null;
      },
      act: async (p) => {
        const g = groundOf(p);
        await bot.activateBlock(getBlock(g), UP, TOP);
        return (await waitFor(() => getName(g.offset(0, 1, 0)) === plant.block)) ? `planted ${plant.block} at ${posText(g.offset(0, 1, 0))}` : null;
      }
    };
  }
  return {
    verb: 'used bone meal on',
    why: (p) => {
      const block = getBlock(p);
      const { age, maxAge } = ageOf(bot, block);
      if (age !== undefined && maxAge !== undefined && age >= maxAge && GROWS.has(block.name)) return `the ${block.name} is already fully grown`;
      return single || growable(block.name, age, maxAge) ? null : `${block.name} doesn't grow with bone meal`;
    },
    // A few goes, like a player, until it is grown or the bone meal runs out.
    act: async (p) => {
      let used = 0;
      while (used < 4 && count(bot, 'bone_meal') > 0) {
        const block = getBlock(p);
        const { age, maxAge } = ageOf(bot, block);
        if (used > 0 && !growable(block.name, age, maxAge)) break;
        const have = count(bot, 'bone_meal');
        await hold(bot, 'bone_meal');
        await bot.activateBlock(block, UP, TOP);
        if (!(await waitFor(() => count(bot, 'bone_meal') < have))) break;
        used++;
        await pause(150, 300);
      }
      return used ? `used ${used} bone_meal at ${posText(p)}, it is now ${growthText(bot, getBlock(p))}` : null;
    }
  };
}

// Tills, plants or bone meals one block, or every fitting block in the box from pos to corner.
async function useOnBlocks(ctx, item, kind, pos, corner) {
  const { bot, signal } = ctx;
  const single = !corner;
  const job = blockJob(ctx, item, kind, single);
  let targets = [pos];
  let min = pos;
  let max = pos;
  if (corner) {
    min = new Vec3(Math.min(pos.x, corner.x), Math.min(pos.y, corner.y), Math.min(pos.z, corner.z));
    max = new Vec3(Math.max(pos.x, corner.x), Math.max(pos.y, corner.y), Math.max(pos.z, corner.z));
    const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
    if (volume > MAX_AREA) return fail(`box is ${volume} blocks, the limit is ${MAX_AREA}`);
    targets = [];
    for (let y = max.y; y >= min.y; y--) {
      for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) targets.push(new Vec3(x, y, z));
    }
  }
  if (targets.some((p) => !bot.blockAt(p, false))) return fail(`position not loaded around ${posText(pos)}`);
  const seen = new Set();
  targets = targets.filter((p) => !job.why(p)).map((p) => job.at?.(p) ?? p).filter((p) => !seen.has(p.toString()) && seen.add(p.toString()));
  if (single && !targets.length) return fail(job.why(pos));
  if (!targets.length) return fail(`nothing in the box to use ${item} on`);

  let done = 0;
  const notes = [];
  const failures = [];
  let stopReason = '';
  for (const p of nearestFirst(targets, () => bot.entity.position.offset(0, 1.6, 0))) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    if (job.why(p)) continue;
    if (!count(bot, item)) {
      stopReason = `ran out of ${item}`;
      break;
    }
    const far = await getInReach(ctx, p);
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    if (far) {
      failures.push(far);
      continue;
    }
    await hold(bot, item);
    const note = await job.act(p);
    if (note) {
      done++;
      notes.push(note);
      if (!single) ctx.status?.progress(`${job.verb} ${done} of ${targets.length} blocks`);
    } else failures.push(`using ${item} on ${bot.blockAt(p, false)?.name} at ${posText(p)} changed nothing`);
    await pause(80, 200);
  }

  if (single) return done ? ok(notes[0]) : fail(failures[0] ?? stopReason);
  let message = `${job.verb} ${done} of ${targets.length} blocks with ${item}`;
  if (kind === 'grow' && notes.length) message += ` (last: ${notes.at(-1)})`;
  if (failures.length) message += `. ${failures.length} failed, first: ${failures.slice(0, 3).join('; ')}`;
  if (stopReason) message += `. Stopped early: ${stopReason}`;
  if (!done) return fail(message);
  // A box a player had her till or sow is a field for the tending chore.
  const sown = kind === 'till' || (kind === 'plant' && FIELD_SEEDS.has(item));
  if (sown && ctx.tended && ctx.requester && ctx.tended.add('fields', fieldRecord(min, max, bot.game?.dimension)) === 'added') {
    message += '. I will tend this field from now on';
  }
  return ok(message);
}

// Picks up water, lava or powder snow at pos with an empty bucket.
async function fillBucket(ctx, pos) {
  const { bot } = ctx;
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  const fluid = ['water', 'lava', 'powder_snow'].includes(block.name) ? block.name : null;
  if (!fluid) return fail(`no water, lava or powder snow at ${posText(pos)}, it is ${block.name}`);
  if (fluid !== 'powder_snow' && Number(block.getProperties().level ?? 0) !== 0) return fail(`the ${fluid} at ${posText(pos)} is flowing, give its source block`);
  const far = await getInReach(ctx, pos, { goal: new GoalNear(pos.x, pos.y, pos.z, 2) });
  if (far) return fail(far);
  const filled = `${fluid}_bucket`;
  const before = count(bot, filled);
  await hold(bot, 'bucket');
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
  bot.activateItem();
  const got = await waitFor(() => count(bot, filled) > before);
  bot.deactivateItem();
  return got ? ok(`filled a bucket with ${fluid} at ${posText(pos)}, now carrying ${count(bot, filled)} ${filled}`) : fail(`the bucket came back empty, I may not see the ${fluid} at ${posText(pos)} from here`);
}

// Pours a full bucket into the spot at pos, aimed at a face of a solid block next to it.
async function pourBucket(ctx, item, spot) {
  const { bot, config } = ctx;
  const getName = (p) => bot.blockAt(p, false)?.name;
  const fluid = FULL_BUCKETS[item];
  // A source block of that fluid, which a pour would leave unchanged.
  const full = () => getName(spot) === fluid && (fluid === 'powder_snow' || Number(bot.blockAt(spot, false).getProperties().level ?? 0) === 0);
  const here = getName(spot);
  if (!here) return fail(`position not loaded: ${posText(spot)}`);
  if (full()) return fail(`there is already a ${fluid} source at ${posText(spot)}, pouring would change nothing`);
  if (!isReplaceable(here) && here !== 'powder_snow') return fail(`${here} is in the way at ${posText(spot)}, the spot has to be empty`);
  const problem = () => dangerProblem({ item, spot, getName, admin: isAdmin(config, ctx.requester), playerNear: playerNear(bot) });
  const before = problem();
  if (before) return fail(`won't pour ${fluid} at ${posText(spot)}: ${before}`);
  const sides = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
  const refs = sides.filter((d) => bot.blockAt(spot.plus(d), false)?.boundingBox === 'block');
  if (!refs.length) return fail(`nothing solid next to ${posText(spot)} to pour against`);
  // Lava is poured from higher up, so it can't run onto the bot.
  const far = await getInReach(ctx, spot.plus(refs[0]), { minY: fluid === 'lava' ? spot.y + 1 : undefined });
  if (far) return fail(far);
  // Someone may have come close during the walk.
  const late = problem();
  if (late) return fail(`won't pour ${fluid} at ${posText(spot)}: ${late}`);
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const center = spot.offset(0.5, 0.5, 0.5);
  const dir = refs.find((d) => eye.minus(center.plus(d.scaled(0.5))).dot(d.scaled(-1)) > 0.1);
  if (!dir) return fail(`can't see a side of ${posText(spot)} to pour against from ${posText(bot.entity.position)}`);
  await hold(bot, item);
  await bot.lookAt(center.plus(dir.scaled(0.5)), true);
  bot.activateItem();
  const poured = await waitFor(full);
  bot.deactivateItem();
  return poured ? ok(`poured ${fluid} at ${posText(spot)}`) : fail(`nothing changed at ${posText(spot)}, it is still ${getName(spot)}`);
}

// Lights a campfire or candle, or puts fire on top of the block at pos (a portal frame,
// netherrack), within the fire rules.
async function lightFire(ctx, item, pos) {
  const { bot, config } = ctx;
  const getName = (p) => bot.blockAt(p, false)?.name;
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  const lightable = LIGHTABLE.test(block.name);
  const spot = lightable ? pos : pos.offset(0, 1, 0);
  if (!lightable && !AIR.has(getName(spot))) return fail(`${getName(spot)} is on top of ${block.name} at ${posText(pos)}, fire needs an empty spot`);
  const problem = (b) => dangerProblem({ item, clicked: b.name, lit: b.getProperties().lit, spot, getName, admin: isAdmin(config, ctx.requester), playerNear: playerNear(bot) });
  const before = problem(block);
  if (before) return fail(`won't use ${item} at ${posText(pos)}: ${before}`);
  const far = await getInReach(ctx, pos);
  if (far) return fail(far);
  // Someone may have come close during the walk.
  const late = problem(bot.blockAt(pos, false) ?? block);
  if (late) return fail(`won't use ${item} at ${posText(pos)}: ${late}`);
  await hold(bot, item);
  await bot.activateBlock(bot.blockAt(pos, false), UP, TOP);
  if (lightable) {
    const lit = await waitFor(() => String(bot.blockAt(pos, false)?.getProperties().lit) === 'true');
    return lit ? ok(`lit the ${block.name} at ${posText(pos)}`) : fail(`the ${block.name} at ${posText(pos)} didn't light`);
  }
  const fire = await waitFor(() => ['fire', 'soul_fire', 'nether_portal'].includes(getName(spot)));
  if (!fire) return fail(`no fire came up at ${posText(spot)}, it is still ${getName(spot)}`);
  return ok(getName(spot) === 'nether_portal' ? `lit the nether portal at ${posText(spot)}` : `lit ${getName(spot)} at ${posText(spot)}`);
}

// Any other item on a block: clicks its top and says what changed.
async function useOther(ctx, item, pos) {
  const { bot, config } = ctx;
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  if (AIR.has(block.name)) return fail(`nothing at ${posText(pos)} to use ${item} on`);
  if (bot.registry.blocksByName?.[item]) return fail(`${item} is a block: use place_block to put it down`);
  if (USE_BLOCK.test(block.name)) return fail(`use use_block for ${block.name}`);
  if (block.name.endsWith('_bed') || block.name === 'respawn_anchor') return fail(`I don't use items on a ${block.name}, it can blow up`);
  if (isProtected(block.name, config.protectedBlocks) && !ctx.placed?.has(pos, block.name)) return fail(`${block.name} is protected, I don't use items on someone's ${block.name}`);
  const far = await getInReach(ctx, pos);
  if (far) return fail(far);
  await hold(bot, item);
  const state = stateText(block);
  const items = inventoryKey(bot);
  await bot.activateBlock(block, UP, TOP);
  const now = () => stateText(bot.blockAt(pos, false));
  const changed = await waitFor(() => now() !== state || inventoryKey(bot) !== items);
  if (!changed) return fail(`using ${item} on ${block.name} at ${posText(pos)} changed nothing`);
  return ok(`used ${item} on ${block.name} at ${posText(pos)}, it is now ${now()}`);
}

// Walks up to mob and uses item on it once: 'used' when something changed (an item went or came,
// the tool wore, something dropped), else 'unchanged', 'out of reach' or 'stopped'.
async function useOnMob(ctx, item, mob) {
  const { bot, signal } = ctx;
  if (mob.position.distanceTo(bot.entity.position) > MOB_REACH) {
    await walkTo(ctx, new GoalFollow(mob, 1.5), { place: false });
    if (signal?.aborted) return 'stopped';
    if (!bot.entities[mob.id] || mob.position.distanceTo(bot.entity.position) > MOB_REACH + 0.5) return 'out of reach';
  }
  await hold(bot, item);
  await bot.lookAt(mob.position.offset(0, (mob.height ?? 1) * 0.6, 0), true);
  const items = inventoryKey(bot);
  const wear = bot.heldItem?.durabilityUsed;
  const drops = dropsNear(bot, mob.position, 3).length;
  bot.useOn(mob);
  const changed = await waitFor(() => inventoryKey(bot) !== items || bot.heldItem?.durabilityUsed !== wear || dropsNear(bot, mob.position, 3).length > drops);
  return changed ? 'used' : 'unchanged';
}

// Uses item on that one mob, the way use_item does on mobs: never on players or traders, and
// never fire, lava or TNT.
export async function useOnEntity(ctx, item, mob) {
  const { bot } = ctx;
  if (!mob || !bot.entities[mob.id]) return fail('it is gone');
  if (mob.type === 'player' || NO_USE.has(mob.name)) return fail(`I don't use items on a ${mob.type === 'player' ? 'player' : mob.name}`);
  if (DANGER.has(item)) return fail(`I never use ${item} on mobs`);
  if (!count(bot, item)) return fail(`missing item: ${item}`);
  const got = await useOnMob(ctx, item, mob);
  if (got === 'used') return ok(`used ${item} on the ${mob.name} at ${posText(mob.position)}`);
  if (got === 'stopped') return fail('stopped');
  if (got === 'out of reach') return fail(`could not get to the ${mob.name}`);
  return fail(`using ${item} on the ${mob.name} changed nothing`);
}

// Uses the item on the count nearest matching mobs, skipping ones it does nothing to (a sheep
// that's already sheared, an animal that isn't hungry).
async function useOnMobs(ctx, item, target, wantCount) {
  const { bot, signal } = ctx;
  if (Object.keys(bot.players ?? {}).some((name) => name.toLowerCase() === target.toLowerCase())) return fail(`${target} is a player, and I never use items on players`);
  if (DANGER.has(item)) return fail(`I never use ${item} on mobs`);
  const wanted = Math.min(Math.max(wantCount ?? 1, 1), 10);
  const before = inventoryCounts(bot);
  const skip = new Set();
  let done = 0;
  let unchanged = 0;
  let stopReason = '';
  while (done < wanted) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    if (!count(bot, item)) {
      stopReason = `ran out of ${item}`;
      break;
    }
    const mob = pickMobs(Object.values(bot.entities), bot.entity, bot.entity.position, target).find((e) => !skip.has(e.id));
    if (!mob) {
      stopReason = `no ${done || unchanged ? 'more ' : ''}${target} within ${SEARCH_RANGE} blocks`;
      break;
    }
    skip.add(mob.id);
    const got = await useOnMob(ctx, item, mob);
    if (got === 'stopped') {
      stopReason = 'stopped';
      break;
    }
    if (got === 'out of reach') continue;
    if (got === 'used') {
      done++;
      ctx.status?.progress(`used ${item} on ${done} of ${wanted} ${target}`);
    } else unchanged++;
    await pause(200, 400);
  }
  if (done) await collectDrops(ctx, { radius: 8, max: 8 });

  const after = inventoryCounts(bot);
  const got = gainedText(before, after);
  const used = usedText(before, after);
  let message = `used ${item} on ${done} ${target}`;
  if (used) message += `, used up ${used}`;
  if (got) message += `, got ${got}`;
  if (unchanged) message += `. ${unchanged} didn't change (already done, not hungry, or it doesn't work on them)`;
  if (done < wanted && stopReason) message += `. Stopped early: ${stopReason}`;
  return done ? ok(message) : fail(message);
}

async function ride(ctx, target) {
  const { bot } = ctx;
  if (bot.vehicle) return fail(`already riding a ${bot.vehicle.name}. Use use_item with nothing to get off first`);
  if (Object.keys(bot.players ?? {}).some((name) => name.toLowerCase() === target.toLowerCase())) return fail(`${target} is a player`);
  const here = bot.entity.position;
  const mount = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(here) <= SEARCH_RANGE && isMount(e, target))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
  if (!mount) return fail(`no ${target} to get in or on within ${SEARCH_RANGE} blocks (boats, minecarts and saddled mounts only)`);
  if (mount.position.distanceTo(here) > MOB_REACH) {
    const walked = await walkTo(ctx, new GoalFollow(mount, 1.5), { place: false });
    if (mount.position.distanceTo(bot.entity.position) > MOB_REACH + 0.5) return fail(`could not get to the ${mount.name}: ${walked.message}`);
  }
  // An item in hand would be used on it (food feeds a horse instead of riding it).
  if (bot.heldItem) await bot.unequip('hand');
  await bot.lookAt(mount.position.offset(0, (mount.height ?? 1) * 0.5, 0), true);
  bot.mount(mount);
  const on = await waitFor(() => bot.vehicle?.id === mount.id, 1500);
  if (!on) return fail(`couldn't get on the ${mount.name} (a horse needs taming and a saddle, a pig or strider a saddle)`);
  return ok(`now riding the ${mount.name} at ${posText(bot.entity.position)}. I can't steer it; use_item with nothing given gets me off`);
}

async function getOff(ctx) {
  const { bot } = ctx;
  const vehicle = bot.vehicle;
  if (!vehicle) return fail('not riding anything. Give an item to use, with x y z for a block or target for a mob');
  bot.dismount();
  // Newer servers only let go on sneak, which mineflayer's dismount doesn't send.
  if (!(await waitFor(() => !bot.vehicle, 1000))) {
    bot.setControlState('sneak', true);
    await waitFor(() => !bot.vehicle, 1000);
    bot.setControlState('sneak', false);
  }
  if (bot.vehicle) return fail(`couldn't get off the ${vehicle.name}`);
  return ok(`got off the ${vehicle.name}, now at ${posText(bot.entity.position)}`);
}

async function drink(ctx, item) {
  const { bot } = ctx;
  const before = count(bot, item);
  await hold(bot, item);
  // These can be drunk with a full food bar, but Mineflayer's consume refuses them then, so
  // hold use until the bottle is used up (about 2 seconds).
  if (ANY_TIME_DRINKS.has(item)) {
    bot.activateItem();
    await waitFor(() => count(bot, item) < before, 3500);
    bot.deactivateItem();
  } else {
    try {
      await bot.consume();
    } catch (err) {
      return fail(`could not drink ${item}: ${err.message}`);
    }
  }
  return count(bot, item) < before ? ok(`drank ${item}, health ${Math.round(bot.health)}/20, food ${bot.food}/20`) : fail(`drinking ${item} didn't use it up`);
}

// Throws the item where the bot looks, or at aim. Splash potions only at aim, and never near
// players: around aim, or anywhere along the way there, since a throw that falls short lands
// in between.
async function throwItem(ctx, item, aim, times) {
  const { bot, signal } = ctx;
  const n = Math.min(Math.max(times ?? 1, 1), 16);
  if (/^(splash|lingering)_potion$/.test(item)) {
    if (!aim) return fail(`say where to throw the ${item} (x y z)`);
    if (playersOnThrow(bot, aim)) return fail(`a player is close to where the ${item} would land, so I won't throw it`);
  }
  let thrown = 0;
  for (let i = 0; i < n; i++) {
    if (signal?.aborted || !count(bot, item)) break;
    const have = count(bot, item);
    await hold(bot, item);
    if (aim) await bot.lookAt(aim.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    await delay(100);
    bot.deactivateItem();
    if (!(await waitFor(() => count(bot, item) < have))) break;
    thrown++;
    // Ender pearls have a cooldown of a second.
    await delay(item === 'ender_pearl' ? 1100 : 250);
  }
  if (!thrown) return fail(`throwing ${item} did nothing`);
  if (item === 'ender_pearl') await delay(1000);
  return ok(`threw ${thrown} ${item}${thrown < n ? ` of ${n}` : ''}, now at ${posText(bot.entity.position)}`);
}

// The use_item tool: an item on a block, on mobs or in the air, or getting on and off rides.
export async function useItem(ctx, { item, x, y, z, x2, y2, z2, target, count: times }) {
  const { bot } = ctx;
  const hasPos = x !== undefined && y !== undefined && z !== undefined;
  if (!item) {
    if (target) return ride(ctx, target);
    if (hasPos) return fail('say which item to use on that block');
    return getOff(ctx);
  }
  const held = findItem(bot.inventory.items(), item, bot.registry.itemsByName);
  if (!held) return fail(`missing item: ${item}`);
  const name = held.name;
  const kind = useKind(name);
  if (kind === 'banned') return fail(`I never use ${name}, it could wreck things`);
  if (target) return useOnMobs(ctx, name, target, times);
  if (kind === 'drink') return drink(ctx, name);
  if (kind === 'throw') return throwItem(ctx, name, hasPos ? new Vec3(x, y, z) : null, times);
  if (!hasPos) {
    if (bot.registry.foodsByName?.[name]) return fail(`to eat ${name} yourself use eat, or give target to feed it to animals`);
    return fail(`say where to use ${name} (x y z) or on which mobs (target)`);
  }
  const pos = new Vec3(x, y, z);
  const corner = x2 !== undefined || y2 !== undefined || z2 !== undefined ? new Vec3(x2 ?? x, y2 ?? y, z2 ?? z) : null;
  if (kind === 'till' || kind === 'plant' || kind === 'grow') return useOnBlocks(ctx, name, kind, pos, corner);
  if (corner) return fail('a box (x2 y2 z2) only works with a hoe, seeds or saplings, and bone_meal');
  if (kind === 'fill') return fillBucket(ctx, pos);
  if (kind === 'pour') return pourBucket(ctx, name, pos);
  if (kind === 'fire') return lightFire(ctx, name, pos);
  return useOther(ctx, name, pos);
}
