import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, delay, guarded, customName } from './actions/util.js';
import { isHostile, attackEntity } from './actions/combat.js';
import { useMoveMode } from './actions/movement.js';
import { findNearest } from './actions/blocks.js';
import { isPickable, withContainer } from './actions/containers.js';

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

// Runs the other way from the threats for a few seconds.
export async function flee(ctx, threats, distance = 16) {
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

// Wild animals worth hunting for food: no name tag, not in a pen, and never the last two of
// their kind around, so they can still breed.
export function preyNear(bot, radius = 24) {
  const here = bot.entity.position;
  const animals = Object.values(bot.entities).filter(
    (e) => GAME.has(e.name) && e.position && e.position.distanceTo(here) <= radius && !customName(e)
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

  check() {
    const bot = this.getBot();
    if (!bot?.entity || this.offline() || this.recovering || bot.isSleeping || bot.health <= 0) return;
    const critical = bot.health <= this.config.survival.criticalHealth;
    const starving = bot.food <= 6 && !hasFood(bot);
    if (!critical && !starving) return;
    // Between jobs the idle routine finds food on its own.
    if (!critical && !this.brain.busy) return;
    // After a try that didn't help, wait unless things got worse.
    if (Date.now() < this.retryAt && bot.health > this.lastHealth - 2) return;
    this.recover(bot, critical).catch((err) => this.log(`[survival] ${err.message}`));
  }

  async recover(bot, critical) {
    this.recovering = true;
    const { criticalHealth } = this.config.survival;
    const goal = bot.pathfinder.goal;
    const follow = goal instanceof GoalFollow ? goal : null;
    const before = { health: Math.round(bot.health), food: bot.food };
    const done = [];
    try {
      this.log(`[survival] ${critical ? 'low health' : 'starving'}: health ${Math.round(bot.health)}/20, food ${bot.food}/20`);
      this.say(critical ? "I'm hurt, backing off to heal." : "I'm starving, getting some food first.", this.brain.replyTo ?? null);
      await this.stopChores?.();
      await this.brain.pause('danger');
      const ctx = this.makeCtx(null);

      const fled = new Map();
      for (let i = 0; i < 2; i++) {
        const threats = threatsNear(bot, 10);
        if (threats.length === 0) break;
        for (const t of threats) fled.set(t.id, t.name);
        await flee(ctx, threats);
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
        const got = await getFood(ctx);
        if (got) {
          this.log(`[survival] got food: ${got}`);
          done.push(`got food (${got})`);
        }
        ate = await eat();
      }
      for (let i = 0; i < 2 && ate && bot.food < 17; i++) ate = await eat();
      if (eaten.length) done.push(`ate ${counted(eaten)}`);

      // Give health a moment to come back before going back to work.
      const until = Date.now() + 20000;
      while (critical && bot.health < criticalHealth + 4 && bot.food >= 18 && Date.now() < until && threatsNear(bot, 8).length === 0) {
        await delay(1000);
      }
      const fine = bot.health > criticalHealth && (bot.food > 6 || hasFood(bot));
      this.retryAt = fine ? 0 : Date.now() + 5 * 60000;
      this.lastHealth = bot.health;
      this.log(`[survival] done: health ${Math.round(bot.health)}/20, food ${bot.food}/20${fine ? '' : ', still not good'}`);
    } finally {
      // A player out of view right now is picked up again by the goal when they're back.
      if (follow) bot.pathfinder.setGoal(follow, true);
      this.recovering = false;
      this.brain.resume('danger', recoveryReport({ critical, before, done, health: bot.health, food: bot.food, position: bot.entity?.position }));
    }
  }
}
