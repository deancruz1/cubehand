import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, pause } from './util.js';
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

// Walks over dropped items so they get picked up. Items it can't get to are skipped, and so
// are any that ignore(entity) says to leave.
export async function collectDrops(ctx, { radius = 6, center, item, max = 8, ignore } = {}) {
  const { bot } = ctx;
  const skip = new Set();
  for (let i = 0; i < max; i++) {
    if (ctx.signal?.aborted) return;
    const target = dropsNear(bot, center ?? bot.entity.position, radius, item).find((e) => !skip.has(e.id) && !ignore?.(e));
    if (!target) return;
    const p = target.position;
    if (p.distanceTo(bot.entity.position) > 1) await walkTo(ctx, new GoalNear(p.x, p.y, p.z, 1), { place: false });
    await pause(250, 450);
    if (bot.entities[target.id]) skip.add(target.id);
  }
}

export async function collectItems(ctx, { item, radius }) {
  const { bot } = ctx;
  const range = Math.min(radius ?? 16, 32);
  const what = item ? `dropped ${item}` : 'dropped items';
  if (dropsNear(bot, bot.entity.position, range, item).length === 0) return fail(`no ${what} within ${range} blocks`);

  const before = counts(bot);
  await collectDrops(ctx, { radius: range, item, max: 24 });
  const got = gainedText(before, counts(bot));
  const left = dropsNear(bot, bot.entity.position, range, item).length;
  const rest = left ? `, ${left} still on the ground (out of reach, or my inventory is full)` : '';
  return got ? ok(`picked up ${got}${rest}`) : fail(`picked up nothing${rest}`);
}
