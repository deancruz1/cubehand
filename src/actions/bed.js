import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo } from './movement.js';
import { findNearest } from './blocks.js';

const { GoalNear } = pathfinderPkg.goals;

const RANGE = 48;
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

export function canSleepNow(bot) {
  const t = bot.time.timeOfDay;
  return (bot.isRaining && bot.thunderState > 0) || (t >= 12542 && t <= 23459);
}

// The head half of a bed, which is where a player lies.
function bedHead(block) {
  const { part, facing } = block.getProperties();
  const d = DIRS[facing];
  return part === 'foot' && d ? block.position.offset(d[0], 0, d[1]) : block.position;
}

function freeBeds(bot) {
  return findNearest(bot, (n) => n.endsWith('_bed'), RANGE, 12).filter((p) => !bot.blockAt(p, false)?.getProperties().occupied);
}

// A free bed the bot put down itself.
export function ownBed(bot, placed) {
  return freeBeds(bot).find((p) => placed?.has(p, bot.blockAt(p, false)?.name)) ?? null;
}

// The bed at pos, else the bot's own bed, else the nearest free one.
export function findBed(bot, placed, pos) {
  if (pos) return bot.blockAt(pos, false)?.name.endsWith('_bed') ? pos : null;
  return ownBed(bot, placed) ?? freeBeds(bot)[0] ?? null;
}

export async function sleep(ctx, { x, y, z }) {
  const { bot } = ctx;
  if (bot.isSleeping) return ok('already in bed');
  const given = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : null;
  const pos = findBed(bot, ctx.placed, given);
  if (!pos) return fail(given ? `no bed at ${posText(given)}` : `no free bed within ${RANGE} blocks`);

  const head = bedHead(bot.blockAt(pos, false));
  const walked = await walkTo(ctx, new GoalNear(head.x, head.y, head.z, 2), { place: false });
  if (!walked.ok && bot.entity.position.distanceTo(head.offset(0.5, 0.5, 0.5)) > 3) return fail(`could not get to the bed at ${posText(pos)}: ${walked.message}`);
  const bed = bot.blockAt(pos, false);
  if (!bed?.name.endsWith('_bed')) return fail(`the bed at ${posText(pos)} is gone`);
  await bot.lookAt(head.offset(0.5, 0.3, 0.5)).catch(() => {});
  await pause(200, 400);

  // Using a bed sets the spawn point even when it's too early to sleep.
  if (!canSleepNow(bot)) {
    await bot.activateBlock(bed);
    return ok(`it's daytime so I can't sleep yet, but I used the bed at ${posText(pos)}, which sets my spawn point there`);
  }
  try {
    await bot.sleep(bed);
  } catch (err) {
    return fail(`couldn't sleep in the bed at ${posText(pos)}: ${err.message}`);
  }
  return ok(`sleeping in the bed at ${posText(pos)}, my spawn point is set there`);
}
