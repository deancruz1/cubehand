import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ago } from './areas.js';

const MAX_REQUESTS = 15;
const KEEP_REQUESTS_MS = 12 * 3600000;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Decides what to do with one chat line: ignore it, keep it as history, stop, or send it to Claude.
export function classifyMessage({ username, message, whisper = false }, { botName, allowlist }) {
  if (username.toLowerCase() === botName.toLowerCase()) return { type: 'ignore' };

  const name = escapeRegex(botName);
  const mentioned = whisper || new RegExp(`\\b${name}\\b`, 'i').test(message);
  const allowed = allowlist.some((p) => p.toLowerCase() === username.toLowerCase());
  if (!mentioned || !allowed) return { type: 'history' };

  if (isStop(message, name)) return { type: 'stop' };
  return { type: 'request', text: message };
}

const STOP = /^(?:please )?(?:stop|pause|halt|cancel)(?: (?:here|now|that|it|please|everything|what you(?:'|’)?re doing|what you are doing)){0,3}$/;

// "stop", "pause.", "Clodine, stop here", "stop it now please", "cancel that Clodine". Anything
// that goes on to ask for something else ("stop by the farm") is a request.
function isStop(message, name) {
  const words = message
    .toLowerCase()
    .replace(new RegExp(`@?\\b${name}\\b`, 'gi'), ' ')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return STOP.test(words);
}

// The chat line can carry team prefixes like "<<Team> Name> hi", so cut everything up to "Name> ".
export function chatBody(line, username) {
  const marker = `${username}> `;
  const i = line.indexOf(marker);
  return i >= 0 ? line.slice(i + marker.length) : line;
}

export class ChatHistory {
  constructor(limit) {
    this.limit = limit;
    this.messages = [];
  }

  add(username, message) {
    this.messages.push({ username, message });
    if (this.messages.length > this.limit) this.messages.shift();
  }

  list() {
    return [...this.messages];
  }
}

// Requests players sent the bot, with where the player stood, saved to a file. Players often
// give one job in pieces ("build a house", later "make it 12x12", "it goes on this hill") and
// say "resume" after a restart, so later jobs need the earlier pieces.
export class RequestLog {
  constructor(path = 'requests.json') {
    this.path = path;
    this.entries = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  add(player, text, pos, now = Date.now()) {
    const entry = { time: now, player, text };
    if (pos) entry.pos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    this.entries = [...this.entries, entry].filter((e) => now - e.time <= KEEP_REQUESTS_MS).slice(-MAX_REQUESTS);
    if (this.path) writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  summary(now = Date.now()) {
    const recent = this.entries.filter((e) => now - e.time <= KEEP_REQUESTS_MS);
    if (recent.length === 0) return 'Recent requests to you: none';
    const lines = recent.map((e) => `- ${ago(now - e.time)}, ${e.player}${e.pos ? ` standing at ${e.pos.x} ${e.pos.y} ${e.pos.z}` : ''}: ${e.text}`);
    return `Recent requests to you (oldest first, with where the player stood):\n${lines.join('\n')}`;
  }
}
