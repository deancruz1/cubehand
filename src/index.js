import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, ConfigError } from './config.js';
import { startBot, readChat } from './connection.js';
import { Auth } from './auth.js';
import { ChatHistory, RequestLog, classifyMessage } from './chat.js';
import { buildSnapshot, standingSummary } from './perception.js';
import { Brain } from './brain.js';
import { Standing } from './standing.js';
import { Memory } from './memory.js';
import { PlacedLog, ScaffoldLog } from './placed.js';
import { ChestIndex } from './chests.js';
import { runAction } from './actions/index.js';
import { chatLines } from './actions/chat.js';
import { findPlayer } from './actions/movement.js';
import { smeltSummary } from './actions/furnace.js';
import { posText, setPauseScale } from './actions/util.js';
import { AreaRecorder, TravelLog } from './areas.js';
import { Survival } from './survival.js';
import { Idle } from './idle.js';
import { Status } from './status.js';
import { Gestures } from './gestures.js';
import { Reflex } from './reflex.js';
import { JobLog, LogFile, RefusalLog } from './joblog.js';
import { Lessons, isCorrection } from './lessons.js';
import { Skills } from './skills.js';
import { TOOLS } from './tools.js';

const logFile = new LogFile('logs/bot.log');

function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
  logFile.write(message);
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
setPauseScale(config.bot.pauseScale);

const history = new ChatHistory(config.perception.chatHistory);
const requests = new RequestLog();
const memory = new Memory();
const placed = new PlacedLog();
const scaffold = new ScaffoldLog();
const chests = new ChestIndex();
const standing = new Standing('standing.json');
const areas = new AreaRecorder();
const travel = new TravelLog();
const smeltJobs = new Map();
const lessons = config.learning.lessons ? new Lessons('lessons.json', { ignore: [config.bot.username, ...config.allowlist], log }) : null;
const skills = config.learning.skills ? new Skills({ tools: TOOLS }) : null;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: config.claude.maxRetries });
// Off unless CUBEHAND_PASSPHRASE is set. The passphrase stays here and never goes into config.
const auth = new Auth({ passphrase: process.env.CUBEHAND_PASSPHRASE, allowlist: config.allowlist, admins: config.admins, botName: config.bot.username, ...config.security, log });

let connection;
const currentBot = () => connection?.getBot();
// When the connection dropped, while the bot is waiting to join again.
let offlineSince = null;

// Everything the bot says goes through the chat guard first. With a player name in to, it goes
// to them as a whisper.
function say(text, to = null) {
  const bot = currentBot();
  if (!bot?.entity || offlineSince !== null) return;
  const send = (line) => (to ? bot.whisper(to, line) : bot.chat(line));
  const { parts, blocked, reason } = chatLines(text);
  if (blocked) {
    log(`[guard] kept out of chat (${blocked}): ${text}`);
    send("I'd rather not say that.");
  } else if (reason === 'too long') {
    log(`[guard] cut a long reply short: ${text}`);
  }
  for (const part of parts) send(part);
  status.spoke();
  gestures.said(brain.current);
}

const status = new Status({
  getBot: currentBot,
  say: (text) => say(text, brain.replyTo),
  log,
  // Rounds of the standing job don't fill the silences either: a player wouldn't narrate every tunnel.
  isBusy: () => brain.busy && !brain.current?.self && !brain.current?.standing,
  stuckSeconds: config.limits.stuckSeconds,
  quietSeconds: config.limits.quietSeconds
});
// requester is the player whose job is running, or null for the bot's own chores.
const makeCtx = (signal) => ({ bot: currentBot(), config, signal, memory, placed, areas, smeltJobs, status, skills, log, requester: brain.current?.self ? null : brain.current?.player ?? null });

function snapshot() {
  const bot = currentBot();
  const notes = [status.summary(), standingSummary(brain.standingJob), memory.summary(bot.entity.position), skills?.summary(), requests.summary(), areas.status(), travel.summary(), smeltSummary(smeltJobs)].filter(Boolean).join('\n\n');
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
  jobLog: new JobLog('jobs.jsonl', log),
  refusalLog: new RefusalLog('logs/refusals', 20, log),
  forgetRequests: (before) => requests.forget(before),
  forgetChat: (before) => history.forget(before),
  lessons,
  standing,
  skills,
  say,
  snapshot,
  runTool: (name, input, signal, requester) => {
    reflex.toolStarting(brain.current);
    const ctx = makeCtx(signal);
    return runAction(requester ? { ...ctx, requester } : ctx, name, input);
  },
  onStop: () => currentBot()?.pathfinder?.setGoal(null),
  onJobStart: async () => {
    await idle.interrupt();
    await wakeUp();
  },
  beforeStep: () => survival.eatIfHungry(),
  watchTool: (name, controller) => status.watch(name, controller),
  onThinking: (active, job) => gestures.think(active, job)
});
// Nothing starts before the bot has spawned.
brain.pause('offline');
const survival = new Survival({
  getBot: currentBot,
  brain,
  config,
  makeCtx,
  log,
  say,
  stopChores: () => {
    reflex.cancel();
    return idle.interrupt();
  }
});
const idle = new Idle({ getBot: currentBot, brain, survival, config, makeCtx, log, smeltJobs, placed, scaffold, memory, reflexWalking: () => reflex.walking });
const reflex = new Reflex({ getBot: currentBot, brain, idle, config, makeCtx, log, say });
const gestures = new Gestures({ getBot: currentBot, brain, survival, idle, config, toolRunning: () => Boolean(status.run || brain.current?.tool || reflex.walking) });
survival.start();
idle.start();
status.start();
setInterval(() => {
  const bot = currentBot();
  if (bot?.entity) travel.record(bot.entity.position);
}, 5000);

function onMessage(username, message, whisper) {
  // With a passphrase set, a player on the allowlist who hasn't whispered it counts as off the
  // list for everything below, and a whisper about the passphrase goes no further than here.
  const screen = auth.screen({ username, message, whisper });
  for (const { text, to } of screen.replies) say(text, to);
  if (screen.drop) return;
  message = screen.message;
  const allowlist = auth.trustedList();
  const result = classifyMessage({ username, message, whisper }, { botName: config.bot.username, allowlist });
  // Keep the bot's own lines too, so the next request knows what it last said.
  if (!whisper) history.add(auth.label(username), message);
  if (result.type === 'ignore') return;
  // "no, the other chest" counts against the job it's about, named or not. It goes in before the
  // message itself, which can start a new job of theirs.
  const allowed = allowlist.some((p) => p.toLowerCase() === username.toLowerCase());
  if (allowed && result.type !== 'stop' && isCorrection(message, [config.bot.username])) brain.correct(username, message);
  gestures.notice(username);
  if (result.type === 'stop') {
    // Stand still for a bit instead of going straight back to chores.
    idle.hold(60000);
    reflex.cancel();
    brain.stop(whisper ? username : null, username);
  } else if (result.type === 'request') {
    // Where they stood, so "here" or "this hill" still means something later.
    const bot = currentBot();
    requests.add(username, result.text, bot?.entity ? findPlayer(bot, username)?.position : null);
    // A plain come, follow or stay starts moving now, before the model has answered.
    const kind = reflex.fire(username, result, whisper);
    brain.enqueue(username, result.text, whisper, kind);
  }
}

let stopping = false;

connection = startBot(config, {
  log,
  // A job and the queue wait out a dropped connection and carry on once the bot is back.
  onSpawn: (bot) => {
    if (offlineSince === null) return brain.resume('offline');
    const seconds = Math.round((Date.now() - offlineSince) / 1000);
    offlineSince = null;
    brain.resume('offline', `The connection to the server dropped for ${seconds} seconds and you have joined again, at ${posText(bot.entity.position)}.`);
  },
  onCreate: (bot) => {
    bot.placedLog = placed;
    bot.walkScaffold = scaffold;
    bot.chestIndex = chests;
    // Find the sender by UUID instead of parsing the name, so team prefixes don't break it. Whispers
    // are read here too: Mineflayer's whisper event takes the name from the text, which public
    // chat, a "/me" or a server line can fake, so it is not used.
    let warnedNoSender = false;
    bot.on('messagestr', (message, position, jsonMsg, sender) => {
      log(`[chat:${position}] ${auth.mask(message)}`);
      const line = readChat(bot.players, message, position, sender);
      if (line?.unknown) {
        log(`[chat] could not tell who sent that (sender id: ${sender ?? 'none'})`);
      } else if (line?.serverWhisper) {
        if (!warnedNoSender) log('[chat] a whisper came in as a server line with no sender id, so it was not used');
        warnedNoSender = true;
      } else if (line) {
        onMessage(line.username, line.text, line.whisper);
      }
    });
    bot.on('playerLeft', (player) => auth.left(player?.username));
    bot.on('move_stuck', (text) => {
      log(`[move] ${text}`);
      status.noteStuck(text);
    });
    bot.on('craft_trouble', (text) => log(`[craft] ${text}`));
    bot.on('health', () => survival.check());
    bot.on('move_blocked', (username) => say(`Excuse me ${username}, you're in my way.`));

    // Standing around between jobs, now and then look at a player close by.
    const glance = setInterval(() => {
      if (brain.busy || idle.running || reflex.walking || !bot.entity || bot.pathfinder?.isMoving() || Math.random() < 0.4) return;
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
    brain.died();
    reflex.cancel();
    idle.interrupt();
  },
  onEnd: ({ reconnecting }) => {
    auth.reset();
    reflex.cancel();
    if (!reconnecting) {
      brain.close();
      return brain.abortCurrent('shutdown');
    }
    offlineSince ??= Date.now();
    brain.pause('offline');
  },
  // The job that was running gets a moment to end and write its log line, and nothing new starts.
  onStopped: async () => {
    log('Bot stopped.');
    brain.close();
    brain.queue = [];
    await brain.settle(2000);
    lessons?.save();
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  log(`Crash: ${err.stack ?? err}`);
  lessons?.save();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled error: ${err?.stack ?? err}`);
});

process.on('SIGINT', () => {
  if (stopping) {
    lessons?.save();
    process.exit(0);
  }
  stopping = true;
  log('Shutting down...');
  brain.close();
  brain.queue = [];
  brain.abortCurrent('shutdown');
  connection.shutdown();
  setTimeout(() => {
    lessons?.save();
    process.exit(0);
  }, 3000).unref();
});
