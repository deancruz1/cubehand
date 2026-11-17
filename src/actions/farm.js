import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo } from './movement.js';
import { digBlock, inReach } from './blocks.js';
import { collectDrops } from './items.js';
import { nearestFirst } from './build.js';
import { plantFor, hold, ageOf, waitFor, MAX_AREA } from './use.js';
import { fieldRecord } from '../tended.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const AIR = new Set(['air', 'cave_air', 'void_air']);
const UP = new Vec3(0, 1, 0);
const TOP = new Vec3(0.5, 1, 0.5);
// Fully grown at these ages, for when the registry has no age states.
const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3, cocoa: 2, sweet_berry_bush: 3 };
// Crops that come out whole, and what plants them again.
const SEEDS = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', nether_wart: 'nether_wart' };
// Melons and pumpkins are only taken when a stem grows them, so one put down as decoration stays.
const FRUIT = { melon: 'attached_melon_stem', pumpkin: 'attached_pumpkin_stem' };
const STEMS = { melon_stem: 'melon', pumpkin_stem: 'pumpkin' };
// Plants cut from the second block up, so the base grows again.
const TALL = { sugar_cane: 'sugar_cane', bamboo: 'bamboo', cactus: 'cactus', kelp: 'kelp', kelp_plant: 'kelp' };
const CROPS = [...Object.keys(SEEDS), 'melon', 'pumpkin', 'sugar_cane', 'bamboo', 'cactus', 'kelp', 'sweet_berries', 'cocoa'];
const ALIASES = {
  carrot: 'carrots', potato: 'potatoes', beetroot: 'beetroots', beetroot_seeds: 'beetroots', wheat_seeds: 'wheat',
  sweet_berry_bush: 'sweet_berries', berries: 'sweet_berries', cocoa_beans: 'cocoa', melon_slice: 'melon',
  bamboo_sapling: 'bamboo', kelp_plant: 'kelp'
};
const SIDES = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0) };
const JUNGLE_LOG = /^(stripped_)?jungle_(log|wood)$/;
const MAX_COLUMN = 24;
const COLLECT_EVERY = 8;
const FIELD_RANGE = 48;

const carried = (bot, name) => bot.inventory.items().reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);

// The crop a name means (wheat, carrot, sweet berries), or null.
export function cropName(query) {
  const q = query?.toLowerCase().trim().replace(/\s+/g, '_');
  if (!q) return null;
  return CROPS.includes(q) ? q : ALIASES[q] ?? null;
}

// The crop a block belongs to, or null.
export function cropOf(name) {
  if (SEEDS[name] || FRUIT[name]) return name;
  if (STEMS[name]) return STEMS[name];
  if (TALL[name]) return TALL[name];
  if (name === 'bamboo_sapling') return 'bamboo';
  if (name === 'sweet_berry_bush') return 'sweet_berries';
  if (name === 'cocoa') return 'cocoa';
  return null;
}

function fullyGrown(bot, block) {
  if (!block) return false;
  const { age, maxAge } = ageOf(bot, block);
  const max = maxAge ?? MAX_AGE[block.name];
  return age !== undefined && max !== undefined && age >= max;
}

function boxOf({ x, y, z, x2, y2, z2 }) {
  const a = new Vec3(x, y, z);
  const b = new Vec3(x2 ?? x, y2 ?? y, z2 ?? z);
  return {
    min: new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
    max: new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z))
  };
}

function cellsOf(min, max) {
  const cells = [];
  for (let y = max.y; y >= min.y; y--) {
    for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) cells.push(new Vec3(x, y, z));
  }
  return cells;
}

const volumeOf = (min, max) => (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);

// What is ripe in the box and how to take it, and how many of each crop are left to grow. A box
// given at the farmland or soul sand also covers the crops on it.
export function planHarvest(bot, min, max, crop = null) {
  const getBlock = (p) => bot.blockAt(p, false);
  const nameAt = (p) => getBlock(p)?.name;
  const jobs = [];
  const unripe = new Map();
  const seen = new Set();
  const once = (k) => !seen.has(k) && Boolean(seen.add(k));
  const young = (c) => unripe.set(c, (unripe.get(c) ?? 0) + 1);
  const cells = [];
  for (const p of cellsOf(min, max)) {
    cells.push(p);
    const n = nameAt(p);
    if (n === 'farmland' || n === 'soul_sand') cells.push(p.offset(0, 1, 0));
  }
  for (const p of cells) {
    if (!once(p.toString())) continue;
    const block = getBlock(p);
    const kind = block && cropOf(block.name);
    if (!kind || (crop && kind !== crop)) continue;
    const name = block.name;
    if (SEEDS[name]) {
      if (fullyGrown(bot, block)) jobs.push({ crop: kind, how: 'break', pos: p, block: name, seed: SEEDS[name] });
      else young(kind);
    } else if (FRUIT[name]) {
      if (grownByStem(getBlock, p, FRUIT[name])) jobs.push({ crop: kind, how: 'break', pos: p, block: name });
    } else if (STEMS[name]) {
      young(kind);
    } else if (TALL[name] || name === 'bamboo_sapling') {
      let base = p;
      for (let i = 0; i < MAX_COLUMN && TALL[nameAt(base.offset(0, -1, 0))] === kind; i++) base = base.offset(0, -1, 0);
      if (!once(`base ${base}`)) continue;
      const second = base.offset(0, 1, 0);
      if (TALL[nameAt(base)] === kind && TALL[nameAt(second)] === kind) jobs.push({ crop: kind, how: 'break', pos: second, block: nameAt(second) });
      else young(kind);
    } else if (name === 'sweet_berry_bush') {
      if (fullyGrown(bot, block)) jobs.push({ crop: kind, how: 'pick', pos: p, block: name });
      else young(kind);
    } else if (name === 'cocoa') {
      if (fullyGrown(bot, block)) jobs.push({ crop: kind, how: 'break', pos: p, block: name, log: logOf(getBlock, p, block) });
      else young(kind);
    }
  }
  return { jobs, unripe };
}

function grownByStem(getBlock, p, stem) {
  return Object.values(SIDES).some((d) => {
    const s = getBlock(p.plus(d));
    const facing = s?.name === stem ? SIDES[s.getProperties?.().facing] : null;
    return Boolean(facing && p.plus(d).plus(facing).equals(p));
  });
}

// The jungle log a cocoa pod hangs on: the one its facing points at, else any next to it.
function logOf(getBlock, p, block) {
  const facing = SIDES[block.getProperties?.().facing];
  const sides = facing ? [facing, ...Object.values(SIDES).filter((d) => !d.equals(facing))] : Object.values(SIDES);
  const d = sides.find((s) => JUNGLE_LOG.test(getBlock(p.plus(s))?.name ?? ''));
  return d ? p.plus(d) : null;
}

// Walks within reach of pos without digging or placing anything on the way through the field,
// and without jumping on its farmland.
async function getInReach(ctx, pos) {
  const { bot } = ctx;
  if (inReach(bot, pos)) return null;
  const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { onFoot: true, keepFarmland: true });
  return inReach(bot, pos) ? null : `could not get close enough to ${posText(pos)}: ${walked.message}`;
}

async function pick(ctx, job) {
  const { bot } = ctx;
  // Bone meal in hand would grow the bush instead.
  if (bot.heldItem?.name === 'bone_meal') await bot.unequip('hand');
  await bot.activateBlock(bot.blockAt(job.pos, false), UP, TOP);
  const picked = await waitFor(() => !fullyGrown(bot, bot.blockAt(job.pos, false)));
  return picked ? ok('') : fail(`picking the sweet berry bush at ${posText(job.pos)} changed nothing`);
}

// Plants the spot again, or says why not.
async function replantSpot(ctx, job) {
  const { bot } = ctx;
  const nameAt = (p) => bot.blockAt(p, false)?.name;
  const item = job.seed ?? 'cocoa_beans';
  if (!carried(bot, item)) return `no ${item} left`;
  if (!AIR.has(nameAt(job.pos))) return 'something else is in the spot';
  if (!job.seed && !job.log) return 'no jungle log next to it';
  const against = job.log ?? job.pos.offset(0, -1, 0);
  const far = await getInReach(ctx, against);
  if (far) return 'could not get close enough';
  const plant = job.seed ? plantFor(item) : null;
  if (plant && !plant.fits(nameAt(against))) return `the ground is ${nameAt(against)} now, not ${plant.ground}`;
  if (!plant && !JUNGLE_LOG.test(nameAt(against) ?? '')) return 'the jungle log is gone';
  await hold(bot, item);
  const face = plant ? UP : job.pos.minus(against);
  await bot.activateBlock(bot.blockAt(against, false), face, plant ? TOP : new Vec3(0.5, 0.5, 0.5).plus(face.scaled(0.5)));
  return (await waitFor(() => nameAt(job.pos) === (plant ? plant.block : 'cocoa'))) ? null : 'planting changed nothing';
}

function countsText(tally) {
  return [...tally].map(([crop, t]) => {
    const parts = [`harvested ${t.harvested}`];
    if (SEEDS[crop] || crop === 'cocoa') parts.push(`replanted ${t.replanted}`);
    parts.push(`left unripe ${t.unripe}`);
    return `${crop}: ${parts.join(', ')}`;
  }).join('; ');
}

// Harvests what is ripe in the box and plants it again from what she carries: crops and nether
// wart at full age, melons and pumpkins a stem grows (never the stem), sugar cane, bamboo,
// cactus and kelp from the second block up, ripe sweet berries picked off the bush, and ripe
// cocoa, planted again on the same log. Unripe plants are left and counted.
export async function harvest(ctx, { x, y, z, x2, y2, z2, crop, replant = true, tend = true }) {
  const { bot, signal } = ctx;
  const single = x2 === undefined && y2 === undefined && z2 === undefined;
  if (x === undefined || y === undefined || z === undefined) return fail('say where the field is: x y z, and x2 y2 z2 for the far corner');
  const kind = crop ? cropName(crop) : null;
  if (crop && !kind) return fail(`${crop} is not a crop I harvest. I harvest ${CROPS.join(', ')}`);
  const { min, max } = boxOf({ x, y, z, x2, y2, z2 });
  const volume = volumeOf(min, max);
  if (volume > MAX_AREA) return fail(`box is ${volume} blocks, the limit is ${MAX_AREA}. Harvest it in parts.`);
  if (cellsOf(min, max).some((p) => !bot.blockAt(p, false))) return fail(`part of the box is not loaded around ${posText(min)}, walk closer first`);
  const where = `the box from ${posText(min)} to ${posText(max)}`;

  const { jobs, unripe } = planHarvest(bot, min, max, kind);
  const tally = new Map();
  const of = (c) => {
    if (!tally.has(c)) tally.set(c, { harvested: 0, replanted: 0, unripe: unripe.get(c) ?? 0 });
    return tally.get(c);
  };
  for (const c of unripe.keys()) of(c);
  if (!jobs.length) {
    const none = `nothing ripe in ${where}${unripe.size ? `. ${countsText(tally)}` : `, no ${kind ?? 'crops'} there at all`}`;
    return ok(none + tendNote(ctx, min, max, kind, tend, single));
  }

  const getName = (p) => bot.blockAt(p, false)?.name;
  const notPlanted = new Map();
  const notPlant = (why) => notPlanted.set(why, (notPlanted.get(why) ?? 0) + 1);
  const later = [];
  const failures = [];
  let done = 0;
  let sinceCollect = 0;
  let stopReason = '';
  for (const job of nearestFirst(jobs, () => bot.entity.position.offset(0, 1.6, 0))) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    if (getName(job.pos) !== job.block) continue;
    const far = await getInReach(ctx, job.pos);
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    if (far) {
      failures.push(far);
      continue;
    }
    const got = job.how === 'pick' ? await pick(ctx, job) : await digBlock(ctx, job.pos);
    if (!got.ok) {
      failures.push(got.message);
      continue;
    }
    of(job.crop).harvested++;
    done++;
    ctx.status?.progress(`harvested ${done} of ${jobs.length}`);
    if (replant && (job.seed || job.crop === 'cocoa')) {
      const item = job.seed ?? 'cocoa_beans';
      if (signal?.aborted) {
        notPlant('stopped');
        stopReason = 'stopped';
        break;
      }
      // Without seeds the ones it just dropped will do.
      if (!carried(bot, item)) await collectDrops(ctx, { radius: 3, center: job.pos.offset(0.5, 0.5, 0.5), max: 4 });
      if (!carried(bot, item)) later.push(job);
      else {
        const why = await replantSpot(ctx, job);
        if (why) notPlant(why);
        else of(job.crop).replanted++;
      }
    }
    if (++sinceCollect >= COLLECT_EVERY) {
      sinceCollect = 0;
      await collectDrops(ctx, { radius: 6, max: 8 });
    }
    await pause(80, 200);
  }
  const center = min.plus(max).scaled(0.5).offset(0.5, 0.5, 0.5);
  await collectDrops(ctx, { radius: Math.min(16, Math.max(6, center.distanceTo(max) + 3)), center, max: 16 });
  // Spots that had nothing to plant, now that the drops are picked up.
  for (const job of later) {
    const why = signal?.aborted ? 'stopped' : await replantSpot(ctx, job);
    if (why) notPlant(why);
    else of(job.crop).replanted++;
  }

  let message = `harvested ${done} in ${where}. ${countsText(tally)}`;
  const unplanted = [...notPlanted.values()].reduce((a, b) => a + b, 0);
  if (unplanted) message += `. Could not replant ${unplanted} spots: ${[...notPlanted].map(([why, n]) => `${n} ${why}`).join(', ')}`;
  if (failures.length) message += `. ${failures.length} failed, first: ${failures.slice(0, 3).join('; ')}`;
  if (stopReason) message += `. Stopped early: ${stopReason}`;
  if (!done) return fail(message);
  return ok(message + tendNote(ctx, min, max, kind, tend, single));
}

// A box a player had her work is kept for the tending chore (ctx.tended), and tend false lets
// the fields there go. Her own chores never add one.
function tendNote(ctx, min, max, crop, tend, single) {
  const store = ctx.tended;
  if (!store) return '';
  const dimension = ctx.bot.game?.dimension ?? null;
  if (!tend) {
    const n = store.remove('fields', fieldRecord(min, max, dimension));
    return n ? `. Stopped tending ${n} field${n === 1 ? '' : 's'} there` : '. No field there was being tended';
  }
  if (single || !ctx.requester) return '';
  return store.add('fields', fieldRecord(min, max, dimension, crop)) === 'added' ? '. I will tend this field from now on' : '';
}

// A field is a box she was asked to harvest or plant: { x, y, z, x2, y2, z2, crop?, dimension? }.
function fieldsNear(bot, fields) {
  const here = bot.entity.position;
  return fields
    .map((f) => ({ field: f, ...boxOf(f) }))
    .filter(({ field, min, max }) => (field.dimension == null || field.dimension === bot.game?.dimension) && volumeOf(min, max) <= MAX_AREA)
    .map((f) => ({ ...f, distance: f.min.plus(f.max).scaled(0.5).distanceTo(here) }))
    .filter((f) => f.distance <= FIELD_RANGE && cellsOf(f.min, f.max).every((p) => bot.blockAt(p, false)))
    .sort((a, b) => a.distance - b.distance);
}

function ripeIn(bot, { field, min, max }) {
  const crop = field.crop ? cropName(field.crop) : null;
  return planHarvest(bot, min, max, crop).jobs.length > 0;
}

// The nearest remembered field within FIELD_RANGE with something ripe in it, or null.
export function ripeNear(bot, fields = []) {
  return fieldsNear(bot, fields).find((f) => ripeIn(bot, f))?.field ?? null;
}

// Harvests and replants every nearby field with something ripe, nearest first.
export async function tendFields(ctx, fields = []) {
  const ripe = fieldsNear(ctx.bot, fields).filter((f) => ripeIn(ctx.bot, f));
  if (!ripe.length) return ok('nothing ripe in the fields nearby');
  const results = [];
  for (const { field } of ripe) {
    if (ctx.signal?.aborted) break;
    const { x, y, z, x2, y2, z2, crop } = field;
    results.push(await harvest(ctx, { x, y, z, x2, y2, z2, crop, replant: true, tend: true }));
  }
  const message = results.map((r) => r.message).join('\n');
  return results.some((r) => r.ok) ? ok(message) : fail(message || 'stopped');
}
