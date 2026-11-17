import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, customName } from './util.js';
import { walkTo } from './movement.js';
import { useOnEntity } from './use.js';
import { attackEntity, isBaby, FARM_ANIMALS } from './combat.js';
import { collectDrops } from './items.js';
import { findNearest } from './blocks.js';
import { smelt, rawFoodToCook } from './furnace.js';

const { GoalNear } = pathfinderPkg.goals;

// With one position, the pen is the animals this far around it (and 3 blocks up or down).
const PEN_RANGE = 8;
const MAX_SIDE = 48;
const BREED_COOLDOWN_MS = 5 * 60000;
const GROW_MS = 20 * 60000;
// How far off a remembered pen can be for the chore to walk over to it.
const PEN_REACH = 64;

// What each kind eats to breed, in the order she uses them.
const FOOD = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['dandelion', 'carrot', 'golden_carrot']
};
const MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit'];
const COOKED_MEAT = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit'];
const MILKED = new Set(['cow', 'mooshroom', 'goat']);

export const RUNNERS = { use: useOnEntity, kill: attackEntity, smelt, collect: collectDrops, walk: walkTo };

const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
const keyOf = (e) => e.uuid ?? e.id;

// When she last fed each animal, per bot. Love mode and the breeding cooldown aren't in the
// entity metadata, so her own feeding is all she knows of them.
const FED = new WeakMap();
function fedLog(bot) {
  if (!FED.has(bot)) FED.set(bot, new Map());
  return FED.get(bot);
}

const onCooldown = (bot, e, now = Date.now()) => now - (fedLog(bot).get(keyOf(e)) ?? -Infinity) < BREED_COOLDOWN_MS;

function metaValue(bot, entity, key) {
  const index = bot.registry?.entitiesByName?.[entity.name]?.metadataKeys?.indexOf(key) ?? -1;
  return index >= 0 ? entity.metadata?.[index] : undefined;
}

const sheared = (bot, sheep) => (Number(metaValue(bot, sheep, 'wool') ?? 0) & 0x10) !== 0;

// A farm animal kind from what a player might say: cow, cows, Chickens.
export function animalKind(name) {
  if (!name) return null;
  const wanted = String(name).toLowerCase().trim().replace(/ /g, '_');
  return [wanted, wanted.replace(/s$/, ''), wanted.replace(/es$/, '')].find((n) => FARM_ANIMALS.includes(n)) ?? null;
}

// The pen as a box, from two corners or as the space around one position.
export function penArea({ x, y, z, x2, y2, z2 }) {
  if (x2 === undefined && y2 === undefined && z2 === undefined) {
    return { min: new Vec3(x - PEN_RANGE, y - 3, z - PEN_RANGE), max: new Vec3(x + PEN_RANGE, y + 3, z + PEN_RANGE), single: true };
  }
  const b = new Vec3(x2 ?? x, y2 ?? y, z2 ?? z);
  return { min: new Vec3(Math.min(x, b.x), Math.min(y, b.y), Math.min(z, b.z)), max: new Vec3(Math.max(x, b.x), Math.max(y, b.y), Math.max(z, b.z)), single: false };
}

const centerOf = ({ min, max }) => new Vec3((min.x + max.x + 1) / 2, min.y, (min.z + max.z + 1) / 2);
const inPen = ({ min, max }, p) => p.x >= min.x && p.x < max.x + 1 && p.z >= min.z && p.z < max.z + 1 && p.y >= min.y - 0.5 && p.y < max.y + 1;
const penText = (pen) => (pen.single ? `around ${posText(centerOf(pen))}` : `${posText(pen.min)} to ${posText(pen.max)}`);

// The farm animals in the pen, of the one kind or of every kind.
export function penAnimals(bot, pen, kind = null) {
  return Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.type !== 'player' && (kind ? e.name === kind : FARM_ANIMALS.includes(e.name)) && inPen(pen, e.position));
}

// Walks up to that one animal and uses item on it. Returns { used } with the animal, or { why }.
async function useOn(ctx, run, mob, item) {
  if (!ctx.bot.entities[mob.id]) return { why: 'gone' };
  const result = await run.use(ctx, item, mob);
  return result.ok ? { used: mob } : { why: result.message };
}

// Feeds adults two at a time with the first food they eat that she carries. Returns the animals
// fed and a note on food that was missing or ran out.
async function breedKind(ctx, run, kind, adults, keep, stats) {
  const { bot, signal } = ctx;
  const foods = FOOD[kind];
  const carried = () => foods.find((f) => count(bot, f) > 0);
  const fed = [];
  if (adults.length < 2) return { fed, note: null };
  const free = adults.filter((e) => !onCooldown(bot, e));
  // Named ones breed first, so the ones fed are the ones that stay.
  free.sort((a, b) => Number(Boolean(customName(b))) - Number(Boolean(customName(a))));
  const want = Math.min(free.length, keep) - (Math.min(free.length, keep) % 2);
  if (want === 0) return { fed, note: null };
  if (!carried()) return { fed, note: `no ${foods.join(' or ')} to breed the ${kind}` };
  const left = new Set(free.map((e) => e.id));
  for (const mob of free) {
    if (fed.length >= want || signal?.aborted) break;
    if (!left.has(mob.id) || isBaby(bot, mob)) continue;
    const food = carried();
    if (!food) break;
    const got = await useOn(ctx, run, mob, food);
    if (!got.used) continue;
    left.delete(got.used.id);
    fedLog(bot).set(keyOf(got.used), Date.now());
    fed.push(got.used);
    stats.pairs = Math.floor(fed.length / 2);
    ctx.status?.progress(`fed ${fed.length} ${kind} with ${food}`);
  }
  const ran = fed.length < want && !carried() ? `ran out of ${foods.join(' and ')} for the ${kind}` : null;
  return { fed, note: ran };
}

// Shears or milks each adult that still can be, nearest first.
async function harvestKind(ctx, run, adults, item, canHarvest) {
  const { bot, signal } = ctx;
  let done = 0;
  for (const mob of adults) {
    if (signal?.aborted || !count(bot, item)) break;
    if (isBaby(bot, mob) || !canHarvest(mob)) continue;
    const got = await useOn(ctx, run, mob, item);
    if (got.used) done++;
  }
  return done;
}

// Kills adults past keep: never babies, named animals or ones just fed.
async function cullKind(ctx, run, kind, adults, keep, fedNow, stats) {
  const { bot, signal } = ctx;
  const surplus = adults.length - keep;
  if (surplus <= 0) return null;
  const here = bot.entity.position;
  const spare = adults
    .filter((e) => !customName(e) && !fedNow.has(e.id) && !onCooldown(bot, e))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
  for (const mob of spare) {
    if (stats.culled >= surplus) break;
    if (signal?.aborted) return 'stopped';
    if (!bot.entities[mob.id] || isBaby(bot, mob)) continue;
    const result = await run.kill(ctx, mob);
    if (result === 'killed') {
      stats.culled++;
      ctx.status?.progress(`culled ${stats.culled} ${kind}`);
    } else if (result === 'low health' || result === 'stopped') {
      return result === 'low health' ? `my health got low (${Math.round(bot.health)}/20), so I stopped culling` : 'stopped';
    }
  }
  return stats.culled < surplus ? `${surplus - stats.culled} more ${kind} over the ${keep} to keep are named, just fed or got away` : null;
}

// Puts each raw meat she carries in a furnace or smoker close by to cook while she does other
// things, like her own food cooking. Returns what happened.
async function cookMeat(ctx, run) {
  const { bot } = ctx;
  const notes = [];
  for (const meat of MEAT) {
    if (!count(bot, meat) || ctx.signal?.aborted) continue;
    if (!rawFoodToCook(bot)) {
      notes.push('no fuel to cook the meat');
      break;
    }
    if (!findNearest(bot, (n) => n === 'furnace' || n === 'smoker', 32).length) {
      notes.push('no furnace or smoker within 32 blocks to cook the meat');
      break;
    }
    const result = await run.smelt(ctx, { item: meat, wait: false, make: false });
    notes.push(result.ok ? result.message : `couldn't cook the ${meat}: ${result.message}`);
  }
  return notes;
}

function meatText(bot) {
  const carried = [...MEAT, ...COOKED_MEAT].map((n) => [n, count(bot, n)]).filter(([, c]) => c > 0);
  return carried.length ? `carrying ${carried.map(([n, c]) => `${c} ${n}`).join(', ')}` : 'carrying no meat';
}

// The tend_animals tool: breeds, shears, milks when asked and culls the farm animals in a pen,
// then cooks the meat. kinds in the result has the counts for each kind.
export async function tendAnimals(ctx, { x, y, z, x2, y2, z2, animal, keep = 4, breed = true, cull = true, cook = true, milk = false, tend = true }, runners = {}) {
  const { bot, signal } = ctx;
  const run = { ...RUNNERS, ...runners };
  if (x === undefined || y === undefined || z === undefined) return fail('give the pen as x y z (one spot in it, or a corner with x2 y2 z2 for the other)');
  const kind = animal ? animalKind(animal) : null;
  if (animal && !kind) return fail(`${animal} isn't a farm animal I tend. I tend ${FARM_ANIMALS.join(', ')}`);
  const pen = penArea({ x, y, z, x2, y2, z2 });
  const side = Math.max(pen.max.x - pen.min.x, pen.max.z - pen.min.z) + 1;
  if (side > MAX_SIDE) return fail(`the pen is ${side} blocks across, the limit is ${MAX_SIDE}`);
  const keepAdults = Math.max(keep ?? 4, 2);
  const center = centerOf(pen);
  if (bot.entity.position.distanceTo(center) > PEN_RANGE * 2) {
    const walked = await run.walk(ctx, new GoalNear(center.x, center.y, center.z, 3), { place: false });
    if (signal?.aborted) return ok(`stopped on the way to the pen ${penText(pen)}`);
    if (bot.entity.position.distanceTo(center) > PEN_RANGE * 4) return fail(`could not get to the pen ${penText(pen)}: ${walked.message}`);
  }

  const input = { x, y, z, x2, y2, z2, animal, keep };
  const found = penAnimals(bot, pen, kind);
  if (!found.length) return ok(`no ${kind ?? 'farm animals'} in the pen ${penText(pen)}, nothing to do${penNote(ctx, input, pen, tend, null)}`);
  const kinds = {};
  const notes = [];
  let stop = null;
  for (const name of FARM_ANIMALS) {
    const herd = found.filter((e) => e.name === name);
    if (!herd.length) continue;
    const here = bot.entity.position;
    herd.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
    const adults = herd.filter((e) => !isBaby(bot, e));
    const stats = { adults: adults.length, babies: herd.length - adults.length, pairs: 0, culled: 0, kept: adults.length };
    kinds[name] = stats;
    if (stop) continue;
    let fedNow = new Set();
    if (breed) {
      const bred = await breedKind(ctx, run, name, adults, keepAdults, stats);
      fedNow = new Set(bred.fed.map((e) => e.id));
      if (bred.fed.length % 2) notes.push(`fed 1 ${name} with no partner`);
      if (bred.note) notes.push(bred.note);
    }
    if (signal?.aborted) stop = 'stopped';
    if (!stop && name === 'sheep' && count(bot, 'shears')) {
      stats.sheared = await harvestKind(ctx, run, adults, 'shears', (e) => !sheared(bot, e));
    }
    if (!stop && milk && MILKED.has(name) && count(bot, 'bucket')) {
      stats.milked = await harvestKind(ctx, run, adults, 'bucket', () => true);
    }
    if (signal?.aborted) stop = 'stopped';
    if (!stop && cull) {
      const live = adults.filter((e) => bot.entities[e.id]);
      const why = await cullKind(ctx, run, name, live, keepAdults, fedNow, stats);
      if (why === 'stopped' || why?.startsWith('my health')) stop = why;
      else if (why) notes.push(why);
    }
    stats.kept = stats.adults - stats.culled;
  }

  if (!stop && Object.values(kinds).some((s) => s.culled || s.sheared || s.milked)) {
    await run.collect(ctx, { center, radius: Math.min(side, 16), max: 16 });
  }
  if (!stop && cook) notes.push(...(await cookMeat(ctx, run)));

  const lines = Object.entries(kinds).map(([name, s]) => {
    const extra = [s.sheared ? `${s.sheared} sheared` : '', s.milked ? `${s.milked} milked` : ''].filter(Boolean);
    return `${name}: ${s.adults} adults, ${s.babies} babies, ${s.pairs} pairs fed, ${s.culled} culled, ${s.kept} kept${extra.length ? `, ${extra.join(', ')}` : ''}`;
  });
  let message = `tended the pen ${penText(pen)} (keeping ${keepAdults} adults of each kind). ${lines.join('; ')}`;
  if (notes.length) message += `. ${notes.join('. ')}`;
  if (stop) message += `. Stopped early: ${stop}`;
  message += `. Now ${meatText(bot)}`;
  message += penNote(ctx, input, pen, tend, kinds);
  return { ...ok(message), kinds };
}

// A pen a player had her tend is kept for the pen chore (ctx.tended), replacing one with the
// same corners, and tend false lets the pens there go. Her own chores never add one.
function penNote(ctx, input, pen, tend, kinds) {
  const store = ctx.tended;
  if (!store) return '';
  const dimension = ctx.bot.game?.dimension ?? null;
  if (!tend) {
    const n = store.remove('pens', { x: pen.min.x, y: pen.min.y, z: pen.min.z, x2: pen.max.x, y2: pen.max.y, z2: pen.max.z, dimension });
    return n ? `. Stopped tending ${n} pen${n === 1 ? '' : 's'} there` : '. No pen there was being tended';
  }
  if (!ctx.requester) return '';
  const now = Date.now();
  const record = { ...penRecord(input, ctx.bot, now), nextAt: kinds ? nextVisit(kinds, now) : now + GROW_MS };
  return store.add('pens', record) === 'added' ? '. I will tend this pen from now on' : '';
}

// A pen to remember from what tend_animals was given, as plain data.
export function penRecord(input, bot, now = Date.now()) {
  const { x, y, z, x2, y2, z2, animal, keep } = input;
  const pen = { x, y, z, dimension: bot.game?.dimension ?? null, lastTended: now, nextAt: now + BREED_COOLDOWN_MS };
  if (x2 !== undefined || y2 !== undefined || z2 !== undefined) Object.assign(pen, { x2: x2 ?? x, y2: y2 ?? y, z2: z2 ?? z });
  if (animal) pen.animal = animal;
  if (keep !== undefined) pen.keep = keep;
  return pen;
}

// The remembered pens due a visit, nearest first: in this dimension, close enough, and past
// nextAt (or never tended).
export function pensDue(bot, pens, now = Date.now()) {
  if (!bot?.entity || !pens?.length) return [];
  const here = bot.entity.position;
  const dim = bot.game?.dimension;
  const far = (p) => here.distanceTo(centerOf(penArea(p)));
  return pens
    .filter((p) => (!p.dimension || !dim || p.dimension === dim) && (p.nextAt ?? 0) <= now && far(p) <= PEN_REACH)
    .sort((a, b) => far(a) - far(b));
}

// When a pen is due again after a visit: once the cooldown is over if any pair was fed, when
// the babies have grown if there are any, else after the same wait.
export function nextVisit(kinds, now = Date.now()) {
  const all = Object.values(kinds ?? {});
  if (all.some((s) => s.pairs > 0)) return now + BREED_COOLDOWN_MS;
  return now + GROW_MS;
}

// The idle chore: tends each pen that is due, one after another, and sets when it is due again.
// The pens are changed in place, for the caller to save.
export async function tendPens(ctx, pens, runners = {}) {
  const due = pensDue(ctx.bot, pens);
  const messages = [];
  for (const pen of due) {
    if (ctx.signal?.aborted) break;
    const result = await tendAnimals(ctx, { ...pen, cook: pen.cook ?? true }, runners);
    const now = Date.now();
    pen.lastTended = now;
    pen.nextAt = result.ok ? nextVisit(result.kinds, now) : now + GROW_MS;
    messages.push(result.message);
  }
  if (!due.length) return ok('no pen is due');
  return ok(messages.join('\n'));
}
