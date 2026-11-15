import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// The one job she keeps doing until told to stop, saved to a file so a restart carries on with it.
// Fields: task (what to keep doing, where, the pattern, the limits and rules, in words a later round
// understands on its own), by and admin (who gave it), started, progress (where things stand and
// what the next unit is), rounds, cost, state ('active' or 'paused'), reason (why it's paused),
// idle (rounds in a row without progress), and countFrom and countCost (when, and at what cost, the
// hour and cost limits started counting, which an admin's resume sets again).
export class Standing {
  // With no path it lives only in memory.
  constructor(path = null) {
    this.path = path;
    this.job = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    // An active job read from the file was running when the bot last stopped.
    this.restarted = this.job?.state === 'active';
  }

  save() {
    if (!this.path) return;
    // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.job, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }

  // Returns the job it replaced, or null.
  start({ task, progress, by, admin }, now = Date.now()) {
    const old = this.job;
    const at = new Date(now).toISOString();
    this.job = { task, by, admin: Boolean(admin), started: at, progress, rounds: 0, cost: 0, state: 'active', reason: null, idle: 0, countFrom: at, countCost: 0 };
    this.restarted = false;
    this.save();
    return old;
  }

  setProgress(progress, task = null) {
    if (!this.job) return;
    this.job.progress = progress;
    if (task) this.job.task = task;
    this.save();
  }

  pause(reason) {
    if (!this.job) return;
    Object.assign(this.job, { state: 'paused', reason });
    this.save();
  }

  // The limits count again from here.
  resume(now = Date.now()) {
    if (!this.job) return;
    Object.assign(this.job, { state: 'active', reason: null, idle: 0, countFrom: new Date(now).toISOString(), countCost: this.job.cost });
    this.save();
  }

  // Returns the job that ended, or null.
  end() {
    const old = this.job;
    this.job = null;
    this.restarted = false;
    this.save();
    return old;
  }

  // progressed is true or false, or null for a round whose end says nothing either way.
  addRound(cost, progressed) {
    if (!this.job) return;
    this.job.rounds++;
    this.job.cost = Math.round((this.job.cost + (cost ?? 0)) * 1e6) / 1e6;
    if (progressed === true) this.job.idle = 0;
    else if (progressed === false) this.job.idle++;
    this.save();
  }
}
