import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setupMovements } from './actions/movement.js';
import { fixToolMaterials } from './actions/blocks.js';
import { chatBody } from './chat.js';

const { pathfinder } = pathfinderPkg;

const PERMANENT_KICKS = [
  /whitelist/i,
  /white-listed/i,
  /banned/i,
  /outdated/i,
  /incompatible/i
];

export function nextDelay(attempt, baseSeconds, maxSeconds) {
  return Math.min(baseSeconds * 2 ** attempt, maxSeconds) * 1000;
}

// Newer versions send chat components as NBT: { type, value } wrappers all the way down.
export function unwrapNbt(value) {
  if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
    if (value.type === 'compound') {
      return Object.fromEntries(Object.entries(value.value).map(([k, v]) => [k, unwrapNbt(v)]));
    }
    if (value.type === 'list') return (value.value.value ?? []).map((v) => unwrapNbt({ type: value.value.type, value: v }));
    return value.value;
  }
  return value;
}

// Kick reasons can be plain strings, JSON strings, chat component objects, or NBT.
export function reasonText(reason) {
  if (reason == null) return '';
  if (typeof reason === 'object' && 'type' in reason && 'value' in reason) return reasonText(unwrapNbt(reason));
  if (typeof reason === 'string') {
    try {
      return reasonText(JSON.parse(reason));
    } catch {
      return reason;
    }
  }
  if (typeof reason !== 'object') return String(reason);
  if (typeof reason.toString === 'function' && reason.toString !== Object.prototype.toString) {
    return reason.toString();
  }
  let text = reason.text ?? reason.translate ?? '';
  if (Array.isArray(reason.with)) text += ' ' + reason.with.map(reasonText).join(' ');
  if (Array.isArray(reason.extra)) text += reason.extra.map(reasonText).join('');
  return text.trim();
}

export function isPermanentKick(text) {
  return PERMANENT_KICKS.some((pattern) => pattern.test(text));
}

// The prefix Mineflayer allows before a name, like a team tag.
const NAME_PREFIX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?';
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whispers come in on the chat position too: "Alice whispers to you: hi" from sender Alice,
// "You whisper to Alice: hi" for the bot's own, or "[Alice -> me] hi". Mineflayer's whisper
// event already reports the incoming ones, by the same patterns.
export function isWhisperLine(line, sender) {
  return (
    line.startsWith('You whisper to ') ||
    new RegExp(`^${NAME_PREFIX}${escapeRegex(sender)} whispers(?: to you)?:? `).test(line) ||
    new RegExp(`^\\[${NAME_PREFIX}\\w+ -> \\w+\\s?\\] `).test(line)
  );
}

// What sender whispered to the bot in line, or null when line is no whisper from them. Unlike
// Mineflayer's whisper event, the sender is the one the server named, not a name read out of
// the text, which public chat from a player with a short name ("<Bo> Alice whispers to you: hi"),
// a "/me" or any system line could fake.
export function whisperBody(line, sender) {
  const name = escapeRegex(sender);
  const match =
    new RegExp(`^${NAME_PREFIX}${name} whispers(?: to you)?:? (.*)$`, 's').exec(line) ??
    new RegExp(`^\\[${NAME_PREFIX}${name} -> \\w+\\s?\\] (.*)$`, 's').exec(line);
  return match ? match[1] : null;
}

// One line from Mineflayer's messagestr event as { username, text, whisper }, with the sender
// taken from the id the server sent with it, never from the text. null for a line to leave alone,
// { unknown: true } for player chat from someone not in the player list, and { serverWhisper: true }
// for a server line that reads like a whisper, which has no sender id and could be anyone's.
export function readChat(players, line, position, sender) {
  const list = Object.values(players ?? {});
  if (position !== 'chat') return list.some((p) => whisperBody(line, p.username) !== null) ? { serverWhisper: true } : null;
  const username = list.find((p) => p.uuid === sender)?.username;
  if (!username) return { unknown: true };
  if (isWhisperLine(line, username)) {
    const body = whisperBody(line, username);
    return body === null ? null : { username, text: body, whisper: true };
  }
  return { username, text: chatBody(line, username), whisper: false };
}

// An item's enchantments as prismarine-block's digTime takes them: [{ name, lvl }]. From 1.20.5
// on they come as an enchantments component, { enchantments: [{ id, level }] }, where id is the
// enchantment's place in the registry the server sent (names). Anything unreadable counts as none.
export function enchantList(item, names = [], registry = null) {
  try {
    const list = item?.enchants;
    if (Array.isArray(list)) return list.filter((e) => e && typeof e.name === 'string');
    if (!Array.isArray(list?.enchantments)) return [];
    return list.enchantments
      .map(({ id, level }) => ({ name: names[id] ?? registry?.enchantments?.[id]?.name ?? null, lvl: level }))
      .filter((e) => typeof e.name === 'string' && e.lvl > 0);
  } catch {
    return [];
  }
}

// Mineflayer's bot.digTime, with the held item's and helmet's enchantments read by enchantList.
// Mineflayer's own throws for an enchanted tool from 1.20.5 on, so every dig fails.
export function digTimeFor(bot, block, names = []) {
  const held = bot.heldItem;
  let helmet = null;
  try {
    helmet = bot.inventory.slots[bot.getEquipmentDestSlot('head')];
  } catch {}
  const enchantments = [...enchantList(held, names, bot.registry), ...enchantList(helmet, names, bot.registry)];
  return block.digTime(
    held ? held.type : null,
    bot.game.gameMode === 'creative',
    ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
    !bot.entity.onGround,
    enchantments,
    bot.entity.effects
  );
}

// Loaded after Mineflayer's own plugins, so it replaces their digTime. The enchantment names
// come from the server's registry, in the order its ids count. The ores' tool materials are put
// right here too (fixToolMaterials), so walks that dig through ore use the pickaxe's speed.
export function safeDigTime(bot) {
  fixToolMaterials(bot.registry);
  let names = [];
  bot._client.on('registry_data', (packet) => {
    if (packet?.id?.replace(/^minecraft:/, '') !== 'enchantment' || !Array.isArray(packet.entries)) return;
    names = packet.entries.map((e) => String(e.key).replace(/^minecraft:/, ''));
  });
  bot.digTime = (block) => digTimeFor(bot, block, names);
}

// The death line's text when it came within DEATH_LINE_MS of the death, or null. Servers can turn
// death messages off, and then there is none.
const DEATH_LINE_MS = 5000;
export function deathCause(line, diedAt) {
  return line && Math.abs(line.at - diedAt) <= DEATH_LINE_MS ? line.text : null;
}

export function startBot(config, hooks = {}) {
  const log = hooks.log ?? console.log;
  let bot = null;
  let attempt = 0;
  let stopRetrying = false;
  let shuttingDown = false;
  let retryTimer = null;

  function connect() {
    log(`Connecting to ${config.server.host}:${config.server.port} as ${config.bot.username} (version ${config.server.version})...`);
    bot = mineflayer.createBot({
      host: config.server.host,
      port: config.server.port,
      username: config.bot.username,
      version: config.server.version,
      auth: 'offline'
    });
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(safeDigTime);

    // Real clients end every tick with tick_end on 1.21.2+. Mineflayer doesn't, and
    // without it the server kicks the bot for invalid_player_movement.
    if (bot.supportFeature('sendsClientTickEndPacket')) {
      bot.on('physicsTick', () => bot._client.write('tick_end', {}));
    }

    let death = null;
    let firstSpawn = true;
    // The server's death line ("Clodine tried to swim in lava") is a system line that starts with
    // her name, sent around the time she dies.
    let deathLine = null;
    bot.on('messagestr', (message, position) => {
      if (position === 'system' && message.startsWith(`${bot.username} `)) deathLine = { text: message, at: Date.now() };
    });

    bot.once('spawn', () => setupMovements(bot));

    bot.on('spawn', () => {
      const pos = bot.entity.position.floored();
      if (firstSpawn) {
        firstSpawn = false;
        attempt = 0;
        log(`Spawned as ${bot.username} at ${pos.x} ${pos.y} ${pos.z}`);
        hooks.onSpawn?.(bot);
      } else if (death) {
        const { x, y, z } = death.pos;
        bot.chat(`I died at ${x} ${y} ${z}.`);
        const cause = deathCause(deathLine, death.at);
        if (cause) log(`Death message: ${cause}`);
        hooks.onRespawn?.(bot, { ...death, cause });
        death = null;
        deathLine = null;
      }
    });

    bot.on('death', () => {
      const pos = bot.entity.position.floored();
      death = { pos, dimension: bot.game?.dimension ?? null, at: Date.now() };
      log(`Died at ${pos.x} ${pos.y} ${pos.z}`);
      hooks.onDeath?.(bot, death);
    });

    bot.on('kicked', (reason) => {
      const text = reasonText(reason);
      log(`Kicked: ${text || '(no readable reason)'}`);
      if (!text) log(`Raw kick reason: ${JSON.stringify(reason)}`);
      if (isPermanentKick(text)) {
        stopRetrying = true;
        log('This kick reason will not go away on its own, so I will not reconnect.');
      }
    });

    bot.on('error', (err) => {
      log(`Connection error: ${err.message}`);
    });

    bot.on('end', (reason) => {
      log(`Disconnected: ${reason}`);
      hooks.onEnd?.({ reconnecting: !shuttingDown && !stopRetrying });
      if (shuttingDown || stopRetrying) {
        hooks.onStopped?.();
        return;
      }
      scheduleReconnect();
    });

    hooks.onCreate?.(bot);
  }

  function scheduleReconnect() {
    if (retryTimer) return;
    const delay = nextDelay(attempt, config.reconnect.baseDelaySeconds, config.reconnect.maxDelaySeconds);
    attempt += 1;
    log(`Reconnecting in ${delay / 1000}s...`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function shutdown() {
    shuttingDown = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
      hooks.onStopped?.();
      return;
    }
    try {
      bot?.pathfinder?.setGoal(null);
      bot?.quit();
    } catch {
      hooks.onStopped?.();
    }
  }

  connect();

  return {
    getBot: () => bot,
    shutdown
  };
}
