// Dying: what she is told about it, and the trip back for her things after the respawn.

// What she drops on death vanishes this long after.
const DESPAWN_MS = 5 * 60000;
// Dying again this soon after being sent back, and this close to the same place, means the place
// itself is the danger, so the things are left there.
const RECOVERY_GAP_MS = 60000;
const RECOVERY_NEAR = 16;
const RECOVERY = `Go back and pick your things up (move_to there, then collect_items) if it is safe and there is time. If what killed you is still there, like lava, a crowd of mobs or water you drowned in, don't walk back into it: say so in one short line and leave them. Finish with one short line.`;

const dimensionName = (d) => (d ? String(d).replace(/^minecraft:/, '').replace(/^the_/, '').replaceAll('_', ' ') : null);
const sameSpot = (a, b) =>
  dimensionName(a.dimension) === dimensionName(b.dimension) && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z) <= RECOVERY_NEAR;
const howLong = (ms) => {
  const [n, unit] = ms < 90000 ? [Math.max(1, Math.round(ms / 1000)), 'second'] : [Math.round(ms / 60000), 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

// Where and when she died, what killed her as far as known, and how long her things have left.
export function deathText(info, now = Date.now()) {
  const { x, y, z } = info.pos;
  const where = dimensionName(info.dimension);
  const back = dimensionName(info.respawnedIn);
  const left = info.at + DESPAWN_MS - now;
  return [
    `You died ${howLong(now - info.at)} ago at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}${where ? ` in the ${where}` : ''}.`,
    info.cause ? `The death message said: "${info.cause}".` : '',
    back && back !== where ? `You respawned in the ${back}.` : '',
    `What you carried dropped there and vanishes 5 minutes after you died, ${left > 0 ? `so you have about ${howLong(left)} left to get it` : 'so it is most likely gone'}.`
  ]
    .filter(Boolean)
    .join(' ');
}

// For a player's job that came before the recovery could.
export function deathNote(info, now) {
  return `${deathText(info, now)} Do what was asked first. If it's safe and there's time, on the way or after, pick your things up with collect_items, but don't walk back into what killed you.`;
}

// For the request she died doing, when it comes back.
function diedDuring(info) {
  return `You died partway through this request${info.cause ? ` ("${info.cause}")` : ''} and have respawned since, so check where you are, what you still carry and how far it got before you carry on.`;
}

export function recoveryAsk(info, now = Date.now()) {
  const job = info.job;
  const doing = !job
    ? 'You were not doing a job for a player when you died.'
    : job.carry
      ? `You were doing ${job.player}'s request "${job.text}" when you died. It comes back as a job of its own once this one ends, so don't start on it here.`
      : `You were doing ${job.player}'s request "${job.text}" when you died, and you had died doing it once before, so it won't be picked up again: say so in your last line.`;
  return [deathText(info, now), doing, RECOVERY].join('\n');
}

// Methods of the Brain class, put on it in brain.js, so this is the brain.
export const deathMethods = {
  // Dying pauses the standing job, and she says so once. death is { pos, dimension, at } as far as
  // known. It's kept for respawned(), with the player's job she was doing, if any: free time and
  // rounds of the standing job don't count.
  died(death = null) {
    const job = this.current;
    const doing = job && !job.self && !job.standing ? { player: job.player, text: job.text, whisper: job.whisper, carry: !job.resumed } : null;
    this.death = { ...death, at: death?.at ?? Date.now(), job: doing };
    if (this.pauseStanding('I died')) this.say("I died, so I've paused the standing job. Say continue when you want me to pick it up again.");
  },

  // After the respawn, a job of her own goes back for her things (see recoveryAsk), and the request
  // she died doing comes after it again, once. A player's request that's already running or waiting
  // goes first and hears what happened instead. death can add what killed her (cause), and
  // dimension is where she respawned.
  respawned(death = {}, dimension = null, now = Date.now()) {
    const info = { ...this.death, ...death, job: this.death?.job ?? null, respawnedIn: dimension };
    this.death = null;
    if (!info.pos) return;
    const carry = info.job?.carry
      ? { player: info.job.player, text: info.job.text, whisper: info.job.whisper, resumed: true, after: diedDuring(info) }
      : null;
    const live = this.current && !this.current.controller.signal.aborted ? this.current : null;
    const waiting = this.queue.findIndex((r) => !r.self);
    if (live && !live.self) {
      live.reports.push(deathNote(info, now));
      if (carry) this.queue.unshift(carry);
      this.sentBack(info, now);
      return;
    }
    if (waiting >= 0) {
      const first = this.queue[waiting];
      first.after = [first.after, deathNote(info, now)].filter(Boolean).join('\n\n');
      if (carry) this.queue.splice(waiting + 1, 0, carry);
      this.sentBack(info, now);
      return;
    }
    if (carry) this.queue.unshift(carry);
    const last = this.lastRecovery;
    if (last && now - last.at < RECOVERY_GAP_MS && sameSpot(last, info)) {
      this.log('[brain] died again where the last recovery went, leaving the things');
      this.say("I died in the same spot again, so I'm leaving my things there.");
      return;
    }
    this.sentBack(info, now);
    const queued = this.queue.find((r) => r.recovery);
    if (queued) {
      queued.recovery = info;
      return;
    }
    const request = { player: null, text: null, self: true, recovery: info };
    if (live?.self) {
      this.queue.unshift(request);
      this.abortCurrent('replaced');
    } else if (this.busy || this.paused) this.queue.unshift(request);
    else this.start(request);
  },

  sentBack(info, now) {
    this.lastRecovery = { at: now, pos: info.pos, dimension: info.dimension ?? null };
  }
};
