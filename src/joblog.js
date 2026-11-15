import { appendFileSync } from 'node:fs';

// US dollars per million tokens. Cache writes cost more for the 1 hour lifetime than for 5 minutes.
const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, write5m: 10, write1h: 16 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 }
};
// Haiku 5.5 has a second, dearer rate card for prompts over 100K tokens.
const HAIKU = {
  short: { input: 0.1, output: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 },
  long: { input: 0.5, output: 2.5, cacheRead: 0.05, write5m: 0.625, write1h: 1 }
};
const HAIKU_LONG_PROMPT = 100000;

export function meters(usage) {
  const tokens = {
    input: usage?.input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0
  };
  const split = usage?.cache_creation;
  if (split) {
    tokens.cacheWrite5m = split.ephemeral_5m_input_tokens ?? 0;
    tokens.cacheWrite1h = split.ephemeral_1h_input_tokens ?? 0;
  }
  return tokens;
}

function priceFor(model, tokens) {
  if (model === 'claude-haiku-5-5') {
    return tokens.input + tokens.cacheRead + tokens.cacheWrite > HAIKU_LONG_PROMPT ? HAIKU.long : HAIKU.short;
  }
  return PRICES[model] ?? null;
}

const round = (dollars) => Math.round(dollars * 1e6) / 1e6;

// Cost in dollars of one call, or null for a model with no known price. Writes that the API
// didn't split by lifetime are priced as 5 minute writes.
export function costOf(model, tokens) {
  const price = priceFor(model, tokens);
  if (!price) return null;
  const write1h = tokens.cacheWrite1h ?? 0;
  const write5m = tokens.cacheWrite5m ?? tokens.cacheWrite - write1h;
  const dollars =
    tokens.input * price.input +
    tokens.cacheRead * price.cacheRead +
    write5m * price.write5m +
    write1h * price.write1h +
    tokens.output * price.output;
  return round(dollars / 1e6);
}

function addTokens(total, tokens) {
  for (const [key, value] of Object.entries(tokens)) total[key] = (total[key] ?? 0) + value;
  return total;
}

// One job from start to end: every model call (steps, mid-job replies) and every tool.
export class JobRecord {
  constructor({ player = null, text = null, self = false } = {}) {
    this.startedAt = Date.now();
    this.player = player;
    this.text = text;
    this.self = self;
    // Times the job was put on hold (low health, a lost connection) and how long in all.
    this.holds = 0;
    this.heldMs = 0;
    this.tier = null;
    this.model = null;
    this.effort = null;
    this.end = null;
    this.error = null;
    this.calls = [];
    this.steps = [];
    this.finished = false;
  }

  // A side call, like 'busy' for a mid-job reply.
  call(kind, model, usage, ms) {
    const tokens = meters(usage);
    this.calls.push({ kind, model, ms, tokens, cost: costOf(model, tokens) });
  }

  step(model, usage, ms) {
    const tokens = meters(usage);
    const step = { model, ms, tokens, cost: costOf(model, tokens), tools: [] };
    this.steps.push(step);
    return step;
  }

  finish(end) {
    this.finished = true;
    const calls = [...this.calls, ...this.steps];
    const tokens = calls.reduce((total, c) => addTokens(total, c.tokens), {});
    const cost = calls.some((c) => c.cost === null) ? null : round(calls.reduce((sum, c) => sum + c.cost, 0));
    const toolMs = this.steps.reduce((sum, s) => sum + s.tools.reduce((t, tool) => t + tool.ms, 0), 0);
    return {
      start: new Date(this.startedAt).toISOString(),
      player: this.player,
      request: this.text,
      freeTime: this.self,
      holds: this.holds,
      heldMs: this.heldMs,
      tier: this.tier,
      model: this.model,
      effort: this.effort,
      end,
      ...(this.error ? { error: this.error } : {}),
      ms: Date.now() - this.startedAt,
      calls: this.calls,
      steps: this.steps,
      totals: { steps: this.steps.length, modelMs: calls.reduce((sum, c) => sum + c.ms, 0), toolMs, tokens, cost }
    };
  }
}

export function summaryLine(line) {
  const { totals } = line;
  const t = totals.tokens;
  const seconds = (ms) => (ms / 1000).toFixed(1);
  const cost = totals.cost === null ? 'cost unknown' : `$${totals.cost.toFixed(4)}`;
  return (
    `[job] ${line.end}: ${totals.steps} steps, model ${seconds(totals.modelMs)}s, tools ${seconds(totals.toolMs)}s, ` +
    `tokens in ${t.input ?? 0}, cache read ${t.cacheRead ?? 0}, cache write ${t.cacheWrite ?? 0}, out ${t.output ?? 0}, ${cost}` +
    (line.heldMs ? `, held ${seconds(line.heldMs)}s` : '')
  );
}

// One JSON line per job. A file problem is logged and never stops a job.
export class JobLog {
  constructor(path = 'jobs.jsonl', log = console.log) {
    this.path = path;
    this.log = log;
  }

  write(line) {
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n');
    } catch (err) {
      this.log(`[joblog] couldn't write ${this.path}: ${err.message}`);
    }
  }
}
