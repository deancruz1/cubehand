// Look before building: a player's build_structure of some size runs only once the same plan has
// been drawn with preview_structure, so she sees it and fixes what looks plain or wrong first.
import { createHash } from 'node:crypto';

// How many previewed and built plans the brain remembers, across jobs.
const KEEP_PLANS = 30;
// A plan this big counts, judged from the input without expanding it: this many parts and single
// blocks together, or one part whose box holds more than BIG_PART blocks.
const BIG_PLAN_ITEMS = 8;
const BIG_PART = 150;
// Fields of a call that say how to draw, check or clear for the plan, not what it looks like.
const NOT_PLAN = new Set(['views', 'cut_above', 'dry_run', 'replace', 'clear']);

// What a build_structure call may set next to plan, the id of a previewed plan.
const WITH_PLAN = new Set(['plan', 'origin', 'clear', 'replace', 'dry_run']);

export const PREVIEW_FIRST =
  'Not built: preview this plan first with preview_structure, look at the pictures, fix what looks plain or wrong, then build the plan you previewed by its id (build_structure with plan; it may go at another origin).';

const planId = (id) => String(id).trim().toLowerCase();
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0);

// The same value with object keys in order, and empty or missing fields left out.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

// A short fingerprint of the plan in a call's input, with or without its origin.
export function planKey(input, { origin = true } = {}) {
  const plan = Object.fromEntries(Object.entries(input ?? {}).filter(([k]) => !NOT_PLAN.has(k) && (origin || k !== 'origin')));
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex').slice(0, 32);
}

export function isBigPlan(input) {
  const parts = Array.isArray(input?.parts) ? input.parts : [];
  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];
  if (parts.length + blocks.length >= BIG_PLAN_ITEMS) return true;
  return parts.some((p) => {
    const from = p?.from ?? {};
    const to = p?.to ?? from;
    const side = (k) => Math.abs(Number(to[k] ?? 0) - Number(from[k] ?? 0)) + 1;
    return side('dx') * side('dy') * side('dz') > BIG_PART;
  });
}

const remember = (list, key) => {
  const i = list.indexOf(key);
  if (i !== -1) list.splice(i, 1);
  list.push(key);
  if (list.length > KEEP_PLANS) list.shift();
};

// Methods of the Brain class, put on it in brain.js, so this is the brain.
export const previewMethods = {
  // The line a build_structure call is turned back with, or null when it may run. Only a player's
  // own job is held to it: free time, chores and rounds of the standing job build as before.
  previewFirst(run, block) {
    if (block.name !== 'build_structure' || block.input?.dry_run === true) return null;
    if (this.config.bot?.previewBuilds === false || run.self || run.job.standing) return null;
    if (!isBigPlan(block.input)) return null;
    this.previewedPlans ??= [];
    this.builtPlans ??= [];
    // A plan built before at the same spot is mostly standing already, so it goes through.
    if (this.previewedPlans.includes(planKey(block.input, { origin: false })) || this.builtPlans.includes(planKey(block.input))) return null;
    return PREVIEW_FIRST;
  },

  // The input a build_structure call runs with, as { input }, or { error } with the line it is
  // turned back with. A call that names a previewed plan by its id gets that plan as it was drawn,
  // with the call's own origin, clear, replace and dry_run on top, so the plan is written once.
  planInput(block) {
    const id = block.name === 'build_structure' ? block.input?.plan : undefined;
    if (isEmpty(id)) return { input: block.input };
    const saved = this.savedPlans?.get(planId(id));
    if (!saved) {
      return { error: `Not built: no previewed plan "${id}" is kept (the last ${KEEP_PLANS} are, until a restart). Preview the plan again and build it by the id that gives.` };
    }
    const extra = Object.keys(block.input).filter((k) => !WITH_PLAN.has(k) && !isEmpty(block.input[k]));
    if (extra.length) {
      return { error: `Not built: plan "${id}" is built as it was previewed, so leave out ${extra.join(', ')}. To change it, preview the changed plan and build that one by its id.` };
    }
    const own = Object.fromEntries(Object.entries(block.input).filter(([k, v]) => k !== 'plan' && v !== undefined && v !== null));
    return { input: { ...saved, ...own } };
  },

  // Remembers a plan that was drawn, or one that a build_structure call worked on. For a plan
  // that was drawn, returns the line that tells the model the id to build it by.
  notePlan(block, result) {
    if (block.name === 'build_structure' && block.input?.dry_run !== true && result) remember((this.builtPlans ??= []), planKey(block.input));
    if (block.name !== 'preview_structure' || !result?.ok) return null;
    remember((this.previewedPlans ??= []), planKey(block.input, { origin: false }));
    const plan = Object.fromEntries(Object.entries(block.input ?? {}).filter(([k]) => !['views', 'cut_above', 'dry_run'].includes(k)));
    const key = planKey(plan);
    this.savedPlans ??= new Map();
    let id = [...this.savedPlans].find(([, p]) => planKey(p) === key)?.[0];
    if (!id) {
      this.planCount = (this.planCount ?? 0) + 1;
      id = `p${this.planCount}`;
    }
    // Put last again, so the plans drawn longest ago go first.
    this.savedPlans.delete(id);
    this.savedPlans.set(id, plan);
    if (this.savedPlans.size > KEEP_PLANS) this.savedPlans.delete(this.savedPlans.keys().next().value);
    return `Kept as plan ${id}. To build it, call build_structure with plan "${id}" and nothing else, instead of writing the plan out again (add origin to put it somewhere else, or clear, replace or dry_run).`;
  }
};
