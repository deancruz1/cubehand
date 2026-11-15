import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain, announcesMore } from '../src/brain.js';
import { Standing } from '../src/standing.js';

const config = {
  bot: { username: 'Clodine' },
  admins: ['Steve'],
  claude: {
    model: 'claude-opus-5-5', effort: 'medium', fallback: false, strictTools: true, streaming: false, maxTokens: 16000, busyReplies: false,
    routing: true, everydayModel: 'claude-sonnet-5-5', quickModel: 'claude-haiku-5-5'
  },
  limits: { maxSteps: 25, maxSeconds: 60, queueSize: 3 },
  idle: { freeTimeSteps: 4, freeTimeSeconds: 60 }
};

const TASK = 'Strip mine at y -59 between x 0 and x 40: one tunnel along x every 3 blocks of z, going north. Fill ore holes with deepslate.';
const PROGRESS = 'Tunnels at z 0 and z 3 are dug. Next is z 6.';

const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const reply = (stop_reason, content, usage = { input_tokens: 10, output_tokens: 5 }) => ({ stop_reason, content, usage });
const say = (text) => reply('end_turn', [{ type: 'text', text }]);
const finish = (id, message) => use(id, 'finish', { message });
const progress = (id, text, extra = {}) => use(id, 'standing_job', { action: 'progress', progress: text, ...extra });
// One round's answer: dig, save the progress, finish.
const round = (next, line = 'Dug another tunnel.', usage) => reply('tool_use', [use('a', 'dig_area'), progress('b', next), finish('c', line)], usage);

const textOf = (content) => (typeof content === 'string' ? content : content.map((b) => b.text ?? b.content ?? '').join('\n'));

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const answer = typeof responses === 'function' ? responses(calls.length - 1, params) : responses.shift();
          if (answer instanceof Error) throw answer;
          return answer;
        }
      }
    }
  };
}

function setup({ responses = [], cfg = config, store = new Standing(), runTool, jobLog } = {}) {
  const client = fakeClient(responses);
  const said = [];
  const logs = [];
  const toolCalls = [];
  const brain = new Brain({
    client,
    config: cfg,
    standing: store,
    jobLog,
    runTool: runTool ?? (async (name, input) => {
      toolCalls.push({ name, input });
      return { ok: true, message: `${name} done` };
    }),
    snapshot: () => 'SNAPSHOT',
    say: (text, to = null) => said.push({ text, to }),
    log: (line) => logs.push(line)
  });
  return { brain, client, said, logs, toolCalls, store };
}

const started = (store, extra = {}, now) => {
  store.start({ task: TASK, progress: PROGRESS, by: 'Steve', admin: true, ...extra }, now);
  return store;
};

// Starts the next round as if the gap after the last job had passed, and waits for it.
async function nextRound(brain) {
  brain.lastJobEnd = 0;
  assert.equal(brain.standingRound(), true);
  await brain.current.done;
}

const tick = () => new Promise((r) => setImmediate(r));

test('the store keeps one job and writes it through a temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'standing-'));
  try {
    const path = join(dir, 'standing.json');
    const store = new Standing(path);
    assert.equal(store.job, null);
    assert.equal(started(store).job.state, 'active');
    assert.equal(existsSync(`${path}.tmp`), false);
    const old = store.start({ task: 'Chop the birch rows by the farm.', progress: 'Nothing yet.', by: 'Steve', admin: true });
    assert.equal(old.task, TASK);
    store.addRound(0.25, true);
    store.addRound(0.25, false);
    store.addRound(0.25, null);
    assert.deepEqual([store.job.rounds, store.job.cost, store.job.idle], [3, 0.75, 1]);
    assert.equal(new Standing(path).job.task, 'Chop the birch rows by the farm.');
    store.end();
    assert.equal(new Standing(path).job, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin can start a standing job, and a non-admin is refused with a line to pass on', async () => {
  const start = use('a', 'standing_job', { action: 'start', task: TASK, progress: PROGRESS });
  const admin = setup({ responses: [reply('tool_use', [start, finish('b', 'Strip mining until you say stop.')])] });
  await admin.brain.start({ player: 'Steve', text: 'clodine strip mine until told to stop' });
  assert.equal(admin.store.job.task, TASK);
  assert.deepEqual([admin.store.job.by, admin.store.job.admin, admin.store.job.state], ['Steve', true, 'active']);
  assert.deepEqual(admin.said.map((s) => s.text), ['Strip mining until you say stop.']);

  const other = setup({ responses: [reply('tool_use', [start, finish('b', 'On it.')]), say("Sorry Alex, only an admin can give me a standing job.")] });
  await other.brain.start({ player: 'Alex', text: 'clodine strip mine until told to stop' });
  assert.equal(other.store.job, null);
  const results = other.client.calls[1].messages.at(-1).content;
  assert.match(results[0].content, /only an admin can start a standing job, and Alex isn't one/);
  assert.equal(results[0].is_error, true);
  assert.match(results[1].content, /earlier action in this response failed/);
  assert.deepEqual(other.said.map((s) => s.text), ['Sorry Alex, only an admin can give me a standing job.']);
});

test('starting a new standing job replaces the old one and says so', async () => {
  const { brain, store, client } = setup({
    store: started(new Standing()),
    responses: [reply('tool_use', [use('a', 'standing_job', { action: 'start', task: 'Chop the birch rows by the farm.', progress: 'Nothing cut yet.' })]), say('Switched to chopping.')]
  });
  await brain.start({ player: 'Steve', text: 'clodine forget the mine, keep chopping birch until I say stop' });
  assert.equal(store.job.task, 'Chop the birch rows by the farm.');
  assert.match(client.calls[1].messages.at(-1).content[0].content, /replaces the one from Steve \("Strip mine at y -59/);
});

test('a round starts once the brain is idle, on the everyday model, with the task and progress, and the next round sees the new progress', async () => {
  const lines = [];
  const { brain, client, store, toolCalls } = setup({
    store: started(new Standing()),
    responses: [round('Tunnel at z 6 is dug. Next is z 9.'), round('Tunnel at z 9 is dug. Next is z 12.')],
    jobLog: { write: (line) => lines.push(line) }
  });
  brain.lastJobEnd = 0;
  assert.equal(brain.freeTime(), false);
  assert.equal(brain.standingRound(), true);
  assert.equal(brain.standingRound(), false);
  await brain.current.done;
  const first = client.calls[0];
  assert.equal(first.model, 'claude-sonnet-5-5');
  const turn = textOf(first.messages[0].content);
  assert.match(turn, /^SNAPSHOT\n\n/);
  assert.match(turn, /round 1 of your standing job from Steve/);
  assert.ok(turn.includes(`Task: ${TASK}`));
  assert.ok(turn.includes(`Where it stands: ${PROGRESS}`));
  assert.match(turn, /Do the next unit of this work now, and only one/);
  assert.doesNotMatch(turn, /sort this request|handed to you|restarted/);
  assert.ok(first.tools.some((t) => t.name === 'standing_job'));
  assert.deepEqual(toolCalls.map((t) => t.name), ['dig_area']);
  assert.deepEqual([store.job.progress, store.job.rounds, store.job.idle], ['Tunnel at z 6 is dug. Next is z 9.', 1, 0]);

  await nextRound(brain);
  const second = textOf(client.calls[1].messages[0].content);
  assert.match(second, /round 2 of your standing job/);
  assert.match(second, /Where it stands: Tunnel at z 6 is dug\. Next is z 9\./);
  assert.match(second, /Your last job, a round of the standing job from Steve/);
  assert.equal(store.job.progress, 'Tunnel at z 9 is dug. Next is z 12.');
  assert.deepEqual(lines.map((l) => [l.standing, l.player, l.request, l.tier]), [[true, 'Steve', TASK, 'normal'], [true, 'Steve', TASK, 'normal']]);
});

test('nothing starts a round while a hold, the queue, the gap after a job or a fresh join is in the way', async () => {
  const { brain } = setup({ store: started(new Standing()), responses: () => round('Next is z 9.') });
  brain.lastJobEnd = Date.now();
  assert.equal(brain.standingRound(), false);
  brain.lastJobEnd = 0;
  brain.holds.add('danger');
  assert.equal(brain.standingRound(), false);
  brain.holds.delete('danger');
  brain.queue.push({ player: 'Alex', text: 'hi' });
  assert.equal(brain.standingRound(), false);
  brain.queue = [];
  brain.holds.add('offline');
  brain.resume('offline');
  assert.equal(brain.standingRound(), false);
  brain.roundAfter = 0;
  assert.equal(brain.standingRound(), true);
  await brain.current.done;
});

test("a player's request runs between rounds and the rounds carry on after it", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { brain, client, said, store } = setup({
    store: started(new Standing()),
    responses: [round('Next is z 9.'), say('I am strip mining, Alex.'), round('Next is z 12.')],
    runTool: async () => {
      await gate;
      return { ok: true, message: 'dug 80 blocks' };
    }
  });
  brain.lastJobEnd = 0;
  brain.standingRound();
  const first = brain.current;
  await tick();
  brain.enqueue('Alex', 'clodine what are you up to');
  assert.match(said.at(-1).text, /Alex, got it/);
  release();
  await first.done;
  const player = brain.current;
  assert.equal(player.standing, null);
  await player.done;
  assert.match(textOf(client.calls[1].messages[0].content), /Request from Alex: clodine what are you up to/);
  assert.equal(said.at(-1).text, 'I am strip mining, Alex.');
  await nextRound(brain);
  assert.equal(store.job.progress, 'Next is z 12.');
  assert.equal(store.job.rounds, 2);
});

test('a stop pauses the standing job with no model call, and only an admin\'s bare continue resumes it with none', async () => {
  const { brain, client, said, store } = setup({
    store: started(new Standing()),
    responses: [reply('tool_use', [use('a', 'dig_area')]), say('Sorry Alex, only an admin can resume it.')],
    // The round is stopped while its tool runs.
    runTool: (name, input, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' })))
  });
  brain.lastJobEnd = 0;
  brain.standingRound();
  const job = brain.current;
  while (!job.tool) await tick();
  brain.stop(null, 'Steve');
  await job.done;
  assert.equal(client.calls.length, 1);
  assert.equal(said.at(-1).text, 'Stopped. The standing job is paused too; say continue when you want me to carry on with it.');
  assert.deepEqual([store.job.state, store.job.reason, store.job.idle], ['paused', 'Steve said stop', 0]);
  brain.lastJobEnd = 0;
  assert.equal(brain.standingRound(), false);

  brain.enqueue('Alex', 'clodine continue');
  await brain.current.done;
  assert.equal(client.calls.length, 2);
  assert.equal(store.job.state, 'paused');

  brain.enqueue('Steve', 'clodine, carry on', true);
  assert.equal(client.calls.length, 2);
  assert.equal(brain.busy, false);
  assert.equal(store.job.state, 'active');
  assert.deepEqual(said.at(-1), { text: 'Okay Steve, carrying on with the standing job.', to: 'Steve' });

  // A stop with nothing standing is the plain one.
  store.end();
  brain.stop();
  assert.equal(said.at(-1).text, 'Stopped.');
});

test('two rounds in a row without progress pause the standing job, and she says why', async () => {
  const cfg = { ...config, limits: { ...config.limits, maxSteps: 2 } };
  const { brain, said, store } = setup({
    cfg,
    store: started(new Standing()),
    responses: [
      reply('tool_use', [use('a', 'dig_area'), finish('b', 'Dug a bit.')]),
      round('Next is z 9.'),
      reply('tool_use', [use('a', 'dig_area'), finish('b', 'Dug a bit more.')]),
      reply('tool_use', [use('a', 'dig_area')]),
      reply('tool_use', [use('a', 'dig_area')])
    ]
  });
  await nextRound(brain);
  assert.deepEqual([store.job.idle, store.job.state], [1, 'active']);
  await nextRound(brain);
  assert.equal(store.job.idle, 0);
  await nextRound(brain);
  assert.equal(store.job.idle, 1);
  await nextRound(brain);
  assert.equal(store.job.state, 'paused');
  assert.match(store.job.reason, /2 rounds in a row made no progress, the last one ran out of steps/);
  assert.equal(said.at(-1).text, "I've paused the standing job: 2 rounds in a row made no progress, the last one ran out of steps. Say continue when you want me to try again.");
  assert.equal(said.filter((s) => /ran out of steps/.test(s.text)).length, 1);
});

test('the hour and cost limits pause the standing job, and an admin\'s resume counts again', async () => {
  const hours = setup({ store: started(new Standing(), {}, Date.now() - 5 * 3600000), responses: [round('Next is z 9.')] });
  hours.brain.lastJobEnd = 0;
  assert.equal(hours.brain.standingRound(), false);
  assert.deepEqual([hours.store.job.state, hours.store.job.reason], ['paused', 'it has run for 4 hours']);
  assert.equal(hours.said.at(-1).text, "I've paused the standing job: it has run for 4 hours. Say continue if you want me to keep going.");
  hours.brain.enqueue('Steve', 'clodine continue');
  await nextRound(hours.brain);
  assert.equal(hours.store.job.state, 'active');

  // A million input tokens on the everyday model is $2 a round.
  const cfg = { ...config, standing: { maxCostUsd: 3 } };
  const big = { input_tokens: 1000000, output_tokens: 0 };
  const cost = setup({ cfg, store: started(new Standing()), responses: () => round('Next is z 9.', 'Dug.', big) });
  await nextRound(cost.brain);
  assert.equal(cost.store.job.state, 'active');
  await nextRound(cost.brain);
  assert.deepEqual([cost.store.job.state, cost.store.job.reason, cost.store.job.cost], ['paused', 'it has cost $4.00', 4]);
  assert.match(cost.said.at(-1).text, /paused the standing job: it has cost \$4\.00/);
  cost.brain.enqueue('Steve', 'clodine resume');
  assert.equal(cost.store.job.state, 'active');
  await nextRound(cost.brain);
  assert.equal(cost.store.job.state, 'active');
});

test('a reload from the file carries on an active standing job with a note that she was restarted, and leaves a paused one paused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'standing-'));
  try {
    const path = join(dir, 'standing.json');
    started(new Standing(path));
    const reloaded = new Standing(path);
    assert.equal(reloaded.restarted, true);
    const { brain, client } = setup({ store: reloaded, responses: [round('Next is z 9.'), round('Next is z 12.')] });
    brain.holds.add('offline');
    brain.resume('offline');
    brain.lastJobEnd = 0;
    assert.equal(brain.standingRound(), false);
    brain.roundAfter = 0;
    await nextRound(brain);
    assert.match(textOf(client.calls[0].messages[0].content), /from Steve\. You were restarted since the last round/);
    await nextRound(brain);
    assert.doesNotMatch(textOf(client.calls[1].messages[0].content), /restarted/);
    assert.equal(new Standing(path).job.progress, 'Next is z 12.');

    reloaded.pause('Steve said stop');
    const paused = new Standing(path);
    assert.deepEqual([paused.restarted, paused.job.state], [false, 'paused']);
    const again = setup({ store: paused });
    again.brain.lastJobEnd = 0;
    assert.equal(again.brain.standingRound(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dying pauses the standing job, and she says so once', () => {
  const { brain, said, store } = setup({ store: started(new Standing()) });
  brain.died();
  brain.died();
  assert.deepEqual([store.job.state, store.job.reason], ['paused', 'I died']);
  assert.deepEqual(said.map((s) => s.text), ["I died, so I've paused the standing job. Say continue when you want me to pick it up again."]);
});

test("a round's line is said at most once every sayEveryMin, unless the round paused or ended the standing job", async () => {
  const { brain, said, logs, store } = setup({
    store: started(new Standing()),
    responses: [
      round('Next is z 9.', 'Tunnel at z 6 is dug.'),
      round('Next is z 12.', 'Tunnel at z 9 is dug.'),
      round('Next is z 15.', 'Tunnel at z 12 is dug.'),
      reply('tool_use', [use('a', 'standing_job', { action: 'pause', reason: 'my pickaxe broke and the chests have none' }), finish('b', "I've paused the strip mine: my pickaxe broke.")])
    ]
  });
  await nextRound(brain);
  await nextRound(brain);
  assert.deepEqual(said.map((s) => s.text), ['Tunnel at z 6 is dug.']);
  assert.ok(logs.includes('[standing] not said: Tunnel at z 9 is dug.'));
  brain.lastRoundSaid = Date.now() - 6 * 60000;
  await nextRound(brain);
  assert.equal(said.at(-1).text, 'Tunnel at z 12 is dug.');
  await nextRound(brain);
  assert.equal(said.at(-1).text, "I've paused the strip mine: my pickaxe broke.");
  assert.deepEqual([store.job.state, store.job.reason, store.job.idle], ['paused', 'my pickaxe broke and the chests have none', 0]);
});

test('a round that ends on what the next unit is ends there, without being sent on', async () => {
  const line = "Tunnel at z 6 is dug. Next I'll dig the tunnel at z 9.";
  assert.equal(announcesMore(line), true);
  const { brain, client, said, logs } = setup({ store: started(new Standing()), responses: [round('Next is z 9.', line), reply('end_turn', [{ type: 'text', text: line }])] });
  await nextRound(brain);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(said.map((s) => s.text), [line]);
  brain.lastRoundSaid = 0;
  await nextRound(brain);
  assert.equal(client.calls.length, 2);
  assert.equal(logs.some((l) => /sending her on/.test(l)), false);
});

test('a non-admin may save progress but not change the task, and an admin may change it', async () => {
  const change = progress('a', 'Next is z 9.', { task: 'Strip mine at y -40 instead.' });
  const other = setup({
    store: started(new Standing()),
    responses: [reply('tool_use', [change]), reply('tool_use', [progress('b', 'Tunnel at z 6 is half dug.'), finish('c', 'Only an admin can change the task.')])]
  });
  await other.brain.start({ player: 'Alex', text: 'clodine do the strip mine at y -40 instead' });
  assert.equal(other.store.job.task, TASK);
  assert.match(other.client.calls[1].messages.at(-1).content[0].content, /only an admin can change the task of a standing job/);
  assert.equal(other.store.job.progress, 'Tunnel at z 6 is half dug.');

  const admin = setup({ store: started(new Standing()), responses: [reply('tool_use', [change, finish('b', 'The strip mine moves to y -40.')])] });
  await admin.brain.start({ player: 'Steve', text: 'clodine do the strip mine at y -40 instead' });
  assert.deepEqual([admin.store.job.task, admin.store.job.progress], ['Strip mine at y -40 instead.', 'Next is z 9.']);
});

test('with standing.enabled false the tool and its prompt line are left out, and nothing starts or pauses', async () => {
  const cfg = { ...config, standing: { enabled: false } };
  const { brain, client, said } = setup({ cfg, store: started(new Standing()), responses: [say('Hi.')] });
  await brain.start({ player: 'Steve', text: 'clodine hi' });
  assert.equal(client.calls[0].tools.some((t) => t.name === 'standing_job'), false);
  assert.doesNotMatch(client.calls[0].system[0].text, /standing_job/);
  assert.equal(brain.standingJob, null);
  brain.lastJobEnd = 0;
  assert.equal(brain.standingRound(), false);
  brain.stop();
  assert.equal(said.at(-1).text, 'Stopped.');
  assert.deepEqual(brain.standingTool({ player: 'Steve' }, { action: 'end' }), { ok: false, message: 'Not done: standing jobs are turned off.' });
});
