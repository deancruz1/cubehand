import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo, watchScaffold, SCAFFOLD_BLOCKS } from './movement.js';
import { matchesBlockName, inReach, isProtected, findNearest, removeScaffold } from './blocks.js';
import { collectDrops, gainedText } from './items.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const SEARCH_RANGE = 32;
const MAX_BLOCKS = 64;
const OPEN = new Set(['air', 'cave_air', 'void_air', 'water']);
const FACES = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

export function isOre(name) {
  return name.endsWith('_ore') || name === 'ancient_debris';
}

// A block a player can see: at least one side touches air or water.
export function isExposed(getName, pos) {
  return FACES.some((f) => OPEN.has(getName(pos.plus(f))));
}

// Lower is better. Like a player in a quarry: work the visible wall in front of you, from
// your feet up to a little above your head, close to where you last mined so you clear one
// face at a time. Digging into the floor makes pits, so it comes last. Hidden blocks cost a
// lot because reaching them means digging through others.
// dy is the block's height relative to the bot's feet.
export function targetScore({ distance, exposed, dy, fromLast }) {
  let score = distance + (exposed ? 0 : 12);
  if (dy < 0) score += 10 + 3 * -dy;
  else if (dy > 3) score += 2 * (dy - 3);
  if (fromLast !== undefined) score += 0.5 * fromLast;
  return score;
}

function inventoryCounts(bot) {
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
}

function lavaNext(getName, pos) {
  return FACES.some((f) => getName(pos.plus(f)) === 'lava');
}

async function harvest(bot, block) {
  const tool = bot.pathfinder.bestHarvestTool(block);
  if (tool) await bot.equip(tool, 'hand');
  if (block.harvestTools && !block.canHarvest(bot.heldItem?.type ?? null)) return 'need a better tool';
  await bot.dig(block);
  return null;
}

// Mines like a player would: picks the easiest visible blocks nearby, walks around to reach
// them, mines ores it comes across, and picks up the drops as it goes.
export async function mine(ctx, { block, count }) {
  const { bot, config, signal } = ctx;
  const query = block ?? 'stone';
  const target = Math.min(count ?? 16, MAX_BLOCKS);
  const matches = (name) => matchesBlockName(name, query);
  const ids = bot.registry.blocksArray.filter((b) => matches(b.name) || isOre(b.name)).map((b) => b.id);
  if (!bot.registry.blocksArray.some((b) => matches(b.name))) return fail(`unknown block: ${query}`);
  const getName = (p) => bot.blockAt(p, false)?.name;

  const before = inventoryCounts(bot);
  let last;
  let mined = 0;
  let sinceCollect = 0;
  let failures = 0;
  const ores = new Map();
  const skip = new Set();
  let stopReason = '';

  while (mined < target) {
    if (signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    const here = bot.entity.position;
    const feet = here.floored();
    const under = feet.offset(0, -1, 0);
    const candidates = bot
      .findBlocks({ matching: ids, maxDistance: SEARCH_RANGE, count: 300 })
      .filter((p) => !skip.has(p.toString()) && !p.equals(under) && !lavaNext(getName, p))
      .map((p) => ({ pos: p, name: getName(p), exposed: isExposed(getName, p) }))
      .filter((c) => c.name && !isProtected(c.name, config.protectedBlocks));

    // Ores a player would notice and grab on the way: visible and within reach.
    const bonus = candidates.filter((c) => !matches(c.name) && isOre(c.name) && c.exposed && inReach(bot, c.pos));
    const main = candidates
      .filter((c) => matches(c.name))
      .map((c) => ({
        ...c,
        score: targetScore({ distance: c.pos.distanceTo(here), exposed: c.exposed, dy: c.pos.y - feet.y, fromLast: last ? c.pos.distanceTo(last) : undefined })
      }))
      .sort((a, b) => a.score - b.score);
    const pick = bonus[0] ?? main[0];
    if (!pick) {
      stopReason = `no more ${query} within ${SEARCH_RANGE} blocks`;
      break;
    }

    if (!inReach(bot, pick.pos)) {
      const walked = await walkTo(ctx, new GoalLookAtBlock(pick.pos, bot.world, { reach: 4 }), { place: false });
      if (!walked.ok && !inReach(bot, pick.pos)) {
        skip.add(pick.pos.toString());
        if (++failures >= 5) {
          stopReason = `kept failing to reach blocks, last at ${posText(pick.pos)}`;
          break;
        }
        continue;
      }
    }

    const fresh = bot.blockAt(pick.pos, false);
    if (!fresh || fresh.name !== pick.name) continue;
    let problem;
    try {
      problem = await harvest(bot, fresh);
    } catch (err) {
      problem = err.message;
    }
    if (problem) {
      skip.add(pick.pos.toString());
      if (matches(pick.name) && problem === 'need a better tool') {
        stopReason = `I need a better tool to mine ${pick.name}`;
        break;
      }
      continue;
    }

    failures = 0;
    last = pick.pos;
    if (matches(pick.name)) mined++;
    else ores.set(pick.name, (ores.get(pick.name) ?? 0) + 1);
    ctx.status?.progress(`mined ${mined} of ${target} ${block}`);
    if (++sinceCollect >= 4) {
      await collectDrops(ctx);
      sinceCollect = 0;
    }
    await pause(100, 300);
  }
  await collectDrops(ctx);

  const oreText = ores.size ? `, plus ${[...ores].map(([n, c]) => `${c} ${n}`).join(', ')}` : '';
  const gained = [...inventoryCounts(bot)].map(([n, c]) => [n, c - (before.get(n) ?? 0)]).filter(([, c]) => c > 0);
  const pickedUp = gained.length ? gained.map(([n, c]) => `${c} ${n}`).join(', ') : 'nothing';
  const summary = `mined ${mined} ${query}${oreText}, picked up ${pickedUp}, now at ${posText(bot.entity.position)}`;
  if (mined >= target) return ok(summary);
  return mined > 0 || ores.size ? ok(`${summary}. Stopped early: ${stopReason}`) : fail(`${summary}. ${stopReason}`);
}

export function isLogName(name) {
  return name.endsWith('_log') || name.endsWith('_stem');
}

// Logs joined to start (corners count), within a tree-sized box around it.
export function treeLogs(getName, start, max = 200) {
  const seen = new Set([start.toString()]);
  const queue = [start];
  const logs = [];
  while (queue.length > 0 && logs.length < max) {
    const p = queue.shift();
    logs.push(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const n = p.offset(dx, dy, dz);
          const key = n.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          if (Math.abs(n.x - start.x) > 6 || Math.abs(n.z - start.z) > 6 || n.y < start.y - 2 || n.y > start.y + 32) continue;
          if (isLogName(getName(n) ?? '')) queue.push(n);
        }
      }
    }
  }
  return logs;
}

// Real trees have leaves that can decay. Leaves a player placed are persistent, and log
// walls have none, so builds are left alone.
function hasNaturalLeaves(bot, logs) {
  for (const p of logs) {
    for (const f of FACES) {
      const b = bot.blockAt(p.plus(f), false);
      if (!b) continue;
      if (b.name.endsWith('wart_block')) return true;
      if (b.name.endsWith('_leaves') && String(b.getProperties().persistent) !== 'true') return true;
    }
  }
  return false;
}

function hasScaffoldItems(bot) {
  return bot.inventory.items().some((i) => SCAFFOLD_BLOCKS.includes(i.name));
}

// Chops one tree from the bottom up, climbing on scaffolding for the high logs, then takes
// the scaffolding down again and picks up the logs.
async function chopOne(ctx, logs) {
  const { bot, signal } = ctx;
  const base = logs[0];
  const scaffold = watchScaffold(bot, (p) => Math.abs(p.x - base.x) <= 7 && Math.abs(p.z - base.z) <= 7 && p.y >= base.y - 2 && p.y <= base.y + 34);
  const left = [...logs];
  let chopped = 0;
  let failures = 0;
  let problem = '';
  try {
    while (left.length > 0) {
      if (signal?.aborted) {
        problem = 'stopped';
        break;
      }
      left.sort((a, b) => a.y - b.y);
      const pick = left.find((p) => inReach(bot, p)) ?? left[0];
      left.splice(left.indexOf(pick), 1);
      if (!isLogName(bot.blockAt(pick, false)?.name ?? '')) continue;

      if (!inReach(bot, pick)) {
        const walked = await walkTo(ctx, new GoalLookAtBlock(pick, bot.world, { reach: 4 }), { place: 'climb' });
        if (!walked.ok && !inReach(bot, pick)) {
          if (++failures >= 4) {
            const hint = hasScaffoldItems(bot) ? '' : ', I have no dirt or cobblestone to climb on';
            problem = `couldn't reach the last ${left.length + 1} logs${hint}`;
            break;
          }
          continue;
        }
      }
      try {
        await harvest(bot, bot.blockAt(pick, false));
        chopped++;
        failures = 0;
        ctx.status?.progress(`chopped ${chopped} of ${logs.length} logs from this tree`);
      } catch (err) {
        if (++failures >= 4) {
          problem = `kept failing: ${err.message}`;
          break;
        }
      }
      await pause(100, 250);
    }
  } finally {
    scaffold.stop();
  }
  await removeScaffold(ctx, scaffold.placed);
  await collectDrops(ctx, { radius: 8, center: base, max: 12 });
  return { chopped, problem };
}

// Chops whole trees: the one at x y z, or the nearest ones. trees is how many (default 1).
export async function chopTree(ctx, { x, y, z, trees }) {
  const { bot } = ctx;
  const wanted = Math.min(Math.max(trees ?? 1, 1), 5);
  const getName = (p) => bot.blockAt(p, false)?.name;
  const before = inventoryCounts(bot);
  const handled = new Set();
  const done = [];
  let stopReason = '';

  let given = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : null;
  if (given && !isLogName(getName(given) ?? '')) return fail(`no log at ${posText(given)}`);

  while (done.length < wanted) {
    if (ctx.signal?.aborted) {
      stopReason = 'stopped';
      break;
    }
    const start = given ?? findNearest(bot, isLogName, SEARCH_RANGE, 300).find((p) => !handled.has(p.toString()));
    if (!start) {
      stopReason = `no more trees within ${SEARCH_RANGE} blocks`;
      break;
    }
    const logs = treeLogs(getName, start).sort((a, b) => a.y - b.y);
    for (const p of logs) handled.add(p.toString());
    if (!hasNaturalLeaves(bot, logs)) {
      if (given) return fail(`the logs at ${posText(given)} look like part of a build, not a tree`);
      continue;
    }
    given = null;
    const result = await chopOne(ctx, logs);
    if (result.chopped) done.push(`${result.chopped} logs at ${posText(logs[0])}`);
    if (result.problem) {
      stopReason = result.problem;
      break;
    }
  }

  const got = gainedText(before, inventoryCounts(bot)) || 'nothing';
  const summary = `chopped ${done.length ? done.join(', ') : 'nothing'}, picked up ${got}, now at ${posText(bot.entity.position)}`;
  if (!stopReason) return ok(summary);
  return done.length ? ok(`${summary}. Stopped early: ${stopReason}`) : fail(`${summary}. ${stopReason}`);
}
