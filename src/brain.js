import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from './tools.js';
import { BRAIN_TOOLS } from './braintools.js';
import { systemPrompt } from './prompt.js';
import { JobRecord, summaryLine } from './joblog.js';
import { ago } from './areas.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL_TOOLS = [...TOOLS, ...BRAIN_TOOLS];
// "build" as something to do, not as a noun ("the build") or about one that's done ("did you build").
const BUILD_VERB = /(?<!\b(?:the|your|my|our|this|that|his|her|their|a)\s+)(?<!\b(?:did|have|has|had)\s+(?:you|she|he|we|they|i)\s+)\b(?:re)?(?:build|construct)\b/i;
// "make me a small house", but not "make a door for the house".
const MAKE_STRUCTURE = /\b(?:make|put up|set up|raise)\b(?:\s+(?!(?:in|at|near|by|to|for|from|of|on|inside|behind|next|beside|around|into|with|under)\b)[\w']+){0,4}?\s+(?:house|hut|cabin|shelter|tower|bridge|castle|barn|shed|wall|fort)s?\b/i;
const BUILD_TOOLS = new Set(['build_house', 'build_structure']);
// Time inside a tool doesn't count against the job, but one call is stopped after this long, so a
// tool that hangs still ends. Build tools get longer.
const TOOL_SECONDS = 1800;
const BUILD_TOOL_SECONDS = 3600;
// Plan notes go to chat at most this often, so quick steps don't flood it.
const PLAN_GAP_MS = 8000;
// The model is told once, when this many steps are left, so it can finish up.
const STEPS_WARNING = 3;
const STEPS_LEFT = `This job has ${STEPS_WARNING} steps left, this one included. Use them to finish up, or to tell the player what is still left to do.`;

// Why a held job stopped its tool, as the model is told it.
const HOLD_CAUSES = {
  danger: 'you had to look after yourself',
  offline: 'the connection to the server dropped'
};

const BUSY_INSTRUCTIONS = `Decide what to do with the new message. Reply with exactly one of:
- QUEUE, if it asks you to do something new once your current job is done, or you can't tell.
- UPDATE, if it changes or adds to the job you're doing now (a size, a side, a spot, materials, one more thing to include), so you work it in right away.
- NOW, if they want you to drop the current job and do the new thing right away.
- STOP, if they want you to stop or cancel the current job.
- Otherwise, when it's a question or chat you can answer from the snapshot (what you're doing, how it's going, where something is), your short chat reply to them, one or two sentences.`;

const FREE_TIME = `Nobody has asked you for anything right now, so you have some free time. If there is something small and useful you'd like to do on your own, do it in a few steps. For example: smelt ores you carry, craft a tool you're missing, put spare items away in the right chests, gather a little wood, stone or food for later, or check on your house. Stay within about 32 blocks, never break or change anything players built, and don't start anything long. Don't chat unless you have something worth saying. If nothing is worth doing, reply with only: nothing`;

// Building takes more thought and more time than most jobs. Only requests that ask for something
// to be built count; "go to your house" doesn't.
export function isBuildRequest(text) {
  return BUILD_VERB.test(text) || MAKE_STRUCTURE.test(text);
}

// Goes after the request when the quick model starts a job, so it does simple jobs itself and
// hands the rest up. It can't go in the system prompt, which every model shares.
const SORTING = `Before you start, sort this request by how much thinking it needs:
- Simple, one or two obvious actions (come here, follow me, stop following, look at something, give or drop an item, eat, sleep, or just chatting and answering a question): do it yourself now.
- Otherwise call escalate as the only call in your response: normal for everyday jobs of a few steps (mining, chopping, gathering, crafting, smelting, storing or fetching items, fighting, going somewhere, recording an area), complex for anything that needs a plan or taste (building, designing, changing or fixing a build, decorating, carrying on with a build, or a long job with many parts). When unsure, complex.
- If a job you started yourself turns out to need more than that, call escalate then, the same way.`;
const HANDED_OVER = 'This job has been handed to you, so do it yourself from here and leave the sorting above aside: escalate is not for you.';
const NOT_YOURS = 'Not done: this job is yours to do. Carry on with it yourself.';
const EARLIER_FAILED = 'Not done, because an earlier action in this response failed (see above).';

// Smaller models reject the strict grammar once there are many tools, and only the bigger ones
// have the server-side refusal fallback.
const isSmallModel = (model) => /haiku/.test(model);
const hasFallback = (model) => /opus|fable|mythos/.test(model);
const strictTools = (claude, model) => claude.strictTools && !isSmallModel(model);
// Models that take a role: "system" message partway through the conversation.
const hasSystemMessages = (model) => /opus-5|opus-4-8|fable|mythos|sonnet-5-5|haiku-5-5/.test(model);

const whisperTo = (player, whisper) => (whisper ? player : null);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// The user turn the next request ends with, before any system notice that follows it.
function openTurn(messages) {
  let i = messages.length - 1;
  while (i > 0 && messages[i].role === 'system') i--;
  return messages[i].role === 'user' ? messages[i] : null;
}

// What a job that starts over on another model has already been through, so the players'
// changes aren't lost and nothing gets done twice.
function carriedOver(job) {
  const parts = [...job.told];
  if (job.ran.length) parts.push(`This job was started on another model, which already ran: ${job.ran.join('; ')}. Don't repeat the ones that worked.`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

function appendBlocks(message, blocks) {
  message.content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }, ...blocks] : [...message.content, ...blocks];
}

// Counts the time a job spends on its own (the model thinking, the steps in between), but not
// inside tools or while the job is held, and calls onTimeout once that passes the limit.
class JobClock {
  constructor(limitMs, onTimeout) {
    this.limit = limitMs;
    this.onTimeout = onTimeout;
    this.spent = 0;
    this.since = null;
    this.timer = null;
    this.holds = new Set();
  }

  get used() {
    return this.spent + (this.since === null ? 0 : Date.now() - this.since);
  }

  start() {
    if (this.since !== null || this.holds.size > 0) return;
    this.since = Date.now();
    this.timer = setTimeout(this.onTimeout, Math.max(this.limit - this.spent, 0));
  }

  stop() {
    clearTimeout(this.timer);
    this.spent = this.used;
    this.since = null;
  }

  hold(reason) {
    this.holds.add(reason);
    this.stop();
  }

  release(reason) {
    this.holds.delete(reason);
    this.start();
  }

  setLimit(ms) {
    this.limit = ms;
    if (this.since === null) return;
    this.stop();
    this.start();
  }

  end() {
    this.hold('end');
  }
}

const MAX_NUDGES = 2;
const CARRY_ON = "You ended your turn by saying what you'll do next, but nothing happens until you do it. Carry on now with your tools, and only reply when the whole job is done or you really need an answer from a player. If you are in fact finished, or waiting on the players, reply with one short sentence saying so.";

const FINISH_MORE = "Not done: you said you'd carry on, so do it now with your tools. If you are in fact finished or waiting on a player, finish with a line that says so. Your message wasn't sent.";
const OR_ESCALATE = 'If it needs a model that thinks more, call escalate as the only call.';

const SAYS_NEXT = /\b(next|then|after that)\b[^.!]{0,40}\b(I'll|I will|I'm|I am)\b|\b(I'll|I will|I'm going to|I am going to)\b[^.!]{0,20}\b(next|now)\b|\b(is|are) next\b|\bnext (up|is|are)\b/i;
const GETS_ON = /\b(I'll|I will|I'm going to|I am going to|let me)\s+(?:just |now |then |also |first )?(?:go ahead|get (?:started|going|to work)|start|begin|carry on|continue|keep going|head|build|make(?! sure)|craft|mine|chop|dig|gather|grab|fetch|bring|put|place|add|use|fill|patch|fix|finish|work on|take|store|smelt)\b/i;
// "If you drop me some dirt, I'll build it", "I'll take the ingots out later".
const WAITS = /\bif\b|\b(when|once|whenever) you\b|\blater\b/i;

// A final reply that only says what comes next ("Next I'll do the shutters.", "The west wall is
// next.", "I'll go ahead and build it.") rather than finishing, asking something, or waiting on
// someone.
export function announcesMore(reply) {
  if (!reply || reply.includes('?')) return false;
  return reply.split(/(?<=[.!])\s+/).some((s) => !WAITS.test(s) && (SAYS_NEXT.test(s) || GETS_ON.test(s)));
}

const ENDS = {
  done: 'you ended it with your reply',
  stop: 'a player stopped it',
  time: 'it ran out of time',
  steps: 'it ran out of steps',
  replaced: 'it gave way to another job',
  death: 'you died'
};

// What came before this job, so a question like "what are you doing?" gets a true answer.
export function lastJobLine(last, now = Date.now()) {
  if (!last) return '';
  const what = last.self ? 'your own free time' : `${last.player}'s request "${last.text}"`;
  return `Your last job, ${what}, ended ${ago(now - last.at)}: ${ENDS[last.end] ?? last.end.replaceAll('_', ' ')}. No job is running besides this one.`;
}

export function errorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "I couldn't reach my brain: the API key was rejected.";
  }
  if (err instanceof Anthropic.RateLimitError) return 'My brain is rate limited right now. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "I couldn't reach my brain (connection problem).";
  return 'Something went wrong talking to my brain.';
}

export class Brain {
  // runTool(name, input, signal) returns { ok, message }. snapshot() returns the game state text.
  // onJobStart() runs (and is awaited) before each job, beforeStep() before each model call.
  // watchTool(name, controller) watches a running tool and returns { stop(), report() }.
  // jobLog, if given, gets one line per job with its timings, tokens and cost.
  constructor({ client, config, runTool, snapshot, say, onStop, onJobStart, beforeStep, watchTool, jobLog, log = console.log }) {
    this.client = client;
    this.config = config;
    this.runTool = runTool;
    this.snapshot = snapshot;
    this.say = say;
    this.onStop = onStop ?? (() => {});
    this.onJobStart = onJobStart;
    this.beforeStep = beforeStep;
    this.watchTool = watchTool;
    this.log = log;
    this.jobLog = jobLog;
    this.lastPlanAt = 0;
    this.queue = [];
    this.current = null;
    // Why jobs are on hold right now ('danger', 'offline'). Nothing carries on until it's empty.
    this.holds = new Set();
    // Turned off for good if the API ever turns down a mid-conversation system message.
    this.systemMessages = true;
    this.lastJobEnd = Date.now();
    this.lastFreeTime = Date.now();
    this.lastJob = null;
    this.system = systemPrompt(config.bot.username, config.admins ?? []);
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

  // A request that came in by whisper gets its replies by whisper too.
  enqueue(player, text, whisper = false) {
    const to = whisperTo(player, whisper);
    // Free time gives way to players right away.
    if (this.current?.self) {
      this.queue.unshift({ player, text, whisper });
      this.abortCurrent('replaced');
      return;
    }
    // A player's job that's only held still takes questions, changes and stops as usual.
    if (this.paused && !this.busy) {
      this.queue.push({ player, text, whisper });
      this.say(`${player}, got it. I'll do that once I'm safe.`, to);
      return;
    }
    if (!this.busy) {
      this.start({ player, text, whisper });
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
          content: `${this.snapshot()}\n\nYou are busy with a job from ${job?.player}: "${job?.text}".\n${player} just said: ${text}\n\n${BUSY_INSTRUCTIONS}`
        }
      ],
      output_config: { effort: 'low' }
    });
    this.recordBusyReply(job, player, text, response.model ?? model, response.usage, Date.now() - asked);
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const word = reply.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!reply || word === 'QUEUE') {
      if (this.busy) this.addToQueue(player, text, whisper);
      else this.start({ player, text, whisper });
    } else if (word === 'UPDATE') {
      if (job && this.current === job) this.addToJob(job, player, text, whisper);
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
      this.stop(to);
    } else {
      this.say(reply, to);
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

  writeRecord(record, end) {
    try {
      const line = record.finish(end);
      this.log(summaryLine(line));
      this.jobLog?.write(line);
    } catch (err) {
      this.log(`[joblog] couldn't record the job: ${err.message}`);
    }
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
  // them before it does anything else.
  addToJob(job, player, text, whisper = false) {
    job.notes.push({ player, text, whisper });
    job.tool?.abort('update');
    this.say(`Okay ${player}, I'll work that in.`, whisperTo(player, whisper));
  }

  // What the model was told is kept, so a job that starts over on another model hears it too.
  takeNotes(job) {
    const blocks = job.notes
      .splice(0)
      .map(({ player, text }) => ({ type: 'text', text: `While you were working, ${player} said: ${text}\nWork this into the job you're doing now.` }));
    job.told.push(...blocks.map((b) => b.text));
    return blocks;
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

  stop(to = null) {
    this.queue = [];
    this.abortCurrent('stop');
    this.onStop();
    this.say('Stopped.', to);
  }

  abortCurrent(reason) {
    if (this.current) this.current.controller.abort(reason);
  }

  // Something urgent comes first (low health, a lost connection). A player's job is held: the
  // tool it's running stops, the model's next steps wait until resume(), and then it carries on
  // in the same conversation. Free time just ends. Nothing new starts while anything is held.
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
    if (this.busy || this.paused || this.queue.length > 0) return false;
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
      notes: [...(request.notes ?? [])],
      reports: [],
      // Notes and hold reports the model has been given, and the actions the job has run.
      told: [],
      ran: [],
      tool: null,
      running: null,
      clock: null,
      hold: null,
      heldFor: null,
      tell: null,
      // The cost that gets the next warning.
      warnAt: null
    };
    job.record = new JobRecord({ player: request.player, text: request.text, self: job.self });
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
        this.writeRecord(job.record, end);
        this.lastJob = { player: job.player, text: job.text, self: job.self, end, at: Date.now() };
        this.current = null;
        this.lastJobEnd = Date.now();
        // Instructions the job never got to, like when it ran out of time, become requests of their own.
        const reason = controller.signal.aborted ? controller.signal.reason : null;
        if (reason === null || reason === 'time') this.queue.unshift(...job.notes.map(({ player, text, whisper }) => ({ player, text, whisper })));
        if (this.paused) return;
        const next = this.queue.shift();
        if (next) this.start(next);
      });
    return job.done;
  }

  // Jobs go to a model by how much thinking they need: simple ones (and sorting jobs and messages
  // that come in mid-job) to the quick model, everyday chores to the everyday model, and building
  // or anything that needs a plan to the main one. With routing off, everything uses the main model.
  modelFor(tier) {
    const { claude } = this.config;
    if (claude.routing !== true) return claude.model;
    if (tier === 'simple') return claude.quickModel ?? claude.model;
    if (tier === 'normal') return claude.everydayModel ?? claude.model;
    return claude.model;
  }

  // The tier a new job starts on. With routing on, a player's job starts on the quick model,
  // which does simple jobs itself and hands the rest up (builds skip that), and free time runs
  // on the everyday model.
  firstTier({ text, self, tier }) {
    if (tier) return tier;
    if (this.config.claude.routing !== true) return 'complex';
    if (self) return 'normal';
    return isBuildRequest(text) ? 'complex' : 'simple';
  }

  createMessage(messages, signal, effort = this.config.claude.effort, model = this.config.claude.model) {
    const { claude } = this.config;
    const params = {
      model,
      max_tokens: claude.maxTokens,
      system: this.systemBlocks,
      tools: strictTools(claude, model) ? ALL_TOOLS : ALL_TOOLS.map(({ strict, ...rest }) => rest),
      messages,
      output_config: { effort },
      cache_control: { type: 'ephemeral' }
    };
    if (claude.fallback && hasFallback(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    return this.client.beta.messages.create(params, { signal });
  }

  logUsage(step, usage) {
    if (!usage) return;
    this.log(
      `[claude] step ${step}: input ${usage.input_tokens}, cache read ${usage.cache_read_input_tokens ?? 0}, ` +
        `cache write ${usage.cache_creation_input_tokens ?? 0}, output ${usage.output_tokens}`
    );
  }

  endedByAbort(signal, self = false, tell = (line) => this.say(line)) {
    const reason = signal.reason;
    if (reason === 'time') {
      this.onStop();
      if (!self) tell('I ran out of time on that one.');
    }
    // 'stop' already confirmed in chat, 'death' and 'shutdown' are reported elsewhere, 'danger'
    // and 'offline' only end free time, and 'replaced' needs nothing.
  }

  async handle(request, signal, job = { notes: [], reports: [], told: [], ran: [] }) {
    const { player, text, self = false, whisper = false } = request;
    const { limits, claude, idle } = this.config;
    const record = job.record;
    const to = whisperTo(player, whisper);
    // Nothing said while the bot is offline gets through, so a line waits out a hold. A stop or a
    // replacing job drops it.
    const tell = async (line) => {
      await this.waitWhileHeld(job, signal);
      if (!signal.aborted) this.say(line, to);
    };
    job.tell = tell;
    const ended = () => this.endedByAbort(signal, self, (line) => this.say(line, to));
    await this.waitWhileHeld(job, signal);
    if (signal.aborted) return ended();
    let tier = this.firstTier(request);
    // The quick model can hand the job up until it does, or until another model takes it over.
    let sorting = claude.routing === true && !request.tier && tier === 'simple';
    // Whether the conversation still asks for sorting with nothing saying it's over.
    let sortingAsked = sorting;
    job.tier = tier;
    let model = this.modelFor(tier);
    let build = !self && isBuildRequest(text);
    const buildSeconds = limits.buildMaxSeconds ?? 1200;
    const buildSteps = limits.buildMaxSteps ?? 40;
    const buildEffort = claude.buildEffort ?? 'high';
    const moreEffort = EFFORTS.indexOf(buildEffort) > EFFORTS.indexOf(claude.effort) ? buildEffort : claude.effort;
    const maxSeconds = self ? idle.freeTimeSeconds : build ? buildSeconds : limits.maxSeconds;
    let maxSteps = self ? idle.freeTimeSteps : build ? buildSteps : limits.maxSteps;
    let effort = build ? moreEffort : claude.effort;
    if (record) Object.assign(record, { tier, model, effort });
    // The time limit only counts time outside tools and holds.
    const clock = new JobClock(maxSeconds * 1000, () => this.current?.controller.abort('time'));
    job.clock = clock;
    if (job.hold) clock.hold('hold');
    clock.start();
    const using = claude.routing === true ? ` [${tier}, ${model}]` : '';
    this.log(self ? `[brain] free time${using}` : `[brain] request from ${player}: ${text}${build ? ' (build)' : ''}${whisper ? ' (whispered)' : ''}${using}`);
    let nudges = 0;
    let warned = false;

    try {
      const ask = self ? FREE_TIME : `Request from ${player}${whisper ? ' (whispered)' : ''}: ${text}`;
      const before = self || !this.lastJob ? '' : `\n\n${lastJobLine(this.lastJob)}`;
      const messages = [{ role: 'user', content: `${this.snapshot()}${before}\n\n${ask}${carriedOver(job)}${sorting ? `\n\n${SORTING}` : ''}` }];

      // A bigger model takes the job over. It carries on in the same conversation, without the
      // turn that handed it over, as long as the system prompt and tools stay byte-identical: the
      // new model reads the earlier thinking it can (the API drops, unbilled, any it can't), and the
      // last user turn can still take a note since nothing after it is kept. Otherwise the job
      // starts over on that tier. Returns the restarted job, or null to carry on.
      const handOver = (to, why) => {
        const next = this.modelFor(to);
        sorting = false;
        const sameTools = strictTools(claude, model) === strictTools(claude, next);
        if (sameTools && (hasSystemMessages(next) || !messages.some((m) => m.role === 'system'))) {
          this.log(`[brain] ${why}, handing it to ${next}`);
          messages.pop();
          if (sortingAsked) appendBlocks(openTurn(messages), [{ type: 'text', text: HANDED_OVER }]);
          sortingAsked = false;
          tier = to;
          job.tier = tier;
          model = next;
          if (record) Object.assign(record, { tier, model });
          return null;
        }
        this.log(`[brain] ${why}, starting over on ${next}`);
        clock.end();
        return this.handle({ ...request, tier: to }, signal, job);
      };

      for (let step = 1; step <= maxSteps; step++) {
        await this.waitWhileHeld(job, signal);
        if (signal.aborted) return ended();
        // A hold that begins after this makes the answer to this step out of date.
        const heldBefore = record?.holds ?? 0;
        await this.beforeStep?.();
        if (signal.aborted) return ended();
        this.deliverNotes(job, messages);
        const notices = [];
        const reports = job.reports.splice(0);
        if (reports.length) {
          job.told.push(reports.join(' '));
          notices.push(`${reports.join(' ')} Carry on with the job from here.`);
        }
        if (!self && !warned && step > 1 && step === maxSteps - STEPS_WARNING + 1) {
          warned = true;
          notices.push(STEPS_LEFT);
        }
        const newNotice = this.addNotices(messages, notices, model);

        let response;
        const asked = Date.now();
        try {
          // A bad request on a step with a new system notice is sent once more with the notice as
          // text. Only when that works was the notice the problem, and notices stay text from then
          // on. When it fails too, its error ends the job like any other.
          response = await this.createMessage(messages, signal, effort, model).catch(async (err) => {
            if (!newNotice || signal.aborted || !(err instanceof Anthropic.BadRequestError)) throw err;
            this.foldNotice(messages);
            const retried = await this.createMessage(messages, signal, effort, model);
            this.log(`[brain] the API turned down a mid-conversation system message (${err.message}). Sending notices as text from now on.`);
            this.systemMessages = false;
            return retried;
          });
        } catch (err) {
          if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return ended();
          this.log(`[brain] API error: ${err.message}`);
          if (record) Object.assign(record, { end: 'api_error', error: err.message });
          if (!self) await tell(errorMessage(err));
          return;
        }
        this.logUsage(step, response.usage);
        const logged = record?.step(response.model ?? model, response.usage, Date.now() - asked);
        this.warnCost(job);
        const outdated = () => (record?.holds ?? 0) > heldBefore;

        if (response.stop_reason === 'refusal') {
          if (record) record.end = 'refusal';
          if (!self) await tell("I can't help with that one.");
          return;
        }
        if (response.stop_reason === 'max_tokens') {
          if (record) record.end = 'max_tokens';
          if (!self) await tell('My answer got cut off. Try asking for something smaller.');
          return;
        }

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'pause_turn') continue;

        if (response.stop_reason !== 'tool_use') {
          const reply = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
          if (reply && !(self && /^nothing\W*$/i.test(reply))) {
            if (record) record.reply = reply.slice(0, 300);
            await tell(reply);
          }
          if (signal.aborted) return ended();
          // Something a player added during the last step still has to be worked in.
          if (job.notes.length) {
            messages.push({ role: 'user', content: this.takeNotes(job) });
            continue;
          }
          // A reply that only says what comes next would leave her standing there, so she
          // gets sent on to do it.
          if (!self && nudges < MAX_NUDGES && announcesMore(reply)) {
            nudges++;
            if (record) record.nudges = nudges;
            this.log('[brain] she said what comes next, sending her on');
            messages.push({ role: 'user', content: CARRY_ON });
            continue;
          }
          return;
        }

        // The quick model hands the job up, and none of that response's calls run.
        const escalate = response.content.find((b) => b.type === 'tool_use' && b.name === 'escalate');
        if (escalate && sorting) {
          const to = escalate.input?.to === 'normal' ? 'normal' : 'complex';
          logged?.tools.push({ name: 'escalate', ok: true, ms: 0, to });
          const restarted = handOver(to, `this is a ${to} job`);
          if (restarted) return restarted;
          continue;
        }

        // A job on a smaller model that turns out to be a build goes to the main model, which
        // makes the build call itself.
        const wantsBuild = !self && response.content.some((b) => b.type === 'tool_use' && BUILD_TOOLS.has(b.name));
        if (wantsBuild && tier !== 'complex' && model !== claude.model) {
          const restarted = handOver('complex', 'this needs building');
          if (restarted) return restarted;
          continue;
        }

        // The short note the model writes next to its tool calls says what it's about to do.
        const plan = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (plan) {
          this.log(`[brain] plan: ${plan}`);
          // A plan made before a hold won't be carried out, so it isn't said.
          if (!self && !outdated() && Date.now() - this.lastPlanAt >= PLAN_GAP_MS) {
            this.say(plan, to);
            this.lastPlanAt = Date.now();
          }
        }

        const results = [];
        const notDone = (block, content) => results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true });
        // Set when a hold stopped one of this response's tools, so the rest don't run on the old plan.
        let heldUp = null;
        // Calls run in order and stop at the first one that fails or is stopped, since later ones
        // usually depend on it.
        let failed = false;
        const calls = response.content.filter((b) => b.type === 'tool_use');
        for (const [i, block] of calls.entries()) {
          // Calls planned before a hold began don't run: the model hears what happened first.
          await this.waitWhileHeld(job, signal);
          if (signal.aborted) return ended();
          if (!heldUp && outdated()) heldUp = job.heldFor;
          if (job.notes.length) {
            notDone(block, 'Not done, because a player just changed the instructions (see below).');
            continue;
          }
          if (heldUp) {
            notDone(block, `Not done, because ${HOLD_CAUSES[heldUp]} (see below).`);
            continue;
          }
          if (failed) {
            notDone(block, block.name === 'finish' ? `${EARLIER_FAILED} Your message wasn't sent.` : EARLIER_FAILED);
            continue;
          }
          if (block.name === 'escalate') {
            logged?.tools.push({ name: 'escalate', ok: false, ms: 0, error: NOT_YOURS });
            notDone(block, NOT_YOURS);
            continue;
          }
          // Everything before it worked, so the job ends here without another model call.
          if (block.name === 'finish') {
            if (i < calls.length - 1) {
              notDone(block, "Not done: finish has to be the last call in a response. Your message wasn't sent.");
              continue;
            }
            const line = String(block.input?.message ?? '').trim();
            // Same as a plain reply: a line that promises more work isn't said, and she's sent on.
            if (!self && nudges < MAX_NUDGES && announcesMore(line)) {
              nudges++;
              if (record) record.nudges = nudges;
              logged?.tools.push({ name: 'finish', ok: false, ms: 0, error: `held back: ${line}`.slice(0, 300) });
              this.log(`[brain] finish said what comes next, sending her on: ${line}`);
              notDone(block, sorting ? `${FINISH_MORE} ${OR_ESCALATE}` : FINISH_MORE);
              continue;
            }
            logged?.tools.push({ name: 'finish', ok: true, ms: 0 });
            this.log(`[brain] finish: ${line}`);
            if (line && !(self && /^nothing\W*$/i.test(line))) {
              if (record) record.reply = line.slice(0, 300);
              await tell(line);
            }
            return;
          }
          const building = !self && BUILD_TOOLS.has(block.name);
          this.log(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
          // A job that turns into a build, like "carry on", gets the build budget from here on.
          if (building && !build) {
            build = true;
            maxSteps = Math.max(maxSteps, buildSteps);
            if (warned && maxSteps - step >= STEPS_WARNING) warned = false;
            effort = moreEffort;
            if (record) record.effort = effort;
            clock.setLimit(Math.max(clock.limit, buildSeconds * 1000));
            this.log('[brain] this job is a build now');
          }
          const tool = new AbortController();
          job.tool = tool;
          const watch = this.watchTool?.(block.name, tool);
          const toolSeconds = building ? BUILD_TOOL_SECONDS : TOOL_SECONDS;
          const ceiling = setTimeout(() => tool.abort('too_long'), toolSeconds * 1000);
          clock.hold('tool');
          let result;
          const ran = Date.now();
          try {
            const running = this.runTool(block.name, block.input, AbortSignal.any([signal, tool.signal]));
            job.running = running;
            result = await running;
          } finally {
            clearTimeout(ceiling);
            watch?.stop();
            job.tool = null;
            job.running = null;
            clock.release('tool');
          }
          // After a long build there's always a little time left to check on it.
          if (building) clock.setLimit(Math.max(clock.limit, clock.used + 120000));
          const why = tool.signal.aborted && !signal.aborted ? tool.signal.reason : null;
          let content = result.message;
          if (why === 'update') content += ' (Stopped because a player just changed the instructions, see below.)';
          if (why === 'stuck') content += ` (${watch?.report() ?? 'I stopped this myself: nothing was changing.'} Work out what's in the way before trying the same thing again.)`;
          if (why === 'too_long') content += ` (Stopped because one call can run for at most ${toolSeconds / 60} minutes.)`;
          if (HOLD_CAUSES[why]) {
            heldUp = why;
            content += ` (Stopped because ${HOLD_CAUSES[why]}, see below.)`;
          }
          this.log(`[tool] -> ${result.ok && !why ? 'ok' : 'failed'}: ${result.message}${why ? ` (${why})` : ''}`);
          const ok = Boolean(result.ok && !why);
          logged?.tools.push({ name: block.name, ok, ms: Date.now() - ran, ...(ok ? {} : { error: String(content).slice(0, 300) }) });
          const input = JSON.stringify(block.input ?? {});
          job.ran.push(`${block.name} ${input.length > 100 ? `${input.slice(0, 100)}...` : input}${result.ok && !why ? '' : ' (failed)'}`);
          if (!result.ok || why) failed = true;
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content,
            ...(result.ok && why !== 'stuck' ? {} : { is_error: true })
          });
        }
        if (signal.aborted) return ended();
        messages.push({ role: 'user', content: results });
      }

      if (record) record.end = 'steps';
      if (!self) await tell('I ran out of steps on that one.');
    } finally {
      clock.end();
    }
  }
}
