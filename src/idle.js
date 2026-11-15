import pathfinderPkg from 'mineflayer-pathfinder';
import { pause, delay } from './actions/util.js';
import { walkTo, useMoveMode } from './actions/movement.js';
import { attackEntity } from './actions/combat.js';
import { collectDrops, dropsNear, leftThere } from './actions/items.js';
import { findNearest } from './actions/blocks.js';
import { sleep, canSleepNow, ownBed } from './actions/bed.js';
import { smelt, readyJob, rawFoodToCook } from './actions/furnace.js';
import { needsFood, hasFood, eatBest, isThreat, isDeadly, threatsNear, flee, getFood } from './survival.js';

const { GoalNear, GoalFollow } = pathfinderPkg.goals;

// What the bot does on its own between jobs, one chore at a time, most urgent first. A player's
// request stops the chore right away.
export class Idle {
  constructor({ getBot, brain, survival, config, makeCtx, log, smeltJobs, placed }) {
    this.getBot = getBot;
    this.brain = brain;
    this.survival = survival;
    this.config = config;
    this.makeCtx = makeCtx;
    this.log = log;
    this.smeltJobs = smeltJobs;
    this.placed = placed;
    this.running = null;
    this.until = new Map();
    this.skipMobs = new Set();
    this.anchor = null;
    this.holdUntil = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 4000);
  }

  later(name, ms) {
    this.until.set(name, Date.now() + ms);
  }

  ready(name) {
    return (this.until.get(name) ?? 0) <= Date.now();
  }

  // Stops the chore in progress and waits for it to wind down.
  async interrupt() {
    const run = this.running;
    if (!run) return;
    run.controller.abort('player');
    await Promise.race([run.done, delay(5000)]);
  }

  // No chores for a while, like after a player says stop.
  hold(ms) {
    this.holdUntil = Date.now() + ms;
    if (this.running) this.running.follow = null;
    this.interrupt();
  }

  tick() {
    const bot = this.getBot();
    if (this.brain.busy) this.anchor = null;
    if (!this.config.idle.enabled || !bot?.entity || this.running || this.brain.busy || this.brain.paused) return;
    if (this.survival.recovering || bot.isSleeping || bot.health <= 0 || Date.now() < this.holdUntil) return;
    this.anchor ??= bot.entity.position.clone();
    const chore = this.pick(bot);
    if (!chore) return;
    this.log(`[idle] ${chore.name}`);
    // A chore that walks replaces a follow goal, so it is put back afterwards.
    const goal = bot.pathfinder.goal;
    const run = { controller: new AbortController(), done: null, follow: goal instanceof GoalFollow ? goal : null };
    run.done = chore
      .run(this.makeCtx(run.controller.signal))
      .catch((err) => this.log(`[idle] ${chore.name} failed: ${err.message}`))
      .finally(() => {
        const follow = run.follow;
        // A player out of view right now is picked up again by the goal when they're back.
        if (follow && !bot.pathfinder.goal) {
          useMoveMode(bot, false);
          bot.pathfinder.setGoal(follow, true);
        }
        if (this.running === run) this.running = null;
      });
    this.running = run;
  }

  pick(bot) {
    const { idle, survival } = this.config;
    const here = bot.entity.position;

    if (needsFood(bot, survival.eatAtFood) && hasFood(bot) && this.ready('eat')) {
      return { name: 'eat', run: () => eatBest(bot).then(() => this.later('eat', 10000)) };
    }
    const defend = this.threat(bot);
    if (defend) return defend;
    if (bot.food <= 12 && !hasFood(bot) && this.ready('food')) {
      return {
        name: 'find food',
        run: async (ctx) => {
          const got = await getFood(ctx);
          if (got) {
            this.log(`[idle] got food: ${got}`);
            await eatBest(bot);
          } else if (!ctx.signal.aborted) {
            this.later('food', 5 * 60000);
          }
        }
      };
    }

    // Following someone: stay with them.
    if (bot.pathfinder.goal) return null;

    // Only her own bed, so she never takes a player's.
    const bed = canSleepNow(bot) && this.ready('sleep') && threatsNear(bot, 12).length === 0 ? ownBed(bot, this.placed) : null;
    if (bed) {
      return {
        name: 'go to bed',
        run: async (ctx) => {
          const r = await sleep(ctx, { x: bed.x, y: bed.y, z: bed.z });
          if (!r.ok && !ctx.signal.aborted) {
            this.log(`[idle] ${r.message}`);
            this.later('sleep', 60000);
          }
        }
      };
    }
    const job = readyJob(this.smeltJobs);
    if (job && this.ready('furnace')) {
      return {
        name: 'take things out of the furnace',
        run: async (ctx) => {
          const r = await smelt(ctx, { x: job.pos.x, y: job.pos.y, z: job.pos.z });
          this.log(`[idle] ${r.message}`);
          if (!r.ok) this.later('furnace', 60000);
        }
      };
    }
    const raw = this.ready('cook') ? rawFoodToCook(bot) : null;
    if (raw && findNearest(bot, (n) => n === 'furnace' || n === 'smoker', 32).length) {
      return {
        name: `cook ${raw}`,
        run: async (ctx) => {
          const r = await smelt(ctx, { item: raw, wait: true, make: false });
          this.log(`[idle] ${r.message}`);
          this.later('cook', r.ok ? 60000 : 10 * 60000);
        }
      };
    }
    const leave = (e) => leftThere(bot, e) || Math.abs(e.position.y - here.y) >= 3;
    if (this.ready('pickup') && dropsNear(bot, here, 6).some((e) => !leave(e))) {
      return {
        name: 'pick up items',
        run: async (ctx) => {
          await collectDrops(ctx, { radius: 6, max: 6, ignore: leave });
          this.later('pickup', 15000);
        }
      };
    }

    const minutes = idle.freeTimeMinutes;
    const online = this.config.allowlist.some((name) => bot.players[name]);
    const quiet = Date.now() - Math.max(this.brain.lastJobEnd, this.brain.lastFreeTime) >= minutes * 60000;
    if (minutes > 0 && online && quiet && this.brain.queue.length === 0) {
      this.brain.freeTime();
      return null;
    }

    if (this.ready('stroll') && Math.random() < 0.15 && !findNearest(bot, (n) => n === 'farmland', 6).length) {
      return { name: 'look around', run: (ctx) => this.stroll(ctx) };
    }
    return null;
  }

  // Hostile mobs close to the bot or to a player near it. Creepers get a wide berth instead,
  // and so do the warden, bosses and the creaking, from further off: the warden's sonic boom
  // reaches about 15 blocks, through walls.
  threat(bot) {
    if (!this.ready('defend')) return null;
    const here = bot.entity.position;
    const players = Object.values(bot.players)
      .map((p) => p.entity)
      .filter((e) => e && e !== bot.entity && e.position.distanceTo(here) <= 24);
    const radius = this.config.idle.defendRadius;
    const mobs = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && isThreat(e) && !this.skipMobs.has(e.id))
      .filter((e) => Math.abs(e.position.y - here.y) <= 4)
      .filter((e) => e.position.distanceTo(here) <= radius || players.some((p) => p.position.distanceTo(e.position) <= 6))
      .filter((e) => canSee(bot, e))
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
    const creeper = mobs.find((e) => e.name === 'creeper' && e.position.distanceTo(here) <= 5);
    if (creeper) return { name: 'back away from a creeper', run: (ctx) => flee(ctx, [creeper], 10) };
    const deadly = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isDeadly(e) && e.position.distanceTo(here) <= 16);
    if (deadly.length) return { name: `back away from ${deadly[0].name}`, run: (ctx) => flee(ctx, deadly, 24) };
    const mob = mobs.find((e) => e.name !== 'creeper');
    if (!mob || bot.health < 12) return null;
    return {
      name: `fight ${mob.name}`,
      run: async (ctx) => {
        const result = await attackEntity(ctx, mob);
        if (result !== 'killed' && result !== 'stopped') {
          this.skipMobs.add(mob.id);
          this.later('defend', 10000);
        }
      }
    };
  }

  // A few steps to an open spot close by, then a look around, like a player waiting for something.
  async stroll(ctx) {
    const { bot } = ctx;
    this.later('stroll', 30000 + Math.random() * 60000);
    const a = (this.anchor ?? bot.entity.position).floored();
    const angle = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 4;
    const spot = standingSpot(bot, a.offset(Math.round(Math.cos(angle) * r), 0, Math.round(Math.sin(angle) * r)));
    // Only somewhere in plain view, so a stroll never wanders through a door or round a wall.
    if (!spot || !clearLine(bot, spot.offset(0.5, 1.6, 0.5))) return;
    await walkTo(ctx, new GoalNear(spot.x, spot.y, spot.z, 0), { place: false });
    if (ctx.signal.aborted) return;
    await pause(500, 1500);
    await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.6).catch(() => {});
  }
}

const thinSnow = (b) => b.name === 'snow' && b.getProperties().layers <= 2;

// Somewhere to stand at about the height of pos: open at the feet and head, solid underneath.
function standingSpot(bot, pos) {
  for (const dy of [0, 1, -1]) {
    const feet = pos.offset(0, dy, 0);
    const below = bot.blockAt(feet.offset(0, -1, 0), false);
    const body = [bot.blockAt(feet, false), bot.blockAt(feet.offset(0, 1, 0), false)];
    const open = (b) => b && (b.boundingBox === 'empty' || thinSnow(b)) && !b.name.includes('water') && !b.name.includes('lava');
    if (below?.boundingBox === 'block' && body.every(open)) return feet;
  }
  return null;
}

// Nothing solid between the bot's eyes and target.
function clearLine(bot, target) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const dir = target.minus(eye);
  const dist = dir.norm();
  if (dist < 1) return true;
  return !bot.world.raycast(eye, dir.normalize(), dist);
}

// A mob behind a wall or underground is no business of the bot's.
function canSee(bot, entity) {
  return clearLine(bot, entity.position.offset(0, (entity.height ?? 1.8) * 0.8, 0));
}
