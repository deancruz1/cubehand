import { createHash, timingSafeEqual } from 'node:crypto';

const HINT_EVERY_MS = 5 * 60000;
// A whisper that starts like this is a go at the passphrase, whatever comes after.
const MARKER = /^pass\s+/i;

// What goes in place of a public line that had the passphrase in it.
export const SAID_IN_PUBLIC = '(a line with the passphrase in it was taken out)';

const digest = (text) => createHash('sha256').update(String(text)).digest();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The server runs in offline mode, so a name proves nothing. With a passphrase set, a player on
// the allowlist counts as off it until they have whispered the passphrase to the bot, and stays
// verified until they leave, the bot reconnects or the session runs out.
export class Auth {
  constructor({ passphrase = '', allowlist = [], admins = [], botName = '', sessionHours = 12, maxTries = 5, lockMinutes = 10, log = () => {} } = {}) {
    const secret = String(passphrase ?? '').trim();
    this.secret = secret ? digest(secret) : null;
    this.lower = secret.toLowerCase();
    this.allowlist = allowlist;
    this.admins = admins;
    this.botName = botName;
    this.sessionMs = sessionHours * 3600000;
    this.maxTries = maxTries;
    this.lockMs = lockMinutes * 60000;
    this.lockMinutes = lockMinutes;
    this.log = log;
    // Keyed by lower case name: when each was verified, wrong tries, locks and the last hint.
    this.verified = new Map();
    this.tries = new Map();
    this.locks = new Map();
    this.hinted = new Map();
  }

  get needed() {
    return this.secret !== null;
  }

  onList(name) {
    return Boolean(name) && this.allowlist.some((p) => p.toLowerCase() === name.toLowerCase());
  }

  isVerified(name, now = Date.now()) {
    if (!this.needed || !name) return false;
    const key = name.toLowerCase();
    const since = this.verified.get(key);
    if (since === undefined) return false;
    if (now - since < this.sessionMs) return true;
    this.verified.delete(key);
    return false;
  }

  // The allowlist as every trust check should see it.
  trustedList(now = Date.now()) {
    return this.needed ? this.allowlist.filter((p) => this.isVerified(p, now)) : this.allowlist;
  }

  // The name a chat line is kept under, so a line an unverified player said stays marked as
  // untrusted even after the real player verifies.
  label(name, now = Date.now()) {
    return this.needed && this.onList(name) && !this.isVerified(name, now) ? `${name} (unverified)` : name;
  }

  // Hashed first, so both sides have the same length and the time taken says nothing about it.
  matches(text) {
    return this.needed && timingSafeEqual(digest(String(text ?? '').trim()), this.secret);
  }

  contains(text) {
    return this.needed && String(text ?? '').toLowerCase().includes(this.lower);
  }

  // A line for the console or the log file.
  mask(text) {
    return this.contains(text) ? SAID_IN_PUBLIC : text;
  }

  // { handled, reply }: handled means the whisper was about the passphrase and goes no further.
  handleWhisper(name, text, now = Date.now()) {
    if (!this.needed || !this.onList(name)) return { handled: false, reply: null };
    const said = String(text ?? '').trim();
    const key = name.toLowerCase();
    if (this.isVerified(name, now)) {
      if (this.matches(said) || (MARKER.test(said) && this.matches(said.replace(MARKER, '')))) return { handled: true, reply: 'You are already verified.' };
      if (this.contains(said)) return { handled: true, reply: 'I left that one out, it had the passphrase in it.' };
      return { handled: false, reply: null };
    }
    const marked = MARKER.test(said);
    const right = this.matches(said) || (marked && this.matches(said.replace(MARKER, '')));
    // Ordinary whispered chat is no try: only a single word, or one that starts with "pass ".
    if (!right && !marked && /\s/.test(said)) return { handled: false, reply: null };
    if ((this.locks.get(key) ?? 0) > now) return { handled: true, reply: null };
    this.locks.delete(key);
    if (right) {
      this.verified.set(key, now);
      this.tries.delete(key);
      this.log(`[auth] ${name} verified`);
      return { handled: true, reply: 'Thanks, you are verified. Your orders work now.' };
    }
    const tries = (this.tries.get(key) ?? 0) + 1;
    this.log(`[auth] ${name} wrong try ${tries} of ${this.maxTries}`);
    if (tries < this.maxTries) {
      this.tries.set(key, tries);
      return { handled: true, reply: 'That is not the passphrase.' };
    }
    this.tries.delete(key);
    this.locks.set(key, now + this.lockMs);
    this.log(`[auth] ${name} locked for ${this.lockMinutes} minutes`);
    return { handled: true, reply: `Too many wrong tries. I'll ignore tries from you for ${this.lockMinutes} minutes.` };
  }

  // The line that tells an unverified player to whisper the passphrase first, at most every 5 minutes.
  hint(name, now = Date.now()) {
    if (!this.needed || !this.onList(name) || this.isVerified(name, now)) return null;
    const key = name.toLowerCase();
    const last = this.hinted.get(key);
    if (last !== undefined && now - last < HINT_EVERY_MS) return null;
    this.hinted.set(key, now);
    return `Whisper me the passphrase first, with /msg ${this.botName} followed by the passphrase.`;
  }

  // What to do with one chat line before anything else sees it: drop it, or carry on with message,
  // which is the line itself or SAID_IN_PUBLIC. replies are whispers to send, as { text, to }.
  screen({ username, message, whisper = false }, now = Date.now()) {
    if (!this.needed || username.toLowerCase() === this.botName.toLowerCase()) return { drop: false, message, replies: [] };
    if (whisper) {
      const { handled, reply } = this.handleWhisper(username, message, now);
      if (handled) return { drop: true, message: null, replies: reply ? [{ text: reply, to: username }] : [] };
    } else if (this.contains(message)) {
      // The line still goes on, as the marker, so nothing about how the bot reacts shows it was there.
      this.log(`[auth] the passphrase was said in public chat by ${username}`);
      const text = `${username} said the passphrase in public chat, so it should be changed.`;
      const admins = this.admins.filter((a) => this.isVerified(a, now));
      return { drop: false, message: SAID_IN_PUBLIC, replies: admins.map((to) => ({ text, to })) };
    }
    const addressed = whisper || new RegExp(`\\b${escapeRegex(this.botName)}\\b`, 'i').test(message);
    const hint = addressed ? this.hint(username, now) : null;
    return { drop: false, message, replies: hint ? [{ text: hint, to: username }] : [] };
  }

  // Locks and wrong tries stay, so leaving and joining again doesn't buy more tries.
  left(name) {
    if (!name) return;
    this.verified.delete(name.toLowerCase());
    this.hinted.delete(name.toLowerCase());
  }

  reset() {
    this.verified.clear();
    this.hinted.clear();
  }
}
