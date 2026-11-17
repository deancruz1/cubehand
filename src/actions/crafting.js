import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay, guarded, TimeoutError } from './util.js';
import { walkTo } from './movement.js';
import { findNearest, inReach, placeOne } from './blocks.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const MAX_DEPTH = 3;
const TABLE_RANGE = 32;
const BATCH = 8;
const MAX_NUDGES = 3;
const TABLE_STUCK = 'the crafting table stopped responding';
// drainMs is longer than the 20 s mineflayer waits for a slot update before it gives up.
export const CRAFT_TIMING = { batchMs: 20000, quietMs: 3000, settleMs: 6000, drainMs: 25000, progressMs: 10000, tickMs: 1000 };
// A batch that was given up on can still be running inside mineflayer, and starting another
// would mix its clicks with the first one's.
const running = new WeakMap();

// What she carries, for crafting and for obtain alike. Crafts close their window and resync
// the inventory before anything counts, so bot.inventory is the only count that is needed.
export function carriedItems(bot) {
  return bot.inventory.items();
}

function have(bot, id) {
  return carriedItems(bot).filter((i) => i.type === id).reduce((sum, i) => sum + i.count, 0);
}

const ingredientNames = (bot, r) => [...new Set(r.delta.filter((d) => d.count < 0).map((d) => bot.registry.items[d.id]?.name))].sort().join(',');

// Only the recipe variant made from exactly these items, so planks of one wood that a plan keeps
// for something else don't go into the sticks.
function variant(bot, ingredients) {
  if (!ingredients?.length) return () => true;
  const want = [...new Set(ingredients)].sort().join(',');
  return (r) => ingredientNames(bot, r) === want;
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

function windowState(bot) {
  const w = bot.currentWindow;
  if (!w) return 'closed';
  return `${w.id}|${w.selectedItem?.count ?? 0}|${w.slots.map((s) => (s ? `${s.type}:${s.count}` : '')).join(',')}`;
}

// A resync sends every slot of the window again, which wakes a click that is still waiting for
// a slot update the server never sent. A table craft with no window open is waiting for the
// table to open, so it gets used again.
function nudge(bot, table) {
  const w = bot.currentWindow ?? (table ? null : bot.inventory);
  if (w) bot._syncWindow?.(w).catch(() => {});
  else bot.activateBlock?.(table).catch(() => {});
}

function watchQuiet(bot, table, job) {
  let last = windowState(bot);
  let since = Date.now();
  let nudges = 0;
  return setInterval(() => {
    const now = windowState(bot);
    if (now !== last) {
      last = now;
      since = Date.now();
      return;
    }
    if (job.done || nudges >= MAX_NUDGES || Date.now() - since < CRAFT_TIMING.quietMs) return;
    nudges++;
    since = Date.now();
    nudge(bot, table);
  }, CRAFT_TIMING.tickMs);
}

// Gives a batch that timed out one more resync and a few seconds to finish by itself.
async function settle(bot, table, job, status) {
  if (job.done) return true;
  status?.progress('waiting for a slow craft to finish');
  nudge(bot, table);
  const end = Date.now() + CRAFT_TIMING.settleMs;
  while (!job.done && Date.now() < end) await delay(100);
  return job.done;
}

// Ends a craft that was given up on. Closing its table window makes the server hand back what
// is left in the grid and on the cursor, and leaves the craft waiting for slot updates that
// can't come, so it stops when mineflayer's own wait runs out instead of clicking on. Nothing
// resyncs the inventory meanwhile, because that would wake a 2x2 craft back up.
async function stop(bot, job, status) {
  const end = Date.now() + CRAFT_TIMING.drainMs;
  // The stuck watchdog would stop the job during a wait this long with nothing moving.
  let told = 0;
  while (!job.done && Date.now() < end) {
    if (Date.now() - told >= CRAFT_TIMING.progressMs) {
      told = Date.now();
      status?.progress('waiting for a stuck craft to end');
    }
    const w = bot.currentWindow;
    if (job.table && w?.type?.startsWith('minecraft:crafting')) bot.closeWindow(w);
    await delay(100);
  }
  return job.done;
}

// One bot.craft that has really ended when this returns, unless the job is still marked running.
async function runBatch(bot, recipe, n, table, status) {
  const job = { done: false, table };
  job.promise = bot.craft(recipe, n, table ?? undefined).finally(() => {
    job.done = true;
  });
  running.set(bot, job);
  const watch = table ? watchQuiet(bot, table, job) : null;
  try {
    await guarded(() => job.promise, { ms: CRAFT_TIMING.batchMs });
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    if (await settle(bot, table, job, status)) return job.promise;
    // A nudge now would open the table again while stop is closing it.
    clearInterval(watch);
    await stop(bot, job, status);
    throw err;
  } finally {
    clearInterval(watch);
  }
}

// Gives a craft an earlier call gave up on one more nudge, then stops it. Returns why crafting
// can't start yet, or null.
async function finishRunning(bot, status) {
  const job = running.get(bot);
  if (!job || job.done || (await settle(bot, job.table, job, status)) || (await stop(bot, job, status))) return null;
  return job.table ? 'my last craft at the crafting table never finished, so the table is still busy' : "my last craft never finished, so I can't start another yet";
}

// Crafts a few at a time and recounts in between, so one lost click can't take the rest of the
// job with it. Every count comes from bot.inventory after the batch has ended and the inventory
// was resynced. Returns how many were really made.
async function craftTimes(ctx, item, perCraft, times, table, pick = () => true) {
  const { bot } = ctx;
  const start = have(bot, item.id);
  const made = () => Math.max(0, have(bot, item.id) - start);
  let error = null;
  let misses = 0;
  while (made() < times * perCraft && misses < 2 && !ctx.signal?.aborted) {
    let n = Math.min(BATCH, Math.ceil((times * perCraft - made()) / perCraft), Math.floor(roomFor(bot, item) / perCraft));
    if (n <= 0) {
      error = 'my inventory is full';
      break;
    }
    let recipe = bot.recipesFor(item.id, null, n * perCraft, table).filter(pick)[0];
    if (!recipe) {
      n = 1;
      recipe = bot.recipesFor(item.id, null, perCraft, table).filter(pick)[0];
    }
    if (!recipe) {
      error = error ?? 'missing ingredient';
      break;
    }
    const before = have(bot, item.id);
    let stuck = false;
    try {
      await runBatch(bot, recipe, n, table, ctx.status);
    } catch (err) {
      stuck = err instanceof TimeoutError;
      error = stuck ? (table ? TABLE_STUCK : 'crafting got stuck') : err.message;
      bot.emit('craft_trouble', `crafting ${item.name} failed (${err.message}). Inventory: ${inventoryText(bot)}`);
    }
    // A resync would wake a craft that is still running, so that one keeps the count it has.
    if (running.get(bot)?.done !== false) await settleInventory(bot);
    if (stuck) break;
    if (error && have(bot, item.id) <= before) misses++;
  }
  if (ctx.signal?.aborted && made() < times * perCraft) error = `stopped after making ${made()}`;
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

async function craftItem(ctx, name, count, depth, notes, ingredients) {
  const { bot } = ctx;
  const item = bot.registry.itemsByName[name];
  if (!item) return fail(`unknown item: ${name}`);
  if (depth > MAX_DEPTH) return fail(`too many steps to make ${name}`);

  let all = bot.recipesAll(item.id, null, true);
  if (all.length === 0) return fail(`${name} can't be crafted`);
  let pick = variant(bot, ingredients);
  if (!all.some(pick)) pick = () => true;
  all = all.filter(pick);

  let recipe = bot.recipesFor(item.id, null, count, null).filter(pick)[0];
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
    recipe = bot.recipesFor(item.id, null, count, table).filter(pick)[0];
    if (!recipe) return fail(`still missing ingredients for ${name}`);
  }

  const times = Math.ceil(count / recipe.result.count);
  if (table) await bot.lookAt(table.position.offset(0.5, 0.5, 0.5)).catch(() => {});
  await pause(250, 600);
  const made = await craftTimes(ctx, item, recipe.result.count, times, table, pick);
  if (made.count === 0) return fail(`couldn't craft ${name}: ${made.error ?? 'nothing came out'}`);
  if (depth > 0) notes.push(`made ${made.count} ${name}`);
  if (made.count < count) return fail(`only crafted ${made.count} of ${count} ${name}: ${made.error ?? 'ran out'}`);
  return ok(`crafted ${made.count} ${name}`);
}

// Crafts an item, making missing parts (planks, sticks...) and a crafting table first if needed.
// ingredients (from obtain's plan) picks the recipe variant made from exactly those items.
export async function craft(ctx, { item, count, ingredients }) {
  const notes = [];
  const busy = await finishRunning(ctx.bot, ctx.status);
  if (busy) return fail(`couldn't craft ${item}: ${busy}`);
  await settleInventory(ctx.bot);
  const result = await craftItem(ctx, item, Math.max(1, count ?? 1), 0, notes, ingredients);
  const steps = notes.length ? ` (first ${notes.join(', ')})` : '';
  return result.ok ? ok(`${result.message}${steps}`) : fail(`${result.message}${steps}`);
}
