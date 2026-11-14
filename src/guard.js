// Checks everything the bot says before it goes to chat, whatever the model was talked into.
// Nothing it says can run as a command, hateful or sexual words are kept out, and long replies
// are cut short.

const MAX_CHARS = 500;

// Hateful slurs and explicit words, matched as whole words after undoing simple letter swaps
// (4 or @ for a, 1 or ! for i, 0 for o, 3 for e, 5 or $ for s).
const BLOCKED = [
  'nigg(?:a|er|ah|az|ers)?', 'fagg?(?:ot|ots|y)?', 'kike', 'spic', 'chink', 'gook', 'wetback', 'trann(?:y|ie)',
  'retard(?:ed|s)?', 'rape(?:d|s)?', 'rapist', 'porn', 'hentai', 'penis', 'vagina', 'cock', 'dick',
  'pussy', 'cunt', 'whore', 'slut', 'blowjob', 'cum(?:shot|ming)?', 'jizz', 'nudes?', 'naked', 'horny',
  'masturbat(?:e|ing|ion)', 'orgasm', 'nazi', 'heil', 'kys', 'kill yourself'
];
const BLOCKED_RE = new RegExp(`(^|[^a-z])(${BLOCKED.join('|')})(?=$|[^a-z])`);
const SWAPS = { 4: 'a', '@': 'a', 1: 'i', '!': 'i', 0: 'o', 3: 'e', 5: 's', $: 's' };

export function blockedReason(text) {
  const plain = text.toLowerCase().replace(/[4@1!035$]/g, (c) => SWAPS[c]);
  const m = BLOCKED_RE.exec(plain);
  return m ? `blocked word "${m[2]}"` : null;
}

// Cuts a long reply at the last sentence that fits.
export function shorten(text, max = MAX_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 3).trimEnd()}...`;
}

// The text to send, or null when it must not be sent. reason says why it changed.
export function guardChat(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return { text: null, reason: 'empty' };
  const reason = blockedReason(flat);
  if (reason) return { text: null, reason };
  const short = shorten(flat);
  return { text: short, reason: short === flat ? null : 'too long' };
}

// Admins may give standing orders and confirm breaking protected blocks.
export function isAdmin(config, name) {
  return Boolean(name) && (config.admins ?? []).some((a) => a.toLowerCase() === name.toLowerCase());
}

// A line that starts with / would run as a command under the bot's name, so the slashes go.
export function safeLine(part) {
  return part.replace(/^[\s/\\]+/, '');
}
