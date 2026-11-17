// Running the tool calls of one response, in order. run is the job's run and turn the step's
// state (see brainsteps.js).
import { asText } from './lessons.js';
import { isBuildCall } from './brainroute.js';
import { STEPS_WARNING, HOLD_CAUSES, NOT_YOURS, EARLIER_FAILED, MAX_NUDGES, FINISH_MORE, OR_ESCALATE, promisesMore, unsavedRules, ruleNudge } from './brainlines.js';

// Time inside a tool doesn't count against the job, but one call is stopped after this long, so a
// tool that hangs still ends. Build tools get longer.
const TOOL_SECONDS = 1800;
const BUILD_TOOL_SECONDS = 3600;
// A tool that was cut short says so ("Stopped early: stopped", "stopped before breaking ...",
// "movement was interrupted"), even when it got enough done to report ok.
const CUT_SHORT = /\b(?:stopped|interrupted)\b/i;
const finishedAnyway = (result) => Boolean(result?.ok) && !CUT_SHORT.test(String(result.message ?? ''));

// A hold that began after the step was sent makes its answer out of date.
export const outdated = (run, turn) => (run.record?.holds ?? 0) > turn.heldBefore;
const notDone = (turn, block, content) => turn.results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true });

// Calls run in order and stop at the first one that fails or is stopped, since later ones
// usually depend on it. Returns 'aborted' when the job was stopped, 'finished' when finish
// ended it.
export async function runCalls(brain, run, turn) {
  const { job, signal } = run;
  const more = () => new Promise((resolve) => (turn.wake = resolve));
  for (let i = 0; ; i++) {
    while (i >= turn.calls.length && !turn.known && !turn.dropped) await more();
    const block = turn.calls[i];
    // Whether finish is the last call is only clear once the whole response is in.
    while (block?.name === 'finish' && !turn.known && !turn.dropped) await more();
    if (turn.dropped || !block) return null;
    // Calls planned before a hold began don't run: the model hears what happened first.
    await brain.waitWhileHeld(job, signal);
    if (signal.aborted) return 'aborted';
    if (turn.dropped) return null;
    if (!turn.heldUp && outdated(run, turn)) turn.heldUp = job.heldFor;
    if (job.notes.length) {
      notDone(turn, block, 'Not done, because a player just changed the instructions (see below).');
      continue;
    }
    if (turn.heldUp) {
      notDone(turn, block, `Not done, because ${HOLD_CAUSES[turn.heldUp]} (see below).`);
      continue;
    }
    if (turn.failed) {
      notDone(turn, block, block.name === 'finish' ? `${EARLIER_FAILED} Your message wasn't sent.` : EARLIER_FAILED);
      continue;
    }
    if (block.name === 'escalate') {
      turn.toolLog.push({ name: 'escalate', ok: false, ms: 0, error: NOT_YOURS });
      notDone(turn, block, NOT_YOURS);
      continue;
    }
    if (block.name === 'standing_job') {
      standingCall(brain, run, turn, block);
      continue;
    }
    // Everything before it worked, so the job ends here without another model call.
    if (block.name === 'finish') {
      if (await finishCall(brain, run, turn, block, i)) return 'finished';
      continue;
    }
    await toolCall(brain, run, turn, block);
  }
}

function standingCall(brain, run, turn, block) {
  const result = brain.standingTool(run.job, block.input ?? {});
  brain.log(`[tool] standing_job ${JSON.stringify(block.input)} -> ${result.ok ? 'ok' : 'failed'}: ${result.message}`);
  turn.toolLog.push({ name: 'standing_job', ok: result.ok, ms: 0, action: block.input?.action, ...(result.ok ? {} : { error: result.message.slice(0, 300) }) });
  run.job.ran.push(`standing_job ${block.input?.action ?? ''}${result.ok ? '' : ' (failed)'}`);
  if (!result.ok) turn.failed = true;
  turn.results.push({ type: 'tool_result', tool_use_id: block.id, content: result.message, ...(result.ok ? {} : { is_error: true }) });
}

// Returns true when finish ended the job, and false when it was sent back.
async function finishCall(brain, run, turn, block, i) {
  const { job, record, self } = run;
  if (i < turn.calls.length - 1) {
    notDone(turn, block, "Not done: finish has to be the last call in a response. Your message wasn't sent.");
    return false;
  }
  const line = String(block.input?.message ?? '').trim();
  if (run.nudges < MAX_NUDGES && unsavedRules(run).length) {
    run.nudges++;
    turn.toolLog.push({ name: 'finish', ok: false, ms: 0, error: `held back, rule not saved: ${line}`.slice(0, 300) });
    brain.log(`[brain] finish came before the rule was saved, sending her back: ${line}`);
    notDone(turn, block, `Not done: ${ruleNudge(brain.config, run)} Your message wasn't sent.${run.sorting ? ` ${OR_ESCALATE}` : ''}`);
    return false;
  }
  // Same as a plain reply: a line that promises more work isn't said, and she's sent on.
  // In a round the next round is the more.
  if (!self && !job.standing && run.nudges < MAX_NUDGES && promisesMore(run, line)) {
    run.nudges++;
    if (record) record.nudges = run.nudges;
    turn.toolLog.push({ name: 'finish', ok: false, ms: 0, error: `held back: ${line}`.slice(0, 300) });
    brain.log(`[brain] finish said what comes next, sending her on: ${line}`);
    notDone(turn, block, run.sorting ? `${FINISH_MORE} ${OR_ESCALATE}` : FINISH_MORE);
    return false;
  }
  turn.toolLog.push({ name: 'finish', ok: true, ms: 0 });
  brain.log(`[brain] finish: ${line}`);
  if (line && !(self && /^nothing\W*$/i.test(line))) {
    if (record) record.reply = line.slice(0, 300);
    await run.speak(line);
  }
  return true;
}

// A job that turns into a build, like "carry on", gets the build budget from here on.
function becomeBuild(brain, run) {
  run.build = true;
  run.maxSteps = Math.max(run.maxSteps, run.buildSteps);
  if (run.warned && run.maxSteps - run.step >= STEPS_WARNING) run.warned = false;
  run.effort = run.moreEffort;
  if (run.record) run.record.effort = run.effort;
  run.clock.setLimit(Math.max(run.clock.limit, run.buildSeconds * 1000));
  brain.log('[brain] this job is a build now');
}

async function toolCall(brain, run, turn, block) {
  const { job, signal, clock } = run;
  const building = !run.self && isBuildCall(block);
  brain.log(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
  if (building && !run.build) becomeBuild(brain, run);
  const tool = new AbortController();
  job.tool = tool;
  const watch = brain.watchTool?.(block.name, tool);
  job.toolWatch = watch;
  const toolSeconds = building ? BUILD_TOOL_SECONDS : TOOL_SECONDS;
  const ceiling = setTimeout(() => tool.abort('too_long'), toolSeconds * 1000);
  clock.hold('tool');
  turn.doneThinking();
  let result;
  const ran = Date.now();
  try {
    const as = block.name === 'remember' ? brain.rememberFor(job) : undefined;
    const running = brain.runTool(block.name, block.input, AbortSignal.any([signal, tool.signal]), as);
    job.running = running;
    result = await running;
  } finally {
    clearTimeout(ceiling);
    clearTimeout(job.noteTimer);
    job.noteTimer = null;
    watch?.stop();
    job.tool = null;
    job.toolWatch = null;
    job.running = null;
    clock.release('tool');
  }
  // After a long build there's always a little time left to check on it.
  if (building) clock.setLimit(Math.max(clock.limit, clock.used + 120000));
  toolResult(brain, run, turn, block, { result, tool, watch, toolSeconds, ran });
}

// What a finished call tells the model, the job log and the job.
function toolResult(brain, run, turn, block, { result, tool, watch, toolSeconds, ran }) {
  const { job, signal } = run;
  let why = tool.signal.aborted && !signal.aborted ? tool.signal.reason : null;
  // A change that landed as the tool was finishing cut nothing short: its result stands and
  // the note still goes in next.
  if (why === 'update' && finishedAnyway(result)) {
    brain.log('[brain] the tool had finished its work when the change stopped it');
    why = null;
  }
  let content = result.message;
  if (why === 'update') content += ' (Stopped because a player just changed the instructions, see below.)';
  if (why === 'stuck') content += ` (${watch?.report() ?? 'I stopped this myself: nothing was changing.'} Work out what's in the way before trying the same thing again.)`;
  if (why === 'too_long') content += ` (Stopped because one call can run for at most ${toolSeconds / 60} minutes.)`;
  if (HOLD_CAUSES[why]) {
    turn.heldUp = why;
    content += ` (Stopped because ${HOLD_CAUSES[why]}, see below.)`;
  }
  brain.log(`[tool] -> ${result.ok && !why ? 'ok' : 'failed'}: ${result.message}${why ? ` (${why})` : ''}`);
  const ok = Boolean(result.ok && !why);
  if (ok && block.name === 'remember') {
    job.savedRules = job.rules.length;
    job.heard = [];
  }
  const action = block.name === 'skill' ? { action: block.input?.action } : {};
  // Stopped from outside (a change, a hold, a stop, a response that won't be carried
  // out), so the result says nothing about the tool itself.
  const interrupted = signal.aborted || (why !== null && why !== 'stuck' && why !== 'too_long');
  turn.toolLog.push({
    name: block.name,
    ok,
    ms: Date.now() - ran,
    ...action,
    ...(ok ? {} : { error: String(content).slice(0, 300) }),
    ...(interrupted ? { interrupted: true } : {})
  });
  // A tool that failed on its own, not because of a change, a hold or a stop, gets what
  // earlier jobs learned about it, once a job.
  if (!ok && !run.self && brain.lessons && why !== 'update' && !HOLD_CAUSES[why] && !signal.aborted && !job.lessonTools.has(block.name)) {
    job.lessonTools.add(block.name);
    const found = brain.lessons.forTool(block.name);
    job.lessonIds.push(...found.map((l) => l.id));
    if (found.length) content += `\n\n${asText(found)}`;
  }
  const input = JSON.stringify(block.input ?? {});
  job.ran.push(`${block.name} ${input.length > 100 ? `${input.slice(0, 100)}...` : input}${result.ok && !why ? '' : ' (failed)'}`);
  if (!result.ok || why) turn.failed = true;
  turn.results.push({
    type: 'tool_result',
    tool_use_id: block.id,
    content,
    ...(result.ok && why !== 'stuck' ? {} : { is_error: true })
  });
}

// Stops the calls of a response that won't be carried out, and the one running, if any.
export async function drop(run, turn, why) {
  turn.dropped = true;
  turn.wake();
  run.job.tool?.abort(why);
  await turn.runner;
}
