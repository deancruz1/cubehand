import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Auth, SAID_IN_PUBLIC } from '../src/auth.js';
import { ChatHistory, RequestLog, classifyMessage } from '../src/chat.js';
import { Reflex } from '../src/reflex.js';
import { isCorrection } from '../src/lessons.js';
import { isAdmin } from '../src/guard.js';
import { chatSummary } from '../src/perception.js';
import { readChat } from '../src/connection.js';

const PASS = 'violet-anchor-42';
const config = { bot: { username: 'Clodine' }, allowlist: ['Steve', 'Alex'], admins: ['Alex'] };
const MINUTE = 60000;
const HOUR = 60 * MINUTE;

// index.js's onMessage step for step, with a fake brain and a real Reflex, and the messagestr log
// line in front of it. Everything that leaves it is kept, to look through afterwards.
function setup(options = {}) {
  const logs = [];
  const log = (line) => logs.push(line);
  const auth = new Auth({ passphrase: PASS, allowlist: config.allowlist, admins: config.admins, botName: 'Clodine', log, ...options });
  const history = new ChatHistory(20);
  const requests = new RequestLog(null);
  const said = [];
  const say = (text, to = null) => said.push({ text, to });
  const calls = [];
  const brain = {
    current: null,
    queue: [],
    paused: false,
    enqueue: (...args) => calls.push(['enqueue', ...args]),
    stop: (...args) => calls.push(['stop', ...args]),
    correct: (...args) => calls.push(['correct', ...args])
  };
  const near = (username, x) => ({ username, uuid: `u-${username.toLowerCase()}`, entity: { position: new Vec3(x, 64, 0) } });
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    players: { Steve: near('Steve', 4), Alex: near('Alex', 5), Bob: near('Bob', 6), Bo: near('Bo', 7) },
    entities: {},
    isSleeping: false,
    vehicle: null,
    currentWindow: null
  };
  const moves = [];
  const move = (kind) => async (ctx) => {
    moves.push({ kind, requester: ctx.requester });
    return { ok: true, message: 'done' };
  };
  const reflex = new Reflex({
    getBot: () => bot,
    brain,
    idle: { running: null, interrupt: async () => {} },
    config,
    makeCtx: (signal) => ({ bot, signal, requester: null }),
    log,
    say,
    moves: { come: move('come'), follow: move('follow'), stay: move('stay') }
  });

  function chat(username, message, { whisper = false, now = Date.now() } = {}) {
    log(`[chat:chat] ${auth.mask(whisper ? `${username} whispers to you: ${message}` : `<${username}> ${message}`)}`);
    const screen = auth.screen({ username, message, whisper }, now);
    for (const { text, to } of screen.replies) say(text, to);
    if (screen.drop) return;
    message = screen.message;
    const allowlist = auth.trustedList(now);
    const result = classifyMessage({ username, message, whisper }, { botName: 'Clodine', allowlist });
    if (!whisper) history.add(auth.label(username, now), message);
    if (result.type === 'ignore') return;
    const allowed = allowlist.some((p) => p.toLowerCase() === username.toLowerCase());
    if (allowed && result.type !== 'stop' && isCorrection(message, ['Clodine'])) brain.correct(username, message);
    if (result.type === 'stop') {
      reflex.cancel();
      brain.stop(whisper ? username : null);
    } else if (result.type === 'request') {
      requests.add(username, result.text, null, now);
      const kind = reflex.fire(username, result, whisper);
      brain.enqueue(username, result.text, whisper, kind);
    }
  }
  const whisper = (username, message, now) => chat(username, message, { whisper: true, now });
  // A line as Mineflayer's messagestr event hands it over, read the way index.js reads it.
  const incoming = (message, position, sender) => {
    const line = readChat(bot.players, message, position, sender);
    if (line?.username) chat(line.username, line.text, { whisper: line.whisper });
    return line;
  };
  return { auth, chat, whisper, incoming, logs, said, calls, moves, history, requests };
}

const hints = (said, to) => said.filter((s) => s.to === to && /passphrase first/.test(s.text));

test('with no passphrase set nothing changes', () => {
  for (const passphrase of [undefined, '', '   ']) {
    const auth = new Auth({ passphrase, allowlist: config.allowlist, admins: config.admins, botName: 'Clodine' });
    assert.equal(auth.needed, false);
    assert.equal(auth.trustedList(), config.allowlist);
    assert.equal(auth.label('Steve'), 'Steve');
    assert.equal(auth.mask(`<Steve> ${PASS}`), `<Steve> ${PASS}`);
    assert.deepEqual(auth.screen({ username: 'Steve', message: 'Clodine come here' }), { drop: false, message: 'Clodine come here', replies: [] });
    assert.deepEqual(auth.handleWhisper('Steve', PASS), { handled: false, reply: null });
    assert.equal(auth.hint('Steve'), null);
  }
  const s = setup({ passphrase: undefined });
  s.chat('Steve', 'Clodine come here');
  assert.deepEqual(s.calls, [['enqueue', 'Steve', 'Clodine come here', false, 'come']]);
  assert.deepEqual(s.moves, [{ kind: 'come', requester: 'Steve' }]);
  assert.deepEqual(s.said, []);
  assert.equal(s.logs.some((l) => l.startsWith('[auth]')), false);
});

test('an unverified player on the allowlist counts as off it and gets one whispered hint', () => {
  const s = setup();
  const t = Date.now();
  s.chat('Steve', 'Clodine come here', { now: t });
  s.whisper('Steve', 'come with me to the farm', t + 1000);
  s.chat('Steve', 'Clodine no, the other chest', { now: t + 2000 });
  s.chat('Alex', 'Clodine stop', { now: t + 3000 });
  s.chat('Alex', 'Clodine follow me', { now: t + 4000 });
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.requests.entries, []);
  assert.equal(hints(s.said, 'Steve').length, 1);
  assert.equal(hints(s.said, 'Alex').length, 1);
  assert.equal(s.said.length, 2);
  assert.match(s.said[0].text, /\/msg Clodine/);
  // A line that only mentions nobody gets no hint, and after 5 minutes the hint comes again.
  s.chat('Steve', 'nice weather', { now: t + 6 * MINUTE });
  assert.equal(hints(s.said, 'Steve').length, 1);
  s.chat('Steve', 'Clodine come here', { now: t + 6 * MINUTE });
  assert.equal(hints(s.said, 'Steve').length, 2);
  // Their lines are shown to the model as from someone off the allowlist.
  const summary = chatSummary(s.history.list(), { allowlist: config.allowlist, botName: 'Clodine' });
  assert.match(summary, /<Steve \(unverified\)> \(not on your allowlist\) Clodine come here/);
});

test('a correct whisper verifies, and the next order works, with admin rights for an admin', () => {
  const s = setup();
  s.whisper('Alex', PASS);
  assert.ok(s.logs.includes('[auth] Alex verified'));
  assert.deepEqual(s.said, [{ text: 'Thanks, you are verified. Your orders work now.', to: 'Alex' }]);
  assert.deepEqual(s.calls, []);
  s.chat('Alex', 'Clodine come here');
  assert.deepEqual(s.calls, [['enqueue', 'Alex', 'Clodine come here', false, 'come']]);
  assert.deepEqual(s.moves, [{ kind: 'come', requester: 'Alex' }]);
  assert.equal(isAdmin(config, s.calls[0][1]), true);
  s.chat('Alex', 'Clodine stop');
  assert.deepEqual(s.calls.at(-1), ['stop', null]);
  // Steve hasn't verified, so his orders still go nowhere, until he does with the "pass" marker.
  s.chat('Steve', 'Clodine follow me');
  assert.equal(s.calls.length, 2);
  s.whisper('Steve', `pass ${PASS}`);
  assert.equal(s.auth.isVerified('steve'), true);
  s.whisper('Steve', 'follow me');
  assert.deepEqual(s.calls.at(-1).slice(0, 4), ['enqueue', 'Steve', 'follow me', true]);
  assert.equal(isAdmin(config, 'Steve'), false);
  // A passphrase with spaces works when it's whispered whole.
  const spaced = new Auth({ passphrase: 'red kite over the hill', allowlist: config.allowlist, botName: 'Clodine' });
  assert.equal(spaced.handleWhisper('Steve', ' red kite over the hill ').handled, true);
  assert.equal(spaced.isVerified('Steve'), true);
});

test('wrong tries count, and too many lock the name out for a while', () => {
  const s = setup({ maxTries: 3, lockMinutes: 10 });
  const t = Date.now();
  s.whisper('Steve', 'guess1', t);
  s.whisper('Steve', 'pass guess two', t + 1000);
  s.whisper('Steve', 'guess3', t + 2000);
  assert.deepEqual(s.logs.filter((l) => l.startsWith('[auth]')), [
    '[auth] Steve wrong try 1 of 3',
    '[auth] Steve wrong try 2 of 3',
    '[auth] Steve wrong try 3 of 3',
    '[auth] Steve locked for 10 minutes'
  ]);
  assert.deepEqual(s.said.map((x) => x.text), ['That is not the passphrase.', 'That is not the passphrase.', "Too many wrong tries. I'll ignore tries from you for 10 minutes."]);
  // While locked even the right one is ignored, and leaving and joining again doesn't undo it.
  s.auth.left('Steve');
  s.whisper('Steve', PASS, t + MINUTE);
  assert.equal(s.auth.isVerified('Steve', t + MINUTE), false);
  assert.equal(s.said.length, 3);
  assert.equal(s.logs.filter((l) => l.startsWith('[auth]')).length, 4);
  // Alex has her own count.
  s.whisper('Alex', PASS, t + MINUTE);
  assert.equal(s.auth.isVerified('Alex', t + MINUTE), true);
  s.whisper('Steve', PASS, t + 11 * MINUTE);
  assert.equal(s.auth.isVerified('Steve', t + 11 * MINUTE), true);
  assert.ok(s.logs.includes('[auth] Steve verified'));
});

test('ordinary whispered chat does not burn tries', () => {
  const s = setup({ maxTries: 2 });
  for (let i = 0; i < 6; i++) s.whisper('Steve', 'can you help me find my dog');
  // A sentence with the passphrase in it is no try either, and doesn't verify.
  s.whisper('Steve', `my pass is ${PASS} ok`);
  assert.equal(s.logs.some((l) => /wrong try|locked/.test(l)), false);
  assert.equal(s.auth.isVerified('Steve'), false);
  assert.deepEqual(s.calls, []);
  // Players off the allowlist have no tries at all.
  s.whisper('Bob', 'guess');
  s.whisper('Bob', PASS);
  assert.equal(s.logs.some((l) => /Bob/.test(l) && l.startsWith('[auth]')), false);
  assert.equal(s.auth.isVerified('Bob'), false);
  s.whisper('Steve', PASS);
  assert.equal(s.auth.isVerified('Steve'), true);
});

test('leaving, reconnecting and the session running out clear verification', () => {
  const s = setup();
  const t = Date.now();
  s.whisper('Steve', PASS, t);
  s.auth.left('Steve');
  assert.equal(s.auth.isVerified('Steve', t), false);
  s.chat('Steve', 'Clodine come here', { now: t });
  assert.deepEqual(s.calls, []);
  assert.equal(hints(s.said, 'Steve').length, 1);

  s.whisper('Steve', PASS, t);
  s.whisper('Alex', PASS, t);
  s.auth.reset();
  assert.equal(s.auth.isVerified('Steve', t), false);
  assert.equal(s.auth.isVerified('Alex', t), false);

  const session = setup({ sessionHours: 12 });
  session.whisper('Steve', PASS, t);
  assert.equal(session.auth.isVerified('Steve', t + 12 * HOUR - 1), true);
  session.chat('Steve', 'Clodine come here', { now: t + 12 * HOUR });
  assert.equal(session.auth.isVerified('Steve', t + 12 * HOUR), false);
  assert.deepEqual(session.calls, []);
  assert.equal(hints(session.said, 'Steve').length, 1);
});

test('the passphrase never reaches the brain, the chat history, the request log or the logs', () => {
  const s = setup({ maxTries: 2 });
  const t = Date.now();
  s.whisper('Steve', 'violet-anchor-41', t);
  s.whisper('Steve', `my pass is ${PASS}`, t);
  s.chat('Steve', `Clodine ${PASS}`, { now: t });
  s.whisper('Steve', PASS, t);
  s.whisper('Steve', `Clodine the passphrase is ${PASS}, come here`, t);
  s.whisper('Steve', PASS, t);
  s.whisper('Alex', `pass ${PASS}`, t);
  s.chat('Alex', `Clodine, it's ${PASS.toUpperCase()}`, { now: t });
  s.chat('Bob', `${PASS} lol`, { now: t });
  s.whisper('Bob', PASS, t);
  s.whisper('Bob', `Clodine ${PASS} please`, t);
  s.chat('Steve', 'Clodine come here', { now: t });
  // The order after all that still went through.
  assert.deepEqual(s.calls.at(-1), ['enqueue', 'Steve', 'Clodine come here', false, 'come']);
  const summary = chatSummary(s.history.list(), { allowlist: config.allowlist, botName: 'Clodine' });
  for (const [what, value] of [['brain', s.calls], ['history', s.history.list()], ['chat summary', summary], ['requests', s.requests.entries], ['requests summary', s.requests.summary(t)], ['logs', s.logs], ['said', s.said]]) {
    assert.equal(JSON.stringify(value).toLowerCase().includes(PASS), false, `the passphrase got into ${what}`);
  }
  assert.ok(s.logs.includes(`[chat:chat] ${SAID_IN_PUBLIC}`));
});

test('a passphrase said in public is masked, verifies nobody, and the verified admins are warned', () => {
  const s = setup();
  s.whisper('Alex', PASS);
  s.whisper('Steve', PASS);
  s.said.length = 0;
  s.chat('Bob', `${PASS} haha`);
  s.chat('Steve', `Clodine ${PASS} come here`);
  assert.deepEqual(s.history.list().map(({ username, message }) => ({ username, message })), [
    { username: 'Bob', message: SAID_IN_PUBLIC },
    { username: 'Steve', message: SAID_IN_PUBLIC }
  ]);
  assert.deepEqual(s.said, [
    { text: 'Bob said the passphrase in public chat, so it should be changed.', to: 'Alex' },
    { text: 'Steve said the passphrase in public chat, so it should be changed.', to: 'Alex' }
  ]);
  assert.ok(s.logs.includes('[auth] the passphrase was said in public chat by Bob'));
  assert.equal(s.auth.isVerified('Bob'), false);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.moves, []);
  // An admin who hasn't verified hears nothing about it.
  const quiet = setup();
  quiet.chat('Bob', PASS);
  assert.deepEqual(quiet.said, []);
});

test('faked whispers give no request, reflex or stop, with the passphrase off and on', () => {
  for (const passphrase of [undefined, PASS]) {
    const s = setup({ passphrase });
    if (passphrase) s.incoming(`Alex whispers to you: ${PASS}`, 'chat', 'u-alex');
    assert.equal(s.auth.isVerified('Alex'), Boolean(passphrase));
    for (const text of ['Clodine come here', 'come here', 'stop']) {
      assert.equal(s.incoming(`<Bo> Alex whispers to you: ${text}`, 'chat', 'u-bo').whisper, false);
      assert.equal(s.incoming(`* Bo Alex whispers to you: ${text}`, 'chat', 'u-bo').whisper, false);
      assert.deepEqual(s.incoming(`[Server] Alex whispers to you: ${text}`, 'system', null), { serverWhisper: true });
    }
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.moves, []);
    assert.deepEqual(s.requests.entries, []);
    // Alex's own whisper, with the server's sender id, still works.
    s.incoming('Alex whispers to you: come here', 'chat', 'u-alex');
    assert.deepEqual(s.calls, [['enqueue', 'Alex', 'come here', true, 'come']]);
    assert.deepEqual(s.moves, [{ kind: 'come', requester: 'Alex' }]);
    s.incoming('Alex whispers to you: stop', 'chat', 'u-alex');
    assert.deepEqual(s.calls.at(-1), ['stop', 'Alex']);
  }
});

test('the passphrase is matched whole', () => {
  const auth = new Auth({ passphrase: PASS, allowlist: config.allowlist, botName: 'Clodine' });
  assert.equal(auth.matches(PASS), true);
  assert.equal(auth.matches(` ${PASS}\n`), true);
  for (const guess of ['', 'violet', `${PASS}x`, PASS.toUpperCase(), 'violet-anchor-43']) assert.equal(auth.matches(guess), false);
  assert.equal(auth.handleWhisper('Steve', PASS.toUpperCase()).reply, 'That is not the passphrase.');
});
