import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasInterrupted } from './joblog.js';

// A report over jobs.jsonl: what jobs cost, how long they took, where they went wrong.
// Run with `npm run report -- [path] [--since DATE] [--days N] [--player NAME] [--json]`.

const TROUBLE_ENDS = ['steps', 'time', 'api_error', 'crash', 'refusal', 'max_tokens', 'not_understood'];
const TIER_ORDER = ['simple', 'normal', 'complex'];
// Tools that steer the job rather than act in the world, left out of sequences.
const CONTROL_TOOLS = new Set(['escalate', 'finish', 'standing_job']);
const DAY = 24 * 60 * 60 * 1000;

// Each rule looks at one field of every row in a section and trips when the value passes its
// limit. atLeast skips rows too small to say much.
export const RULES = [
  { section: 'tools', key: 'name', field: 'failRate', label: 'failure rate', over: 0.25, atLeast: { calls: 10 }, as: 'pct' },
  {
    section: 'byModel',
    key: 'model',
    field: 'cacheHitAfterFirst',
    label: 'steps with a cache read after its first job',
    under: 0.8,
    as: 'pct'
  },
  {
    section: 'handovers',
    subject: 'quick model',
    field: 'rate',
    label: 'escalation rate',
    over: 0.4,
    atLeast: { quickJobs: 1 },
    as: 'pct'
  },
  { section: 'byTier', key: 'tier', field: 'stepsMedian', label: 'median steps per job', over: 10 }
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (values) => values.reduce((total, v) => total + v, 0);

export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

const median = (values) => quantile(values, 0.5);

export function asJob(raw) {
  if (!isObject(raw)) return null;
  const startMs = Date.parse(raw.start);
  if (Number.isNaN(startMs)) return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).filter(isObject).map((s) => ({
    model: s.model ?? raw.model ?? null,
    ms: num(s.ms),
    firstMs: typeof s.firstMs === 'number' ? s.firstMs : null,
    tokens: isObject(s.tokens) ? s.tokens : {},
    cost: typeof s.cost === 'number' ? s.cost : null,
    tools: (Array.isArray(s.tools) ? s.tools : []).filter(isObject).map((t) => ({ ...t, ok: t.ok !== false, interrupted: wasInterrupted(t, startMs), ms: num(t.ms) }))
  }));
  const calls = (Array.isArray(raw.calls) ? raw.calls : []).filter(isObject);
  const tools = steps.flatMap((s) => s.tools);
  const known = [...calls, ...steps].map((c) => c.cost).filter((c) => typeof c === 'number');
  const totals = isObject(raw.totals) ? raw.totals : {};
  return {
    start: raw.start,
    startMs,
    player: raw.player ?? null,
    request: typeof raw.request === 'string' ? raw.request : null,
    freeTime: raw.freeTime === true,
    tier: raw.tier ?? null,
    model: raw.model ?? null,
    reflex: typeof raw.reflex === 'string' ? raw.reflex : null,
    standing: raw.standing === true,
    lesson: typeof raw.lesson === 'string' ? raw.lesson : null,
    end: raw.end ?? 'unknown',
    ms: num(raw.ms),
    holds: num(raw.holds),
    heldMs: num(raw.heldMs),
    costWarnings: num(raw.costWarnings),
    nudges: num(raw.nudges),
    steps,
    calls,
    tools,
    cost: typeof totals.cost === 'number' ? totals.cost : known.length ? sum(known) : null,
    modelMs: typeof totals.modelMs === 'number' ? totals.modelMs : sum([...calls, ...steps].map((c) => num(c.ms))),
    toolMs: typeof totals.toolMs === 'number' ? totals.toolMs : sum(tools.map((t) => t.ms))
  };
}

// Ends of lines that are a side call of their own rather than a job.
export const SIDE_ENDS = new Set(['lesson', 'busy_reply', 'tidy']);

// Lines that don't parse or aren't a job (a line cut off mid-write, say) are counted and skipped.
// Lines from the review call after a job (end 'lesson'), replies sorted after their job was
// logged (end 'busy_reply') and the free-time call that tidies the notes (end 'tidy') aren't
// jobs and are kept apart.
export function parseLog(text) {
  const jobs = [];
  const lessons = [];
  const busyReplies = [];
  const tidies = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let job = null;
    try {
      job = asJob(JSON.parse(line));
    } catch {}
    if (job?.end === 'lesson') lessons.push(job);
    else if (job?.end === 'busy_reply') busyReplies.push(job);
    else if (job?.end === 'tidy') tidies.push(job);
    else if (job) jobs.push(job);
    else bad++;
  }
  for (const list of [jobs, lessons, busyReplies, tidies]) list.sort((a, b) => a.startMs - b.startMs);
  return { jobs, bad, lessons, busyReplies, tidies };
}

// A bare date means local midnight; anything else is read as a time.
export function parseSince(text) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const ms = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

export function parseArgs(argv) {
  const args = { path: 'jobs.jsonl', since: null, days: null, player: null, bot: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (['--since', '--days', '--player', '--bot'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} needs a value.` };
      if (arg === '--since') {
        args.since = parseSince(value);
        if (args.since === null) return { error: `--since needs a date like 2026-11-15 or an ISO time, not ${value}.` };
      } else if (arg === '--days') {
        args.days = Number(value);
        if (!(args.days > 0)) return { error: `--days needs a number above 0, not ${value}.` };
      } else args[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith('--')) return { error: `Unknown option ${arg}.` };
    args.path = arg;
  }
  return args;
}

export function filterJobs(jobs, { since = null, days = null, player = null, now = Date.now() } = {}) {
  const from = Math.max(since ?? -Infinity, days ? now - days * DAY : -Infinity);
  const who = player?.toLowerCase();
  return jobs.filter((j) => j.startMs >= from && (!who || j.player?.toLowerCase() === who));
}

export function normaliseFailure(text) {
  return String(text)
    .split('\n')[0]
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// The first two words of a request, lowercased, with the bot's name left out.
export function firstWords(text, botName = null, count = 2) {
  const name = botName?.toLowerCase();
  const words = String(text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter((w) => w && w !== name);
  return words.slice(0, count).join(' ');
}

function countBy(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Busy replies, lesson reviews and note tidies on their own lines aren't jobs, but what they cost
// is in the cost in all.
function totalsOf(jobs, busyReplies = [], lessons = [], tidies = []) {
  const costs = jobs.map((j) => j.cost).filter((c) => c !== null);
  const busyCost = sum(busyReplies.map((b) => num(b.cost)));
  const lessonCost = sum(lessons.map((l) => num(l.cost)));
  const tidyCost = sum(tidies.map((t) => num(t.cost)));
  const days = countBy(jobs.map((j) => dayKey(j.startMs))).sort((a, b) => a[0].localeCompare(b[0]));
  const first = new Date(jobs[0].startMs);
  const last = new Date(jobs[jobs.length - 1].startMs);
  const span =
    Math.round((new Date(last.getFullYear(), last.getMonth(), last.getDate()) - new Date(first.getFullYear(), first.getMonth(), first.getDate())) / DAY) + 1;
  return {
    jobs: jobs.length,
    from: jobs[0].start,
    to: jobs[jobs.length - 1].start,
    ends: Object.fromEntries(countBy(jobs.map((j) => j.end))),
    cost: sum(costs) + busyCost + lessonCost + tidyCost,
    jobCost: sum(costs),
    medianCost: median(costs),
    unknownCost: jobs.length - costs.length,
    modelMs: sum(jobs.map((j) => j.modelMs)),
    toolMs: sum(jobs.map((j) => j.toolMs)),
    sideCalls: sum(jobs.map((j) => j.calls.length)),
    sideCost: sum(jobs.flatMap((j) => j.calls.map((c) => (typeof c.cost === 'number' ? c.cost : 0)))),
    busyReplies: busyReplies.length,
    busyCost,
    lessonCost,
    tidies: tidies.length,
    tidyCost,
    reflex: Object.fromEntries(countBy(jobs.map((j) => j.reflex).filter(Boolean))),
    rounds: jobs.filter((j) => j.standing).length,
    roundCost: sum(jobs.filter((j) => j.standing).map((j) => num(j.cost))),
    perDay: jobs.length / span,
    days: days.map(([day, count]) => ({ day, jobs: count }))
  };
}

// Stats over slices of steps: one slice per job, each with what that slice cost.
function stepStats(slices) {
  const steps = slices.flatMap((s) => s.steps);
  const counts = slices.map((s) => s.steps.length);
  const costs = slices.map((s) => s.cost).filter((c) => c !== null);
  const firsts = steps.map((s) => s.firstMs).filter((ms) => ms !== null);
  const cached = (list) => (list.length ? list.filter((s) => num(s.tokens.cacheRead) > 0).length / list.length : null);
  return {
    jobs: slices.length,
    steps: steps.length,
    stepsMedian: median(counts),
    stepsP90: quantile(counts, 0.9),
    costPerJob: costs.length ? sum(costs) / costs.length : null,
    stepMsMedian: median(steps.map((s) => s.ms)),
    firstMsMedian: median(firsts),
    cacheHit: cached(steps),
    cacheHitAfterFirst: slices.length > 1 ? cached(slices.slice(1).flatMap((s) => s.steps)) : null,
    cacheWrite: sum(steps.map((s) => num(s.tokens.cacheWrite))),
    cacheRead: sum(steps.map((s) => num(s.tokens.cacheRead)))
  };
}

const stepCost = (steps) => (steps.some((s) => s.cost === null) ? null : sum(steps.map((s) => s.cost)));

function byModel(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const own = new Map();
    for (const step of job.steps) {
      if (!own.has(step.model)) own.set(step.model, []);
      own.get(step.model).push(step);
    }
    for (const [model, steps] of own) {
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model).push({ steps, cost: stepCost(steps) });
    }
  }
  return [...groups].map(([model, slices]) => ({ model, ...stepStats(slices) })).sort((a, b) => b.steps - a.steps);
}

// A job was handed over when the quick model called escalate or a later step ran on another model.
function handoverOf(job) {
  if (!job.steps.length) return null;
  const escalate = job.tools.find((t) => t.name === 'escalate' && t.ok);
  const first = job.steps[0].model;
  const next = job.steps.find((s) => s.model !== first) ?? null;
  if (!escalate && !next) return null;
  return { escalated: Boolean(escalate), to: escalate?.to ?? job.tier, reason: reasonOf(escalate), first: job.steps[0], next };
}

// The quick model's few words on why it handed a job up, the same however they're cased or
// ended. Records from before it gave one have none.
const reasonOf = (escalate) =>
  typeof escalate?.reason === 'string'
    ? escalate.reason
        .toLowerCase()
        .replace(/[.!\s]+$/, '')
        .trim() || null
    : null;

// The record keeps the tier a job ended on, so the tier it started on comes from its first model.
function startTiers(jobs) {
  const tierOf = new Map();
  for (const job of jobs) if (job.steps.length && !handoverOf(job) && job.tier) tierOf.set(job.steps[0].model, job.tier);
  return jobs.map((job) => {
    const handover = handoverOf(job);
    if (!handover) return job.steps.length ? job.tier : null;
    return tierOf.get(job.steps[0].model) ?? (handover.escalated ? 'simple' : null);
  });
}

const tierRank = (tier) => (TIER_ORDER.includes(tier) ? TIER_ORDER.indexOf(tier) : TIER_ORDER.length);

function byTier(jobs, tiers) {
  const groups = new Map();
  jobs.forEach((job, i) => {
    if (!job.steps.length) return;
    const tier = tiers[i] ?? 'unknown';
    if (!groups.has(tier)) groups.set(tier, []);
    groups.get(tier).push({ steps: job.steps, cost: job.cost });
  });
  return [...groups].map(([tier, slices]) => ({ tier, ...stepStats(slices) })).sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
}

function handovers(jobs, tiers, botName) {
  const quick = jobs.filter((_, i) => tiers[i] === 'simple');
  const escalated = quick.map((job) => ({ job, handover: handoverOf(job) })).filter((e) => e.handover);
  const all = jobs.map((job, i) => ({ from: tiers[i], handover: handoverOf(job) })).filter((e) => e.handover);
  const nexts = escalated.map((e) => e.handover.next).filter(Boolean);
  return {
    quickJobs: quick.length,
    escalated: escalated.length,
    rate: quick.length ? escalated.length / quick.length : null,
    to: Object.fromEntries(countBy(escalated.map((e) => e.handover.to))),
    reasons: countBy(escalated.map((e) => e.handover.reason).filter(Boolean))
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    noReason: escalated.filter((e) => e.handover.escalated && !e.handover.reason).length,
    pairs: countBy(all.map((e) => `${e.from ?? 'unknown'} > ${e.handover.to ?? 'unknown'}`)).map(([pair, count]) => {
      const [from, to] = pair.split(' > ');
      return { from, to, count };
    }),
    firstStepMsMedian: median(escalated.map((e) => e.handover.first.ms)),
    firstStepMsTotal: sum(escalated.map((e) => e.handover.first.ms)),
    firstStepCost: sum(escalated.map((e) => num(e.handover.first.cost))),
    nextStepMsMedian: median(nexts.map((s) => s.ms)),
    nextStepCostMedian: median(nexts.map((s) => s.cost).filter((c) => c !== null)),
    words: countBy(escalated.map((e) => firstWords(e.job.request, botName)).filter(Boolean))
      .slice(0, 10)
      .map(([words, count]) => ({ words, count }))
  };
}

function byTool(jobs) {
  const groups = new Map();
  for (const tool of jobs.flatMap((j) => j.tools)) {
    const name = tool.name ?? 'unknown';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(tool);
  }
  return [...groups]
    .map(([name, tools]) => {
      // Only a skill run can fail at the task; saving, listing and forgetting are bookkeeping. A
      // call stopped from outside (a player's change, a hold, a stop) says nothing either way.
      const counted = (name === 'skill' ? tools.filter((t) => t.action === 'run') : tools).filter((t) => !t.interrupted);
      const failed = counted.filter((t) => !t.ok);
      const ms = tools.map((t) => t.ms);
      return {
        name,
        calls: tools.length,
        interrupted: tools.filter((t) => t.interrupted).length,
        failed: failed.length,
        failRate: counted.length ? failed.length / counted.length : null,
        msMedian: median(ms),
        msP90: quantile(ms, 0.9),
        msTotal: sum(ms),
        failures: countBy(failed.filter((t) => t.error).map((t) => normaliseFailure(t.error)))
          .slice(0, 3)
          .map(([text, count]) => ({ text, count }))
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function skillsOf(jobs) {
  const calls = jobs.flatMap((j) => j.tools.filter((t) => t.name === 'skill'));
  const runs = calls.filter((t) => t.action === 'run');
  const judged = runs.filter((t) => !t.interrupted);
  const failed = judged.filter((t) => !t.ok).length;
  const worked = (action) => calls.filter((t) => t.action === action && t.ok).length;
  return {
    calls: calls.length,
    jobs: jobs.filter((j) => j.tools.some((t) => t.name === 'skill' && t.action === 'run')).length,
    runs: runs.length,
    failed,
    failRate: judged.length ? failed / judged.length : null,
    saves: worked('save'),
    forgets: worked('forget'),
    lists: calls.filter((t) => t.action === 'list').length
  };
}

function lessonsOf(lines, recent = 5) {
  const kept = lines.filter((l) => l.lesson);
  return {
    reviews: lines.length,
    kept: kept.length,
    cost: sum(lines.map((l) => num(l.cost))),
    recent: kept
      .slice(-recent)
      .reverse()
      .map((l) => ({ start: l.start, request: l.request, lesson: l.lesson }))
  };
}

function jobLine(job) {
  return {
    start: job.start,
    player: job.player,
    freeTime: job.freeTime,
    request: job.request,
    model: job.model,
    steps: job.steps.length,
    seconds: job.ms / 1000,
    cost: job.cost,
    end: job.end
  };
}

function trouble(jobs) {
  const pick = (test) => jobs.filter(test).map(jobLine);
  return {
    ended: pick((j) => TROUBLE_ENDS.includes(j.end)),
    nudged: pick((j) => j.nudges > 0),
    held: pick((j) => j.holds > 0),
    warned: pick((j) => j.costWarnings > 0),
    expensive: [...jobs].filter((j) => j.cost !== null).sort((a, b) => b.cost - a.cost).slice(0, 10).map(jobLine),
    slowest: [...jobs].sort((a, b) => b.ms - a.ms).slice(0, 10).map(jobLine)
  };
}

// A job's runs of successful calls in a row, each a list of tool names with a tool repeated back
// to back counted once.
export function toolRuns(job) {
  const runs = [];
  let run = [];
  for (const tool of job.tools) {
    if (CONTROL_TOOLS.has(tool.name)) continue;
    if (!tool.ok) {
      runs.push(run);
      run = [];
    } else if (run[run.length - 1] !== tool.name) run.push(tool.name);
  }
  runs.push(run);
  return runs;
}

// Runs of successful calls in a row (see toolRuns). Every stretch of 3 to maxLength tools in a
// run is counted, and unless keepInside, a stretch inside a longer one that came up just as often
// is dropped. Only stretches in minJobs jobs or more are kept.
export function findSequences(jobs, { minLength = 3, maxLength = 6, minCount = 3, minJobs = 2, top = 10, keepInside = false } = {}) {
  const found = new Map();
  jobs.forEach((job, index) => {
    for (const names of toolRuns(job)) {
      for (let length = minLength; length <= Math.min(maxLength, names.length); length++) {
        for (let i = 0; i + length <= names.length; i++) {
          const key = names.slice(i, i + length).join(' > ');
          if (!found.has(key)) found.set(key, { tools: names.slice(i, i + length), count: 0, jobs: new Set() });
          const entry = found.get(key);
          entry.count++;
          entry.jobs.add(index);
        }
      }
    }
  });
  const kept = [...found.values()].filter((e) => e.count >= minCount && e.jobs.size >= minJobs);
  const inside = (short, long) => long.tools.length > short.tools.length && ` ${long.tools.join(' ')} `.includes(` ${short.tools.join(' ')} `);
  return kept
    .filter((e) => keepInside || !kept.some((other) => other.count === e.count && inside(e, other)))
    .sort((a, b) => b.count - a.count || b.tools.length - a.tools.length || a.tools.join().localeCompare(b.tools.join()))
    .slice(0, top)
    .map((e) => ({ tools: e.tools, count: e.count, jobs: e.jobs.size }));
}

export function standOut(report, rules = RULES) {
  const found = [];
  for (const rule of rules) {
    const section = report[rule.section];
    const rows = Array.isArray(section) ? section : section ? [section] : [];
    for (const row of rows) {
      const value = row[rule.field];
      if (typeof value !== 'number') continue;
      if (Object.entries(rule.atLeast ?? {}).some(([field, min]) => !(row[field] >= min))) continue;
      const tripped = rule.over !== undefined ? value > rule.over : value < rule.under;
      if (!tripped) continue;
      const subject = rule.key ? row[rule.key] : rule.subject;
      const limit = rule.over ?? rule.under;
      const show = (v) => (rule.as === 'pct' ? pct(v) : count(v));
      found.push({
        rule: rule.label,
        subject,
        value,
        limit,
        text: `${subject}: ${rule.label} ${show(value)} (${rule.over !== undefined ? 'over' : 'under'} ${show(limit)})`
      });
    }
  }
  return found;
}

export function buildReport(jobs, { bad = 0, lessons = [], busyReplies = [], tidies = [], botName = null, rules = RULES } = {}) {
  const tiers = startTiers(jobs);
  const report = {
    jobs: jobs.length,
    badLines: bad,
    lessons: lessonsOf(lessons),
    totals: totalsOf(jobs, busyReplies, lessons, tidies),
    byModel: byModel(jobs),
    byTier: byTier(jobs, tiers),
    handovers: handovers(jobs, tiers, botName),
    tools: byTool(jobs),
    skills: skillsOf(jobs),
    trouble: trouble(jobs),
    sequences: findSequences(jobs)
  };
  return { standOut: standOut(report, rules), ...report };
}

function pct(share) {
  return share === null || share === undefined ? '-' : `${Math.round(share * 100)}%`;
}

function count(n) {
  if (n === null || n === undefined) return '-';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function money(dollars) {
  if (dollars === null || dollars === undefined) return '-';
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(4)}`;
}

function secs(ms) {
  if (ms === null || ms === undefined) return '-';
  const s = ms / 1000;
  return s < 100 ? s.toFixed(1) : String(Math.round(s));
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

const shortModel = (model) => (model ? model.replace(/^claude-/, '') : '-');

function when(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// align has an l or r for each column; columns past its end line up on the right.
function table(headers, rows, align = 'l') {
  const cells = [headers, ...rows].map((row) => row.map((c) => String(c)));
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells.map((row) =>
    '  ' +
    row
      .map((c, i) => (align[i] === 'l' ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join('  ')
      .trimEnd()
  );
}

function jobTable(lines, limit = lines.length) {
  const shown = lines.slice(0, limit);
  const rows = shown.map((j) => [
    when(j.start),
    j.freeTime ? '(free time)' : (j.player ?? '-'),
    shortModel(j.model),
    j.steps,
    secs(j.seconds * 1000),
    money(j.cost),
    j.end
  ]);
  const out = table(['time', 'player', 'model', 'steps', 's', 'cost', 'end'], rows, 'lllrrrl');
  const result = [out[0]];
  shown.forEach((j, i) => {
    result.push(out[i + 1]);
    if (j.request) result.push(`      ${j.request.replace(/\s+/g, ' ').slice(0, 60)}`);
  });
  if (lines.length > limit) result.push(`  and ${lines.length - limit} more`);
  return result;
}

function statsTable(rows, key, label) {
  return table(
    [label, 'jobs', 'steps', 'p90', '$/job', 'step s', 'first s', 'cached', 'after 1st', 'write', 'read'],
    rows.map((r) => [
      key(r),
      r.jobs,
      count(r.stepsMedian),
      count(r.stepsP90),
      money(r.costPerJob),
      secs(r.stepMsMedian),
      secs(r.firstMsMedian),
      pct(r.cacheHit),
      pct(r.cacheHitAfterFirst),
      tokens(r.cacheWrite),
      tokens(r.cacheRead)
    ])
  );
}

export function formatReport(report, path = 'jobs.jsonl') {
  const { totals, handovers: h, trouble: t } = report;
  const out = [];
  const section = (title, lines) => {
    if (!lines.length) return;
    out.push('', title, ...lines);
  };

  out.push(`Job report for ${path}: ${totals.jobs} jobs, ${when(totals.from)} to ${when(totals.to)}`);
  const apart = [
    [report.lessons.reviews, 'lesson line'],
    [totals.busyReplies, 'busy reply line'],
    [totals.tidies, 'note tidy line']
  ].filter(([n]) => n);
  if (apart.length) {
    const one = sum(apart.map(([n]) => n)) === 1;
    out.push(`Left out ${apart.map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`).join(' and ')}, which ${one ? 'is not a job' : 'are not jobs'}.`);
  }
  if (report.badLines) out.push(`Skipped ${report.badLines} line${report.badLines === 1 ? '' : 's'} that could not be read.`);

  section(
    'What stands out',
    report.standOut.length ? report.standOut.map((s) => `  - ${s.text}`) : ['  Nothing crossed a rule.']
  );

  const ends = Object.entries(totals.ends).map(([end, n]) => `${end} ${n}`).join(', ');
  const totalLines = [
    `  Jobs         ${totals.jobs}, ${count(Math.round(totals.perDay * 10) / 10)} a day`,
    `  Ended        ${ends}`,
    `  Cost         ${money(totals.cost)} in all, median ${money(totals.medianCost)} a job` +
      (totals.unknownCost ? `, ${totals.unknownCost} with no known price` : ''),
    `  Model time   ${secs(totals.modelMs)}s`,
    `  Tool time    ${secs(totals.toolMs)}s`
  ];
  if (totals.sideCalls) totalLines.push(`  Side calls   ${totals.sideCalls} in jobs, ${money(totals.sideCost)}`);
  if (totals.busyReplies) {
    const one = totals.busyReplies === 1;
    totalLines.push(
      `  Busy replies ${totals.busyReplies} on ${one ? 'a line of its own' : 'lines of their own'}, ${money(totals.busyCost)}, ` +
        `in the cost above but not ${one ? 'a job' : 'jobs'}`
    );
  }
  if (totals.tidies) totalLines.push(`  Note tidies  ${totals.tidies}, ${money(totals.tidyCost)}, in the cost above but not jobs`);
  const reflexes = Object.entries(totals.reflex ?? {});
  if (reflexes.length) totalLines.push(`  Reflex jobs  ${reflexes.map(([kind, n]) => `${kind} ${n}`).join(', ')}`);
  if (totals.rounds) totalLines.push(`  Rounds       ${totals.rounds} of standing jobs, ${money(totals.roundCost)}`);
  if (totals.days.length > 1) totalLines.push(`  By day       ${totals.days.slice(-14).map((d) => `${d.day.slice(5)} ${d.jobs}`).join(', ')}`);
  section('Totals', totalLines);

  if (report.byModel.length) section('By model', statsTable(report.byModel, (r) => shortModel(r.model), 'model'));
  if (report.byTier.length) section('By starting tier', statsTable(report.byTier, (r) => r.tier, 'tier'));
  if (report.byModel.length || report.byTier.length) {
    out.push('  steps and p90 are per job, step s and first s are medians, cached is the share of steps');
    out.push('  with a cache read, and write and read are cache tokens.');
  }

  if (h.quickJobs || h.pairs.length) {
    const lines = [
      `  Quick model jobs   ${h.quickJobs}, ${h.escalated} escalated (${pct(h.rate)})` +
        (h.escalated ? `: ${Object.entries(h.to).map(([to, n]) => `${n} to ${to}`).join(', ')}` : '')
    ];
    // Older records give no reason, so the table only shows once some job has one.
    if (h.reasons.length) {
      const rows = h.reasons.map((r) => [r.reason.slice(0, 40), r.count]);
      if (h.noReason) rows.push(['(none given)', h.noReason]);
      lines.push('  Reasons given for escalating:');
      lines.push(...table(['reason', 'jobs'], rows).map((l) => `  ${l}`));
    }
    if (h.escalated) {
      lines.push(`  First step         median ${secs(h.firstStepMsMedian)}s, ${secs(h.firstStepMsTotal)}s and ${money(h.firstStepCost)} in all`);
      if (h.nextStepMsMedian !== null) lines.push(`  Next step          median ${secs(h.nextStepMsMedian)}s and ${money(h.nextStepCostMedian)} on the new model`);
    }
    const other = h.pairs.filter((p) => p.from !== 'simple');
    if (other.length) lines.push(`  Other handovers    ${other.map((p) => `${p.from} to ${p.to} ${p.count}`).join(', ')}`);
    if (h.words.length) {
      lines.push('  Escalated requests began with:');
      lines.push(...table(['words', 'jobs'], h.words.map((w) => [w.words.slice(0, 40), w.count])).map((l) => `  ${l}`));
    }
    section('Handovers', lines);
  }

  if (report.tools.length) {
    const lines = table(
      ['tool', 'calls', 'interrupted', 'failed', 'med s', 'p90 s', 'total s'],
      report.tools.map((r) => [r.name, r.calls, r.interrupted || '-', r.failed ? pct(r.failRate) : '-', secs(r.msMedian), secs(r.msP90), secs(r.msTotal)])
    );
    const failing = report.tools.filter((r) => r.failures.length);
    if (failing.length) {
      lines.push('', '  Common failures');
      for (const r of failing) {
        lines.push(`  ${r.name}`);
        for (const f of r.failures) lines.push(`    ${String(f.count).padStart(3)}  ${f.text.slice(0, 88)}`);
      }
    }
    section('By tool', lines);
  }

  const sk = report.skills;
  if (sk.calls) {
    section('Skills', [
      `  Runs         ${sk.runs} in ${sk.jobs} job${sk.jobs === 1 ? '' : 's'}, ${sk.failed} failed (${pct(sk.failRate)})`,
      `  Saved        ${sk.saves}, forgot ${sk.forgets}, listed ${sk.lists}`
    ]);
  }

  const ls = report.lessons;
  if (ls.reviews) {
    const lines = [`  Reviews      ${ls.reviews} ran, ${ls.kept} kept a lesson, ${money(ls.cost)}, in the cost under Totals`];
    for (const l of ls.recent) {
      const text = l.lesson.replace(/\s+/g, ' ');
      lines.push(`  ${when(l.start)}  ${text.length > 85 ? `${text.slice(0, 82)}...` : text}`);
    }
    section('Lessons', lines);
  }

  section('Ended early', t.ended.length ? jobTable(t.ended, 20) : []);
  section('Nudged', t.nudged.length ? jobTable(t.nudged, 10) : []);
  section('Put on hold', t.held.length ? jobTable(t.held, 10) : []);
  section('Cost warnings', t.warned.length ? jobTable(t.warned, 10) : []);
  section('Most expensive', t.expensive.length ? jobTable(t.expensive) : []);
  section('Slowest', t.slowest.length ? jobTable(t.slowest) : []);

  section(
    'Sequences',
    report.sequences.length
      ? [
          ...table(['times', 'jobs', 'tools'], report.sequences.map((s) => [s.count, s.jobs, s.tools.join(' > ')]), 'rrl'),
          '  A tool repeated back to back counts once.'
        ]
      : []
  );
  return out.join('\n');
}

function botNameFrom(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).bot?.username ?? null;
  } catch {
    return null;
  }
}

export function main(argv, { out = console.log, now = Date.now(), configPath = 'config.json' } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    out(args.error);
    return 1;
  }
  if (!existsSync(args.path)) {
    out(`No job log at ${args.path}, so nothing to report.`);
    return 0;
  }
  const { jobs, bad, lessons, busyReplies, tidies } = parseLog(readFileSync(args.path, 'utf8'));
  if (!jobs.length) {
    out(`No jobs in ${args.path}${bad ? ` (${bad} line${bad === 1 ? '' : 's'} could not be read)` : ''}, so nothing to report.`);
    return 0;
  }
  const picked = filterJobs(jobs, { ...args, now });
  if (!picked.length) {
    out(`No jobs in ${args.path} match those filters.`);
    return 0;
  }
  const report = buildReport(picked, {
    bad,
    lessons: filterJobs(lessons, { ...args, now }),
    busyReplies: filterJobs(busyReplies, { ...args, now }),
    tidies: filterJobs(tidies, { ...args, now }),
    botName: args.bot ?? botNameFrom(configPath)
  });
  out(args.json ? JSON.stringify(report, null, 2) : formatReport(report, args.path));
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (entry === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = main(process.argv.slice(2));
