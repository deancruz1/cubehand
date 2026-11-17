import { posText } from './actions/util.js';

const LABELS = {
  build_house: 'building the house',
  build_structure: 'building',
  mine: 'mining',
  dig_area: 'digging out the area',
  use_item: 'using an item',
  chop_tree: 'chopping trees',
  collect_items: 'picking up items',
  move_to: 'walking',
  go_to_player: 'walking over',
  open_container: 'checking a chest',
  take_items: 'taking things from a chest',
  store_items: 'putting things in a chest',
  craft: 'crafting',
  obtain: 'getting items',
  smelt: 'smelting',
  inspect_blocks: 'looking the blocks over',
  break_block: 'breaking a block',
  place_block: 'placing a block',
  find_block: 'looking for blocks',
  survey: 'looking around the building',
  attack: 'fighting',
  skill: 'running a saved routine'
};
const label = (name) => LABELS[name] ?? name.replaceAll('_', ' ');

// What the bot is busy with right now, shared by the brain, the tools and the chat. Long tools
// report their progress here. While a player's job runs, a short status line goes to chat
// whenever the bot has been quiet for a while. A tool that makes no progress at all (the bot
// doesn't move, dig, or gain or lose items) is stopped after a while, and the brain is told
// what happened so it can decide what to do instead.
export class Status {
  constructor({ getBot, say, isBusy = () => false, log = () => {}, stuckSeconds = 45, quietSeconds = 60 }) {
    this.getBot = getBot;
    this.say = say;
    this.isBusy = isBusy;
    this.log = log;
    this.stuckMs = stuckSeconds * 1000;
    this.quietMs = quietSeconds * 1000;
    this.run = null;
    this.lastTool = null;
    this.lastStuck = null;
    this.lastSpoke = Date.now();
  }

  start() {
    this.timer = setInterval(() => this.heartbeat(), 5000);
    this.timer.unref?.();
  }

  // Anything the bot says in chat counts, so status lines only fill the silences.
  spoke(now = Date.now()) {
    this.lastSpoke = now;
  }

  heartbeat(now = Date.now()) {
    if (!this.isBusy()) {
      this.lastSpoke = now;
      return;
    }
    if (now - this.lastSpoke < this.quietMs) return;
    this.say(`(${this.describe()})`);
    this.lastSpoke = now;
  }

  describe() {
    const run = this.run;
    if (run) return `${label(run.name)}${run.progress ? `: ${run.progress}` : ''}`;
    return this.lastTool ? `done ${label(this.lastTool)}, working out the next step` : 'working out what to do first';
  }

  // Called by tools as they go, like "placed 80 of 700 blocks".
  progress(text, now = Date.now()) {
    if (!this.run) return;
    if (text !== this.run.progress) this.run.progressAt = now;
    this.run.progress = text;
    this.run.active = now;
  }

  // A walking problem from the movement code, kept for the next stuck report.
  noteStuck(text) {
    this.lastStuck = { text, at: Date.now() };
  }

  // Watches a tool while it runs. controller is aborted with 'stuck' if nothing happens for too long.
  // progressAt() is when its progress line last changed, or null while it has reported none.
  watch(name, controller) {
    const bot = this.getBot();
    const now = Date.now();
    const run = { name, controller, started: now, active: now, pos: bot?.entity?.position.clone(), items: itemKey(bot), progress: null, progressAt: null };
    this.run = run;
    const timer = setInterval(() => this.check(run), 1000);
    timer.unref?.();
    return {
      stop: () => {
        clearInterval(timer);
        this.lastTool = name;
        if (this.run === run) this.run = null;
      },
      report: () => this.stuckReport(run),
      progressAt: () => run.progressAt
    };
  }

  check(run, now = Date.now()) {
    const bot = this.getBot();
    if (!bot?.entity || run.controller.signal.aborted) return;
    const pos = bot.entity.position;
    const items = itemKey(bot);
    if (!run.pos || pos.distanceTo(run.pos) >= 0.5 || items !== run.items || bot.targetDigBlock) {
      run.active = now;
      run.pos = pos.clone();
      run.items = items;
    }
    if (now - run.active >= this.stuckMs) {
      this.log(`[status] ${run.name} made no progress for ${Math.round(this.stuckMs / 1000)}s, stopping it`);
      run.controller.abort('stuck');
    }
  }

  stuckReport(run, now = Date.now()) {
    const bot = this.getBot();
    const parts = [`I stopped this myself: nothing changed for ${Math.round(this.stuckMs / 1000)} seconds`];
    if (bot?.entity) parts.push(`I'm at ${posText(bot.entity.position.floored())}`);
    if (run.progress) parts.push(`last progress: ${run.progress}`);
    if (this.lastStuck && now - this.lastStuck.at < 120000) parts.push(`last walking problem: ${this.lastStuck.text}`);
    return `${parts.join('. ')}.`;
  }

  // For the snapshot, so a quick question ("how's it going?") gets a real answer.
  summary(now = Date.now()) {
    const run = this.run;
    if (!run) return null;
    const secs = Math.round((now - run.started) / 1000);
    return `Right now: running ${run.name} for ${secs}s${run.progress ? `, ${run.progress}` : ''}`;
  }
}

function itemKey(bot) {
  return (bot?.inventory?.items() ?? []).map((i) => `${i.slot}:${i.type}:${i.count}`).join(',');
}
