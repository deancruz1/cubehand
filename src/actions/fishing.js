import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, delay } from './util.js';
import { walkTo } from './movement.js';
import { gainedText, isWater } from './items.js';

const { GoalBlock } = pathfinderPkg.goals;

const MAX_MINUTES = 10;
const MAX_COUNT = 64;
const WATER_RANGE = 24;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// How long to wait, in ms: for a bite after a cast (the game takes 5 to 30 s, then the fish swims
// in), before checking where the bobber landed, and for a catch to fly in after reeling.
export const FISH_TIMES = { bite: 45000, land: 3000, arrive: 3000 };

const key = (p) => `${p.x},${p.y},${p.z}`;

function isOpen(block) {
  return Boolean(block) && block.boundingBox === 'empty' && !isWater(block) && block.name !== 'lava';
}

function isSurface(getBlock, p) {
  return getBlock(p)?.name === 'water' && isOpen(getBlock(p.offset(0, 1, 0)));
}

// Water surface blocks within range of the bot: water with open air right above.
function surfaces(bot, range) {
  const id = bot.registry.blocksByName.water?.id;
  if (id === undefined) return [];
  const getBlock = (p) => bot.blockAt(p, false);
  return bot.findBlocks({ matching: id, maxDistance: range, count: 2000 }).filter((p) => isSurface(getBlock, p));
}

// Where to stand and what to cast at, from water surface blocks: a dry spot on the bank right
// next to the water (never in it), and surface blocks 2 to 6 away from it to aim at, about 4 away
// first. Puddles are left out: only water with at least 6 surface blocks round it counts. Closest
// spot to here first, or null.
export function fishingSpot(getBlock, waters, here) {
  const set = new Set(waters.map(key));
  const wide = (w) => {
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (set.has(key(w.offset(dx, 0, dz)))) n++;
    return n;
  };
  const open = waters.filter((w) => wide(w) >= 6);
  const stands = new Map();
  for (const w of open) {
    for (const [dx, dz] of DIRS) {
      for (const rise of [1, 2]) {
        const feet = w.offset(dx, rise, dz);
        const below = getBlock(feet.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block' || isWater(below)) continue;
        if (!isOpen(getBlock(feet)) || !isOpen(getBlock(feet.offset(0, 1, 0)))) continue;
        stands.set(key(feet), feet);
        break;
      }
    }
  }
  const across = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const away = (p) => p.offset(0.5, 0, 0.5).distanceTo(here);
  const order = [...stands.values()].sort((a, b) => away(a) - away(b));
  for (const stand of order) {
    const targets = open
      .filter((w) => across(w, stand) >= 2 && across(w, stand) <= 6)
      .sort((a, b) => Math.abs(across(a, stand) - 4) - Math.abs(across(b, stand) - 4))
      .slice(0, 4);
    if (targets.length) return { stand, targets };
  }
  return null;
}

function counts(bot) {
  const map = new Map();
  for (const i of bot.inventory.items()) map.set(i.name, (map.get(i.name) ?? 0) + i.count);
  return map;
}

// Holds a fishing rod, taking one from the inventory if need be. False when she has none.
async function holdRod(bot) {
  if (bot.heldItem?.name === 'fishing_rod') return true;
  const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
  if (!rod) return false;
  try {
    await bot.equip(rod, 'hand');
  } catch {
    return false;
  }
  return bot.heldItem?.name === 'fishing_rod';
}

function nearestBobber(bot) {
  const here = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e.name === 'fishing_bobber' && e.position && e.position.distanceTo(here) <= 32)
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] ?? null;
}

// The bobber floats at the top of the water, so the block at it or just under it is water.
function onWater(bot, bobber) {
  return [0, -0.5].some((dy) => bot.blockAt(bobber.position.offset(0, dy, 0), false)?.name === 'water');
}

// Resolves with the first of: what promise gives, 'timeout' after ms, or 'stopped' when signal
// aborts.
function race(promise, ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('stopped');
    const stopped = () => finish('stopped');
    const timer = setTimeout(() => finish('timeout'), Math.max(ms, 0));
    function finish(value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stopped);
      resolve(value);
    }
    signal?.addEventListener('abort', stopped, { once: true });
    promise.then(finish);
  });
}

// Reels in a bobber still out, and waits a moment for it to go.
async function reelIn(bot, bite) {
  bot.activateItem();
  await race(bite, 1000);
}

// One cast at the water surface block aim. Mineflayer's bot.fish() casts, and on a bite reels in
// and resolves; it rejects when the bobber goes away (reeled in, or caught on something). A bobber
// that never bites keeps it waiting for good, so a cast with no bite in time is reeled in here.
// Returns 'caught', 'nothing' (reeled in on a bite, nothing came), 'dry' (it landed out of the
// water), 'gone', 'no bite' or 'stopped'.
async function cast(bot, aim, { signal, until }) {
  const before = counts(bot);
  await bot.lookAt(aim.offset(0.5, 1.5, 0.5), true);
  const bite = bot.fish().then(
    () => 'bite',
    () => 'gone'
  );
  let outcome = await race(bite, FISH_TIMES.land, signal);
  if (outcome === 'timeout') {
    const bobber = nearestBobber(bot);
    if (bobber && !onWater(bot, bobber)) {
      await reelIn(bot, bite);
      return 'dry';
    }
    outcome = await race(bite, Math.min(FISH_TIMES.bite, until - Date.now()), signal);
  }
  if (outcome === 'timeout' || outcome === 'stopped') {
    await reelIn(bot, bite);
    return outcome === 'stopped' ? 'stopped' : 'no bite';
  }
  if (outcome === 'gone') return 'gone';
  const end = Date.now() + FISH_TIMES.arrive;
  while (Date.now() < end) {
    if (gainedText(before, counts(bot))) return 'caught';
    await delay(100);
  }
  return 'nothing';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The fish tool: stands at the edge of open water nearby and casts until count catches or minutes
// pass (10 at most), then says what came in.
export async function fish(ctx, { count = 1, minutes } = {}) {
  const { bot, signal } = ctx;
  const want = Math.min(Math.max(count ?? 1, 1), MAX_COUNT);
  const limit = Math.min(minutes > 0 ? minutes : MAX_MINUTES, MAX_MINUTES);
  if (!bot.inventory.items().some((i) => i.name === 'fishing_rod') && bot.heldItem?.name !== 'fishing_rod') {
    return fail("I don't have a fishing rod");
  }
  const getBlock = (p) => bot.blockAt(p, false);
  const spot = fishingSpot(getBlock, surfaces(bot, WATER_RANGE), bot.entity.position);
  if (!spot) return fail(`no open water within ${WATER_RANGE} blocks with a dry bank to fish from`);
  const { stand } = spot;
  if (!bot.entity.position.floored().equals(stand)) {
    const walked = await walkTo(ctx, new GoalBlock(stand.x, stand.y, stand.z), { place: false });
    if (signal?.aborted) return fail('stopped before casting');
    if (!walked.ok) return fail(`could not get to the water's edge at ${posText(stand)}: ${walked.message}`);
  }
  if (bot.entity.isInWater || isWater(getBlock(bot.entity.position))) return fail(`ended up in the water at ${posText(bot.entity.position)} instead of on the bank`);

  const before = counts(bot);
  const until = Date.now() + limit * 60000;
  let caught = 0;
  let casts = 0;
  let dry = 0;
  let aim = 0;
  let why = null;
  let broke = false;
  while (caught < want) {
    if (signal?.aborted) {
      why = 'stopped';
      break;
    }
    if (Date.now() >= until) {
      why = `${plural(limit, 'minute')} went by`;
      break;
    }
    if (!(await holdRod(bot))) {
      why = casts ? 'my fishing rod broke' : "I couldn't hold my fishing rod";
      broke = casts > 0;
      break;
    }
    const result = await cast(bot, spot.targets[aim % spot.targets.length], { signal, until });
    casts++;
    if (result === 'stopped') {
      why = 'stopped';
      break;
    }
    if (result === 'caught') {
      caught++;
      dry = 0;
      ctx.status?.progress(`fishing: caught ${caught} of ${want} so far (${gainedText(before, counts(bot))})`);
    } else if (result === 'dry' || result === 'gone') {
      dry++;
      aim++;
      if (dry >= spot.targets.length * 2) {
        why = `the bobber kept landing out of the water from ${posText(stand)}`;
        break;
      }
    }
  }

  const got = gainedText(before, counts(bot));
  const tally = `${plural(casts, 'cast')} from ${posText(stand)}`;
  if (caught >= want) return ok(`caught ${got} in ${tally}`);
  if (got) return ok(`caught ${got} in ${tally}, ${caught} of the ${want} asked for. Stopped because ${why}`);
  if (broke) return ok(`caught nothing in ${tally}, then ${why}`);
  return fail(`caught nothing in ${tally}. Stopped because ${why}`);
}
