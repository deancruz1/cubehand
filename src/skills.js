import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { ok, fail } from './actions/util.js';
import { isAdmin } from './guard.js';
import { asJob, findSequences, toolRuns, SIDE_ENDS } from './report.js';

const MAX_SKILLS = 50;
const MAX_STEPS = 20;
const MAX_PARAMS = 8;
const MAX_DESCRIPTION = 120;
const MAX_STRING = 200;
const MAX_ARG = 100;
const MAX_INPUT = 1000;
// A run's whole result, however many steps the skill has.
const RESULT_BUDGET = 1200;
const SUMMARY_BUDGET = 600;
const LIST_BUDGET = 3000;
const UNRELIABLE_AFTER = 3;

const NAME = /^[a-z0-9_]{2,40}$/;
const PARAM = /^[a-z][a-z0-9_]{0,29}$/;
const WHOLE = /^\{([a-z][a-z0-9_]{0,29})\}$/;
const PART = /\{([a-z][a-z0-9_]{0,29})\}/g;
const ANY = /\{[a-z][a-z0-9_]{0,29}\}/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const COMMAND = /^\s*\//;

// Tools a skill may not call, and why. A skill only does things: the model does the talking,
// reads what it looks at, and decides what comes next.
const CHAT = 'a skill does things, you do the talking';
const LOOK = 'it only looks, and you need to read what it finds';
const BANNED = {
  finish: 'only you can end a job',
  escalate: 'only you can hand a job on',
  skill: "skills can't run other skills",
  say: CHAT,
  whisper: CHAT,
  inspect_blocks: LOOK,
  open_container: LOOK,
  survey: LOOK,
  find_block: LOOK,
  record_area: 'it waits on a player walking around between calls',
  follow_player: 'it keeps going after the call, and the next step would cut it off',
  remember: 'memories are yours to keep, not something to repeat',
  forget: 'memories are yours to keep, not something to repeat',
  build_house: 'a build is one call already and needs you to check it',
  build_structure: 'a build is one call already and needs you to check it',
  copy_structure: 'a build is one call already and needs you to check it',
  break_blocks: 'it breaks built blocks, which needs a player to say so each time',
  enchant: 'the offers change every time, and you need to read them to choose'
};
export const NOT_IN_SKILLS = new Set(Object.keys(BANNED));
// Flags that a player has to give for the job at hand, or that only look, so a skill never sets them.
const ONLY_FALSE = ['confirmed', 'dry_run', 'plan_only', 'list'];
// Flags a skill may not turn off: tend false stops her looking after a field or pen for good.
const NEVER_FALSE = ['tend'];
// Stops by the brain's own watchers count against the skill; a player stopping it doesn't.
const FAILED_ABORTS = new Set(['stuck', 'too_long']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Checks value against the part of JSON Schema the tool definitions use: type (object, array,
// string, integer, number, boolean), properties, required, additionalProperties false, items and
// enum. With open, a string that is a placeholder passes for any type, since it isn't filled yet.
export function checkSchema(value, schema, at = 'input', open = false) {
  if (open && typeof value === 'string' && ANY.test(value) && (WHOLE.test(value) || schema.type === 'string')) return null;
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${at} must be a string`;
      break;
    case 'integer':
      if (!Number.isInteger(value)) return `${at} must be a whole number`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${at} must be true or false`;
      break;
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be a list`;
      if (!schema.items) break;
      for (let i = 0; i < value.length; i++) {
        const bad = checkSchema(value[i], schema.items, `${at}[${i}]`, open);
        if (bad) return bad;
      }
      break;
    }
    case 'object': {
      if (!isObject(value)) return `${at} must be an object`;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!(key in value)) return `${at} needs ${key}`;
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) {
          if (schema.additionalProperties === false) return `${at} has no field ${key}`;
          continue;
        }
        const bad = checkSchema(v, props[key], `${at}.${key}`, open);
        if (bad) return bad;
      }
      break;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
  return null;
}

export function placeholders(value, found = new Set()) {
  if (typeof value === 'string') for (const m of value.matchAll(PART)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, found));
  else if (isObject(value)) Object.values(value).forEach((v) => placeholders(v, found));
  return found;
}

// "{count}" on its own becomes the argument itself, so 64 stays a number; inside a longer string
// it is written in as text.
export function substitute(value, args) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return args[whole[1]];
    return value.replace(PART, (_, name) => String(args[name]));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, args));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, args)]));
  return value;
}

function textProblem(text, at, max = MAX_STRING) {
  if (text.length > max) return `${at} is over ${max} characters`;
  if (CONTROL.test(text)) return `${at} has a line break or control character`;
  if (COMMAND.test(text)) return `${at} starts with a slash like a chat command`;
  return null;
}

function stringsProblem(value, at) {
  if (typeof value === 'string') return textProblem(value, at);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = stringsProblem(value[i], `${at}[${i}]`);
      if (bad) return bad;
    }
  } else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      const bad = stringsProblem(v, `${at}.${key}`);
      if (bad) return bad;
    }
  }
  return null;
}

function stepProblem(tool, input, schemas, at, open) {
  if (BANNED[tool]) return `${at}: ${tool} can't be in a skill, ${BANNED[tool]}`;
  const schema = schemas.get(tool);
  if (!schema) return `${at}: there is no tool called ${tool}`;
  if (!isObject(input)) return `${at}: input must be an object`;
  if (JSON.stringify(input).length > MAX_INPUT) return `${at}: input is over ${MAX_INPUT} characters`;
  const bad = stringsProblem(input, `${at} ${tool}`);
  if (bad) return bad;
  for (const flag of ONLY_FALSE) {
    if (flag in input && input[flag] !== false) return `${at}: a skill can't set ${flag}, ${flag === 'confirmed' ? 'a player has to confirm that each time' : 'it only looks'}`;
  }
  for (const flag of NEVER_FALSE) {
    if (input[flag] === false) return `${at}: a skill can't set ${flag} false, that stops you looking after the place for good`;
  }
  return checkSchema(input, schema, `${at} ${tool}`, open);
}

// Why a skill can't be saved or run, or null when it is fine. schemas maps each tool a skill may
// use to its input schema.
export function validateSkill(skill, schemas) {
  const { name, description, params, steps } = skill ?? {};
  if (typeof name !== 'string' || !NAME.test(name)) return 'name must be 2 to 40 lowercase letters, digits or underscores';
  if (typeof description !== 'string' || !description.trim()) return 'it needs a one-line description';
  const badText = textProblem(description, 'description', MAX_DESCRIPTION);
  if (badText) return badText;
  if (!Array.isArray(params) || params.length > MAX_PARAMS) return `params must be a list of at most ${MAX_PARAMS} names`;
  for (const p of params) if (typeof p !== 'string' || !PARAM.test(p)) return `param ${p} must be lowercase letters, digits or underscores, starting with a letter`;
  if (new Set(params).size !== params.length) return 'params has the same name twice';
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) return `it needs 1 to ${MAX_STEPS} steps`;
  for (let i = 0; i < steps.length; i++) {
    const bad = stepProblem(steps[i]?.tool, steps[i]?.input, schemas, `step ${i + 1}`, true);
    if (bad) return bad;
  }
  const used = placeholders(steps.map((s) => s.input));
  for (const p of used) if (!params.includes(p)) return `{${p}} is used but not in params`;
  for (const p of params) if (!used.has(p)) return `param ${p} is never used in the steps`;
  return null;
}

// The skill's steps with args filled in, each checked against its tool's schema, or { error }.
export function bindSteps(skill, args, schemas) {
  if (!isObject(args)) return { error: 'args must be an object' };
  for (const key of Object.keys(args)) if (!skill.params.includes(key)) return { error: `it has no param ${key}` };
  for (const p of skill.params) {
    const value = args[p];
    if (value === undefined) return { error: `it needs ${p} in args (params: ${skill.params.join(', ')})` };
    if (typeof value === 'string') {
      const bad = textProblem(value, `arg ${p}`, MAX_ARG);
      if (bad) return { error: bad };
    } else if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      return { error: `arg ${p} must be a string, number or true/false` };
    }
  }
  const steps = [];
  for (let i = 0; i < skill.steps.length; i++) {
    const { tool, input } = skill.steps[i];
    const filled = substitute(input, args);
    const bad = stepProblem(tool, filled, schemas, `step ${i + 1}`, false);
    if (bad) return { error: bad };
    steps.push({ tool, input: filled });
  }
  return { steps };
}

// Splits a tool result into what it said and the state line runAction put on the end.
function splitState(message) {
  const text = String(message ?? '');
  const at = text.lastIndexOf('\nNow at ');
  if (at < 0) return { body: text.trim(), state: '' };
  return { body: text.slice(0, at).trim(), state: text.slice(at + 1).trim() };
}

function snip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return max <= 3 ? '' : `${flat.slice(0, max - 3).trimEnd()}...`;
}

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
const stepsWere = (from, to, verb) => (from === to ? `Step ${from} was ${verb}` : `Steps ${from}-${to} were ${verb}`);

// Fits the completed steps into room characters: each step gets an even share of it.
function doneText(done, room) {
  if (!done.length || room <= 0) return '';
  const share = Math.floor(room / done.length);
  const parts = done.map((d, i) => {
    const head = `${i + 1} ${d.tool}`;
    const left = Math.min(share - head.length - 4, 60);
    return left >= 12 ? `${head}: ${snip(d.body, left)}` : head;
  });
  return sentence(snip(parts.join('; '), room - 1));
}

function load(path) {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data
      .filter((s) => isObject(s) && typeof s.name === 'string' && Array.isArray(s.steps) && Array.isArray(s.params))
      .map((s) => ({ runs: 0, failures: 0, failStreak: 0, lastRun: null, savedBy: null, ...s }));
  } catch {
    return [];
  }
}

const unreliable = (s) => (s.failStreak ?? 0) >= UNRELIABLE_AFTER;
const skillLine = (s) => `${s.name}(${s.params.join(', ')}): ${s.description}${unreliable(s) ? ` [unreliable: failed its last ${s.failStreak} runs]` : ''}`;
const byUse = (a, b) => b.runs - a.runs || (b.lastRun ?? 0) - (a.lastRun ?? 0) || a.name.localeCompare(b.name);

// Routines the bot saved as an ordered list of calls to its own tools, with named params, so it
// can do one again in a single call. Saved to a file so they survive restarts. Nothing in a skill
// is code: every step goes through runAction as if the model had made the call itself.
export class Skills {
  // tools: the tool definitions skills may use ({ name, input_schema }), as in tools.js.
  constructor({ tools = [], path = 'skills.json' } = {}) {
    this.path = path;
    this.schemas = new Map(tools.filter((t) => !NOT_IN_SKILLS.has(t.name)).map((t) => [t.name, t.input_schema]));
    this.skills = load(path);
  }

  get(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return this.skills.find((s) => s.name === key) ?? null;
  }

  // Returns { skill, replaced } or { error }.
  save({ name, description, params = [], steps, savedBy = null }, now = Date.now()) {
    const skill = {
      name: String(name ?? '').trim().toLowerCase(),
      description: typeof description === 'string' ? description.trim() : description,
      params,
      steps: Array.isArray(steps) ? steps.map((s) => ({ tool: s?.tool, input: s?.input })) : steps
    };
    const bad = validateSkill(skill, this.schemas);
    if (bad) return { error: bad };
    const old = this.get(skill.name);
    if (!old && this.skills.length >= MAX_SKILLS) return { error: `${MAX_SKILLS} skills are saved already, forget one first` };
    const same = old && JSON.stringify(old.steps) === JSON.stringify(skill.steps) && JSON.stringify(old.params) === JSON.stringify(skill.params);
    const entry = {
      ...skill,
      savedBy: savedBy ?? null,
      created: same ? old.created : now,
      lastRun: same ? old.lastRun : null,
      runs: same ? old.runs : 0,
      failures: same ? old.failures : 0,
      failStreak: same ? old.failStreak ?? 0 : 0
    };
    this.skills = this.skills.filter((s) => s.name !== skill.name);
    this.skills.push(entry);
    this.write();
    return { skill: entry, replaced: Boolean(old) };
  }

  forget(name) {
    const found = this.get(name);
    if (!found) return false;
    this.skills = this.skills.filter((s) => s !== found);
    this.write();
    return true;
  }

  // Runs the steps in order through runAction(ctx, tool, input) and stops at the first that fails
  // or when signal aborts. onStep(step, total, tool) is called before each, step counting from 1.
  // With endState false the result leaves off the last step's state line, for when the caller adds
  // its own for the whole run.
  async run(name, args = {}, { runAction, ctx, signal = ctx?.signal, onStep, endState = true } = {}, now = () => Date.now()) {
    const skill = this.get(name);
    if (!skill) return fail(`no skill called ${name}${this.skills.length ? ` (saved: ${this.skills.map((s) => s.name).join(', ')})` : ''}`);
    const invalid = validateSkill(skill, this.schemas);
    if (invalid) return fail(`skill ${skill.name} can't run any more: ${invalid}. Save it again or forget it.`);
    const bound = bindSteps(skill, args ?? {}, this.schemas);
    if (bound.error) return fail(`skill ${skill.name} not run, nothing was done: ${bound.error}`);

    // A skill someone without admin rights saved never gets an admin's rights by being run on an
    // admin's job: its steps run as the player who saved it.
    const config = ctx?.config ?? {};
    const trusted = !isAdmin(config, ctx?.requester) || skill.savedBy === ctx.requester || isAdmin(config, skill.savedBy);
    const stepCtx = trusted ? ctx : { ...ctx, requester: skill.savedBy ?? null };
    const total = bound.steps.length;
    const done = [];
    let stopped = null;
    let state = '';
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) {
        stopped = { step: i + 1, aborted: true, before: true };
        break;
      }
      const { tool, input } = bound.steps[i];
      onStep?.(i + 1, total, tool);
      let result;
      try {
        result = await runAction(stepCtx, tool, input);
      } catch (err) {
        result = fail(`${tool} failed: ${err.message}`);
      }
      const { body, state: line } = splitState(result?.message);
      if (line) state = line;
      if (!result?.ok) {
        stopped = { step: i + 1, tool, body, aborted: Boolean(signal?.aborted) };
        break;
      }
      done.push({ tool, body });
    }

    skill.lastRun = now();
    if (!stopped?.aborted || FAILED_ABORTS.has(signal?.reason)) {
      skill.runs = (skill.runs ?? 0) + 1;
      if (stopped) {
        skill.failures = (skill.failures ?? 0) + 1;
        skill.failStreak = (skill.failStreak ?? 0) + 1;
      } else {
        skill.failStreak = 0;
      }
    }
    this.write();

    const tail = endState && state ? `\n${snip(state, 300)}` : '';
    if (!stopped) {
      const head = `Ran skill ${skill.name}, all ${total} step${total > 1 ? 's' : ''} worked: `;
      return ok(`${head}${doneText(done, RESULT_BUDGET - head.length - tail.length)}${tail}`);
    }
    const n = stopped.step;
    let head;
    if (stopped.before) head = `Skill ${skill.name} was stopped before step ${n} of ${total}.`;
    else head = `Skill ${skill.name} ${stopped.aborted ? 'was stopped during' : 'failed at'} step ${n} of ${total} (${stopped.tool}): ${sentence(snip(stopped.body, 300) || 'no reason given')}`;
    const notRun = stopped.before ? `${stepsWere(n, total, 'not run')}.` : n < total ? `${stepsWere(n + 1, total, 'not run')}.` : '';
    const doneHead = done.length ? ` ${stepsWere(1, done.length, 'done')}: ` : ' No step before it was done.';
    const room = RESULT_BUDGET - head.length - doneHead.length - notRun.length - tail.length - 1;
    const list = done.length ? doneText(done, room) : '';
    return fail(`${head}${doneHead}${list}${notRun ? ` ${notRun}` : ''}${tail}`);
  }

  // One line per skill for the snapshot, most used first, within limit characters. Empty when
  // there are none, so a bot with no skills pays nothing for them.
  summary({ limit = SUMMARY_BUDGET } = {}) {
    if (!this.skills.length) return '';
    const sorted = [...this.skills].sort(byUse);
    const lines = ['Skills you saved (do one with the skill tool, action run):'];
    let used = lines[0].length;
    for (let i = 0; i < sorted.length; i++) {
      const line = `- ${skillLine(sorted[i])}`;
      const more = sorted.length - i - 1;
      const reserve = more ? `\n+${more} more, skill list shows them all`.length : 0;
      if (used + 1 + line.length + reserve > limit) {
        const rest = `+${sorted.length - i} more, skill list shows them all`;
        if (used + 1 + rest.length <= limit) lines.push(rest);
        break;
      }
      lines.push(line);
      used += 1 + line.length;
    }
    return lines.join('\n');
  }

  // Every skill with its counts, or one skill with its steps.
  listText(name) {
    if (name) {
      const s = this.get(name);
      if (!s) return `no skill called ${name}`;
      const runs = `run ${s.runs} time${s.runs === 1 ? '' : 's'}, ${s.failures} failed`;
      const steps = s.steps.map((step, i) => `${i + 1} ${step.tool} ${JSON.stringify(step.input)}`);
      const text = [`${skillLine(s)} (${runs})`, ...steps].join('\n');
      return text.length <= LIST_BUDGET ? text : `${text.slice(0, LIST_BUDGET - 3)}...`;
    }
    if (!this.skills.length) return 'no skills saved';
    const lines = [...this.skills].sort(byUse).map((s) => `- ${skillLine(s)} (run ${s.runs}, failed ${s.failures})`);
    const text = lines.join('\n');
    return text.length <= LIST_BUDGET ? text : `${text.slice(0, LIST_BUDGET - 3)}...`;
  }

  write() {
    // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.skills, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

const contains = (runs, tools) => runs.some((run) => ` ${run.join(' ')} `.includes(` ${tools.join(' ')} `));
const collapse = (names) => names.filter((n, i) => n !== names[i - 1]);

// A routine worth saving: the longest run of 3 or more tools that the job that just ended (a line
// from the job log) did, that minJobs or more earlier job lines did too, that a skill may hold
// every step of, and that no saved skill covers yet. null when there is none. Free time and side
// lines don't count. earlier should be a bounded list, like JobLog.recent().
export function repeatedRoutine(line, earlier, { skills = [], usable = () => true, minJobs = 3 } = {}) {
  const job = asJob(line);
  if (!job || job.freeTime || SIDE_ENDS.has(job.end)) return null;
  const own = toolRuns(job).filter((run) => run.length >= 3);
  if (!own.length) return null;
  const before = earlier.filter((l) => l !== line).map(asJob).filter((j) => j && !j.freeTime && !SIDE_ENDS.has(j.end));
  const saved = skills.map((s) => collapse((s.steps ?? []).map((step) => step.tool)));
  const found = findSequences(before, { minCount: minJobs, minJobs, top: Infinity, keepInside: true }).filter(
    (s) => s.tools.every(usable) && contains(own, s.tools) && !contains(saved, s.tools)
  );
  found.sort((a, b) => b.tools.length - a.tools.length || b.jobs - a.jobs);
  return found[0]?.tools ?? null;
}

// The line for the first turn of the next job like it.
export const routineHint = (tools) => `You did ${tools.join(' > ')} in earlier jobs like this too; skill save can make it one call.`;

const str = { type: 'string' };

export const SKILL_TOOL = {
  name: 'skill',
  description: 'Your saved routines: tool calls done in order in one call. save: name, a one-line description, and steps, each a tool and its input as JSON text; "{p}" in an input is filled from args at run time, and every p goes in params. run: args as JSON text like {"count":64}; stops at the first step that fails. forget: deletes one. list: all of them, or one\'s steps with name. Steps can\'t chat, finish, only look, or build.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'run', 'forget', 'list'] },
      name: str,
      description: str,
      params: { type: 'array', items: str },
      steps: {
        type: 'array',
        items: { type: 'object', properties: { tool: str, input: str }, required: ['tool', 'input'], additionalProperties: false }
      },
      args: str
    },
    required: ['action'],
    additionalProperties: false
  }
};

// Strict schemas can't hold free-form objects, so step inputs and args come as JSON text. Objects
// are taken as they are too, for models that get the tools without strict.
function parseObject(value, what) {
  if (value === undefined || value === null || value === '') return { value: {} };
  if (isObject(value)) return { value };
  if (typeof value !== 'string') return { error: `${what} must be a JSON object` };
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? { value: parsed } : { error: `${what} must be a JSON object` };
  } catch {
    return { error: `${what} is not valid JSON` };
  }
}

// The skill action for actions/index.js. runStep(ctx, tool, input) runs one step, which should be
// runAction itself so each step goes through every check a call from the model does. The store
// comes from ctx.skills.
export function skillAction(runStep) {
  return async (ctx, { action, name, description, params, steps, args } = {}) => {
    const skills = ctx.skills;
    if (!skills) return fail('skills are turned off');
    if (action === 'list') return ok(skills.listText(name));
    if (!name) return fail(`give the name of the skill to ${action}`);
    if (action === 'forget') return skills.forget(name) ? ok(`forgot skill ${name}`) : fail(`no skill called ${name}`);
    if (action === 'save') {
      if (!Array.isArray(steps) || !steps.length) return fail('not saved: it needs steps');
      const parsed = [];
      for (let i = 0; i < steps.length; i++) {
        const input = parseObject(steps[i]?.input, `step ${i + 1} input`);
        if (input.error) return fail(`not saved: ${input.error}`);
        parsed.push({ tool: steps[i]?.tool, input: input.value });
      }
      const saved = skills.save({ name, description, params: params ?? [], steps: parsed, savedBy: ctx.requester ?? null });
      if (saved.error) return fail(`not saved: ${saved.error}`);
      const { skill } = saved;
      const takes = skill.params.length ? `, takes ${skill.params.join(', ')}` : '';
      return ok(`${saved.replaced ? 'replaced' : 'saved'} skill ${skill.name}: ${skill.steps.length} step${skill.steps.length > 1 ? 's' : ''}${takes}`);
    }
    if (action === 'run') {
      const parsedArgs = parseObject(args, 'args');
      if (parsedArgs.error) return fail(`skill ${name} not run: ${parsedArgs.error}`);
      return skills.run(name, parsedArgs.value, {
        runAction: runStep,
        ctx,
        signal: ctx.signal,
        endState: false,
        onStep: (step, total, tool) => ctx.status?.progress(`step ${step} of ${total} of skill ${name}: ${tool.replaceAll('_', ' ')}`)
      });
    }
    return fail(`unknown skill action: ${action}`);
  };
}
