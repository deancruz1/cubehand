import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, delay, guarded, customName } from './actions/util.js';
import { isHostile, isBaby, attackEntity, takeShield } from './actions/combat.js';
import { useMoveMode } from './actions/movement.js';
import { findNearest } from './actions/blocks.js';
import { isPickable, withContainer } from './actions/containers.js';
import { isWater } from './actions/items.js';

const { GoalXZ, GoalFollow } = pathfinderPkg.goals;

const NEVER_EAT = new Set(['pufferfish', 'poisonous_potato', 'spider_eye', 'suspicious_stew', 'chorus_fruit']);
const RISKY = new Set(['rotten_flesh', 'chicken']);
const PRECIOUS = new Set(['golden_apple', 'enchanted_golden_apple']);
const GAME = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin']);
const DEADLY = new Set(['warden', 'wither', 'ender_dragon', 'creaking']);
const PEN = /_(fence|fence_gate|wall)$/;

const quality = (f) => f.effectiveQuality ?? f.foodPoints + f.saturation;

// The best food to eat from items. Risky food only when starving, golden apples only when
// close to dying.
export function pickFood(foods, items, { starving = false, critical = false } = {}) {
  return (
    items
      .filter((i) => foods[i.name] && !NEVER_EAT.has(i.name))
      .filter((i) => starving || !RISKY.has(i.name))
      .filter((i) => critical || !PRECIOUS.has(i.name))
      .sort((a, b) => quality(foods[b.name]) - quality(foods[a.name]))[0] ?? null
  );
}

export function hasFood(bot) {
  return pickFood(bot.registry.foodsByName, bot.inventory.items(), { starving: bot.food <= 4 }) !== null;
}

// Hungry, or hurt and not full enough for health to come back on its own.
export function needsFood(bot, eatAt = 14) {
  return bot.food < 20 && (bot.food <= eatAt || (bot.health <= 14 && bot.food < 18));
}

// Eats the best food carried and goes back to holding what it held. Returns the food's name.
export async function eatBest(bot, { critical = false } = {}) {
  if (bot.food >= 20) return null;
  const item = pickFood(bot.registry.foodsByName, bot.inventory.items(), { starving: bot.food <= 4, critical });
  if (!item) return null;
  const held = bot.heldItem?.name;
  try {
    await bot.equip(item, 'hand');
    await guarded(() => bot.consume(), { ms: 5000 });
  } catch {
    return null;
  }
  const back = held && held !== item.name ? bot.inventory.items().find((i) => i.name === held) : null;
  if (back) await bot.equip(back, 'hand').catch(() => {});
  return item.name;
}

// Hostile mobs the bot may fight on its own. Bosses, the warden and the creaking are never
// fought unless named, but threatsNear still counts them, so recovery backs off from them.
export function isThreat(entity) {
  return isHostile(entity) && !NEUTRAL.has(entity.name) && !DEADLY.has(entity.name);
}

export function isDeadly(entity) {
  return DEADLY.has(entity.name);
}

export function threatsNear(bot, radius) {
  const here = bot.entity.position;
  return Object.values(bot.entities).filter(
    (e) => e !== bot.entity && e.position && (isThreat(e) || isDeadly(e)) && Math.abs(e.position.y - here.y) <= 4 && e.position.distanceTo(here) <= radius
  );
}

// Runs the other way from the threats for a few seconds, with a shield she carries in the off
// hand. It stays down: running, she faces away from them.
export async function flee(ctx, threats, distance = 16) {
  const shield = await takeShield(ctx.bot);
  try {
    await runAway(ctx, threats, distance);
  } finally {
    await shield?.restore();
  }
}

async function runAway(ctx, threats, distance) {
  const { bot } = ctx;
  const here = bot.entity.position;
  let dx = 0;
  let dz = 0;
  for (const t of threats) {
    const len = Math.hypot(here.x - t.position.x, here.z - t.position.z) || 1;
    dx += (here.x - t.position.x) / len;
    dz += (here.z - t.position.z) / len;
  }
  const len = Math.hypot(dx, dz) || 1;
  useMoveMode(bot, false);
  const goal = new GoalXZ(Math.floor(here.x + (dx / len) * distance), Math.floor(here.z + (dz / len) * distance));
  await guarded(() => bot.pathfinder.goto(goal), { ms: 10000, signal: ctx.signal, onCancel: () => bot.pathfinder.setGoal(null) }).catch(() => {});
}

// Mineflayer's oxygenLevel runs 0 to 20 (the game's air supply divided by 15, so 0.75 s a point).
// Below this with her head under water she heads for air, with time left to swim to it.
const LOW_AIR = 14;
// Once she has her head out, a dip back under only counts again at or below this, or after
// AIR_QUIET_MS, so bobbing at the surface doesn't stop her job over and over.
const URGENT_AIR = 6;
const AIR_QUIET_MS = 4000;
const FIRE = new Set(['fire', 'soul_fire']);

export function headBlock(bot) {
  const e = bot.entity;
  return bot.blockAt(e.position.offset(0, e.eyeHeight ?? 1.62, 0), false);
}

// The burning flag is bit 1 of shared_flags, entity metadata key 0.
export function onFire(entity) {
  return Boolean((entity?.metadata?.[0] ?? 0) & 1);
}

// Air, water, plants and the like: nothing to stand on or bump into, and safe to be in.
function isOpen(block) {
  return Boolean(block) && block.boundingBox === 'empty' && !isWater(block) && block.name !== 'lava' && !FIRE.has(block.name);
}

// Somewhere a body fits while swimming: water or open, never lava.
function swimmable(block) {
  return Boolean(block) && block.boundingBox === 'empty' && block.name !== 'lava';
}

// What she has to get out of now, or null: 'lava', 'air' (head under water and air low, or hurt
// while under), 'fire' (standing in it) or 'burning' (on fire out of water). With strict, any
// time her head is under counts as 'air', and being in water at all as 'water'.
export function hazard(bot, { hurt = false, strict = false } = {}) {
  const e = bot.entity;
  if (!e?.position || !bot.blockAt) return null;
  const feet = bot.blockAt(e.position, false);
  const head = headBlock(bot);
  if (e.isInLava || feet?.name === 'lava' || head?.name === 'lava') return 'lava';
  if (isWater(head) && (strict || hurt || (bot.oxygenLevel ?? 20) <= LOW_AIR)) return 'air';
  if (FIRE.has(feet?.name) || FIRE.has(head?.name)) return 'fire';
  if (onFire(e) && !e.isInWater && !isWater(feet)) return 'burning';
  if (strict && (e.isInWater || isWater(feet))) return 'water';
  return null;
}

const NEIGHBOURS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1], [0, -1, 0]];

// The shortest swim from head (the block her head is in) to a block with air, as the head
// positions along the way, or null. Her feet go one below her head, so both must fit. Ice or any
// other solid block overhead is no way out, so this goes round it to a hole or the shore.
export function swimPath(getBlockAt, head, { radius = 10, up = 12, down = 4 } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const seen = new Map();
  const getBlock = (p) => {
    const k = key(p);
    if (!seen.has(k)) seen.set(k, getBlockAt(p));
    return seen.get(k);
  };
  const fits = (p) => swimmable(getBlock(p)) && swimmable(getBlock(p.offset(0, -1, 0)));
  const from = new Map([[key(head), null]]);
  const queue = [head];
  for (let i = 0; i < queue.length && i < 20000; i++) {
    const p = queue[i];
    if (isOpen(getBlock(p))) {
      const path = [];
      for (let at = p; at; at = from.get(key(at))) path.unshift(at);
      return path;
    }
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const next = p.offset(dx, dy, dz);
      if (Math.hypot(next.x - head.x, next.z - head.z) > radius || next.y > head.y + up || next.y < head.y - down) continue;
      if (from.has(key(next)) || !fits(next)) continue;
      // No cutting a corner through a solid block.
      if (dx && dz && (!fits(p.offset(dx, 0, 0)) || !fits(p.offset(0, 0, dz)))) continue;
      from.set(key(next), p);
      queue.push(next);
    }
  }
  return null;
}

// Places to stand within radius of feet, closest first: something solid underneath and room for
// her whole body out of water, lava and fire. Swimming at the top, her feet are over a block
// under the surface, so a bank level with it is 2 up.
export function standSpots(getBlock, feet, radius = 6) {
  const spots = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const across = Math.hypot(dx, dz);
      if (across > radius) continue;
      for (const dy of [0, 1, 2, -1]) {
        const p = feet.offset(dx, dy, dz);
        const below = getBlock(p.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block' || below.name === 'magma_block') continue;
        if (!isOpen(getBlock(p)) || !isOpen(getBlock(p.offset(0, 1, 0)))) continue;
        spots.push({ pos: p, cost: across + Math.abs(dy) / 2 });
      }
    }
  }
  return spots.sort((a, b) => a.cost - b.cost).map((s) => s.pos);
}

// Water with air above it within radius of feet, closest first, to put a fire out in.
export function waterSpots(getBlock, feet, radius = 6) {
  const spots = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const across = Math.hypot(dx, dz);
      if (across > radius) continue;
      for (let dy = -2; dy <= 1; dy++) {
        const p = feet.offset(dx, dy, dz);
        const block = getBlock(p);
        if (!isWater(block) || block.boundingBox !== 'empty' || !isOpen(getBlock(p.offset(0, 1, 0)))) continue;
        spots.push({ pos: p, cost: across + Math.abs(dy) });
      }
    }
  }
  return spots.sort((a, b) => a.cost - b.cost).map((s) => s.pos);
}

// Heads straight for each block in path in turn (feet or head positions, as at() reads them),
// holding jump to swim up or climb out, until done() or ms runs out. Returns done().
async function steer(bot, path, done, { ms = 8000, at = (p) => p, signal } = {}) {
  const until = Date.now() + ms;
  let step = 0;
  try {
    while (Date.now() < until && !signal?.aborted && bot.entity && !done()) {
      const here = at(bot.entity.position).floored();
      const reached = path.findIndex((p, i) => i >= step && p.equals(here));
      if (reached >= 0) step = Math.min(reached + 1, path.length - 1);
      const target = path[step];
      const pos = bot.entity.position;
      const dx = target.x + 0.5 - pos.x;
      const dz = target.z + 0.5 - pos.z;
      const far = Math.hypot(dx, dz) > 0.3;
      if (far) bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {});
      bot.setControlState('forward', far);
      bot.setControlState('sprint', false);
      // Sinking is how she goes down; holding jump everywhere else keeps her rising.
      bot.setControlState('jump', target.y >= here.y);
      await delay(50);
    }
    return done();
  } finally {
    bot.clearControlStates();
  }
}

const eyes = (bot) => (p) => p.offset(0, bot.entity.eyeHeight ?? 1.62, 0);

// Breaks the solid block over her head (ice, usually) with the best tool she has. Slow under water.
async function breakOverhead(bot) {
  const head = headBlock(bot);
  const block = head && bot.blockAt(head.position.offset(0, 1, 0), false);
  if (!block || block.boundingBox !== 'block' || !bot.canDigBlock?.(block)) return false;
  const tool = bot.pathfinder?.bestHarvestTool?.(block);
  if (tool) await bot.equip(tool, 'hand').catch(() => {});
  try {
    await guarded(() => bot.dig(block, true), { ms: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Where her feet are when she floats at the top of the water over feet. A bank is looked for from
// there, since one level with the water is out of reach of the search from a block or two down.
export function floatingFeet(getBlock, feet) {
  let p = feet;
  for (let i = 0; i < 12 && isWater(getBlock(p.offset(0, 2, 0))); i++) p = p.offset(0, 1, 0);
  return p;
}

async function toLand(bot, getBlock) {
  const spot = standSpots(getBlock, floatingFeet(getBlock, bot.entity.position.floored()), 12)[0];
  if (!spot) return null;
  const e = bot.entity;
  const out = await steer(bot, [spot], () => e.onGround && !e.isInWater && !e.isInLava, { ms: 12000 });
  return out ? `got out onto ${getBlock(spot.offset(0, -1, 0))?.name ?? 'land'} at ${posText(e.position)}` : null;
}

async function toWater(bot, getBlock) {
  const spot = waterSpots(getBlock, bot.entity.position.floored())[0];
  if (!spot) return null;
  const e = bot.entity;
  const out = await steer(bot, [spot], () => e.isInWater || !onFire(e), { ms: 5000 });
  return out ? `put the fire out in the water at ${posText(spot)}` : null;
}

// Gets her out of danger (see hazard) as far as she can. Returns what she did, as a phrase.
export async function getOut(bot, danger, { signal } = {}) {
  const getBlock = (p) => bot.blockAt(p, false);
  const e = bot.entity;
  const done = [];
  if (danger === 'air') {
    let path = swimPath(getBlock, headBlock(bot).position);
    if (!path && (await breakOverhead(bot))) {
      done.push('broke the block overhead');
      path = swimPath(getBlock, headBlock(bot).position);
    }
    if (!path) return [...done, 'found no way up to air within 10 blocks'].join(', then ');
    const up = await steer(bot, path, () => !isWater(headBlock(bot)), { ms: 15000, at: eyes(bot), signal });
    if (!up) return [...done, `could not get up to air from ${posText(e.position)}`].join(', then ');
    done.push(`swam up to air at ${posText(e.position)}`);
  }
  if (danger === 'lava' || danger === 'fire') {
    const spot = standSpots(getBlock, e.position.floored(), 4)[0];
    const clear = () => !e.isInLava && !FIRE.has(getBlock(e.position)?.name) && getBlock(e.position)?.name !== 'lava';
    const out = spot && (await steer(bot, [spot], () => clear() && e.onGround, { signal }));
    if (!out) return `could not find a way out of the ${danger === 'lava' ? 'lava' : 'fire'} at ${posText(e.position)}`;
    done.push(`got out of the ${danger === 'lava' ? 'lava' : 'fire'} at ${posText(e.position)}`);
  }
  if (danger === 'air' || danger === 'water') {
    if (!signal?.aborted && (e.isInWater || isWater(getBlock(e.position)))) {
      const land = await toLand(bot, getBlock);
      done.push(land ?? 'found nothing solid close by to climb onto');
    }
  } else if (!signal?.aborted && onFire(e) && !e.isInWater) {
    const water = await toWater(bot, getBlock);
    if (water) done.push(water);
    else if (danger === 'burning') done.push('found no water close by to put the fire out');
  }
  return done.join(', then ');
}

const DANGER = {
  air: 'Your air ran low under water',
  water: 'You were in water',
  lava: 'You were in lava',
  fire: 'You were standing in fire',
  burning: 'You were on fire'
};

// What a held job is told when it carries on after getting out of danger.
export function escapeReport(danger, what, { health, position }) {
  const where = position ? `, and you're at ${posText(position)}` : '';
  return `${DANGER[danger]}, so you stopped to get out. You ${what}. Health is now ${Math.round(health)}/20${where}.`;
}

function inPen(bot, entity) {
  const p = entity.position.floored();
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const name = bot.blockAt(p.offset(dx, dy, dz), false)?.name;
        if (name && PEN.test(name)) return true;
      }
    }
  }
  return false;
}

// Wild animals worth hunting for food: grown, no name tag, not in a pen, and never the last two
// grown ones of their kind around, so they can still breed.
export function preyNear(bot, radius = 24) {
  const here = bot.entity.position;
  const animals = Object.values(bot.entities).filter(
    (e) => GAME.has(e.name) && e.position && e.position.distanceTo(here) <= radius && !customName(e) && !isBaby(bot, e)
  );
  return animals
    .filter((e) => animals.filter((o) => o.name === e.name).length > 2 && !inPen(bot, e))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
}

function foodCount(bot) {
  const foods = bot.registry.foodsByName;
  return bot.inventory.items().filter((i) => foods[i.name]).reduce((sum, i) => sum + i.count, 0);
}

// Gets food the way a player would: from a chest nearby first, then by hunting a wild animal.
// Returns what it got, or null.
export async function getFood(ctx) {
  const { bot } = ctx;
  for (const pos of findNearest(bot, isPickable, 32, 4)) {
    if (ctx.signal?.aborted) return null;
    const taken = await withContainer(ctx, pos, async (window) => {
      const food = pickFood(bot.registry.foodsByName, window.containerItems());
      if (!food) return fail('no food');
      const n = Math.min(food.count, 8);
      await window.withdraw(food.type, null, n);
      return ok(`${n} ${food.name} from the chest at ${posText(pos)}`);
    });
    if (taken.ok) return taken.message;
  }
  for (const prey of preyNear(bot).slice(0, 3)) {
    if (ctx.signal?.aborted) return null;
    const before = foodCount(bot);
    const result = await attackEntity(ctx, prey, { minHealth: 2 });
    if (foodCount(bot) > before) return `hunted a ${prey.name}`;
    if (result === 'stopped' || result === 'low health') return null;
  }
  return null;
}

// "zombie, zombie, skeleton" as "2 zombie and skeleton".
function counted(names) {
  return [...new Set(names)].map((name) => {
    const n = names.filter((other) => other === name).length;
    return n > 1 ? `${n} ${name}` : name;
  }).join(' and ');
}

// What a held job is told when it carries on after recovering.
export function recoveryReport({ critical, before, done, health, food, position }) {
  const why = critical ? `Your health got down to ${before.health}/20` : `You were starving (food ${before.food}/20)`;
  const what = done.length ? ` You ${done.join(', then ')}.` : '';
  const where = position ? `, and you're at ${posText(position)}` : '';
  return `${why}, so you stopped to look after yourself.${what} Health is now ${Math.round(health)}/20 and food ${food}/20${where}.`;
}

// Watches health and food. When health gets critical, or food runs out with nothing to eat
// mid-job, the job is put on hold: get away from danger, eat or find food, then the job carries
// on with an account of what happened.
export class Survival {
  constructor({ getBot, brain, config, makeCtx, log, say, stopChores }) {
    this.getBot = getBot;
    this.brain = brain;
    this.config = config;
    this.makeCtx = makeCtx;
    this.log = log;
    this.say = say;
    this.stopChores = stopChores;
    this.recovering = false;
    this.retryAt = 0;
    this.lastHealth = 20;
    this.seenHealth = 20;
    this.escaping = null;
    this.quietUntil = {};
    this.treading = false;
  }

  start() {
    this.timer = setInterval(() => this.check(), 1000);
  }

  // While the connection is down, getBot() still hands back the old bot, so it's left alone.
  offline() {
    return this.brain.holds?.has('offline') ?? false;
  }

  // Between steps of a job no tool is running, so eating can't get in the way of anything.
  async eatIfHungry() {
    const bot = this.getBot();
    if (!bot?.entity || this.offline() || this.recovering || !needsFood(bot, this.config.survival.eatAtFood)) return;
    const ate = await eatBest(bot);
    if (ate) this.log(`[survival] ate ${ate}, food ${bot.food}/20, health ${Math.round(bot.health)}/20`);
  }

  // Air changes come in as their own event, sooner than the once-a-second check.
  listen(bot) {
    if (this.listening === bot || typeof bot.on !== 'function') return;
    this.listening = bot;
    bot.on('breath', () => this.check());
  }

  check() {
    const bot = this.getBot();
    if (!bot?.entity || this.offline() || bot.isSleeping || bot.health <= 0) return;
    this.listen(bot);
    const hurt = bot.health < this.seenHealth;
    this.seenHealth = bot.health;
    if (this.escaping) return;
    const danger = hazard(bot, { hurt });
    if (danger && !this.quiet(danger, bot, hurt)) {
      this.escape(bot, danger).catch((err) => this.log(`[survival] ${err.message}`));
      return;
    }
    this.tread(bot);
    if (this.recovering) return;
    const critical = bot.health <= this.config.survival.criticalHealth;
    const starving = bot.food <= 6 && !hasFood(bot);
    if (!critical && !starving) return;
    // Between jobs the idle routine finds food on its own.
    if (!critical && !this.brain.busy) return;
    // After a try that didn't help, wait unless things got worse.
    if (Date.now() < this.retryAt && bot.health > this.lastHealth - 2) return;
    this.recover(bot, critical).catch((err) => this.log(`[survival] ${err.message}`));
  }

  // A danger she couldn't get away from last time (no water for a fire, no land to climb onto)
  // is left alone for a few seconds, so she doesn't spin on it. So is her head dipping under again
  // right after she got it out, unless she is hurt there or her air is nearly gone.
  quiet(danger, bot, hurt = false) {
    if (danger === 'air' && (hurt || (bot?.oxygenLevel ?? 20) <= URGENT_AIR)) return false;
    return Date.now() < (this.quietUntil[danger] ?? 0);
  }

  // With her head under water and nothing steering her, she holds jump the way a player holds
  // space, so she stays at the surface while a tool places or digs instead of sinking until her
  // air runs low. She lets go once she stands or is out of the water.
  tread(bot) {
    const e = bot.entity;
    if (!e?.position || !bot.blockAt) return;
    const wet = e.isInWater || isWater(bot.blockAt(e.position, false));
    const steered = Boolean(bot.vehicle) || Boolean(bot.pathfinder?.isMoving?.());
    if (!isWater(headBlock(bot)) && !(this.treading && wet && !e.onGround)) {
      if (this.treading && !steered) bot.setControlState?.('jump', false);
      this.treading = false;
      return;
    }
    if (steered) return;
    this.treading = true;
    bot.setControlState?.('jump', true);
  }

  // Getting out of water, lava or fire comes before everything else. The running tool and chores
  // are told to stop but not waited for, and a step of a recovery under way is cut short.
  async escape(bot, danger) {
    const own = !this.recovering;
    this.log(`[survival] ${danger}: health ${Math.round(bot.health)}/20, air ${bot.oxygenLevel ?? 20}/20, at ${posText(bot.entity.position)}`);
    if (own) {
      Promise.resolve(this.stopChores?.()).catch(() => {});
      Promise.resolve(this.brain.pause('hazard')).catch(() => {});
    }
    this.step?.abort();
    bot.pathfinder?.setGoal?.(null);
    let what = '';
    this.escaping = getOut(bot, danger);
    try {
      what = await this.escaping;
      this.log(`[survival] ${what}`);
      const e = bot.entity;
      if (onFire(e) && !e.isInWater) this.quietUntil.burning = Date.now() + 8000;
      if (e.isInWater || isWater(bot.blockAt(e.position, false))) {
        this.quietUntil.water = Date.now() + 10000;
        // Still in the water with nowhere to climb out: stay up, and don't count the next dip.
        if (!isWater(headBlock(bot))) this.quietUntil.air = Date.now() + AIR_QUIET_MS;
        this.treading = true;
        bot.setControlState?.('jump', true);
      }
      if (!own && what && this.notes?.at(-1) !== what) this.notes?.push(what);
      return what;
    } finally {
      this.escaping = null;
      if (own) this.brain.resume('hazard', escapeReport(danger, what || 'did not get out', { health: bot.health, position: bot.entity?.position }));
    }
  }

  // Waits out an escape already going, then gets out of any water, lava or fire still around her.
  // Recovery does this between steps, so it never stands still in them.
  async getClear(bot) {
    if (this.escaping) await this.escaping.catch(() => {});
    const danger = hazard(bot, { strict: true });
    if (danger && !this.quiet(danger)) await this.escape(bot, danger).catch((err) => this.log(`[survival] ${err.message}`));
  }

  // A context for one step of a recovery, which an escape can cut short.
  stepCtx() {
    this.step = new AbortController();
    return this.makeCtx(this.step.signal);
  }

  async recover(bot, critical) {
    this.recovering = true;
    const { criticalHealth } = this.config.survival;
    const goal = bot.pathfinder.goal;
    const follow = goal instanceof GoalFollow ? goal : null;
    const before = { health: Math.round(bot.health), food: bot.food };
    const done = [];
    this.notes = done;
    try {
      this.log(`[survival] ${critical ? 'low health' : 'starving'}: health ${Math.round(bot.health)}/20, food ${bot.food}/20`);
      this.say(critical ? "I'm hurt, backing off to heal." : "I'm starving, getting some food first.", this.brain.replyTo ?? null);
      // Under water there's no time to wait for the job to stop first.
      const stopping = Promise.all([this.stopChores?.(), this.brain.pause('danger')]);
      await this.getClear(bot);
      await stopping;

      const fled = new Map();
      for (let i = 0; i < 2; i++) {
        const threats = threatsNear(bot, 10);
        if (threats.length === 0) break;
        for (const t of threats) fled.set(t.id, t.name);
        await flee(this.stepCtx(), threats);
        await this.getClear(bot);
      }
      if (fled.size) done.push(`backed off from ${counted([...fled.values()])}`);
      const eaten = [];
      const eat = async () => {
        const name = await eatBest(bot, { critical });
        if (name) eaten.push(name);
        return name;
      };
      let ate = await eat();
      if (!ate && bot.food < 18) {
        const got = await getFood(this.stepCtx());
        if (got) {
          this.log(`[survival] got food: ${got}`);
          done.push(`got food (${got})`);
        }
        await this.getClear(bot);
        ate = await eat();
      }
      for (let i = 0; i < 2 && ate && bot.food < 17; i++) ate = await eat();
      if (eaten.length) done.push(`ate ${counted(eaten)}`);

      // Give health a moment to come back before going back to work.
      const until = Date.now() + 20000;
      while (critical && bot.health < criticalHealth + 4 && bot.food >= 18 && Date.now() < until && threatsNear(bot, 8).length === 0) {
        await this.getClear(bot);
        await delay(1000);
      }
      const fine = bot.health > criticalHealth && (bot.food > 6 || hasFood(bot));
      this.retryAt = fine ? 0 : Date.now() + 5 * 60000;
      this.lastHealth = bot.health;
      this.log(`[survival] done: health ${Math.round(bot.health)}/20, food ${bot.food}/20${fine ? '' : ', still not good'}`);
    } finally {
      // A player out of view right now is picked up again by the goal when they're back.
      if (follow) {
        useMoveMode(bot, false);
        bot.pathfinder.setGoal(follow, true);
      }
      this.recovering = false;
      this.notes = null;
      this.step = null;
      this.brain.resume('danger', recoveryReport({ critical, before, done, health: bot.health, food: bot.food, position: bot.entity?.position }));
    }
  }
}
