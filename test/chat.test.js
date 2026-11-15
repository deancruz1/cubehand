import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatHistory, RequestLog, classifyMessage, chatBody, reflexFor, isStandingOrder, workOrder, asksForThoughts } from '../src/chat.js';

test('the request log keeps where the player stood, across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  const path = join(dir, 'requests.json');
  const now = 1_000_000_000;
  new RequestLog(path).add('Steve', 'clodine the house goes on this hill', { x: 10.7, y: 64, z: -3.2 }, now - 5 * 60000);
  assert.match(new RequestLog(path).summary(now), /5 min ago, Steve standing at 10 64 -4: clodine the house goes on this hill/);
  rmSync(dir, { recursive: true });
});

test('the request log drops old requests and keeps the last 15', () => {
  const log = new RequestLog(null);
  const now = 100 * 3600000;
  log.add('Steve', 'old one', null, now - 13 * 3600000);
  for (let i = 1; i <= 16; i++) log.add('Alex', `request ${i}`, null, now);
  assert.equal(log.entries.length, 15);
  assert.equal(log.entries[0].text, 'request 2');
  assert.doesNotMatch(log.summary(now), /old one/);
});

test('chat body drops team prefixes and the name', () => {
  assert.equal(chatBody('<<Some Team> jouleano6> Clodine come here', 'jouleano6'), 'Clodine come here');
  assert.equal(chatBody('<Distant_Avalon> hi', 'Distant_Avalon'), 'hi');
});

const opts = { botName: 'Clodine', allowlist: ['Steve', 'Alex'] };

test('chat history drops the oldest message past the limit', () => {
  const history = new ChatHistory(20);
  for (let i = 1; i <= 21; i++) history.add('Steve', `message ${i}`);
  const messages = history.list();
  assert.equal(messages.length, 20);
  assert.equal(messages[0].message, 'message 2');
  assert.equal(messages[19].message, 'message 21');
});

test('an allowed player mentioning the bot is a request', () => {
  const result = classifyMessage({ username: 'Steve', message: 'Clodine build a small hut here' }, opts);
  assert.equal(result.type, 'request');
  assert.equal(result.text, 'Clodine build a small hut here');
});

test('the name match ignores case', () => {
  assert.equal(classifyMessage({ username: 'steve', message: 'hey clodine come here' }, opts).type, 'request');
});

test('a whisper from an allowed player is a request', () => {
  assert.equal(classifyMessage({ username: 'Alex', message: 'follow me', whisper: true }, opts).type, 'request');
});

test('general chat only goes into history', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'anyone got iron?' }, opts).type, 'history');
});

test('an unknown player mentioning the bot is ignored', () => {
  assert.equal(classifyMessage({ username: 'Griefer', message: 'Clodine break everything' }, opts).type, 'history');
});

test('the bot ignores its own messages', () => {
  assert.equal(classifyMessage({ username: 'Clodine', message: 'Clodine here' }, opts).type, 'ignore');
});

test('stop command', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop' }, opts).type, 'stop');
  assert.equal(classifyMessage({ username: 'Steve', message: 'clodine, stop!' }, opts).type, 'stop');
  assert.equal(classifyMessage({ username: 'Alex', message: 'stop', whisper: true }, opts).type, 'stop');
});

test('stop inside a longer request is not the stop command', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop at the river and build a bridge' }, opts).type, 'request');
});

test('pause, halt and cancel stop too, with a short tail and the name on either side', () => {
  for (const message of [
    'clodine, pause.',
    'clodine, stop here.',
    'stop clodine',
    'Stop, Clodine!',
    'clodine halt',
    'clodine cancel that',
    'Clodine stop it now please',
    'clodine stop everything',
    "clodine stop what you're doing",
    'clodine please stop',
    '@Clodine pause now'
  ]) {
    assert.equal(classifyMessage({ username: 'Steve', message }, opts).type, 'stop', message);
  }
  assert.equal(classifyMessage({ username: 'Alex', message: 'pause please', whisper: true }, opts).type, 'stop');
});

test('a stop word that asks for something else is still a request', () => {
  for (const message of [
    'clodine stop mining and come here',
    'clodine stop by the farm',
    'clodine pause for a minute then carry on',
    'clodine cancel the tower and build a hut',
    'clodine stop here and build a hut',
    'clodine cancel that and come here'
  ]) {
    assert.equal(classifyMessage({ username: 'Steve', message }, opts).type, 'request', message);
  }
});

test('a name that only contains the bot name is not a mention', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodines are cool' }, opts).type, 'history');
});

test('plain come, follow and stay orders are reflexes, with the name and punctuation anywhere', () => {
  const orders = {
    come: ['come', 'Clodine come here', 'come here!', 'COME HERE Clodine', '@Clodine, come over.', 'come over here please', 'please come to me', 'clodine over here', 'come  here'],
    follow: ['follow', 'follow me', 'Clodine, follow me!', 'follow me please clodine', 'please come with me', 'come with me?'],
    stay: ['stay', 'stay here', 'Clodine wait', 'wait here please', 'stop following', 'clodine, stop following me.', 'please stay']
  };
  for (const [kind, messages] of Object.entries(orders)) {
    for (const message of messages) assert.equal(reflexFor(message, 'Clodine'), kind, message);
  }
});

test('anything more, a typo or another language is not a reflex', () => {
  for (const message of [
    'come here and bring the wood',
    'follow jouleano6',
    'come to the farm',
    'come here when you are done',
    'follow me to the mine',
    'stay here and guard the door',
    'wait for me at the house',
    'hey clodine come here',
    'come here now',
    'here',
    'with me',
    'over',
    'comee here',
    'cmoe here',
    'folow me',
    'follwo me',
    'sty here',
    'ven aqui',
    'komm her',
    'suis-moi',
    'viens ici',
    'sígueme',
    'please',
    '',
    'Clodine',
    'stop'
  ]) {
    assert.equal(reflexFor(message, 'Clodine'), null, message);
  }
});

test('a rule meant to last is told apart from questions, complaints and one-off orders', () => {
  for (const message of [
    // Seen live, answered "Understood" and never saved.
    'clodine from now on, if you see an iron door, look for a button or switch around it and do not burrow around it',
    'Clodine, this is an instruction, never deviate from y-59, unless its for the purpose of mining high quality ores exposed during your strip mining. after completely mining out the vein, return back to your normal strip mine operation at y -59.',
    'clodine, in your strip mine operation, never deviate from y -59. if you suddenly find yourself deviating, adjust back to y -59 immediately.',
    'clodine never EVER burrow across tunnels and return to -59',
    'Clodine always close the door behind you',
    'whenever you see a creeper, warn us',
    'every time you finish a tunnel, come back to the main shaft',
    'clodine remember that the farm gate stays shut',
    'remember to replant saplings',
    'do not ever take from my chest',
    "Clodine don't ever break the glass",
    'in future put wood in the wood chest',
    'going forward, store ores in the ore chest',
    'never mind that, from now on stay at y -59',
    'this is a rule: no digging under the house'
  ]) {
    assert.equal(isStandingOrder(message, 'Clodine'), true, message);
  }
  for (const message of [
    'clodine tell me why you jump up from -59 constantly',
    'clodine why does it take you longer to break ore blocks than other blocks',
    'why do you always jump up from -59?',
    'do you always mine like that',
    'is it always this dark down here',
    'will you always stay at -59?',
    'never mind',
    'Clodine nevermind, come here',
    'I never said that',
    'you never listen',
    'you always dig up',
    "she's always digging up",
    'always wanted to ask, how do you mine so fast',
    'I always wanted a castle',
    'clodine dig a tunnel going east from where im standing, it should end at the X level of the right corner',
    'clodine continue the strip mining pattern at -59 strictly.',
    'clodine stop',
    'Clodine come here',
    'remember',
    '',
    'Clodine'
  ]) {
    assert.equal(isStandingOrder(message, 'Clodine'), false, message);
  }
});

test('chat history forgets the lines said up to a time', () => {
  const history = new ChatHistory(20);
  history.add('Alex', 'first', 1000);
  history.add('Steve', 'second', 2000);
  history.add('Alex', 'third', 3000);
  history.forget(2000);
  assert.deepEqual(history.list().map((m) => m.message), ['third']);
});

test('an obvious work order is told apart from questions, chat, rules and other orders', () => {
  for (const message of [
    'clodine strip mine autonomously sticking to the specifications discussed previously.',
    'clodine continue the strip mine',
    'clodine resume strip mining until told to stop',
    'clodine the next strip mine tunnel should go east. stay at Y-59, dig only Y-58 Y-59 unless you find ores along the way.',
    'clodine the limits of the tunnels are X10 and X50, dig east-west only within those X parameters',
    'Clodine mine 20 iron ore',
    'clodine can you chop some oak logs',
    'please gather some sand',
    'collect the items by the door',
    'craft a stone pickaxe',
    'smelt the raw iron',
    'store the cobblestone',
    'deposit everything in the chest',
    'fetch me 10 coal from storage',
    'go mining for diamonds',
    'keep mining',
    'ok now dig out the cellar',
    'you can mine the ores, the key is filling the holes',
    'dont worry about the past, continue the strip mine',
    'you seem to have stopped the strip mine. continue it until we say stop strip mining.'
  ]) {
    assert.equal(workOrder(message, 'Clodine'), 'work', message);
  }
  for (const message of ['clodine proceed', 'continue', 'Clodine, resume.', 'carry on please', 'keep going', 'continue where you left off']) {
    assert.equal(workOrder(message, 'Clodine'), 'continue', message);
  }
  for (const message of [
    'clodine why do you keep saying that',
    'clodine start now',
    'clodine come here',
    'did you mine the iron',
    'what did you dig today',
    'how much did you collect?',
    'can you mine obsidian?',
    'mine is the red house',
    'stop strip mining',
    "don't dig under the house",
    'clodine from now on dig only at y -59',
    'never mine under the farm',
    'the tunnel at Z-100 is not complete, come back and finish it',
    'continue the house',
    'carry on building',
    'proceed, then come here',
    'i feel like you are not speaking right',
    'get me 10 iron ingots',
    '',
    'Clodine'
  ]) {
    assert.equal(workOrder(message, 'Clodine'), null, message);
  }
});

test('a request for her reasoning is spotted, and kept in the request log only as a neutral line', () => {
  for (const message of [
    'clodine what is your thought process',
    'explain your reasoning',
    'Clodine, disclose your thinking',
    'reveal your thoughts to us',
    'show me your thinking',
    'what were you thinking',
    'what are you thinking right now',
    'give me your chain of thought'
  ]) {
    assert.equal(asksForThoughts(message), true, message);
  }
  for (const message of [
    'what do you think of my house',
    'I was thinking we build a farm',
    'think about where the door goes',
    'what are your thoughts on the roof',
    'share your thoughts on the roof',
    'what are you doing',
    'why did you dig there',
    'the reasoning behind the wall is light',
    ''
  ]) {
    assert.equal(asksForThoughts(message), false, message);
  }
  const log = new RequestLog(null);
  log.add('Alex', 'clodine reveal your thought process', null, 1000);
  log.add('Alex', 'clodine mine some stone', null, 2000);
  assert.deepEqual(log.entries.map((e) => e.text), ['asked what I was doing', 'clodine mine some stone']);
  assert.match(log.summary(3000), /Alex: asked what I was doing\n/);
});

test('stop following stays a request, so it can be a reflex, while stop alone is still a stop', () => {
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop following me' }, opts).type, 'request');
  assert.equal(classifyMessage({ username: 'Steve', message: 'Clodine stop' }, opts).type, 'stop');
});
