// Which model a job goes to: what counts as a build, and the tier a new job starts on.
import { isStandingOrder, workOrder } from './chat.js';

// "build" as something to do, not as a noun ("the build") or about one that's done ("did you build").
const BUILD_VERB = /(?<!\b(?:the|your|my|our|this|that|his|her|their|a)\s+)(?<!\b(?:did|have|has|had)\s+(?:you|she|he|we|they|i)\s+)\b(?:re)?(?:build|construct)\b/i;
// "make me a small house", but not "make a door for the house".
const MAKE_STRUCTURE = /\b(?:make|put up|set up|raise)\b(?:\s+(?!(?:in|at|near|by|to|for|from|of|on|inside|behind|next|beside|around|into|with|under)\b)[\w']+){0,4}?\s+(?:house|hut|cabin|shelter|tower|bridge|castle|barn|shed|wall|fort)s?\b/i;
const BUILD_TOOLS = new Set(['build_house', 'build_structure', 'copy_structure']);
// A build_structure of at most this many blocks, counting every block in the box of each part, is
// a patch (filling a few ore holes, say), not a build: it runs on the model that asked for it,
// with the usual budget. A roof is never a patch.
const PATCH_BLOCKS = 24;
function isPatch(call) {
  if (call.name !== 'build_structure') return false;
  const { parts = [], blocks = [] } = call.input ?? {};
  if (!Array.isArray(parts) || !Array.isArray(blocks)) return false;
  let count = blocks.length;
  for (const part of parts) {
    if (part?.shape === 'roof' || !part?.from || !part?.to) return false;
    const side = (k) => Math.abs(Number(part.to[k]) - Number(part.from[k])) + 1;
    count += side('dx') * side('dy') * side('dz');
  }
  return count >= 1 && count <= PATCH_BLOCKS;
}
export const isBuildCall = (call) => BUILD_TOOLS.has(call.name) && !isPatch(call);

// Building takes more thought and more time than most jobs. Only requests that ask for something
// to be built count; "go to your house" doesn't.
export function isBuildRequest(text) {
  return BUILD_VERB.test(text) || MAKE_STRUCTURE.test(text);
}

// What sends a request past the quick model at the start (see firstTier), read from the request in
// lower case without the bot's name or punctuation: a go-ahead, fixing or adding to a build, work
// on the tunnels, and sorting things into chests. Questions and orders for the body stay quick.
const GO_AHEAD = /^(?:(?:ok|okay|yes|yeah|yep|sure|good|great|then|so|now|please|sorry|i apologi[sz]e)\s+)*(?:yes|yeah|yep|sure|go ahead|do it|do that(?: then)?|start(?: now)?|begin|proceed|continue|resume|carry on|keep going|go on|do the necessary)(?: (?:then|now|please|it|with it|work))*$/;
const BUILD_WORK = /\b(?:patch|fix|repair|fill|expand|widen|extend|replicate|redo|decorate|improve|convert|smooth|fence|connect|add|finish|complete|continue|resume|start|make|still|missing)\b.*\b(?:walls?|roofs?|ceiling|attic|windows?|doors?|doorways?|gates?|gate ?houses?|bridges?|stalls?|floors?|flooring|stairs|houses?|buildings?|towers?|fountain|park|hall|office|holes?|gaps?|build(?:ing)?|project)\b/;
const TUNNEL_WORK = /\b(?:continue|complete|finish|clear|trim|extend|dig|mirror|follow|resume|proceed|go back to|still|missing)\b.*\b(?:tunnels?|strip ?min(?:e|ing)|branch(?:es)?|pattern)\b/;
const STORE_WORK = /\b(?:sort|store|deposit|stash|move|put|take|bring|retrieve)\b.*\b(?:chests?|storage)\b/;
const ASKS = /^(?:why|what|how|who|which|where|when|tell|explain|(?:do|does|did|are|is|have|has) (?:you|i|we|she|he|it|they))\b/;
const BODY_FIRST = /^(?:please )?(?:come|follow|stay|wait|stop|pause)\b/;
const plainWords = (text, name) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[.,!;:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.replace(/^@/, '') !== name.toLowerCase())
    .join(' ');

// Only these start the body moving before the model is asked; a stop only ends what was going on.
export const REFLEX_MOVES = new Set(['come', 'follow', 'stay']);

// Methods of the Brain class, put on it in brain.js, so this is the brain.
export const routeMethods = {
  // Jobs go to a model by how much thinking they need: simple ones (and sorting jobs and messages
  // that come in mid-job) to the quick model, everyday chores to the everyday model, and building
  // or anything that needs a plan to the main one. With routing off, everything uses the main model.
  modelFor(tier) {
    const { claude } = this.config;
    if (claude.routing !== true) return claude.model;
    if (tier === 'simple') return claude.quickModel ?? claude.model;
    if (tier === 'normal') return claude.everydayModel ?? claude.model;
    return claude.model;
  },

  // The tier a new job starts on. With routing on, a player's job starts on the quick model,
  // which does simple jobs itself and hands the rest up. Builds skip that, and so do fixing or
  // adding to a build (the main model), an obvious work order, work on the tunnels or sorting into
  // chests (the everyday model), and a go-ahead like "resume" or "yes" right after a job on one
  // of those, which goes back to it. Free time and rounds of the standing job run on the everyday
  // model.
  firstTier({ text, self, tier, reflex, standing }) {
    if (tier) return tier;
    if (this.config.claude.routing !== true) return 'complex';
    if (self || standing) return 'normal';
    if (isBuildRequest(text)) return 'complex';
    if (REFLEX_MOVES.has(reflex)) return 'simple';
    const name = this.config.bot.username;
    const order = workOrder(text, name);
    if (order === 'work') return 'normal';
    const words = plainWords(text, name);
    // A go-ahead right after a job one of the bigger models did is for that model too.
    const last = this.lastJob && !this.lastJob.self && ['normal', 'complex'].includes(this.lastJob.tier) ? this.lastJob.tier : null;
    if (last && (order === 'continue' || GO_AHEAD.test(words))) return last;
    if (!words || text.includes('?') || ASKS.test(words) || BODY_FIRST.test(words) || isStandingOrder(text, name)) return 'simple';
    if (BUILD_WORK.test(words)) return 'complex';
    return TUNNEL_WORK.test(words) || STORE_WORK.test(words) ? 'normal' : 'simple';
  }
};
