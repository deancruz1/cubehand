import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo } from './movement.js';
import { findNearest, inReach, placeOne } from './blocks.js';
import { craft, placeSpot } from './crafting.js';
import { countItems } from './containers.js';
import { gainedText } from './items.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const RANGE = 32;
const FURNACES = ['furnace', 'blast_furnace', 'smoker'];
const SECONDS = { furnace: 10, blast_furnace: 5, smoker: 5 };
const WAIT_LIMIT_S = 90;

// What smelts into what. Logs and wood make charcoal.
const SMELTS = {
  raw_iron: 'iron_ingot', iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot', gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', nether_gold_ore: 'gold_ingot',
  raw_copper: 'copper_ingot', copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap', coal_ore: 'coal', deepslate_coal_ore: 'coal',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond', emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli', redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz', sand: 'glass', red_sand: 'glass', cobblestone: 'stone', stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate', clay_ball: 'brick', clay: 'terracotta', netherrack: 'nether_brick',
  sandstone: 'smooth_sandstone', red_sandstone: 'smooth_red_sandstone', quartz_block: 'smooth_quartz',
  stone_bricks: 'cracked_stone_bricks', basalt: 'smooth_basalt', wet_sponge: 'sponge', cactus: 'green_dye',
  sea_pickle: 'lime_dye', chorus_fruit: 'popped_chorus_fruit', kelp: 'dried_kelp',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato'
};
const RAW_FOOD = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'];
const FUELS = [['coal', 8], ['charcoal', 8], ['blaze_rod', 12], ['dried_kelp_block', 20], ['coal_block', 80]];

const isNetherWood = (name) => name.startsWith('crimson_') || name.startsWith('warped_');
const isLog = (name) => /_(log|wood)$/.test(name) && !isNetherWood(name);

export function smeltOutput(name) {
  return SMELTS[name] ?? (isLog(name) ? 'charcoal' : null);
}

// The item to put in: name itself when it smelts and is carried, or something carried that
// smelts into it (iron_ingot finds raw_iron).
export function inputFor(name, carried) {
  if (smeltOutput(name) && carried.includes(name)) return name;
  return carried.find((c) => smeltOutput(c) === name) ?? null;
}

export function fuelValue(name) {
  const fuel = FUELS.find(([n]) => n === name);
  if (fuel) return fuel[1];
  if (isNetherWood(name)) return 0;
  if (name.endsWith('_planks') || isLog(name)) return 1.5;
  if (name === 'stick') return 0.5;
  return 0;
}

// Coal first, then other real fuels, then planks, sticks and logs. Picks one kind that covers
// the job, or the kind that covers the most. only limits it to the kind already in the fuel slot.
export function pickFuel(counts, items, { exclude, only } = {}) {
  const order = [...FUELS.map(([n]) => n)];
  const wood = [...counts.keys()].filter((n) => fuelValue(n) > 0 && !order.includes(n));
  wood.sort((a, b) => (isLog(a) ? 2 : a === 'stick' ? 1 : 0) - (isLog(b) ? 2 : b === 'stick' ? 1 : 0));
  const kinds = [...order, ...wood].filter((n) => counts.get(n) && n !== exclude && (!only || n === only));
  let best = null;
  for (const name of kinds) {
    const need = Math.ceil(items / fuelValue(name));
    const have = counts.get(name);
    if (have >= need) return { name, count: need };
    if (!best || have * fuelValue(name) > best.count * fuelValue(best.name)) best = { name, count: have };
  }
  return best;
}

function furnaceKind(input) {
  if (/^raw_|_ore$|^ancient_debris$/.test(input)) return 'blast_furnace';
  if (RAW_FOOD.includes(input)) return 'smoker';
  return 'furnace';
}

function carriedCounts(bot) {
  return countItems(bot.inventory.items());
}

async function openAt(ctx, pos) {
  const { bot } = ctx;
  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: false });
    if (!walked.ok && !inReach(bot, pos)) return { error: `could not get to the furnace at ${posText(pos)}: ${walked.message}` };
  }
  const block = bot.blockAt(pos, false);
  if (!block || !FURNACES.includes(block.name)) return { error: `there's no furnace at ${posText(pos)} any more`, gone: true };
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5)).catch(() => {});
  await pause(200, 450);
  try {
    return { furnace: await bot.openFurnace(block), kind: block.name };
  } catch (err) {
    return { error: `could not open the furnace at ${posText(pos)}: ${err.message}` };
  }
}

// A furnace that is free for this input, or the one at pos when a player picked it.
async function openFree(ctx, input, pos) {
  const { bot, smeltJobs } = ctx;
  if (pos) {
    const opened = await openAt(ctx, pos);
    if (opened.error) return opened;
    const inside = opened.furnace.inputItem();
    if (inside && inside.name !== input) {
      opened.furnace.close();
      return { error: `the furnace at ${posText(pos)} is busy with ${inside.count} ${inside.name}` };
    }
    return { ...opened, pos };
  }
  const kinds = [...new Set([furnaceKind(input), 'furnace'])];
  const here = bot.entity.position;
  // The special kind is twice as fast, so it may be a little further away.
  const score = (p) => p.distanceTo(here) - (bot.blockAt(p, false)?.name === 'furnace' ? 0 : 8);
  const found = findNearest(bot, (n) => kinds.includes(n), RANGE, 8)
    .filter((p) => smeltJobs.has(p.toString()) || !bot.blockAt(p, false)?.getProperties().lit)
    .sort((a, b) => score(a) - score(b));
  for (const p of found.slice(0, 3)) {
    if (ctx.signal?.aborted) return { error: 'stopped' };
    const opened = await openAt(ctx, p);
    if (opened.error) continue;
    const inside = opened.furnace.inputItem();
    const out = opened.furnace.outputItem();
    const mine = smeltJobs.has(p.toString());
    if ((!inside || inside.name === input) && (!out || (mine && out.name === smeltOutput(input)))) return { ...opened, pos: p };
    opened.furnace.close();
    await pause(200, 400);
  }
  return { error: 'no free furnace nearby' };
}

async function makeFurnace(ctx) {
  const { bot } = ctx;
  if (!carriedCounts(bot).get('furnace')) {
    const made = await craft(ctx, { item: 'furnace', count: 1 });
    if (!made.ok) return { error: `there's no free furnace nearby and I couldn't make one (${made.message})` };
  }
  const spot = placeSpot(bot);
  if (!spot) return { error: 'there is no free furnace nearby and no room next to me to put one down' };
  const placed = await placeOne(ctx, 'furnace', spot);
  if (!placed.ok) return { error: `couldn't put a furnace down: ${placed.message}` };
  return { pos: spot };
}

// Stays at the open furnace until the input is used up, taking the output as it fills.
async function waitForFurnace(ctx, furnace, perItem, seconds) {
  const { signal } = ctx;
  const deadline = Date.now() + (seconds + 15) * 1000;
  let left = furnace.inputItem()?.count ?? 0;
  let changed = Date.now();
  let problem = null;
  while (furnace.inputItem() && Date.now() < deadline) {
    if (signal?.aborted) {
      problem = 'stopped';
      break;
    }
    await pause(1000);
    if ((furnace.outputItem()?.count ?? 0) >= 56) await furnace.takeOutput().catch(() => {});
    const now = furnace.inputItem()?.count ?? 0;
    ctx.status?.progress(`smelting, ${now} left`);
    if (now !== left) {
      left = now;
      changed = Date.now();
    } else if (Date.now() - changed > perItem * 2000 + 5000) {
      problem = furnace.fuelItem() ? 'the furnace stopped' : 'it ran out of fuel';
      break;
    }
  }
  if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
  if (!problem && furnace.inputItem()) problem = 'it took longer than expected';
  return problem;
}

// Takes finished items out of a furnace: one of the bot's own jobs, or the one at pos.
async function collect(ctx, pos) {
  const { bot, smeltJobs } = ctx;
  const job = pos ? smeltJobs.get(pos.toString()) : [...smeltJobs.values()].sort((a, b) => a.readyAt - b.readyAt)[0];
  const target = pos ?? job?.pos;
  if (!target) return fail("I don't have anything in a furnace. Give x y z to empty a particular furnace.");
  const opened = await openAt(ctx, target);
  if (opened.error) {
    if (opened.gone) smeltJobs.delete(target.toString());
    return fail(opened.error);
  }
  const { furnace } = opened;
  const before = carriedCounts(bot);
  try {
    if (furnace.outputItem()) await furnace.takeOutput();
    const left = furnace.inputItem();
    if (!left) smeltJobs.delete(target.toString());
    else if (job) job.readyAt = Date.now() + left.count * SECONDS[opened.kind] * 1000;
    const got = gainedText(before, carriedCounts(bot));
    const rest = left ? `, ${left.count} ${left.name} still in it` : '';
    return got ? ok(`took ${got} out of the furnace at ${posText(target)}${rest}`) : fail(`nothing is finished yet in the furnace at ${posText(target)}${rest}`);
  } finally {
    await pause(200, 400);
    furnace.close();
  }
}

// make false never puts down a new furnace (for the bot's own chores).
export async function smelt(ctx, { item, count, x, y, z, wait, make = true }) {
  const { bot, smeltJobs } = ctx;
  const given = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : null;
  if (!item) return collect(ctx, given);

  const carried = carriedCounts(bot);
  const input = inputFor(item, [...carried.keys()]);
  if (!input) {
    const what = smeltOutput(item) ? item : `anything that smelts into ${item}`;
    return fail(`I'm not carrying ${what}. Take it out of a chest first.`);
  }
  const output = smeltOutput(input);
  const amount = Math.min(count ?? carried.get(input), carried.get(input), 64);
  if (!pickFuel(carried, 1, { exclude: input })) return fail('I have no fuel. I need coal or charcoal (or planks, logs or sticks).');

  let opened = await openFree(ctx, input, given);
  let made = '';
  if (opened.error && !given && opened.error !== 'stopped' && make) {
    const built = await makeFurnace(ctx);
    if (built.error) return fail(built.error);
    made = ` (put down a furnace at ${posText(built.pos)})`;
    opened = await openAt(ctx, built.pos);
    if (!opened.error) opened.pos = built.pos;
  }
  if (opened.error) return fail(opened.error);
  const { furnace, kind, pos } = opened;
  const before = carriedCounts(bot);
  let closed = false;
  try {
    if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
    const inputId = bot.registry.itemsByName[input].id;
    const already = furnace.inputItem()?.count ?? 0;
    const n = Math.min(amount, 64 - already);
    if (n > 0) await furnace.putInput(inputId, null, n);
    const total = furnace.inputItem()?.count ?? already + n;

    const slot = furnace.fuelItem();
    const covered = slot ? fuelValue(slot.name) * slot.count : 0;
    let fuelText = '';
    if (total > covered) {
      const fuel = pickFuel(carriedCounts(bot), total - covered, { exclude: input, only: slot?.name });
      if (fuel) {
        await furnace.putFuel(bot.registry.itemsByName[fuel.name].id, null, fuel.count);
        fuelText = ` with ${fuel.count} ${fuel.name}`;
        if (fuel.count * fuelValue(fuel.name) + covered < total) fuelText += ' (not enough fuel for all of it)';
      } else if (!slot) {
        return fail(`I have no fuel that fits in the furnace at ${posText(pos)}`);
      }
    }

    const seconds = total * SECONDS[kind];
    const stay = wait ?? seconds <= WAIT_LIMIT_S;
    if (!stay) {
      smeltJobs.set(pos.toString(), { pos, input, output, count: total, readyAt: Date.now() + seconds * 1000 });
      const minutes = Math.max(1, Math.round(seconds / 60));
      return ok(`put ${total} ${input} in the ${kind} at ${posText(pos)}${fuelText}${made}. It will be done in about ${minutes} min; come back with smelt (no item) to take it out`);
    }

    const problem = await waitForFurnace(ctx, furnace, SECONDS[kind], seconds);
    const left = furnace.inputItem();
    if (left) smeltJobs.set(pos.toString(), { pos, input, output, count: left.count, readyAt: Date.now() + left.count * SECONDS[kind] * 1000 });
    else smeltJobs.delete(pos.toString());
    await pause(200, 400);
    furnace.close();
    closed = true;
    const got = gainedText(before, carriedCounts(bot));
    const rest = left ? `. ${left.count} ${left.name} are still in the ${kind} at ${posText(pos)} because ${problem}` : '';
    return got ? ok(`smelted ${got} in the ${kind} at ${posText(pos)}${fuelText}${made}${rest}`) : fail(`nothing came out of the ${kind} at ${posText(pos)}: ${problem ?? 'unknown problem'}`);
  } finally {
    if (!closed) furnace.close();
  }
}

export function readyJob(smeltJobs, now = Date.now()) {
  return [...smeltJobs.values()].find((j) => j.readyAt <= now) ?? null;
}

// Raw food the bot carries and could cook right now with its own fuel.
export function rawFoodToCook(bot) {
  const carried = carriedCounts(bot);
  const raw = RAW_FOOD.find((n) => carried.get(n));
  return raw && pickFuel(carried, 1, { exclude: raw }) ? raw : null;
}

export function smeltSummary(smeltJobs, now = Date.now()) {
  if (smeltJobs.size === 0) return null;
  const lines = [...smeltJobs.values()].map((j) => {
    const mins = Math.round((j.readyAt - now) / 60000);
    const when = j.readyAt <= now ? 'ready now' : mins < 1 ? 'ready in under a minute' : `ready in about ${mins} min`;
    return `${j.count} ${j.input} in the furnace at ${posText(j.pos)} (${when})`;
  });
  return `Your furnace jobs: ${lines.join('; ')}`;
}
