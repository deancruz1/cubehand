import { findPlayer } from './actions/movement.js';

// Thinking gestures end on their own after this long, in case a request never says it's over.
const THINK_CEILING_MS = 90000;

const between = (min, max) => min + Math.random() * (max - min);
const clampPitch = (p) => Math.max(-1.2, Math.min(1.2, p));

// The small things a player does without thinking: turning to whoever talks to her, a nod or a
// wave now and then, and moving her head about while she works out her next step instead of
// standing frozen. Only the head, an arm swing and a short crouch are used, never anything that
// moves her or touches the world, and nothing while something else is aiming or moving her.
// The waits are plain timers that are cleared the moment she has to act, so pauseScale doesn't
// apply (with 0 they would spin).
export class Gestures {
  constructor({ getBot, brain, survival, idle, config, toolRunning = () => false }) {
    this.getBot = getBot;
    this.brain = brain;
    this.survival = survival;
    this.idle = idle;
    this.enabled = config.bot.gestures !== false;
    this.toolRunning = toolRunning;
    this.timers = new Set();
    this.thinking = null;
    this.thinkTimer = null;
    this.sneaking = null;
    this.lastNod = 0;
  }

  // Every tool, chore, survival and the pathfinder set her look themselves, and placing is aimed
  // by it, so a gesture only happens when none of them is going.
  free(bot) {
    if (!bot?.entity) return false;
    if (this.toolRunning() || this.idle?.running || this.survival?.recovering || this.brain.paused) return false;
    const pf = bot.pathfinder;
    if (pf?.isMoving?.() || pf?.isMining?.() || pf?.isBuilding?.()) return false;
    return !(bot.targetDigBlock || bot.usingHeldItem || bot.vehicle || bot.isSleeping || bot.currentWindow);
  }

  later(min, max, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, between(min, max));
    timer.unref?.();
    this.timers.add(timer);
  }

  // Turns to a player within range. False when they aren't there or she's busy.
  face(username, range = 32) {
    const bot = this.getBot();
    if (!this.free(bot)) return false;
    const entity = findPlayer(bot, username);
    if (!entity || entity.position.distanceTo(bot.entity.position) > range) return false;
    bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0)).catch(() => {});
    return true;
  }

  // Someone allowed spoke to her: she turns to them, and sometimes nods or swings an arm once
  // the turn is mostly done. With gestures off she still turns, as she always did.
  notice(username) {
    if (!this.face(username) || !this.enabled) return;
    const now = Date.now();
    if (now - this.lastNod < 8000 || Math.random() < 0.45) return;
    this.lastNod = now;
    const nod = Math.random() < 0.5;
    this.later(250, 600, () => {
      const bot = this.getBot();
      if (!this.free(bot)) return;
      // A crouch off the ground (on a ladder, say) would change how she hangs there.
      if (nod && bot.entity.onGround && !bot.getControlState?.('sneak')) {
        bot.setControlState('sneak', true);
        this.sneaking = bot;
        this.later(180, 320, () => this.unsneak());
      } else {
        bot.swingArm?.('right');
      }
    });
  }

  unsneak() {
    const bot = this.sneaking;
    this.sneaking = null;
    bot?.setControlState('sneak', false);
  }

  // From the brain: true right before a model request, false when she's about to act or speak.
  think(active, job) {
    if (!active) return this.calm();
    this.endThinking();
    const bot = this.getBot();
    if (!this.enabled || !bot?.entity) return;
    // Tools look at what they work on, so where she faces now is where she last acted.
    this.thinking = { job, home: { yaw: bot.entity.yaw, pitch: bot.entity.pitch }, until: Date.now() + THINK_CEILING_MS, moved: false };
    this.next(600, 1400);
  }

  next(min, max) {
    this.thinkTimer = setTimeout(() => this.beat(), between(min, max));
    this.thinkTimer.unref?.();
  }

  beat() {
    this.thinkTimer = null;
    const t = this.thinking;
    if (!t) return;
    if (Date.now() >= t.until || !this.brain.busy) return this.endThinking();
    const bot = this.getBot();
    if (this.free(bot)) this.glance(bot, t);
    if (Math.random() < 0.2) this.next(2500, 4500);
    else this.next(900, 2600);
  }

  // Back to the work, over to whoever asked if they're close, or a look around.
  glance(bot, t) {
    const { home } = t;
    const r = Math.random();
    const asker = t.job?.player ? findPlayer(bot, t.job.player) : null;
    const near = asker && asker.position.distanceTo(bot.entity.position) <= 12;
    t.moved = true;
    if (near && r < 0.3) {
      bot.lookAt(asker.position.offset(0, asker.height ?? 1.6, 0)).catch(() => {});
    } else if (r < 0.65) {
      bot.look(home.yaw + (Math.random() - 0.5) * 0.3, clampPitch(home.pitch + (Math.random() - 0.5) * 0.2)).catch(() => {});
    } else {
      const side = Math.random() < 0.5 ? -1 : 1;
      bot.look(home.yaw + side * between(0.3, 1.1), clampPitch((Math.random() - 0.5) * 0.6)).catch(() => {});
    }
  }

  // A forced look lands at once, so no turn is left going when the next tool aims.
  endThinking() {
    clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    const t = this.thinking;
    this.thinking = null;
    if (!t?.moved) return;
    const bot = this.getBot();
    if (this.free(bot)) bot.look(t.home.yaw, t.home.pitch, true).catch(() => {});
  }

  // She's about to act: every gesture stops now.
  calm() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.unsneak();
    this.endThinking();
  }

  // A line said for a player's job. When the job is over right after it, that was her last word,
  // so she faces whoever asked.
  said(job) {
    if (!this.enabled || !job || job.self || !job.player) return;
    setImmediate(() => {
      if (this.brain.current !== job) this.face(job.player, 16);
    });
  }
}
