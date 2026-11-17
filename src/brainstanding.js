import { workOrder } from './chat.js';
import { isAdmin } from './guard.js';

// Standing jobs (see standing.js): work she keeps doing in rounds, each a short job of its own.
const STANDING_DEFAULTS = { enabled: true, maxHours: 4, maxCostUsd: 5, sayEveryMin: 5 };
// Rounds wait this long after the last job, so the chores between them get a turn, and this long
// after the bot has joined the server.
const ROUND_GAP_MS = 3000;
export const AFTER_SPAWN_MS = 10000;
// A round that ends one of these ways got nowhere, and so does one that ends without a progress
// call. Two in a row pause the standing job.
const NO_PROGRESS = {
  done: 'ended without saving any progress',
  steps: 'ran out of steps',
  time: 'ran out of time',
  api_error: "couldn't reach my brain",
  refusal: 'was refused',
  max_tokens: 'got cut off',
  crash: 'crashed'
};
const MAX_IDLE_ROUNDS = 2;
const ROUND = `Do the next unit of this work now, and only one: one tunnel, one row of trees, one batch. First look after what a player would: if your pack is nearly full, put things away where your notes say; make sure you have a working tool; eat if you need to. Then call standing_job with progress (where things stand now and what the next unit is), and finish with one short line. The next round starts on its own, so don't ask whether to carry on.`;
const RESTARTED = 'You were restarted since the last round, so check where you are and what you carry before you go on.';
export const STOPPED_STANDING = 'Stopped. The standing job is paused too; say continue when you want me to carry on with it.';

// Methods of the Brain class, put on it in brain.js, so this is the brain.
export const standingMethods = {
  get standingConfig() {
    return { ...STANDING_DEFAULTS, ...this.config.standing };
  },

  // The standing job, active or paused, or null when there is none or they are turned off.
  get standingJob() {
    return this.standingConfig.enabled === false ? null : this.standing.job;
  },

  // While this is true, rounds take the place of free time.
  get standingActive() {
    return this.standingJob?.state === 'active';
  },

  // The next round of the standing job, once nothing else is going on: no job, nothing queued, no
  // hold, and a moment after the last job. Returns whether one started.
  standingRound(now = Date.now()) {
    const sj = this.standingJob;
    if (sj?.state !== 'active' || this.busy || this.paused || this.queue.length > 0) return false;
    if (now < this.roundAfter || now - this.lastJobEnd < ROUND_GAP_MS || this.standingLimit(now)) return false;
    const round = { by: sj.by, task: sj.task, progress: sj.progress, number: sj.rounds + 1, started: sj.started, restarted: this.standing.restarted };
    this.standing.restarted = false;
    this.start({ player: sj.by, text: sj.task, standing: round });
    return true;
  },

  // Pauses the standing job when it has reached standing.maxHours or standing.maxCostUsd since it
  // started or was last resumed, and says so. Returns whether it did.
  standingLimit(now = Date.now()) {
    const sj = this.standingJob;
    if (sj?.state !== 'active') return false;
    const { maxHours, maxCostUsd } = this.standingConfig;
    const cost = sj.cost - (sj.countCost ?? 0);
    let why = null;
    if (maxHours > 0 && now - Date.parse(sj.countFrom ?? sj.started) >= maxHours * 3600000) why = `it has run for ${maxHours} hours`;
    else if (maxCostUsd > 0 && cost >= maxCostUsd) why = `it has cost $${cost.toFixed(2)}`;
    if (!why) return false;
    this.standing.pause(why);
    this.log(`[standing] paused: ${why}`);
    this.say(`I've paused the standing job: ${why}. Say continue if you want me to keep going.`);
    return true;
  },

  // Returns whether there was an active standing job to pause.
  pauseStanding(reason) {
    if (!this.standingActive) return false;
    this.standing.pause(reason);
    this.log(`[standing] paused: ${reason}`);
    return true;
  },

  // A bare "continue" from an admin while the standing job is paused carries it on, with no model
  // call. Returns whether it did.
  resumeOnContinue(player, text, to = null) {
    if (this.standingJob?.state !== 'paused' || !isAdmin(this.config, player) || workOrder(text, this.config.bot.username) !== 'continue') return false;
    this.standing.resume();
    this.log(`[standing] resumed by ${player}`);
    this.say(`Okay ${player}, carrying on with the standing job.`, to);
    if (this.current?.self) this.abortCurrent('replaced');
    return true;
  },

  // After a round: what it cost, and whether it got anywhere. Two in a row that didn't pause the
  // standing job, and she says why.
  endRound(job, end) {
    const sj = this.standing.job;
    if (!sj || sj.started !== job.standing.started) return;
    const counts = sj.state === 'active' && end in NO_PROGRESS;
    const progressed = counts ? end === 'done' && job.standingProgress : null;
    this.standing.addRound(job.record.cost, progressed);
    if (progressed === false && sj.idle >= MAX_IDLE_ROUNDS) {
      const why = NO_PROGRESS[end];
      this.pauseStanding(`${MAX_IDLE_ROUNDS} rounds in a row made no progress, the last one ${why}`);
      this.say(`I've paused the standing job: ${MAX_IDLE_ROUNDS} rounds in a row made no progress, the last one ${why}. Say continue when you want me to try again.`);
      return;
    }
    this.standingLimit();
  },

  // A round's own line is said at most once every standing.sayEveryMin, unless the round paused or
  // ended the standing job. Returns whether line is kept out of chat.
  keptQuiet(job, line) {
    if (!job.standing) return false;
    const now = Date.now();
    if (job.standingChanged || now - this.lastRoundSaid >= this.standingConfig.sayEveryMin * 60000) {
      this.lastRoundSaid = now;
      return false;
    }
    this.log(`[standing] not said: ${line}`);
    return true;
  },

  // The standing_job tool. Only an admin's job may start or resume one or change its task: the
  // same player a remember call would be saved for, so a note from someone else never gets more say.
  standingTool(job, input = {}) {
    const fail = (message) => ({ ok: false, message });
    const done = (message) => ({ ok: true, message });
    if (this.standingConfig.enabled === false) return fail('Not done: standing jobs are turned off.');
    if (job.self) return fail('Not done: free time leaves the standing job alone.');
    const { action } = input;
    const task = String(input.task ?? '').trim();
    const progress = String(input.progress ?? '').trim();
    const who = this.rememberFor(job) ?? job.player;
    const admin = isAdmin(this.config, who);
    const refuse = (what) => fail(`Not done: only an admin can ${what} a standing job, and ${who} isn't one. Tell them that plainly.`);
    const sj = this.standing.job;
    if (action === 'start') {
      if (!task || !progress) return fail('Not done: start needs task and progress.');
      if (!admin) return refuse('start');
      const old = this.standing.start({ task, progress, by: who, admin });
      this.log(`[standing] started by ${who}: ${task}`);
      const replaced = old ? ` It replaces the one from ${old.by} ("${old.task.slice(0, 100)}"), so say so in your reply.` : '';
      return done(`Started the standing job.${replaced} The first round starts on its own once this job ends, so finish now unless the player asked for something else too.`);
    }
    if (!sj) return fail('Not done: there is no standing job.');
    if (action === 'progress') {
      if (!progress) return fail('Not done: progress needs progress.');
      if (task && task !== sj.task && !admin) return refuse('change the task of');
      this.standing.setProgress(progress, task || null);
      job.standingProgress = true;
      return done(task && task !== sj.task ? 'Saved the progress and the new task.' : 'Saved the progress.');
    }
    if (action === 'pause') {
      if (sj.state === 'paused') return done('It was already paused.');
      this.pauseStanding(String(input.reason ?? '').trim() || `${who} asked to pause it`);
      job.standingChanged = true;
      return done('Paused the standing job. Say so in your reply; an admin can resume it.');
    }
    if (action === 'resume') {
      if (!admin) return refuse('resume');
      if (sj.state === 'active') return done('It is already running.');
      this.standing.resume();
      this.log(`[standing] resumed by ${who}`);
      return done('Resumed the standing job: the next round starts on its own once this job ends.');
    }
    if (action === 'end') {
      this.standing.end();
      this.log(`[standing] ended at ${who}'s word`);
      job.standingChanged = true;
      return done('Ended the standing job.');
    }
    return fail('Not done: action must be start, progress, pause, resume or end.');
  },

  // The first turn's ask for a round.
  roundAsk(round) {
    return [
      `This is round ${round.number} of your standing job from ${round.by}.${round.restarted ? ` ${RESTARTED}` : ''}`,
      `Task: ${round.task}`,
      `Where it stands: ${round.progress}`,
      ROUND
    ].join('\n');
  }
};
