import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain, chatPart, deathText } from '../src/brain.js';
import { RefusalLog } from '../src/joblog.js';
import { Lessons, worthLesson } from '../src/lessons.js';

const baseConfig = {
  bot: { username: 'Clodine' },
  claude: { model: 'claude-opus-5-5', effort: 'medium', fallback: true, strictTools: true, streaming: true, maxTokens: 16000, busyReplies: false },
  limits: { maxSteps: 25, maxSeconds: 60, queueSize: 3 }
};
const plain = { ...baseConfig, claude: { ...baseConfig.claude, streaming: false } };

function toolUse(id, name, input = {}) {
  return { type: 'tool_use', id, name, input };
}

function reply(stop_reason, content) {
  return { stop_reason, content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } };
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

// The server-sent events the API streams for a message. gates[i], if given, holds the events back
// until it resolves, before content block i starts, and gates.end before the message ends.
function eventsOf({ gates = {}, content, usage, stop_reason, stop_details, ...rest }) {
  const start = sse('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', ...rest, content: [], stop_reason: null, stop_sequence: null, usage } });
  const parts = [{ data: start }];
  content.forEach((block, index) => {
    let data;
    if (block.type === 'text') {
      const half = Math.ceil(block.text.length / 2);
      const deltas = [block.text.slice(0, half), block.text.slice(half)].filter(Boolean);
      data = sse('content_block_start', { index, content_block: { ...block, text: '' } }) + deltas.map((text) => sse('content_block_delta', { index, delta: { type: 'text_delta', text } })).join('');
    } else if (block.type === 'thinking') {
      data =
        sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
        sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }) +
        sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      data = sse('content_block_start', { index, content_block: { ...block, input: {} } }) + sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      data = sse('content_block_start', { index, content_block: block });
    }
    parts.push({ gate: gates[index], data: data + sse('content_block_stop', { index }) });
  });
  parts.push({ gate: gates.end, data: sse('message_delta', { delta: { stop_reason, stop_sequence: null, ...(stop_details ? { stop_details } : {}) }, usage }) + sse('message_stop', {}) });
  return parts;
}

function sseResponse(message, signal) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        } catch {}
      });
      (async () => {
        for (const { gate, data } of eventsOf(message)) {
          if (gate) await gate;
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(data));
        }
        controller.close();
      })();
    }
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

// The SDK itself, with a fetch that streams back each answer it's given, in order.
function streamingSdk() {
  const answers = [];
  const sdk = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async (url, init) => sseResponse(answers.shift(), init.signal) });
  // Like beta.messages.stream: an error comes out of finalMessage(), and a stop before the
  // answer is ready ends it the way the SDK does.
  return (params, opts, next) => {
    const listeners = [];
    const aborted = new Promise((resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true }));
    const final = Promise.race([Promise.resolve(next), aborted]).then((message) => {
      if (message instanceof Error) throw message;
      if (!message) return message;
      answers.push(message);
      const stream = sdk.beta.messages.stream(params, opts);
      for (const listener of listeners) stream.on('streamEvent', listener);
      return stream.finalMessage();
    });
    return {
      on(event, listener) {
        if (event === 'streamEvent') listeners.push(listener);
        return this;
      },
      finalMessage: () => final
    };
  };
}

// A fake client that hands back scripted responses and records every request.
function fakeClient(responses) {
  const calls = [];
  const stream = streamingSdk();
  const next = () => (typeof responses === 'function' ? responses(calls.length) : responses.shift());
  return {
    calls,
    beta: {
      messages: {
        create: async (params, opts) => {
          calls.push({ params: structuredClone({ ...params }), opts });
          const answer = next();
          if (answer instanceof Error) throw answer;
          return answer;
        },
        stream: (params, opts) => {
          calls.push({ params: structuredClone({ ...params }), opts, streamed: true });
          return stream(params, opts, next());
        }
      }
    }
  };
}

function makeBrain({ client, config = baseConfig, runTool, jobLog, onThinking, lessons, skills, snapshot = () => 'SNAPSHOT', forgetRequests, forgetChat, watchTool, log = () => {} }) {
  const said = [];
  const heard = [];
  const toolCalls = [];
  const thinks = [];
  let stops = 0;
  const brain = new Brain({
    client,
    config,
    jobLog,
    lessons,
    skills,
    runTool: runTool ?? (async (name, input) => {
      toolCalls.push({ name, input });
      return { ok: true, message: `${name} done` };
    }),
    snapshot,
    forgetRequests,
    forgetChat,
    say: (text, to = null) => {
      said.push(text);
      heard.push({ text, to });
    },
    onStop: () => stops++,
    onThinking: onThinking ?? ((active) => thinks.push(active)),
    watchTool,
    log
  });
  return { brain, said, heard, toolCalls, thinks, stops: () => stops };
}

test('runs tools, sends results back, and says the final reply', async () => {
  for (const config of [plain, baseConfig]) {
    const client = fakeClient([
      reply('tool_use', [toolUse('a', 'go_to_player', { player: 'Steve' }), toolUse('b', 'place_block', { block: 'torch', x: 1, y: 2, z: 3 })]),
      reply('end_turn', [{ type: 'text', text: 'Torch placed.' }])
    ]);
    const { brain, said, toolCalls } = makeBrain({ client, config });
    await brain.start({ player: 'Steve', text: 'Clodine come here and place a torch' });

    assert.deepEqual(toolCalls.map((t) => t.name), ['go_to_player', 'place_block']);
    assert.deepEqual(said, ['Torch placed.']);

    const second = client.calls[1].params.messages;
    assert.equal(second.length, 3);
    assert.equal(second[1].role, 'assistant');
    assert.equal(second[1].content.length, 2);
    assert.equal(second[2].role, 'user');
    assert.deepEqual(second[2].content.map((r) => r.tool_use_id), ['a', 'b']);
  }
});

test('the first message holds the snapshot and the request', async () => {
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Hi!' }])]);
  const { brain } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'Clodine hi' });
  const first = client.calls[0].params.messages[0];
  assert.match(first.content, /SNAPSHOT/);
  assert.match(first.content, /Request from Steve: Clodine hi/);
});

test('request settings: model, effort, caching, strict tools, fallback', async () => {
  const client = fakeClient([reply('end_turn', [])]);
  const { brain } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'hi' });
  const params = client.calls[0].params;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.deepEqual(params.output_config, { effort: 'medium' });
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(params.system.length, 1);
  assert.equal(params.system[0].type, 'text');
  assert.match(params.system[0].text, /Clodine/);
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(params.tools.every((t) => t.strict === true));
});

test('fallback can be turned off', async () => {
  const client = fakeClient([reply('end_turn', [])]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, fallback: false } };
  const { brain } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'hi' });
  assert.equal(client.calls[0].params.fallbacks, undefined);
  assert.equal(client.calls[0].params.betas, undefined);
});

test('strict tools can be turned off', async () => {
  const client = fakeClient([reply('end_turn', [])]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, strictTools: false } };
  const { brain } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'hi' });
  assert.ok(client.calls[0].params.tools.every((t) => !('strict' in t)));
});

test('a failed tool is sent back with is_error', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'move_to', { x: 0, y: 0, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: "I can't get there." }])
  ]);
  const { brain } = makeBrain({ client, config: plain, runTool: async () => ({ ok: false, message: 'no path' }) });
  await brain.start({ player: 'Steve', text: 'go' });
  const result = client.calls[1].params.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'no path');
});

test('refusal and max_tokens end the request with a chat message', async () => {
  for (const config of [plain, baseConfig]) {
    const client = fakeClient(() => reply('refusal', []));
    const refused = makeBrain({ client, config });
    await refused.brain.start({ player: 'Steve', text: 'x' });
    assert.deepEqual(refused.said, ["I can't help with that one."]);
    assert.equal(refused.toolCalls.length, 0);
    assert.equal(client.calls.length, 2);

    const cut = makeBrain({ client: fakeClient([reply('max_tokens', [toolUse('a', 'say', { message: 'hi' })])]), config });
    await cut.brain.start({ player: 'Steve', text: 'x' });
    assert.match(cut.said[0], /cut off/);
    assert.equal(cut.toolCalls.length, 0);
  }
});

test('step limit stops the loop and tells the player', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'stop_moving')]));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 3 } };
  const { brain, said } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'x' });
  assert.equal(client.calls.length, 3);
  assert.deepEqual(said, ['I ran out of steps on that one.']);
});

// A client whose every answer takes ms, and that gives up when the request is aborted.
function slowClient(ms, answer) {
  const calls = [];
  const stream = streamingSdk();
  return {
    calls,
    beta: {
      messages: {
        create: (params, opts) => {
          calls.push({ params: structuredClone({ ...params }), opts });
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(answer()), ms);
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Anthropic.APIUserAbortError());
            });
          });
        },
        stream: (params, opts) => {
          calls.push({ params: structuredClone({ ...params }), opts, streamed: true });
          const later = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(answer()), ms);
            opts?.signal?.addEventListener('abort', () => clearTimeout(timer));
          });
          return stream(params, opts, later);
        }
      }
    }
  };
}

test('time limit stops a job that thinks too long and tells the player', async () => {
  const client = slowClient(200, () => reply('end_turn', [{ type: 'text', text: 'Done.' }]));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05 } };
  const { brain, said, stops } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'x' });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(said, ['I ran out of time on that one.']);
  assert.equal(stops(), 1);
});

test('time inside any tool does not count against the job', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05 } };
  const slowMine = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, message: 'mined 64' }), 150));
  const { brain, said } = makeBrain({ client, config, runTool: slowMine });
  await brain.start({ player: 'Steve', text: 'mine 64 stone' });
  assert.deepEqual(said, ['Mined.']);
});

test('a tool call that runs past its ceiling is stopped and the job carries on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = fakeClient([reply('tool_use', [toolUse('a', 'go_to', { x: 0, y: 0, z: 0 })]), reply('end_turn', [{ type: 'text', text: 'Still far.' }])]);
  let started;
  const toolStarted = new Promise((r) => (started = r));
  const hung = (name, input, signal) =>
    new Promise((resolve) => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped walking' }));
    });
  const { brain, said } = makeBrain({ client, runTool: hung });
  const job = brain.start({ player: 'Steve', text: 'go far away' });
  await toolStarted;
  t.mock.timers.tick(1800 * 1000);
  await job;
  assert.deepEqual(said, ['Still far.']);
  const result = client.calls[1].params.messages[2].content[0];
  assert.match(result.content, /stopped walking \(Stopped because one call can run for at most 30 minutes\.\)/);
});

test('stop cancels the current request, clears the queue and confirms', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'build_structure')]));
  let started;
  const toolStarted = new Promise((r) => (started = r));
  const slowTool = (name, input, signal) =>
    new Promise((resolve) => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }));
    });
  const { brain, said, stops } = makeBrain({ client, runTool: slowTool });

  const job = brain.start({ player: 'Steve', text: 'build' });
  brain.enqueue('Alex', 'follow me');
  await toolStarted;
  brain.stop();
  await job;

  assert.equal(client.calls.length, 1);
  assert.equal(brain.queue.length, 0);
  assert.equal(said.at(-1), 'Stopped.');
  assert.equal(stops(), 1);
});

test('requests queue while busy, up to the limit', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const client = fakeClient([reply('tool_use', [toolUse('a', 'build_structure')]), reply('end_turn', []), reply('end_turn', [{ type: 'text', text: 'Okay.' }]), reply('end_turn', [])]);
  const config = { ...baseConfig, limits: { ...baseConfig.limits, queueSize: 1 } };
  const ran = [];
  const { brain, said } = makeBrain({
    client,
    config,
    runTool: async (name) => {
      ran.push(name);
      await gate;
      return { ok: true, message: 'done' };
    }
  });

  const job = brain.start({ player: 'Steve', text: 'build' });
  await new Promise((r) => setImmediate(r));
  brain.enqueue('Alex', 'follow me');
  brain.enqueue('Steve', 'one more');
  assert.match(said[0], /Alex, got it/);
  assert.match(said[1], /queue is full/);

  release();
  await job;
  while (brain.busy) await new Promise((r) => setImmediate(r));
  assert.equal(client.calls.length, 3);
  assert.match(client.calls[2].params.messages[0].content, /Request from Alex: follow me/);
});

test('build requests get more effort', async () => {
  const client = fakeClient([reply('end_turn', [])]);
  const { brain } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'build a small house here' });
  assert.deepEqual(client.calls[0].params.output_config, { effort: 'high' });
});

function busyBrain(responses) {
  let release;
  const gate = new Promise((r) => (release = r));
  const client = fakeClient(responses);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  const made = makeBrain({
    client,
    config,
    runTool: async () => {
      await gate;
      return { ok: true, message: 'done' };
    }
  });
  return { ...made, client, release };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a question while busy is answered right away', async () => {
  const { brain, said, release } = busyBrain([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('end_turn', [{ type: 'text', text: 'Mining stone, about half done.' }]),
    reply('end_turn', [])
  ]);
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'what are you doing?');
  while (said.length === 0) await tick();
  assert.deepEqual(said, ['Mining stone, about half done.']);
  assert.equal(brain.queue.length, 0);
  release();
  await job;
});

test('a new job while busy is queued for after the current one', async () => {
  const { brain, said, release, client } = busyBrain([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('end_turn', [{ type: 'text', text: 'QUEUE' }]),
    reply('end_turn', []),
    reply('end_turn', [])
  ]);
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'then chop a tree');
  while (said.length === 0) await tick();
  assert.match(said[0], /Alex, got it/);
  assert.equal(brain.queue.length, 1);
  release();
  await job;
  while (brain.busy) await tick();
  assert.match(client.calls[3].params.messages[0].content, /Request from Alex: then chop a tree/);
});

test('a change to the current job goes straight into it', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'UPDATE' }]),
    reply('end_turn', [{ type: 'text', text: 'Making it 12x12 instead.' }])
  ]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  let started;
  const toolStarted = new Promise((r) => (started = r));
  const longBuild = (name, input, signal) =>
    new Promise((resolve) => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, message: 'Stopped early: stopped' }));
    });
  const { brain, said } = makeBrain({ client, config, runTool: longBuild });

  const job = brain.start({ player: 'Steve', text: 'build a house' });
  await toolStarted;
  brain.enqueue('Alex', 'make it 12x12');
  await job;

  assert.deepEqual(said, ["Okay Alex, I'll work that in.", 'Making it 12x12 instead.']);
  const last = client.calls[2].params.messages.at(-1).content;
  assert.match(last[0].content, /Stopped because a player just changed the instructions/);
  assert.match(last[1].text, /Alex said: make it 12x12\nWork this into the job you're doing now\. If it's meant for later jobs too, save it with remember, in the note for that place or task\.$/);
  assert.equal(brain.queue.length, 0);
});

test('tools wait until the model has seen a change', async () => {
  let brain;
  const client = fakeClient((n) => {
    if (n === 1) {
      brain.addToJob(brain.current, 'Alex', 'door on the north side');
      return reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0, door: 'south' })]);
    }
    return reply('end_turn', [{ type: 'text', text: 'North it is.' }]);
  });
  const made = makeBrain({ client });
  brain = made.brain;
  await brain.start({ player: 'Steve', text: 'build a house' });

  assert.equal(made.toolCalls.length, 0);
  const last = client.calls[1].params.messages.at(-1).content;
  assert.match(last[0].content, /Not done/);
  assert.match(last[1].text, /Alex said: door on the north side/);
});

test('a change that comes in as the job finishes keeps it going', async () => {
  let brain;
  const client = fakeClient((n) => {
    if (n === 1) {
      brain.addToJob(brain.current, 'Alex', 'add a basement too');
      return reply('end_turn', [{ type: 'text', text: 'House done.' }]);
    }
    return reply('end_turn', [{ type: 'text', text: 'Basement added.' }]);
  });
  const made = makeBrain({ client });
  brain = made.brain;
  await brain.start({ player: 'Steve', text: 'build a house' });

  assert.deepEqual(made.said, ["Okay Alex, I'll work that in.", 'House done.', 'Basement added.']);
  assert.match(client.calls[1].params.messages.at(-1).content[0].text, /add a basement too/);
});

test('a change the job never got to becomes a request of its own', async () => {
  let brain;
  const client = fakeClient((n) => (n === 1 ? reply('tool_use', [toolUse('a', 'mine')]) : reply('end_turn', [])));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 1 } };
  const made = makeBrain({
    client,
    config,
    runTool: async () => {
      brain.addToJob(brain.current, 'Alex', 'then mine 10 more');
      return { ok: true, message: 'mined' };
    }
  });
  brain = made.brain;
  await brain.start({ player: 'Steve', text: 'mine stone' });
  while (brain.busy) await tick();
  assert.match(client.calls[1].params.messages[0].content, /Request from Alex: then mine 10 more/);
});

test('a job that turns into a build gets the build budget', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 2, buildMaxSteps: 4 } };
  const { brain } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'carry on' });
  assert.equal(client.calls.length, 4);
  assert.deepEqual(client.calls[0].params.output_config, { effort: 'medium' });
  assert.deepEqual(client.calls[1].params.output_config, { effort: 'high' });
});

test('a build job gets the bigger reply cap from when it becomes a build, other jobs the normal one, and never less than maxTokens', async () => {
  const capOf = async (text, config = baseConfig) => {
    const client = fakeClient([reply('end_turn', [])]);
    await makeBrain({ client, config }).brain.start({ player: 'Steve', text });
    return client.calls[0].params.max_tokens;
  };
  assert.equal(await capOf('build a house here'), 32000);
  assert.equal(await capOf('mine some stone'), 16000);
  const withCap = (buildMaxTokens) => ({ ...baseConfig, claude: { ...baseConfig.claude, buildMaxTokens } });
  assert.equal(await capOf('build a house here', withCap(40000)), 40000);
  assert.equal(await capOf('build a house here', withCap(8000)), 16000);

  const client = fakeClient([reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]), reply('end_turn', [])]);
  await makeBrain({ client }).brain.start({ player: 'Steve', text: 'carry on' });
  assert.deepEqual(client.calls.map((c) => c.params.max_tokens), [16000, 32000]);
});

test('with streaming off a build job keeps the normal reply cap', async () => {
  const client = fakeClient([reply('end_turn', [])]);
  await makeBrain({ client, config: { ...plain, claude: { ...plain.claude, buildMaxTokens: 32000 } } }).brain.start({ player: 'Steve', text: 'build a house here' });
  assert.equal(client.calls[0].streamed, undefined);
  assert.equal(client.calls[0].params.max_tokens, 16000);
  assert.deepEqual(client.calls[0].params.output_config, { effort: 'high' });
});

test('a build step cut off mid-plan is asked for again in sections, twice at most, and other jobs still end on it', async () => {
  for (const config of [plain, baseConfig]) {
    const half = toolUse('a', 'build_structure', { origin: { x: 0, y: 64, z: 0 }, parts: [] });
    const client = fakeClient([reply('max_tokens', [{ type: 'text', text: 'Building the bridge.' }, half]), reply('end_turn', [{ type: 'text', text: 'Built it.' }])]);
    const { brain, said, toolCalls } = makeBrain({ client, config });
    await brain.start({ player: 'Steve', text: 'build a bridge here' });
    assert.equal(client.calls.length, 2);
    assert.equal(toolCalls.length, 0);
    const second = JSON.stringify(client.calls[1].params.messages);
    assert.match(second, /the plan was too long for one reply, so none of it ran/);
    assert.match(second, /the shell first, then the roof, then the details and surroundings/);
    assert.ok(!second.includes('Building the bridge.'));
    assert.ok(!said.some((line) => /cut off/.test(line)));

    const always = fakeClient(() => reply('max_tokens', []));
    const cut = makeBrain({ client: always, config });
    await cut.brain.start({ player: 'Steve', text: 'build a bridge here' });
    assert.equal(always.calls.length, 3);
    assert.deepEqual(cut.said, ['My answer got cut off. Try asking for something smaller.']);
  }
});

test('time spent building does not count against the job', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'Built it.' }])
  ]);
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05, buildMaxSeconds: 0.05 } };
  const slowBuild = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, message: 'built' }), 150));
  const { brain, said } = makeBrain({ client, config, runTool: slowBuild });
  await brain.start({ player: 'Steve', text: 'build a hut' });
  assert.deepEqual(said, ['Built it.']);
});

test('the note next to tool calls goes to chat', async () => {
  for (const config of [plain, baseConfig]) {
    const client = fakeClient([
      reply('tool_use', [{ type: 'text', text: 'Taking down the old roof first.' }, toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]),
      reply('end_turn', [{ type: 'text', text: 'Done.' }])
    ]);
    const { brain, said } = makeBrain({ client, config });
    await brain.start({ player: 'Steve', text: 'build a house' });
    assert.deepEqual(said, ['Taking down the old roof first.', 'Done.']);
  }
});

test('a tool the watchdog stops comes back to the model with what happened', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Trying elsewhere.' }])]);
  const said = [];
  const brain = new Brain({
    client,
    config: baseConfig,
    runTool: (name, input, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: true, message: 'mined 3' }))),
    snapshot: () => 'SNAPSHOT',
    say: (t) => said.push(t),
    log: () => {},
    watchTool: (name, controller) => {
      setImmediate(() => controller.abort('stuck'));
      return { stop: () => {}, report: () => "I stopped this myself: nothing changed for 45 seconds. I'm at 1 2 3." };
    }
  });
  await brain.start({ player: 'Steve', text: 'mine stone' });
  const result = client.calls[1].params.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /mined 3 \(I stopped this myself: nothing changed for 45 seconds\. I'm at 1 2 3\./);
  assert.deepEqual(said, ['Trying elsewhere.']);
});

test('API errors are reported in chat and the bot keeps going', async () => {
  const authError = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
  const client = fakeClient([authError, reply('end_turn', [{ type: 'text', text: 'Back!' }])]);
  const { brain, said } = makeBrain({ client });

  await brain.start({ player: 'Steve', text: 'first' });
  assert.deepEqual(said, ["I couldn't reach my brain: the API key was rejected."]);

  await brain.start({ player: 'Steve', text: 'second' });
  assert.equal(said.at(-1), 'Back!');
});

test('rate limit and connection errors get their own messages', async () => {
  const rate = makeBrain({ client: fakeClient([new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())]) });
  await rate.brain.start({ player: 'Steve', text: 'x' });
  assert.match(rate.said[0], /rate limited/);

  const conn = makeBrain({ client: fakeClient([new Anthropic.APIConnectionError({ message: 'offline' })]) });
  await conn.brain.start({ player: 'Steve', text: 'x' });
  assert.match(conn.said[0], /connection problem/);
});

test('a final reply that only says what comes next sends her on to do it', async () => {
  const client = fakeClient([
    reply('end_turn', [{ type: 'text', text: 'I fixed the door. Next I am going over the west wall gaps.' }]),
    reply('tool_use', [toolUse('a', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('end_turn', [{ type: 'text', text: 'West wall done.' }])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'Clodine fix the walls' });
  assert.deepEqual(toolCalls.map((t) => t.name), ['build_structure']);
  assert.deepEqual(said, ['I fixed the door. Next I am going over the west wall gaps.', 'West wall done.']);
  assert.match(client.calls[1].params.messages.at(-1).content, /Carry on now/);
});

test('replies that finish or ask something end the job', async () => {
  const { announcesMore } = await import('../src/brain.js');
  assert.equal(announcesMore('The west wall gaps are next.'), true);
  assert.equal(announcesMore("Next I'll put shutters on, unless you'd rather I start the outhouse first."), true);
  assert.equal(announcesMore("I'll add the eaves now."), true);
  assert.equal(announcesMore('Done, the house has a porch now.'), false);
  assert.equal(announcesMore('Should I do the shutters next?'), false);
  assert.equal(announcesMore("I'm fine."), false);
});

test('lines that promise more work are caught, and harmless closers and waits on a player are not', async () => {
  const { announcesMore } = await import('../src/brain.js');
  // Seen live: the bot ended its job with these and stood idle.
  assert.equal(announcesMore('The chest has 58 dirt and 440 cobblestone, and I already carry 20 dirt, so I have enough scaffolding for the chimney cap. I\'ll go ahead and build it.'), true);
  assert.equal(announcesMore("The roof and walls are done. Next is the chimney cap, which needs a scaffold, so I'll use the 20 dirt I'm carrying and build it up from the attic."), true);
  // Waiting on a player is a real end; asking for what she already had is left to the prompt.
  assert.equal(announcesMore("The house is done, but I couldn't do the chimney cap: there's no way out onto the roof from the attic and I couldn't climb up the outside. If you drop me about 16 dirt or cobblestone, I'll build a scaffold and add it."), false);
  assert.equal(announcesMore("Let me grab the planks from the chest."), true);
  for (const closer of [
    "All done. I'll be here if you need me.",
    'Let me know if you want anything else.',
    'Want me to add a porch too?',
    "The iron is still cooking, I'll take it out later.",
    "Here are your logs. I'll stay put.",
    'Done, the house has a porch now.'
  ]) {
    assert.equal(announcesMore(closer), false, closer);
  }
});

test('a report that she is blocked and waiting for it to work again is let through, a real promise is not', async () => {
  const { announcesMore } = await import('../src/brain.js');
  // Seen live: both were sent on, costing a call each before she could say she was stuck.
  assert.equal(
    announcesMore(
      '50 Cent, I can\'t dig right now. Every break fails with the error "enchantments.concat is not a function". I worked out the pattern from the existing tunnels. They are 1 wide and 2 tall (y -59 and -58), with a 2-block wall between each, so a tunnel every 3 blocks in z. The next one is z -5417, running x2747 to x2777. I haven\'t dug any of it. I\'ll start it once digging works again.'
    ),
    false
  );
  assert.equal(
    announcesMore(
      'I couldn\'t get around it. Breaking blocks still fails with "enchantments.concat is not a function". I tried the diamond pickaxe, the axe, and an empty hand. It looks like a bug in the tool itself rather than something I can work around. The next tunnel is z -5417, x2747 to x2777, and I\'ll dig it as soon as breaking works.'
    ),
    false
  );
  for (const promise of [
    "Digging works again, so I'll start the next tunnel now.",
    "Once that's done, I'll build the roof.",
    "Once I've fixed the door, I'll go ahead and do the shutters.",
    "I'll go ahead and dig it."
  ]) {
    assert.equal(announcesMore(promise), true, promise);
  }
});

test('work that waits on the player saying the word or choosing is let through, a promise that mentions them is not', async () => {
  const { announcesMore } = await import('../src/brain.js');
  // Seen live: both were sent on for nothing.
  assert.equal(
    announcesMore("The z -5408 tunnel is finished from x 2776 to 2747, all at y -59, with no cutting across other tunnels. I'm standing at 2749. Say the word and I'll start the next tunnel at z -5411."),
    false
  );
  assert.equal(
    announcesMore(
      "Understood, jouleano6. I'll stop cutting across the tunnels. I've worn out one pickaxe, and the other has 814 uses left. Tell me which z line the next tunnel should run along, parallel to the first one at z -5414, and I'll dig it east to west and stay at y -59."
    ),
    false
  );
  assert.equal(announcesMore("Let me know when you're ready and I'll start the next one."), false);
  for (const promise of [
    "I'll tell you when it's done, and I'll start the roof now.",
    "Tell me if it looks off. I'll start the roof now.",
    "Tell me which side you like, and I'll start the roof now.",
    "Say the word when you need me. I'll go ahead and dig the next tunnel."
  ]) {
    assert.equal(announcesMore(promise), true, promise);
  }
});

test('a finish that promises more is held back and the job goes on, within the nudge limit', async () => {
  const lines = [];
  const promise = "I'll go ahead and build it.";
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'open_container', { x: 1, y: 64, z: 1 }), toolUse('b', 'finish', { message: promise })]),
    reply('tool_use', [toolUse('c', 'build_structure', { parts: [] }), toolUse('d', 'finish', { message: 'Chimney cap is on.' })])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'check the chest for dirt' });
  assert.deepEqual(toolCalls.map((t) => t.name), ['open_container', 'build_structure']);
  assert.deepEqual(said, ['Chimney cap is on.']);
  const held = client.calls[1].params.messages.at(-1).content[1];
  assert.equal(held.is_error, true);
  assert.match(held.content, /^Not done: you said you'd carry on, so do it now.*Your message wasn't sent\.$/);
  assert.doesNotMatch(held.content, /escalate/);
  assert.equal(lines[0].nudges, 1);
  assert.equal(lines[0].reply, 'Chimney cap is on.');
  assert.deepEqual(lines[0].steps[0].tools[1], { name: 'finish', ok: false, ms: 0, error: `held back: ${promise}` });

  const stubborn = fakeClient(() => reply('tool_use', [toolUse('a', 'finish', { message: promise })]));
  const again = makeBrain({ client: stubborn });
  await again.brain.start({ player: 'Steve', text: 'build the chimney' });
  assert.equal(stubborn.calls.length, 3);
  assert.deepEqual(again.said, [promise]);

  const free = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'finish', { message: promise })])]), config: routedIdle });
  await free.brain.start({ player: null, text: null, self: true });
  assert.deepEqual(free.said, [promise]);
});

test('a quick-model job that turns out to need real work can still be handed up after a step', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'open_container', { x: 1, y: 64, z: 1 }), toolUse('b', 'finish', { message: "Next is the chimney cap, so I'll use the dirt I carry." })]),
    reply('tool_use', [toolUse('c', 'escalate', { to: 'complex' })]),
    reply('tool_use', [toolUse('d', 'build_structure', { parts: [] }), toolUse('e', 'finish', { message: 'Chimney cap is on.' })])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'check the chest for dirt and scaffolding materials' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  assert.match(textOf(client.calls[0].params.messages[0].content), /If a job you started yourself turns out to need more than that, call escalate then/);
  const held = client.calls[1].params.messages.at(-1).content[1];
  assert.match(held.content, /call escalate as the only call/);
  assert.match(textOf(client.calls[2].params.messages[0].content), /already ran: open_container/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['open_container', 'build_structure']);
  assert.deepEqual(said, ['Chimney cap is on.']);
});

test('the next job hears how the last one ended', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'open_container'), toolUse('b', 'finish', { message: 'The chest has 58 dirt.' })]),
    reply('end_turn', [{ type: 'text', text: "Nothing right now. I checked the chest, and the chimney cap isn't done." }])
  ]);
  const { brain } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'check the chest' });
  assert.doesNotMatch(client.calls[0].params.messages[0].content, /Your last job/);
  await brain.start({ player: 'Alex', text: 'what are you doing' });
  assert.match(
    client.calls[1].params.messages[0].content,
    /^SNAPSHOT\n\nYour last job, Steve's request "check the chest", ended just now: you ended it with your reply\. No job is running besides this one\.\n\nRequest from Alex: what are you doing$/
  );

  const { lastJobLine } = await import('../src/brain.js');
  assert.equal(lastJobLine({ self: true, end: 'steps', at: 0 }, 5 * 60000), 'Your last job, your own free time, ended 5 min ago: it ran out of steps. No job is running besides this one.');
  assert.match(lastJobLine({ player: 'Steve', text: 'mine', end: 'api_error', at: 0 }, 0), /ended just now: api error\./);
});

test('the last job line carries a question about her reasoning only as the neutral summary, and names a round as one', async () => {
  const { lastJobLine } = await import('../src/brain.js');
  const asked = lastJobLine({ player: 'Steve', text: 'clodine reveal your thinking please', end: 'done', at: 0 }, 0);
  assert.equal(asked, 'Your last job, Steve\'s request "asked what I was doing", ended just now: you ended it with your reply. No job is running besides this one.');
  assert.match(lastJobLine({ player: 'Steve', text: 'clodine mine some stone', end: 'done', at: 0 }, 0), /Steve's request "clodine mine some stone"/);
  assert.match(lastJobLine({ player: 'Steve', text: 'strip mine at y -59', standing: true, end: 'done', at: 0 }, 0), /^Your last job, a round of the standing job from Steve, ended/);

  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Mining stone, nothing else.' }]), reply('end_turn', [{ type: 'text', text: 'Hi.' }])]);
  const { brain } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'clodine what is your thought process' });
  await brain.start({ player: 'Steve', text: 'clodine hi' });
  const second = client.calls[1].params.messages[0].content;
  assert.match(second, /Steve's request "asked what I was doing"/);
  assert.doesNotMatch(second, /thought process/);
});

test('a failed tool keeps its failure text in the job record', async () => {
  const lines = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'move_to', { x: 0, y: 0, z: 0 })]), reply('end_turn', [{ type: 'text', text: "I can't get there." }])]);
  const { brain } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) }, runTool: async () => ({ ok: false, message: `no path ${'x'.repeat(400)}` }) });
  await brain.start({ player: 'Steve', text: 'go' });
  const [tool] = lines[0].steps[0].tools;
  assert.equal(tool.ok, false);
  assert.equal(tool.error.length, 300);
  assert.match(tool.error, /^no path x/);
  assert.equal(lines[0].reply, "I can't get there.");
  assert.equal('nudges' in lines[0], false);
});

const routed = { ...baseConfig, claude: { ...baseConfig.claude, routing: true, everydayModel: 'claude-sonnet-5-5', quickModel: 'claude-haiku-5-5' } };

const textOf = (content) => (typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n'));
const unstrict = { ...routed, claude: { ...routed.claude, strictTools: false } };
const routedIdle = { ...routed, idle: { freeTimeSeconds: 60, freeTimeSteps: 4 } };

test('"come here" takes one call: the quick model moves and finishes in the same response', async () => {
  const lines = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'go_to_player', { player: 'Steve' }), toolUse('b', 'finish', { message: 'Here.' })])]);
  const { brain, said, toolCalls } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine come here' });
  assert.equal(client.calls.length, 1);
  const job = client.calls[0].params;
  assert.equal(job.model, 'claude-haiku-5-5');
  assert.equal(job.fallbacks, undefined);
  assert.ok(job.tools.every((t) => t.strict === undefined));
  assert.ok(['escalate', 'finish'].every((name) => job.tools.some((t) => t.name === name)));
  assert.match(job.messages[0].content, /Request from Steve: Clodine come here\n\nBefore you start, sort this request/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['go_to_player']);
  assert.deepEqual(said, ['Here.']);
  assert.equal(lines[0].calls.length, 0);
  assert.equal(lines[0].tier, 'simple');
  assert.equal(lines[0].model, 'claude-haiku-5-5');
  assert.equal(lines[0].end, 'done');
});

test('a three-action everyday job takes two calls: the hand-up, then the actions and finish together', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [{ type: 'text', text: 'Let me pass this on.' }, toolUse('a', 'escalate', { to: 'normal' })]),
    reply('tool_use', [
      toolUse('b', 'take_items', { items: [{ item: 'coal' }] }),
      toolUse('c', 'smelt', { item: 'raw_iron' }),
      toolUse('d', 'store_items', { items: [{ item: 'iron_ingot' }] }),
      toolUse('e', 'finish', { message: 'Iron smelted and stored.' })
    ])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine I need the raw iron smelted and put away' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  // Strict tools for the everyday model only, so it starts from the request again, without the sorting.
  const second = client.calls[1].params.messages;
  assert.equal(second.length, 1);
  assert.doesNotMatch(second[0].content, /sort this request/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['take_items', 'smelt', 'store_items']);
  assert.deepEqual(said, ['Iron smelted and stored.']);
  assert.equal(lines[0].tier, 'normal');
  assert.equal(lines[0].model, 'claude-sonnet-5-5');
  assert.deepEqual(lines[0].steps.map((s) => s.model), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(lines[0].steps[0].tools, [{ name: 'escalate', ok: true, ms: 0, to: 'normal' }]);
});

test('a job handed up carries on in the same conversation when the tools match, and is told not to hand it on', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'escalate', { to: 'complex' }), toolUse('b', 'mine')]),
    reply('tool_use', [toolUse('c', 'escalate', { to: 'complex' })]),
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, config: unstrict });
  await brain.start({ player: 'Steve', text: 'Clodine tidy up the storage room' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.deepEqual(client.calls[1].params.tools, client.calls[0].params.tools);
  assert.deepEqual(client.calls[1].params.system, client.calls[0].params.system);
  // The escalating turn is gone and nothing it asked for ran; the first message got the note on the end.
  const handed = client.calls[1].params.messages;
  assert.equal(handed.length, 1);
  assert.match(textOf(handed[0].content), /sort this request/);
  assert.match(handed[0].content.at(-1).text, /handed to you.*escalate is not for you/);
  assert.equal(toolCalls.length, 0);
  // Handing it on again is answered, and the job goes on.
  const answer = client.calls[2].params.messages.at(-1).content[0];
  assert.equal(answer.is_error, true);
  assert.match(answer.content, /^Not done: this job is yours to do/);
  assert.deepEqual(said, ['Done.']);
});

test('a model that is not sorting a job gets an answer to escalate, not a lost job', async () => {
  for (const [config, request, model] of [
    [baseConfig, { player: 'Steve', text: 'mine stone' }, 'claude-opus-5-5'],
    [routedIdle, { player: null, text: null, self: true }, 'claude-sonnet-5-5'],
    [routed, { player: 'Steve', text: 'mine stone', tier: 'complex' }, 'claude-opus-5-5']
  ]) {
    const client = fakeClient([reply('tool_use', [toolUse('a', 'escalate', { to: 'complex' }), toolUse('b', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
    const { brain, toolCalls } = makeBrain({ client, config });
    await brain.start(request);
    assert.deepEqual(client.calls.map((c) => c.params.model), [model, model]);
    assert.doesNotMatch(client.calls[0].params.messages[0].content, /sort this request/);
    const results = client.calls[1].params.messages.at(-1).content;
    assert.match(results[0].content, /^Not done: this job is yours/);
    assert.deepEqual(toolCalls.map((t) => t.name), ['mine']);
  }
});

test('the quick model gives a few words on why it hands a job up, and they go in the job log and the brain log', async () => {
  const lines = [];
  const logs = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'escalate', { to: 'normal', reason: ' needs mining and smelting ' })]),
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) }, log: (line) => logs.push(line) });
  await brain.start({ player: 'Steve', text: 'Clodine I need the raw iron smelted and put away' });
  assert.deepEqual(lines[0].steps[0].tools, [{ name: 'escalate', ok: true, ms: 0, to: 'normal', reason: 'needs mining and smelting' }]);
  assert.ok(logs.some((l) => /this is a normal job \(needs mining and smelting\)/.test(l)));
  const escalate = client.calls[0].params.tools.find((t) => t.name === 'escalate');
  assert.deepEqual(escalate.input_schema.required, ['to']);
  assert.equal(escalate.input_schema.properties.reason.type, 'string');
});

test("a player's job that says and does nothing in its first step goes back once, on the everyday model if it was on the quick one", async () => {
  const lines = [];
  const client = fakeClient([reply('end_turn', []), reply('end_turn', [{ type: 'text', text: 'There are 12 cows in the pen.' }])]);
  const { brain, said } = makeBrain({ client, config: unstrict, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine the cows in the pen' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  // The empty turn is gone, and the first turn says what went wrong.
  const second = client.calls[1].params.messages;
  assert.equal(second.length, 1);
  assert.match(textOf(second[0].content), /heard nothing/);
  assert.deepEqual(said, ['There are 12 cows in the pen.']);
  assert.equal(lines[0].end, 'done');

  // On a bigger model it goes back to the same one.
  const same = fakeClient([reply('end_turn', []), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  const other = makeBrain({ client: same });
  await other.brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(same.calls.map((c) => c.params.model), ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.equal(same.calls[1].params.messages.length, 1);
  assert.deepEqual(other.said, ['Mined.']);
});

test('a job that stays silent on its second try tells the player she did not understand and ends as not understood', async () => {
  for (const config of [baseConfig, routed]) {
    const lines = [];
    const client = fakeClient([reply('end_turn', []), reply('end_turn', [])]);
    const { brain, said } = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) } });
    await brain.start({ player: 'Steve', text: 'Clodine the thing by the place' });
    assert.equal(client.calls.length, 2);
    assert.deepEqual(said, ["Sorry, I didn't understand that. Could you say it another way?"]);
    assert.equal(lines[0].end, 'not_understood');
  }
});

test('a silent end after a tool call, in free time or after a reflex move ends as before', async () => {
  const afterTool = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [])]);
  const one = makeBrain({ client: afterTool });
  await one.brain.start({ player: 'Steve', text: 'mine stone' });
  assert.equal(afterTool.calls.length, 2);
  assert.deepEqual(one.said, []);

  const free = fakeClient([reply('end_turn', [])]);
  await makeBrain({ client: free, config: routedIdle }).brain.start({ player: null, text: null, self: true });
  assert.equal(free.calls.length, 1);

  const reflex = fakeClient([reply('end_turn', [])]);
  await makeBrain({ client: reflex, config: routed }).brain.start({ player: 'Steve', text: 'come here', reflex: 'come' });
  assert.equal(reflex.calls.length, 1);
});

test('with routing off everything runs on the main model, and free time on the everyday model with routing on', async () => {
  const off = fakeClient([reply('end_turn', [{ type: 'text', text: 'Coming.' }])]);
  await makeBrain({ client: off }).brain.start({ player: 'Steve', text: 'come here' });
  assert.equal(off.calls[0].params.model, 'claude-opus-5-5');
  assert.doesNotMatch(off.calls[0].params.messages[0].content, /sort this request/);
  assert.ok(off.calls[0].params.tools.some((t) => t.name === 'escalate'));

  const free = fakeClient([reply('end_turn', [{ type: 'text', text: 'nothing' }])]);
  const { brain, said } = makeBrain({ client: free, config: routedIdle });
  await brain.start({ player: null, text: null, self: true });
  assert.equal(free.calls[0].params.model, 'claude-sonnet-5-5');
  assert.deepEqual(said, []);
});

test('build requests skip the sorting and go straight to the main model', async () => {
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'On it.' }])]);
  const { brain } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].params.model, 'claude-opus-5-5');
  assert.equal(client.calls[0].params.fallbacks, 'default');
  assert.deepEqual(client.calls[0].params.output_config, { effort: 'high' });
  assert.doesNotMatch(client.calls[0].params.messages[0].content, /sort this request/);

  const visit = fakeClient([reply('end_turn', [{ type: 'text', text: 'On my way.' }])]);
  await makeBrain({ client: visit, config: routed }).brain.start({ player: 'Steve', text: 'Clodine go to your house' });
  assert.equal(visit.calls[0].params.model, 'claude-haiku-5-5');
  assert.deepEqual(visit.calls[0].params.output_config, { effort: 'medium' });
});

test('only requests that ask for something to be built count as builds', async () => {
  const { isBuildRequest } = await import('../src/brain.js');
  const builds = [
    'build a house here',
    'Clodine build me a small cabin by the lake',
    'can you build a tower?',
    'construct a bridge over the river',
    'make me a little hut',
    'make a wooden house next to mine',
    'put up a shelter for the night',
    'rebuild the tower bigger',
    'build a wall around the farm',
    'Clodine, could you build something nice here',
    'make the house bigger',
    'set up a small barn by the field'
  ];
  const others = [
    'go to your house',
    'come to my house',
    'meet me at the tower',
    'put the logs in the chest by the house',
    'is the bridge done?',
    'did you build the hut?',
    'what did you build today',
    'how is the build going',
    'sleep in the cabin tonight',
    'follow me to the shelter',
    'make torches for the house',
    'make a bed in the house',
    'take the iron from the chest in the tower',
    'chop the trees near the bridge',
    'craft some planks',
    'make a pickaxe'
  ];
  for (const text of builds) assert.equal(isBuildRequest(text), true, text);
  for (const text of others) assert.equal(isBuildRequest(text), false, text);
});

test('an everyday job that turns into a build carries on in the same conversation on the main model', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('z', 'escalate', { to: 'normal' })]),
    reply('tool_use', [toolUse('a', 'inspect_blocks', { x: 0, y: 0, z: 0 })]),
    reply('tool_use', [{ type: 'text', text: 'Patching it now.' }, toolUse('b', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('tool_use', [toolUse('c', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('end_turn', [{ type: 'text', text: 'Fixed.' }])
  ]);
  const { brain, toolCalls, said } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine the west wall looks wrong' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  // The everyday model's build call never ran or got said; the main model saw everything before it.
  assert.deepEqual(toolCalls.map((t) => t.name), ['inspect_blocks', 'build_structure']);
  assert.deepEqual(said, ['Fixed.']);
  assert.deepEqual(client.calls[3].params.messages, client.calls[2].params.messages);
  assert.deepEqual(client.calls[3].params.tools, client.calls[2].params.tools);
  assert.deepEqual(client.calls[3].params.system, client.calls[2].params.system);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tier, 'complex');
  assert.equal(lines[0].model, 'claude-opus-5-5');
});

test('a quick job that turns into a build starts over when the main model gets different tools', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('tool_use', [toolUse('b', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('end_turn', [{ type: 'text', text: 'Fixed.' }])
  ]);
  const { brain, toolCalls } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine the west wall looks wrong' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  // Strict tools for the main model only, so it starts from the request again.
  assert.equal(toolCalls.length, 1);
  assert.equal(client.calls[1].params.messages.length, 1);
  assert.doesNotMatch(client.calls[1].params.messages[0].content, /sort this request/);
});

test('with strict tools off, a quick job that turns into a build carries on too', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('tool_use', [toolUse('b', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain, toolCalls } = makeBrain({ client, config: unstrict });
  await brain.start({ player: 'Steve', text: 'Clodine I need stone, then sort it out' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  assert.deepEqual(toolCalls.map((t) => t.name), ['mine']);
  const handed = client.calls[2].params.messages;
  assert.equal(handed.length, 3);
  assert.equal(handed[2].content[0].type, 'tool_result');
  assert.match(handed[2].content.at(-1).text, /escalate is not for you/);
});

test('mid-job replies send the system prompt with the same 1 hour cache marker', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('end_turn', [{ type: 'text', text: 'Mining.' }]),
    reply('end_turn', [])
  ]);
  const config = { ...routed, claude: { ...routed.claude, busyReplies: true } };
  let release;
  const gate = new Promise((r) => (release = r));
  const { brain, said } = makeBrain({ client, config, runTool: async () => (await gate, { ok: true, message: 'done' }) });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  while (client.calls.length < 1) await tick();
  await tick();
  brain.enqueue('Alex', 'what are you doing?');
  while (said.length === 0) await tick();
  release();
  await job;
  const [step, busy] = client.calls.map((c) => c.params);
  assert.deepEqual(busy.system, step.system);
  assert.equal(busy.cache_control, undefined);
});

function fullQueueBrain(responses) {
  const made = busyBrain(responses);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true }, limits: { ...baseConfig.limits, queueSize: 1 } };
  made.brain.config = config;
  made.brain.queue.push({ player: 'Steve', text: 'already waiting' });
  return made;
}

test('a full queue still answers questions', async () => {
  const { brain, said, release } = fullQueueBrain([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mining, nearly done.' }])]);
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'how is it going?');
  while (said.length === 0) await tick();
  assert.deepEqual(said, ['Mining, nearly done.']);
  brain.queue = [];
  release();
  await job;
});

test('a full queue still takes a stop in words', async () => {
  const { brain, said, release } = fullQueueBrain([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'STOP' }])]);
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'please drop that');
  while (said.length === 0) await tick();
  assert.deepEqual(said, ['Stopped.']);
  assert.equal(brain.queue.length, 0);
  release();
  await job;
});

test('a full queue turns away only a new job', async () => {
  const { brain, said, release } = fullQueueBrain([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'QUEUE' }])]);
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'then chop a tree');
  while (said.length === 0) await tick();
  assert.match(said[0], /Alex, I'm busy and my queue is full/);
  assert.equal(brain.queue.length, 1);
  brain.queue = [];
  release();
  await job;
});

function usage(input, cacheRead, cacheWrite, output) {
  return { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output };
}

test('each job writes one log line with its calls, tools, tokens and cost', async () => {
  const lines = [];
  const client = fakeClient([
    { ...reply('tool_use', [toolUse('z', 'escalate', { to: 'normal' })]), usage: usage(100, 0, 0, 2) },
    { ...reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft')]), usage: { ...usage(50, 0, 8000, 40), cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 7000 } } },
    { ...reply('end_turn', [{ type: 'text', text: 'Done.' }]), usage: usage(20, 9000, 100, 10) }
  ]);
  const { brain } = makeBrain({
    client,
    config: routed,
    jobLog: { write: (line) => lines.push(line) },
    runTool: async (name) => ({ ok: name === 'mine', message: name })
  });
  await brain.start({ player: 'Steve', text: 'Clodine I need some stone' });

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.player, 'Steve');
  assert.equal(line.request, 'Clodine I need some stone');
  assert.equal(line.freeTime, false);
  assert.equal(line.holds, 0);
  assert.equal(line.heldMs, 0);
  assert.equal(line.tier, 'normal');
  assert.equal(line.model, 'claude-sonnet-5-5');
  assert.equal(line.effort, 'medium');
  assert.equal(line.end, 'done');
  assert.ok(!Number.isNaN(Date.parse(line.start)));
  // The sorting is the quick model's own first step now, not a side call.
  assert.equal(line.calls.length, 0);
  assert.equal(line.steps.length, 3);
  assert.equal(line.steps[0].model, 'claude-haiku-5-5');
  assert.deepEqual(line.steps[0].tools, [{ name: 'escalate', ok: true, ms: 0, to: 'normal' }]);
  assert.deepEqual(line.steps[1].tools.map((t) => [t.name, t.ok]), [['mine', true], ['craft', false]]);
  assert.ok(line.steps[1].tools.every((t) => typeof t.ms === 'number'));
  assert.deepEqual(line.steps[1].tokens, { input: 50, cacheRead: 0, cacheWrite: 8000, output: 40, cacheWrite5m: 1000, cacheWrite1h: 7000 });
  assert.deepEqual(line.totals.tokens, { input: 170, cacheRead: 9000, cacheWrite: 8100, output: 52, cacheWrite5m: 1000, cacheWrite1h: 7000 });
  assert.equal(line.totals.steps, 3);
  const expected = line.steps[0].cost + line.steps[1].cost + line.steps[2].cost;
  assert.ok(Math.abs(line.totals.cost - expected) < 1e-6);
  assert.ok(line.totals.cost > 0);
});

test('the job log records how each job ended', async () => {
  const endOf = async (client, config = baseConfig, runTool) => {
    const lines = [];
    const { brain } = makeBrain({ client, config, runTool, jobLog: { write: (line) => lines.push(line) } });
    await brain.start({ player: 'Steve', text: 'x' });
    return lines[0];
  };
  assert.equal((await endOf(fakeClient(() => reply('refusal', [])))).end, 'refusal');
  assert.equal((await endOf(fakeClient([reply('max_tokens', [])]))).end, 'max_tokens');
  const failed = await endOf(fakeClient([new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())]));
  assert.equal(failed.end, 'api_error');
  assert.equal(failed.steps.length, 0);
  const steps = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 2 } };
  assert.equal((await endOf(fakeClient(() => reply('tool_use', [toolUse('a', 'mine')])), steps)).end, 'steps');
  const time = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05 } };
  assert.equal((await endOf(slowClient(200, () => reply('end_turn', [])), time)).end, 'time');
});

test('a stopped job is logged as stopped', async () => {
  const lines = [];
  let started;
  const toolStarted = new Promise((r) => (started = r));
  const { brain } = makeBrain({
    client: fakeClient(() => reply('tool_use', [toolUse('a', 'mine')])),
    jobLog: { write: (line) => lines.push(line) },
    runTool: (name, input, signal) =>
      new Promise((resolve) => {
        started();
        signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }));
      })
  });
  const job = brain.start({ player: 'Steve', text: 'mine' });
  await toolStarted;
  brain.stop();
  await job;
  assert.equal(lines[0].end, 'stop');
});

test('a mid-job reply is counted in the job it came in during', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine')]),
    { ...reply('end_turn', [{ type: 'text', text: 'Mining.' }]), usage: usage(300, 0, 0, 7) },
    reply('end_turn', [])
  ]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  let release;
  const gate = new Promise((r) => (release = r));
  const { brain, said } = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) }, runTool: async () => (await gate, { ok: true, message: 'done' }) });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  brain.enqueue('Alex', 'what are you doing?');
  while (said.length === 0) await tick();
  release();
  await job;
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].calls.map((c) => [c.kind, c.tokens.input]), [['busy', 300]]);
});

// Four steps of 300K input tokens on the main model, $1.20 each, then the reply.
function priceyClient() {
  return fakeClient([
    ...['a', 'b', 'c', 'd'].map((id) => ({ ...reply('tool_use', [toolUse(id, 'mine')]), usage: usage(300000, 0, 0, 0) })),
    reply('end_turn', [{ type: 'text', text: 'Done mining.' }])
  ]);
}

async function priceyJob(warnCostUsd, request = { player: 'Steve', text: 'mine stone', whisper: true }) {
  const lines = [];
  const logged = [];
  const client = priceyClient();
  const config = { ...baseConfig, limits: { ...baseConfig.limits, warnCostUsd }, idle: { freeTimeSeconds: 60, freeTimeSteps: 8 } };
  const made = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) }, log: (text) => logged.push(text) });
  await made.brain.start(request);
  return { ...made, client, line: lines[0], logged };
}

const costLines = (heard) => heard.filter((h) => /has cost/.test(h.text));

test('an expensive job is pointed out once at the threshold and again each time the cost doubles', async () => {
  const { heard, logged, line } = await priceyJob(2);
  assert.deepEqual(costLines(heard), [
    { text: 'This job has cost about $2.40 so far. Say stop if you want me to end it.', to: 'Steve' },
    { text: 'This job has cost about $4.80 so far. Say stop if you want me to end it.', to: 'Steve' }
  ]);
  assert.deepEqual(logged.filter((l) => /^\[brain\] this job has cost/.test(l)), ['[brain] this job has cost $2.40 so far', '[brain] this job has cost $4.80 so far']);
  assert.equal(line.costWarnings, 2);
  assert.match(logged.find((l) => l.startsWith('[job]')), /, cost warnings 2$/);
});

test('a cost warning never ends or changes the job, and the model never hears about it', async () => {
  const warned = await priceyJob(2);
  const quiet = await priceyJob(0);
  assert.equal(costLines(quiet.heard).length, 0);
  assert.equal(quiet.logged.some((l) => /has cost/.test(l)), false);
  assert.equal(quiet.line.costWarnings, 0);
  assert.equal(warned.line.end, 'done');
  assert.equal(warned.line.steps.length, 5);
  assert.deepEqual(warned.toolCalls, quiet.toolCalls);
  assert.deepEqual(warned.client.calls.map((c) => c.params), quiet.client.calls.map((c) => c.params));
  assert.ok(warned.client.calls.every((c) => !JSON.stringify(c.params.messages).includes('has cost')));
  assert.deepEqual(warned.heard.filter((h) => !/has cost/.test(h.text)), quiet.heard);
});

test('free time gets the cost warning in the console only', async () => {
  const { heard, logged, line } = await priceyJob(2, { player: null, text: null, self: true });
  assert.equal(costLines(heard).length, 0);
  assert.equal(logged.filter((l) => /^\[brain\] this job has cost/.test(l)).length, 2);
  assert.equal(line.costWarnings, 2);
});

test('a job on a model with no known price gets no cost warning', async () => {
  const client = fakeClient([
    { ...reply('tool_use', [toolUse('a', 'mine')]), model: 'some-other-model', usage: usage(5000000, 0, 0, 0) },
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const lines = [];
  const { brain, heard } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(heard, [{ text: 'Done.', to: null }]);
  assert.equal(lines[0].totals.cost, null);
  assert.equal(lines[0].costWarnings, 0);
});

test('a cost warning that comes during a hold is said once the hold is over', async () => {
  let answer;
  const thinking = new Promise((r) => (answer = r));
  const client = fakeClient((n) =>
    n === 1 ? thinking.then(() => ({ ...reply('tool_use', [toolUse('a', 'mine')]), usage: usage(600000, 0, 0, 0) })) : reply('end_turn', [{ type: 'text', text: 'Done.' }])
  );
  const { brain, heard } = makeBrain({ client });
  const job = brain.start({ player: 'Steve', text: 'mine stone', whisper: true });
  await tick();
  await brain.pause('offline');
  answer();
  await sleep(20);
  assert.deepEqual(heard, []);
  brain.resume('offline');
  await job;
  assert.deepEqual(heard, [
    { text: 'This job has cost about $2.40 so far. Say stop if you want me to end it.', to: 'Steve' },
    { text: 'Done.', to: 'Steve' }
  ]);
});

test('a mid-job reply counts toward the cost warning of the job it came in during', async () => {
  const client = fakeClient([
    { ...reply('tool_use', [toolUse('a', 'mine')]), usage: usage(450000, 0, 0, 0) },
    { ...reply('end_turn', [{ type: 'text', text: 'Mining.' }]), usage: usage(100000, 0, 0, 0) },
    reply('end_turn', [])
  ]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  let release;
  const gate = new Promise((r) => (release = r));
  const lines = [];
  const { brain, heard } = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) }, runTool: async () => (await gate, { ok: true, message: 'done' }) });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  assert.equal(costLines(heard).length, 0);
  brain.enqueue('Alex', 'what are you doing?');
  while (heard.length < 2) await tick();
  release();
  await job;
  assert.deepEqual(costLines(heard), [{ text: 'This job has cost about $2.20 so far. Say stop if you want me to end it.', to: null }]);
  assert.equal(lines[0].costWarnings, 1);
});

test('a job log that fails to write never breaks the job', async () => {
  const logged = [];
  const brain = new Brain({
    client: fakeClient([reply('end_turn', [{ type: 'text', text: 'Hi!' }])]),
    config: baseConfig,
    runTool: async () => ({ ok: true, message: '' }),
    snapshot: () => 'SNAPSHOT',
    say: () => {},
    log: (text) => logged.push(text),
    jobLog: {
      write: () => {
        throw new Error('disk full');
      }
    }
  });
  await brain.start({ player: 'Steve', text: 'hi' });
  assert.ok(logged.some((l) => /^\[job\] done: 1 steps/.test(l)));
  assert.ok(logged.some((l) => /disk full/.test(l)));
});

// The first tool call runs until it's stopped, later ones finish at once.
function holdingTool() {
  const ran = [];
  let started;
  const ready = new Promise((r) => (started = r));
  const run = (name, input, signal) => {
    ran.push(name);
    if (ran.length > 1) return Promise.resolve({ ok: true, message: `${name} done` });
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, message: 'mined 3' })));
  };
  return { ran, ready, run };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a hazard hold stops the tool with its own note, marks it interrupted and keeps the rest of the batch from running', async () => {
  const lines = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft')]), reply('end_turn', [{ type: 'text', text: 'Back to mining.' }])]);
  const tool = holdingTool();
  const { brain } = makeBrain({ client, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('hazard');
  brain.resume('hazard', 'You got out of the lava.');
  await job;
  const results = client.calls[1].params.messages[2].content;
  assert.equal(results[0].content, 'mined 3 (Stopped because you had to get out of water, lava or fire, see below.)');
  assert.equal(results[1].content, 'Not done, because you had to get out of water, lava or fire (see below).');
  assert.deepEqual(tool.ran, ['mine']);
  assert.equal(lines[0].steps[0].tools[0].interrupted, true);
});

test('a job held for safety keeps its conversation and hears what happened', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft')]),
    reply('end_turn', [{ type: 'text', text: 'Back to mining.' }]),
    reply('end_turn', [{ type: 'text', text: 'Hi Alex.' }])
  ]);
  const tool = holdingTool();
  const { brain, said } = makeBrain({ client, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('danger');
  assert.equal(brain.busy, true);
  brain.enqueue('Alex', 'hi');
  assert.deepEqual(said, ["Alex, got it. I'll do that after my current job."]);
  await sleep(30);
  assert.equal(client.calls.length, 1);
  brain.resume('danger', 'Your health got down to 6/20.');
  await job;

  const messages = client.calls[1].params.messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[2].content[0].content, 'mined 3 (Stopped because you had to look after yourself, see below.)');
  assert.match(messages[2].content[1].content, /^Not done, because you had to look after yourself/);
  assert.equal(messages[2].content[1].is_error, true);
  assert.deepEqual(messages[3], { role: 'system', content: 'Your health got down to 6/20. Carry on with the job from here.' });
  assert.deepEqual(tool.ran, ['mine']);
  while (brain.busy) await tick();
  assert.deepEqual(said.slice(1), ['Back to mining.', 'Hi Alex.']);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].end, 'done');
  assert.equal(lines[0].holds, 1);
  assert.ok(lines[0].heldMs >= 25);
  assert.equal(lines[0].steps.length, 2);
});

test('an answer asked for before a hold began runs none of its tools, and the model decides again', async () => {
  let answer;
  const thinking = new Promise((r) => (answer = r));
  const client = fakeClient((n) =>
    n === 1
      ? thinking.then(() => reply('tool_use', [{ type: 'text', text: 'Mining over there.' }, toolUse('a', 'mine'), toolUse('b', 'finish', { message: 'Mined.' })]))
      : reply('end_turn', [{ type: 'text', text: 'Done.' }])
  );
  const { brain, toolCalls, said } = makeBrain({ client });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  await brain.pause('danger');
  answer();
  await sleep(20);
  brain.resume('danger', 'You backed off from zombie.');
  await job;
  assert.equal(toolCalls.length, 0);
  assert.deepEqual(said, ['Done.']);
  const messages = client.calls[1].params.messages;
  assert.deepEqual(messages[2].content.map((r) => [r.content, r.is_error]), Array(2).fill(['Not done, because you had to look after yourself (see below).', true]));
  assert.deepEqual(messages.at(-1), { role: 'system', content: 'You backed off from zombie. Carry on with the job from here.' });
});

test('a final reply that comes back during a hold is said once the hold is over, unless the job is stopped', async () => {
  const held = async (stop) => {
    let answer;
    const thinking = new Promise((r) => (answer = r));
    const client = fakeClient(() => thinking.then(() => reply('end_turn', [{ type: 'text', text: 'Here.' }])));
    const made = makeBrain({ client });
    const job = made.brain.start({ player: 'Steve', text: 'come here', whisper: true });
    await tick();
    await made.brain.pause('offline');
    answer();
    await sleep(20);
    assert.deepEqual(made.said, []);
    assert.equal(made.brain.busy, true);
    if (stop) made.brain.stop();
    else made.brain.resume('offline');
    await job;
    return made.heard;
  };
  assert.deepEqual(await held(false), [{ text: 'Here.', to: 'Steve' }]);
  assert.deepEqual(await held(true), [{ text: 'Stopped.', to: null }]);
});

test('an error line during a hold waits for the hold to end', async () => {
  let fail;
  const thinking = new Promise((r) => (fail = r));
  const client = fakeClient(() => thinking.then(() => Promise.reject(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers()))));
  const { brain, said } = makeBrain({ client });
  const job = brain.start({ player: 'Steve', text: 'x' });
  await tick();
  await brain.pause('offline');
  fail();
  await sleep(20);
  assert.deepEqual(said, []);
  brain.resume('offline');
  await job;
  assert.match(said[0], /rate limited/);
});

test('a held player job still takes changes and questions, with the queue limit', async () => {
  const tool = holdingTool();
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'UPDATE' }]),
    reply('end_turn', [{ type: 'text', text: 'Making it 12x12.' }])
  ]);
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  const { brain, said } = makeBrain({ client, config, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'build a house' });
  await tool.ready;
  await brain.pause('danger');
  brain.enqueue('Steve', 'make it 12x12');
  while (said.length === 0) await tick();
  assert.deepEqual(said, ["Okay Steve, I'll work that in."]);
  assert.equal(brain.queue.length, 0);
  brain.resume('danger', 'You ate bread.');
  await job;
  assert.deepEqual(said.at(-1), 'Making it 12x12.');
  assert.ok(client.calls[2].params.messages.some((m) => textOf(typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text')).includes('Steve said: make it 12x12')));

  const full = holdingTool();
  const queued = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [])]), config: { ...baseConfig, limits: { ...baseConfig.limits, queueSize: 1 } }, runTool: full.run });
  const second = queued.brain.start({ player: 'Steve', text: 'mine stone' });
  await full.ready;
  await queued.brain.pause('danger');
  queued.brain.enqueue('Alex', 'chop a tree');
  queued.brain.enqueue('Alex', 'and another');
  assert.deepEqual(queued.said, ["Alex, got it. I'll do that after my current job.", "Alex, I'm busy and my queue is full. Try again in a bit."]);
  queued.brain.queue = [];
  queued.brain.stop();
  await second;
});

test('stop and a replacing job still work while a job is held', async () => {
  const lines = [];
  const tool = holdingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Hi.' }])]);
  const { brain, said } = makeBrain({ client, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('danger');
  brain.stop();
  await job;
  assert.equal(brain.busy, false);
  assert.equal(said.at(-1), 'Stopped.');
  assert.equal(lines[0].end, 'stop');
  assert.equal(lines[0].holds, 1);

  const second = holdingTool();
  const replaced = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Hi Alex.' }])]), runTool: second.run });
  const held = replaced.brain.start({ player: 'Steve', text: 'mine stone' });
  await second.ready;
  await replaced.brain.pause('danger');
  replaced.brain.queue.unshift({ player: 'Alex', text: 'say hi' });
  replaced.brain.abortCurrent('replaced');
  await held;
  assert.equal(replaced.brain.busy, false);
  replaced.brain.resume('danger');
  await replaced.brain.current.done;
  assert.deepEqual(replaced.said, ['Hi Alex.']);
});

test('time spent held does not count against the job', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Done.' }])]);
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05 } };
  const tool = holdingTool();
  const { brain, said } = makeBrain({ client, config, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('danger');
  await sleep(120);
  brain.resume('danger');
  await job;
  assert.deepEqual(said, ['Done.']);
});

test('a job carries on only once every hold is over', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Done.' }])]);
  const tool = holdingTool();
  const { brain } = makeBrain({ client, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('danger');
  await brain.pause('offline');
  brain.resume('danger', 'Health is now 14/20.');
  await sleep(20);
  assert.equal(client.calls.length, 1);
  brain.resume('offline', 'The connection to the server dropped for 9 seconds and you have joined again, at 1 64 2.');
  await job;
  assert.equal(
    client.calls[1].params.messages.at(-1).content,
    'Health is now 14/20. The connection to the server dropped for 9 seconds and you have joined again, at 1 64 2. Carry on with the job from here.'
  );
});

test('nothing starts while the bot is offline', async () => {
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Hi Steve.' }]), reply('end_turn', [{ type: 'text', text: 'Hi Alex.' }])]);
  const { brain, said } = makeBrain({ client });
  await brain.pause('offline');
  brain.enqueue('Steve', 'hi');
  brain.start({ player: 'Alex', text: 'hi' });
  assert.equal(brain.busy, false);
  assert.equal(brain.freeTime(), false);
  assert.deepEqual(brain.queue.map((r) => r.player), ['Steve', 'Alex']);
  assert.equal(client.calls.length, 0);
  brain.resume('offline');
  await brain.current.done;
  await brain.current?.done;
  assert.deepEqual(said.slice(1), ['Hi Steve.', 'Hi Alex.']);
});

test('the model hears once, with three steps left, that the job is running out of steps', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'mine')]));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 5 } };
  const { brain, said } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'mine a lot' });
  assert.equal(client.calls.length, 5);
  const notices = (n) => client.calls[n].params.messages.filter((m) => m.role === 'system');
  assert.deepEqual([0, 1].map((n) => notices(n).length), [0, 0]);
  assert.deepEqual(client.calls[2].params.messages.at(-1), {
    role: 'system',
    content: 'This job has 3 steps left, this one included. Use them to finish up, or to tell the player what is still left to do.'
  });
  const last = client.calls[4].params.messages;
  assert.equal(notices(4).length, 1);
  assert.equal(last[5].role, 'system');
  assert.equal(last[6].role, 'assistant');
  assert.deepEqual(said, ['I ran out of steps on that one.']);
});

test('a model without mid-conversation system messages gets the step notice as text', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'mine')]));
  const config = { ...baseConfig, claude: { ...baseConfig.claude, model: 'claude-sonnet-5' }, limits: { ...baseConfig.limits, maxSteps: 4 } };
  const { brain } = makeBrain({ client, config });
  await brain.start({ player: 'Steve', text: 'mine a lot' });
  const turn = client.calls[1].params.messages.at(-1);
  assert.equal(turn.role, 'user');
  assert.equal(turn.content[0].type, 'tool_result');
  assert.match(turn.content.at(-1).text, /^This job has 3 steps left/);
  assert.ok(client.calls.every((c) => c.params.messages.every((m) => m.role !== 'system')));
});

test('replies to a whispered request go back as whispers', async () => {
  const client = fakeClient([
    reply('tool_use', [{ type: 'text', text: 'Heading over.' }, toolUse('a', 'go_to_player', { player: 'Steve' })]),
    reply('end_turn', [{ type: 'text', text: 'Here.' }])
  ]);
  const { brain, heard } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'come here', whisper: true });
  assert.deepEqual(heard, [{ text: 'Heading over.', to: 'Steve' }, { text: 'Here.', to: 'Steve' }]);
  assert.match(client.calls[0].params.messages[0].content, /Request from Steve \(whispered\): come here/);

  const failed = makeBrain({ client: fakeClient([new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())]) });
  await failed.brain.start({ player: 'Steve', text: 'x', whisper: true });
  assert.equal(failed.heard[0].to, 'Steve');
  assert.match(failed.heard[0].text, /rate limited/);
});

test('acknowledgements to a whisper go back as whispers', async () => {
  const tool = holdingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [])]);
  const { brain, heard } = makeBrain({ client, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  brain.enqueue('Alex', 'then chop a tree', true);
  brain.addToJob(brain.current, 'Alex', 'and some birch', true);
  assert.deepEqual(heard, [
    { text: "Alex, got it. I'll do that after my current job.", to: 'Alex' },
    { text: "Okay Alex, I'll work that in.", to: 'Alex' }
  ]);
  brain.stop('Alex');
  await job;
  assert.deepEqual(heard.at(-1), { text: 'Stopped.', to: 'Alex' });
});

// A 400 the way the API sends it, with the reason in the body.
const badRequest = (message) => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers());

test('a system notice the API turns down goes in as text, once, and stays text from then on', async () => {
  const logged = [];
  // Whatever the wording, a retry with the notice as text that works shows the notice was the problem.
  const turnedDown = badRequest('invalid request');
  const client = fakeClient((n) => (n === 2 ? turnedDown : reply('tool_use', [toolUse('a', 'mine')])));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 4 } };
  const brain = new Brain({
    client,
    config,
    runTool: async () => ({ ok: true, message: 'mined' }),
    snapshot: () => 'SNAPSHOT',
    say: () => {},
    log: (text) => logged.push(text)
  });
  const job = brain.start({ player: 'Steve', text: 'mine a lot' });
  await job;
  assert.equal(client.calls[1].params.messages.at(-1).role, 'system');
  const retry = client.calls[2].params.messages;
  assert.equal(retry.at(-1).role, 'user');
  assert.match(retry.at(-1).content.at(-1).text, /^This job has 3 steps left/);
  assert.equal(client.calls.length, 5);
  assert.ok(client.calls.slice(2).every((c) => c.params.messages.every((m) => m.role !== 'system')));
  assert.equal(brain.systemMessages, false);
  assert.ok(logged.some((l) => /turned down a mid-conversation system message/.test(l)));

  // Later notices, like a hold report, go in as text.
  const messages = [{ role: 'user', content: 'x' }];
  brain.addNotices(messages, ['Health is now 14/20.'], 'claude-opus-5-5');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.at(-1).text, 'Health is now 14/20.');
});

test('a bad request without a new system notice ends the job as before', async () => {
  const lines = [];
  const turnedDown = new Anthropic.BadRequestError(400, { type: 'error' }, 'messages: bad', new Headers());
  const client = fakeClient([turnedDown]);
  const { brain, said } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'x' });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(said, ['Something went wrong talking to my brain.']);
  assert.equal(lines[0].end, 'api_error');
  assert.equal(brain.systemMessages, true);
});

test('a bad request that comes back again with the notice as text keeps system messages on', async () => {
  const lines = [];
  const client = fakeClient((n) => (n >= 2 ? badRequest('messages.1.content.0: tool_use ids must be unique') : reply('tool_use', [toolUse('a', 'mine')])));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSteps: 4 } };
  const { brain, said } = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'mine a lot' });
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[1].params.messages.at(-1).role, 'system');
  const retry = client.calls[2].params.messages;
  assert.ok(retry.every((m) => m.role !== 'system'));
  assert.match(retry.at(-1).content.at(-1).text, /^This job has 3 steps left/);
  assert.deepEqual(said, ['Something went wrong talking to my brain.']);
  assert.equal(lines[0].end, 'api_error');
  assert.match(lines[0].error, /tool_use ids must be unique/);
  assert.equal(brain.systemMessages, true);
});

test('a job that starts over on a bigger model keeps the changes, hold reports and actions it already had', async () => {
  let brain;
  let steps = 0;
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'go_to_player', { player: 'Steve' })]),
    reply('tool_use', [toolUse('b', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('tool_use', [toolUse('c', 'build_house', { x: 0, y: 64, z: 0 }), toolUse('d', 'finish', { message: 'Hut is up.' })])
  ]);
  const ran = [];
  brain = new Brain({
    client,
    config: routed,
    runTool: async (name) => (ran.push(name), { ok: true, message: `${name} done` }),
    snapshot: () => 'SNAPSHOT',
    say: () => {},
    log: () => {},
    beforeStep: async () => {
      if (++steps !== 2) return;
      await brain.pause('danger');
      brain.addToJob(brain.current, 'Steve', 'and put up a hut next to me');
      brain.resume('danger', 'You ate bread.');
    }
  });
  await brain.start({ player: 'Steve', text: 'Clodine come here' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  const restarted = client.calls[2].params.messages;
  assert.equal(restarted.length, 1);
  const first = restarted[0].content;
  assert.match(first, /Request from Steve: Clodine come here/);
  assert.match(first, /Steve said: and put up a hut next to me/);
  assert.match(first, /You ate bread\./);
  assert.match(first, /already ran: go_to_player \{"player":"Steve"\}\. Don't repeat/);
  assert.equal(first.match(/put up a hut/g).length, 1);
  assert.deepEqual(ran, ['go_to_player', 'build_house']);
});

test('settle waits for the current job to write its log line, but not forever', async () => {
  const lines = [];
  const tool = holdingTool();
  const { brain } = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'mine')])]), runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  brain.start({ player: 'Steve', text: 'mine' });
  await tool.ready;
  brain.abortCurrent('shutdown');
  await brain.settle(1000);
  assert.deepEqual(lines.map((l) => l.end), ['shutdown']);

  // A tool that doesn't listen to the stop.
  let release;
  const stuck = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'mine')])]), runTool: () => new Promise((r) => (release = () => r({ ok: false, message: 'x' }))) });
  const job = stuck.brain.start({ player: 'Steve', text: 'mine' });
  while (!release) await tick();
  stuck.brain.abortCurrent('shutdown');
  const since = Date.now();
  await stuck.brain.settle(30);
  assert.ok(Date.now() - since < 500);
  assert.equal(stuck.brain.busy, true);
  release();
  await job;
});

test('lines about the running job go to whoever whispered it', async () => {
  const tool = holdingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [])]);
  const { brain } = makeBrain({ client, runTool: tool.run });
  assert.equal(brain.replyTo, null);
  const job = brain.start({ player: 'Steve', text: 'mine stone', whisper: true });
  await tool.ready;
  assert.equal(brain.replyTo, 'Steve');
  brain.stop();
  await job;
  assert.equal(brain.replyTo, null);
});

test('finish after the last action says the line and ends the job without another call', async () => {
  const lines = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'craft', { item: 'stick' }), toolUse('b', 'finish', { message: 'Made sticks.' })])]);
  const { brain, heard, toolCalls } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'make sticks', whisper: true });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(toolCalls.map((t) => t.name), ['craft']);
  assert.deepEqual(heard, [{ text: 'Made sticks.', to: 'Steve' }]);
  assert.equal(lines[0].end, 'done');
  assert.deepEqual(lines[0].steps[0].tools.map((t) => [t.name, t.ok]), [['craft', true], ['finish', true]]);
});

test('finish is not carried out when something before it failed', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'move_to', { x: 0, y: 0, z: 0 }), toolUse('b', 'place_block', { block: 'torch', x: 0, y: 1, z: 0 }), toolUse('c', 'finish', { message: 'Torch placed.' })]),
    reply('end_turn', [{ type: 'text', text: "I can't get there." }])
  ]);
  const ran = [];
  const { brain, said } = makeBrain({ client, runTool: async (name) => (ran.push(name), { ok: false, message: 'no path' }) });
  await brain.start({ player: 'Steve', text: 'put a torch there' });
  assert.deepEqual(ran, ['move_to']);
  assert.deepEqual(said, ["I can't get there."]);
  const [walk, place, finish] = client.calls[1].params.messages.at(-1).content;
  assert.equal(walk.content, 'no path');
  assert.equal(place.content, 'Not done, because an earlier action in this response failed (see above).');
  assert.equal(place.is_error, true);
  assert.match(finish.content, /^Not done, because an earlier action in this response failed.*Your message wasn't sent\./);
  assert.equal(finish.is_error, true);
});

test('a stopped call stops the rest of the response too', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft'), toolUse('c', 'store_items')]), reply('end_turn', [])]);
  const ran = [];
  const brain = new Brain({
    client,
    config: baseConfig,
    runTool: (name, input, signal) => {
      ran.push(name);
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: true, message: 'mined 3' })));
    },
    snapshot: () => 'SNAPSHOT',
    say: () => {},
    log: () => {},
    watchTool: (name, controller) => {
      setImmediate(() => controller.abort('stuck'));
      return { stop: () => {}, report: () => 'Nothing changed.' };
    }
  });
  await brain.start({ player: 'Steve', text: 'mine, craft and store' });
  assert.deepEqual(ran, ['mine']);
  const results = client.calls[1].params.messages.at(-1).content;
  assert.deepEqual(results.slice(1).map((r) => r.content), Array(2).fill('Not done, because an earlier action in this response failed (see above).'));
});

test('finish waits while a player change still has to be worked in', async () => {
  let brain;
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'finish', { message: 'Mined.' })]),
    reply('end_turn', [{ type: 'text', text: 'Mined, and some coal too.' }])
  ]);
  const made = makeBrain({
    client,
    runTool: async () => {
      brain.addToJob(brain.current, 'Alex', 'get coal too');
      return { ok: true, message: 'mined' };
    }
  });
  brain = made.brain;
  await brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(made.said, ["Okay Alex, I'll work that in.", 'Mined, and some coal too.']);
  const last = client.calls[1].params.messages.at(-1).content;
  assert.match(last[1].content, /^Not done, because a player just changed the instructions/);
  assert.match(last[2].text, /Alex said: get coal too/);
});

test('finish waits out a hold that stopped the action before it', async () => {
  const tool = holdingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'finish', { message: 'Mined.' })]), reply('end_turn', [{ type: 'text', text: 'Back at it.' }])]);
  const { brain, said } = makeBrain({ client, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await tool.ready;
  await brain.pause('danger');
  brain.resume('danger', 'You ate bread.');
  await job;
  assert.deepEqual(said, ['Back at it.']);
  assert.match(client.calls[1].params.messages[2].content[1].content, /^Not done, because you had to look after yourself/);
});

test('finish only works as the last call, and free time can finish quietly', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'finish', { message: 'Done.' }), toolUse('b', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  const { brain, said, toolCalls } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(toolCalls.map((t) => t.name), ['mine']);
  assert.match(client.calls[1].params.messages.at(-1).content[0].content, /finish has to be the last call/);
  assert.deepEqual(said, ['Mined.']);

  const free = makeBrain({ client: fakeClient([reply('tool_use', [toolUse('a', 'finish', { message: 'nothing' })])]), config: routedIdle });
  await free.brain.start({ player: null, text: null, self: true });
  assert.deepEqual(free.said, []);
});

function gate() {
  let open;
  const shut = new Promise((resolve) => (open = resolve));
  shut.open = open;
  return shut;
}

async function until(check) {
  for (let i = 0; i < 2000 && !check(); i++) await tick();
  assert.ok(check(), 'timed out');
}

// onThinking goes true, false, true, false: one false for each true.
const paired = (thinks) => thinks.length % 2 === 0 && thinks.every((active, i) => active === (i % 2 === 0));

test('the plan line is said and the first call starts before the answer is all in, and later calls still run in order', async () => {
  const lines = [];
  const more = gate();
  const end = gate();
  const mined = gate();
  const client = fakeClient([
    {
      ...reply('tool_use', [{ type: 'text', text: 'Checking the roof first.' }, toolUse('a', 'mine', { block: 'stone' }), toolUse('b', 'craft', { item: 'stick' }), toolUse('c', 'store_items', { items: [] })]),
      gates: { 3: more, end }
    },
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const events = [];
  const runTool = async (name) => {
    events.push(`start ${name}`);
    if (name === 'mine') await mined;
    events.push(`end ${name}`);
    return { ok: true, message: `${name} done` };
  };
  const { brain, said, thinks } = makeBrain({ client, runTool, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'fix the roof', whisper: true });
  await until(() => events.length > 0);
  assert.deepEqual(said, ['Checking the roof first.']);
  assert.deepEqual(events, ['start mine']);
  assert.deepEqual(thinks, [true, false]);
  // craft has come in, but waits for mine.
  more.open();
  await sleep(20);
  assert.deepEqual(events, ['start mine']);
  mined.open();
  await until(() => events.length === 4);
  // The last call waits for the end, since it could still be cut off.
  assert.deepEqual(events, ['start mine', 'end mine', 'start craft', 'end craft']);
  assert.equal(client.calls.length, 1);
  await sleep(20);
  end.open();
  await job;
  assert.deepEqual(events.slice(4), ['start store_items', 'end store_items']);
  assert.equal(client.calls.length, 2);
  const results = client.calls[1].params.messages[2].content;
  assert.deepEqual(results.map((r) => [r.tool_use_id, r.content]), [['a', 'mine done'], ['b', 'craft done'], ['c', 'store_items done']]);
  assert.deepEqual(said, ['Checking the roof first.', 'Done.']);
  const [step] = lines[0].steps;
  assert.deepEqual(step.tools.map((t) => [t.name, t.ok]), [['mine', true], ['craft', true], ['store_items', true]]);
  assert.equal(typeof step.firstMs, 'number');
  assert.ok(step.firstMs < step.ms, `${step.firstMs} < ${step.ms}`);
  assert.deepEqual(thinks, [true, false, true, false]);
});

test('a call that fails before the rest of the answer is in stops the rest, and finish after it does not end the job', async () => {
  const rest = gate();
  const client = fakeClient([
    {
      ...reply('tool_use', [toolUse('a', 'move_to', { x: 0, y: 0, z: 0 }), toolUse('b', 'place_block', { block: 'torch', x: 0, y: 1, z: 0 }), toolUse('c', 'finish', { message: 'Torch placed.' })]),
      gates: { 2: rest }
    },
    reply('end_turn', [{ type: 'text', text: "I can't get there." }])
  ]);
  const ran = [];
  const { brain, said, thinks } = makeBrain({ client, runTool: async (name) => (ran.push(name), { ok: false, message: 'no path' }) });
  const job = brain.start({ player: 'Steve', text: 'put a torch there' });
  await until(() => ran.length === 1);
  await sleep(10);
  rest.open();
  await job;
  assert.deepEqual(ran, ['move_to']);
  assert.deepEqual(said, ["I can't get there."]);
  const [walk, place, finish] = client.calls[1].params.messages.at(-1).content;
  assert.equal(walk.content, 'no path');
  assert.equal(place.content, 'Not done, because an earlier action in this response failed (see above).');
  assert.match(finish.content, /^Not done, because an earlier action in this response failed.*Your message wasn't sent\./);
  assert.ok(paired(thinks));
  assert.equal(thinks.length, 4);
});

test('a hold that begins while the answer streams in runs none of it, says no plan, and ends the thinking', async () => {
  const rest = gate();
  const client = fakeClient([
    { ...reply('tool_use', [{ type: 'text', text: 'Mining over there.' }, toolUse('a', 'mine'), toolUse('b', 'craft')]), gates: { 0: rest } },
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain, said, toolCalls, thinks } = makeBrain({ client });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await until(() => client.calls.length === 1);
  await sleep(10);
  await brain.pause('danger');
  assert.deepEqual(thinks, [true, false]);
  rest.open();
  await sleep(20);
  assert.deepEqual(toolCalls, []);
  assert.deepEqual(said, []);
  brain.resume('danger', 'You backed off from zombie.');
  await job;
  assert.deepEqual(toolCalls, []);
  assert.deepEqual(said, ['Done.']);
  const messages = client.calls[1].params.messages;
  assert.deepEqual(messages[2].content.map((r) => r.content), Array(2).fill('Not done, because you had to look after yourself (see below).'));
  assert.deepEqual(thinks, [true, false, true, false]);
});

test('a hold that stops a call while the answer streams in keeps the later calls from running', async () => {
  const tool = holdingTool();
  const rest = gate();
  const client = fakeClient([
    { ...reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft'), toolUse('c', 'store_items')]), gates: { 2: rest } },
    reply('end_turn', [{ type: 'text', text: 'Back to mining.' }])
  ]);
  const { brain, said, thinks } = makeBrain({ client, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await until(() => tool.ran.length > 0);
  await brain.pause('danger');
  rest.open();
  await sleep(20);
  brain.resume('danger', 'You ate bread.');
  await job;
  assert.deepEqual(tool.ran, ['mine']);
  const results = client.calls[1].params.messages[2].content;
  assert.equal(results[0].content, 'mined 3 (Stopped because you had to look after yourself, see below.)');
  assert.deepEqual(results.slice(1).map((r) => r.content), Array(2).fill('Not done, because you had to look after yourself (see below).'));
  assert.deepEqual(said, ['Back to mining.']);
  assert.ok(paired(thinks));
});

test('a stop while the answer streams in stops the running call, runs nothing after it, and keeps it in the job log', async () => {
  const lines = [];
  const tool = holdingTool();
  const rest = gate();
  const client = fakeClient([{ ...reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft'), toolUse('c', 'store_items')]), gates: { 2: rest } }]);
  const { brain, said, thinks } = makeBrain({ client, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'mine stone' });
  await until(() => tool.ran.length > 0);
  brain.stop();
  await job;
  rest.open();
  await sleep(10);
  assert.deepEqual(tool.ran, ['mine']);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(said, ['Stopped.']);
  assert.equal(lines[0].end, 'stop');
  assert.deepEqual(lines[0].steps[0].tools.map((t) => [t.name, t.ok]), [['mine', false]]);
  assert.equal(lines[0].steps[0].tokens.input, 10);
  assert.deepEqual(thinks, [true, false]);
});

test('a refusal or a cut-off that comes after a call has started stops that call and ends the job as before', async () => {
  for (const [stop, line] of [
    ['refusal', "I can't help with that one."],
    ['max_tokens', 'My answer got cut off. Try asking for something smaller.']
  ]) {
    const lines = [];
    const tool = holdingTool();
    const end = gate();
    const client = fakeClient([{ ...reply(stop, [toolUse('a', 'mine'), toolUse('b', 'craft')]), gates: { end } }]);
    const { brain, said, thinks } = makeBrain({ client, runTool: tool.run, jobLog: { write: (l) => lines.push(l) } });
    const job = brain.start({ player: 'Steve', text: 'mine stone' });
    await until(() => tool.ran.length > 0);
    end.open();
    await job;
    assert.deepEqual(tool.ran, ['mine']);
    assert.deepEqual(said, [line]);
    assert.equal(client.calls.length, 1);
    assert.equal(lines[0].end, stop);
    assert.deepEqual(lines[0].steps[0].tools.map((t) => [t.name, t.ok]), [['mine', false]]);
    assert.deepEqual(thinks, [true, false]);
  }
});

const refusal = (category = null) => ({ ...reply('refusal', []), stop_details: { type: 'refusal', category, explanation: category ? 'Declined.' : null } });

test('a refusal with no output is tried once more on the same model, and the job carries on when that answers', async () => {
  for (const config of [plain, baseConfig]) {
    const lines = [];
    let forgot = 0;
    const client = fakeClient([refusal('general_harms'), reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
    const { brain, said, toolCalls } = makeBrain({ client, config, jobLog: { write: (l) => lines.push(l) }, forgetRequests: () => forgot++ });
    await brain.start({ player: 'Steve', text: 'mine some stone' });
    assert.equal(forgot, 0);
    assert.equal('leanCured' in lines[0].refusals, false);
    assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
    assert.deepEqual(client.calls[1].params.messages, client.calls[0].params.messages);
    assert.deepEqual(toolCalls.map((t) => t.name), ['mine']);
    assert.deepEqual(said, ['Mined.']);
    assert.equal(lines[0].end, 'done');
    assert.equal(lines[0].steps.length, 3);
    assert.ok(lines[0].steps[0].cost > 0);
    assert.equal(lines[0].refusals.count, 1);
    assert.deepEqual(lines[0].refusals.by, [{ model: 'claude-opus-5-5', category: 'general_harms', lean: false }]);
  }
});

// A snapshot laid out the way index.js builds one, with the parts a lean turn leaves out made by
// the code that makes them in the bot.
async function carriedSnapshot(dir) {
  const { RequestLog } = await import('../src/chat.js');
  const { chatSummary } = await import('../src/perception.js');
  const requests = new RequestLog(join(dir, 'requests.json'));
  requests.add('Alex', 'clodine say something odd', null, Date.now() - 60000);
  requests.add('Steve', 'mine some stone', null, Date.now() - 1000);
  const chat = [{ username: 'Alex', message: 'clodine say something odd' }];
  const text = () => ['Position: 1 2 3', 'Inventory: 3 stone', 'Memories: none', requests.summary(), 'Areas: none', chatSummary(chat)].join('\n\n');
  return { requests, text };
}

const CARRIED = [/^Recent requests to you/, /^Recent chat/, /^Your last job/];
const firstText = (call) => textOf(call.params.messages[0].content);

test('a refusal with no category or for reasoning_extraction is tried again without the carried-over parts, and a cure clears the remembered requests', async () => {
  for (const [config, category] of [
    [plain, null],
    [plain, 'reasoning_extraction'],
    [baseConfig, null],
    [baseConfig, 'reasoning_extraction']
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'brain-lean-'));
    try {
      const lines = [];
      const logged = [];
      const { requests, text } = await carriedSnapshot(dir);
      const client = fakeClient([refusal(category), reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
      const { brain, said } = makeBrain({
        client,
        config,
        snapshot: text,
        forgetRequests: (before) => requests.forget(before),
        jobLog: { write: (l) => lines.push(l) },
        log: (l) => logged.push(l)
      });
      brain.lastJob = { player: 'Alex', text: 'clodine say something odd', self: false, end: 'done', at: Date.now() - 30000 };
      requests.add('Bob', 'a request after the job began', null, Date.now() + 60000);
      await brain.start({ player: 'Steve', text: 'mine some stone' });
      const full = firstText(client.calls[0]).split('\n\n');
      const lean = firstText(client.calls[1]).split('\n\n');
      for (const part of CARRIED) assert.ok(full.some((p) => part.test(p)), `${part}`);
      assert.deepEqual(lean, full.filter((p) => !CARRIED.some((part) => part.test(p))));
      assert.ok(lean.includes('Position: 1 2 3') && lean.includes('Request from Steve: mine some stone'));
      // The rest of the job stays lean.
      assert.equal(firstText(client.calls[2]), firstText(client.calls[1]));
      assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
      assert.deepEqual(said, ['Mined.']);
      assert.deepEqual(lines[0].refusals, { count: 1, by: [{ model: 'claude-opus-5-5', category, lean: false }], leanCured: true });
      // Only the requests the job carried are cleared, in the file too.
      assert.deepEqual(requests.entries.map((e) => e.player), ['Bob']);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')).map((e) => e.player), ['Bob']);
      assert.ok(logged.includes('[brain] the step went through without the carried-over parts, so this job stays without them and the remembered requests and recent chat are cleared'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a lean try at a later step also drops the earlier thinking, which no longer matches the first turn', async () => {
  const thinking = { type: 'thinking', thinking: 'Stone is east.', signature: 'c2ln' };
  const client = fakeClient([reply('tool_use', [thinking, toolUse('a', 'mine')]), refusal(), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  const { brain, said } = makeBrain({ client, config: plain, snapshot: () => 'Position: 1 2 3\n\nRecent chat:\n<Alex> hi' });
  await brain.start({ player: 'Steve', text: 'mine some stone' });
  assert.deepEqual(client.calls[1].params.messages[1].content, [thinking, toolUse('a', 'mine')]);
  assert.deepEqual(client.calls[2].params.messages[1].content, [toolUse('a', 'mine')]);
  assert.doesNotMatch(firstText(client.calls[2]), /Recent chat/);
  assert.deepEqual(said, ['Mined.']);
});

test('a reasoning_extraction refusal: the quick or main model tries once lean, then the job ends', async () => {
  const quick = fakeClient([refusal('reasoning_extraction'), reply('tool_use', [toolUse('a', 'finish', { message: 'Here.' })])]);
  const sorted = makeBrain({ client: quick, config: routed });
  await sorted.brain.start({ player: 'Steve', text: 'Clodine come here' });
  assert.deepEqual(quick.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(sorted.said, ['Here.']);

  for (const [config, model, text] of [
    [routed, 'claude-haiku-5-5', 'Clodine come here'],
    [plain, 'claude-opus-5-5', 'x'],
    [baseConfig, 'claude-opus-5-5', 'x']
  ]) {
    let forgot = 0;
    const client = fakeClient(() => refusal('reasoning_extraction'));
    const { brain, said } = makeBrain({ client, config, forgetRequests: () => forgot++ });
    await brain.start({ player: 'Steve', text });
    assert.deepEqual(client.calls.map((c) => c.params.model), [model, model]);
    assert.deepEqual(said, ["I can't help with that one."]);
    assert.equal(forgot, 0);
  }
});

test('a handed-over step refused lean too moves to the other bigger model, still lean, and a refusal there ends the job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-lean-'));
  try {
    const { requests, text } = await carriedSnapshot(dir);
    const lines = [];
    let forgot = 0;
    const client = fakeClient([
      reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]),
      refusal('reasoning_extraction'),
      refusal('reasoning_extraction'),
      reply('tool_use', [toolUse('b', 'mine')]),
      reply('end_turn', [{ type: 'text', text: 'Mined.' }])
    ]);
    const { brain, said } = makeBrain({ client, config: unstrict, snapshot: text, forgetRequests: () => forgot++, jobLog: { write: (l) => lines.push(l) } });
    await brain.start({ player: 'Steve', text: 'Clodine I need some stone' });
    assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
    assert.ok(CARRIED.slice(0, 2).every((part) => firstText(client.calls[1]).split('\n\n').some((p) => part.test(p))));
    assert.ok(firstText(client.calls[2]).split('\n\n').every((p) => !CARRIED.some((part) => part.test(p))));
    assert.deepEqual(client.calls[3].params.messages, client.calls[2].params.messages);
    assert.deepEqual(said, ['Mined.']);
    // The other model cured it, not the lean turn alone, so the requests stay.
    assert.equal(forgot, 0);
    assert.equal(requests.entries.length, 2);
    assert.deepEqual(lines[0].refusals, {
      count: 2,
      by: [
        { model: 'claude-sonnet-5-5', category: 'reasoning_extraction', lean: false },
        { model: 'claude-sonnet-5-5', category: 'reasoning_extraction', lean: true }
      ]
    });

    const refused = fakeClient((n) => (n === 1 ? reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]) : refusal()));
    const ended = makeBrain({ client: refused, config: unstrict, jobLog: { write: (l) => lines.push(l) } });
    await ended.brain.start({ player: 'Steve', text: 'Clodine I need some stone' });
    assert.deepEqual(refused.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(ended.said, ["I can't help with that one."]);
    assert.equal(lines[1].refusals.count, 3);
    assert.equal(lines[1].end, 'refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused step on a job a bigger model took over goes to the main model and stays there', async () => {
  const lines = [];
  const logged = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]),
    refusal('cyber'),
    reply('tool_use', [toolUse('b', 'mine')]),
    reply('end_turn', [{ type: 'text', text: 'Mined.' }])
  ]);
  const { brain, said } = makeBrain({ client, config: unstrict, jobLog: { write: (l) => lines.push(l) }, log: (l) => logged.push(l) });
  await brain.start({ player: 'Steve', text: 'Clodine I need some stone' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.deepEqual(client.calls[2].params.messages, client.calls[1].params.messages);
  assert.equal(client.calls[1].params.fallbacks, undefined);
  assert.equal(client.calls[2].params.fallbacks, 'default');
  assert.deepEqual(said, ['Mined.']);
  assert.equal(lines[0].model, 'claude-opus-5-5');
  assert.equal(lines[0].tier, 'complex');
  assert.deepEqual(lines[0].refusals, { count: 1, by: [{ model: 'claude-sonnet-5-5', category: 'cyber', lean: false }] });
  assert.ok(logged.some((l) => /^\[brain\] refusal from claude-sonnet-5-5: output 5, category cyber \(Declined\.\), request unknown$/.test(l)));
  assert.ok(logged.includes('[brain] the step was refused, sending it to claude-opus-5-5'));

  // With strict tools only on the bigger models, the job starts over on the everyday model and
  // still moves to the main one.
  const strict = fakeClient([reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]), refusal('cyber'), reply('end_turn', [{ type: 'text', text: 'Done.' }])]);
  const again = makeBrain({ client: strict, config: routed });
  await again.brain.start({ player: 'Steve', text: 'Clodine I need some stone' });
  assert.deepEqual(strict.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(again.said, ['Done.']);
});

test('a step the main model refuses too ends the job the way it always did', async () => {
  const lines = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]), refusal('cyber'), refusal('general_harms'), reply('end_turn', [{ type: 'text', text: 'never' }])]);
  const { brain, said, toolCalls } = makeBrain({ client, config: unstrict, jobLog: { write: (l) => lines.push(l) } });
  await brain.start({ player: 'Steve', text: 'Clodine I need some stone' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(said, ["I can't help with that one."]);
  assert.equal(toolCalls.length, 0);
  assert.equal(lines[0].end, 'refusal');
  assert.equal(lines[0].refusals.count, 2);
  assert.deepEqual(lines[0].refusals.by.map((r) => r.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(lines[0].steps.length, 3);
});

test('a refusal that comes with text ends the job at once', async () => {
  for (const config of [plain, baseConfig]) {
    const client = fakeClient(() => reply('refusal', [{ type: 'text', text: "I won't help with that." }]));
    const { brain, said } = makeBrain({ client, config });
    await brain.start({ player: 'Steve', text: 'x' });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(said, ["I can't help with that one."]);
  }
});

test('a job spends at most two extra calls on refused steps', async () => {
  const lines = [];
  // Every other call is refused, starting with the first.
  const client = fakeClient((n) => (n % 2 === 1 ? refusal() : reply('tool_use', [toolUse(`t${n}`, 'mine')])));
  const { brain, said, toolCalls } = makeBrain({ client, config: plain, jobLog: { write: (l) => lines.push(l) } });
  await brain.start({ player: 'Steve', text: 'mine a lot' });
  assert.equal(client.calls.length, 5);
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(said, ["I can't help with that one."]);
  assert.equal(lines[0].end, 'refusal');
  assert.equal(lines[0].refusals.count, 3);
  assert.equal(lines[0].steps.length, 5);
});

test('each refused request is saved with its full conversation, the prompt only as a length and hash, and no key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-refusals-'));
  try {
    const client = { ...fakeClient(() => refusal('cyber')), apiKey: 'sk-ant-secret-for-test' };
    const refusalLog = new RefusalLog(join(dir, 'refusals'), 20, () => {});
    const brain = new Brain({ client, config: plain, refusalLog, runTool: async () => ({ ok: true, message: 'ok' }), snapshot: () => 'SNAPSHOT', say: () => {}, log: () => {} });
    await brain.start({ player: 'Steve', text: 'mine some stone' });
    const files = readdirSync(join(dir, 'refusals')).sort();
    assert.equal(files.length, 2);
    const text = readFileSync(join(dir, 'refusals', files[0]), 'utf8');
    assert.doesNotMatch(text, /sk-ant|api[-_]?key|x-api-key|headers/i);
    const saved = JSON.parse(text);
    assert.equal(saved.model, 'claude-opus-5-5');
    assert.equal(saved.stopDetails.category, 'cyber');
    assert.deepEqual(saved.request.messages, client.calls[0].params.messages);
    assert.equal(saved.request.system.length, client.calls[0].params.system[0].text.length);
    assert.match(saved.request.system.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!text.includes(client.calls[0].params.system[0].text.slice(0, 200)));
    assert.deepEqual(saved.request.tools, client.calls[0].params.tools.map((t) => t.name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mid-job reply never sends its label or its sorting to chat', async () => {
  assert.equal(
    chatPart("Chat reply: Alex's message is a compliment and a reminder to keep to y -59, which I'm already doing, so it's a chat answer. Thanks, Alex. I'm keeping to y -59 and will check my position as I dig."),
    "Thanks, Alex. I'm keeping to y -59 and will check my position as I dig."
  );
  assert.equal(chatPart('Reply: About halfway done.'), 'About halfway done.');
  assert.equal(chatPart("It's a question about the job, so it's a chat answer."), '');
  assert.equal(chatPart('About halfway done.\nThe chest is by the door.'), 'About halfway done.\nThe chest is by the door.');

  const leaked = "Chat reply: Alex's message is a compliment, so it's a chat answer. Thanks, Alex.";
  let finishTool;
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('end_turn', [{ type: 'text', text: leaked }]),
    reply('end_turn', [{ type: 'text', text: 'Mined.' }])
  ]);
  const runTool = () => new Promise((resolve) => (finishTool = () => resolve({ ok: true, message: 'mined' })));
  const config = { ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } };
  const { brain, said } = makeBrain({ client, config, runTool });
  const job = brain.start({ player: 'Steve', text: 'mine some stone' });
  await until(() => finishTool);
  await brain.busyReply('Alex', 'Clodine nice work');
  finishTool();
  await job;
  assert.deepEqual(said, ['Thanks, Alex.', 'Mined.']);
});

test('a streamed answer goes into the conversation exactly as a whole one would, thinking included, with the same tokens and cost', async () => {
  const content = [
    { type: 'thinking', thinking: 'The roof has a gap at 3 70 -2.', signature: 'c2lnbmF0dXJl' },
    { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
    { type: 'text', text: 'Patching the roof.' },
    toolUse('a', 'place_block', { block: 'oak_planks', x: 3, y: 70, z: -2 }),
    { type: 'thinking', thinking: 'Then the wall.', signature: 'd2FsbA==' },
    toolUse('b', 'build_structure', { origin: { x: 0, y: 64, z: 0 }, parts: [{ block: 'stone', from: [0, 0, 0], to: [1, 1, 1] }] })
  ];
  const run = async (config) => {
    const lines = [];
    const client = fakeClient([
      { ...reply('tool_use', content), usage: { ...usage(40, 9000, 3000, 120), cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } },
      reply('end_turn', [{ type: 'text', text: 'Patched.' }])
    ]);
    const made = makeBrain({ client, config, jobLog: { write: (line) => lines.push(line) } });
    await made.brain.start({ player: 'Steve', text: 'fix the roof' });
    return { client, sent: client.calls[1].params.messages, line: lines[0], said: made.said, ran: made.toolCalls.map((t) => t.name) };
  };
  const streamed = await run(baseConfig);
  const whole = await run(plain);
  assert.ok(streamed.client.calls.every((c) => c.streamed));
  assert.ok(whole.client.calls.every((c) => !c.streamed));
  assert.deepEqual(streamed.sent[1], { role: 'assistant', content });
  assert.deepEqual(streamed.sent, whole.sent);
  assert.deepEqual(streamed.line.steps[0].tokens, { input: 40, cacheRead: 9000, cacheWrite: 3000, output: 120, cacheWrite5m: 1000, cacheWrite1h: 2000 });
  assert.deepEqual(streamed.line.totals, { ...whole.line.totals, modelMs: streamed.line.totals.modelMs, toolMs: streamed.line.totals.toolMs });
  assert.ok(streamed.line.totals.cost > 0);
  assert.deepEqual(streamed.said, whole.said);
  assert.deepEqual(streamed.ran, ['place_block', 'build_structure']);
  assert.deepEqual(streamed.ran, whole.ran);
});

test('a sorting step, or text with no call after it, is only acted on once the answer is all in', async () => {
  const end = gate();
  const client = fakeClient([{ ...reply('tool_use', [{ type: 'text', text: 'On my way.' }, toolUse('a', 'go_to_player', { player: 'Steve' }), toolUse('b', 'finish', { message: 'Here.' })]), gates: { end } }]);
  const { brain, said, toolCalls, thinks } = makeBrain({ client, config: routed });
  const job = brain.start({ player: 'Steve', text: 'Clodine come here' });
  await until(() => client.calls.length === 1);
  await sleep(20);
  assert.deepEqual(said, []);
  assert.deepEqual(toolCalls, []);
  assert.deepEqual(thinks, [true]);
  end.open();
  await job;
  assert.deepEqual(toolCalls.map((t) => t.name), ['go_to_player']);
  assert.deepEqual(said, ['On my way.', 'Here.']);
  assert.deepEqual(thinks, [true, false]);

  const last = gate();
  const replyClient = fakeClient([{ ...reply('end_turn', [{ type: 'text', text: 'The roof is done.' }, { type: 'text', text: 'Next is the porch.' }]), gates: { 1: last } }, reply('end_turn', [{ type: 'text', text: 'Porch done.' }])]);
  const replied = makeBrain({ client: replyClient });
  const second = replied.brain.start({ player: 'Steve', text: 'fix the house' });
  await until(() => replyClient.calls.length === 1);
  await sleep(20);
  assert.deepEqual(replied.said, []);
  last.open();
  await second;
  assert.deepEqual(replied.said, ['The roof is done. Next is the porch.', 'Porch done.']);
});

test('onThinking pairs up on the plain path and on errors, and its own errors never reach the job', async () => {
  const order = [];
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  let brain;
  const made = makeBrain({
    client,
    config: plain,
    runTool: async (name) => (order.push(`tool ${name}`), { ok: true, message: 'mined' }),
    onThinking: (active, job) => order.push(`${active ? 'thinking' : 'done'}${job === brain.current ? '' : ' (wrong job)'}`)
  });
  brain = made.brain;
  await brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(order, ['thinking', 'done', 'tool mine', 'thinking', 'done']);

  for (const config of [plain, baseConfig]) {
    const failed = makeBrain({ client: fakeClient([new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())]), config });
    await failed.brain.start({ player: 'Steve', text: 'x' });
    assert.deepEqual(failed.thinks, [true, false]);
  }

  const logged = [];
  const broken = makeBrain({
    client: fakeClient([reply('tool_use', [toolUse('a', 'mine'), toolUse('b', 'craft')]), reply('end_turn', [{ type: 'text', text: 'Done.' }])]),
    onThinking: () => {
      throw new Error('head stuck');
    },
    log: (text) => logged.push(text)
  });
  await broken.brain.start({ player: 'Steve', text: 'mine stone' });
  assert.deepEqual(broken.toolCalls.map((t) => t.name), ['mine', 'craft']);
  assert.deepEqual(broken.said, ['Done.']);
  assert.equal(logged.filter((l) => l === '[brain] onThinking failed: head stuck').length, 4);
});

test('with streaming off every step uses create, and mid-job replies never stream', async () => {
  const off = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
  const { brain } = makeBrain({ client: off, config: plain });
  await brain.start({ player: 'Steve', text: 'mine stone' });
  assert.equal(off.calls.length, 2);
  assert.ok(off.calls.every((c) => !c.streamed));

  const { brain: busy, said, release, client } = busyBrain([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Mining.' }]), reply('end_turn', [])]);
  const job = busy.start({ player: 'Steve', text: 'mine stone' });
  await tick();
  busy.enqueue('Alex', 'what are you doing?');
  await until(() => said.length > 0);
  release();
  await job;
  assert.deepEqual(client.calls.map((c) => Boolean(c.streamed)), [true, false, true]);
});

test('the prompt explains finish and batches, and no longer asks for a dry run before every build', async () => {
  const { systemPrompt } = await import('../src/prompt.js');
  const text = systemPrompt('Clodine');
  assert.match(text, /finish/);
  assert.match(text, /stop at the first (one that )?fail/);
  assert.match(text, /\(whispered\)/);
  assert.doesNotMatch(text, /with dry_run first/);
  assert.doesNotMatch(text, /check it with dry_run, then build/);
});

test('a reflex job is told what the body already did, and the system prompt stays the same', async () => {
  const lines = {
    come: /You already set off toward Steve the moment they asked, so don't call a walk to them again\. Just reply\./,
    follow: /You are already following Steve, so don't call follow_player again\. Just reply\./,
    stay: /You already stopped and are staying put, so don't call stop_moving\. Just reply\./
  };
  const plainJob = fakeClient([reply('end_turn', [{ type: 'text', text: 'Hi!' }])]);
  await makeBrain({ client: plainJob }).brain.start({ player: 'Steve', text: 'Clodine come here' });
  assert.doesNotMatch(plainJob.calls[0].params.messages[0].content, /already/);
  for (const [kind, line] of Object.entries(lines)) {
    for (const config of [baseConfig, routed]) {
      const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Okay!' }])]);
      await makeBrain({ client, config }).brain.start({ player: 'Steve', text: 'Clodine come here', reflex: kind });
      assert.match(textOf(client.calls[0].params.messages[0].content), line);
      if (config === baseConfig) assert.deepEqual(client.calls[0].params.system, plainJob.calls[0].params.system);
    }
  }
});

test('the rest of a stop message is told the stop is done, keeps its own tier, and an unknown kind adds nothing', async () => {
  const STOP_DONE = /You already stopped what you were doing and said so, so don't call stop_moving or say you stopped again\. Just do the rest of what they asked\./;
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Coming.' }])]);
  await makeBrain({ client }).brain.start({ player: 'Steve', text: 'come here', reflex: 'stop' });
  assert.match(textOf(client.calls[0].params.messages[0].content), STOP_DONE);
  const { brain } = makeBrain({ client: fakeClient([]), config: routed });
  assert.equal(brain.firstTier({ player: 'Steve', text: 'dig out the next tunnel', reflex: 'stop' }), brain.firstTier({ player: 'Steve', text: 'dig out the next tunnel' }));

  const odd = fakeClient([reply('end_turn', [{ type: 'text', text: 'Hi!' }])]);
  const lines = [];
  await makeBrain({ client: odd, jobLog: { write: (line) => lines.push(line) } }).brain.start({ player: 'Steve', text: 'hello', reflex: 'wave' });
  assert.doesNotMatch(textOf(odd.calls[0].params.messages[0].content), /already/);
  assert.equal(lines[0].end, 'done');

  // Queued behind a job the stop is still ending, it carries the kind too.
  const queued = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Coming.' }])]);
  let started;
  const ready = new Promise((r) => (started = r));
  const run = (name, input, signal) =>
    new Promise((resolve) => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }));
    });
  const b = makeBrain({ client: queued, runTool: run });
  const first = b.brain.start({ player: 'Steve', text: 'mine stone' });
  await ready;
  b.brain.stop(null, 'Steve');
  b.brain.queue.push({ player: 'Steve', text: 'come here', whisper: false, reflex: 'stop' });
  await first;
  while (b.brain.busy) await tick();
  assert.match(textOf(queued.calls[1].params.messages[0].content), STOP_DONE);
});

test('a reflex order is marked in the job log, also when it ends free time', async () => {
  const lines = [];
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'Coming!' }])]);
  const { brain } = makeBrain({ client, jobLog: { write: (line) => lines.push(line) } });
  brain.enqueue('Steve', 'Clodine come here', false, 'come');
  await brain.current.done;
  assert.equal(lines[0].reflex, 'come');

  const freeLines = [];
  const slow = slowClient(30, () => reply('end_turn', [{ type: 'text', text: 'Following you.' }]));
  const free = makeBrain({ client: slow, config: { ...plain, idle: { freeTimeSeconds: 60, freeTimeSteps: 4 } }, jobLog: { write: (line) => freeLines.push(line) } });
  free.brain.freeTime();
  await tick();
  free.brain.enqueue('Steve', 'Clodine follow me', false, 'follow');
  while (free.brain.busy || freeLines.length < 2) await tick();
  assert.deepEqual(freeLines.map((l) => [l.freeTime, l.reflex ?? null]), [[true, null], [false, 'follow']]);
  assert.deepEqual(free.said, ['Following you.']);
});

test('"On my way, I\'ll head right over" ends a reflex job, while a normal job is still sent on', async () => {
  const line = "On my way, I'll head right over.";
  for (const ending of ['finish', 'reply']) {
    const answer = () => (ending === 'finish' ? reply('tool_use', [toolUse('a', 'finish', { message: line })]) : reply('end_turn', [{ type: 'text', text: line }]));
    const quick = fakeClient([answer(), reply('end_turn', [{ type: 'text', text: 'Here.' }])]);
    const reflexJob = makeBrain({ client: quick });
    await reflexJob.brain.start({ player: 'Steve', text: 'Clodine come here', reflex: 'come' });
    assert.equal(quick.calls.length, 1, ending);
    assert.deepEqual(reflexJob.said, [line]);

    const held = fakeClient([answer(), reply('end_turn', [{ type: 'text', text: 'Here.' }])]);
    const normal = makeBrain({ client: held });
    await normal.brain.start({ player: 'Steve', text: 'Clodine come here' });
    assert.equal(held.calls.length, 2, ending);
  }
});

test('text before a lone finish only goes to the log, but is said before real actions', async () => {
  for (const config of [plain, baseConfig]) {
    const logs = [];
    const client = fakeClient([
      reply('tool_use', [{ type: 'text', text: 'Yes. Strip mining means digging a straight tunnel through a layer of ore.' }, toolUse('a', 'finish', { message: 'Yes. Strip mining means digging a straight tunnel at one height.' })])
    ]);
    const lone = makeBrain({ client, config, log: (line) => logs.push(line) });
    await lone.brain.start({ player: 'Steve', text: 'Clodine do you know strip mining?' });
    assert.deepEqual(lone.said, ['Yes. Strip mining means digging a straight tunnel at one height.'], config.claude.streaming ? 'streamed' : 'not streamed');
    assert.ok(logs.some((l) => l === '[brain] plan: Yes. Strip mining means digging a straight tunnel through a layer of ore.'));

    const acting = fakeClient([reply('tool_use', [{ type: 'text', text: 'Walking over.' }, toolUse('a', 'go_to_player', { player: 'Steve' }), toolUse('b', 'finish', { message: 'Here.' })])]);
    const walker = makeBrain({ client: acting, config });
    await walker.brain.start({ player: 'Steve', text: 'Clodine come here and dig' });
    assert.deepEqual(walker.said, ['Walking over.', 'Here.']);
  }
});

// A lessons store that starts empty and never writes, so no file is left behind.
function lessonStore() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-lessons-'));
  const lessons = new Lessons(join(dir, 'lessons.json'), { ignore: ['Clodine', 'Steve', 'Alex'] });
  lessons.saveSoon = () => {};
  rmSync(dir, { recursive: true, force: true });
  return lessons;
}

// Like fakeClient, but calls with no tools (the lesson reviews) get answers of their own.
function reviewClient(responses, review) {
  const client = fakeClient(responses);
  const create = client.beta.messages.create;
  client.reviews = [];
  client.beta.messages.create = async (params, opts) => {
    if (params.tools) return create(params, opts);
    client.reviews.push(structuredClone(params));
    return typeof review === 'function' ? review(client.reviews.length) : review;
  };
  return client;
}

const lessonReply = (text) => ({ model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 300, output_tokens: 20 } });
const learner = { ...plain, claude: { ...plain.claude, routing: true, everydayModel: 'claude-sonnet-5-5', quickModel: 'claude-haiku-5-5' } };

test('a job that went wrong is looked over once by the quick model, and the lesson is kept and logged', async () => {
  const lessons = lessonStore();
  const lines = [];
  const logged = [];
  const lesson = 'Walk to a cave or a hillside first, since mine only searches the blocks around you.';
  const client = reviewClient([reply('tool_use', [toolUse('a', 'mine', { block: 'iron_ore' })]), reply('end_turn', [{ type: 'text', text: "I couldn't find any iron." }])], lessonReply(lesson));
  const { brain } = makeBrain({
    client,
    config: learner,
    lessons,
    jobLog: { write: (line) => lines.push(line) },
    log: (line) => logged.push(line),
    runTool: async () => ({ ok: false, message: 'no iron_ore within 32 blocks' })
  });
  await brain.start({ player: 'Steve', text: 'Clodine mine some iron', tier: 'complex' });
  await until(() => lines.length === 2);
  assert.equal(client.reviews.length, 1);
  const review = client.reviews[0];
  assert.equal(review.model, 'claude-haiku-5-5');
  assert.equal(review.tools, undefined);
  assert.deepEqual(review.output_config, { effort: 'low' });
  assert.match(review.system, /exactly NONE/);
  assert.match(review.messages[0].content, /Actions in order: mine FAILED: no iron_ore within 32 blocks/);
  assert.doesNotMatch(review.messages[0].content, /Steve|Clodine/);
  assert.equal(lines[0].end, 'done');
  assert.equal(lines[1].end, 'lesson');
  assert.equal(lines[1].lesson, lesson);
  assert.equal(lines[1].calls[0].kind, 'lesson');
  assert.deepEqual(lessons.lessons.map((l) => [l.text, l.tools, l.source]), [[lesson, ['mine'], 'failure']]);
  assert.ok(logged.includes(`[lessons] learned: ${lesson}`));
  brain.correct('Steve', 'no, wrong');
  await tick();
  assert.equal(client.reviews.length, 1);
});

test('a clean job is not looked over, and counts for the lessons in its first message once the wait is over', async () => {
  const lessons = lessonStore();
  const shown = lessons.add('Check remembered chests with obtain before you go mining iron ore.', { tools: ['mine'], request: 'mine some iron ore' });
  const client = reviewClient([reply('tool_use', [toolUse('a', 'mine', { block: 'iron_ore' })]), reply('end_turn', [{ type: 'text', text: 'Got 16 iron ore.' }])], lessonReply('NONE'));
  const { brain } = makeBrain({ client, config: plain, lessons });
  brain.correctionWindowMs = 20;
  await brain.start({ player: 'Steve', text: 'Clodine mine some iron ore' });
  const first = client.calls[0].params;
  assert.match(first.messages[0].content, /Request from Steve: Clodine mine some iron ore\n\nNotes from earlier jobs, advice only[^\n]*\n- Check remembered chests with obtain before you go mining iron ore\.$/);
  assert.doesNotMatch(first.system[0].text, /Notes from earlier jobs|remembered chests with obtain/);
  assert.equal(shown.helped, 0);
  await sleep(60);
  assert.equal(shown.helped, 1);
  assert.equal(shown.score, 1.5);
  assert.equal(client.reviews.length, 0);

  const other = reviewClient([reply('end_turn', [{ type: 'text', text: 'Hi!' }])], lessonReply('NONE'));
  await makeBrain({ client: other, config: plain, lessons }).brain.start({ player: 'Steve', text: 'Clodine how are you' });
  assert.doesNotMatch(other.calls[0].params.messages[0].content, /Notes from earlier jobs/);
});

test('a correction during a job, or just after it, has the job looked over with it', async () => {
  for (const when of ['during', 'after']) {
    const client = reviewClient([reply('tool_use', [toolUse('a', 'store_items', { items: [{ item: 'cobblestone' }] })]), reply('end_turn', [{ type: 'text', text: 'Stored.' }])], lessonReply('NONE'));
    let brain;
    ({ brain } = makeBrain({
      client,
      config: plain,
      lessons: lessonStore(),
      runTool: async () => {
        if (when === 'during') {
          brain.correct('Alex', 'no, not that chest');
          brain.correct('Steve', 'no, not that chest');
        }
        return { ok: true, message: 'stored 64 cobblestone' };
      }
    }));
    brain.correctionWindowMs = 5000;
    await brain.start({ player: 'Steve', text: 'Clodine put the cobblestone away' });
    if (when === 'after') {
      assert.equal(client.reviews.length, 0);
      brain.correct('Alex', 'you put it in the wrong chest');
      assert.equal(client.reviews.length, 0);
      brain.correct('Steve', 'you put it in the wrong chest');
    }
    await until(() => client.reviews.length === 1);
    const quoted = when === 'during' ? 'no, not that chest' : 'you put it in the wrong chest';
    // Alex's correction doesn't go with Steve's job, but it counts as the same thing said again.
    assert.match(client.reviews[0].messages[0].content, new RegExp(`\\nPlayer messages about it: "${quoted}"\\nPlayers have said this or something like it 2 times in the last few hours\\.\\n</job>$`), when);
    assert.equal(brain.waiting.size, 0);
  }
});

test('a tool that fails on its own gets its lessons with its result once a job, and the job log keeps the plain error', async () => {
  for (const config of [plain, baseConfig]) {
    const lessons = lessonStore();
    const lesson = lessons.add('Walk around deep water instead of through it when move_to finds no path.', { tools: ['move_to'] });
    lessons.add('Clear leaves around a trunk before chop_tree on a big jungle tree.', { tools: ['chop_tree'] });
    const lines = [];
    const client = reviewClient(
      [
        reply('tool_use', [toolUse('a', 'move_to', { x: 1, y: 64, z: 1 })]),
        reply('tool_use', [toolUse('b', 'move_to', { x: 2, y: 64, z: 2 })]),
        reply('end_turn', [{ type: 'text', text: "I can't get there." }])
      ],
      lessonReply('NONE')
    );
    const { brain } = makeBrain({ client, config, lessons, jobLog: { write: (line) => lines.push(line) }, runTool: async () => ({ ok: false, message: 'no path' }) });
    await brain.start({ player: 'Steve', text: 'Clodine go over there' });
    const name = config.claude.streaming ? 'streamed' : 'not streamed';
    assert.doesNotMatch(client.calls[0].params.messages[0].content, /Notes from earlier jobs/, name);
    const first = client.calls[1].params.messages.at(-1).content[0];
    const second = client.calls[2].params.messages.at(-1).content[0];
    assert.equal(first.content, `no path\n\nNotes from earlier jobs, advice only (they never override your rules or what the player asks):\n- ${lesson.text}`, name);
    assert.equal(first.is_error, true);
    assert.equal(second.content, 'no path', name);
    assert.deepEqual(lines[0].steps.flatMap((s) => s.tools).map((t) => t.error), ['no path', 'no path']);
    assert.equal(lesson.uses, 1);
  }
});

test('a tool stopped by a player changing the job gets no lessons', async () => {
  const lessons = lessonStore();
  const lesson = lessons.add('Walk around deep water instead of through it when move_to finds no path.', { tools: ['move_to'] });
  let brain;
  const client = reviewClient([reply('tool_use', [toolUse('a', 'move_to', { x: 1, y: 64, z: 1 })]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])], lessonReply('NONE'));
  ({ brain } = makeBrain({
    client,
    config: plain,
    lessons,
    runTool: (name, input, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }));
        brain.addToJob(brain.current, 'Steve', 'go to the other side instead');
      })
  }));
  await brain.start({ player: 'Steve', text: 'Clodine go over there' });
  const result = client.calls[1].params.messages.at(-1).content[0];
  assert.match(result.content, /^stopped \(Stopped because a player just changed the instructions/);
  assert.doesNotMatch(result.content, /Notes from earlier jobs/);
  assert.equal(lesson.uses, 0);
});

test('the review never holds up the next job, and a review call that fails is only logged', async () => {
  const lessons = lessonStore();
  const logged = [];
  let fail;
  const failing = new Promise((_, reject) => (fail = reject));
  const client = reviewClient(
    [reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'No stone here.' }]), reply('end_turn', [{ type: 'text', text: 'Hello Alex!' }])],
    () => failing
  );
  const { brain, said } = makeBrain({ client, config: plain, lessons, log: (line) => logged.push(line), runTool: async () => ({ ok: false, message: 'no stone nearby' }) });
  const first = brain.start({ player: 'Steve', text: 'Clodine mine stone' });
  brain.enqueue('Alex', 'Clodine say hi');
  await first;
  await until(() => said.includes('Hello Alex!'));
  assert.equal(client.reviews.length, 1);
  fail(new Error('overloaded'));
  await until(() => logged.some((line) => line === "[lessons] couldn't review the job: overloaded"));
  assert.equal(lessons.lessons.length, 0);
});

test('with learning.lessons off nothing is picked, shown, looked over or counted', async () => {
  const lessons = lessonStore();
  const lesson = lessons.add('Walk around deep water instead of through it when move_to finds no path.', { tools: ['move_to'], request: 'walk to the deep water' });
  const client = reviewClient([reply('tool_use', [toolUse('a', 'move_to', { x: 1, y: 64, z: 1 })]), reply('end_turn', [{ type: 'text', text: "I can't." }])], lessonReply('NONE'));
  const config = { ...plain, learning: { lessons: false, skills: true } };
  const { brain } = makeBrain({ client, config, lessons, runTool: async () => ({ ok: false, message: 'no path' }) });
  await brain.start({ player: 'Steve', text: 'Clodine walk to the deep water' });
  brain.correct('Steve', 'no, wrong way');
  await tick();
  assert.doesNotMatch(client.calls[0].params.messages[0].content, /Notes from earlier jobs/);
  assert.equal(client.calls[1].params.messages.at(-1).content[0].content, 'no path');
  assert.equal(client.reviews.length, 0);
  assert.equal(brain.waiting.size, 0);
  assert.equal(lesson.uses, 0);
});

test('once the bot is shutting down, nothing more is looked over or counted', async () => {
  const lessons = lessonStore();
  const shown = lessons.add('Check remembered chests with obtain before you go mining iron ore.', { tools: ['mine'], request: 'mine some iron ore' });
  const client = reviewClient(
    [reply('tool_use', [toolUse('a', 'mine')]), reply('end_turn', [{ type: 'text', text: 'Done.' }]), reply('tool_use', [toolUse('b', 'mine')]), reply('end_turn', [{ type: 'text', text: 'No luck.' }])],
    lessonReply('NONE')
  );
  let runs = 0;
  const { brain } = makeBrain({ client, config: plain, lessons, runTool: async () => (++runs === 1 ? { ok: true, message: 'mined 16 iron_ore' } : { ok: false, message: 'no iron_ore nearby' }) });
  brain.correctionWindowMs = 20;
  await brain.start({ player: 'Steve', text: 'Clodine mine some iron ore' });
  assert.equal(brain.waiting.size, 1);
  brain.close();
  assert.equal(brain.waiting.size, 0);
  brain.correct('Steve', 'no, not that');
  await brain.start({ player: 'Steve', text: 'Clodine mine some iron ore' });
  await sleep(60);
  assert.equal(client.reviews.length, 0);
  assert.equal(shown.helped, 0);
  assert.equal(shown.failed, 0);
});

test("a reflex job's line and a job that only saves or lists skills are not taken for jobs that went wrong", async () => {
  const lessons = lessonStore();
  const lines = [];
  const client = reviewClient(
    [
      reply('tool_use', [toolUse('a', 'finish', { message: "On my way, I'll head over to you now." })]),
      reply('tool_use', [toolUse('b', 'skill', { action: 'save', name: 'restock', description: 'Restock', steps: [{ tool: 'say', input: '{}' }] })]),
      reply('tool_use', [toolUse('c', 'skill', { action: 'list' }), toolUse('d', 'finish', { message: 'I have no skills saved.' })]),
      reply('tool_use', [toolUse('e', 'skill', { action: 'run', name: 'restock', args: '{"count":64}' })]),
      reply('end_turn', [{ type: 'text', text: 'The restock skill failed at the mining step.' }])
    ],
    lessonReply('NONE')
  );
  const runTool = async (name, input) => {
    if (input.action === 'save') return { ok: false, message: "not saved: step 1: say can't be in a skill, a skill does things, you do the talking" };
    if (input.action === 'run') return { ok: false, message: 'Skill restock failed at step 2 of 3 (mine): no stone nearby. Step 1 was done: 1 take_items: took 1 iron_pickaxe. Step 3 was not run.' };
    return { ok: true, message: 'no skills saved' };
  };
  const { brain, said } = makeBrain({ client, config: plain, lessons, runTool, jobLog: { write: (line) => lines.push(line) } });
  brain.correctionWindowMs = 5000;
  await brain.start({ player: 'Steve', text: 'Clodine come here', reflex: 'come' });
  assert.deepEqual(said, ["On my way, I'll head over to you now."]);
  assert.equal(lines[0].reflex, 'come');
  assert.equal(lines[0].nudges, undefined);
  assert.equal(worthLesson(lines[0]), false);

  await brain.start({ player: 'Steve', text: 'Clodine save that as a skill' });
  assert.deepEqual(lines[1].steps.flatMap((s) => s.tools).map((t) => [t.name, t.action, t.ok]), [['skill', 'save', false], ['skill', 'list', true], ['finish', undefined, true]]);
  assert.equal(worthLesson(lines[1]), false);
  assert.equal(client.reviews.length, 0);

  await brain.start({ player: 'Steve', text: 'Clodine restock the stone' });
  assert.equal(worthLesson(lines[2]), true);
  await until(() => client.reviews.length === 1);
  assert.match(client.reviews[0].messages[0].content, /Actions in order: skill FAILED: Skill restock failed at step 2 of 3 \(mine\): no stone nearby\./);
});

test('the skill tool is sent unless learning.skills is off, and the tools sent are the same for every model', async () => {
  const on = fakeClient([reply('end_turn', [])]);
  await makeBrain({ client: on }).brain.start({ player: 'Steve', text: 'hi' });
  const names = on.calls[0].params.tools.map((t) => t.name);
  assert.deepEqual(names.slice(-4), ['skill', 'finish', 'escalate', 'standing_job']);
  assert.match(on.calls[0].params.system[0].text, /skill save/);

  for (const strictTools of [true, false]) {
    const off = fakeClient([reply('end_turn', [])]);
    const config = { ...baseConfig, claude: { ...baseConfig.claude, strictTools }, learning: { lessons: true, skills: false } };
    await makeBrain({ client: off, config }).brain.start({ player: 'Steve', text: 'hi' });
    const sent = off.calls[0].params.tools.map((t) => t.name);
    assert.deepEqual(sent, names.filter((n) => n !== 'skill'));
    assert.doesNotMatch(off.calls[0].params.system[0].text, /skill save|skill run/);
  }

  const loose = (tools) => JSON.stringify(tools.map(({ strict, ...rest }) => rest));
  for (const config of [routed, unstrict]) {
    const client = fakeClient(() => reply('end_turn', [{ type: 'text', text: 'Hi.' }]));
    const { brain } = makeBrain({ client, config });
    for (const tier of ['simple', 'normal', 'complex', 'simple']) await brain.start({ player: 'Steve', text: 'hi', tier });
    const [quick, everyday, main, again] = client.calls.map((c) => c.params);
    assert.deepEqual([quick, everyday, main].map((p) => p.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.equal(JSON.stringify(everyday.tools), JSON.stringify(main.tools));
    assert.equal(JSON.stringify(quick.tools), JSON.stringify(again.tools));
    assert.equal(JSON.stringify(quick.tools), config === unstrict ? JSON.stringify(main.tools) : loose(main.tools));
    assert.ok(quick.tools.some((t) => t.name === 'skill'));
  }
});

const IRON_DOOR = 'clodine from now on, if you see an iron door, look for a button or switch around it and do not burrow around it';
const UNDERSTOOD = "Understood, Steve. If I see an iron door, I'll look for the button or switch beside it and won't dig around it.";
const saveRule = (id) => toolUse(id, 'remember', { name: 'iron door rule', note: 'Standing order from Steve: at an iron door, look for a button or switch beside it, never dig around it.' });
const withAdmins = (config, admins = ['Steve', 'Alex']) => ({ ...config, admins });

test('a standing order answered with only "Understood" is held back once, until it is saved', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'finish', { message: UNDERSTOOD })]),
    reply('tool_use', [saveRule('b'), toolUse('c', 'finish', { message: 'Saved that as a standing order.' })])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, config: withAdmins(routed), jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: IRON_DOOR });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5']);
  assert.match(textOf(client.calls[0].params.messages[0].content), /save a place or a standing order \(any rule for how to work\) with remember/);
  const held = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(held.is_error, true);
  assert.match(held.content, /^Not done: Steve gave you a lasting rule.*Save it now with remember.*who said it.*Your message wasn't sent\. If it needs a model that thinks more, call escalate/);
  assert.doesNotMatch(held.content, /isn't an admin/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['remember']);
  assert.deepEqual(said, ['Saved that as a standing order.']);
  assert.deepEqual(lines[0].steps[0].tools[0], { name: 'finish', ok: false, ms: 0, error: `held back, rule not saved: ${UNDERSTOOD}` });

  // Saved in the same response as the finish: nothing is held.
  const quick = fakeClient([reply('tool_use', [saveRule('a'), toolUse('b', 'finish', { message: 'Saved.' })])]);
  const once = makeBrain({ client: quick, config: withAdmins(routed) });
  await once.brain.start({ player: 'Steve', text: IRON_DOOR });
  assert.equal(quick.calls.length, 1);
  assert.deepEqual(once.said, ['Saved.']);

  // A one-off order or a question is never held for this.
  const plainJob = fakeClient([reply('tool_use', [toolUse('a', 'finish', { message: 'Ore is harder than stone.' })])]);
  const asked = makeBrain({ client: plainJob, config: withAdmins(routed) });
  await asked.brain.start({ player: 'Steve', text: 'clodine why does it take you longer to break ore blocks than other blocks' });
  assert.equal(plainJob.calls.length, 1);
});

test('the hold for an unsaved rule happens once and shares the nudge limit with promises of more work', async () => {
  const promise = "Understood. I'll go ahead and dig the next tunnel at y -59.";
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'finish', { message: promise })]));
  const { brain, said } = makeBrain({ client, config: withAdmins(baseConfig) });
  await brain.start({ player: 'Steve', text: 'Clodine, this is an instruction, never deviate from y-59' });
  assert.equal(client.calls.length, 3);
  assert.match(client.calls[1].params.messages.at(-1).content[0].content, /lasting rule/);
  assert.match(client.calls[2].params.messages.at(-1).content[0].content, /you said you'd carry on/);
  assert.deepEqual(said, [promise]);
});

test('a plain reply to an unsaved rule is held back too, and a non-admin is told it can only be a note', async () => {
  const client = fakeClient([
    reply('end_turn', [{ type: 'text', text: 'Understood, I will stay at y -59.' }]),
    reply('tool_use', [saveRule('a'), toolUse('b', 'finish', { message: 'Kept that as a note, but only an admin can give me standing orders.' })])
  ]);
  const { brain, said } = makeBrain({ client, config: withAdmins(baseConfig, ['Steve']) });
  await brain.start({ player: 'Alex', text: 'clodine, in your strip mine operation, never deviate from y -59.' });
  const held = client.calls[1].params.messages.at(-1);
  assert.equal(held.role, 'user');
  assert.match(held.content, /^Alex gave you a lasting rule.*Alex isn't an admin, so it can only be kept as a note.*Your message wasn't sent\.$/);
  assert.doesNotMatch(held.content, /escalate/);
  assert.deepEqual(said, ['Kept that as a note, but only an admin can give me standing orders.']);
});

test('the quick model can hand an unsaved rule up, and the bigger model is held for it too if it forgets', async () => {
  // Strict tools differ, so the job starts over on the main model.
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'finish', { message: UNDERSTOOD })]),
    reply('tool_use', [toolUse('b', 'escalate', { to: 'complex' })]),
    reply('tool_use', [toolUse('c', 'finish', { message: UNDERSTOOD })]),
    reply('tool_use', [saveRule('d'), toolUse('e', 'finish', { message: 'Saved.' })])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client, config: withAdmins(routed) });
  await brain.start({ player: 'Steve', text: IRON_DOOR });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.match(client.calls[3].params.messages.at(-1).content[0].content, /^Not done: Steve gave you a lasting rule/);
  assert.doesNotMatch(client.calls[3].params.messages.at(-1).content[0].content, /escalate/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['remember']);
  assert.deepEqual(said, ['Saved.']);

  // Same tools: the main model carries on in the conversation that asked for the rule to be saved.
  const same = fakeClient([
    reply('tool_use', [toolUse('a', 'finish', { message: UNDERSTOOD })]),
    reply('tool_use', [toolUse('b', 'escalate', { to: 'complex' })]),
    reply('tool_use', [saveRule('c'), toolUse('d', 'finish', { message: 'Saved.' })])
  ]);
  const handed = makeBrain({ client: same, config: withAdmins(unstrict) });
  await handed.brain.start({ player: 'Steve', text: IRON_DOOR });
  assert.deepEqual(same.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  const turn = same.calls[2].params.messages.at(-1).content;
  assert.match(turn[0].content, /lasting rule/);
  assert.match(turn.at(-1).text, /handed to you/);
  assert.deepEqual(handed.said, ['Saved.']);
});

test('a rule given mid-job goes into the job as a lasting rule, and the job saves it before it ends', async () => {
  const live = 'clodine, in your strip mine operation, never deviate from y -59. if you suddenly find yourself deviating, adjust back to y -59 immediately.';
  for (const busyAnswer of [
    'UPDATE',
    // Seen live: the reasoning and the word both went to chat, and the rule was lost.
    "Alex's message is an instruction that changes the current job (stay at y -59 except for high-value exposed ores), so it's an update to what I'm doing now.\nUPDATE"
  ]) {
    const client = fakeClient([
      reply('tool_use', [toolUse('a', 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 30, y2: -58, z2: 0 })]),
      reply('end_turn', [{ type: 'text', text: busyAnswer }]),
      reply('tool_use', [toolUse('b', 'finish', { message: 'Tunnel done.' })]),
      reply('tool_use', [toolUse('c', 'remember', { name: 'strip mine', note: 'Standing order from Alex: stay at y -59 in the strip mine.' }), toolUse('d', 'finish', { message: 'Tunnel done, and the y -59 rule is saved.' })])
    ]);
    let started;
    const toolStarted = new Promise((r) => (started = r));
    const runTool = (name, input, signal) =>
      name === 'remember'
        ? Promise.resolve({ ok: true, message: 'remembered strip mine' })
        : new Promise((resolve) => {
            started();
            signal.addEventListener('abort', () => resolve({ ok: false, message: 'Stopped early: stopped' }));
          });
    const config = withAdmins({ ...baseConfig, claude: { ...baseConfig.claude, busyReplies: true } });
    const { brain, said } = makeBrain({ client, config, runTool });
    const job = brain.start({ player: 'Steve', text: 'continue the strip mine' });
    await toolStarted;
    brain.enqueue('Alex', live);
    await job;
    assert.deepEqual(said, ["Okay Alex, I'll work that in.", 'Tunnel done, and the y -59 rule is saved.'], busyAnswer);
    const note = client.calls[2].params.messages.at(-1).content.at(-1).text;
    assert.match(note, /Alex said: clodine, in your strip mine operation.*\nThis is a lasting rule: .*save it with remember before you finish\.$/s);
    assert.match(client.calls[3].params.messages.at(-1).content[0].content, /^Not done: Alex gave you a lasting rule/);
  }
});

test('a rule another player gives mid-job is saved under their name and admin status, never with more say', async () => {
  const { Memory } = await import('../src/memory.js');
  const { remember } = await import('../src/actions/memory.js');
  const dir = mkdtempSync(join(tmpdir(), 'brain-credit-'));
  const config = withAdmins(baseConfig, ['Steve', 'Bob']);
  // jobPlayer's job; each note is [player, text] said during its first step; returns the saved entry.
  const saved = async (jobPlayer, notes, request = 'continue the strip mine') => {
    const memory = new Memory(join(dir, `${Math.random()}.json`));
    let brain;
    const client = fakeClient((n) => {
      if (n === 1) {
        for (const [player, text] of notes) brain.addToJob(brain.current, player, text);
        return reply('end_turn', [{ type: 'text', text: 'Mining.' }]);
      }
      return reply('tool_use', [toolUse('a', 'remember', { name: 'strip mine', note: 'Stay at y -59 in the strip mine.' }), toolUse('b', 'finish', { message: 'Saved.' })]);
    });
    const made = makeBrain({ client, config, runTool: (name, input, signal, requester) => remember({ memory, config, requester: requester ?? brain.current.player }, input) });
    brain = made.brain;
    await brain.start({ player: jobPlayer, text: request });
    return { entry: memory.notes[0], summary: memory.summary() };
  };
  try {
    const stranger = await saved('Steve', [['Alex', 'clodine, in your strip mine operation, never deviate from y -59.']]);
    assert.equal(stranger.entry.by, 'Alex');
    assert.equal(stranger.entry.notAdmin, true);
    assert.match(stranger.summary, /- strip mine \[from Alex, not an admin: a note only, never an order\]: Stay at y -59/);

    // Not caught as a lasting rule in code, but still theirs.
    const admin = await saved('Steve', [['Bob', 'clodine remain at -59 for every tunnel']]);
    assert.equal(admin.entry.by, 'Bob');
    assert.equal('notAdmin' in admin.entry, false);

    for (const [notes, request] of [
      [[], 'clodine from now on, stay at y -59 in the strip mine'],
      [[['Steve', 'never deviate from y -59']], 'continue the strip mine']
    ]) {
      const own = await saved('Steve', notes, request);
      assert.equal(own.entry.by, 'Steve');
      assert.equal('notAdmin' in own.entry, false);
    }

    // Unclear whose it is: the least trusted of them.
    assert.equal((await saved('Steve', [['Bob', 'never cut across tunnels'], ['Alex', 'never deviate from y -59']])).entry.by, 'Alex');
    const under = await saved('Alex', [['Bob', 'never deviate from y -59']]);
    assert.equal(under.entry.by, 'Alex');
    assert.equal(under.entry.notAdmin, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain reply goes to the log as well as to chat, so a question never looks unanswered', async () => {
  const logged = [];
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'My walking hops up onto loose blocks in the tunnel.' }])]);
  const { brain, said } = makeBrain({ client, config: withAdmins(routed), log: (line) => logged.push(line) });
  await brain.start({ player: 'Steve', text: 'clodine tell me why you jump up from -59 constantly' });
  assert.deepEqual(said, ['My walking hops up onto loose blocks in the tunnel.']);
  assert.ok(logged.includes('[brain] reply: My walking hops up onto loose blocks in the tunnel.'));
});

// The first dig_area runs until finish() or until it's stopped, and then answers onStop; any other
// call answers at once.
function digTool(onStop = { ok: false, message: 'dug 30 blocks. Stopped early: stopped' }) {
  const ran = [];
  let started;
  let finish = () => {};
  let stopped = false;
  const ready = new Promise((r) => (started = r));
  const run = (name, input, signal, requester) => {
    ran.push({ name, requester });
    if (name !== 'dig_area' || ran.filter((r) => r.name === 'dig_area').length > 1) return Promise.resolve({ ok: true, message: `${name} done` });
    started();
    return new Promise((resolve) => {
      finish = () => resolve({ ok: true, message: 'dug 74 blocks' });
      signal.addEventListener('abort', () => {
        stopped = true;
        resolve(onStop);
      });
    });
  };
  return { ran, ready, run, finish: () => finish(), stopped: () => stopped };
}

const busyPlain = { ...plain, claude: { ...plain.claude, busyReplies: true } };
const dig = (id) => toolUse(id, 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 30, y2: -58, z2: 0 });
const lastTurn = (call) => call.params.messages.at(-1).content;
const LATER = "Okay Alex, I'll work that in after this step.";

test('a note that can wait leaves the running tool alone and goes in with its result', async () => {
  const lines = [];
  const logged = [];
  const tool = digTool();
  const client = fakeClient([
    reply('tool_use', [dig('a'), toolUse('b', 'move_to', { x: 5, y: -59, z: 3 })]),
    reply('end_turn', [{ type: 'text', text: 'ADD' }]),
    reply('end_turn', [{ type: 'text', text: 'Tunnel done, and the spare stone is put away.' }])
  ]);
  const { brain, said, heard } = makeBrain({ client, config: busyPlain, runTool: tool.run, jobLog: { write: (line) => lines.push(line) }, log: (line) => logged.push(line) });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'put the spare stone in the chest after', true);
  await until(() => said.length === 1);
  assert.deepEqual(heard, [{ text: LATER, to: 'Alex' }]);
  await sleep(20);
  assert.equal(tool.stopped(), false);
  tool.finish();
  await job;

  assert.equal(client.calls.length, 3);
  const turn = lastTurn(client.calls[2]);
  assert.equal(turn[0].content, 'dug 74 blocks');
  assert.equal(turn[0].is_error, undefined);
  assert.match(turn[1].content, /^Not done, because a player just changed the instructions/);
  assert.match(turn[2].text, /^While you were working, Alex said: put the spare stone in the chest after\nWork this into the job you're doing now\./);
  assert.deepEqual(tool.ran.map((r) => r.name), ['dig_area']);
  const entry = lines[0].steps[0].tools[0];
  assert.equal(entry.ok, true);
  assert.equal('interrupted' in entry, false);
  assert.ok(logged.includes('[brain] the note from Alex waits for the running tool to finish'));
  assert.equal(said.at(-1), 'Tunnel done, and the spare stone is put away.');
});

test('the busy reply sorts a change by whether it can wait, and only UPDATE stops the tool', async () => {
  for (const [answer, waits] of [
    ['ADD', true],
    ['This is a rule for how to work, so the dig can finish first.\nADD', true],
    ['UPDATE', false],
    ['Digging on would go past the end of the tunnel.\nUPDATE', false]
  ]) {
    const lines = [];
    const tool = digTool();
    const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: answer }]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])]);
    const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
    const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
    await tool.ready;
    brain.enqueue('Alex', 'clodine one more thing about the tunnel');
    await until(() => said.length >= 1);
    await tick();
    assert.equal(tool.stopped(), !waits, answer);
    assert.equal(said[0], waits ? LATER : "Okay Alex, I'll work that in.", answer);
    tool.finish();
    await job;
    const entry = lines[0].steps[0].tools[0];
    assert.equal(entry.ok, waits, answer);
    assert.equal(entry.interrupted, waits ? undefined : true, answer);
    if (!waits) assert.match(lastTurn(client.calls[2])[0].content, /Stopped because a player just changed the instructions/);
    assert.match(client.calls[1].params.messages[0].content, /\n- UPDATE, if it changes the job you're doing now so that what you're doing this moment is wrong or wasted/);
    assert.match(client.calls[1].params.messages[0].content, /\n- ADD, if it adds to the job you're doing now but what you're doing this moment can finish first .*If unsure which, UPDATE\.\n/);
  }
  assert.equal(chatPart('It can wait, so ADD. Sure thing!'), 'Sure thing!');
});

test('a waiting note goes in the old way once the tool runs 90 seconds past it, and a second note joins it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logged = [];
  const tool = digTool();
  const client = fakeClient([
    reply('tool_use', [dig('a')]),
    reply('end_turn', [{ type: 'text', text: 'ADD' }]),
    reply('end_turn', [{ type: 'text', text: 'ADD' }]),
    reply('end_turn', [{ type: 'text', text: 'Okay.' }])
  ]);
  const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, log: (line) => logged.push(line) });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'refill the ore holes as you go');
  await until(() => said.length === 1);
  t.mock.timers.tick(60000);
  brain.enqueue('Steve', 'and light the tunnel after');
  await until(() => said.length === 2);
  assert.equal(said[1], "Okay Steve, I'll work that in after this step.");
  t.mock.timers.tick(29999);
  await tick();
  assert.equal(tool.stopped(), false);
  t.mock.timers.tick(1);
  await job;
  assert.equal(tool.stopped(), true);
  const turn = lastTurn(client.calls[3]);
  assert.match(turn[0].content, /Stopped early: stopped \(Stopped because a player just changed the instructions, see below\.\)$/);
  assert.deepEqual(
    turn.slice(1).map((b) => b.text.split('\n')[0]),
    ['While you were working, Alex said: refill the ore holes as you go', 'While you were working, Steve said: and light the tunnel after']
  );
  assert.ok(logged.includes('[brain] the tool ran 90s past a waiting note, stopping it'));
});

test('a waiting note lets a tool run on while its progress line keeps changing, and stops it once that stalls for 90 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const lines = [];
  const logged = [];
  const tool = digTool();
  let at = null;
  const watchTool = () => ({ stop: () => {}, report: () => '', progressAt: () => at });
  const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'ADD' }]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])]);
  const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, watchTool, jobLog: { write: (line) => lines.push(line) }, log: (line) => logged.push(line) });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'light the tunnel after');
  await until(() => said.length === 1);
  assert.equal(said[0], LATER);
  t.mock.timers.tick(30000);
  at = Date.now();
  t.mock.timers.tick(60000);
  await tick();
  assert.equal(tool.stopped(), false);
  assert.ok(logged.includes('[brain] the tool is still making progress, so the note waits on'));
  t.mock.timers.tick(10000);
  at = Date.now();
  t.mock.timers.tick(20000);
  await tick();
  assert.equal(tool.stopped(), false);
  t.mock.timers.tick(69999);
  await tick();
  assert.equal(tool.stopped(), false);
  t.mock.timers.tick(1);
  await job;
  assert.equal(tool.stopped(), true);
  assert.ok(logged.includes('[brain] the tool ran 90s past a waiting note without progress, stopping it'));
  assert.match(lastTurn(client.calls[2])[0].content, /Stopped early: stopped \(Stopped because a player just changed the instructions, see below\.\)$/);
  assert.equal(lines[0].steps[0].tools[0].interrupted, true);
});

test('a tool that keeps making progress past a waiting note runs to its own ceiling, and the note goes in then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const tool = digTool();
  const watchTool = () => ({ stop: () => {}, report: () => '', progressAt: () => Date.now() });
  const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'ADD' }]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])]);
  const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, watchTool });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'light the tunnel after');
  await until(() => said.length === 1);
  for (let s = 0; s < 1799; s += 90) {
    t.mock.timers.tick(Math.min(90000, 1799000 - s * 1000));
    await tick();
  }
  assert.equal(tool.stopped(), false);
  t.mock.timers.tick(1000);
  await job;
  assert.equal(tool.stopped(), true);
  const turn = lastTurn(client.calls[2]);
  assert.match(turn[0].content, /\(Stopped because one call can run for at most 30 minutes\.\)$/);
  assert.match(turn[1].text, /^While you were working, Alex said: light the tunnel after\n/);
});

test('a change that cannot wait still stops a tool that is making progress at once', async () => {
  const tool = digTool();
  const watchTool = () => ({ stop: () => {}, report: () => '', progressAt: () => Date.now() });
  const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'UPDATE' }]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])]);
  const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, watchTool });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'stop at the lava instead');
  await job;
  assert.equal(tool.stopped(), true);
  assert.equal(said[0], "Okay Alex, I'll work that in.");
});

test('a tool that finished as the 90 second stop landed keeps its result, and one cut short does not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [result, finished] of [
    [{ ok: true, message: 'placed 199, skipped 0, failed 0, took down 7 scaffolding blocks' }, true],
    [{ ok: true, message: 'placed 120, skipped 0, failed 0. Stopped early: stopped' }, false],
    [{ ok: false, message: 'placed 0, skipped 0, failed 3' }, false]
  ]) {
    const lines = [];
    const logged = [];
    const tool = digTool(result);
    const client = fakeClient([
      reply('tool_use', [dig('a'), toolUse('b', 'move_to', { x: 5, y: -59, z: 3 })]),
      reply('end_turn', [{ type: 'text', text: 'ADD' }]),
      reply('end_turn', [{ type: 'text', text: 'Okay.' }])
    ]);
    const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, jobLog: { write: (line) => lines.push(line) }, log: (line) => logged.push(line) });
    const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
    await tool.ready;
    brain.enqueue('Alex', 'light the tunnel after');
    await until(() => said.length === 1);
    t.mock.timers.tick(90000);
    await job;
    const name = result.message;
    assert.equal(tool.stopped(), true, name);
    const turn = lastTurn(client.calls[2]);
    assert.equal(turn[0].content, finished ? result.message : `${result.message} (Stopped because a player just changed the instructions, see below.)`, name);
    assert.equal(turn[0].is_error, result.ok ? undefined : true, name);
    assert.match(turn[1].content, /^Not done, because a player just changed the instructions/, name);
    assert.match(turn[2].text, /^While you were working, Alex said: light the tunnel after\n/, name);
    assert.deepEqual(tool.ran.map((r) => r.name), ['dig_area'], name);
    const entry = lines[0].steps[0].tools[0];
    assert.equal(entry.ok, finished, name);
    assert.equal(entry.interrupted, finished ? undefined : true, name);
    assert.equal(logged.includes('[brain] the tool had finished its work when the change stopped it'), finished, name);
  }
});

test('a hold keeps a waiting note for the step after it', async () => {
  const lines = [];
  const tool = digTool();
  const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'ADD' }]), reply('end_turn', [{ type: 'text', text: 'Back to the tunnel.' }])]);
  const { brain, said } = makeBrain({ client, config: busyPlain, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', 'put the spare stone in the chest after');
  await until(() => said.length === 1);
  await brain.pause('danger');
  assert.equal(tool.stopped(), true);
  brain.resume('danger', 'You ate bread.');
  await job;
  const sent = JSON.stringify(client.calls[2].params.messages);
  assert.match(sent, /Alex said: put the spare stone in the chest after/);
  assert.match(sent, /You ate bread\./);
  assert.equal(lines[0].steps[0].tools[0].interrupted, true);
  assert.deepEqual(said, [LATER, 'Back to the tunnel.']);
});

test('a waiting note goes with the queue on a stop, and becomes a request of its own when the job ends without it', async () => {
  const lines = [];
  const tool = digTool();
  const client = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'ADD' }])]);
  const stopped = makeBrain({ client, config: busyPlain, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = stopped.brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  stopped.brain.enqueue('Alex', 'put the spare stone in the chest after');
  await until(() => stopped.said.length === 1);
  stopped.brain.stop();
  await job;
  assert.equal(stopped.brain.busy, false);
  assert.equal(stopped.brain.queue.length, 0);
  assert.equal(client.calls.length, 2);
  assert.equal(lines[0].end, 'stop');
  assert.equal(lines[0].steps[0].tools[0].interrupted, true);

  const short = digTool();
  const later = fakeClient([reply('tool_use', [dig('a')]), reply('end_turn', [{ type: 'text', text: 'ADD' }]), reply('end_turn', [{ type: 'text', text: 'Done.' }])]);
  const config = { ...busyPlain, limits: { ...busyPlain.limits, maxSteps: 1 } };
  const ended = makeBrain({ client: later, config, runTool: short.run });
  const first = ended.brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await short.ready;
  ended.brain.enqueue('Alex', 'put the spare stone in the chest after');
  await until(() => ended.said.length === 1);
  short.finish();
  await first;
  while (ended.brain.busy) await tick();
  assert.match(later.calls[2].params.messages[0].content, /Request from Alex: put the spare stone in the chest after/);
});

test('a waiting note survives a handover to a bigger model', async () => {
  for (const config of [routed, unstrict]) {
    const tool = digTool();
    const client = fakeClient([
      reply('tool_use', [dig('a')]),
      reply('end_turn', [{ type: 'text', text: 'ADD' }]),
      reply('tool_use', [toolUse('z', 'escalate', { to: 'normal' })]),
      reply('end_turn', [{ type: 'text', text: 'Tunnel done, and the spare stone is put away.' }])
    ]);
    const { brain, said } = makeBrain({ client, config: { ...config, claude: { ...config.claude, busyReplies: true } }, runTool: tool.run });
    const job = brain.start({ player: 'Steve', text: 'the next tunnel needs doing' });
    await tool.ready;
    brain.enqueue('Alex', 'put the spare stone in the chest after');
    await until(() => said.length === 1);
    assert.equal(said[0], LATER);
    tool.finish();
    await job;
    const name = config === routed ? 'starts over' : 'same conversation';
    assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'], name);
    assert.match(JSON.stringify(client.calls[3].params.messages), /Alex said: put the spare stone in the chest after/, name);
    assert.equal(said.at(-1), 'Tunnel done, and the spare stone is put away.', name);
  }
});

test('a lasting rule that waits is still saved before the job finishes, under its sender', async () => {
  const live = 'clodine, in your strip mine operation, never deviate from y -59.';
  for (const busyAnswer of ['ADD', 'Got it, I will stay at y -59 from now on.']) {
    const tool = digTool();
    const client = fakeClient([
      reply('tool_use', [dig('a')]),
      reply('end_turn', [{ type: 'text', text: busyAnswer }]),
      reply('tool_use', [toolUse('b', 'finish', { message: 'Tunnel done.' })]),
      reply('tool_use', [toolUse('c', 'remember', { name: 'strip mine', note: 'Standing order from Alex: stay at y -59 in the strip mine.' }), toolUse('d', 'finish', { message: 'Tunnel done, and the y -59 rule is saved.' })])
    ]);
    const { brain, said } = makeBrain({ client, config: withAdmins(busyPlain), runTool: tool.run });
    const job = brain.start({ player: 'Steve', text: 'continue the strip mine' });
    await tool.ready;
    brain.enqueue('Alex', live);
    await until(() => said.length === 1);
    await tick();
    assert.equal(tool.stopped(), false, busyAnswer);
    tool.finish();
    await job;
    assert.deepEqual(said, [LATER, 'Tunnel done, and the y -59 rule is saved.'], busyAnswer);
    assert.match(lastTurn(client.calls[2]).at(-1).text, /Alex said: clodine, in your strip mine operation.*\nThis is a lasting rule: .*save it with remember before you finish\.$/s);
    assert.match(lastTurn(client.calls[3])[0].content, /^Not done: Alex gave you a lasting rule/);
    assert.deepEqual(tool.ran.map((r) => [r.name, r.requester]), [['dig_area', undefined], ['remember', 'Alex']], busyAnswer);
  }
});

test('a small build_structure patch runs on the model that asked for it, and a bigger build or a house still goes to the main model', async () => {
  const origin = { x: 0, y: -59, z: 0 };
  const holes = Array.from({ length: 6 }, (_, i) => ({ dx: i, dy: 0, dz: 0, block: 'cobbled_deepslate' }));
  const cases = [
    ['six blocks', 'build_structure', { origin, blocks: holes }, false],
    ['sixty blocks', 'build_structure', { origin, parts: [{ shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 4, dy: 2, dz: 3 }, block: 'cobbled_deepslate' }] }, true],
    ['a house', 'build_house', { x: 0, y: 64, z: 0 }, true],
    ['a copy', 'copy_structure', { name: 'hut', x: 10, y: 64, z: 0 }, true]
  ];
  for (const [what, name, input, handed] of cases) {
    const lines = [];
    const logged = [];
    const client = fakeClient([
      reply('tool_use', [toolUse('z', 'escalate', { to: 'normal' })]),
      reply('tool_use', [toolUse('a', name, input)]),
      ...(handed ? [reply('tool_use', [toolUse('b', name, input)])] : []),
      reply('end_turn', [{ type: 'text', text: 'Filled.' }])
    ]);
    const { brain, toolCalls } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) }, log: (line) => logged.push(line) });
    await brain.start({ player: 'Steve', text: 'Clodine the ore holes need filling' });
    const models = client.calls.map((c) => c.params.model);
    assert.deepEqual(toolCalls.map((t) => t.name), [name], what);
    if (handed) {
      assert.deepEqual(models, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'], what);
      assert.ok(logged.includes('[brain] this needs building, handing it to claude-opus-5-5'), what);
      assert.equal(lines[0].model, 'claude-opus-5-5', what);
    } else {
      assert.deepEqual(models, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'], what);
      assert.deepEqual([lines[0].tier, lines[0].model, lines[0].effort], ['normal', 'claude-sonnet-5-5', 'medium'], what);
      assert.ok(!logged.includes('[brain] this job is a build now'), what);
    }
  }
});

test('notes a replaced job never got to, a lasting rule among them, become requests after the job that took its place', async () => {
  const lines = [];
  const rule = 'clodine from now on put deepslate in the ore holes';
  const tool = digTool();
  const client = fakeClient([
    reply('tool_use', [dig('a')]),
    reply('end_turn', [{ type: 'text', text: 'ADD' }]),
    reply('end_turn', [{ type: 'text', text: 'ADD' }]),
    reply('end_turn', [{ type: 'text', text: 'NOW' }]),
    reply('end_turn', [{ type: 'text', text: 'On my way.' }]),
    reply('tool_use', [toolUse('b', 'remember', { name: 'ore holes', note: 'Standing order from Alex: put deepslate in the ore holes.' }), toolUse('c', 'finish', { message: 'Saved.' })]),
    reply('end_turn', [{ type: 'text', text: 'Stone put away.' }])
  ]);
  const { brain, said } = makeBrain({ client, config: withAdmins(busyPlain), runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel' });
  await tool.ready;
  brain.enqueue('Alex', rule);
  await until(() => said.length === 1);
  brain.enqueue('Alex', 'put the spare stone in the chest after');
  await until(() => said.length === 2);
  brain.enqueue('Steve', 'come here now');
  await job;
  await until(() => said.includes('Stone put away.'));
  while (brain.busy) await tick();
  assert.deepEqual(
    client.calls.slice(4).map((c) => c.params.messages[0].content.match(/Request from (.*)/)[1]),
    ['Steve: come here now', `Alex: ${rule}`, 'Alex: put the spare stone in the chest after']
  );
  assert.deepEqual(lines.map((l) => [l.player, l.end]), [['Steve', 'replaced'], ['Steve', 'done'], ['Alex', 'done'], ['Alex', 'done']]);
  // The rule's job is its sender's, so remember saves it as theirs.
  assert.deepEqual(tool.ran.map((r) => [r.name, r.requester]), [['dig_area', undefined], ['remember', undefined]]);
  assert.deepEqual(said, [LATER, LATER, 'Okay Steve, switching to that.', 'On my way.', 'Saved.', 'Stone put away.']);
});

test('an obvious work order starts on the everyday model and goes on like a handed-over job', async () => {
  const lines = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'mine')]),
    reply('tool_use', [toolUse('b', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('tool_use', [toolUse('c', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain, toolCalls } = makeBrain({ client, config: routed, jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine strip mine the next tunnel at y -59' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  const first = textOf(client.calls[0].params.messages[0].content);
  assert.match(first, /Request from Steve: Clodine strip mine the next tunnel at y -59/);
  assert.doesNotMatch(first, /sort this request|handed to you/);
  assert.deepEqual(toolCalls.map((t) => t.name), ['mine', 'build_house']);
  assert.equal(lines[0].tier, 'complex');

  // escalate is not this model's to call.
  const own = fakeClient([reply('tool_use', [toolUse('a', 'escalate', { to: 'complex' })]), reply('end_turn', [{ type: 'text', text: 'Digging.' }])]);
  await makeBrain({ client: own, config: routed }).brain.start({ player: 'Steve', text: 'Clodine dig out the cellar' });
  assert.deepEqual(own.calls.map((c) => c.params.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.equal(lastTurn(own.calls[1])[0].content, 'Not done: this job is yours to do. Carry on with it yourself.');

  // A refused step goes to the other bigger model, as it does on a handed-over job.
  const refused = fakeClient([refusal('cyber'), reply('end_turn', [{ type: 'text', text: 'Dug.' }])]);
  await makeBrain({ client: refused, config: routed }).brain.start({ player: 'Steve', text: 'Clodine dig out the cellar' });
  assert.deepEqual(refused.calls.map((c) => c.params.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('requests like the live ones start on the everyday model only when they are plain work, or a go-ahead after work', () => {
  const { brain } = makeBrain({ client: fakeClient([]), config: routed });
  const work = { player: 'Steve', text: 'Clodine strip mine', self: false, end: 'done', at: Date.now(), tier: 'normal' };
  const chat = { ...work, text: 'Clodine how are you', tier: 'simple' };
  const free = { ...work, player: null, text: null, self: true };
  for (const [text, last, tier] of [
    ["clodine why do you keep saying you can't help with that one", work, 'simple'],
    ['clodine start now', work, 'normal'],
    ['clodine start now', chat, 'simple'],
    ['clodine the next strip mine tunnel should go east starting at Z-100. stay at Y-59, dig only Y-58 Y-59 unless you find ores along the way. execute.', chat, 'normal'],
    ['clodine the limits of the tunnels are X10 and X50, dig east-west only within those X parameters. continue the next tunnel.', work, 'normal'],
    ['clodine i gave you three pickaxes, resume strip mine.', null, 'normal'],
    ['clodine proceed with the strip mine until told to stop', work, 'normal'],
    ['clodine without forgetting about the current tunnel, there seems to be a tunnel which is incomplete, can you tell which one it is?', work, 'simple'],
    ['clodine proceed', work, 'normal'],
    ['clodine proceed', chat, 'simple'],
    ['clodine carry on', free, 'simple'],
    ['clodine keep going', null, 'simple'],
    ['clodine the tunnel at Z-100 is not complete, come back and finish it', work, 'simple'],
    ['clodine you can mine the ores, the key is replacing the empty spaces with deepslate', work, 'normal'],
    ['clodine how are you feeling? emotionally.', work, 'simple'],
    ['clodine build a hut by the tunnel', work, 'complex']
  ]) {
    brain.lastJob = last;
    assert.equal(brain.firstTier({ player: 'Steve', text }), tier, text);
  }
  brain.lastJob = work;
  assert.equal(brain.firstTier({ player: 'Steve', text: 'Clodine come here', reflex: 'come' }), 'simple');
  assert.equal(brain.firstTier({ self: true }), 'normal');
  const off = makeBrain({ client: fakeClient([]), config: plain });
  assert.equal(off.brain.firstTier({ player: 'Steve', text: 'Clodine strip mine' }), 'complex');
});

test('fixing a build, tunnel work, sorting into chests and a go-ahead after a bigger job skip the quick model, and chat and body orders do not', () => {
  const { brain } = makeBrain({ client: fakeClient([]), config: routed });
  const build = { player: 'Steve', text: 'Clodine build a gate house', self: false, end: 'done', at: Date.now(), tier: 'complex' };
  const chat = { ...build, text: 'Clodine hi', tier: 'simple' };
  for (const [text, last, tier] of [
    ['clodine there are also gaping holes in your original building, can you check and patch those holes', chat, 'complex'],
    ['clodine nice work on the attic. add some windows to the attic as well', chat, 'complex'],
    ['clodine the top cobble stones missing from this gatehouse.', chat, 'complex'],
    ['clodine resume', build, 'complex'],
    ['clodine i apologise. resume', build, 'complex'],
    ['clodine yes', build, 'complex'],
    ['clodine go ahead', chat, 'simple'],
    ['clodine continue the tunnel south until you reach Z-5312', chat, 'normal'],
    ['clodine there are still tunnels missing between Z-5420 and Z-5402 dig those out', chat, 'normal'],
    ['clodine the chest by the house is still full of stuff, please sort them into the storage room', chat, 'normal'],
    ['clodine follow me into the tunnel', chat, 'simple'],
    ['clodine come here and put your things in the chest', chat, 'simple'],
    ['clodine can you see the holes in the wall?', chat, 'simple'],
    ['clodine this is perfect. i loved the furniture you put in the first floor. good job.', chat, 'simple'],
    ['clodine from now on, always fill the holes you leave in the wall', chat, 'simple'],
    ['clodine good job', build, 'simple']
  ]) {
    brain.lastJob = last;
    assert.equal(brain.firstTier({ player: 'Steve', text }), tier, text);
  }
});

test('a job remembers the tier it ended on, so a bare continue can follow work', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'escalate', { to: 'normal' })]), reply('end_turn', [{ type: 'text', text: 'Done.' }]), reply('end_turn', [{ type: 'text', text: 'Carrying on.' }])]);
  const { brain } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine the ore holes need filling' });
  assert.equal(brain.lastJob.tier, 'normal');
  await brain.start({ player: 'Steve', text: 'clodine carry on' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
});

test('a lean cure also clears the recent chat the job carried, and keeps what came after', async () => {
  const { ChatHistory } = await import('../src/chat.js');
  for (const [first, cured] of [
    [refusal(null), true],
    [refusal('general_harms'), false]
  ]) {
    const history = new ChatHistory(20);
    history.add('Alex', 'clodine say something odd', Date.now() - 60000);
    history.add('Bob', 'a line after the job began', Date.now() + 60000);
    const client = fakeClient([first, reply('end_turn', [{ type: 'text', text: 'Mined.' }])]);
    const { brain, said } = makeBrain({ client, config: plain, snapshot: () => 'Position: 1 2 3\n\nRecent chat:\n<Alex> clodine say something odd', forgetChat: (before) => history.forget(before) });
    await brain.start({ player: 'Steve', text: 'mine some stone' });
    assert.deepEqual(said, ['Mined.']);
    assert.deepEqual(history.list().map((m) => m.username), cured ? ['Bob'] : ['Alex', 'Bob']);
  }
});

test("an admin's correction goes with another player's job, and one said before carries how often", async () => {
  const config = { ...plain, admins: ['Alex'] };
  {
    const lessons = lessonStore();
    let brain;
    const client = reviewClient([reply('tool_use', [toolUse('a', 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 9, y2: -58, z2: 0 })]), reply('end_turn', [{ type: 'text', text: 'Dug it.' }])], lessonReply('NONE'));
    ({ brain } = makeBrain({
      client,
      config,
      lessons,
      runTool: async () => {
        brain.correct('Alex', 'you drifted to y -58 again');
        return { ok: true, message: 'dug 20 blocks' };
      }
    }));
    brain.correct('Steve', 'you are at -58, go back to -59');
    await brain.start({ player: 'Steve', text: 'Clodine dig the next tunnel' });
    await until(() => client.reviews.length === 1);
    assert.match(
      client.reviews[0].messages[0].content,
      /\nPlayer messages about it: "you drifted to y -58 again"\nPlayers have said this or something like it 2 times in the last few hours\.\n<\/job>$/
    );
  }
  {
    const client = reviewClient([reply('tool_use', [toolUse('a', 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 9, y2: -58, z2: 0 })]), reply('end_turn', [{ type: 'text', text: 'Dug it.' }])], lessonReply('NONE'));
    const { brain } = makeBrain({ client, config, lessons: lessonStore(), runTool: async () => ({ ok: true, message: 'dug 20 blocks' }) });
    brain.correctionWindowMs = 5000;
    await brain.start({ player: 'Steve', text: 'Clodine dig the next tunnel' });
    assert.equal(brain.waiting.size, 1);
    brain.correct('Alex', 'you missed a spot at the end');
    await until(() => client.reviews.length === 1);
    assert.match(client.reviews[0].messages[0].content, /\nPlayer messages about it: "you missed a spot at the end"\n<\/job>$/);
    assert.equal(brain.waiting.size, 0);
  }
});

test('a job whose only action was stopped from outside counts for no lesson, and a correction still has it looked over', async () => {
  const lessons = lessonStore();
  const shown = lessons.add('Dig a tunnel one layer at a time with dig_area and check the floor after.', { tools: ['dig_area'], request: 'dig the next tunnel' });
  for (const corrected of [false, true]) {
    let brain;
    const client = reviewClient([reply('tool_use', [toolUse('a', 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 9, y2: -58, z2: 0 })]), reply('end_turn', [{ type: 'text', text: 'Okay.' }])], lessonReply('NONE'));
    ({ brain } = makeBrain({
      client,
      config: plain,
      lessons,
      runTool: (name, input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, message: 'dug 3 blocks. Stopped early: stopped' }));
          brain.addToJob(brain.current, 'Steve', 'and one more tunnel after that');
        })
    }));
    brain.correctionWindowMs = 20;
    await brain.start({ player: 'Steve', text: 'Clodine dig the next tunnel' });
    if (corrected) brain.correct('Steve', 'you are at -58 again');
    await sleep(60);
    assert.equal(shown.uses, corrected ? 2 : 1);
    assert.deepEqual([shown.helped, shown.failed], [0, 0], `corrected: ${corrected}`);
    assert.equal(client.reviews.length, corrected ? 1 : 0);
  }
});

test('a routine done in three earlier jobs is pointed out once, in the next job like it', async () => {
  const earlier = [1, 2, 3].map((i) => ({
    start: `2026-11-15T0${i}:00:00.000Z`,
    player: 'Steve',
    request: 'dig a tunnel',
    freeTime: false,
    end: 'done',
    steps: [{ tools: ['move_to', 'dig_area', 'store_items', 'finish'].map((name) => ({ name, ok: true, ms: 5 })) }]
  }));
  const lines = [...earlier];
  const jobLog = { write: (line) => lines.push(line), recent: () => lines };
  const skills = { skills: [], schemas: new Map(['move_to', 'dig_area', 'store_items'].map((name) => [name, {}])) };
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'move_to', { x: 1, y: -59, z: 1 }), toolUse('b', 'dig_area', { x1: 0, y1: -59, z1: 0, x2: 9, y2: -58, z2: 0 }), toolUse('c', 'store_items', { items: [{ item: 'cobblestone' }] })]),
    reply('end_turn', [{ type: 'text', text: 'Dug and stored.' }]),
    reply('end_turn', [{ type: 'text', text: 'Fine, thanks.' }]),
    reply('end_turn', [{ type: 'text', text: 'On it.' }]),
    reply('end_turn', [{ type: 'text', text: 'On it again.' }])
  ]);
  const { brain } = makeBrain({ client, config: plain, jobLog, skills });
  const hint = /\n\nYou did move_to > dig_area > store_items in earlier jobs like this too; skill save can make it one call\.$/;
  await brain.start({ player: 'Steve', text: 'Clodine dig the next tunnel' });
  assert.doesNotMatch(client.calls[0].params.messages[0].content, /skill save can make it/);
  await brain.start({ player: 'Steve', text: 'Clodine how are you' });
  assert.doesNotMatch(client.calls[2].params.messages[0].content, /skill save can make it/);
  await brain.start({ player: 'Steve', text: 'Clodine dig another tunnel' });
  assert.match(client.calls[3].params.messages[0].content, hint);
  await brain.start({ player: 'Steve', text: 'Clodine dig one more tunnel' });
  assert.doesNotMatch(client.calls[4].params.messages[0].content, /skill save can make it/);
});

const idleConfig = { ...plain, idle: { freeTimeSeconds: 60, freeTimeSteps: 4 } };
const okay = () => reply('end_turn', [{ type: 'text', text: 'Okay.' }]);
const settled = async (brain) => {
  while (brain.busy) await tick();
};
// The first call runs until it's stopped; any other call answers at once.
function blockingTool() {
  const ran = [];
  let started;
  const ready = new Promise((r) => (started = r));
  const run = (name, input, signal) => {
    ran.push(name);
    if (ran.length > 1) return Promise.resolve({ ok: true, message: `${name} done` });
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' })));
  };
  return { ran, ready, run };
}

test('after a death a trip back goes first on its own, and the request she died doing comes back after it', async () => {
  const lines = [];
  const tool = blockingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'dig_area', { x1: 0, y1: -40, z1: 0, x2: 20, y2: -39, z2: 0 })]), reply('end_turn', [{ type: 'text', text: 'Got my things back.' }]), reply('end_turn', [{ type: 'text', text: 'Tunnel done.' }])]);
  const { brain, heard } = makeBrain({ client, config: idleConfig, runTool: tool.run, jobLog: { write: (line) => lines.push(line) } });
  const job = brain.start({ player: 'Steve', text: 'dig the next tunnel', whisper: true });
  await tool.ready;
  brain.died({ pos: { x: 10.5, y: -40, z: 3.2 }, dimension: 'minecraft:overworld', at: Date.now() });
  brain.abortCurrent('death');
  brain.respawned({ cause: 'Clodine tried to swim in lava' }, 'minecraft:overworld');
  await job;
  await settled(brain);

  assert.equal(client.calls.length, 3);
  const trip = textOf(client.calls[1].params.messages[0].content);
  assert.match(trip, /You died \d+ seconds? ago at 10 -40 3 in the overworld\. The death message said: "Clodine tried to swim in lava"\./);
  assert.match(trip, /vanishes 5 minutes after you died, so you have about \d+ (seconds|minutes) left to get it\./);
  assert.match(trip, /You were doing Steve's request "dig the next tunnel" when you died\. It comes back as a job of its own once this one ends/);
  assert.match(trip, /don't walk back into it/);
  assert.doesNotMatch(trip, /respawned in/);
  const again = textOf(client.calls[2].params.messages[0].content);
  assert.match(again, /Request from Steve \(whispered\): dig the next tunnel\n\nYou died partway through this request \("Clodine tried to swim in lava"\) and have respawned since/);
  assert.deepEqual(lines.map((l) => [l.end, l.freeTime, l.recovery ?? false, l.player]), [['death', false, false, 'Steve'], ['done', true, true, null], ['done', false, false, 'Steve']]);
  assert.deepEqual(heard.at(-1), { text: 'Tunnel done.', to: 'Steve' });
});

test('the trip back runs on the everyday model, and says when her things are gone or she is in another dimension', async () => {
  const client = fakeClient([okay()]);
  const { brain } = makeBrain({ client, config: routedIdle });
  brain.died({ pos: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:the_nether', at: Date.now() });
  brain.respawned({}, 'minecraft:overworld');
  await settled(brain);
  assert.equal(client.calls[0].params.model, 'claude-sonnet-5-5');
  const trip = textOf(client.calls[0].params.messages[0].content);
  assert.match(trip, /in the nether\. You respawned in the overworld\./);
  assert.match(trip, /You were not doing a job for a player when you died\./);
  assert.doesNotMatch(trip, /death message/);
  assert.match(deathText({ pos: { x: 1, y: 2, z: 3 }, at: 0 }, 6 * 60000), /^You died 6 minutes ago at 1 2 3\. .*so it is most likely gone\.$/);
});

test('dying again near the same spot within a minute of a trip back leaves the things, and a later or far death does not', async () => {
  const client = fakeClient(() => okay());
  const { brain, said } = makeBrain({ client, config: idleConfig });
  const t0 = Date.now();
  const die = async (x, at) => {
    brain.died({ pos: { x, y: 64, z: 0 }, dimension: 'overworld', at });
    brain.respawned({}, 'overworld', at + 1000);
    await settled(brain);
  };
  await die(0, t0);
  assert.equal(client.calls.length, 1);
  await die(10, t0 + 30000);
  assert.equal(client.calls.length, 1);
  assert.equal(said.at(-1), "I died in the same spot again, so I'm leaving my things there.");
  await die(200, t0 + 40000);
  assert.equal(client.calls.length, 2);
  await die(205, t0 + 40000 + 61000);
  assert.equal(client.calls.length, 3);
});

test('a player request already waiting goes first and hears about the death, with no trip of its own', async () => {
  const client = fakeClient([okay()]);
  const { brain } = makeBrain({ client, config: idleConfig });
  brain.pause('offline');
  brain.enqueue('Alex', 'come here');
  brain.died({ pos: { x: 4, y: 70, z: -8 }, at: Date.now() });
  brain.respawned({ cause: 'Clodine was slain by Zombie' });
  assert.equal(brain.queue.length, 1);
  brain.resume('offline');
  await settled(brain);
  assert.equal(client.calls.length, 1);
  const first = textOf(client.calls[0].params.messages[0].content);
  assert.match(first, /Request from Alex: come here\n\nYou died \d+ seconds? ago at 4 70 -8\. The death message said: "Clodine was slain by Zombie"\..* Do what was asked first\./);
});

test('a player cutting in on the trip back hears about the death, and only one trip waits at a time', async () => {
  const tool = blockingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'move_to', { x: 4, y: 70, z: -8 })]), okay()]);
  const { brain } = makeBrain({ client, config: idleConfig, runTool: tool.run });
  brain.died({ pos: { x: 4, y: 70, z: -8 }, at: Date.now() });
  brain.respawned({});
  await tool.ready;
  brain.enqueue('Alex', 'come here');
  await settled(brain);
  assert.equal(client.calls.length, 2);
  assert.match(textOf(client.calls[1].params.messages[0].content), /Request from Alex: come here\n\nYou died .* Do what was asked first\./);

  const held = makeBrain({ client: fakeClient([]), config: idleConfig }).brain;
  held.pause('offline');
  held.died({ pos: { x: 0, y: 64, z: 0 }, at: Date.now() });
  held.respawned({});
  held.died({ pos: { x: 300, y: 64, z: 0 }, at: Date.now() });
  held.respawned({});
  assert.deepEqual(held.queue.map((r) => r.recovery?.pos.x), [300]);
});

test('a request she dies doing a second time is not picked up again', async () => {
  const tool = blockingTool();
  const client = fakeClient([reply('tool_use', [toolUse('a', 'mine')]), okay()]);
  const { brain } = makeBrain({ client, config: idleConfig, runTool: tool.run });
  const job = brain.start({ player: 'Steve', text: 'mine by the lava', resumed: true });
  await tool.ready;
  brain.died({ pos: { x: 0, y: 12, z: 0 }, at: Date.now() });
  brain.abortCurrent('death');
  brain.respawned({});
  await job;
  await settled(brain);
  assert.equal(client.calls.length, 2);
  assert.match(textOf(client.calls[1].params.messages[0].content), /You were doing Steve's request "mine by the lava" when you died, and you had died doing it once before, so it won't be picked up again/);
  assert.equal(brain.queue.length, 0);
});


// A tool that hands back pictures, the way preview_structure and view_area do.
const PIXELS = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pictureTool = (labels) => async (name) => ({ ok: true, message: `${name} drew it`, images: labels.map((label) => ({ media_type: 'image/png', data: PIXELS, label })) });

test('a tool that returns pictures sends them in its result, after the text, each with its label', async () => {
  const lines = [];
  const logged = [];
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'preview_structure', { origin: { x: 0, y: 64, z: 0 }, parts: [] })]),
    reply('end_turn', [{ type: 'text', text: 'Looks plain, I will add a roof.' }])
  ]);
  const { brain } = makeBrain({ client, config: plain, runTool: pictureTool(['south-east', 'top']), jobLog: { write: (line) => lines.push(line) }, log: (line) => logged.push(line) });
  await brain.start({ player: 'Steve', text: 'Clodine build a hut' });
  const result = client.calls[1].params.messages.at(-1).content[0];
  assert.deepEqual(result, {
    type: 'tool_result',
    tool_use_id: 'a',
    content: [
      { type: 'text', text: 'preview_structure drew it' },
      { type: 'text', text: 'Picture 1: south-east' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXELS } },
      { type: 'text', text: 'Picture 2: top' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXELS } }
    ]
  });
  assert.deepEqual(lines[0].steps[0].tools[0].images, { count: 2, labels: ['south-east', 'top'] });
  assert.ok(!JSON.stringify(lines).includes(PIXELS));
  assert.ok(!logged.join('\n').includes(PIXELS));
  assert.ok(logged.includes('[tool] -> ok: preview_structure drew it (+2 pictures: south-east, top)'));
});

test('a failed tool sends its text only, without pictures, and looking is no build', async () => {
  const client = fakeClient([reply('tool_use', [toolUse('a', 'view_area', { x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 })]), reply('end_turn', [])]);
  const runTool = async () => ({ ok: false, message: 'part of the box is not loaded', images: [{ media_type: 'image/png', data: PIXELS, label: 'top' }] });
  const logged = [];
  const { brain } = makeBrain({ client, config: plain, runTool, log: (line) => logged.push(line) });
  await brain.start({ player: 'Steve', text: 'Clodine look at the house' });
  const result = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(typeof result.content, 'string');
  assert.match(result.content, /^part of the box is not loaded/);
  assert.equal(result.is_error, true);
  assert.ok(!logged.includes('[brain] this job is a build now'));
});

test('only the first 12 picture results in a job carry pictures, and the conversation is only added to', async () => {
  const look = (i) => reply('tool_use', [{ type: 'thinking', thinking: `thought ${i}`, signature: `sig${i}` }, toolUse(`t${i}`, 'view_area', { x1: 0, y1: 64, z1: 0, x2: 4, y2: 68, z2: 4 })]);
  const client = fakeClient([...Array.from({ length: 13 }, (_, i) => look(i)), reply('end_turn', [{ type: 'text', text: 'Seen it.' }])]);
  const lines = [];
  const { brain, toolCalls } = makeBrain({ client, config: plain, runTool: pictureTool(['top']), jobLog: { write: (line) => lines.push(line) } });
  await brain.start({ player: 'Steve', text: 'Clodine look around the house' });
  assert.equal(client.calls.length, 14);
  const last = client.calls[13].params.messages;
  const results = last.filter((m) => m.role === 'user' && Array.isArray(m.content)).map((m) => m.content[0]);
  assert.equal(results.length, 13);
  assert.ok(results.slice(0, 12).every((r) => Array.isArray(r.content) && r.content[2].type === 'image'));
  assert.equal(typeof results[12].content, 'string');
  assert.match(results[12].content, /\n\(No pictures with this one: this job has reached its limit of 12 results with pictures\. A new request starts a fresh count\.\)$/);
  assert.equal(results[12].is_error, undefined);
  // Every request starts with the one before it, unchanged, thinking and pictures included.
  for (let i = 1; i < client.calls.length; i++) {
    const before = client.calls[i - 1].params.messages;
    assert.deepEqual(client.calls[i].params.messages.slice(0, before.length), before);
  }
  assert.equal(toolCalls.length, 0);
  assert.equal(lines[0].steps[12].tools[0].images, undefined);
  assert.deepEqual(lines[0].steps[11].tools[0].images, { count: 1, labels: ['top'] });
});

test('view_area is no build, a build job that looks afterwards keeps its build budget, and design_guide is build work', async () => {
  const config = { ...plain, limits: { ...plain.limits, maxSteps: 3, buildMaxSteps: 6 } };
  const wall = { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 6, dy: 3, dz: 6 }, block: 'oak_planks' }] };
  const look = toolUse('v', 'view_area', { x1: 0, y1: 64, z1: 0, x2: 6, y2: 67, z2: 6 });
  const built = fakeClient((n) => reply('tool_use', [n === 1 ? toolUse('b', 'build_structure', wall) : { ...look, id: `v${n}` }]));
  const logged = [];
  const job = makeBrain({ client: built, config, runTool: pictureTool(['south-east']), log: (line) => logged.push(line) });
  await job.brain.start({ player: 'Steve', text: 'Clodine make it look nice' });
  assert.equal(built.calls.length, 6);
  assert.equal(logged.filter((l) => l === '[brain] this job is a build now').length, 1);

  const looked = fakeClient((n) => reply('tool_use', [{ ...look, id: `v${n}` }]));
  const quick = makeBrain({ client: looked, config, runTool: pictureTool(['south-east']) });
  await quick.brain.start({ player: 'Steve', text: 'Clodine look at that' });
  assert.equal(looked.calls.length, 3);

  // Asking for the design guide is build work from that step on.
  const guided = fakeClient((n) => reply('tool_use', [toolUse(`g${n}`, 'design_guide', { structure: 'cabin' })]));
  const guide = makeBrain({ client: guided, config, log: (line) => logged.push(line) });
  await guide.brain.start({ player: 'Steve', text: 'Clodine something nice please' });
  assert.equal(guided.calls.length, 6);
  assert.equal(logged.filter((l) => l === '[brain] this job is a build now').length, 2);
});

test('a refused request is saved without the picture data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-pictures-'));
  try {
    const client = fakeClient([reply('tool_use', [toolUse('a', 'view_area', { x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 })]), refusal('cyber'), refusal('cyber'), refusal('cyber')]);
    const refusalLog = new RefusalLog(join(dir, 'refusals'), 20, () => {});
    const brain = new Brain({ client, config: plain, refusalLog, runTool: pictureTool(['top']), snapshot: () => 'SNAPSHOT', say: () => {}, log: () => {} });
    await brain.start({ player: 'Steve', text: 'look at the house' });
    const files = readdirSync(join(dir, 'refusals'));
    assert.ok(files.length >= 1);
    const text = readFileSync(join(dir, 'refusals', files.sort()[0]), 'utf8');
    assert.ok(!text.includes(PIXELS));
    const saved = JSON.parse(text);
    const image = saved.request.messages[2].content[0].content[2];
    assert.equal(image.type, 'image');
    assert.equal(image.source.data, `(${PIXELS.length} base64 characters left out)`);
    assert.equal(client.calls[1].params.messages[2].content[0].content[2].source.data, PIXELS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A house plan big enough to need a look first: one part's box is 7 by 4 by 7.
const housePlan = {
  origin: { x: 100, y: 64, z: 200 },
  palette: { wall: 'oak_planks' },
  parts: [{ shape: 'walls', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 6, dy: 3, dz: 6 }, block: 'oak_planks' }],
  blocks: [{ dx: 3, dy: 0, dz: 0, block: 'air' }]
};
// Calls each step in turn, then a plain reply.
const callsClient = (...steps) => fakeClient([...steps.map((s, i) => reply('tool_use', [toolUse(`c${i}`, s[0], s[1])])), reply('end_turn', [{ type: 'text', text: 'Done.' }])]);
const ranTools = (toolCalls) => toolCalls.map((t) => t.name);

test('a big build_structure is turned back until that plan was previewed', async () => {
  const client = callsClient(['build_structure', housePlan]);
  const logged = [];
  const { brain, toolCalls } = makeBrain({ client, config: plain, log: (line) => logged.push(line) });
  await brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.deepEqual(toolCalls, []);
  const result = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'Not built: preview this plan first with preview_structure, look at the pictures, fix what looks plain or wrong, then call build_structure with the plan you previewed (it may go at another origin).');
  assert.ok(logged.includes('[brain] turned back build_structure: that plan was not previewed'));
});

test('a previewed plan builds, at another origin and with its keys in another order too', async () => {
  const moved = { blocks: housePlan.blocks, parts: [{ block: 'oak_planks', to: { dz: 6, dy: 3, dx: 6 }, from: { dz: 0, dy: 0, dx: 0 }, shape: 'walls' }], palette: { wall: 'oak_planks' }, origin: { x: 5, y: 70, z: 5 } };
  const client = callsClient(['preview_structure', { ...housePlan, views: ['top'], cut_above: 2 }], ['build_structure', housePlan], ['build_structure', moved]);
  const { brain, toolCalls } = makeBrain({ client, config: plain });
  await brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.deepEqual(ranTools(toolCalls), ['preview_structure', 'build_structure', 'build_structure']);

  // A different plan is still turned back.
  const other = callsClient(['build_structure', { ...housePlan, palette: { wall: 'spruce_planks' } }]);
  const again = makeBrain({ client: other, config: plain });
  again.brain.previewedPlans = brain.previewedPlans;
  await again.brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.deepEqual(again.toolCalls, []);
});

test('small plans, dry runs and a plan built before go straight through', async () => {
  const wall = { origin: { x: 0, y: 64, z: 0 }, parts: [{ shape: 'fill', from: { dx: 0, dy: 0, dz: 0 }, to: { dx: 9, dy: 3, dz: 0 }, block: 'cobblestone' }] };
  const client = callsClient(['build_structure', wall], ['build_structure', { ...housePlan, dry_run: true }]);
  const { brain, toolCalls } = makeBrain({ client, config: plain });
  await brain.start({ player: 'Steve', text: 'Clodine build a wall' });
  assert.deepEqual(ranTools(toolCalls), ['build_structure', 'build_structure']);

  // Eight parts and blocks together count as big, however small each is.
  const bits = { origin: { x: 0, y: 64, z: 0 }, blocks: Array.from({ length: 8 }, (_, i) => ({ dx: i, dy: 0, dz: 0, block: 'torch' })) };
  const torches = makeBrain({ client: callsClient(['build_structure', bits]), config: plain });
  await torches.brain.start({ player: 'Steve', text: 'Clodine put torches along there' });
  assert.deepEqual(torches.toolCalls, []);

  // Once built, the same plan at the same spot is mostly standing, so it goes through again.
  const built = makeBrain({ client: callsClient(['build_structure', housePlan]), config: plain });
  built.brain.builtPlans = [];
  built.brain.notePlan({ name: 'build_structure', input: housePlan }, { ok: true, message: 'placed 3' });
  await built.brain.start({ player: 'Steve', text: 'Clodine carry on with the house' });
  assert.deepEqual(ranTools(built.toolCalls), ['build_structure']);
});

test('a plan previewed in one job can be built in a later one, and the switch turns the check off', async () => {
  const answers = [
    reply('tool_use', [toolUse('p', 'preview_structure', housePlan)]),
    reply('end_turn', [{ type: 'text', text: 'Here is the plan.' }]),
    reply('tool_use', [toolUse('b', 'build_structure', housePlan)]),
    reply('end_turn', [{ type: 'text', text: 'Built.' }])
  ];
  const { brain, toolCalls } = makeBrain({ client: fakeClient(answers), config: plain });
  await brain.start({ player: 'Steve', text: 'Clodine plan a house' });
  await brain.start({ player: 'Steve', text: 'Clodine resume' });
  assert.deepEqual(ranTools(toolCalls), ['preview_structure', 'build_structure']);

  // replace and clear don't change the look, so a plan previewed without them builds with them.
  const replaced = makeBrain({ client: callsClient(['build_structure', { ...housePlan, replace: true, clear: true }]), config: plain });
  replaced.brain.previewedPlans = brain.previewedPlans;
  await replaced.brain.start({ player: 'Steve', text: 'Clodine build it over the old shed' });
  assert.deepEqual(ranTools(replaced.toolCalls), ['build_structure']);

  const off = { ...plain, bot: { ...plain.bot, previewBuilds: false } };
  const unchecked = makeBrain({ client: callsClient(['build_structure', housePlan]), config: off });
  await unchecked.brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.deepEqual(ranTools(unchecked.toolCalls), ['build_structure']);
});
