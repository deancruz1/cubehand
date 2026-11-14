import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from './tools.js';
import { systemPrompt } from './prompt.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUILD_WORDS = /\b(build|construct|house|hut|cabin|shelter|tower|bridge)\b/i;
const BUILD_TOOLS = new Set(['build_house', 'build_structure']);
// Time spent in a build tool doesn't count against the job, up to this much per call.
const BUILD_TOOL_SECONDS = 3600;
// Plan notes go to chat at most this often, so quick steps don't flood it.
const PLAN_GAP_MS = 8000;

const BUSY_INSTRUCTIONS = `Decide what to do with the new message. Reply with exactly one of:
- QUEUE, if it asks you to do something new once your current job is done, or you can't tell.
- UPDATE, if it changes or adds to the job you're doing now (a size, a side, a spot, materials, one more thing to include), so you work it in right away.
- NOW, if they want you to drop the current job and do the new thing right away.
- STOP, if they want you to stop or cancel the current job.
- Otherwise, when it's a question or chat you can answer from the snapshot (what you're doing, how it's going, where something is), your short chat reply to them, one or two sentences.`;

const FREE_TIME = `Nobody has asked you for anything right now, so you have some free time. If there is something small and useful you'd like to do on your own, do it in a few steps. For example: smelt ores you carry, craft a tool you're missing, put spare items away in the right chests, gather a little wood, stone or food for later, or check on your house. Stay within about 32 blocks, never break or change anything players built, and don't start anything long. Don't chat unless you have something worth saying. If nothing is worth doing, reply with only: nothing`;

const RESUMED = '\n(You stopped this job earlier to look after yourself. Carry on from where you left off.)';

// Building takes more thought and more time than most jobs.
export function isBuildRequest(text) {
  return BUILD_WORDS.test(text);
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
  constructor({ client, config, runTool, snapshot, say, onStop, onJobStart, beforeStep, watchTool, log = console.log }) {
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
    this.lastPlanAt = 0;
    this.queue = [];
    this.current = null;
    this.paused = false;
    this.lastJobEnd = Date.now();
    this.lastFreeTime = Date.now();
    this.system = systemPrompt(config.bot.username);
  }

  get busy() {
    return this.current !== null;
  }

  enqueue(player, text) {
    // Free time gives way to players right away.
    if (this.current?.self) {
      this.queue.unshift({ player, text });
      this.abortCurrent('replaced');
      return;
    }
    if (this.paused) {
      this.queue.push({ player, text });
      this.say(`${player}, got it. I'll do that once I'm safe.`);
      return;
    }
    if (!this.busy) {
      this.start({ player, text });
      return;
    }
    if (this.queue.length >= this.config.limits.queueSize) {
      this.say(`${player}, I'm busy and my queue is full. Try again in a bit.`);
      return;
    }
    if (this.config.claude.busyReplies === false) {
      this.addToQueue(player, text);
      return;
    }
    this.busyReply(player, text).catch((err) => {
      this.log(`[brain] busy reply failed: ${err.message}`);
      this.addToQueue(player, text);
    });
  }

  addToQueue(player, text) {
    this.queue.push({ player, text });
    this.say(`${player}, got it. I'll do that after my current job.`);
  }

  // A message that comes in mid-job gets a quick look without tools, so questions are answered
  // right away instead of waiting in the queue.
  async busyReply(player, text) {
    const { claude } = this.config;
    const job = this.current;
    const response = await this.client.beta.messages.create({
      model: claude.model,
      max_tokens: 2000,
      system: this.system,
      messages: [
        {
          role: 'user',
          content: `${this.snapshot()}\n\nYou are busy with a job from ${job?.player}: "${job?.text}".\n${player} just said: ${text}\n\n${BUSY_INSTRUCTIONS}`
        }
      ],
      output_config: { effort: 'low' }
    });
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const word = reply.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!reply || word === 'QUEUE') {
      if (this.busy) this.addToQueue(player, text);
      else this.start({ player, text });
    } else if (word === 'UPDATE') {
      if (job && this.current === job) this.addToJob(job, player, text);
      else if (this.busy) this.addToQueue(player, text);
      else this.start({ player, text });
    } else if (word === 'NOW') {
      if (this.busy) {
        this.queue.unshift({ player, text });
        this.say(`Okay ${player}, switching to that.`);
        this.abortCurrent('replaced');
      } else {
        this.start({ player, text });
      }
    } else if (word === 'STOP') {
      this.stop();
    } else {
      this.say(reply);
    }
  }

  // More instructions for the job in progress. The tool that's running stops, so the model sees
  // them before it does anything else.
  addToJob(job, player, text) {
    job.notes.push({ player, text });
    job.tool?.abort('update');
    this.say(`Okay ${player}, I'll work that in.`);
  }

  takeNotes(job) {
    return job.notes
      .splice(0)
      .map(({ player, text }) => ({ type: 'text', text: `While you were working, ${player} said: ${text}\nWork this into the job you're doing now.` }));
  }

  // Notes go at the end of the next message to the model.
  deliverNotes(job, messages) {
    const last = messages.at(-1);
    if (job.notes.length === 0 || last.role !== 'user') return;
    const notes = this.takeNotes(job);
    last.content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }, ...notes] : [...last.content, ...notes];
  }

  stop() {
    this.queue = [];
    this.abortCurrent('stop');
    this.onStop();
    this.say('Stopped.');
  }

  abortCurrent(reason) {
    if (this.current) this.current.controller.abort(reason);
  }

  // Something urgent comes first (low health): the current job stops and goes back to the front
  // of the queue, and nothing else starts until resume().
  async pause() {
    this.paused = true;
    const job = this.current;
    if (!job) return;
    if (!job.self) this.queue.unshift({ player: job.player, text: job.text, resumed: true, notes: [...job.notes] });
    job.controller.abort('danger');
    await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
  }

  resume() {
    this.paused = false;
    if (this.busy) return;
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  // A job the bot picks for itself when nobody needs it.
  freeTime() {
    if (this.busy || this.paused || this.queue.length > 0) return false;
    this.lastFreeTime = Date.now();
    this.start({ player: null, text: null, self: true });
    return true;
  }

  start(request) {
    const controller = new AbortController();
    const job = { controller, done: null, player: request.player, text: request.text, self: Boolean(request.self), notes: [...(request.notes ?? [])], tool: null };
    this.current = job;
    job.done = Promise.resolve()
      .then(() => this.onJobStart?.(job))
      .catch(() => {})
      .then(() => this.handle(request, controller.signal, job))
      .catch((err) => {
        this.log(`[brain] request crashed: ${err.stack ?? err.message}`);
        if (!job.self) this.say('Something went wrong on my end.');
      })
      .finally(() => {
        this.current = null;
        this.lastJobEnd = Date.now();
        // Instructions the job never got to, like when it ran out of time, become requests of their own.
        const reason = controller.signal.aborted ? controller.signal.reason : null;
        if (reason === null || reason === 'time') this.queue.unshift(...job.notes.map(({ player, text }) => ({ player, text })));
        if (this.paused) return;
        const next = this.queue.shift();
        if (next) this.start(next);
      });
    return job.done;
  }

  createMessage(messages, signal, effort = this.config.claude.effort) {
    const { claude } = this.config;
    const params = {
      model: claude.model,
      max_tokens: claude.maxTokens,
      system: this.system,
      // Smaller models reject the strict grammar once there are many tools.
      tools: claude.strictTools ? TOOLS : TOOLS.map(({ strict, ...rest }) => rest),
      messages,
      output_config: { effort },
      cache_control: { type: 'ephemeral' }
    };
    if (claude.fallback) {
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

  endedByAbort(signal, self = false) {
    const reason = signal.reason;
    if (reason === 'time') {
      this.onStop();
      if (!self) this.say('I ran out of time on that one.');
    }
    // 'stop' already confirmed in chat, 'death' and 'shutdown' are reported elsewhere, 'danger'
    // by the survival routine, and 'replaced' needs nothing.
  }

  async handle({ player, text, self = false, resumed = false }, signal, job = { notes: [] }) {
    const { limits, claude, idle } = this.config;
    let build = !self && isBuildRequest(text);
    const buildSeconds = limits.buildMaxSeconds ?? 1200;
    const buildSteps = limits.buildMaxSteps ?? 40;
    const buildEffort = claude.buildEffort ?? 'high';
    const moreEffort = EFFORTS.indexOf(buildEffort) > EFFORTS.indexOf(claude.effort) ? buildEffort : claude.effort;
    const maxSeconds = self ? idle.freeTimeSeconds : build ? buildSeconds : limits.maxSeconds;
    let maxSteps = self ? idle.freeTimeSteps : build ? buildSteps : limits.maxSteps;
    let effort = build ? moreEffort : claude.effort;
    const started = Date.now();
    let deadline = started + maxSeconds * 1000;
    let timer;
    const setDeadline = (at) => {
      clearTimeout(timer);
      timer = setTimeout(() => this.current?.controller.abort('time'), Math.max(at - Date.now(), 0));
    };
    setDeadline(deadline);
    this.log(self ? '[brain] free time' : `[brain] request from ${player}: ${text}${build ? ' (build)' : ''}${resumed ? ' (resumed)' : ''}`);
    const ended = () => this.endedByAbort(signal, self);

    try {
      const ask = self ? FREE_TIME : `Request from ${player}: ${text}${resumed ? RESUMED : ''}`;
      const messages = [{ role: 'user', content: `${this.snapshot()}\n\n${ask}` }];

      for (let step = 1; step <= maxSteps; step++) {
        if (signal.aborted) return ended();
        await this.beforeStep?.();
        if (signal.aborted) return ended();
        this.deliverNotes(job, messages);

        let response;
        try {
          response = await this.createMessage(messages, signal, effort);
        } catch (err) {
          if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return ended();
          this.log(`[brain] API error: ${err.message}`);
          if (!self) this.say(errorMessage(err));
          return;
        }
        this.logUsage(step, response.usage);

        if (response.stop_reason === 'refusal') {
          if (!self) this.say("I can't help with that one.");
          return;
        }
        if (response.stop_reason === 'max_tokens') {
          if (!self) this.say('My answer got cut off. Try asking for something smaller.');
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
          if (reply && !(self && /^nothing\W*$/i.test(reply))) this.say(reply);
          // Something a player added during the last step still has to be worked in.
          if (job.notes.length) {
            messages.push({ role: 'user', content: this.takeNotes(job) });
            continue;
          }
          return;
        }

        // The short note the model writes next to its tool calls says what it's about to do.
        const plan = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (plan) {
          this.log(`[brain] plan: ${plan}`);
          if (!self && Date.now() - this.lastPlanAt >= PLAN_GAP_MS) {
            this.say(plan);
            this.lastPlanAt = Date.now();
          }
        }

        const results = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          if (signal.aborted) return ended();
          if (job.notes.length) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Not done, because a player just changed the instructions (see below).', is_error: true });
            continue;
          }
          this.log(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
          const building = !self && BUILD_TOOLS.has(block.name);
          // A job that turns into a build, like "carry on", gets the build budget from here on.
          if (building && !build) {
            build = true;
            maxSteps = Math.max(maxSteps, buildSteps);
            effort = moreEffort;
            deadline = Math.max(deadline, started + buildSeconds * 1000);
            this.log('[brain] this job is a build now');
          }
          // Time spent building doesn't count, since a big house can take a while.
          const left = deadline - Date.now();
          if (building) setDeadline(Date.now() + Math.max(left, BUILD_TOOL_SECONDS * 1000));
          const tool = new AbortController();
          job.tool = tool;
          const watch = this.watchTool?.(block.name, tool);
          let result;
          try {
            result = await this.runTool(block.name, block.input, AbortSignal.any([signal, tool.signal]));
          } finally {
            watch?.stop();
            job.tool = null;
          }
          if (building) {
            deadline = Date.now() + Math.max(left, 120000);
            setDeadline(deadline);
          }
          const why = tool.signal.aborted && !signal.aborted ? tool.signal.reason : null;
          let content = result.message;
          if (why === 'update') content += ' (Stopped because a player just changed the instructions, see below.)';
          if (why === 'stuck') content += ` (${watch?.report() ?? 'I stopped this myself: nothing was changing.'} Work out what's in the way before trying the same thing again.)`;
          this.log(`[tool] -> ${result.ok && !why ? 'ok' : 'failed'}: ${result.message}${why ? ` (${why})` : ''}`);
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

      if (!self) this.say('I ran out of steps on that one.');
    } finally {
      clearTimeout(timer);
    }
  }
}
