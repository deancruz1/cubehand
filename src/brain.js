import { TOOLS } from './tools.js';
import { BRAIN_TOOLS } from './braintools.js';
import { systemPrompt } from './prompt.js';
import { JobRecord, summaryLine } from './joblog.js';
import { judgeable, reviewable, worthLesson, lessonMeta, lessonRequest, parseLesson, keywords, CORRECTION_WINDOW_MS } from './lessons.js';
import { repeatedRoutine, routineHint } from './skills.js';
import { isStandingOrder } from './chat.js';
import { isAdmin } from './guard.js';
import { Standing } from './standing.js';
import { BUSY_INSTRUCTIONS, BUSY_WORDS, chatPart, WORK_IN, LASTING_NOTE } from './brainlines.js';
import { routeMethods } from './brainroute.js';
import { hasSystemMessages, apiMethods } from './brainapi.js';
import { deathNote, deathMethods } from './braindeath.js';
import { AFTER_SPAWN_MS, STOPPED_STANDING, standingMethods } from './brainstanding.js';
import { NEXT, AGAIN, whisperTo, openTurn, appendBlocks, openRun, startRun, firstTurn, runStep } from './brainsteps.js';

export { chatPart, announcesMore, lastJobLine, leanSnapshot, errorMessage } from './brainlines.js';
export { isBuildRequest } from './brainroute.js';
export { deathText, recoveryAsk } from './braindeath.js';

const ALL_TOOLS = [...TOOLS, ...BRAIN_TOOLS];
// A note that can wait goes in with the result of the tool that's running, unless that tool runs
// on this long after the note came in, and as long since its progress line last changed.
const NOTE_WAIT_MS = 90000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export class Brain {
  // runTool(name, input, signal, requester) returns { ok, message }; requester, when given, is who
  // the call counts as coming from instead of the job's player. snapshot() returns the game state text.
  // onJobStart() runs (and is awaited) before each job, beforeStep() before each model call.
  // watchTool(name, controller) watches a running tool and returns { stop(), report() }.
  // jobLog, if given, gets one line per job with its timings, tokens and cost.
  // onThinking(true, job) runs as a job's step goes to the model, and onThinking(false, job) once
  // as soon as she's about to act or speak on it, or the request ends any other way.
  // lessons, if given, is the Lessons store from lessons.js.
  // refusalLog, if given, gets the full request of every refused step (see joblog.js), and
  // forgetRequests(before) clears the remembered requests made up to then, and forgetChat(before)
  // the recent chat said up to then.
  // standing, if given, is the Standing store from standing.js; without one it lives in memory.
  // skills, if given, is the Skills store from skills.js, used to point out routines worth saving.
  constructor({ client, config, runTool, snapshot, say, onStop, onJobStart, beforeStep, watchTool, onThinking, jobLog, refusalLog, forgetRequests, forgetChat, lessons, standing, skills: skillStore, log = console.log }) {
    this.client = client;
    this.config = config;
    this.runTool = runTool;
    this.snapshot = snapshot;
    this.say = say;
    this.onStop = onStop ?? (() => {});
    this.onJobStart = onJobStart;
    this.beforeStep = beforeStep;
    this.watchTool = watchTool;
    this.onThinking = onThinking;
    this.log = log;
    this.jobLog = jobLog;
    this.refusalLog = refusalLog;
    this.forgetRequests = forgetRequests;
    this.forgetChat = forgetChat;
    this.lastPlanAt = 0;
    this.queue = [];
    this.current = null;
    // Why jobs are on hold right now ('danger', 'hazard', 'offline'). Nothing carries on until it's empty.
    this.holds = new Set();
    // Turned off for good if the API ever turns down a mid-conversation system message.
    this.systemMessages = true;
    this.lastJobEnd = Date.now();
    this.lastFreeTime = Date.now();
    this.lastJob = null;
    this.lessons = config.learning?.lessons === false ? null : (lessons ?? null);
    // Players' jobs that ended a moment ago with nothing wrong, kept a while in case the player
    // says otherwise, and the lesson calls under way.
    this.waiting = new Map();
    this.reviews = new Set();
    this.correctionWindowMs = CORRECTION_WINDOW_MS;
    this.closing = false;
    this.standing = standing ?? new Standing();
    // When a round's own line was last said, and when rounds may start after the bot joined.
    this.lastRoundSaid = 0;
    this.roundAfter = 0;
    const skills = config.learning?.skills !== false;
    this.skillStore = skills ? (skillStore ?? null) : null;
    // A routine to point out in the next job like the one that did it, and the routines already
    // pointed out since the start.
    this.routine = null;
    this.routinesShown = new Set();
    // The last death, until she respawns, and when and where she was last sent back after one.
    this.death = null;
    this.lastRecovery = null;
    const standingOn = this.standingConfig.enabled !== false;
    // The same lists go with every call, so the cache entry for them holds across models.
    this.tools = ALL_TOOLS.filter((t) => (skills || t.name !== 'skill') && (standingOn || t.name !== 'standing_job'));
    this.looseTools = this.tools.map(({ strict, ...rest }) => rest);
    this.system = systemPrompt(config.bot.username, config.admins ?? [], { skills, standing: standingOn });
    // Every job starts a new conversation, so the tools and system prompt get their own cache
    // entry that lasts between jobs. A 1 hour entry has to come before the 5 minute one that
    // automatic caching puts on the end of the conversation.
    this.systemBlocks = [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  }

  get busy() {
    return this.current !== null;
  }

  get paused() {
    return this.holds.size > 0;
  }

  // Who lines about the running job go to: the player who whispered it, or null for public chat.
  get replyTo() {
    const job = this.current;
    return job && !job.self ? whisperTo(job.player, job.whisper) : null;
  }

  // A request that came in by whisper gets its replies by whisper too. reflex is the kind of
  // order the body already started on, which only happens with no player's job about.
  enqueue(player, text, whisper = false, reflex = null) {
    const to = whisperTo(player, whisper);
    const request = reflex ? { player, text, whisper, reflex } : { player, text, whisper };
    if (this.resumeOnContinue(player, text, to)) return;
    // Free time gives way to players right away. A player who cuts in on the trip back after a
    // death hears about it instead.
    if (this.current?.self) {
      if (this.current.recovery) request.after = deathNote(this.current.recovery, Date.now());
      this.queue.unshift(request);
      this.abortCurrent('replaced');
      return;
    }
    // A player's job that's only held still takes questions, changes and stops as usual.
    if (this.paused && !this.busy) {
      this.queue.push(request);
      this.say(`${player}, got it. I'll do that once I'm safe.`, to);
      return;
    }
    if (!this.busy) {
      this.start(request);
      return;
    }
    if (this.config.claude.busyReplies === false) {
      this.addToQueue(player, text, whisper);
      return;
    }
    this.busyReply(player, text, whisper).catch((err) => {
      this.log(`[brain] busy reply failed: ${err.message}`);
      this.addToQueue(player, text, whisper);
    });
  }

  // A full queue only turns away new jobs. Questions, stops and changes still get read.
  addToQueue(player, text, whisper = false) {
    const to = whisperTo(player, whisper);
    if (this.queue.length >= this.config.limits.queueSize) {
      this.say(`${player}, I'm busy and my queue is full. Try again in a bit.`, to);
      return;
    }
    this.queue.push({ player, text, whisper });
    this.say(`${player}, got it. I'll do that after my current job.`, to);
  }

  // A message that comes in mid-job gets a quick look without tools, so questions are answered
  // right away instead of waiting in the queue.
  async busyReply(player, text, whisper = false) {
    const to = whisperTo(player, whisper);
    const { claude } = this.config;
    const job = this.current;
    const model = this.modelFor('simple');
    const asked = Date.now();
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: 2000,
      system: this.systemBlocks,
      messages: [
        {
          role: 'user',
          content: `${this.snapshot()}\n\nYou are busy with ${job?.standing ? 'a round of the standing job' : 'a job'} from ${job?.player}: "${job?.text}".\n${player} just said: ${text}\n\n${BUSY_INSTRUCTIONS}`
        }
      ],
      output_config: { effort: 'low' }
    });
    this.recordBusyReply(job, player, text, response.model ?? model, response.usage, Date.now() - asked);
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    let word = reply.replace(/[^A-Za-z]/g, '').toUpperCase();
    // The word can come after a line of reasoning, which isn't for chat.
    const last = reply.match(/\b(QUEUE|UPDATE|ADD|NOW|STOP)\W*$/)?.[1];
    if (!BUSY_WORDS.includes(word) && last) word = last;
    // A lasting rule only answered in chat would be lost, so the running job gets it to save.
    if (reply && !BUSY_WORDS.includes(word) && isStandingOrder(text, this.config.bot.username)) word = 'ADD';
    if (!reply || word === 'QUEUE') {
      if (this.busy) this.addToQueue(player, text, whisper);
      else this.start({ player, text, whisper });
    } else if (word === 'UPDATE' || word === 'ADD') {
      if (job && this.current === job) this.addToJob(job, player, text, whisper, word === 'ADD');
      else if (this.busy) this.addToQueue(player, text, whisper);
      else this.start({ player, text, whisper });
    } else if (word === 'NOW') {
      if (this.busy) {
        this.queue.unshift({ player, text, whisper });
        this.say(`Okay ${player}, switching to that.`, to);
        this.abortCurrent('replaced');
      } else {
        this.start({ player, text, whisper });
      }
    } else if (word === 'STOP') {
      this.stop(to, player);
    } else {
      const line = chatPart(reply);
      if (line !== reply) this.log(`[brain] kept the sorting out of a mid-job reply: ${reply}`);
      if (line) this.say(line, to);
    }
  }

  // A reply that comes back after its job was logged gets a line of its own.
  recordBusyReply(job, player, text, model, usage, ms) {
    if (job?.record && !job.record.finished) {
      job.record.call('busy', model, usage, ms);
      this.warnCost(job);
      return;
    }
    const record = new JobRecord({ player, text });
    record.call('busy', model, usage, ms);
    this.writeRecord(record, 'busy_reply');
  }

  // Returns the line it wrote, or null.
  writeRecord(record, end, extra = {}) {
    try {
      const line = { ...record.finish(end), ...extra };
      this.log(summaryLine(line));
      this.jobLog?.write(line);
      return line;
    } catch (err) {
      this.log(`[joblog] couldn't record the job: ${err.message}`);
      return null;
    }
  }

  // After a player's job: one that went wrong is looked over for a lesson now, and one that went
  // fine waits a while in case the player says otherwise, then counts for the lessons it was shown.
  // One that only a correction could say anything about (cut off by another job, or every call
  // stopped from outside) waits too, but never counts for its lessons.
  afterJob(line, job) {
    if (!this.lessons || !line || job.self || this.closing) return;
    try {
      if (!reviewable(line)) return;
      this.endWait(job.player, true);
      if (worthLesson(line, job.corrections)) {
        this.review(line, job);
        return;
      }
      const timer = setTimeout(() => this.endWait(job.player, true), this.correctionWindowMs);
      timer.unref?.();
      this.waiting.set(job.player, { line, job, timer });
    } catch (err) {
      this.log(`[lessons] couldn't look at the job: ${err.message}`);
    }
  }

  // Stops waiting on a player's last job. Returns what was waiting, or null.
  endWait(player, wentFine) {
    const held = this.waiting.get(player);
    if (!held) return null;
    clearTimeout(held.timer);
    this.waiting.delete(player);
    if (wentFine && judgeable(held.line)) this.lessons.outcome(held.job.lessonIds, { ok: true });
    return held;
  }

  // A player saying the bot got something wrong. It goes with their job if it's running, or
  // else has their last job, if it ended a moment ago, looked over with it. An admin's correction
  // goes with anyone's job, the running one or else the last one to end.
  correct(player, text) {
    if (!this.lessons || this.closing) return;
    this.lessons.noteCorrection(text);
    const admin = isAdmin(this.config, player);
    const job = this.current;
    if (job && !job.self && (job.player === player || admin)) {
      job.corrections.push(text);
      return;
    }
    const whose = this.waiting.has(player) ? player : admin ? [...this.waiting.keys()].at(-1) : undefined;
    const held = whose === undefined ? null : this.endWait(whose, false);
    if (!held) return;
    held.job.corrections.push(text);
    this.review(held.line, held.job);
  }

  // A routine a player's job just did that earlier jobs did too, and no skill holds yet, is
  // pointed out once, in the first turn of the next job like it (see routineFor).
  noteRoutine(line, job) {
    if (!this.skillStore || !line || job.self || this.closing || !this.jobLog?.recent) return;
    try {
      const store = this.skillStore;
      const tools = repeatedRoutine(line, this.jobLog.recent(), { skills: store.skills, usable: (name) => store.schemas.has(name) });
      if (!tools || this.routinesShown.has(tools.join(' '))) return;
      this.routine = { tools, words: keywords(line.request, new Set([this.config.bot.username.toLowerCase()])), standing: job.standing?.started ?? null };
    } catch (err) {
      this.log(`[skills] couldn't look for a routine: ${err.message}`);
    }
  }

  // The routine line for a job's first turn, or ''. A round gets it when the last round of the
  // same standing job did the routine, and a player's job when its request shares two keywords
  // (or its one keyword) with the request that did it.
  routineFor(job, text) {
    const routine = this.routine;
    if (!routine || job.self) return '';
    let fits;
    if (job.standing) fits = routine.standing === job.standing.started;
    else {
      const want = keywords(text, new Set([this.config.bot.username.toLowerCase()]));
      const shared = want.filter((w) => routine.words.includes(w)).length;
      fits = routine.standing === null && want.length > 0 && shared >= Math.min(2, want.length);
    }
    if (!fits) return '';
    this.routine = null;
    this.routinesShown.add(routine.tools.join(' '));
    return routineHint(routine.tools);
  }

  // Each job is looked over at most once, and never holds up the jobs after it.
  review(line, job) {
    if (job.reviewed || this.closing) return;
    job.reviewed = true;
    try {
      if (judgeable(line)) this.lessons.outcome(job.lessonIds, { ok: false });
    } catch (err) {
      this.log(`[lessons] couldn't score the lessons: ${err.message}`);
    }
    this.learn(line, [...job.corrections]).catch((err) => {
      if (!this.closing) this.log(`[lessons] couldn't review the job: ${err.message}`);
    });
  }

  // One call to the quick model with no tools, which writes one lesson from the job or NONE.
  async learn(line, corrections) {
    const { config } = this;
    const model = this.modelFor('simple');
    const names = [config.bot.username, ...(config.allowlist ?? []), ...(config.admins ?? []), line.player].filter(Boolean);
    const controller = new AbortController();
    this.reviews.add(controller);
    const asked = Date.now();
    let response;
    try {
      const times = this.lessons.timesSaid(corrections);
      response = await this.client.beta.messages.create({ model, ...lessonRequest(line, corrections, { names, times }), output_config: { effort: 'low' } }, { signal: controller.signal });
    } finally {
      this.reviews.delete(controller);
    }
    if (this.closing) return;
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const text = parseLesson(reply, { names });
    const record = new JobRecord({ player: line.player, text: line.request });
    record.call('lesson', response.model ?? model, response.usage, Date.now() - asked);
    this.writeRecord(record, 'lesson', text ? { lesson: text } : {});
    if (!text) {
      this.log(`[lessons] nothing kept from that job: ${reply.replace(/\s+/g, ' ').slice(0, 200) || 'empty reply'}`);
      return;
    }
    const lesson = this.lessons.add(text, lessonMeta(line, corrections));
    this.log(`[lessons] ${lesson.text === text ? 'learned' : 'learned again'}: ${lesson.text}`);
  }

  // The process is on its way out, so nothing more is looked over or counted.
  close() {
    this.closing = true;
    for (const held of this.waiting.values()) clearTimeout(held.timer);
    this.waiting.clear();
    for (const controller of this.reviews) controller.abort();
  }

  // A job whose cost reaches limits.warnCostUsd gets a warning, and another each time that
  // doubles. It only warns: the job carries on and the model never hears about it.
  warnCost(job) {
    const limit = this.config.limits.warnCostUsd ?? 2;
    const cost = job?.record?.cost;
    // A call with no known price leaves the cost unknown, and an unknown cost gets no warning.
    if (!limit || cost === null || cost === undefined) return;
    // A player's job hears its warning once its first step has begun.
    if (!job.self && !job.tell) return;
    job.warnAt ??= limit;
    if (cost < job.warnAt) return;
    while (job.warnAt <= cost) job.warnAt *= 2;
    job.record.costWarnings++;
    this.log(`[brain] this job has cost $${cost.toFixed(2)} so far`);
    if (!job.self) {
      job.tell(`This job has cost about $${cost.toFixed(2)} so far. Say stop if you want me to end it.`).catch((err) => {
        this.log(`[brain] couldn't send the cost warning: ${err.message}`);
      });
    }
  }

  // More instructions for the job in progress. The tool that's running stops, so the model sees
  // them before it does anything else, unless they can wait: then they go in with its result,
  // or once it has run NOTE_WAIT_MS past the first of them with no change to its progress line.
  // A tool still getting somewhere runs on until it ends or reaches its own ceiling.
  addToJob(job, player, text, whisper = false, canWait = false) {
    job.notes.push({ player, text, whisper });
    const tool = job.tool;
    const waits = Boolean(canWait && tool && !tool.signal.aborted);
    if (!waits) tool?.abort('update');
    else if (!job.noteTimer) {
      this.log(`[brain] the note from ${player} waits for the running tool to finish`);
      const watch = job.toolWatch;
      const due = () => {
        const moved = watch?.progressAt?.() ?? null;
        const left = moved === null ? 0 : moved + NOTE_WAIT_MS - Date.now();
        if (left > 0) {
          this.log('[brain] the tool is still making progress, so the note waits on');
          job.noteTimer = setTimeout(due, left);
          return;
        }
        this.log(`[brain] the tool ran ${NOTE_WAIT_MS / 1000}s past a waiting note${moved === null ? '' : ' without progress'}, stopping it`);
        tool.abort('update');
      };
      job.noteTimer = setTimeout(due, NOTE_WAIT_MS);
    }
    this.say(waits ? `Okay ${player}, I'll work that in after this step.` : `Okay ${player}, I'll work that in.`, whisperTo(player, whisper));
  }

  // What the model was told is kept, so a job that starts over on another model hears it too.
  takeNotes(job) {
    const blocks = job.notes.splice(0).map(({ player, text }) => {
      job.heard.push(player);
      const lasting = !job.self && isStandingOrder(text, this.config.bot.username);
      if (lasting) job.rules.push({ player, text });
      return { type: 'text', text: `While you were working, ${player} said: ${text}\n${lasting ? LASTING_NOTE : WORK_IN}` };
    });
    job.told.push(...blocks.map((b) => b.text));
    return blocks;
  }

  // Who a remember call is saved for, or undefined for the job's player. A note may be what another
  // player said mid-job, so it goes to them, and when that's unclear to the least trusted of those
  // who could have said it: never with more say than its real sender had.
  rememberFor(job) {
    if (job.self) return undefined;
    const senders = [...new Set([...job.rules.slice(job.savedRules).map((r) => r.player), ...job.heard])];
    if (!senders.some((p) => p !== job.player)) return undefined;
    if (!isAdmin(this.config, job.player) && !senders.includes(job.player)) senders.push(job.player);
    if (senders.length === 1) return senders[0];
    return senders.find((p) => !isAdmin(this.config, p)) ?? senders.find((p) => p !== job.player);
  }

  // Notes go at the end of the next message to the model.
  deliverNotes(job, messages) {
    const turn = openTurn(messages);
    if (job.notes.length === 0 || !turn) return;
    appendBlocks(turn, this.takeNotes(job));
  }

  // Notices from the bot's own side (steps running out, what happened during a hold) go in a
  // system message after the last user turn where the model takes one, or else at the end of
  // that turn. Returns true when it added a new system message.
  addNotices(messages, notices, model) {
    if (notices.length === 0) return false;
    const text = notices.join('\n\n');
    const last = messages.at(-1);
    if (last.role === 'system') last.content += `\n\n${text}`;
    else if (last.role !== 'user') messages.push({ role: 'user', content: text });
    else if (this.systemMessages && hasSystemMessages(model)) {
      messages.push({ role: 'system', content: text });
      return true;
    } else appendBlocks(last, [{ type: 'text', text }]);
    return false;
  }

  // Moves the system notice at the end into the user turn before it.
  foldNotice(messages) {
    const notice = messages.pop();
    appendBlocks(messages.at(-1), [{ type: 'text', text: notice.content }]);
  }

  // A stop pauses the standing job too. by is who said it, when known.
  stop(to = null, by = null) {
    this.queue = [];
    this.abortCurrent('stop');
    this.onStop();
    const paused = this.pauseStanding(by ? `${by} said stop` : 'a player said stop');
    this.say(paused ? STOPPED_STANDING : 'Stopped.', to);
  }

  abortCurrent(reason) {
    if (this.current) this.current.controller.abort(reason);
  }

  // Something urgent comes first (low health, water, lava or fire, a lost connection). A player's
  // job is held: the tool it's running stops, the model's next steps wait until resume(), and then
  // it carries on in the same conversation. Free time just ends. Nothing new starts while anything
  // is held.
  async pause(reason = 'danger') {
    this.holds.add(reason);
    const job = this.current;
    if (!job) return;
    if (job.self) {
      job.controller.abort(reason);
      await Promise.race([job.done, wait(5000)]);
      return;
    }
    job.heldFor = reason;
    job.doneThinking?.();
    if (!job.hold) {
      let release;
      const done = new Promise((resolve) => (release = resolve));
      job.hold = { since: Date.now(), done, release };
      job.record.holds++;
      job.clock?.hold('hold');
    }
    job.tool?.abort(reason);
    if (job.running) await Promise.race([job.running.catch(() => {}), wait(5000)]);
  }

  // report says what happened during the hold, for the job to read when it carries on.
  resume(reason = 'danger', report = null) {
    this.holds.delete(reason);
    if (reason === 'offline') this.roundAfter = Date.now() + AFTER_SPAWN_MS;
    const job = this.current;
    if (report && job?.hold) job.reports.push(report);
    if (this.paused) return;
    if (job?.hold) this.release(job);
    if (this.busy) return;
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  release(job) {
    const { since, release } = job.hold;
    job.hold = null;
    job.record.heldMs += Date.now() - since;
    job.clock?.release('hold');
    release();
  }

  // Waits while the job is held, or until it's stopped.
  async waitWhileHeld(job, signal) {
    while (job.hold && !signal.aborted) {
      await new Promise((resolve) => {
        const stopped = () => resolve();
        signal.addEventListener('abort', stopped, { once: true });
        job.hold.done.then(() => {
          signal.removeEventListener('abort', stopped);
          resolve();
        });
      });
    }
  }

  // Waits, for at most ms, until the current job has ended and written its log line.
  async settle(ms) {
    const job = this.current;
    if (!job) return;
    let timer;
    await Promise.race([job.done, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  // A job the bot picks for itself when nobody needs it.
  freeTime() {
    if (this.busy || this.paused || this.queue.length > 0 || this.standingActive) return false;
    this.lastFreeTime = Date.now();
    this.start({ player: null, text: null, self: true });
    return true;
  }

  start(request) {
    if (this.paused) {
      this.queue.push(request);
      return Promise.resolve();
    }
    const controller = new AbortController();
    const job = {
      controller,
      done: null,
      player: request.player,
      text: request.text,
      self: Boolean(request.self),
      whisper: Boolean(request.whisper),
      reflex: request.reflex ?? null,
      // The death a trip back is for, and whether this is the request she died doing, back again.
      recovery: request.recovery ?? null,
      resumed: Boolean(request.resumed),
      // For a round of the standing job, what it was when the round began, whether the round
      // called progress, and whether it paused or ended the standing job.
      standing: request.standing ?? null,
      standingProgress: false,
      standingChanged: false,
      notes: [...(request.notes ?? [])],
      reports: [],
      // Notes and hold reports the model has been given, and the actions the job has run.
      told: [],
      ran: [],
      tool: null,
      toolWatch: null,
      running: null,
      noteTimer: null,
      clock: null,
      hold: null,
      heldFor: null,
      tell: null,
      doneThinking: null,
      // The cost that gets the next warning.
      warnAt: null,
      // Players saying it went wrong, the lessons it was given at the start, the ids of every
      // lesson it was shown, and the tools whose lessons it got when they failed.
      corrections: [],
      lessons: null,
      lessonIds: [],
      lessonTools: new Set(),
      reviewed: false,
      // Lasting rules players gave in this job, and how many of them a remember call came after.
      rules: !request.self && !request.standing && isStandingOrder(request.text, this.config.bot.username) ? [{ player: request.player, text: request.text }] : [],
      savedRules: 0,
      // Who gave the notes delivered since the last remember call.
      heard: [],
      // Whether a bigger model took the job over, and the extra calls spent on refused steps.
      handedOver: false,
      refusalRetries: 0,
      // Whether the job runs without the carried-over parts of its first turn, the model trying
      // that after a refusal, and when the remembered requests it carried were read.
      lean: false,
      leanTry: null,
      carriedAt: null
    };
    job.record = new JobRecord({ player: request.player, text: request.text, self: job.self, reflex: job.reflex, standing: Boolean(job.standing), recovery: Boolean(job.recovery) });
    this.current = job;
    job.done = Promise.resolve()
      .then(() => this.onJobStart?.(job))
      .catch(() => {})
      .then(() => this.handle(request, controller.signal, job))
      .catch((err) => {
        this.log(`[brain] request crashed: ${err.stack ?? err.message}`);
        if (!job.self) this.say('Something went wrong on my end.', whisperTo(job.player, job.whisper));
        job.record.end = 'crash';
        job.record.error = err.message;
      })
      .finally(() => {
        if (job.hold) this.release(job);
        const end = controller.signal.aborted ? controller.signal.reason : (job.record.end ?? 'done');
        const line = this.writeRecord(job.record, end);
        this.afterJob(line, job);
        this.noteRoutine(line, job);
        if (job.standing) {
          try {
            this.endRound(job, end);
          } catch (err) {
            this.log(`[standing] couldn't count the round: ${err.message}`);
          }
        }
        this.lastJob = { player: job.player, text: job.text, self: job.self, standing: Boolean(job.standing), end, at: Date.now(), tier: job.tier };
        this.current = null;
        this.lastJobEnd = Date.now();
        // Instructions the job never got to, like when it ran out of time, become requests of their own.
        // On a replacement they go after the job that took its place.
        const reason = controller.signal.aborted ? controller.signal.reason : null;
        const left = job.notes.map(({ player, text, whisper }) => ({ player, text, whisper }));
        if (reason === null || reason === 'time') this.queue.unshift(...left);
        else if (reason === 'replaced') this.queue.splice(1, 0, ...left);
        if (this.paused) return;
        const next = this.queue.shift();
        if (next) this.start(next);
      });
    return job.done;
  }

  // Tells onThinking a step of job has gone to the model, and returns the function that says
  // it's over, which only does anything the first time.
  startThinking(job) {
    const tell = (active) => {
      try {
        this.onThinking?.(active, job);
      } catch (err) {
        this.log(`[brain] onThinking failed: ${err.message}`);
      }
    };
    tell(true);
    let thinking = true;
    return () => {
      if (!thinking) return;
      thinking = false;
      tell(false);
    };
  }

  endedByAbort(signal, self = false, tell = (line) => this.say(line)) {
    const reason = signal.reason;
    if (reason === 'time') {
      this.onStop();
      if (!self) tell('I ran out of time on that one.');
    }
    // 'stop' already confirmed in chat, 'death' and 'shutdown' are reported elsewhere, 'danger',
    // 'hazard' and 'offline' only end free time, and 'replaced' needs nothing.
  }

  // One job, step by step (see brainsteps.js). A job that starts over on another model gets a
  // call of its own, with the same job.
  async handle(request, signal, job = { notes: [], reports: [], told: [], ran: [], corrections: [], lessons: null, lessonIds: [], lessonTools: new Set(), rules: [], savedRules: 0, heard: [], handedOver: false, refusalRetries: 0, lean: false, leanTry: null, carriedAt: null }) {
    const run = openRun(this, request, signal, job);
    await this.waitWhileHeld(job, signal);
    if (signal.aborted) return run.ended();
    startRun(this, run);
    try {
      firstTurn(this, run);
      for (run.step = 1; run.step <= run.maxSteps; run.step++) {
        const next = await runStep(this, run);
        if (next === AGAIN) run.step--;
        else if (next !== NEXT) return next;
      }
      if (run.record) run.record.end = 'steps';
      if (!run.self) await run.speak('I ran out of steps on that one.');
    } finally {
      run.clock.end();
    }
  }
}

// Parts of the class that live in files of their own, put on it as if written here.
for (const methods of [routeMethods, apiMethods, deathMethods, standingMethods]) {
  for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(methods))) Object.defineProperty(Brain.prototype, name, { ...desc, enumerable: false });
}
