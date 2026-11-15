import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { nextDelay, reasonText, isPermanentKick, isWhisperLine, enchantList, digTimeFor, safeDigTime } from '../src/connection.js';

const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Item = require('prismarine-item')(registry);
const Block = require('prismarine-block')(registry);

const deepslate = () => Block.fromStateId(registry.blocksByName.deepslate.defaultState, 0);
// An item as the server sends it from 1.20.5 on, with its components.
const fromServer = (name, components = []) =>
  Item.fromNotch({ itemId: registry.itemsByName[name].id, itemCount: 1, components, removeComponents: [] });
const enchanted = (name, enchantments) =>
  fromServer(name, [{ type: 'enchantments', data: { enchantments: enchantments.map(([n, level]) => ({ id: registry.enchantmentsByName[n].id, level })) } }]);

function digBot(held, { helmet = null, eyeLevel = 'air' } = {}) {
  const slots = [];
  slots[5] = helmet;
  return {
    heldItem: held,
    registry,
    inventory: { slots },
    getEquipmentDestSlot: (dest) => (dest === 'head' ? 5 : 0),
    game: { gameMode: 'survival' },
    _getBlockAtEyeLevel: () => ({ name: eyeLevel }),
    entity: { onGround: true, effects: {} }
  };
}

test('dig time with an unenchanted pickaxe and with Efficiency read from its components', () => {
  assert.equal(digTimeFor(digBot(fromServer('diamond_pickaxe')), deepslate()), 600);
  const tool = enchanted('diamond_pickaxe', [['efficiency', 5], ['unbreaking', 3]]);
  // What Mineflayer's own digTime chokes on: not an array.
  assert.equal(Array.isArray(tool.enchants), false);
  assert.deepEqual(enchantList(tool, [], registry), [{ name: 'efficiency', lvl: 5 }, { name: 'unbreaking', lvl: 3 }]);
  assert.equal(digTimeFor(digBot(tool), deepslate()), 150);
});

test('enchantment ids follow the registry the server sent when there is one', () => {
  const tool = fromServer('diamond_pickaxe', [{ type: 'enchantments', data: { enchantments: [{ id: 2, level: 4 }] } }]);
  assert.deepEqual(enchantList(tool, ['protection', 'unbreaking', 'efficiency'], registry), [{ name: 'efficiency', lvl: 4 }]);
  const bot = digBot(tool);
  bot._client = new EventEmitter();
  safeDigTime(bot);
  bot._client.emit('registry_data', { id: 'minecraft:enchantment', entries: ['protection', 'unbreaking', 'efficiency'].map((n) => ({ key: `minecraft:${n}` })) });
  bot._client.emit('registry_data', { id: 'minecraft:biome', entries: [{ key: 'minecraft:plains' }] });
  assert.equal(bot.digTime(deepslate()), digTimeFor(digBot(enchanted('diamond_pickaxe', [['efficiency', 4]])), deepslate()));
  assert.ok(bot.digTime(deepslate()) < 600);
});

test('dig time with enchantments as an array, and with an enchants getter that throws', () => {
  const listed = fromServer('diamond_pickaxe');
  Object.defineProperty(listed, 'enchants', { get: () => [{ name: 'efficiency', lvl: 5 }, null] });
  assert.equal(digTimeFor(digBot(listed), deepslate()), 150);
  const broken = fromServer('diamond_pickaxe');
  Object.defineProperty(broken, 'enchants', {
    get: () => {
      throw new Error("Don't know how to get the enchants from an item on this mc version");
    }
  });
  assert.deepEqual(enchantList(broken), []);
  assert.equal(digTimeFor(digBot(broken), deepslate()), 600);
  assert.equal(digTimeFor(digBot(null), deepslate()) > 600, true);
});

test('an enchanted helmet counts too: Aqua Affinity takes away the underwater slowdown', () => {
  const tool = enchanted('diamond_pickaxe', [['efficiency', 5]]);
  const helmet = enchanted('diamond_helmet', [['aqua_affinity', 1], ['protection', 4]]);
  assert.equal(digTimeFor(digBot(fromServer('diamond_pickaxe'), { eyeLevel: 'water' }), deepslate()), 2850);
  assert.equal(digTimeFor(digBot(fromServer('diamond_pickaxe'), { eyeLevel: 'water', helmet }), deepslate()), 600);
  assert.equal(digTimeFor(digBot(tool, { helmet }), deepslate()), 150);
  assert.equal(digTimeFor(digBot(tool, { helmet: fromServer('iron_helmet') }), deepslate()), 150);
});

test('ore digs at pickaxe speed as soon as the dig time plugin loads, enchanted tools too', () => {
  const ore = () => Block.fromStateId(registry.blocksByName.deepslate_diamond_ore.defaultState, 0);
  const bot = digBot(fromServer('diamond_pickaxe'));
  bot._client = new EventEmitter();
  safeDigTime(bot);
  assert.equal(bot.digTime(ore()), 850);
  assert.equal(digTimeFor(digBot(enchanted('diamond_pickaxe', [['efficiency', 5]])), ore()), 200);
  assert.equal(bot.digTime(deepslate()), 600);
});

test('whisper lines are told apart from public chat', () => {
  assert.equal(isWhisperLine('Alice whispers to you: Clodine come here', 'Alice'), true);
  assert.equal(isWhisperLine('[Red] Alice whispers to you: hi', 'Alice'), true);
  assert.equal(isWhisperLine('You whisper to Alice: On my way.', 'Clodine'), true);
  assert.equal(isWhisperLine('[Alice -> me] hi', 'Alice'), true);
  assert.equal(isWhisperLine('<Alice> Clodine come here', 'Alice'), false);
  assert.equal(isWhisperLine('<Alice> Bob whispers to you: hi', 'Alice'), false);
  assert.equal(isWhisperLine('<Bo> x whispers to you: y', 'Bo'), false);
});

test('reconnect delay doubles from 5s and caps at 60s', () => {
  const delays = [0, 1, 2, 3, 4, 5].map((attempt) => nextDelay(attempt, 5, 60));
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('kick reason text from a JSON chat component', () => {
  const reason = JSON.stringify({ translate: 'multiplayer.disconnect.not_whitelisted' });
  assert.equal(reasonText(reason), 'multiplayer.disconnect.not_whitelisted');
});

test('kick reason text from plain text with extra parts', () => {
  assert.equal(reasonText({ text: 'You are ', extra: [{ text: 'banned' }] }), 'You are banned');
});

test('kick reason text from an NBT chat component', () => {
  const reason = {
    type: 'compound',
    value: {
      translate: { type: 'string', value: 'multiplayer.disconnect.not_whitelisted' }
    }
  };
  assert.equal(reasonText(reason), 'multiplayer.disconnect.not_whitelisted');
});

test('whitelist, ban and outdated kicks are permanent', () => {
  assert.ok(isPermanentKick('multiplayer.disconnect.not_whitelisted'));
  assert.ok(isPermanentKick('You are not white-listed on this server!'));
  assert.ok(isPermanentKick('You are banned from this server.'));
  assert.ok(isPermanentKick('Outdated client! Please use 26.3'));
});

test('a normal disconnect is not permanent', () => {
  assert.equal(isPermanentKick('Server closed'), false);
  assert.equal(isPermanentKick('Timed out'), false);
});
