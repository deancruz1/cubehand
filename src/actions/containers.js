import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, guarded, TimeoutError, AbortedError } from './util.js';
import { walkTo } from './movement.js';
import { inReach, findNearest, matchesBlockName } from './blocks.js';
import { nearbyStorage } from '../perception.js';
import { chestKey, partsDistance, pickSource, stashTargets, keepReason } from '../chests.js';

const SEARCH_RANGE = 64;
const STASH_RANGE = 48;
const MAX_SOURCES = 6;
const MAX_UNKNOWN = 4;
// The main inventory and the hotbar.
const INVENTORY_SLOTS = 36;
const MAX_STASH_VISITS = 10;
const OPEN_MS = 5000;
const LATE_MS = 30000;
const LOOK_RETRY_MS = 600000;

const { GoalLookAtBlock } = pathfinderPkg.goals;

export function isContainer(name) {
  return ['chest', 'trapped_chest', 'barrel', 'ender_chest'].includes(name) || name.endsWith('shulker_box');
}

// Containers the bot may pick by itself. Opening a trapped chest sends a redstone signal, so
// it is only opened when its x y z is given.
export function isPickable(name) {
  return isContainer(name) && name !== 'trapped_chest';
}

const opening = new WeakMap();

// Runs open() (bot.openContainer and the like). Mineflayer waits for the window forever, and a
// chest with a block or a cat on top, or a shulker box with no room for its lid, never sends
// one, so this gives up after ms or when the job stops. A window that still turns up later is
// closed, unless something else was opened since. Tests shorten the wait with ctx.openMs.
export async function openWindow(ctx, open, ms = ctx.openMs ?? OPEN_MS) {
  const { bot, signal } = ctx;
  const turn = (opening.get(bot) ?? 0) + 1;
  opening.set(bot, turn);
  const pending = open();
  try {
    return await guarded(() => pending, { ms, signal });
  } catch (err) {
    if (err instanceof TimeoutError || err instanceof AbortedError) {
      const gaveUp = Date.now();
      pending.then((window) => {
        if (opening.get(bot) === turn && Date.now() - gaveUp < LATE_MS) window.close();
      }, () => {});
    }
    throw err;
  }
}

export function countItems(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

function countsText(counts) {
  return counts.size ? [...counts].map(([name, count]) => `${name}: ${count}`).join(', ') : 'nothing';
}

function countOf(items, name) {
  return items.reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);
}

const toVec = (p) => new Vec3(p.x, p.y, p.z);

// Notes what is inside for the chest index. An ender chest shows your own items wherever you
// open it, so it isn't kept.
function rememberContents(ctx, pos, name, window) {
  const { bot } = ctx;
  if (!bot.chestIndex || name === 'ender_chest') return;
  try {
    const items = window.containerItems();
    const here = nearbyStorage(bot, 8).find((c) => c.parts.some((p) => p.equals(pos)));
    bot.chestIndex.record({
      dim: bot.game?.dimension,
      name,
      parts: here?.parts ?? [pos],
      items: countItems(items),
      free: window.inventoryStart - items.length,
      labels: here?.labels
    });
  } catch (err) {
    ctx.log?.(`[chests] could not note what is in ${name}: ${err.message}`);
  }
}

// Walks over, opens the container, runs work(window), and always closes it again.
// With no position given it uses the nearest container that isn't a trapped chest.
export async function withContainer(ctx, { x, y, z }, work) {
  const { bot } = ctx;
  let pos;
  if (x === undefined || y === undefined || z === undefined) {
    pos = findNearest(bot, isPickable, SEARCH_RANGE)[0];
    if (!pos) return fail(`no chest or barrel within ${SEARCH_RANGE} blocks`);
  } else {
    pos = new Vec3(x, y, z);
  }
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  if (!isContainer(block.name)) {
    bot.chestIndex?.remove(pos, bot.game?.dimension);
    return fail(`no chest or barrel at ${posText(pos)} (found ${block.name})`);
  }

  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: false });
    if (!walked.ok && !inReach(bot, pos)) return fail(`could not get close enough to ${posText(pos)}: ${walked.message}`);
  }

  // Paced like a player: look at it, open it, look through it, then close it.
  let window;
  try {
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
    await pause(200, 450);
    window = await openWindow(ctx, () => bot.openContainer(bot.blockAt(pos, false)));
  } catch (err) {
    if (err instanceof AbortedError) return fail('stopped');
    if (err instanceof TimeoutError) return fail(`the ${block.name} at ${posText(pos)} wouldn't open, something is probably blocking it (a block or a cat on top, or no room for a shulker box lid)`);
    return fail(`could not open ${block.name}: ${err.message}`);
  }
  try {
    await pause(500, 1000);
    return await work(window, `${block.name} at ${posText(pos)}`);
  } finally {
    rememberContents(ctx, pos, block.name, window);
    await pause(300, 600);
    window.close();
  }
}

export async function openContainer(ctx, input) {
  return withContainer(ctx, input, async (window, name) => {
    const items = window.containerItems();
    const free = window.inventoryStart - items.length;
    return ok(`${name} holds: ${countsText(countItems(items))} (${free} empty slots)`);
  });
}

// How many of name still fit in slots: the empty ones, plus what is left on stacks of it.
function roomFor(items, slots, name, stackSize) {
  const topUp = items.reduce((sum, i) => (i.name === name ? sum + Math.max(0, stackSize - i.count) : sum), 0);
  return Math.max(0, slots - items.length) * stackSize + topUp;
}

const freeSlots = (items) => Math.max(0, INVENTORY_SLOTS - items.length);

// True when none of the names fits anywhere in the inventory.
function inventoryFull(bot, names) {
  const items = bot.inventory.items();
  return freeSlots(items) === 0 && !items.some((i) => names.includes(i.name) && i.count < (i.stackSize ?? 64));
}

function fullText(free, left, where) {
  const leftText = left.length ? `, left ${left.join(', ')} in the ${where}` : '';
  return `inventory is full (${free} free slots)${leftText}. stash puts things away to free room`;
}

// window.withdraw refuses whenever the inventory has no empty slot, even with room left on
// stacks of the same item, so that case goes through bot.transfer.
function withdraw(bot, window, type, count) {
  if (typeof bot.transfer !== 'function' || window.items().length < INVENTORY_SLOTS) return window.withdraw(type, null, count);
  return bot.transfer({
    window, itemType: type, metadata: null, count,
    sourceStart: 0, sourceEnd: window.inventoryStart, destStart: window.inventoryStart, destEnd: window.inventoryEnd
  });
}

// A transfer that stops part-way leaves the rest on the cursor. Putting it back where it came
// from keeps the next transfer clean and stops it being dropped when the window closes.
async function settle(ctx, window, store) {
  const { bot } = ctx;
  if (!window.selectedItem || typeof bot.putSelectedItemRange !== 'function') return;
  const [start, end] = store ? [window.inventoryStart, window.inventoryEnd] : [0, window.inventoryStart];
  try {
    await bot.putSelectedItemRange(start, end, window, null);
  } catch (err) {
    ctx.log?.(`[containers] could not put back what was on the cursor: ${err.message}`);
  }
}

// Moves up to want of item into the container (store) or out of it, no more than fits, and
// counts what really arrived. full is true when the rest had no room.
async function moveOne(ctx, window, store, item, want) {
  const { bot } = ctx;
  const to = () => (store ? window.containerItems() : window.items());
  const source = (store ? window.items() : window.containerItems()).find((i) => i.name === item);
  if (!source || !want) return { moved: 0, full: false, error: null };
  const stackSize = source.stackSize ?? bot.registry?.itemsByName?.[item]?.stackSize ?? 64;
  const amount = Math.min(want, roomFor(to(), store ? window.inventoryStart : INVENTORY_SLOTS, item, stackSize));
  if (!amount) return { moved: 0, full: true, error: null };
  const before = countOf(to(), item);
  let error = null;
  try {
    if (store) await window.deposit(source.type, null, amount);
    else await withdraw(bot, window, source.type, amount);
  } catch (err) {
    error = err.message;
  }
  await settle(ctx, window, store);
  const moved = Math.max(0, countOf(to(), item) - before);
  const full = moved < want && (amount < want || /full/i.test(error ?? ''));
  return { moved, full, error: moved < want && !full ? error ?? `only ${moved} of ${want} moved` : null };
}

// Moves each requested item one way and reports what really moved, and why the rest didn't.
async function moveItems(ctx, input, verb) {
  const store = verb === 'store';
  return withContainer(ctx, input, async (window, name) => {
    const done = [];
    const left = [];
    const problems = [];
    for (const { item, count } of input.items) {
      if (ctx.signal?.aborted) {
        problems.push('stopped');
        break;
      }
      const have = countOf(store ? window.items() : window.containerItems(), item);
      if (!have) {
        problems.push(`no ${item} to ${verb}`);
        continue;
      }
      const want = Math.min(count ?? have, have);
      const { moved, full, error } = await moveOne(ctx, window, store, item, want);
      if (moved) done.push(`${moved} ${item}`);
      if (full) left.push(`${want - moved} ${item}`);
      if (error) problems.push(`${item}: ${error}`);
      await pause(150, 400);
    }
    const parts = [`${done.length ? `${store ? 'stored' : 'took'} ${done.join(', ')}` : 'nothing moved'} (${name})`];
    if (left.length) parts.push(store ? `the ${name} is full, ${left.join(', ')} did not fit` : fullText(freeSlots(window.items()), left, name));
    if (problems.length) parts.push(`${done.length ? 'Problems: ' : ''}${problems.join('; ')}`);
    return done.length ? ok(parts.join('. ')) : fail(parts.join('. '));
  });
}

export async function storeItems(ctx, input) {
  return moveItems(ctx, input, 'store');
}

function takeFrom(ctx, input) {
  return moveItems(ctx, input, 'take');
}

const loadedName = (bot) => (p) => bot.blockAt(toVec(p), false)?.name ?? null;

// Without x y z: takes from the nearest containers the chest index says hold each item, more
// than one when the first has too little, then opens up to MAX_UNKNOWN containers it knows
// nothing about, nearest first. Each one opened is noted in the index.
export async function takeItems(ctx, input) {
  const { bot } = ctx;
  const names = input.items.map((i) => i.item);
  if (inventoryFull(bot, names)) return fail(`took nothing: ${fullText(0, [], '')}`);
  const { x, y, z } = input;
  if (x !== undefined && y !== undefined && z !== undefined) return takeFrom(ctx, input);
  const chests = bot.chestIndex;
  const dim = bot.game?.dimension;
  // Infinity means all of it, from the first container that has some.
  const wanted = new Map();
  for (const { item, count } of input.items) wanted.set(item, (wanted.get(item) ?? 0) + (count ?? Infinity));
  if (!chests) return takeFrom(ctx, input);
  chests.prune(dim, bot.entity.position, SEARCH_RANGE, loadedName(bot));

  const tried = new Set();
  const took = [];
  const empty = [];
  const notes = [];
  let known = 0;
  let unknown = 0;
  let stop = false;
  while (wanted.size && !stop) {
    if (ctx.signal?.aborted) {
      notes.push('stopped');
      break;
    }
    const source = known < MAX_SOURCES ? pickSource(chests.list(dim), wanted, bot.entity.position, tried, SEARCH_RANGE) : null;
    let pos;
    if (source) {
      pos = toVec(source.parts[0]);
      tried.add(source.key);
      known++;
    } else {
      if (unknown >= MAX_UNKNOWN) break;
      pos = findNearest(bot, isPickable, SEARCH_RANGE, 20).find((p) => !chests.find(p, dim) && !tried.has(chestKey([p], dim)));
      if (!pos) break;
      tried.add(chestKey([pos], dim));
      unknown++;
    }
    const expected = (source?.items ?? []).map(([name]) => name).filter((name) => wanted.has(name));
    const result = await withContainer(ctx, pos, async (window, name) => {
      const got = [];
      const left = [];
      const gone = expected.filter((item) => !countOf(window.containerItems(), item));
      for (const [item, want] of [...wanted]) {
        if (ctx.signal?.aborted) break;
        const have = countOf(window.containerItems(), item);
        if (!have) continue;
        const { moved, full, error } = await moveOne(ctx, window, false, item, Math.min(want, have));
        if (moved) got.push(`${moved} ${item}`);
        if (want === Infinity ? moved > 0 : moved >= want) wanted.delete(item);
        else wanted.set(item, want - moved);
        if (full) left.push(`${Math.min(want, have) - moved} ${item}`);
        if (error) notes.push(`${item}: ${error}`);
        await pause(150, 400);
        if (full || error) {
          stop = true;
          break;
        }
      }
      if (got.length) took.push(`${got.join(', ')} from ${name}`);
      else if (!left.length && !gone.length) empty.push(name);
      if (gone.length) notes.push(`${name} no longer had ${gone.join(', ')}`);
      if (left.length) notes.push(fullText(freeSlots(window.items()), left, name));
      return ok('');
    });
    if (!result.ok) notes.push(result.message);
  }

  const missing = [...wanted].map(([item, n]) => (n === Infinity ? item : `${n} ${item}`));
  const parts = [took.length ? `took ${took.join('; ')}` : 'took nothing'];
  if (missing.length) parts.push(`still missing: ${missing.join(', ')}`);
  if (!tried.size) parts.push(`no container within ${SEARCH_RANGE} blocks had it when last opened`);
  if (empty.length) parts.push(`none in ${empty.join(', ')}`);
  if (notes.length) parts.push(`notes: ${notes.join('; ')}`);
  return took.length ? ok(parts.join('. ')) : fail(parts.join('. '));
}

// Opens up to max containers the chest index knows nothing about, nearest first, only so the
// index notes what is in them. Nothing is moved. An ender chest is never noted, so it is skipped.
// One that wouldn't open never gets into the index either, so it is skipped for LOOK_RETRY_MS.
// Returns the containers it looked in and why any others couldn't be opened.
export async function lookInUnknown(ctx, max = MAX_UNKNOWN) {
  const { bot } = ctx;
  const chests = bot.chestIndex;
  const dim = bot.game?.dimension;
  const looked = [];
  const problems = [];
  if (!chests) return { looked, problems };
  bot.lookFails ??= new Map();
  const skip = (k) => (bot.lookFails.get(k) ?? 0) > Date.now();
  const tried = new Set();
  while (tried.size < max && !ctx.signal?.aborted) {
    const pos = findNearest(bot, (n) => isPickable(n) && n !== 'ender_chest', SEARCH_RANGE, 20)
      .find((p) => !chests.find(p, dim) && !tried.has(chestKey([p], dim)) && !skip(chestKey([p], dim)));
    if (!pos) break;
    const k = chestKey([pos], dim);
    tried.add(k);
    const result = await withContainer(ctx, pos, async (window, name) => ok(name));
    if (result.ok) looked.push(result.message);
    else if (!ctx.signal?.aborted) {
      problems.push(result.message);
      bot.lookFails.set(k, Date.now() + LOOK_RETRY_MS);
    }
  }
  return { looked, problems };
}

// What stash puts away from carried (a Map of name to count): only the listed items when items
// is given, else everything but the keep list and the kinds kept by default.
export function stashSelection(carried, { items, keep } = {}, isFood) {
  const put = new Map();
  const kept = [];
  const left = items?.map((i) => i.count ?? Infinity);
  for (const [name, count] of carried) {
    if (keep?.some((k) => matchesBlockName(name, k))) {
      kept.push({ name, count, reason: 'asked to keep' });
      continue;
    }
    if (items?.length) {
      let amount = 0;
      items.forEach((i, n) => {
        if (amount >= count || left[n] <= 0 || !matchesBlockName(name, i.item)) return;
        const a = Math.min(left[n], count - amount);
        amount += a;
        left[n] -= a;
      });
      if (amount) put.set(name, amount);
      continue;
    }
    const reason = keepReason(name, isFood);
    if (reason) kept.push({ name, count, reason });
    else put.set(name, count);
  }
  return { put, kept };
}

function groupedText(list) {
  const groups = new Map();
  for (const { name, count, reason } of list) {
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(`${count} ${name}`);
  }
  return [...groups].map(([reason, names]) => `${names.join(', ')} (${reason})`).join('; ');
}

// Puts away everything the bot doesn't need to carry. Each kind goes where stashTargets says,
// visiting the nearest planned container next, and moves on to the next choice when one is full.
export async function stash(ctx, input = {}) {
  const { bot } = ctx;
  const chests = bot.chestIndex;
  const dim = bot.game?.dimension;
  const foods = bot.registry.foodsByName;
  const isFood = foods ? (name) => Boolean(foods[name]) : undefined;
  const carried = countItems(bot.inventory.items());
  const { put, kept } = stashSelection(carried, input, isFood);
  const notCarried = (input.items ?? []).filter((i) => ![...carried.keys()].some((n) => matchesBlockName(n, i.item))).map((i) => i.item);
  const keptText = kept.length ? `kept ${groupedText(kept)}` : null;
  const notCarriedText = notCarried.length ? `not carrying ${notCarried.join(', ')}` : null;
  if (!put.size) {
    const text = ['nothing to put away', keptText, notCarriedText].filter(Boolean).join('. ');
    return notCarried.length ? fail(text) : ok(text);
  }

  const storage = nearbyStorage(bot, STASH_RANGE).filter((c) => isPickable(c.name)).map((c) => ({
    ...c,
    key: chestKey(c.parts, dim),
    items: chests?.find(c.parts[0], dim)?.items ?? null
  }));
  if (storage.length === 0) return fail(`no chest, barrel or shulker box within ${STASH_RANGE} blocks`);

  const skip = new Set();
  const stored = [];
  const stuck = [];
  const problems = [];
  let visits = 0;
  while (put.size) {
    if (ctx.signal?.aborted) {
      for (const [name, count] of put) stuck.push({ name, count, reason: 'stopped' });
      break;
    }
    const here = bot.entity.position;
    const plan = new Map();
    for (const [name, count] of [...put]) {
      const targets = stashTargets(name, storage, here, isFood);
      const target = targets.find((c) => !skip.has(c.key));
      if (!target) {
        stuck.push({ name, count, reason: targets.length ? 'every container that fits is full or out of reach' : 'every container nearby is labeled for something else' });
        put.delete(name);
        continue;
      }
      if (!plan.has(target.key)) plan.set(target.key, { target, names: [] });
      plan.get(target.key).names.push(name);
    }
    if (plan.size === 0) break;
    if (visits >= MAX_STASH_VISITS) {
      for (const [name, count] of put) stuck.push({ name, count, reason: 'too many containers for one call' });
      break;
    }
    visits++;
    const { target, names } = [...plan.values()].sort((a, b) => partsDistance(a.target.parts, here) - partsDistance(b.target.parts, here))[0];
    const result = await withContainer(ctx, toVec(target.parts[0]), async (window, label) => {
      const done = [];
      for (const name of names) {
        if (ctx.signal?.aborted) break;
        const own = window.items().filter((i) => i.name === name);
        const amount = Math.min(put.get(name), countOf(own, name));
        if (!amount) {
          put.delete(name);
          continue;
        }
        const before = countOf(window.containerItems(), name);
        try {
          await window.deposit(own[0].type, null, amount);
        } catch {
          // A full container throws; whatever didn't fit goes to the next choice below.
        }
        await settle(ctx, window, true);
        const moved = countOf(window.containerItems(), name) - before;
        if (moved) done.push(`${moved} ${name}`);
        if (moved >= amount) {
          put.delete(name);
        } else {
          put.set(name, put.get(name) - moved);
          skip.add(target.key);
        }
        await pause(150, 400);
      }
      target.items = [...countItems(window.containerItems())];
      if (done.length) stored.push(`${done.join(', ')} in ${label}`);
      return ok('');
    });
    if (!result.ok) {
      problems.push(result.message);
      skip.add(target.key);
    }
  }

  const parts = [stored.length ? `put away ${stored.join('; ')}` : 'put nothing away'];
  if (stuck.length) parts.push(`still carrying ${groupedText(stuck)}`);
  if (keptText) parts.push(keptText);
  if (notCarriedText) parts.push(notCarriedText);
  if (problems.length) parts.push(`problems: ${problems.join('; ')}`);
  return stored.length ? ok(parts.join('. ')) : fail(parts.join('. '));
}
