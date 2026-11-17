import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Reflex } from '../src/reflex.js';
import { classifyMessage } from '../src/chat.js';
import { ACTIONS } from '../src/actions/index.js';

const chatOpts = { botName: 'Clodine', allowlist: ['Steve', 'Alex'] };
const request = (message, username = 'Steve', whisper = false) => classifyMessage({ username, message, whisper }, chatOpts);
const tick = () => new Promise((r) => setImmediate(r));

// A bot with Steve close by, a brain with nothing going on, and movement functions that only
// note how they were called. come answers with whatever comeResult gives.
function setup({ reflexes, comeResult = () => ({ ok: true, message: 'arrived' }) } = {}) {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    players: { Steve: { username: 'Steve', entity: { position: new Vec3(8, 64, 0) } } },
    entities: {},
    isSleeping: false,
    vehicle: null,
    currentWindow: null
  };
  const brain = { current: null, queue: [], paused: false };
  const idle = { running: null, holds: 0, interrupt: async () => {}, hold: () => idle.holds++ };
  const calls = [];
  const said = [];
  const logs = [];
  const moves = {
    come: async (ctx, input) => {
      calls.push({ kind: 'come', ctx, input });
      return comeResult(ctx);
    },
    follow: async (ctx, input) => {
      calls.push({ kind: 'follow', ctx, input });
      return { ok: true, message: 'following' };
    },
    stay: async (ctx, input) => {
      calls.push({ kind: 'stay', ctx, input });
      return { ok: true, message: 'stopped' };
    }
  };
  const config = { bot: { username: 'Clodine', ...(reflexes === undefined ? {} : { reflexes }) } };
  const reflex = new Reflex({
    getBot: () => bot,
    brain,
    idle,
    config,
    makeCtx: (signal) => ({ bot, signal, requester: null }),
    log: (line) => logs.push(line),
    say: (text, to = null) => said.push({ text, to }),
    moves
  });
  return { reflex, bot, brain, idle, calls, said, logs };
}

// A come walk that runs until it's stopped, or until finish() ends it with a result.
function hangingWalk() {
  let finish;
  const ended = new Promise((r) => (finish = r));
  return {
    finish: (result) => finish(result),
    comeResult: (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped', message: 'stopped' }));
        ended.then(resolve);
      })
  };
}

test('each kind fires at once and calls its movement function once, with the speaker as requester', async () => {
  for (const [message, kind] of [['Clodine come here', 'come'], ['Clodine follow me', 'follow'], ['Clodine stay here', 'stay']]) {
    const s = setup();
    assert.equal(s.reflex.fire('Steve', request(message)), kind);
    assert.deepEqual(s.calls.map((c) => c.kind), [kind]);
    assert.deepEqual(s.calls[0].input, { player: 'Steve' });
    assert.equal(s.calls[0].ctx.requester, 'Steve');
    assert.deepEqual(s.logs, [`[reflex] ${kind} for Steve`]);
    await tick();
    assert.equal(s.calls.length, 1);
  }
});

test('the movements are the come, follow and stop_moving tools themselves', () => {
  const reflex = new Reflex({ getBot: () => null, brain: {}, config: { bot: { username: 'Clodine' } }, makeCtx: () => ({}), log: () => {}, say: () => {} });
  assert.deepEqual(reflex.moves, { come: ACTIONS.go_to_player, follow: ACTIONS.follow_player, stay: ACTIONS.stop_moving });
});

test('nothing fires for a message that is more than a plain order', () => {
  const s = setup();
  assert.equal(s.reflex.fire('Steve', request('Clodine come here and bring the wood')), null);
  assert.equal(s.reflex.fire('Steve', request('Clodine follow Alex')), null);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.logs, []);
});

test('nothing fires for a player off the allowlist or a message not for the bot', () => {
  const s = setup();
  assert.equal(s.reflex.fire('Bob', request('Clodine come here', 'Bob')), null);
  assert.equal(s.reflex.fire('Steve', request('come here')), null);
  assert.equal(s.reflex.fire('Steve', request('Clodine stop')), null);
  assert.equal(s.reflex.fire('Steve', request('Clodine stop and come here')), null);
  assert.deepEqual(s.calls, []);
});

const blockers = {
  "a player's job is running": (s) => (s.brain.current = { self: false, player: 'Alex' }),
  "a player's job is queued": (s) => s.brain.queue.push({ player: 'Alex', text: 'mine' }),
  'the brain is on hold': (s) => (s.brain.paused = true),
  'the bot is asleep': (s) => (s.bot.isSleeping = true),
  'the bot is riding': (s) => (s.bot.vehicle = { id: 3 }),
  'a container is open': (s) => (s.bot.currentWindow = { id: 1 }),
  'the bot has not spawned': (s) => (s.bot.entity = null),
  'the speaker cannot be found': (s) => delete s.bot.players.Steve
};

for (const [why, block] of Object.entries(blockers)) {
  test(`nothing fires while ${why}`, () => {
    const s = setup();
    block(s);
    for (const message of ['Clodine come here', 'Clodine follow me']) assert.equal(s.reflex.fire('Steve', request(message)), null, message);
    assert.deepEqual(s.calls, []);
  });
}

test('stay holds chores and come and follow leave them be', () => {
  const s = setup();
  s.reflex.fire('Steve', request('Clodine come here'));
  s.reflex.fire('Steve', request('Clodine follow me'));
  assert.equal(s.idle.holds, 0);
  s.reflex.fire('Steve', request('Clodine wait here'));
  assert.equal(s.idle.holds, 1);
});

test('stay needs no one to be found', () => {
  const s = setup();
  delete s.bot.players.Steve;
  assert.equal(s.reflex.fire('Steve', request('Clodine stop following me')), 'stay');
  assert.deepEqual(s.calls.map((c) => c.kind), ['stay']);
});

test('with reflexes off nothing fires', () => {
  const s = setup({ reflexes: false });
  assert.equal(s.reflex.fire('Steve', request('Clodine come here')), null);
  assert.deepEqual(s.calls, []);
});

test('during free time the body only moves once the free-time tool has let go', async () => {
  const s = setup();
  let letGo;
  s.brain.current = { self: true, running: new Promise((r) => (letGo = r)) };
  assert.equal(s.reflex.fire('Steve', request('Clodine come here')), 'come');
  await tick();
  assert.deepEqual(s.calls, []);
  letGo({ ok: false, message: 'stopped' });
  await tick();
  assert.deepEqual(s.calls.map((c) => c.kind), ['come']);
});

test('free time that is only thinking gives the body over at once', () => {
  const s = setup();
  s.brain.current = { self: true, running: null };
  assert.equal(s.reflex.fire('Steve', request('Clodine follow me')), 'follow');
  assert.deepEqual(s.calls.map((c) => c.kind), ['follow']);
});

test('a chore is stopped first, and a stop before it winds down drops the order', async () => {
  const s = setup();
  let windDown;
  let interrupts = 0;
  s.idle.running = {};
  s.idle.interrupt = () => {
    interrupts++;
    return new Promise((r) => (windDown = r));
  };
  s.reflex.fire('Steve', request('Clodine come here'));
  assert.equal(interrupts, 1);
  s.reflex.cancel();
  windDown();
  await tick();
  assert.deepEqual(s.calls, []);

  s.reflex.fire('Steve', request('Clodine come here'));
  windDown();
  await tick();
  assert.deepEqual(s.calls.map((c) => c.kind), ['come']);
});

test('a walk that finds no way says one line, whispered back to a whispered order', async () => {
  for (const whisper of [false, true]) {
    const s = setup({ comeResult: () => ({ ok: false, reason: 'no_route', message: 'no way across the river' }) });
    s.reflex.fire('Steve', request(whisper ? 'come here' : 'Clodine come here', 'Steve', whisper), whisper);
    await tick();
    assert.deepEqual(s.said, [{ text: "I can't find a way to you.", to: whisper ? 'Steve' : null }]);
    assert.equal(s.reflex.walking, false);
  }
});

test('a walk that arrives, or is cut off by another walk, says nothing', async () => {
  for (const result of [{ ok: true, message: 'arrived' }, { ok: false, reason: 'interrupted', message: 'movement was interrupted' }]) {
    const s = setup({ comeResult: () => result });
    s.reflex.fire('Steve', request('Clodine come here'));
    await tick();
    assert.deepEqual(s.said, []);
  }
});

test('the walk counts as under way until it ends, and a stop ends it without a word', async () => {
  const walk = hangingWalk();
  const s = setup({ comeResult: walk.comeResult });
  s.reflex.fire('Steve', request('Clodine come here'));
  assert.equal(s.reflex.walking, true);
  await tick();
  assert.equal(s.reflex.walking, true);
  const { signal } = s.calls[0].ctx;
  s.reflex.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(s.reflex.walking, false);
  await tick();
  assert.deepEqual(s.said, []);
});

test("another job's tool ends the walk, the reflex job's own tools leave it going", () => {
  const walk = hangingWalk();
  const s = setup({ comeResult: walk.comeResult });
  s.reflex.fire('Steve', request('Clodine come here'));
  s.reflex.toolStarting({ player: 'Steve', reflex: 'come' });
  assert.equal(s.reflex.walking, true);
  s.reflex.toolStarting({ player: 'Alex', reflex: null });
  assert.equal(s.reflex.walking, false);
  assert.equal(s.calls[0].ctx.signal.aborted, true);
});

test('stay ends a come walk still going', () => {
  const walk = hangingWalk();
  const s = setup({ comeResult: walk.comeResult });
  s.reflex.fire('Steve', request('Clodine come here'));
  const { signal } = s.calls[0].ctx;
  s.reflex.fire('Steve', request('Clodine wait'));
  assert.equal(signal.aborted, true);
  assert.equal(s.reflex.walking, false);
  assert.deepEqual(s.calls.map((c) => c.kind), ['come', 'stay']);
});
