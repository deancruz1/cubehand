import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay, guarded, TimeoutError } from './util.js';
import { walkTo } from './movement.js';
import { findNearest, inReach, placeOne } from './blocks.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const MAX_DEPTH = 3;
const TABLE_RANGE = 32;
const BATCH = 8;
const BATCH_MS = 20000;

function have(bot, id) {
  return bot.inventory.items().filter((i) => i.type === id).reduce((sum, i) => sum + i.count, 0);
}

function inventoryText(bot) {
  const slots = bot.inventory.slots.map((s, i) => (s ? `${i}:${s.count} ${s.name}` : null)).filter(Boolean);
  const cursor = bot.inventory.selectedItem;
  return `${slots.join(', ')}${cursor ? `; cursor ${cursor.count} ${cursor.name}` : ''}`;
}

// The 2x2 grid in the inventory loses track of items over the proxy, and mineflayer never
// closes it. Closing the inventory makes the server put back anything left in the grid or on
// the cursor, and the resync then pulls the real contents.
export async function settleInventory(bot) {
  if (bot.currentWindow) return;
  bot.closeWindow(bot.inventory);
  if (!bot._syncWindow) return delay(300);
  await guarded(() => bot._syncWindow(bot.inventory), { ms: 3000 }).catch(() => {});
}

// Room for more of an item in the main inventory and hotbar.
function roomFor(bot, item) {
  let room = 0;
  for (let i = bot.inventory.inventoryStart; i < bot.inventory.inventoryEnd; i++) {
    const s = bot.inventory.slots[i];
    if (!s) room += item.stackSize;
    else if (s.type === item.id) room += Math.max(0, item.stackSize - s.count);
  }
  return room;
}

// Crafts a few at a time and checks the inventory in between, so one lost click can't take the
// rest of the job with it. Returns how many were really made.
async function craftTimes(ctx, item, perCraft, times, table) {
  const { bot } = ctx;
  const start = have(bot, item.id);
  const made = () => have(bot, item.id) - start;
  let error = null;
  let misses = 0;
  while (made() < times * perCraft && misses < 2 && !ctx.signal?.aborted) {
    let n = Math.min(BATCH, Math.ceil((times * perCraft - made()) / perCraft), Math.floor(roomFor(bot, item) / perCraft));
    if (n <= 0) {
      error = 'my inventory is full';
      break;
    }
    let recipe = bot.recipesFor(item.id, null, n * perCraft, table)[0];
    if (!recipe) {
      n = 1;
      recipe = bot.recipesFor(item.id, null, perCraft, table)[0];
    }
    if (!recipe) {
      error = error ?? 'missing ingredient';
      break;
    }
    const before = have(bot, item.id);
    let stuck = false;
    try {
      await guarded(() => bot.craft(recipe, n, table ?? undefined), { ms: BATCH_MS });
    } catch (err) {
      stuck = err instanceof TimeoutError;
      error = stuck ? 'crafting got stuck' : err.message;
      bot.emit('craft_trouble', `crafting ${item.name} failed (${err.message}). Inventory: ${inventoryText(bot)}`);
    }
    if (!table) await settleInventory(bot);
    // A stuck craft keeps waiting in the background, so starting another one would mix their clicks.
    if (stuck) break;
    if (error && have(bot, item.id) <= before) misses++;
  }
  return { count: made(), error };
}

// What a recipe still needs from the inventory to make count items: [{ id, need }].
export function missingFor(recipe, count, haveCount) {
  const times = Math.ceil(count / recipe.result.count);
  return recipe.delta
    .filter((d) => d.count < 0)
    .map((d) => ({ id: d.id, need: -d.count * times - haveCount(d.id) }))
    .filter((m) => m.need > 0);
}

// Picks the recipe that is closest to possible. Missing items we could craft right now
// count less than ones we would have to go and find.
function bestRecipe(bot, recipes, count) {
  let best = null;
  let bestScore = Infinity;
  for (const recipe of recipes) {
    const missing = missingFor(recipe, count, (id) => have(bot, id));
    const score = missing.reduce((s, m) => s + (bot.recipesFor(m.id, null, m.need, null).length ? m.need * 0.5 : m.need * 10), 0);
    if (score < bestScore) {
      best = recipe;
      bestScore = score;
    }
  }
  return best;
}

// An empty spot next to the bot with solid ground under it.
export function placeSpot(bot) {
  const feet = bot.entity.position.floored();
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  for (const [dx, dz] of offsets) {
    const pos = feet.offset(dx, 0, dz);
    const spot = bot.blockAt(pos, false);
    const ground = bot.blockAt(pos.offset(0, -1, 0), false);
    const head = bot.blockAt(pos.offset(0, 1, 0), false);
    if (spot?.name === 'air' && ground?.boundingBox === 'block' && head?.name === 'air') return pos;
  }
  return null;
}

async function getTable(ctx, depth, notes) {
  const { bot } = ctx;
  const near = findNearest(bot, (name) => name === 'crafting_table', TABLE_RANGE)[0];
  if (near) return { block: bot.blockAt(near) };

  const tableItem = bot.registry.itemsByName.crafting_table;
  if (!have(bot, tableItem.id)) {
    const made = await craftItem(ctx, 'crafting_table', 1, depth + 1, notes);
    if (!made.ok) return { error: `there's no crafting table nearby and I couldn't make one (${made.message})` };
  }
  const spot = placeSpot(bot);
  if (!spot) return { error: 'no room next to me to put a crafting table down' };
  const placed = await placeOne(ctx, 'crafting_table', spot);
  if (!placed.ok) return { error: `couldn't put the crafting table down: ${placed.message}` };
  notes.push(`placed a crafting table at ${posText(spot)}`);
  return { block: bot.blockAt(spot) };
}

async function craftItem(ctx, name, count, depth, notes) {
  const { bot } = ctx;
  const item = bot.registry.itemsByName[name];
  if (!item) return fail(`unknown item: ${name}`);
  if (depth > MAX_DEPTH) return fail(`too many steps to make ${name}`);

  const all = bot.recipesAll(item.id, null, true);
  if (all.length === 0) return fail(`${name} can't be crafted`);

  let recipe = bot.recipesFor(item.id, null, count, null)[0];
  let table = null;
  if (!recipe) {
    const plan = bestRecipe(bot, all, count);
    for (const m of missingFor(plan, count, (id) => have(bot, id))) {
      const part = bot.registry.items[m.id].name;
      const made = await craftItem(ctx, part, m.need, depth + 1, notes);
      if (!made.ok) return fail(`missing ${m.need} ${part}: ${made.message}`);
    }
    if (plan.requiresTable) {
      const found = await getTable(ctx, depth, notes);
      if (found.error) return fail(found.error);
      table = found.block;
      if (!inReach(bot, table.position)) {
        const walked = await walkTo(ctx, new GoalLookAtBlock(table.position, bot.world, { reach: 4 }), { place: false });
        if (!walked.ok && !inReach(bot, table.position)) return fail(`couldn't get to the crafting table at ${posText(table.position)}`);
      }
    }
    recipe = bot.recipesFor(item.id, null, count, table)[0];
    if (!recipe) return fail(`still missing ingredients for ${name}`);
  }

  const times = Math.ceil(count / recipe.result.count);
  if (table) await bot.lookAt(table.position.offset(0.5, 0.5, 0.5)).catch(() => {});
  await pause(250, 600);
  const made = await craftTimes(ctx, item, recipe.result.count, times, table);
  if (made.count === 0) return fail(`couldn't craft ${name}: ${made.error ?? 'nothing came out'}`);
  if (depth > 0) notes.push(`made ${made.count} ${name}`);
  if (made.count < count) return fail(`only crafted ${made.count} of ${count} ${name}: ${made.error ?? 'ran out'}`);
  return ok(`crafted ${made.count} ${name}`);
}

// Crafts an item, making missing parts (planks, sticks...) and a crafting table first if needed.
export async function craft(ctx, { item, count }) {
  const notes = [];
  await settleInventory(ctx.bot);
  const result = await craftItem(ctx, item, Math.max(1, count ?? 1), 0, notes);
  const steps = notes.length ? ` (first ${notes.join(', ')})` : '';
  return result.ok ? ok(`${result.message}${steps}`) : fail(`${result.message}${steps}`);
}
