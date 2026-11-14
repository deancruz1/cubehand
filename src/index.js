import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, ConfigError } from './config.js';
import { startBot } from './connection.js';
import { ChatHistory, RequestLog, classifyMessage, chatBody } from './chat.js';
import { buildSnapshot } from './perception.js';
import { Brain } from './brain.js';
import { Memory } from './memory.js';
import { PlacedLog } from './placed.js';
import { runAction } from './actions/index.js';
import { chatLines } from './actions/chat.js';
import { findPlayer } from './actions/movement.js';
import { smeltSummary } from './actions/furnace.js';
import { AreaRecorder, TravelLog } from './areas.js';
import { Survival } from './survival.js';
import { Idle } from './idle.js';
import { Status } from './status.js';

function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const history = new ChatHistory(config.perception.chatHistory);
const requests = new RequestLog();
const memory = new Memory();
const placed = new PlacedLog();
const areas = new AreaRecorder();
const travel = new TravelLog();
const smeltJobs = new Map();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: config.claude.maxRetries });

let connection;
const currentBot = () => connection?.getBot();

// Everything the bot says goes through the chat guard first.
function say(text) {
  const bot = currentBot();
  if (!bot?.entity) return;
  const { parts, blocked, reason } = chatLines(text);
  if (blocked) {
    log(`[guard] kept out of chat (${blocked}): ${text}`);
    bot.chat("I'd rather not say that.");
  } else if (reason === 'too long') {
    log(`[guard] cut a long reply short: ${text}`);
  }
  for (const part of parts) bot.chat(part);
  status.spoke();
}

const status = new Status({
  getBot: currentBot,
  say,
  log,
  isBusy: () => brain.busy && !brain.current?.self,
  stuckSeconds: config.limits.stuckSeconds,
  quietSeconds: config.limits.quietSeconds
});
// requester is the player whose job is running, or null for the bot's own chores.
const makeCtx = (signal) => ({ bot: currentBot(), config, signal, memory, placed, areas, smeltJobs, status, log, requester: brain.current?.self ? null : brain.current?.player ?? null });

function snapshot() {
  const bot = currentBot();
  const notes = [status.summary(), memory.summary(bot.entity.position), requests.summary(), areas.status(), travel.summary(), smeltSummary(smeltJobs)].filter(Boolean).join('\n\n');
  return buildSnapshot(bot, config, history.list(), notes);
}

// Wakes the bot if it's in bed, so it can move again.
async function wakeUp() {
  const bot = currentBot();
  if (!bot?.isSleeping) return;
  const woke = new Promise((resolve) => {
    bot.once('wake', resolve);
    setTimeout(resolve, 2000);
  });
  await bot.wake().catch(() => {});
  await woke;
}

const brain = new Brain({
  client,
  config,
  log,
  say,
  snapshot,
  runTool: (name, input, signal) => runAction(makeCtx(signal), name, input),
  onStop: () => currentBot()?.pathfinder?.setGoal(null),
  onJobStart: async () => {
    await idle.interrupt();
    await wakeUp();
  },
  beforeStep: () => survival.eatIfHungry(),
  watchTool: (name, controller) => status.watch(name, controller)
});
const survival = new Survival({ getBot: currentBot, brain, config, makeCtx, log, say, stopChores: () => idle.interrupt() });
const idle = new Idle({ getBot: currentBot, brain, survival, config, makeCtx, log, smeltJobs, placed });
survival.start();
idle.start();
status.start();
setInterval(() => {
  const bot = currentBot();
  if (bot?.entity) travel.record(bot.entity.position);
}, 5000);

function onMessage(username, message, whisper) {
  const result = classifyMessage({ username, message, whisper }, { botName: config.bot.username, allowlist: config.allowlist });
  // Keep the bot's own lines too, so the next request knows what it last said.
  if (!whisper) history.add(username, message);
  if (result.type === 'ignore') return;
  lookAtPlayer(username);
  if (result.type === 'stop') {
    // Stand still for a bit instead of going straight back to chores.
    idle.hold(60000);
    brain.stop();
  } else if (result.type === 'request') {
    // Where they stood, so "here" or "this hill" still means something later.
    const bot = currentBot();
    requests.add(username, result.text, bot?.entity ? findPlayer(bot, username)?.position : null);
    brain.enqueue(username, result.text);
  }
}

// Turn to whoever is talking, like a player would. Walking turns the head back on its own.
function lookAtPlayer(username) {
  const bot = currentBot();
  if (!bot?.entity) return;
  const entity = findPlayer(bot, username);
  if (entity && entity.position.distanceTo(bot.entity.position) <= 32) {
    bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0)).catch(() => {});
  }
}

let stopping = false;

connection = startBot(config, {
  log,
  onCreate: (bot) => {
    bot.placedLog = placed;
    // Find the sender by UUID instead of parsing the name, so team prefixes don't break it.
    bot.on('messagestr', (message, position, jsonMsg, sender) => {
      log(`[chat:${position}] ${message}`);
      if (position !== 'chat') return;
      const username = Object.values(bot.players).find((p) => p.uuid === sender)?.username;
      if (!username) {
        log(`[chat] could not tell who sent that (sender id: ${sender ?? 'none'})`);
        return;
      }
      onMessage(username, chatBody(message, username), false);
    });
    bot.on('whisper', (username, message) => onMessage(username, message, true));
    bot.on('move_stuck', (text) => {
      log(`[move] ${text}`);
      status.noteStuck(text);
    });
    bot.on('craft_trouble', (text) => log(`[craft] ${text}`));
    bot.on('health', () => survival.check());
    bot.on('move_blocked', (username) => say(`Excuse me ${username}, you're in my way.`));

    // Standing around between jobs, now and then look at a player close by.
    const glance = setInterval(() => {
      if (brain.busy || idle.running || !bot.entity || bot.pathfinder?.isMoving() || Math.random() < 0.4) return;
      const here = bot.entity.position;
      const near = Object.values(bot.players)
        .map((p) => p.entity)
        .filter((e) => e && e !== bot.entity && e.position.distanceTo(here) <= 6);
      if (near.length === 0) return;
      const entity = near[Math.floor(Math.random() * near.length)];
      bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0)).catch(() => {});
    }, 3000);
    bot.once('end', () => clearInterval(glance));
  },
  onDeath: () => {
    brain.abortCurrent('death');
    idle.interrupt();
  },
  onEnd: () => brain.abortCurrent('shutdown'),
  onStopped: () => {
    log('Bot stopped.');
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  log(`Crash: ${err.stack ?? err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled error: ${err?.stack ?? err}`);
});

process.on('SIGINT', () => {
  if (stopping) process.exit(0);
  stopping = true;
  log('Shutting down...');
  brain.queue = [];
  brain.abortCurrent('shutdown');
  connection.shutdown();
  setTimeout(() => process.exit(0), 3000).unref();
});
