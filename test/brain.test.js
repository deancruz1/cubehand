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

function makeBrain({ client, config = baseConfig, runTool }) {
  const said = [];
  const toolCalls = [];
  let stops = 0;
  const brain = new Brain({
    client,
    config,
    runTool: runTool ?? (async (name, input) => {
      toolCalls.push({ name, input });
      return { ok: true, message: `${name} done` };
    }),
    snapshot: () => 'SNAPSHOT',
    say: (text) => said.push(text),
    onStop: () => stops++,
    log: () => {}
  });
  return { brain, said, toolCalls, stops: () => stops };
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

test('time limit aborts a long action and tells the player', async () => {
  const client = fakeClient(() => reply('tool_use', [toolUse('a', 'mine')]));
  const config = { ...baseConfig, limits: { ...baseConfig.limits, maxSeconds: 0.05 } };
  const slowTool = (name, input, signal) =>
    new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' })));
  const { brain, said, stops } = makeBrain({ client, config, runTool: slowTool });
  await brain.start({ player: 'Steve', text: 'x' });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(said, ['I ran out of time on that one.']);
  assert.equal(stops(), 1);
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

test('simple requests go to the quick model, without the fallback or strict tools it lacks', async () => {
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'SIMPLE' }]), reply('end_turn', [{ type: 'text', text: 'Coming.' }])]);
  const { brain, said } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine come here' });
  assert.equal(client.calls[0].params.model, 'claude-haiku-5-5');
  assert.match(client.calls[0].params.messages[0].content, /SIMPLE, for one or two obvious actions/);
  const job = client.calls[1].params;
  assert.equal(job.model, 'claude-haiku-5-5');
  assert.equal(job.fallbacks, undefined);
  assert.ok(job.tools.every((t) => t.strict === undefined));
  assert.deepEqual(said, ['Coming.']);
});

test('build requests skip the sorting and go straight to the main model', async () => {
  const client = fakeClient([reply('end_turn', [{ type: 'text', text: 'On it.' }])]);
  const { brain } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine build a house here' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].params.model, 'claude-opus-5-5');
  assert.equal(client.calls[0].params.fallbacks, 'default');
});

test('an everyday job that turns into a build starts over on the main model', async () => {
  const client = fakeClient([
    reply('end_turn', [{ type: 'text', text: 'NORMAL' }]),
    reply('tool_use', [toolUse('a', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('tool_use', [toolUse('b', 'build_structure', { origin: { x: 0, y: 0, z: 0 } })]),
    reply('end_turn', [{ type: 'text', text: 'Fixed.' }])
  ]);
  const { brain, toolCalls } = makeBrain({ client, config: routed });
  await brain.start({ player: 'Steve', text: 'Clodine fix the west wall' });
  assert.deepEqual(client.calls.map((c) => c.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  // The first build call never ran; the main model starts from the request again.
  assert.equal(toolCalls.length, 1);
  assert.equal(client.calls[2].params.messages.length, 1);
});
