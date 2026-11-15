import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setupMovements } from './actions/movement.js';

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

    // Real clients end every tick with tick_end on 1.21.2+. Mineflayer doesn't, and
    // without it the server kicks the bot for invalid_player_movement.
    if (bot.supportFeature('sendsClientTickEndPacket')) {
      bot.on('physicsTick', () => bot._client.write('tick_end', {}));
    }

    let deathPos = null;
    let firstSpawn = true;

    bot.once('spawn', () => setupMovements(bot));

    bot.on('spawn', () => {
      const pos = bot.entity.position.floored();
      if (firstSpawn) {
        firstSpawn = false;
        attempt = 0;
        log(`Spawned as ${bot.username} at ${pos.x} ${pos.y} ${pos.z}`);
        hooks.onSpawn?.(bot);
      } else if (deathPos) {
        bot.chat(`I died at ${deathPos.x} ${deathPos.y} ${deathPos.z}.`);
        deathPos = null;
      }
    });

    bot.on('death', () => {
      deathPos = bot.entity.position.floored();
      log(`Died at ${deathPos.x} ${deathPos.y} ${deathPos.z}`);
      hooks.onDeath?.(bot, deathPos);
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
