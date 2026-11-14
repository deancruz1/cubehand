import { ok, fail } from './util.js';
import { guardChat, safeLine } from '../guard.js';

export const CHAT_LIMIT = 256;

// Section signs and control characters get players kicked for "illegal characters".
export function cleanText(text) {
  return String(text).replace(/§/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function splitMessage(text, max = CHAT_LIMIT) {
  const words = cleanText(text).split(' ').filter(Boolean);
  const parts = [];
  let current = '';
  for (let word of words) {
    while (word.length > max) {
      if (current) {
        parts.push(current);
        current = '';
      }
      parts.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= max) current += ' ' + word;
    else {
      parts.push(current);
      current = word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// The chat lines to send for text, after the guard (see guard.js). blocked is why nothing
// may be sent.
export function chatLines(text, max = CHAT_LIMIT) {
  const { text: allowed, reason } = guardChat(text);
  if (!allowed) return { parts: [], blocked: reason === 'empty' ? null : reason, reason };
  const parts = splitMessage(allowed, max).map(safeLine).filter(Boolean);
  return { parts, blocked: null, reason };
}

export async function say({ bot, log }, { message }) {
  const { parts, blocked } = chatLines(message);
  if (blocked) {
    log?.(`[guard] kept out of chat (${blocked}): ${cleanText(message)}`);
    return fail(`not said, it has a ${blocked}. Say it another way, or leave it out.`);
  }
  if (parts.length === 0) return fail('message was empty');
  for (const part of parts) bot.chat(part);
  return ok(`said ${parts.length} message${parts.length > 1 ? 's' : ''}`);
}

export async function whisper({ bot, log }, { player, message }) {
  if (!bot.players[player]) return fail(`player not found: ${player}`);
  const max = CHAT_LIMIT - `/tell ${player} `.length;
  const { parts, blocked } = chatLines(message, max);
  if (blocked) {
    log?.(`[guard] kept out of chat (${blocked}): ${cleanText(message)}`);
    return fail(`not said, it has a ${blocked}. Say it another way, or leave it out.`);
  }
  if (parts.length === 0) return fail('message was empty');
  for (const part of parts) bot.whisper(player, part);
  return ok(`whispered ${parts.length} message${parts.length > 1 ? 's' : ''} to ${player}`);
}
