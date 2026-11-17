import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay, TimeoutError, AbortedError } from './util.js';
import { walkTo } from './movement.js';
import { findNearest, inReach } from './blocks.js';
import { openWindow } from './containers.js';

const { GoalLookAtBlock, GoalNear } = pathfinderPkg.goals;

const RANGE = 32;
const WATER_RANGE = 16;
const MAX_COUNT = 9;
// The stand's own slots: three bottles, the ingredient on top, blaze powder for fuel.
const BOTTLE_SLOTS = [0, 1, 2];
const INGREDIENT_SLOT = 3;
const FUEL_SLOT = 4;
// Window properties: brew time left in ticks (400 at the start), and fuel left (20 brews a powder).
const BREW_TIME = 0;
const FUEL = 1;
const BREWS_PER_POWDER = 20;

// How long to wait, in ms: for a brew to start once the ingredient is in, for one to finish (20 s
// in the game, with time to spare), and between looks at the stand.
export const BREW_TIMES = { start: 4000, step: 35000, tick: 1000 };

// The game's potion registry in order, which is how a bottle's potion_contents names its potion.
export const POTION_IDS = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness',
  'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness', 'turtle_master', 'long_turtle_master',
  'strong_turtle_master', 'water_breathing', 'long_water_breathing', 'healing', 'strong_healing', 'harming',
  'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested'
];

// from is the potion it is brewed from: awkward (nether wart in water) unless said, water itself,
// or another potion that the ingredient turns into this one. long and strong say whether redstone
// and glowstone dust work on it.
const RECIPES = {
  healing: { ingredient: 'glistering_melon_slice', strong: true },
  swiftness: { ingredient: 'sugar', long: true, strong: true },
  fire_resistance: { ingredient: 'magma_cream', long: true },
  night_vision: { ingredient: 'golden_carrot', long: true },
  water_breathing: { ingredient: 'pufferfish', long: true },
  strength: { ingredient: 'blaze_powder', long: true, strong: true },
  regeneration: { ingredient: 'ghast_tear', long: true, strong: true },
  slow_falling: { ingredient: 'phantom_membrane', long: true },
  poison: { ingredient: 'spider_eye', long: true, strong: true },
  leaping: { ingredient: 'rabbit_foot', long: true, strong: true },
  turtle_master: { ingredient: 'turtle_scute', long: true, strong: true },
  weakness: { from: 'water', ingredient: 'fermented_spider_eye', long: true },
  invisibility: { from: 'night_vision', ingredient: 'fermented_spider_eye', long: true },
  slowness: { from: 'swiftness', ingredient: 'fermented_spider_eye', long: true, strong: true },
  harming: { from: 'healing', ingredient: 'fermented_spider_eye', strong: true }
};

const ALIASES = {
  speed: 'swiftness', jump: 'leaping', jump_boost: 'leaping', instant_health: 'healing', health: 'healing',
  instant_damage: 'harming', damage: 'harming', fire_res: 'fire_resistance', turtle: 'turtle_master'
};

const words = (name) => name.replace(/_/g, ' ');

// "long potion of swiftness", "splash strong healing" and the like, as { name, long, strong,
// splash }, or null when it isn't a potion she knows.
export function parsePotion(text) {
  const flags = { long: false, strong: false, splash: false };
  const rest = [];
  for (const w of String(text ?? '').toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(Boolean)) {
    if (w === 'long' || w === 'extended') flags.long = true;
    else if (w === 'strong' || w === 'ii') flags.strong = true;
    else if (w === 'splash') flags.splash = true;
    else if (!['potion', 'potions', 'of', 'a', 'the'].includes(w)) rest.push(w);
  }
  const joined = rest.join('_');
  const name = ALIASES[joined] ?? joined;
  return RECIPES[name] ? { name, ...flags } : null;
}

// The steps from a water bottle to the potion, one ingredient each, with the potion it makes.
export function brewSteps({ name, long, strong, splash }) {
  const steps = [];
  const build = (n) => {
    const r = RECIPES[n];
    if (r.from && r.from !== 'water') build(r.from);
    else if (!r.from) steps.push({ ingredient: 'nether_wart', makes: 'awkward' });
    steps.push({ ingredient: r.ingredient, makes: n });
  };
  build(name);
  if (long) steps.push({ ingredient: 'redstone', makes: `long_${name}` });
  if (strong) steps.push({ ingredient: 'glowstone_dust', makes: `strong_${name}` });
  if (splash) steps.push({ ingredient: 'gunpowder', makes: steps.at(-1).makes, splash: true });
  return steps;
}

export function potionLabel(makes, splash = false) {
  if (!splash && makes === 'water') return 'water bottle';
  const kind = splash ? 'splash potion' : 'potion';
  if (['awkward', 'mundane', 'thick'].includes(makes)) return `${makes} ${kind}`;
  return `${kind} of ${words(makes)}`;
}

// What potion a bottle holds, from its potion_contents component, or null for anything else.
export function potionOf(item) {
  if (!item || !['potion', 'splash_potion', 'lingering_potion'].includes(item.name)) return null;
  const id = item.componentMap?.get('potion_contents')?.data?.potionId;
  return { makes: id == null ? 'unknown' : POTION_IDS[id] ?? `unknown (id ${id})`, splash: item.name === 'splash_potion' };
}

export function itemLabel(item) {
  const p = potionOf(item);
  return p ? potionLabel(p.makes, p.splash) : item.name;
}

const isWaterBottle = (item) => item.name === 'potion' && potionOf(item)?.makes === 'water';

function labelCounts(items) {
  const map = new Map();
  for (const i of items) map.set(itemLabel(i), (map.get(itemLabel(i)) ?? 0) + i.count);
  return map;
}

// "3 potions of swiftness", "2 water bottles", "1 awkward potion".
function countsText(map) {
  const many = (label) => label.replace(/^(splash )?potion of/, '$1potions of').replace(/ (potion|bottle)$/, ' $1s');
  return [...map].map(([name, n]) => `${n} ${n > 1 ? many(name) : name}`).join(', ');
}

function gained(before, after) {
  const map = new Map();
  for (const [name, n] of after) if (n > (before.get(name) ?? 0)) map.set(name, n - (before.get(name) ?? 0));
  return map;
}

function bottlesText(window) {
  const bottles = BOTTLE_SLOTS.map((s) => window.slots[s]).filter(Boolean);
  return bottles.length ? countsText(labelCounts(bottles)) : 'none';
}

// The last value of each window property the server sent, for the window open now.
function watchProperties(bot) {
  const seen = new Map();
  const on = (packet) => {
    if (!seen.has(packet.windowId)) seen.set(packet.windowId, new Map());
    seen.get(packet.windowId).set(packet.property, packet.value);
  };
  bot._client.on('craft_progress_bar', on);
  return { of: (window) => seen.get(window.id) ?? new Map(), stop: () => bot._client.removeListener('craft_progress_bar', on) };
}

async function openStand(ctx, pos, props) {
  const { bot } = ctx;
  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: false });
    if (!walked.ok && !inReach(bot, pos)) return { error: `could not get to the brewing stand at ${posText(pos)}: ${walked.message}` };
  }
  const block = bot.blockAt(pos, false);
  if (block?.name !== 'brewing_stand') return { error: `there's no brewing stand at ${posText(pos)}` };
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5)).catch(() => {});
  await pause(200, 450);
  let window;
  try {
    window = await openWindow(ctx, () => bot.openBlock(block));
  } catch (err) {
    if (err instanceof AbortedError) return { error: 'stopped' };
    if (err instanceof TimeoutError) return { error: `the brewing stand at ${posText(pos)} wouldn't open` };
    return { error: `could not open the brewing stand at ${posText(pos)}: ${err.message}` };
  }
  if (!String(window.type).includes('brewing')) {
    window.close();
    return { error: `the brewing stand at ${posText(pos)} opened as ${window.type}` };
  }
  // The brew time and fuel come just after the window does.
  const until = Date.now() + 1000;
  while (!props.of(window).has(FUEL) && Date.now() < until) await delay(50);
  return { window };
}

// Puts count of the inventory item (a window slot) into slot to: the whole stack with a left
// click, or one at a time with right clicks, then puts what's left back.
async function putIn(bot, window, item, to, count = item.count) {
  await bot.clickWindow(item.slot, 0, 0);
  if (count >= item.count) await bot.clickWindow(to, 0, 0);
  else for (let i = 0; i < count; i++) await bot.clickWindow(to, 1, 0);
  if (window.selectedItem) await bot.clickWindow(item.slot, 0, 0);
  if (window.slots[to]?.name !== item.name) throw new Error(`${item.name} did not go into the brewing stand`);
  await pause(100, 250);
}

async function takeOut(bot, window, slot) {
  if (!window.slots[slot]) return;
  const free = window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd);
  if (free === null) throw new Error('my inventory is full');
  await bot.clickWindow(slot, 0, 0);
  await bot.clickWindow(free, 0, 0);
  await pause(100, 250);
}

function findWater(bot) {
  const id = bot.registry.blocksByName.water?.id;
  if (id === undefined) return null;
  return bot
    .findBlocks({ matching: id, maxDistance: WATER_RANGE, count: 64 })
    .filter((p) => {
      const block = bot.blockAt(p, false);
      const above = bot.blockAt(p.offset(0, 1, 0), false);
      return Number(block?.getProperties?.().level ?? 0) === 0 && above?.boundingBox === 'empty' && above.name !== 'water';
    })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] ?? null;
}

const waterBottles = (bot) => bot.inventory.items().filter(isWaterBottle).length;

// Fills glass bottles at the water source by using them on it. Returns how many got filled.
async function fillBottles(ctx, water, n) {
  const { bot, signal } = ctx;
  const near = () => bot.entity.position.distanceTo(water.offset(0.5, 0.5, 0.5)) <= 4;
  if (!near()) {
    const walked = await walkTo(ctx, new GoalNear(water.x, water.y + 1, water.z, 3), { place: false });
    if (!walked.ok && !near()) return 0;
  }
  let filled = 0;
  while (filled < n && !signal?.aborted) {
    const glass = bot.inventory.items().find((i) => i.name === 'glass_bottle');
    if (!glass) break;
    await bot.equip(glass, 'hand');
    await bot.lookAt(water.offset(0.5, 0.9, 0.5), true);
    const before = waterBottles(bot);
    bot.activateItem();
    const until = Date.now() + 1500;
    while (waterBottles(bot) <= before && Date.now() < until) await delay(100);
    if (waterBottles(bot) <= before) break;
    filled++;
    await pause(150, 300);
  }
  return filled;
}

// Waits at the open stand for one brew. Null when the ingredient was used and the bottles changed,
// otherwise why not.
async function waitForBrew(ctx, window, props, step, where) {
  const { signal } = ctx;
  const before = BOTTLE_SLOTS.map((s) => JSON.stringify(potionOf(window.slots[s])));
  const startBy = Date.now() + BREW_TIMES.start;
  const end = Date.now() + BREW_TIMES.step;
  let started = false;
  while (Date.now() < end) {
    if (signal?.aborted) return 'stopped';
    await delay(BREW_TIMES.tick);
    const ticks = props.of(window).get(BREW_TIME) ?? 0;
    if (ticks > 0) started = true;
    const changed = BOTTLE_SLOTS.every((s, i) => !window.slots[s] || JSON.stringify(potionOf(window.slots[s])) !== before[i]);
    if (!window.slots[INGREDIENT_SLOT] && changed) return null;
    if (!started && Date.now() > startBy) {
      if (!(props.of(window).get(FUEL) > 0) && !window.slots[FUEL_SLOT]) return 'the stand has no fuel';
      return `${step.ingredient} does nothing to ${bottlesText(window)}`;
    }
    ctx.status?.progress(`brewing at ${where}: ${step.ingredient} in, ${Math.ceil(ticks / 20)} s left`);
  }
  return 'it took longer than expected';
}

// The brew tool: brews count bottles (up to 9, three at a time) of the potion at the stand at
// x y z or the nearest one, a step at a time, after checking she has everything for the whole
// chain. It never makes or fetches what's missing. With wait false it loads the first step and
// leaves it brewing; brew again with the same potion carries on from what is in the stand.
export async function brew(ctx, { potion, count = 3, x, y, z, wait = true }) {
  const { bot, signal } = ctx;
  const wanted = parsePotion(potion);
  if (!wanted) return fail(`I don't know a potion called "${potion}". I can brew ${Object.keys(RECIPES).map(words).join(', ')}, with long, strong or splash in front`);
  const recipe = RECIPES[wanted.name];
  if (wanted.long && wanted.strong) return fail('a potion can be long or strong, not both');
  if (wanted.long && !recipe.long) return fail(`there's no long potion of ${words(wanted.name)}`);
  if (wanted.strong && !recipe.strong) return fail(`there's no strong potion of ${words(wanted.name)}`);
  const steps = brewSteps(wanted);
  const goal = potionLabel(steps.at(-1).makes, wanted.splash);
  const n = Math.min(Math.max(count ?? 3, 1), MAX_COUNT);

  const given = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : null;
  const pos = given ?? findNearest(bot, (name) => name === 'brewing_stand', RANGE)[0];
  if (!pos) return fail(`no brewing stand within ${RANGE} blocks`);
  const where = `the brewing stand at ${posText(pos)}`;

  const props = watchProperties(bot);
  const before = labelCounts(bot.inventory.items());
  let window = null;
  // Only what she put in or carried on with comes back out; a player's bottles stay.
  let touched = false;
  let leave = false;
  let problem = null;
  try {
    const opened = await openStand(ctx, pos, props);
    if (opened.error) return fail(opened.error);
    window = opened.window;
    if (window.slots[INGREDIENT_SLOT] || (props.of(window).get(BREW_TIME) ?? 0) > 0) {
      return fail(`${where} is busy brewing ${bottlesText(window)}${window.slots[INGREDIENT_SLOT] ? ` with ${window.slots[INGREDIENT_SLOT].name}` : ''}`);
    }

    // Bottles left in the stand are carried on from the step they're at, when they're on the way.
    const batches = [];
    const inStand = BOTTLE_SLOTS.map((s) => window.slots[s]).filter(Boolean);
    if (inStand.length) {
      const at = steps.findLastIndex((s) => inStand.every((b) => potionOf(b)?.makes === s.makes && potionOf(b).splash === Boolean(s.splash)));
      if (at < 0) return fail(`${where} holds ${bottlesText(window)}, which isn't on the way to ${goal}. Take them out first`);
      batches.push({ size: inStand.length, from: at + 1, inStand: true });
    }
    let fresh = Math.max(0, n - inStand.length);
    while (fresh > 0) {
      batches.push({ size: Math.min(3, fresh), from: 0 });
      fresh -= 3;
    }

    // Everything the whole chain takes, checked before anything goes in.
    const need = new Map();
    let brews = 0;
    for (const b of batches) {
      for (const s of steps.slice(b.from)) {
        need.set(s.ingredient, (need.get(s.ingredient) ?? 0) + 1);
        brews++;
      }
    }
    const fuelItem = window.slots[FUEL_SLOT];
    const fuelHas = (props.of(window).get(FUEL) ?? 0) + (fuelItem?.name === 'blaze_powder' ? fuelItem.count * BREWS_PER_POWDER : 0);
    const powderForFuel = Math.ceil(Math.max(0, brews - fuelHas) / BREWS_PER_POWDER);
    if (powderForFuel) need.set('blaze_powder', (need.get('blaze_powder') ?? 0) + powderForFuel);
    const carried = new Map();
    for (const i of bot.inventory.items()) carried.set(i.name, (carried.get(i.name) ?? 0) + i.count);
    const short = [];
    for (const [item, k] of need) {
      const have = carried.get(item) ?? 0;
      if (have < k) short.push(`${k - have} ${item}${item === 'blaze_powder' && powderForFuel ? ` (${powderForFuel} of it for fuel)` : ''}`);
    }
    const bottlesNeeded = batches.filter((b) => !b.inStand).reduce((sum, b) => sum + b.size, 0);
    const toFill = Math.max(0, bottlesNeeded - waterBottles(bot));
    const water = toFill ? findWater(bot) : null;
    if (toFill > (carried.get('glass_bottle') ?? 0)) short.push(`${toFill - (carried.get('glass_bottle') ?? 0)} water bottles (or glass bottles to fill)`);
    else if (toFill && !water) short.push(`water within ${WATER_RANGE} blocks to fill ${toFill} glass bottles`);
    if (short.length) return fail(`can't brew ${n} ${goal} at ${where} yet. Short of: ${short.join(', ')}. Get them with obtain, then brew again`);

    if (toFill) {
      window.close();
      window = null;
      const filled = await fillBottles(ctx, water, toFill);
      if (filled < toFill) return fail(signal?.aborted ? 'stopped while filling bottles' : `could only fill ${filled} of ${toFill} glass bottles at the water at ${posText(water)}`);
      const again = await openStand(ctx, pos, props);
      if (again.error) return fail(again.error);
      window = again.window;
    }

    touched = true;
    if (powderForFuel) {
      const powder = window.items().find((i) => i.name === 'blaze_powder');
      await putIn(bot, window, powder, FUEL_SLOT, powderForFuel);
    }

    let made = 0;
    for (const batch of batches) {
      if (!batch.inStand) {
        const bottles = window.items().filter(isWaterBottle).slice(0, batch.size);
        for (let i = 0; i < bottles.length; i++) await putIn(bot, window, bottles[i], BOTTLE_SLOTS[i]);
      }
      for (let i = batch.from; i < steps.length; i++) {
        if (signal?.aborted) {
          problem = 'stopped';
          break;
        }
        const step = steps[i];
        const item = window.items().find((it) => it.name === step.ingredient);
        if (!item) {
          problem = `no ${step.ingredient} left`;
          break;
        }
        await putIn(bot, window, item, INGREDIENT_SLOT, 1);
        if (!wait) {
          leave = true;
          const next = steps.slice(i + 1).map((s) => s.ingredient);
          const later = next.length ? `Still to add after it, one at a time: ${next.join(', ')}.` : "That's the last step.";
          const more = n > batch.size ? ` ${n - batch.size} more bottles after these.` : '';
          return ok(`put ${bottlesText(window)} and ${step.ingredient} in ${where}. In about 20 s they will be ${potionLabel(step.makes, step.splash)}. ${later}${more} Run brew with the same potion again to carry on`);
        }
        problem = await waitForBrew(ctx, window, props, step, where);
        if (problem) {
          problem = `${problem} (at the ${step.ingredient} step)`;
          break;
        }
        ctx.status?.progress(`brewing at ${where}: ${bottlesText(window)} now`);
      }
      if (problem) break;
      made += batch.size;
      for (const s of BOTTLE_SLOTS) await takeOut(bot, window, s);
    }
    if (problem) {
      const now = bottlesText(window);
      for (const s of [...BOTTLE_SLOTS, INGREDIENT_SLOT]) await takeOut(bot, window, s).catch(() => {});
      const got = countsText(gained(before, labelCounts(bot.inventory.items())));
      return fail(`stopped brewing ${goal}: ${problem}. The bottles are now ${now}, back in my inventory${got && made ? `. Made before that: ${got}` : ''}`);
    }
    const got = countsText(gained(before, labelCounts(bot.inventory.items())));
    return got ? ok(`brewed ${got} at ${where}`) : fail(`nothing came out of ${where}`);
  } catch (err) {
    return fail(`brewing went wrong at ${where}: ${err.message}`);
  } finally {
    props.stop();
    if (window) {
      if (touched && !leave) {
        for (const s of [...BOTTLE_SLOTS, INGREDIENT_SLOT]) await takeOut(bot, window, s).catch(() => {});
      }
      await pause(200, 400);
      window.close();
    }
  }
}
