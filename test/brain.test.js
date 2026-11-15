import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { Brain } from '../src/brain.js';

const baseConfig = {
  bot: { username: 'Clodine' },
  claude: { model: 'claude-opus-5-5', effort: 'medium', fallback: true, strictTools: true, maxTokens: 16000, busyReplies: false },
  limits: { maxSteps: 25, maxSeconds: 60, queueSize: 3 }
};

function toolUse(id, name, input = {}) {
  return { type: 'tool_use', id, name, input };
}

function reply(stop_reason, content) {
  return { stop_reason, content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } };
}

// A fake client that hands back scripted responses and records every request.
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, opts) => {
          calls.push({ params: structuredClone({ ...params }), opts });
          const next = typeof responses === 'function' ? responses(calls.length) : responses.shift();
          if (next instanceof Error) throw next;
          return next;
        }
      }
    }
  };
}

function makeBrain({ client, config = baseConfig, runTool, jobLog }) {
  const said = [];
  const heard = [];
  const toolCalls = [];
  let stops = 0;
  const brain = new Brain({
    client,
    config,
    jobLog,
    runTool: runTool ?? (async (name, input) => {
      toolCalls.push({ name, input });
      return { ok: true, message: `${name} done` };
    }),
    snapshot: () => 'SNAPSHOT',
    say: (text, to = null) => {
      said.push(text);
      heard.push({ text, to });
    },
    onStop: () => stops++,
    log: () => {}
  });
  return { brain, said, heard, toolCalls, stops: () => stops };
}

test('runs tools, sends results back, and says the final reply', async () => {
  const client = fakeClient([
    reply('tool_use', [toolUse('a', 'go_to_player', { player: 'Steve' }), toolUse('b', 'place_block', { block: 'torch', x: 1, y: 2, z: 3 })]),
    reply('end_turn', [{ type: 'text', text: 'Torch placed.' }])
  ]);
  const { brain, said, toolCalls } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'Clodine come here and place a torch' });

  assert.deepEqual(toolCalls.map((t) => t.name), ['go_to_player', 'place_block']);
  assert.deepEqual(said, ['Torch placed.']);

  const second = client.calls[1].params.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content.length, 2);
  assert.equal(second[2].role, 'user');
  assert.deepEqual(second[2].content.map((r) => r.tool_use_id), ['a', 'b']);
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
  const { brain } = makeBrain({ client, runTool: async () => ({ ok: false, message: 'no path' }) });
  await brain.start({ player: 'Steve', text: 'go' });
  const result = client.calls[1].params.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'no path');
});

test('refusal and max_tokens end the request with a chat message', async () => {
  const refused = makeBrain({ client: fakeClient([reply('refusal', [])]) });
  await refused.brain.start({ player: 'Steve', text: 'x' });
  assert.deepEqual(refused.said, ["I can't help with that one."]);
  assert.equal(refused.toolCalls.length, 0);

  const cut = makeBrain({ client: fakeClient([reply('max_tokens', [toolUse('a', 'say', { message: 'hi' })])]) });
  await cut.brain.start({ player: 'Steve', text: 'x' });
  assert.match(cut.said[0], /cut off/);
  assert.equal(cut.toolCalls.length, 0);
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
  const client = fakeClient([reply('tool_use', [toolUse('a', 'build_structure')]), reply('end_turn', []), reply('end_turn', []), reply('end_turn', [])]);
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
  assert.match(last[1].text, /Alex said: make it 12x12/);
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
  const client = fakeClient([
    reply('tool_use', [{ type: 'text', text: 'Taking down the old roof first.' }, toolUse('a', 'build_house', { x: 0, y: 64, z: 0 })]),
    reply('end_turn', [{ type: 'text', text: 'Done.' }])
  ]);
  const { brain, said } = makeBrain({ client });
  await brain.start({ player: 'Steve', text: 'build a house' });
  assert.deepEqual(said, ['Taking down the old roof first.', 'Done.']);
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
  await brain.start({ player: 'Steve', text: 'Clodine smelt the raw iron and put it away' });
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
  await brain.start({ player: 'Steve', text: 'Clodine sort out the storage room' });
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
  await brain.start({ player: 'Steve', text: 'Clodine fix the west wall' });
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
  await brain.start({ player: 'Steve', text: 'Clodine fix the west wall' });
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
  await brain.start({ player: 'Steve', text: 'Clodine mine then sort it out' });
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
  await brain.start({ player: 'Steve', text: 'Clodine mine some stone' });

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.player, 'Steve');
  assert.equal(line.request, 'Clodine mine some stone');
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
  assert.equal((await endOf(fakeClient([reply('refusal', [])]))).end, 'refusal');
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

test('the prompt explains finish and batches, and no longer asks for a dry run before every build', async () => {
  const { systemPrompt } = await import('../src/prompt.js');
  const text = systemPrompt('Clodine');
  assert.match(text, /finish/);
  assert.match(text, /stop at the first (one that )?fail/);
  assert.match(text, /\(whispered\)/);
  assert.doesNotMatch(text, /with dry_run first/);
  assert.doesNotMatch(text, /check it with dry_run, then build/);
});
