import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, delay } from './util.js';
import { walkTo } from './movement.js';

const { GoalNear } = pathfinderPkg.goals;

export function droppedItem(entity) {
  if (entity.name !== 'item') return null;
  try {
    return entity.getDroppedItem();
  } catch {
    return null;
  }
}

const WATERY = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

// Water, the plants that only grow in it, and waterlogged blocks.
export function isWater(block) {
  if (!block) return false;
  if (WATERY.has(block.name)) return true;
  try {
    return block.getProperties?.().waterlogged === true;
  } catch {
    return false;
  }
}

// A drop she would have to put her head under water for (sunk, or held under ice), or one in
// lava. One floating with air above it can still be picked up.
export function wetDrop(bot, entity) {
  const p = entity.position.floored();
  const at = bot.blockAt?.(p, false);
  if (!at) return false;
  if (at.name === 'lava') return true;
  if (!isWater(at)) return false;
  const above = bot.blockAt(p.offset(0, 1, 0), false);
  return !above || above.boundingBox !== 'empty' || isWater(above) || above.name === 'lava';
}

function matchesItem(name, query) {
  return name === query || name.endsWith(`_${query}`);
}

// Dropped items within radius of center, closest to the bot first.
export function dropsNear(bot, center, radius, item) {
  const here = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e.name === 'item' && e.position && e.position.distanceTo(center) <= radius)
    .filter((e) => !item || matchesItem(droppedItem(e)?.name ?? '', item))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
}

function counts(bot) {
  const map = new Map();
  for (const i of bot.inventory.items()) map.set(i.name, (map.get(i.name) ?? 0) + i.count);
  return map;
}

export function gainedText(before, after) {
  const gained = [...after].map(([n, c]) => [n, c - (before.get(n) ?? 0)]).filter(([, c]) => c > 0);
  return gained.length ? gained.map(([n, c]) => `${c} ${n}`).join(', ') : '';
}

// Items the bot dropped on purpose (handed to a player, or asked to drop) are left where they
// are for a while, so its own chores don't pick them straight back up.
export function leaveDrops(bot, minutes = 5) {
  bot.leftDrops = { pos: bot.entity.position.clone(), until: Date.now() + minutes * 60000 };
}

export function leftThere(bot, entity) {
  const left = bot.leftDrops;
  return Boolean(left && left.until > Date.now() && entity.position.distanceTo(left.pos) <= 5);
}

// Items it found no way to are remembered on the bot for a while, so jobs that pick up every
// few blocks don't spend a long path search on the same item each time.
const SKIP_DROP_MS = 60000;

export function skippedDrop(bot, id) {
  return (bot.skippedDrops?.get(id) ?? 0) > Date.now();
}

function skipDrop(bot, id) {
  bot.skippedDrops ??= new Map();
  const now = Date.now();
  for (const [key, until] of bot.skippedDrops) if (until <= now) bot.skippedDrops.delete(key);
  bot.skippedDrops.set(id, now + SKIP_DROP_MS);
}

// Whether there is farmland within three blocks of p, which a jump on the way could trample.
function farmlandNear(bot, p) {
  const c = p.floored();
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -2; dy <= 1; dy++) {
      for (let dz = -3; dz <= 3; dz++) if (bot.blockAt(c.offset(dx, dy, dz), false)?.name === 'farmland') return true;
    }
  }
  return false;
}

// Walks over dropped items so they get picked up, on foot only: the walk never digs or places,
// so a field's farmland or the base of a fence stays, and near farmland it never jumps on it
// (keepFarmland). Items it can't get to that way are
// skipped (see skippedDrop), and so are any under water or in lava, and any that
// ignore(entity) says to leave. Returns how many it walked to, how many it couldn't reach, and
// whether it stopped part-way.
export async function collectDrops(ctx, { radius = 6, center, item, max = 8, ignore } = {}) {
  const { bot } = ctx;
  const skip = new Set();
  const out = { walked: 0, unreachable: 0, stopped: false };
  for (let i = 0; i < max; i++) {
    if (ctx.signal?.aborted) {
      out.stopped = true;
      return out;
    }
    const target = dropsNear(bot, center ?? bot.entity.position, radius, item).find(
      (e) => !skip.has(e.id) && !skippedDrop(bot, e.id) && !ignore?.(e) && !wetDrop(bot, e)
    );
    if (!target) return out;
    const p = target.position;
    let walked = null;
    if (p.distanceTo(bot.entity.position) > 1) walked = await walkTo(ctx, new GoalNear(p.x, p.y, p.z, 1), { place: false, onFoot: true, keepFarmland: farmlandNear(bot, p) });
    await delay(250, 450);
    out.walked++;
    if (!bot.entities[target.id]) continue;
    skip.add(target.id);
    if (walked && !walked.ok && !ctx.signal?.aborted) {
      skipDrop(bot, target.id);
      out.unreachable++;
    }
  }
  if (ctx.signal?.aborted) out.stopped = true;
  return out;
}

export async function collectItems(ctx, { item, radius }) {
  const { bot } = ctx;
  const range = Math.min(radius ?? 16, 32);
  const what = item ? `dropped ${item}` : 'dropped items';
  if (dropsNear(bot, bot.entity.position, range, item).length === 0) return ok(`no ${what} within ${range} blocks`);

  const before = counts(bot);
  const run = await collectDrops(ctx, { radius: range, item, max: 24 });
  const got = gainedText(before, counts(bot));
  const after = dropsNear(bot, bot.entity.position, range, item);
  const wet = after.filter((e) => wetDrop(bot, e)).length;
  const blocked = after.filter((e) => !wetDrop(bot, e) && skippedDrop(bot, e.id)).length;
  const left = after.length - wet - blocked;
  const notes = [];
  if (left) notes.push(`${left} still on the ground (${run.stopped ? 'not got to before I stopped' : 'my inventory is full, or more than I go for in one go'})`);
  if (blocked) notes.push(`${blocked} I couldn't get to without digging or building my way there`);
  if (wet) notes.push(`${wet} left under water or in lava, where I could drown or burn getting ${wet === 1 ? 'it' : 'them'}`);
  const rest = notes.length ? `, ${notes.join(', ')}` : '';
  const stop = run.stopped ? '. Stopped part-way' : '';
  return got ? ok(`picked up ${got}${rest}${stop}`) : fail(`picked up nothing${rest}${stop}`);
}
