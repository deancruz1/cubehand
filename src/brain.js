import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { TOOLS } from './tools.js';
import { BRAIN_TOOLS } from './braintools.js';
import { systemPrompt } from './prompt.js';
import { JobRecord, summaryLine } from './joblog.js';
import { ago } from './areas.js';
import { asText, judgeable, reviewable, worthLesson, lessonMeta, lessonRequest, parseLesson, keywords, CORRECTION_WINDOW_MS } from './lessons.js';
import { repeatedRoutine, routineHint } from './skills.js';
import { isStandingOrder, workOrder, asksForThoughts, THOUGHT_SUMMARY } from './chat.js';
import { isAdmin } from './guard.js';
import { Standing } from './standing.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL_TOOLS = [...TOOLS, ...BRAIN_TOOLS];
// "build" as something to do, not as a noun ("the build") or about one that's done ("did you build").
const BUILD_VERB = /(?<!\b(?:the|your|my|our|this|that|his|her|their|a)\s+)(?<!\b(?:did|have|has|had)\s+(?:you|she|he|we|they|i)\s+)\b(?:re)?(?:build|construct)\b/i;
// "make me a small house", but not "make a door for the house".
const MAKE_STRUCTURE = /\b(?:make|put up|set up|raise)\b(?:\s+(?!(?:in|at|near|by|to|for|from|of|on|inside|behind|next|beside|around|into|with|under)\b)[\w']+){0,4}?\s+(?:house|hut|cabin|shelter|tower|bridge|castle|barn|shed|wall|fort)s?\b/i;
const BUILD_TOOLS = new Set(['build_house', 'build_structure']);
// A build_structure of at most this many blocks, counting every block in the box of each part, is
// a patch (filling a few ore holes, say), not a build: it runs on the model that asked for it,
// with the usual budget. A roof is never a patch.
const PATCH_BLOCKS = 24;
function isPatch(call) {
  if (call.name !== 'build_structure') return false;
  const { parts = [], blocks = [] } = call.input ?? {};
  if (!Array.isArray(parts) || !Array.isArray(blocks)) return false;
  let count = blocks.length;
  for (const part of parts) {
    if (part?.shape === 'roof' || !part?.from || !part?.to) return false;
    const side = (k) => Math.abs(Number(part.to[k]) - Number(part.from[k])) + 1;
    count += side('dx') * side('dy') * side('dz');
  }
  return count >= 1 && count <= PATCH_BLOCKS;
}
const isBuildCall = (call) => BUILD_TOOLS.has(call.name) && !isPatch(call);
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
- UPDATE, if it changes the job you're doing now so that what you're doing this moment is wrong or wasted (a size, a side, a spot, a level, materials, gone far enough), so you stop and work it in right away.
- ADD, if it adds to the job you're doing now but what you're doing this moment can finish first (one more thing to do or include, a rule for how to work, something to fix elsewhere, a name or note to keep), so you work it in after that. If unsure which, UPDATE.
- NOW, if they want you to drop the current job and do the new thing right away.
- STOP, if they want you to stop or cancel the current job.
- Otherwise, when it's a question or chat you can answer from the snapshot (what you're doing, how it's going, where something is), your short chat reply to them, one or two sentences.`;
const BUSY_WORDS = ['QUEUE', 'UPDATE', 'ADD', 'NOW', 'STOP'];
const REPLY_LABEL = /^\s*(?:chat\s+)?(?:reply|answer|response)\s*:\s*/i;
const SORTING_TALK = /\bchat (?:answer|reply|message)\b|\bso (?:it's|it is|this is) (?:a |just )?(?:chat|question)\b/i;
const SORTING_WORD = /\b(?:QUEUE|UPDATE|ADD|NOW|STOP)\b/;
// A note that can wait goes in with the result of the tool that's running, unless that tool runs
// on this long after the note came in.
const NOTE_WAIT_MS = 90000;

// The chat part of a mid-job reply. "Chat reply: their message is a compliment, so it's a chat
// answer. Thanks!" is only "Thanks!": the label and the sentences about sorting the message aren't
// for chat. Empty when nothing else is left.
export function chatPart(reply) {
  const sentences = reply.replace(REPLY_LABEL, '').split(/(?<=[.!?])\s+/);
  let i = 0;
  while (i < sentences.length && (SORTING_TALK.test(sentences[i]) || SORTING_WORD.test(sentences[i]))) i++;
  if (i === 0 && !REPLY_LABEL.test(reply)) return reply;
  return sentences.slice(i).join(' ').trim();
}

const FREE_TIME = `Nobody has asked you for anything right now, so you have some free time. If there is something small and useful you'd like to do on your own, do it in a few steps. For example: smelt ores you carry, craft a tool you're missing, put spare items away in the right chests, gather a little wood, stone or food for later, or check on your house. Stay within about 32 blocks, never break or change anything players built, and don't start anything long. Don't chat unless you have something worth saying. If nothing is worth doing, reply with only: nothing`;

// Building takes more thought and more time than most jobs. Only requests that ask for something
// to be built count; "go to your house" doesn't.
export function isBuildRequest(text) {
  return BUILD_VERB.test(text) || MAKE_STRUCTURE.test(text);
}

// Goes after the request when the quick model starts a job, so it does simple jobs itself and
// hands the rest up. It can't go in the system prompt, which every model shares.
const SORTING = `Before you start, sort this request by how much thinking it needs:
- Simple, one or two obvious actions (come here, follow me, stop following, look at something, give or drop an item, eat, sleep, save a place or a standing order (any rule for how to work) with remember, or just chatting and answering a question): do it yourself now.
- Otherwise call escalate as the only call in your response: normal for everyday jobs of a few steps (mining, chopping, gathering, crafting, smelting, storing or fetching items, fighting, going somewhere, recording an area), complex for anything that needs a plan or taste (building, designing, changing or fixing a build, decorating, carrying on with a build, or a long job with many parts). When unsure, complex.
- If a job you started yourself turns out to need more than that, call escalate then, the same way.`;
const HANDED_OVER = 'This job has been handed to you, so do it yourself from here and leave the sorting above aside: escalate is not for you.';
const NOT_YOURS = 'Not done: this job is yours to do. Carry on with it yourself.';
// Extra model calls a job may spend on refused steps.
const MAX_REFUSAL_RETRIES = 2;
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
// "If you drop me some dirt, I'll build it", "I'll take the ingots out later", "I'll dig it as
// soon as breaking works".
const WAITS = /\bif\b|\b(when|once|whenever) you\b|\blater\b|\b(?:once|when|as soon as|until)\s+(?!I\b|I'|I’)[^.!]{0,40}?\b(?:works?|working|fixed)\b/i;
// "Say the word and I'll start the next tunnel", "Tell me which line, and I'll dig it", but not
// "..., and I'll start the roof now".
const ON_ANSWER = /^(?:just )?(?:say the word|tell me|let me know|give me the word)\b[^.!]*?\band (?:I'll|I will)\b(?![^.!]*\bnow\b)/i;

// A rule meant to outlast the job only carries over in a memory, so a job that got one without
// saving it is held back once before it ends.
const WORK_IN = "Work this into the job you're doing now. If it's meant for later jobs too, save it with remember, in the note for that place or task.";
const LASTING_NOTE ="This is a lasting rule: work it into the job you're doing now, and save it with remember before you finish.";
const RULE_UNSAVED = (who) =>
  `${who} gave you a lasting rule, and your next job won't know it unless you save it. Save it now with remember, in words a later job will understand: what to do, where or when it applies, and who said it ("Standing order from ${who}: ..."). If a note for that place or task already exists, save it again under that name with the new rule added. If you may not save it, tell them so and why.`;
const NOT_ADMIN = (who) => `${who} isn't an admin, so it can only be kept as a note, not a standing order: tell them that.`;

// A final reply that only says what comes next ("Next I'll do the shutters.", "The west wall is
// next.", "I'll go ahead and build it.") rather than finishing, asking something, or waiting on
// someone.
export function announcesMore(reply) {
  if (!reply || reply.includes('?')) return false;
  return reply.split(/(?<=[.!])\s+/).some((s) => !WAITS.test(s) && !ON_ANSWER.test(s) && (SAYS_NEXT.test(s) || GETS_ON.test(s)));
}

const ENDS = {
  done: 'you ended it with your reply',
  stop: 'a player stopped it',
  time: 'it ran out of time',
  steps: 'it ran out of steps',
  replaced: 'it gave way to another job',
  death: 'you died'
};

// What the body already did on a reflex job (see reflex.js), before the model was asked.
const REFLEX_DONE = {
  come: (player) => `You already set off toward ${player} the moment they asked, so don't call a walk to them again. Just reply.`,
  follow: (player) => `You are already following ${player}, so don't call follow_player again. Just reply.`,
  stay: () => "You already stopped and are staying put, so don't call stop_moving. Just reply."
};

// Standing jobs (see standing.js): work she keeps doing in rounds, each a short job of its own.
const STANDING_DEFAULTS = { enabled: true, maxHours: 4, maxCostUsd: 5, sayEveryMin: 5 };
// Rounds wait this long after the last job, so the chores between them get a turn, and this long
// after the bot has joined the server.
const ROUND_GAP_MS = 3000;
const AFTER_SPAWN_MS = 10000;
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
const STOPPED_STANDING = 'Stopped. The standing job is paused too; say continue when you want me to carry on with it.';

// What came before this job, so a question like "what are you doing?" gets a true answer. A request
// for her reasoning only goes in as the neutral line the request log keeps for it.
export function lastJobLine(last, now = Date.now()) {
  if (!last) return '';
  const text = asksForThoughts(last.text) ? THOUGHT_SUMMARY : last.text;
  const what = last.self ? 'your own free time' : last.standing ? `a round of the standing job from ${last.player}` : `${last.player}'s request "${text}"`;
  return `Your last job, ${what}, ended ${ago(now - last.at)}: ${ENDS[last.end] ?? last.end.replaceAll('_', ' ')}. No job is running besides this one.`;
}

// The snapshot without what it carries from before the job: the remembered requests (from
// RequestLog.summary in chat.js) and the recent chat (from chatSummary in perception.js). Every
// other part stays exactly as it was.
const CARRIED_PARTS = [/^Recent requests to you\b/, /^Recent chat\b/];
export function leanSnapshot(snapshot) {
  return snapshot
    .split('\n\n')
    .filter((part) => !CARRIED_PARTS.some((re) => re.test(part)))
    .join('\n\n');
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
    // Why jobs are on hold right now ('danger', 'offline'). Nothing carries on until it's empty.
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

  get standingConfig() {
    return { ...STANDING_DEFAULTS, ...this.config.standing };
  }

  // The standing job, active or paused, or null when there is none or they are turned off.
  get standingJob() {
    return this.standingConfig.enabled === false ? null : this.standing.job;
  }

  // While this is true, rounds take the place of free time.
  get standingActive() {
    return this.standingJob?.state === 'active';
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
    // Free time gives way to players right away.
    if (this.current?.self) {
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
  // or once it has run NOTE_WAIT_MS past the first of them.
  addToJob(job, player, text, whisper = false, canWait = false) {
    job.notes.push({ player, text, whisper });
    const tool = job.tool;
    const waits = Boolean(canWait && tool && !tool.signal.aborted);
    if (!waits) tool?.abort('update');
    else if (!job.noteTimer) {
      this.log(`[brain] the note from ${player} waits for the running tool to finish`);
      job.noteTimer = setTimeout(() => {
        this.log(`[brain] the tool ran ${NOTE_WAIT_MS / 1000}s past a waiting note, stopping it`);
        tool.abort('update');
      }, NOTE_WAIT_MS);
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
  }

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
  }

  // Returns whether there was an active standing job to pause.
  pauseStanding(reason) {
    if (!this.standingActive) return false;
    this.standing.pause(reason);
    this.log(`[standing] paused: ${reason}`);
    return true;
  }

  // Dying pauses the standing job, and she says so once.
  died() {
    if (this.pauseStanding('I died')) this.say("I died, so I've paused the standing job. Say continue when you want me to pick it up again.");
  }

  // A bare "continue" from an admin while the standing job is paused carries it on, with no model
  // call. Returns whether it did.
  resumeOnContinue(player, text, to = null) {
    if (this.standingJob?.state !== 'paused' || !isAdmin(this.config, player) || workOrder(text, this.config.bot.username) !== 'continue') return false;
    this.standing.resume();
    this.log(`[standing] resumed by ${player}`);
    this.say(`Okay ${player}, carrying on with the standing job.`, to);
    if (this.current?.self) this.abortCurrent('replaced');
    return true;
  }

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
  }

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
  }

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
  }

  // The first turn's ask for a round.
  roundAsk(round) {
    return [
      `This is round ${round.number} of your standing job from ${round.by}.${round.restarted ? ` ${RESTARTED}` : ''}`,
      `Task: ${round.task}`,
      `Where it stands: ${round.progress}`,
      ROUND
    ].join('\n');
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
    job.record = new JobRecord({ player: request.player, text: request.text, self: job.self, reflex: job.reflex, standing: Boolean(job.standing) });
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
  // which does simple jobs itself and hands the rest up (builds skip that, and so does an obvious
  // work order, or a bare "continue" after one, which goes to the everyday model), and free time
  // and rounds of the standing job run on the everyday model.
  firstTier({ text, self, tier, reflex, standing }) {
    if (tier) return tier;
    if (this.config.claude.routing !== true) return 'complex';
    if (self || standing) return 'normal';
    if (isBuildRequest(text)) return 'complex';
    if (reflex) return 'simple';
    const order = workOrder(text, this.config.bot.username);
    const afterWork = this.lastJob && !this.lastJob.self && this.lastJob.tier === 'normal';
    return order === 'work' || (order === 'continue' && afterWork) ? 'normal' : 'simple';
  }

  // With claude.streaming on, the answer streams in and onEvent(event, message so far) hears each
  // part of it. Either way this resolves with the whole message.
  createMessage(messages, signal, effort = this.config.claude.effort, model = this.config.claude.model, onEvent = null) {
    const { claude } = this.config;
    const params = {
      model,
      max_tokens: claude.maxTokens,
      system: this.systemBlocks,
      tools: strictTools(claude, model) ? this.tools : this.looseTools,
      messages,
      output_config: { effort },
      cache_control: { type: 'ephemeral' }
    };
    if (claude.fallback && hasFallback(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    if (claude.streaming !== true) return this.client.beta.messages.create(params, { signal });
    const stream = this.client.beta.messages.stream(params, { signal });
    if (onEvent) stream.on('streamEvent', onEvent);
    // A refusal keeps the id of its request, as one from create() does, for the log.
    return stream.finalMessage().then((message) => {
      if (message?.stop_reason === 'refusal' && !message._request_id && stream.request_id) {
        try {
          Object.defineProperty(message, '_request_id', { value: stream.request_id, configurable: true });
        } catch {}
      }
      return message;
    });
  }

  // One console line for a refused step, and its full request in the refusal log. Returns the
  // refusal's category.
  noteRefusal(response, messages, model, effort, lean = false) {
    const details = response.stop_details ?? null;
    const category = details?.category ?? null;
    const by = response.model ?? model;
    const requestId = response._request_id ?? null;
    const path = this.refusalLog?.write({
      at: new Date().toISOString(),
      model: by,
      requestId,
      stopDetails: details,
      usage: response.usage ?? null,
      content: response.content,
      request: {
        model,
        effort,
        lean,
        fallbacks: Boolean(this.config.claude.fallback && hasFallback(model)),
        strictTools: strictTools(this.config.claude, model),
        system: { length: this.system.length, sha256: createHash('sha256').update(this.system).digest('hex') },
        tools: this.tools.map((t) => t.name),
        messages
      }
    });
    this.log(
      `[brain] refusal from ${by}: output ${response.usage?.output_tokens ?? 0}, category ${category ?? 'none'}` +
        `${details?.explanation ? ` (${details.explanation})` : ''}, request ${requestId ?? 'unknown'}${path ? `, saved to ${path}` : ''}`
    );
    return category;
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

  async handle(request, signal, job = { notes: [], reports: [], told: [], ran: [], corrections: [], lessons: null, lessonIds: [], lessonTools: new Set(), rules: [], savedRules: 0, heard: [], handedOver: false, refusalRetries: 0, lean: false, leanTry: null, carriedAt: null }) {
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
    // A round's own lines, which are said less often (see keptQuiet).
    const speak = async (line) => {
      if (!this.keptQuiet(job, line)) await tell(line);
    };
    const ended = () => this.endedByAbort(signal, self, (line) => this.keptQuiet(job, line) || this.say(line, to));
    await this.waitWhileHeld(job, signal);
    if (signal.aborted) return ended();
    let tier = this.firstTier(request);
    // A work order that skipped the quick model goes on as if that model had handed it up.
    if (!self && !request.tier && tier === 'normal') job.handedOver = true;
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
    this.log(
      self
        ? `[brain] free time${using}`
        : job.standing
          ? `[brain] standing job round ${job.standing.number} for ${player}${using}`
          : `[brain] request from ${player}: ${text}${build ? ' (build)' : ''}${whisper ? ' (whispered)' : ''}${using}`
    );
    let nudges = 0;
    let warned = false;
    // On a reflex job the first "On my way, I'll be right there" is about what the body is
    // already doing, so it isn't held back as a promise of more work.
    let excused = Boolean(job.reflex);
    const promisesMore = (line) => {
      if (!announcesMore(line)) return false;
      if (!excused) return true;
      excused = false;
      return false;
    };
    // The rules given since the last remember call and the last time the job was held for them.
    let rulesHeld = 0;
    const unsavedRules = () => (self ? [] : job.rules.slice(Math.max(job.savedRules, rulesHeld)));
    const ruleNudge = () => {
      const names = [...new Set(unsavedRules().map((r) => r.player))];
      rulesHeld = job.rules.length;
      const strangers = names.filter((name) => !isAdmin(this.config, name));
      const text = RULE_UNSAVED(names.join(' and '));
      return strangers.length ? `${text} ${NOT_ADMIN(strangers.join(' and '))}` : text;
    };

    try {
      const ask = self ? FREE_TIME : job.standing ? this.roundAsk(job.standing) : `Request from ${player}${whisper ? ' (whispered)' : ''}: ${text}`;
      const before = self || !this.lastJob ? '' : `\n\n${lastJobLine(this.lastJob)}`;
      const reflexDone = job.reflex ? `\n\n${REFLEX_DONE[job.reflex](player)}` : '';
      // Picked once a job, so one that starts over on another model gets the same ones.
      if (!self && this.lessons && !job.lessons) {
        job.lessons = this.lessons.pick(text);
        job.lessonIds.push(...job.lessons.map((l) => l.id));
      }
      const advice = asText(job.lessons);
      job.routineLine ??= this.routineFor(job, text);
      const snapshot = this.snapshot();
      if (!job.lean) job.carriedAt = Date.now();
      // The start of the first turn, and the same without what was carried over from before the job.
      const leanHead = leanSnapshot(snapshot);
      const head = job.lean ? leanHead : `${snapshot}${before}`;
      const messages = [
        {
          role: 'user',
          content: `${head}\n\n${ask}${carriedOver(job)}${advice ? `\n\n${advice}` : ''}${job.routineLine ? `\n\n${job.routineLine}` : ''}${reflexDone}${sorting ? `\n\n${SORTING}` : ''}`
        }
      ];
      // Takes the carried-over parts out of the first turn for the rest of the job. Editing that
      // turn makes every later thinking block invalid, so those go too, as the API docs say to.
      // Returns whether any did.
      const goLean = () => {
        job.lean = true;
        const swap = (text) => (text.startsWith(head) ? `${leanHead}${text.slice(head.length)}` : text);
        const first = messages[0];
        if (typeof first.content === 'string') first.content = swap(first.content);
        else first.content = [{ ...first.content[0], text: swap(first.content[0].text) }, ...first.content.slice(1)];
        let stripped = false;
        for (let i = messages.length - 1; i > 0; i--) {
          const turn = messages[i];
          if (turn.role !== 'assistant' || !Array.isArray(turn.content)) continue;
          const kept = turn.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
          if (kept.length === turn.content.length) continue;
          stripped = true;
          if (kept.length) turn.content = kept;
          else messages.splice(i, 1);
        }
        return stripped;
      };

      // A bigger model takes the job over. It carries on in the same conversation, without the
      // turn that handed it over, as long as the system prompt and tools stay byte-identical: the
      // new model reads the earlier thinking it can (the API drops, unbilled, any it can't), and the
      // last user turn can still take a note since nothing after it is kept. Otherwise the job
      // starts over on that tier. Returns the restarted job, or null to carry on.
      const handOver = (to, why) => {
        const next = this.modelFor(to);
        sorting = false;
        job.handedOver = true;
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

      // A refused step gets another try. A reasoning_extraction refusal, or one with no category,
      // first goes once more to the same model without the carried-over parts, since the API docs
      // say to change the prompt for that category. Otherwise a job a bigger model took over sends
      // the step to the other bigger model, since the same model usually refuses the same request
      // again, and stays there, and any other job tries the same model once more. Returns the
      // restarted job, true to run the step again, or false to end the job.
      let retryStep = 0;
      let tried = new Set();
      const retryRefused = (step, category) => {
        if (step !== retryStep) {
          retryStep = step;
          tried = new Set();
        }
        if (job.refusalRetries >= MAX_REFUSAL_RETRIES || signal.aborted) return false;
        const other = job.handedOver ? (model === claude.model ? 'normal' : 'complex') : null;
        const otherModel = other ? this.modelFor(other) : model;
        const lean = !job.lean && (category === 'reasoning_extraction' || category == null);
        if (lean) {
          job.refusalRetries++;
          tried.add(model);
          job.leanTry = model;
          const stripped = goLean();
          this.log(
            `[brain] the step was refused, trying it once more on ${model} without the remembered requests, recent chat and last job` +
              `${stripped ? ', and without the earlier thinking' : ''}`
          );
          return true;
        }
        if (otherModel === model) {
          // This category doesn't go away with the same request again.
          if (category === 'reasoning_extraction' || tried.has(model)) return false;
          this.log(`[brain] the step was refused, trying it once more on ${model}`);
        } else if ((record?.refusals ?? []).some((r) => r.model === otherModel)) {
          return false;
        }
        job.refusalRetries++;
        tried.add(model);
        if (otherModel === model) return true;
        const sameTools = strictTools(claude, model) === strictTools(claude, otherModel);
        tier = other;
        job.tier = tier;
        if (sameTools && (hasSystemMessages(otherModel) || !messages.some((m) => m.role === 'system'))) {
          this.log(`[brain] the step was refused, sending it to ${otherModel}`);
          model = otherModel;
          if (record) Object.assign(record, { tier, model });
          return true;
        }
        this.log(`[brain] the step was refused, starting over on ${otherModel}`);
        clock.end();
        return this.handle({ ...request, tier }, signal, job);
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

        const outdated = () => (record?.holds ?? 0) > heldBefore;
        const textOf = (content) =>
          content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
        let doneThinking = () => {};
        // The short note the model writes next to its tool calls says what it's about to do. Next
        // to a lone finish it's the same answer as finish's message, so only the log gets it.
        const sayPlan = (plan, aloud = true) => {
          if (!plan) return;
          this.log(`[brain] plan: ${plan}`);
          // A plan made before a hold won't be carried out, so it isn't said. A round doesn't narrate.
          if (aloud && !self && !job.standing && !outdated() && !signal.aborted && Date.now() - this.lastPlanAt >= PLAN_GAP_MS) {
            doneThinking();
            this.say(plan, to);
            this.lastPlanAt = Date.now();
          }
        };

        // The response's tool calls so far, and whether that's all of them.
        const calls = [];
        let known = false;
        // Set when the calls still left in a response are not to run at all.
        let dropped = false;
        let wake = () => {};
        const more = () => new Promise((resolve) => (wake = resolve));
        const toolLog = [];
        const results = [];
        const notDone = (block, content) => results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true });
        // Set when a hold stopped one of this response's tools, so the rest don't run on the old plan.
        let heldUp = null;
        // Calls run in order and stop at the first one that fails or is stopped, since later ones
        // usually depend on it. Returns 'aborted' when the job was stopped, 'finished' when finish
        // ended it.
        let failed = false;
        const runCalls = async () => {
          for (let i = 0; ; i++) {
            while (i >= calls.length && !known && !dropped) await more();
            const block = calls[i];
            // Whether finish is the last call is only clear once the whole response is in.
            while (block?.name === 'finish' && !known && !dropped) await more();
            if (dropped || !block) return null;
            // Calls planned before a hold began don't run: the model hears what happened first.
            await this.waitWhileHeld(job, signal);
            if (signal.aborted) return 'aborted';
            if (dropped) return null;
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
              toolLog.push({ name: 'escalate', ok: false, ms: 0, error: NOT_YOURS });
              notDone(block, NOT_YOURS);
              continue;
            }
            if (block.name === 'standing_job') {
              const result = this.standingTool(job, block.input ?? {});
              this.log(`[tool] standing_job ${JSON.stringify(block.input)} -> ${result.ok ? 'ok' : 'failed'}: ${result.message}`);
              toolLog.push({ name: 'standing_job', ok: result.ok, ms: 0, action: block.input?.action, ...(result.ok ? {} : { error: result.message.slice(0, 300) }) });
              job.ran.push(`standing_job ${block.input?.action ?? ''}${result.ok ? '' : ' (failed)'}`);
              if (!result.ok) failed = true;
              results.push({ type: 'tool_result', tool_use_id: block.id, content: result.message, ...(result.ok ? {} : { is_error: true }) });
              continue;
            }
            // Everything before it worked, so the job ends here without another model call.
            if (block.name === 'finish') {
              if (i < calls.length - 1) {
                notDone(block, "Not done: finish has to be the last call in a response. Your message wasn't sent.");
                continue;
              }
              const line = String(block.input?.message ?? '').trim();
              if (nudges < MAX_NUDGES && unsavedRules().length) {
                nudges++;
                toolLog.push({ name: 'finish', ok: false, ms: 0, error: `held back, rule not saved: ${line}`.slice(0, 300) });
                this.log(`[brain] finish came before the rule was saved, sending her back: ${line}`);
                notDone(block, `Not done: ${ruleNudge()} Your message wasn't sent.${sorting ? ` ${OR_ESCALATE}` : ''}`);
                continue;
              }
              // Same as a plain reply: a line that promises more work isn't said, and she's sent on.
              // In a round the next round is the more.
              if (!self && !job.standing && nudges < MAX_NUDGES && promisesMore(line)) {
                nudges++;
                if (record) record.nudges = nudges;
                toolLog.push({ name: 'finish', ok: false, ms: 0, error: `held back: ${line}`.slice(0, 300) });
                this.log(`[brain] finish said what comes next, sending her on: ${line}`);
                notDone(block, sorting ? `${FINISH_MORE} ${OR_ESCALATE}` : FINISH_MORE);
                continue;
              }
              toolLog.push({ name: 'finish', ok: true, ms: 0 });
              this.log(`[brain] finish: ${line}`);
              if (line && !(self && /^nothing\W*$/i.test(line))) {
                if (record) record.reply = line.slice(0, 300);
                await speak(line);
              }
              return 'finished';
            }
            const building = !self && isBuildCall(block);
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
            doneThinking();
            let result;
            const ran = Date.now();
            try {
              const as = block.name === 'remember' ? this.rememberFor(job) : undefined;
              const running = this.runTool(block.name, block.input, AbortSignal.any([signal, tool.signal]), as);
              job.running = running;
              result = await running;
            } finally {
              clearTimeout(ceiling);
              clearTimeout(job.noteTimer);
              job.noteTimer = null;
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
            if (ok && block.name === 'remember') {
              job.savedRules = job.rules.length;
              job.heard = [];
            }
            const action = block.name === 'skill' ? { action: block.input?.action } : {};
            // Stopped from outside (a change, a hold, a stop, a response that won't be carried
            // out), so the result says nothing about the tool itself.
            const interrupted = signal.aborted || (why !== null && why !== 'stuck' && why !== 'too_long');
            toolLog.push({
              name: block.name,
              ok,
              ms: Date.now() - ran,
              ...action,
              ...(ok ? {} : { error: String(content).slice(0, 300) }),
              ...(interrupted ? { interrupted: true } : {})
            });
            // A tool that failed on its own, not because of a change, a hold or a stop, gets what
            // earlier jobs learned about it, once a job.
            if (!ok && !self && this.lessons && why !== 'update' && !HOLD_CAUSES[why] && !signal.aborted && !job.lessonTools.has(block.name)) {
              job.lessonTools.add(block.name);
              const found = this.lessons.forTool(block.name);
              job.lessonIds.push(...found.map((l) => l.id));
              if (found.length) content += `\n\n${asText(found)}`;
            }
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
        };
        let runner = null;
        // Stops the calls of a response that won't be carried out, and the one running, if any.
        const drop = async (why) => {
          dropped = true;
          wake();
          job.tool?.abort(why);
          await runner;
        };

        // A step that no later block can hand to another model is acted on as it streams in: the
        // note before its first tool call is said once that call begins, and each call starts as
        // soon as it's written. A sorting step, or one on a smaller model that might still ask to
        // build, is read whole, since a later block there can mean none of it runs.
        const early = claude.streaming === true && !sorting && (self || tier === 'complex' || model === claude.model);
        let first = null;
        let partial = null;
        // The text before the first tool call, once that call has begun.
        let planned = null;
        const onEvent = (event, message) => {
          partial = message;
          if (event.type === 'content_block_stop') {
            const block = message.content[event.index];
            if (first === null && (block.type === 'text' || block.type === 'tool_use')) first = Date.now() - asked;
          }
          if (!early || event.type !== 'content_block_start') return;
          if (planned === null && event.content_block.type === 'tool_use') {
            planned = textOf(message.content);
            sayPlan(planned, event.content_block.name !== 'finish');
          }
          // A call only runs once the next block has begun: the last one could still be cut off,
          // with its input part-written, so it waits for the end like the rest.
          const before = message.content[event.index - 1];
          if (before?.type !== 'tool_use') return;
          calls.push(before);
          if (!runner) {
            runner = runCalls();
            runner.catch(() => {});
          }
          wake();
        };
        const request = () => {
          const done = this.startThinking(job);
          doneThinking = done;
          job.doneThinking = done;
          return this.createMessage(messages, signal, effort, model, onEvent).finally(done);
        };
        const logStep = (message) => {
          const ms = Date.now() - asked;
          const logged = record?.step(message?.model ?? model, message?.usage, ms, first ?? ms);
          if (logged) logged.tools = toolLog;
          return logged;
        };

        let response;
        const asked = Date.now();
        try {
          // A bad request on a step with a new system notice is sent once more with the notice as
          // text. Only when that works was the notice the problem, and notices stay text from then
          // on. When it fails too, its error ends the job like any other.
          response = await request().catch(async (err) => {
            if (!newNotice || runner || signal.aborted || !(err instanceof Anthropic.BadRequestError)) throw err;
            this.foldNotice(messages);
            const retried = await request();
            this.log(`[brain] the API turned down a mid-conversation system message (${err.message}). Sending notices as text from now on.`);
            this.systemMessages = false;
            return retried;
          });
        } catch (err) {
          // Calls that started before the answer broke off are stopped, and kept in the job log.
          if (runner) {
            await drop(signal.aborted ? signal.reason : 'api_error');
            logStep(partial);
          }
          if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return ended();
          this.log(`[brain] API error: ${err.message}`);
          if (record) Object.assign(record, { end: 'api_error', error: err.message });
          if (!self) await speak(errorMessage(err));
          return;
        }
        this.logUsage(step, response.usage);
        const logged = logStep(response);
        this.warnCost(job);

        // The job ends here, so a call that already started is stopped and the rest never run. A
        // refusal with nothing to show for it, not even a call, can get another try first; one
        // that came with text is the model's own answer.
        if (response.stop_reason === 'refusal') {
          const shown = Boolean(runner || textOf(response.content) || response.content.some((b) => b.type === 'tool_use'));
          await drop('refusal');
          const category = this.noteRefusal(response, messages, model, effort, job.lean);
          record?.refusals.push({ model: response.model ?? model, category, lean: Boolean(job.lean) });
          job.leanTry = null;
          if (!shown) {
            const retry = retryRefused(step, category);
            if (retry === true) {
              step--;
              continue;
            }
            if (retry) return retry;
          }
          if (record) record.end = 'refusal';
          if (!self) await speak("I can't help with that one.");
          return;
        }
        // The same model took the step once the carried-over parts were gone, so they were what it
        // refused, and the next job would pay for the same refusal unless the requests and the chat
        // it carried are cleared.
        if (job.leanTry) {
          job.leanTry = null;
          if (record) record.leanCured = true;
          this.log('[brain] the step went through without the carried-over parts, so this job stays without them and the remembered requests and recent chat are cleared');
          try {
            this.forgetRequests?.(job.carriedAt);
          } catch (err) {
            this.log(`[brain] couldn't clear the remembered requests: ${err.message}`);
          }
          try {
            this.forgetChat?.(job.carriedAt);
          } catch (err) {
            this.log(`[brain] couldn't clear the recent chat: ${err.message}`);
          }
        }
        if (response.stop_reason === 'max_tokens') {
          await drop('max_tokens');
          if (record) record.end = 'max_tokens';
          if (!self) await speak('My answer got cut off. Try asking for something smaller.');
          return;
        }

        messages.push({ role: 'assistant', content: response.content });

        // A response whose calls have started gets their results, whatever it ended with.
        if (response.stop_reason === 'pause_turn' && !runner) continue;

        if (response.stop_reason !== 'tool_use' && !runner) {
          const reply = textOf(response.content);
          if (!job.notes.length && nudges < MAX_NUDGES && unsavedRules().length) {
            nudges++;
            this.log(`[brain] reply came before the rule was saved, sending her back: ${reply}`);
            messages.push({ role: 'user', content: `${ruleNudge()} Your message wasn't sent.${sorting ? ` ${OR_ESCALATE}` : ''}` });
            continue;
          }
          if (reply) this.log(`[brain] reply: ${reply}`);
          if (reply && !(self && /^nothing\W*$/i.test(reply))) {
            if (record) record.reply = reply.slice(0, 300);
            await speak(reply);
          }
          if (signal.aborted) return ended();
          // Something a player added during the last step still has to be worked in.
          if (job.notes.length) {
            messages.push({ role: 'user', content: this.takeNotes(job) });
            continue;
          }
          // A reply that only says what comes next would leave her standing there, so she
          // gets sent on to do it.
          if (!self && !job.standing && nudges < MAX_NUDGES && promisesMore(reply)) {
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
        const wantsBuild = !self && response.content.some((b) => b.type === 'tool_use' && isBuildCall(b));
        if (wantsBuild && tier !== 'complex' && model !== claude.model) {
          const restarted = handOver('complex', 'this needs building');
          if (restarted) return restarted;
          continue;
        }

        if (!planned) sayPlan(textOf(response.content), response.content.some((b) => b.type === 'tool_use' && b.name !== 'finish'));

        calls.push(...response.content.filter((b) => b.type === 'tool_use').slice(calls.length));
        known = true;
        wake();
        const outcome = await (runner ?? runCalls());
        if (outcome === 'aborted') return ended();
        if (outcome === 'finished') return;
        if (signal.aborted) return ended();
        messages.push({ role: 'user', content: results });
      }

      if (record) record.end = 'steps';
      if (!self) await speak('I ran out of steps on that one.');
    } finally {
      clock.end();
    }
  }
}
