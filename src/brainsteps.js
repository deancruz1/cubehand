// One job's run through the model, step by step, for Brain.handle. The run holds what one call of
// handle keeps between steps, and the turn what one step keeps; what outlasts a restart on another
// model stays on the job.
import Anthropic from '@anthropic-ai/sdk';
import { asText } from './lessons.js';
import { isBuildCall, isBuildRequest, REFLEX_MOVES } from './brainroute.js';
import { strictTools, hasSystemMessages } from './brainapi.js';
import { recoveryAsk } from './braindeath.js';
import { runCalls, drop, outdated } from './braincalls.js';import {
  STEPS_WARNING,
  STEPS_LEFT,
  MAX_CUT_OFFS,
  PLAN_CUT_OFF,
  FREE_TIME,
  SORTING,
  HANDED_OVER,
  MAX_NUDGES,
  CARRY_ON,
  OR_ESCALATE,
  SAID_NOTHING,
  NOT_UNDERSTOOD,
  REFLEX_DONE,
  lastJobLine,
  leanSnapshot,
  errorMessage,
  promisesMore,
  unsavedRules,
  ruleNudge
} from './brainlines.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Plan notes go to chat at most this often, so quick steps don't flood it.
const PLAN_GAP_MS = 8000;
// Extra model calls a job may spend on refused steps.
const MAX_REFUSAL_RETRIES = 2;

// What a step returns to carry on with the next one, or to run the same one again.
export const NEXT = Symbol('next');
export const AGAIN = Symbol('again');

export const whisperTo = (player, whisper) => (whisper ? player : null);

// The user turn the next request ends with, before any system notice that follows it.
export function openTurn(messages) {
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

export function appendBlocks(message, blocks) {
  message.content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }, ...blocks] : [...message.content, ...blocks];
}

const textOf = (content) =>
  content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();

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

// The run of one handle call, with the ways it talks to the player.
export function openRun(brain, request, signal, job) {
  const { player, text, self = false, whisper = false } = request;
  const { limits, claude, idle } = brain.config;
  const to = whisperTo(player, whisper);
  // Nothing said while the bot is offline gets through, so a line waits out a hold. A stop or a
  // replacing job drops it.
  const tell = async (line) => {
    await brain.waitWhileHeld(job, signal);
    if (!signal.aborted) brain.say(line, to);
  };
  job.tell = tell;
  // A round's own lines, which are said less often (see keptQuiet).
  const speak = async (line) => {
    if (!brain.keptQuiet(job, line)) await tell(line);
  };
  const ended = () => brain.endedByAbort(signal, self, (line) => brain.keptQuiet(job, line) || brain.say(line, to));
  return { request, signal, job, record: job.record, player, text, self, whisper, limits, claude, idle, to, tell, speak, ended };
}

// With routing on, a player's job on the main model is there because it builds or needs a plan,
// so it gets the build effort from its first step on that model. Raising the effort later, when
// its first build call comes, would write the whole conversation to the cache again.
const mainModelJob = (claude, tier, self) => claude.routing === true && tier === 'complex' && !self;

// The model, budget and clock the job starts with.
export function startRun(brain, run) {
  const { request, job, record, player, text, self, whisper, limits, claude, idle } = run;
  const tier = brain.firstTier(request);
  // A work order that skipped the quick model goes on as if that model had handed it up.
  if (!self && !request.tier && tier === 'normal') job.handedOver = true;
  // The quick model can hand the job up until it does, or until another model takes it over.
  const sorting = claude.routing === true && !request.tier && tier === 'simple';
  // Whether the conversation still asks for sorting with nothing saying it's over.
  const sortingAsked = sorting;
  job.tier = tier;
  const model = brain.modelFor(tier);
  const build = !self && isBuildRequest(text);
  const buildSeconds = limits.buildMaxSeconds ?? 1200;
  const buildSteps = limits.buildMaxSteps ?? 40;
  const buildEffort = claude.buildEffort ?? 'high';
  const moreEffort = EFFORTS.indexOf(buildEffort) > EFFORTS.indexOf(claude.effort) ? buildEffort : claude.effort;
  const maxSeconds = self ? idle.freeTimeSeconds : build ? buildSeconds : limits.maxSeconds;
  const maxSteps = self ? idle.freeTimeSteps : build ? buildSteps : limits.maxSteps;
  const effort = build || mainModelJob(claude, tier, self) ? moreEffort : claude.effort;
  // Without streaming the SDK turns away a request whose cap could run past ten minutes, which
  // a build's bigger cap can.
  const moreTokens = claude.streaming === true ? Math.max(claude.maxTokens, claude.buildMaxTokens ?? 32000) : claude.maxTokens;
  const maxTokens = build ? moreTokens : claude.maxTokens;
  if (record) Object.assign(record, { tier, model, effort });
  // The time limit only counts time outside tools and holds.
  const clock = new JobClock(maxSeconds * 1000, () => brain.current?.controller.abort('time'));
  job.clock = clock;
  if (job.hold) clock.hold('hold');
  clock.start();
  const using = claude.routing === true ? ` [${tier}, ${model}]` : '';
  brain.log(
    self
      ? `[brain] ${job.recovery ? 'going back after dying' : 'free time'}${using}`
      : job.standing
        ? `[brain] standing job round ${job.standing.number} for ${player}${using}`
        : `[brain] request from ${player}: ${text}${build ? ' (build)' : ''}${whisper ? ' (whispered)' : ''}${using}`
  );
  Object.assign(run, { tier, sorting, sortingAsked, model, build, buildSeconds, buildSteps, moreEffort, maxSteps, effort, moreTokens, maxTokens, clock });
  Object.assign(run, { nudges: 0, warned: false, excused: REFLEX_MOVES.has(job.reflex), rulesHeld: 0, retryStep: 0, tried: new Set(), step: 0 });
}

// The first turn of the conversation.
export function firstTurn(brain, run) {
  const { request, job, player, text, self, whisper } = run;
  const ask = self ? (job.recovery ? recoveryAsk(job.recovery) : FREE_TIME) : job.standing ? brain.roundAsk(job.standing) : `Request from ${player}${whisper ? ' (whispered)' : ''}: ${text}`;
  const before = self || !brain.lastJob ? '' : `\n\n${lastJobLine(brain.lastJob)}`;
  // A kind with no line here adds nothing.
  const reflexDone = job.reflex && Object.hasOwn(REFLEX_DONE, job.reflex) ? `\n\n${REFLEX_DONE[job.reflex](player)}` : '';
  // Picked once a job, so one that starts over on another model gets the same ones.
  if (!self && brain.lessons && !job.lessons) {
    job.lessons = brain.lessons.pick(text);
    job.lessonIds.push(...job.lessons.map((l) => l.id));
  }
  const advice = asText(job.lessons);
  job.routineLine ??= brain.routineFor(job, text);
  const snapshot = brain.snapshot();
  if (!job.lean) job.carriedAt = Date.now();
  // The start of the first turn, and the same without what was carried over from before the job.
  run.leanHead = leanSnapshot(snapshot);
  run.head = job.lean ? run.leanHead : `${snapshot}${before}`;
  run.messages = [
    {
      role: 'user',
      content: `${run.head}\n\n${ask}${request.after ? `\n\n${request.after}` : ''}${carriedOver(job)}${advice ? `\n\n${advice}` : ''}${job.routineLine ? `\n\n${job.routineLine}` : ''}${reflexDone}${run.sorting ? `\n\n${SORTING}` : ''}`
    }
  ];
}

// Takes the carried-over parts out of the first turn for the rest of the job. Editing that
// turn makes every later thinking block invalid, so those go too, as the API docs say to.
// Returns whether any did.
function goLean(run) {
  const { messages, head, leanHead } = run;
  run.job.lean = true;
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
}

// A bigger model takes the job over. It carries on in the same conversation, without the
// turn that handed it over, as long as the system prompt and tools stay byte-identical: the
// new model reads the earlier thinking it can (the API drops, unbilled, any it can't), and the
// last user turn can still take a note since nothing after it is kept. Otherwise the job
// starts over on that tier. Returns the restarted job, or null to carry on.
function handOver(brain, run, to, why) {
  const { claude, messages, job, record } = run;
  const next = brain.modelFor(to);
  run.sorting = false;
  job.handedOver = true;
  const sameTools = strictTools(claude, run.model) === strictTools(claude, next);
  if (sameTools && (hasSystemMessages(next) || !messages.some((m) => m.role === 'system'))) {
    brain.log(`[brain] ${why}, handing it to ${next}`);
    messages.pop();
    if (run.sortingAsked) appendBlocks(openTurn(messages), [{ type: 'text', text: HANDED_OVER }]);
    run.sortingAsked = false;
    run.tier = to;
    job.tier = run.tier;
    run.model = next;
    // The new model has no cache of this conversation yet, so the effort can change for free.
    if (mainModelJob(claude, to, run.self)) run.effort = run.moreEffort;
    if (record) Object.assign(record, { tier: run.tier, model: run.model, effort: run.effort });
    return null;
  }
  brain.log(`[brain] ${why}, starting over on ${next}`);
  run.clock.end();
  return brain.handle({ ...run.request, tier: to }, run.signal, job);
}

// A refused step gets another try. A reasoning_extraction refusal, or one with no category,
// first goes once more to the same model without the carried-over parts, since the API docs
// say to change the prompt for that category. Otherwise a job a bigger model took over sends
// the step to the other bigger model, since the same model usually refuses the same request
// again, and stays there, and any other job tries the same model once more. Returns the
// restarted job, true to run the step again, or false to end the job.
function retryRefused(brain, run, step, category) {
  const { claude, messages, job, record, signal } = run;
  if (step !== run.retryStep) {
    run.retryStep = step;
    run.tried = new Set();
  }
  if (job.refusalRetries >= MAX_REFUSAL_RETRIES || signal.aborted) return false;
  const model = run.model;
  const other = job.handedOver ? (model === claude.model ? 'normal' : 'complex') : null;
  const otherModel = other ? brain.modelFor(other) : model;
  const lean = !job.lean && (category === 'reasoning_extraction' || category == null);
  if (lean) {
    job.refusalRetries++;
    run.tried.add(model);
    job.leanTry = model;
    const stripped = goLean(run);
    brain.log(
      `[brain] the step was refused, trying it once more on ${model} without the remembered requests, recent chat and last job` +
        `${stripped ? ', and without the earlier thinking' : ''}`
    );
    return true;
  }
  if (otherModel === model) {
    // This category doesn't go away with the same request again.
    if (category === 'reasoning_extraction' || run.tried.has(model)) return false;
    brain.log(`[brain] the step was refused, trying it once more on ${model}`);
  } else if ((record?.refusals ?? []).some((r) => r.model === otherModel)) {
    return false;
  }
  job.refusalRetries++;
  run.tried.add(model);
  if (otherModel === model) return true;
  const sameTools = strictTools(claude, model) === strictTools(claude, otherModel);
  run.tier = other;
  job.tier = run.tier;
  if (sameTools && (hasSystemMessages(otherModel) || !messages.some((m) => m.role === 'system'))) {
    brain.log(`[brain] the step was refused, sending it to ${otherModel}`);
    run.model = otherModel;
    if (record) Object.assign(record, { tier: run.tier, model: run.model });
    return true;
  }
  brain.log(`[brain] the step was refused, starting over on ${otherModel}`);
  run.clock.end();
  return brain.handle({ ...run.request, tier: run.tier }, signal, job);
}

// One step: the model's answer and what comes of it. Returns NEXT or AGAIN, or else what handle
// returns, the job having ended.
export async function runStep(brain, run) {
  const { job, signal } = run;
  await brain.waitWhileHeld(job, signal);
  if (signal.aborted) return run.ended();
  // A hold that begins after this makes the answer to this step out of date.
  const turn = newTurn(run);
  await brain.beforeStep?.();
  if (signal.aborted) return run.ended();
  const newNotice = stepNotices(brain, run);
  const response = await askModel(brain, run, turn, newNotice);
  if (!response) return;
  brain.logUsage(run.step, response.usage);
  const logged = logStep(run, turn, response);
  brain.warnCost(job);
  if (response.stop_reason === 'refusal') return refused(brain, run, turn, response);
  if (job.leanTry) leanCured(brain, run);
  if (response.stop_reason === 'max_tokens') {
    await drop(run, turn, 'max_tokens');
    // The cut-off reply never goes into the conversation, so a build can ask again in parts as
    // long as none of its calls had started.
    if (run.build && turn.calls.length === 0 && (job.cutOffs ?? 0) < MAX_CUT_OFFS) {
      job.cutOffs = (job.cutOffs ?? 0) + 1;
      brain.log('[brain] a build step got cut off, asking for the plan in sections');
      brain.addNotices(run.messages, [PLAN_CUT_OFF], run.model);
      return NEXT;
    }
    if (run.record) run.record.end = 'max_tokens';
    if (!run.self) await run.speak('My answer got cut off. Try asking for something smaller.');
    return;
  }

  run.messages.push({ role: 'assistant', content: response.content });

  // A response with calls gets their results, whatever it ended with: the API turns down the next
  // request when a call in the conversation has no result after it.
  const hasCalls = response.content.some((b) => b.type === 'tool_use');
  if (response.stop_reason === 'pause_turn' && !turn.runner && !hasCalls) return NEXT;
  if (!hasCalls && !turn.runner) return replied(brain, run, response);
  const handed = handUp(brain, run, response, logged);
  if (handed) return handed;

  if (!turn.planned) sayPlan(brain, run, turn, textOf(response.content), response.content.some((b) => b.type === 'tool_use' && b.name !== 'finish'));

  turn.calls.push(...response.content.filter((b) => b.type === 'tool_use').slice(turn.calls.length));
  turn.known = true;
  turn.wake();
  const outcome = await (turn.runner ?? runCalls(brain, run, turn));
  if (outcome === 'aborted') return run.ended();
  if (outcome === 'finished') return;
  if (signal.aborted) return run.ended();
  run.messages.push({ role: 'user', content: turn.results });
  return NEXT;
}

function newTurn(run) {
  return {
    heldBefore: run.record?.holds ?? 0,
    // The response's tool calls so far, and whether that's all of them.
    calls: [],
    known: false,
    // Set when the calls still left in a response are not to run at all.
    dropped: false,
    wake: () => {},
    toolLog: [],
    results: [],
    // Set when a hold stopped one of this response's tools, so the rest don't run on the old plan.
    heldUp: null,
    failed: false,
    runner: null,
    doneThinking: () => {},
    asked: null,
    first: null,
    partial: null,
    // The text before the first tool call, once that call has begun.
    planned: null
  };
}

// Notes from players and notices from the bot's own side go in before the step. Returns whether a
// new system message was added.
function stepNotices(brain, run) {
  const { job, messages } = run;
  brain.deliverNotes(job, messages);
  const notices = [];
  const reports = job.reports.splice(0);
  if (reports.length) {
    job.told.push(reports.join(' '));
    notices.push(`${reports.join(' ')} Carry on with the job from here.`);
  }
  if (!run.self && !run.warned && run.step > 1 && run.step === run.maxSteps - STEPS_WARNING + 1) {
    run.warned = true;
    notices.push(STEPS_LEFT);
  }
  return brain.addNotices(messages, notices, run.model);
}

// The short note the model writes next to its tool calls says what it's about to do. Next
// to a lone finish it's the same answer as finish's message, so only the log gets it.
function sayPlan(brain, run, turn, plan, aloud = true) {
  if (!plan) return;
  brain.log(`[brain] plan: ${plan}`);
  // A plan made before a hold won't be carried out, so it isn't said. A round doesn't narrate.
  if (aloud && !run.self && !run.job.standing && !outdated(run, turn) && !run.signal.aborted && Date.now() - brain.lastPlanAt >= PLAN_GAP_MS) {
    turn.doneThinking();
    brain.say(plan, run.to);
    brain.lastPlanAt = Date.now();
  }
}

// Sends the step and returns the answer, or null when the job ended on an error or a stop.
async function askModel(brain, run, turn, newNotice) {
  const { job, signal, claude } = run;
  // A step that no later block can hand to another model is acted on as it streams in: the
  // note before its first tool call is said once that call begins, and each call starts as
  // soon as it's written. A sorting step, or one on a smaller model that might still ask to
  // build, is read whole, since a later block there can mean none of it runs.
  const early = claude.streaming === true && !run.sorting && (run.self || run.tier === 'complex' || run.model === claude.model);
  const onEvent = (event, message) => {
    turn.partial = message;
    if (event.type === 'content_block_stop') {
      const block = message.content[event.index];
      if (turn.first === null && (block.type === 'text' || block.type === 'tool_use')) turn.first = Date.now() - turn.asked;
    }
    if (!early || event.type !== 'content_block_start') return;
    if (turn.planned === null && event.content_block.type === 'tool_use') {
      turn.planned = textOf(message.content);
      sayPlan(brain, run, turn, turn.planned, event.content_block.name !== 'finish');
    }
    // A call only runs once the next block has begun: the last one could still be cut off,
    // with its input part-written, so it waits for the end like the rest.
    const before = message.content[event.index - 1];
    if (before?.type !== 'tool_use') return;
    turn.calls.push(before);
    if (!turn.runner) {
      turn.runner = runCalls(brain, run, turn);
      turn.runner.catch(() => {});
    }
    turn.wake();
  };
  const send = () => {
    const done = brain.startThinking(job);
    turn.doneThinking = done;
    job.doneThinking = done;
    return brain.createMessage(run.messages, signal, run.effort, run.model, onEvent, run.maxTokens).finally(done);
  };

  turn.asked = Date.now();
  try {
    // A bad request on a step with a new system notice is sent once more with the notice as
    // text. Only when that works was the notice the problem, and notices stay text from then
    // on. When it fails too, its error ends the job like any other.
    return await send().catch(async (err) => {
      if (!newNotice || turn.runner || signal.aborted || !(err instanceof Anthropic.BadRequestError)) throw err;
      brain.foldNotice(run.messages);
      const retried = await send();
      brain.log(`[brain] the API turned down a mid-conversation system message (${err.message}). Sending notices as text from now on.`);
      brain.systemMessages = false;
      return retried;
    });
  } catch (err) {
    // Calls that started before the answer broke off are stopped, and kept in the job log.
    if (turn.runner) {
      await drop(run, turn, signal.aborted ? signal.reason : 'api_error');
      logStep(run, turn, turn.partial);
    }
    if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
      run.ended();
      return null;
    }
    brain.log(`[brain] API error: ${err.message}`);
    if (run.record) Object.assign(run.record, { end: 'api_error', error: err.message });
    if (!run.self) await run.speak(errorMessage(err));
    return null;
  }
}

function logStep(run, turn, message) {
  const ms = Date.now() - turn.asked;
  const logged = run.record?.step(message?.model ?? run.model, message?.usage, ms, turn.first ?? ms);
  if (logged) logged.tools = turn.toolLog;
  if (logged && message?.stop_reason) logged.stop = message.stop_reason;
  return logged;
}

// The job ends here, so a call that already started is stopped and the rest never run. A
// refusal with nothing to show for it, not even a call, can get another try first; one
// that came with text is the model's own answer.
async function refused(brain, run, turn, response) {
  const { job, record } = run;
  const shown = Boolean(turn.runner || textOf(response.content) || response.content.some((b) => b.type === 'tool_use'));
  await drop(run, turn, 'refusal');
  const category = brain.noteRefusal(response, run.messages, run.model, run.effort, job.lean);
  record?.refusals.push({ model: response.model ?? run.model, category, lean: Boolean(job.lean) });
  job.leanTry = null;
  if (!shown) {
    const retry = retryRefused(brain, run, run.step, category);
    if (retry === true) return AGAIN;
    if (retry) return retry;
  }
  if (record) record.end = 'refusal';
  if (!run.self) await run.speak("I can't help with that one.");
}

// The same model took the step once the carried-over parts were gone, so they were what it
// refused, and the next job would pay for the same refusal unless the requests and the chat
// it carried are cleared.
function leanCured(brain, run) {
  const { job, record } = run;
  job.leanTry = null;
  if (record) record.leanCured = true;
  brain.log('[brain] the step went through without the carried-over parts, so this job stays without them and the remembered requests and recent chat are cleared');
  try {
    brain.forgetRequests?.(job.carriedAt);
  } catch (err) {
    brain.log(`[brain] couldn't clear the remembered requests: ${err.message}`);
  }
  try {
    brain.forgetChat?.(job.carriedAt);
  } catch (err) {
    brain.log(`[brain] couldn't clear the recent chat: ${err.message}`);
  }
}

// A response that ended with no tool call: the reply goes to the player, unless she is held back
// to save a rule, to work in a note, to say anything at all, or to do what she said comes next.
async function replied(brain, run, response) {
  const { job, record, self, messages } = run;
  const reply = textOf(response.content);
  if (!job.notes.length && run.nudges < MAX_NUDGES && unsavedRules(run).length) {
    run.nudges++;
    brain.log(`[brain] reply came before the rule was saved, sending her back: ${reply}`);
    messages.push({ role: 'user', content: `${ruleNudge(brain.config, run)} Your message wasn't sent.${run.sorting ? ` ${OR_ESCALATE}` : ''}` });
    return NEXT;
  }
  if (reply) brain.log(`[brain] reply: ${reply}`);
  if (reply && !(self && /^nothing\W*$/i.test(reply))) {
    if (record) record.reply = reply.slice(0, 300);
    await run.speak(reply);
  }
  if (run.signal.aborted) return run.ended();
  // Something a player added during the last step still has to be worked in.
  if (job.notes.length) {
    messages.push({ role: 'user', content: brain.takeNotes(job) });
    return NEXT;
  }
  // A player's job whose first step has no word and no call has said and done nothing at
  // all. It gets one more try, on the everyday model if it was on the quick one, and the
  // empty turn is dropped since the API takes no empty assistant turn. The try is the next
  // step, or step 1 again when the job starts over on the other model.
  const silent = !self && !job.standing && !REFLEX_MOVES.has(job.reflex) && !reply && !response.content.some((b) => b.type === 'tool_use');
  if (silent && job.silentRetry && run.step <= 2) {
    brain.log("[brain] she said nothing again, telling the player she didn't understand");
    if (record) record.end = 'not_understood';
    await run.speak(NOT_UNDERSTOOD);
    return;
  }
  if (silent && run.step === 1) return saidNothing(brain, run);
  // A reply that only says what comes next would leave her standing there, so she
  // gets sent on to do it.
  if (!self && !job.standing && run.nudges < MAX_NUDGES && promisesMore(run, reply)) {
    run.nudges++;
    if (record) record.nudges = run.nudges;
    brain.log('[brain] she said what comes next, sending her on');
    messages.push({ role: 'user', content: CARRY_ON });
    return NEXT;
  }
}

// The one more try for a job that said and did nothing. Returns NEXT or the restarted job.
function saidNothing(brain, run) {
  const { job, messages } = run;
  job.silentRetry = true;
  if (run.tier === 'simple') {
    const restarted = handOver(brain, run, 'normal', 'she said nothing');
    if (restarted) return restarted;
  } else {
    brain.log('[brain] she said nothing, sending her back');
    messages.pop();
  }
  appendBlocks(openTurn(messages), [{ type: 'text', text: SAID_NOTHING }]);
  return NEXT;
}

// The quick model hands the job up, or a job on a smaller model turns out to be a build. None of
// that response's calls run. Returns NEXT or the restarted job, or null when neither happened.
function handUp(brain, run, response, logged) {
  const escalate = response.content.find((b) => b.type === 'tool_use' && b.name === 'escalate');
  if (escalate && run.sorting) {
    const to = escalate.input?.to === 'normal' ? 'normal' : 'complex';
    const reason = typeof escalate.input?.reason === 'string' ? escalate.input.reason.trim().slice(0, 100) : '';
    logged?.tools.push({ name: 'escalate', ok: true, ms: 0, to, ...(reason ? { reason } : {}) });
    return handOver(brain, run, to, `this is a ${to} job${reason ? ` (${reason})` : ''}`) ?? NEXT;
  }
  // A job on a smaller model that turns out to be a build goes to the main model, which
  // makes the build call itself.
  const wantsBuild = !run.self && response.content.some((b) => b.type === 'tool_use' && isBuildCall(b));
  if (wantsBuild && run.tier !== 'complex' && run.model !== run.claude.model) {
    return handOver(brain, run, 'complex', 'this needs building') ?? NEXT;
  }
  return null;
}
