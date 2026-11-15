import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { pause, delay, posText } from './actions/util.js';
import { walkTo, useMoveMode, scaffoldRemovable, underBot } from './actions/movement.js';
import { attackEntity } from './actions/combat.js';
import { collectDrops, dropsNear, leftThere } from './actions/items.js';
import { findNearest, digBlock, inReach } from './actions/blocks.js';
import { DigSpot } from './actions/mining.js';
import { sleep, canSleepNow, ownBed } from './actions/bed.js';
import { smelt, readyJob, rawFoodToCook } from './actions/furnace.js';
import { needsFood, hasFood, eatBest, isThreat, isDeadly, threatsNear, flee, getFood } from './survival.js';
import { tidyDue, tidyNotes } from './memory.js';
import { JobRecord } from './joblog.js';

const { GoalNear, GoalFollow } = pathfinderPkg.goals;

// How far off walk scaffolding she left is still hers to go and take down, and how close
// together the blocks one go takes down are.
const TIDY_RANGE = 48;
const TIDY_GROUP = 6;
// Where the notes from before a tidy go, and how long between looks at whether one is due.
const NOTE_BACKUPS = 'logs/memory-backups';
const NOTES_CHECK_MS = 10 * 60000;

// What the bot does on its own between jobs, one chore at a time, most urgent first. A player's
// request stops the chore right away.
export class Idle {
  // reflexWalking() is true while a walk started on a player's "come here" is still going.
  // scaffold is the ScaffoldLog of blocks her walks left standing, and memory the notes, which
  // she tidies once in a while (see tidyNotes in memory.js) into noteBackups.
  constructor({ getBot, brain, survival, config, makeCtx, log, smeltJobs, placed, scaffold = null, memory = null, noteBackups = NOTE_BACKUPS, reflexWalking = () => false }) {
    this.getBot = getBot;
    this.brain = brain;
    this.survival = survival;
    this.reflexWalking = reflexWalking;
    this.config = config;
    this.makeCtx = makeCtx;
    this.log = log;
    this.smeltJobs = smeltJobs;
    this.placed = placed;
    this.scaffold = scaffold;
    this.memory = memory;
    this.noteBackups = noteBackups;
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
    if (!bot?.entity || this.running || this.brain.busy || this.brain.paused) return;
    if (this.survival.recovering || bot.isSleeping || bot.health <= 0 || Date.now() < this.holdUntil || this.reflexWalking()) return;
    // With chores off, a standing job still gets its rounds.
    if (!this.config.idle.enabled) {
      if (this.brain.standingActive && !bot.pathfinder?.goal) this.brain.standingRound();
      return;
    }
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
    const tops = this.ready('tidy') ? this.scaffoldTops(bot) : [];
    if (tops.length && threatsNear(bot, 12).length === 0) {
      return { name: 'take down scaffolding I left', run: (ctx) => this.tidy(ctx, tops) };
    }
    if (this.memory && !this.brain.standingActive && this.ready('notes')) {
      this.later('notes', NOTES_CHECK_MS);
      if (tidyDue(this.memory.notes, { dir: this.noteBackups })) return { name: 'tidy my notes', run: (ctx) => this.tidyNotes(ctx) };
    }

    // A standing job takes the place of free time and strolls, once the chores above are done.
    if (this.brain.standingActive) {
      this.brain.standingRound();
      return null;
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

  // Walk scaffolding she left within TIDY_RANGE that can come down next: the top block of each
  // pillar, and none waiting for another try or inside a build going on.
  scaffoldTops(bot) {
    if (!this.scaffold) return [];
    const dim = bot.game?.dimension;
    const here = bot.entity.position;
    const nameAt = (e) => bot.blockAt(new Vec3(e.x, e.y, e.z), false)?.name ?? null;
    const zone = bot.buildZone;
    return this.scaffold.standing(dim, nameAt).filter((e) => {
      if ((e.next ?? 0) > Date.now() || nameAt(e) === null) return false;
      if (zone && e.x >= zone.min.x && e.x <= zone.max.x && e.y >= zone.min.y && e.y <= zone.max.y && e.z >= zone.min.z && e.z <= zone.max.z) return false;
      if (here.distanceTo(new Vec3(e.x + 0.5, e.y + 0.5, e.z + 0.5)) > TIDY_RANGE) return false;
      const above = new Vec3(e.x, e.y + 1, e.z);
      return !this.scaffold.has(above, bot.blockAt(above, false)?.name, dim);
    });
  }

  // Goes over to the nearest of her walk scaffolding on foot (no digging, no placing on the way)
  // and takes it down with the blocks close to it, top first, like a player taking their pillar
  // down. A block she can't get to that way gets another try a day later (see ScaffoldLog.failed),
  // and one with something on it that isn't hers stays up.
  async tidy(ctx, tops) {
    const { bot, signal } = ctx;
    const log = this.scaffold;
    const dim = bot.game?.dimension;
    this.later('tidy', 15000);
    const at = (e) => new Vec3(e.x, e.y, e.z);
    const here = bot.entity.position;
    const first = tops.reduce((a, b) => (here.distanceTo(at(b)) < here.distanceTo(at(a)) ? b : a));
    const queue = tops.filter((e) => at(e).distanceTo(at(first)) <= TIDY_GROUP);
    let removed = 0;
    while (queue.length > 0 && !signal?.aborted) {
      queue.sort((a, b) => b.y - a.y);
      const pos = at(queue.shift());
      const block = bot.blockAt(pos, false);
      if (!block) continue;
      if (!log.has(pos, block.name, dim)) {
        log.remove(pos, dim);
        continue;
      }
      const safe = scaffoldRemovable(bot, pos);
      if (safe === 'unsafe') {
        log.removeColumn(pos, dim);
        this.log(`[idle] left the ${block.name} at ${posText(pos)} standing, something that isn't mine is on it`);
        continue;
      }
      if (safe !== 'ok') continue;
      if (!inReach(bot, pos) || underBot(bot, pos)) {
        const walked = await walkTo(ctx, new DigSpot(pos, bot.world, { reach: 4 }), { onFoot: true });
        if (signal?.aborted || walked.reason === 'interrupted') break;
        if (!inReach(bot, pos) || underBot(bot, pos)) {
          log.failed(pos, dim);
          continue;
        }
      }
      const dug = await digBlock(ctx, pos, { anyTool: true });
      if (signal?.aborted) break;
      if (!dug.ok) {
        log.failed(pos, dim);
        continue;
      }
      log.remove(pos, dim);
      removed++;
      const below = log.get(pos.offset(0, -1, 0), dim);
      if (below) queue.push(below);
    }
    if (removed) this.log(`[idle] took down ${removed} blocks of scaffolding`);
  }

  // One call to the everyday model that merges notes about the same place or task. The call goes
  // in the job log as a side line of its own, like a lesson review.
  async tidyNotes(ctx) {
    const { signal } = ctx;
    const brain = this.brain;
    const model = brain.modelFor('normal');
    let record = null;
    const ask = async (request) => {
      const asked = Date.now();
      const response = await brain.client.beta.messages.create({ model, ...request, output_config: { effort: 'low' } }, { signal });
      record = new JobRecord({ text: 'tidy the notes', self: true });
      record.call('tidy', response.model ?? model, response.usage, Date.now() - asked);
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    };
    let merges = null;
    try {
      merges = await tidyNotes(this.memory, { ask, dir: this.noteBackups, log: this.log, signal });
    } finally {
      if (record) brain.writeRecord(record, 'tidy', { merged: merges?.length ?? 0 });
    }
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
