import { findPlayer, goToPlayer, followPlayer, stopMoving } from './actions/movement.js';
import { reflexFor } from './chat.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// The come, follow and stop_moving tools' own functions.
const MOVES = { come: goToPlayer, follow: followPlayer, stay: stopMoving };

// A walk that ended these ways was cut off by something else, not short of a way there.
const CUT_OFF = new Set(['stopped', 'interrupted']);

// A plain "come here", "follow me" or "stay" sets the body moving at once, while the model is
// still working out what to say: its job starts as usual and is told what was already done.
// Only with no player's job running or waiting, nothing on hold, and the bot free to move.
export class Reflex {
  constructor({ getBot, brain, idle, config, makeCtx, log, say, moves = MOVES }) {
    this.getBot = getBot;
    this.brain = brain;
    this.idle = idle;
    this.config = config;
    this.makeCtx = makeCtx;
    this.log = log;
    this.say = say;
    this.moves = moves;
    this.enabled = config.bot.reflexes !== false;
    // The order waiting for free time or a chore to let go, and the come walk under way.
    this.order = null;
    this.walk = null;
  }

  get walking() {
    return this.walk !== null;
  }

  // result is classifyMessage's, so only an allowed player's request to the bot counts. Called
  // before the request goes to the brain. Returns the kind it acted on, or null.
  fire(username, result, whisper = false) {
    if (!this.enabled || result.type !== 'request') return null;
    const kind = reflexFor(result.text, this.config.bot.username);
    if (!kind) return null;
    const { brain } = this;
    const current = brain.current;
    if ((current && !current.self) || brain.queue.length > 0 || brain.paused) return null;
    const bot = this.getBot();
    if (!bot?.entity || bot.isSleeping || bot.vehicle || bot.currentWindow) return null;
    if (kind !== 'stay' && !findPlayer(bot, username)) return null;
    this.log(`[reflex] ${kind} for ${username}`);
    const order = { kind, username, whisper };
    // Free time is ended by the brain once this request goes in, and a chore by the job's start:
    // the body is only taken once their tool has let go of it.
    const busy = [current?.self ? current.running : null, this.idle?.running ? this.idle.interrupt() : null].filter(Boolean);
    if (busy.length === 0) {
      this.act(order);
      return kind;
    }
    this.order = order;
    Promise.race([Promise.all(busy.map((p) => p.catch(() => {}))), wait(5000)]).then(() => {
      if (this.order !== order) return;
      this.order = null;
      this.act(order);
    });
    return kind;
  }

  act({ kind, username, whisper }) {
    const bot = this.getBot();
    if (!bot?.entity) return;
    this.cancel();
    if (kind !== 'come') {
      Promise.resolve(this.moves[kind](this.ctx(null, username), { player: username })).catch((err) => this.log(`[reflex] ${kind} failed: ${err.message}`));
      return;
    }
    const controller = new AbortController();
    const walk = { controller, player: username, done: null };
    this.walk = walk;
    walk.done = Promise.resolve(this.moves.come(this.ctx(controller.signal, username), { player: username }))
      .catch((err) => ({ ok: false, message: err.message }))
      .then((result) => {
        if (this.walk === walk) this.walk = null;
        if (result.ok || controller.signal.aborted || CUT_OFF.has(result.reason)) return;
        this.log(`[reflex] walk to ${username} failed: ${result.message}`);
        this.say("I can't find a way to you.", whisper ? username : null);
      });
  }

  ctx(signal, username) {
    return { ...this.makeCtx(signal), requester: username };
  }

  // A stop, a danger hold or a lost connection: the order waiting and the walk both end.
  cancel() {
    this.order = null;
    const walk = this.walk;
    this.walk = null;
    walk?.controller.abort('stop');
  }

  // Before any job's tool runs. The reflex job's own tools leave the walk alone (a walk of
  // theirs replaces it anyway), and anyone else's end it.
  toolStarting(job) {
    const walk = this.walk;
    if (!walk || (job?.reflex && job.player === walk.player)) return;
    this.cancel();
  }
}
