import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo } from './movement.js';
import { inReach, findNearest } from './blocks.js';

const SEARCH_RANGE = 64;

const { GoalLookAtBlock } = pathfinderPkg.goals;

export function isContainer(name) {
  return ['chest', 'trapped_chest', 'barrel', 'ender_chest'].includes(name) || name.endsWith('shulker_box');
}

export function countItems(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

function countsText(counts) {
  return counts.size ? [...counts].map(([name, count]) => `${name}: ${count}`).join(', ') : 'nothing';
}

// Walks over, opens the container, runs work(window), and always closes it again.
// With no position given it uses the nearest container.
export async function withContainer(ctx, { x, y, z }, work) {
  const { bot } = ctx;
  let pos;
  if (x === undefined || y === undefined || z === undefined) {
    pos = findNearest(bot, isContainer, SEARCH_RANGE)[0];
    if (!pos) return fail(`no chest or barrel within ${SEARCH_RANGE} blocks`);
  } else {
    pos = new Vec3(x, y, z);
  }
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  if (!isContainer(block.name)) return fail(`no chest or barrel at ${posText(pos)} (found ${block.name})`);

  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: false });
    if (!walked.ok && !inReach(bot, pos)) return fail(`could not get close enough to ${posText(pos)}: ${walked.message}`);
  }

  // Paced like a player: look at it, open it, look through it, then close it.
  let window;
  try {
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
    await pause(200, 450);
    window = await bot.openContainer(bot.blockAt(pos, false));
  } catch (err) {
    return fail(`could not open ${block.name}: ${err.message}`);
  }
  try {
    await pause(500, 1000);
    return await work(window, `${block.name} at ${posText(pos)}`);
  } finally {
    await pause(300, 600);
    window.close();
  }
}

export async function openContainer(ctx, input) {
  return withContainer(ctx, input, async (window, name) => {
    const items = window.containerItems();
    const free = window.inventoryStart - items.length;
    return ok(`${name} holds: ${countsText(countItems(items))} (${free} empty slots)`);
  });
}

// Moves each requested item one way. from() lists what can be moved, move() does the transfer.
async function moveItems(ctx, input, verb, from, move) {
  return withContainer(ctx, input, async (window, name) => {
    const done = [];
    const problems = [];
    for (const { item, count } of input.items) {
      if (ctx.signal?.aborted) {
        problems.push('stopped');
        break;
      }
      const matching = from(window).filter((i) => i.name === item);
      const have = matching.reduce((sum, i) => sum + i.count, 0);
      if (!have) {
        problems.push(`no ${item} to ${verb}`);
        continue;
      }
      const amount = Math.min(count ?? have, have);
      try {
        await move(window, matching[0].type, amount);
        done.push(`${amount} ${item}`);
      } catch (err) {
        problems.push(`${item}: ${err.message}`);
      }
      await pause(150, 400);
    }
    const summary = `${done.length ? `${verb === 'store' ? 'stored' : 'took'} ${done.join(', ')}` : `nothing moved`} (${name})`;
    if (problems.length) return done.length ? ok(`${summary}. Problems: ${problems.join('; ')}`) : fail(`${summary}. ${problems.join('; ')}`);
    return ok(summary);
  });
}

export async function storeItems(ctx, input) {
  return moveItems(ctx, input, 'store', () => ctx.bot.inventory.items(), (w, type, n) => w.deposit(type, null, n));
}

export async function takeItems(ctx, input) {
  return moveItems(ctx, input, 'take', (w) => w.containerItems(), (w, type, n) => w.withdraw(type, null, n));
}
