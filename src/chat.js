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

  const stop = stopKind(message, botName);
  if (stop === 'stop') return { type: 'stop' };
  // The body stops at once, and the whole message then goes to Claude for the rest of it.
  if (stop === 'more') return { type: 'stop', text: message };
  return { type: 'request', text: message };
}

const STOP_LEAD = String.raw`^(?:(?:please|no|hey|ok|okay|oh|oi|just|now|wait)\s+)*`;
const STOP_WORD = String.raw`(?:stop|pause|halt|cancel)`;
const STOP = new RegExp(`${STOP_LEAD}${STOP_WORD}(?: (?:${STOP_WORD}|here|now|right|there|at once|that|this|it|please|all|everything|moving|what you(?:'|’)?re doing|what you are doing)){0,4}$`);
// What comes after a stop word at the start, unless it's about a place or a later time ("stop by
// the farm", "stop at the river", "pause when able", "stop once the tunnel is done").
const STOP_THEN = new RegExp(`${STOP_LEAD}${STOP_WORD} (?!(?:by|at(?! once)|in|on|over|to|for|when|whenever|once|after|before|if|unless|until|till|as soon as)\\b)(.+)$`);
// Only what to stop doing: "breaking", "strip mining the wall".
const DOING = /^(?:\S+ )?(?!(?:bring|thing|nothing|something|anything|everything)\b)\S+ing\b/;
const GOES_ON = /\b(?:and|then|but|instead|so|come|follow|go|get|bring|stay|wait)\b/;

// 'stop' for a plain stop ("pause.", "Clodine, stop here", "stop it now please", "cancel that
// Clodine", "stop breaking"), 'more' for a stop that goes on to ask for something else ("stop and
// come here", "stop what you are doing and come here"), and null for anything else.
function stopKind(message, botName) {
  const name = escapeRegex(botName);
  const words = plainWords(message, name);
  if (STOP.test(words)) return 'stop';
  const rest = words.match(STOP_THEN)?.[1];
  // "stop following me" is the stay reflex.
  if (!rest || reflexFor(message, botName)) return null;
  const only = DOING.test(rest) && !GOES_ON.test(rest) && clauses(message, name).length === 1 && !isStandingOrder(message, botName);
  return only ? 'stop' : 'more';
}

// The message in lower case without the bot's name or punctuation.
function plainWords(message, name) {
  return message
    .toLowerCase()
    .replace(new RegExp(`@?\\b${name}\\b`, 'gi'), ' ')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LASTING = /\b(?:from now on(?:wards)?|from here on|going forward|in (?:the )?future|at all times|always|never|when ?ever|every ?time|any ?time|each time|this is (?:an instruction|an order|a rule)|standing order|remember (?:that|this|to)|(?:do not|don't|dont) ever)\b/;
// Those words where they set no rule: "never mind", "I never said that", "you always dig up".
const NOT_LASTING = /\b(?:never ?mind|(?:i|you|we|she|he|they|it)(?:['’](?:ve|d|s|re|m)| have| has| had| do| does| did| is| are| was| were| am)? (?:never|always)|always wanted)\b/g;
const QUESTION = /^(?:why|what|how|who|which|where|tell me (?:why|what|how|if|whether)|explain|(?:do|does|did|are|is|have|has) (?:you|i|we|she|he|it|they))\b/;

// A request that sets a rule meant to outlast the job: "from now on ...", "never deviate from
// y -59", "this is an instruction, ...". Questions and one-off orders are not.
export function isStandingOrder(message, botName) {
  if (!message || message.includes('?')) return false;
  const words = plainWords(message, escapeRegex(botName));
  return !QUESTION.test(words) && LASTING.test(words.replace(NOT_LASTING, ' '));
}

const REFLEXES = {
  come: /^(?:please )?(?:come(?: here| over(?: here)?| to me)?|over here)(?: please)?$/,
  follow: /^(?:please )?(?:follow(?: me)?|come with me)(?: please)?$/,
  stay: /^(?:please )?(?:stay(?: here)?|wait(?: here)?|stop following(?: me)?)(?: please)?$/
};

// 'come', 'follow' or 'stay' for a message that is only that order ("Clodine, come here!",
// "follow me please"), so the body can start before the model has read it. Anything more
// ("come to the farm", "follow Alex") is null and goes the usual way.
export function reflexFor(message, botName) {
  const words = plainWords(message, escapeRegex(botName));
  return Object.keys(REFLEXES).find((kind) => REFLEXES[kind].test(words)) ?? null;
}

const WORK_LEAD = String.raw`^(?:(?:ok|okay|yes|yeah|so|now|then|and|also|just|please|go|start|keep|can you|could you|would you|will you|you can)\s+)*`;
// "mine" as the pronoun ("mine is the red one") is not an order.
const WORK_VERB = String.raw`(?:mine(?! (?:is|was|are|has|had|too|either)\b)|mining|dig|digging|tunnel|chop|chopping|gather|collect|craft|smelt|store|deposit|fetch)\b`;
const WORK = new RegExp(`${WORK_LEAD}${WORK_VERB}`);
const STRIP_MINE = /(?<!\b(?:stop|quit|no more|don't|dont|do not|never)\s+)\bstrip[ -]?min(?:e|es|ing)\b/;
// A message that opens with a reflex word is about where she goes, not work: "follow me into the
// strip mine".
const GOES = /^(?:please )?(?:come|follow|stay)\b/;
const CONTINUE = new RegExp(`${WORK_LEAD}(?:continue|resume|proceed|keep going|carry on)(?: (?:it|that|with it|on|now|please|where you left off))*$`);

// The parts of a message between punctuation, in lower case without the bot's name.
function clauses(message, name) {
  return message
    .toLowerCase()
    .replace(new RegExp(`@?\\b${name}\\b`, 'gi'), ' ')
    .split(/[.,;:!]+/)
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 'work' for an obvious order to mine, dig, chop, gather, craft, smelt, store or fetch ("strip mine
// autonomously", "dig only y -58 and y -59", "continue the strip mine"), 'continue' for a bare
// "continue", "resume" or "proceed", and null for anything else: questions, chat, rules meant to
// last and other orders stay with the quick model.
export function workOrder(message, botName) {
  if (!message || message.includes('?') || isStandingOrder(message, botName)) return null;
  const name = escapeRegex(botName);
  if (QUESTION.test(plainWords(message, name))) return null;
  const parts = clauses(message, name);
  if (!parts.length || GOES.test(parts[0])) return null;
  if (parts.some((c) => STRIP_MINE.test(c) || WORK.test(c))) return 'work';
  return parts.length === 1 && CONTINUE.test(parts[0]) ? 'continue' : null;
}

const THOUGHT_QUESTION = /\b(?:thought process|(?:your|ur) reasoning|chain of thought|what (?:are|were|r) (?:you|u) thinking|(?:disclose|reveal|show)(?: me| us)? (?:your|ur) (?:thinking|thoughts))\b/;
export const THOUGHT_SUMMARY = 'asked what I was doing';

// A request that asks for her reasoning ("what is your thought process", "reveal your thinking").
export function asksForThoughts(message) {
  return THOUGHT_QUESTION.test(String(message ?? '').toLowerCase());
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

  add(username, message, now = Date.now()) {
    this.messages.push({ username, message, time: now });
    if (this.messages.length > this.limit) this.messages.shift();
  }

  // Drops the lines said up to before.
  forget(before = Date.now()) {
    this.messages = this.messages.filter((m) => m.time > before);
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

  // A request for her reasoning is kept only as a neutral line, so later jobs don't carry its wording.
  add(player, text, pos, now = Date.now()) {
    const entry = { time: now, player, text: asksForThoughts(text) ? THOUGHT_SUMMARY : text };
    if (pos) entry.pos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    this.entries = [...this.entries, entry].filter((e) => now - e.time <= KEEP_REQUESTS_MS).slice(-MAX_REQUESTS);
    if (this.path) writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  // Drops the requests made up to before.
  forget(before = Date.now()) {
    this.entries = this.entries.filter((e) => e.time > before);
    if (this.path) writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  summary(now = Date.now()) {
    const recent = this.entries.filter((e) => now - e.time <= KEEP_REQUESTS_MS);
    if (recent.length === 0) return 'Recent requests to you: none';
    const lines = recent.map((e) => `- ${ago(now - e.time)}, ${e.player}${e.pos ? ` standing at ${e.pos.x} ${e.pos.y} ${e.pos.z}` : ''}: ${e.text}`);
    return `Recent requests to you (oldest first, with where the player stood):\n${lines.join('\n')}`;
  }
}
