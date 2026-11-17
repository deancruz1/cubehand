// What the brain tells the model and the players: the fixed lines and the nudges, when a nudge is
// due, and reading the model's own lines (a mid-job reply, a promise of more work).
import Anthropic from '@anthropic-ai/sdk';
import { ago } from './areas.js';
import { asksForThoughts, THOUGHT_SUMMARY } from './chat.js';
import { isAdmin } from './guard.js';

// The model is told once, when this many steps are left, so it can finish up.
export const STEPS_WARNING = 3;
export const STEPS_LEFT = `This job has ${STEPS_WARNING} steps left, this one included. Use them to finish up, or to tell the player what is still left to do.`;

// Why a held job stopped its tool, as the model is told it.
export const HOLD_CAUSES = {
  danger: 'you had to look after yourself',
  hazard: 'you had to get out of water, lava or fire',
  offline: 'the connection to the server dropped'
};

export const BUSY_INSTRUCTIONS = `Decide what to do with the new message. Reply with exactly one of:
- QUEUE, if it asks you to do something new once your current job is done, or you can't tell.
- UPDATE, if it changes the job you're doing now so that what you're doing this moment is wrong or wasted (a size, a side, a spot, a level, materials, gone far enough), so you stop and work it in right away.
- ADD, if it adds to the job you're doing now but what you're doing this moment can finish first (one more thing to do or include, a rule for how to work, something to fix elsewhere, a name or note to keep), so you work it in after that. If unsure which, UPDATE.
- NOW, if they want you to drop the current job and do the new thing right away.
- STOP, if they want you to stop or cancel the current job.
- Otherwise, when it's a question or chat you can answer from the snapshot (what you're doing, how it's going, where something is), your short chat reply to them, one or two sentences.`;
export const BUSY_WORDS = ['QUEUE', 'UPDATE', 'ADD', 'NOW', 'STOP'];
const REPLY_LABEL = /^\s*(?:chat\s+)?(?:reply|answer|response)\s*:\s*/i;
const SORTING_TALK = /\bchat (?:answer|reply|message)\b|\bso (?:it's|it is|this is) (?:a |just )?(?:chat|question)\b/i;
const SORTING_WORD = /\b(?:QUEUE|UPDATE|ADD|NOW|STOP)\b/;

// The chat part of a mid-job reply. "Chat reply: their message is a compliment, so it's a chat
// answer. Thanks!" is only "Thanks!": the label and the sentences about sorting the message aren't
// for chat. Empty when nothing else is left.
export function chatPart(reply) {
  const sentences = reply.replace(REPLY_LABEL, '').split(/(?<=[.!?])\s+/);
  let i = 0;
  while (i < sentences.length && (SORTING_TALK.test(sentences[i]) || SORTING_WORD.test(sentences[i]))) i++;
  if (i === 0 && !REPLY_LABEL.test(reply)) return reply;
  return sentences.slice(i).join(' ').trim();
}

export const FREE_TIME = `Nobody has asked you for anything right now, so you have some free time. If there is something small and useful you'd like to do on your own, do it in a few steps. For example: smelt ores you carry, craft a tool you're missing, put spare items away in the right chests, gather a little wood, stone or food for later, or check on your house. Stay within about 32 blocks, never break or change anything players built, and don't start anything long. Don't chat unless you have something worth saying. If nothing is worth doing, reply with only: nothing`;

// Goes after the request when the quick model starts a job, so it does simple jobs itself and
// hands the rest up. It can't go in the system prompt, which every model shares.
export const SORTING = `Before you start, sort this request by how much thinking it needs:
- Simple, one or two obvious actions (come here, follow me, stop following, look at something, give or drop an item, eat, sleep, save a place or a standing order (any rule for how to work) with remember, or just chatting and answering a question): do it yourself now.
- Otherwise call escalate as the only call in your response: normal for everyday jobs of a few steps (mining, chopping, gathering, crafting, smelting, storing or fetching items, fighting, going somewhere, recording an area), complex for anything that needs a plan or taste (building, designing, changing or fixing a build, decorating, carrying on with a build, or a long job with many parts). When unsure, complex.
- If a job you started yourself turns out to need more than that, call escalate then, the same way.`;
export const HANDED_OVER = 'This job has been handed to you, so do it yourself from here and leave the sorting above aside: escalate is not for you.';
export const NOT_YOURS = 'Not done: this job is yours to do. Carry on with it yourself.';
export const EARLIER_FAILED = 'Not done, because an earlier action in this response failed (see above).';

export const MAX_NUDGES = 2;
export const CARRY_ON = "You ended your turn by saying what you'll do next, but nothing happens until you do it. Carry on now with your tools, and only reply when the whole job is done or you really need an answer from a player. If you are in fact finished, or waiting on the players, reply with one short sentence saying so.";

export const FINISH_MORE ="Not done: you said you'd carry on, so do it now with your tools. If you are in fact finished or waiting on a player, finish with a line that says so. Your message wasn't sent.";
export const OR_ESCALATE = 'If it needs a model that thinks more, call escalate as the only call.';
export const SAID_NOTHING = "Your turn on this request ended without a word or a tool call, so the player asked for something and heard nothing. Answer them, or do what they asked with your tools. If you don't understand what they want, say so in one short line.";
export const NOT_UNDERSTOOD = "Sorry, I didn't understand that. Could you say it another way?";

const SAYS_NEXT = /\b(next|then|after that)\b[^.!]{0,40}\b(I'll|I will|I'm|I am)\b|\b(I'll|I will|I'm going to|I am going to)\b[^.!]{0,20}\b(next|now)\b|\b(is|are) next\b|\bnext (up|is|are)\b/i;
const GETS_ON = /\b(I'll|I will|I'm going to|I am going to|let me)\s+(?:just |now |then |also |first )?(?:go ahead|get (?:started|going|to work)|start|begin|carry on|continue|keep going|head|build|make(?! sure)|craft|mine|chop|dig|gather|grab|fetch|bring|put|place|add|use|fill|patch|fix|finish|work on|take|store|smelt)\b/i;
// "If you drop me some dirt, I'll build it", "I'll take the ingots out later", "I'll dig it as
// soon as breaking works".
const WAITS = /\bif\b|\b(when|once|whenever) you\b|\blater\b|\b(?:once|when|as soon as|until)\s+(?!I\b|I'|I’)[^.!]{0,40}?\b(?:works?|working|fixed)\b/i;
// "Say the word and I'll start the next tunnel", "Tell me which line, and I'll dig it", but not
// "..., and I'll start the roof now".
const ON_ANSWER = /^(?:just )?(?:say the word|tell me|let me know|give me the word)\b[^.!]*?\band (?:I'll|I will)\b(?![^.!]*\bnow\b)/i;

// A rule meant to outlast the job only carries over in a memory, so a job that got one without
// saving it is held back once before it ends.
export const WORK_IN = "Work this into the job you're doing now. If it's meant for later jobs too, save it with remember, in the note for that place or task.";
export const LASTING_NOTE ="This is a lasting rule: work it into the job you're doing now, and save it with remember before you finish.";
const RULE_UNSAVED = (who) =>
  `${who} gave you a lasting rule, and your next job won't know it unless you save it. Save it now with remember, in words a later job will understand: what to do, where or when it applies, and who said it ("Standing order from ${who}: ..."). If a note for that place or task already exists, save it again under that name with the new rule added. If you may not save it, tell them so and why.`;
const NOT_ADMIN = (who) => `${who} isn't an admin, so it can only be kept as a note, not a standing order: tell them that.`;

// A final reply that only says what comes next ("Next I'll do the shutters.", "The west wall is
// next.", "I'll go ahead and build it.") rather than finishing, asking something, or waiting on
// someone.
export function announcesMore(reply) {
  if (!reply || reply.includes('?')) return false;
  return reply.split(/(?<=[.!])\s+/).some((s) => !WAITS.test(s) && !ON_ANSWER.test(s) && (SAYS_NEXT.test(s) || GETS_ON.test(s)));
}

// On a reflex job the first "On my way, I'll be right there" is about what the body is already
// doing, so it isn't held back as a promise of more work. run is the job's run (see brainsteps.js).
export function promisesMore(run, line) {
  if (!announcesMore(line)) return false;
  if (!run.excused) return true;
  run.excused = false;
  return false;
}

// The rules given since the last remember call and the last time the job was held for them.
export const unsavedRules = (run) => (run.self ? [] : run.job.rules.slice(Math.max(run.job.savedRules, run.rulesHeld)));
export function ruleNudge(config, run) {
  const names = [...new Set(unsavedRules(run).map((r) => r.player))];
  run.rulesHeld = run.job.rules.length;
  const strangers = names.filter((name) => !isAdmin(config, name));
  const text = RULE_UNSAVED(names.join(' and '));
  return strangers.length ? `${text} ${NOT_ADMIN(strangers.join(' and '))}` : text;
}

const ENDS = {
  done: 'you ended it with your reply',
  stop: 'a player stopped it',
  time: 'it ran out of time',
  steps: 'it ran out of steps',
  replaced: 'it gave way to another job',
  death: 'you died',
  not_understood: "you said you didn't understand it"
};

// What the body already did on a reflex job (see reflex.js), before the model was asked.
export const REFLEX_DONE = {
  come: (player) => `You already set off toward ${player} the moment they asked, so don't call a walk to them again. Just reply.`,
  follow: (player) => `You are already following ${player}, so don't call follow_player again. Just reply.`,
  stay: () => "You already stopped and are staying put, so don't call stop_moving. Just reply.",
  stop: () => "You already stopped what you were doing and said so, so don't call stop_moving or say you stopped again. Just do the rest of what they asked."
};

// What came before this job, so a question like "what are you doing?" gets a true answer. A request
// for her reasoning only goes in as the neutral line the request log keeps for it.
export function lastJobLine(last, now = Date.now()) {
  if (!last) return '';
  const text = asksForThoughts(last.text) ? THOUGHT_SUMMARY : last.text;
  const what = last.self ? 'your own free time' : last.standing ? `a round of the standing job from ${last.player}` : `${last.player}'s request "${text}"`;
  return `Your last job, ${what}, ended ${ago(now - last.at)}: ${ENDS[last.end] ?? last.end.replaceAll('_', ' ')}. No job is running besides this one.`;
}

// The snapshot without what it carries from before the job: the remembered requests (from
// RequestLog.summary in chat.js) and the recent chat (from chatSummary in perception.js). Every
// other part stays exactly as it was.
const CARRIED_PARTS = [/^Recent requests to you\b/, /^Recent chat\b/];
export function leanSnapshot(snapshot) {
  return snapshot
    .split('\n\n')
    .filter((part) => !CARRIED_PARTS.some((re) => re.test(part)))
    .join('\n\n');
}

export function errorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "I couldn't reach my brain: the API key was rejected.";
  }
  if (err instanceof Anthropic.RateLimitError) return 'My brain is rate limited right now. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "I couldn't reach my brain (connection problem).";
  return 'Something went wrong talking to my brain.';
}
