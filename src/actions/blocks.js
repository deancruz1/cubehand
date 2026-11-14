import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause } from './util.js';
import { walkTo, isGate, isOpen, SCAFFOLD_BLOCKS } from './movement.js';
import { collectDrops } from './items.js';

const { GoalPlaceBlock, GoalLookAtBlock, GoalNear } = pathfinderPkg.goals;

const REACH = 4.5;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE = new Set([
  ...AIR, 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'seagrass',
  'vine', 'glow_lichen', 'leaf_litter', 'short_dry_grass', 'tall_dry_grass'
]);

// Below first, so blocks sit on top of something when they can.
const FACES = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0)
];

export function isReplaceable(name) {
  return REPLACEABLE.has(name);
}

export function isProtected(name, protectedBlocks) {
  return protectedBlocks.some((p) => name === p || name.endsWith('_' + p));
}

export function inReach(bot, pos) {
  return bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= REACH;
}

export async function eat({ bot }, { food }) {
  const foods = bot.registry.foodsByName;
  const items = bot.inventory.items();
  let item;
  if (food) {
    if (!foods[food]) return fail(`not a food: ${food}`);
    item = items.find((i) => i.name === food);
    if (!item) return fail(`missing item: ${food}`);
  } else {
    item = items.find((i) => foods[i.name]);
    if (!item) return fail('no food');
  }
  if (bot.food >= 20) return fail('already full');

  await bot.equip(item, 'hand');
  try {
    await bot.consume();
  } catch (err) {
    return fail(`could not eat: ${err.message}`);
  }
  return ok(`ate ${item.name}, food is now ${bot.food}/20`);
}

export async function inspectBlocks({ bot, config }, { x1, y1, z1, x2, y2, z2 }) {
  const [ax, bx] = [x1, x2 ?? x1].sort((a, b) => a - b);
  const [ay, by] = [y1, y2 ?? y1].sort((a, b) => a - b);
  const [az, bz] = [z1, z2 ?? z1].sort((a, b) => a - b);
  const volume = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
  if (volume > config.limits.maxInspectBlocks) {
    return fail(`box is ${volume} blocks, the limit is ${config.limits.maxInspectBlocks}`);
  }

  const lines = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      for (let z = az; z <= bz; z++) {
        const block = bot.blockAt(new Vec3(x, y, z), false);
        lines.push(`${x} ${y} ${z}: ${block ? block.name : 'not loaded'}`);
      }
    }
  }
  return ok(lines.join('\n'));
}

function isFullBlock(block) {
  const s = block.shapes;
  return s.length === 1 && s[0][0] === 0 && s[0][1] === 0 && s[0][2] === 0 && s[0][3] === 1 && s[0][4] === 1 && s[0][5] === 1;
}

// A solid neighbor to place against. Ladders only go on the side of a full block; attach
// (a direction like 0 0 -1) picks which side when it matters.
export function findReference(bot, pos, name, attach) {
  const ladder = name === 'ladder';
  const faces = attach ? [attach] : ladder ? FACES.filter((f) => f.y === 0) : FACES;
  for (const dir of faces) {
    const neighbor = bot.blockAt(pos.plus(dir), false);
    if (!neighbor || neighbor.boundingBox !== 'block') continue;
    if (ladder && !isFullBlock(neighbor)) continue;
    return { reference: neighbor, face: dir.scaled(-1) };
  }
  return null;
}

// True when the bot's body is in the block at pos, so nothing can be placed there.
function standingIn(bot, pos) {
  const p = bot.entity.position;
  return pos.x + 1 > p.x - 0.3 && pos.x < p.x + 0.3 && pos.z + 1 > p.z - 0.3 && pos.z < p.z + 0.3 && pos.y + 1 > p.y && pos.y < p.y + 1.8;
}

// Shared by place_block, build_structure and build_house. Assumes the block name is known.
export async function placeOne(ctx, name, pos, { attach } = {}) {
  const { bot } = ctx;
  let target = bot.blockAt(pos, false);
  if (!target) return fail(`position not loaded: ${posText(pos)}`);
  if (target.name === name) return ok(`already ${name} at ${posText(pos)}`);
  // Snow deeper than one layer can't be built into, so dig it out first.
  if (target.name === 'snow' && target.getProperties().layers > 1) {
    const dug = await digBlock(ctx, pos);
    if (!dug.ok) return dug;
    target = bot.blockAt(pos, false);
  }
  if (!REPLACEABLE.has(target.name)) return fail(`position occupied by ${target.name}: ${posText(pos)}`);

  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return fail(`missing item: ${name}`);

  if (!findReference(bot, pos, name, attach)) return fail(`no block to place against at ${posText(pos)}`);

  if (!inReach(bot, pos) || standingIn(bot, pos)) {
    const walked = await walkTo(ctx, new GoalPlaceBlock(pos, bot.world, { range: 4 }), { place: 'climb' });
    if (standingIn(bot, pos)) return fail(`could not step out of the way of ${posText(pos)}: ${walked.message}`);
    if (!walked.ok && !inReach(bot, pos)) return fail(`could not get close enough to ${posText(pos)}: ${walked.message}`);
  }

  // Re-check after walking, the pathfinder may have changed things nearby.
  const ref = findReference(bot, pos, name, attach);
  if (!ref) return fail(`no block to place against at ${posText(pos)}`);

  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(ref.reference, ref.face);
  } catch (err) {
    const placed = bot.blockAt(pos, false);
    if (placed?.name !== name) return fail(`could not place at ${posText(pos)}: ${err.message}`);
  }
  ctx.placed?.add(name, pos);
  await pause(80, 200);
  return ok(`placed ${name} at ${posText(pos)}`);
}

export async function placeBlock(ctx, { block, x, y, z }) {
  if (!ctx.bot.registry.blocksByName[block]) return fail(`unknown block: ${block}`);
  return placeOne(ctx, block, new Vec3(x, y, z));
}

// "log" matches oak_log, spruce_log and so on; "chest" matches chest and trapped_chest.
export function matchesBlockName(name, query) {
  return name === query || name.endsWith(`_${query}`);
}

// Nearest loaded blocks matching test(name), closest first.
export function findNearest(bot, test, maxDistance, count = 1) {
  const ids = bot.registry.blocksArray.filter((b) => test(b.name)).map((b) => b.id);
  if (ids.length === 0) return [];
  const here = bot.entity.position;
  return bot
    .findBlocks({ matching: ids, maxDistance, count: 500 })
    .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
    .slice(0, count);
}

export async function findBlock({ bot }, { block, maxDistance }) {
  const range = Math.min(maxDistance ?? 64, 128);
  const found = findNearest(bot, (name) => matchesBlockName(name, block), range, 5);
  if (found.length === 0) return fail(`no ${block} within ${range} blocks`);
  const here = bot.entity.position;
  const lines = found.map((p) => `${bot.blockAt(p).name} at ${posText(p)} (${Math.round(p.distanceTo(here))} away)`);
  return ok(`nearest ${block}: ${lines.join('; ')}`);
}

// The break_block tool: protected blocks (chests, beds...) need a player's clear go-ahead,
// unless the bot placed that block itself. Picks up what drops.
export async function breakBlock(ctx, { x, y, z, confirmed }) {
  const { bot, config } = ctx;
  const pos = new Vec3(x, y, z);
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  const mine = ctx.placed?.has(pos, block.name);
  if (isProtected(block.name, config.protectedBlocks) && !confirmed && !mine) {
    return fail(`protected block: ${block.name}. Only break it if a player clearly asked for this one (then set confirmed), or if you placed it yourself.`);
  }
  const result = await digBlock(ctx, pos);
  if (result.ok) await collectDrops(ctx, { radius: 3, center: pos.offset(0.5, 0.5, 0.5), max: 3 });
  return result;
}

// Walks over and digs the block with the best tool. No protection checks.
export async function digBlock(ctx, pos) {
  const { bot, signal } = ctx;
  const { y } = pos;
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  if (AIR.has(block.name)) return fail(`nothing to break at ${posText(pos)}`);

  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: 'climb' });
    if (!walked.ok && !inReach(bot, pos)) {
      const above = y - Math.floor(bot.entity.position.y);
      const height = above > 3 ? ` It is ${above} blocks above your feet, too high to reach from the ground.` : '';
      return fail(`could not get close enough to ${posText(pos)}: ${walked.message}.${height}`);
    }
  }

  const fresh = bot.blockAt(pos, false);
  if (!bot.canDigBlock(fresh)) return fail(`can't break ${fresh.name} at ${posText(pos)}`);

  const tool = bot.pathfinder.bestHarvestTool(fresh);
  if (tool) await bot.equip(tool, 'hand');

  const onAbort = () => bot.stopDigging();
  signal?.addEventListener('abort', onAbort);
  try {
    await bot.dig(fresh);
  } catch (err) {
    return fail(`stopped breaking ${fresh.name}: ${err.message}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  ctx.placed?.remove(pos);
  return ok(`broke ${fresh.name} at ${posText(pos)}${tool ? ` with ${tool.name}` : ''}`);
}

// Breaks scaffolding the bot put down, top first, so nothing is left behind.
export async function removeScaffold(ctx, positions) {
  const { bot } = ctx;
  let removed = 0;
  for (const pos of [...positions].sort((a, b) => b.y - a.y)) {
    if (ctx.signal?.aborted) break;
    const block = bot.blockAt(pos, false);
    if (!block || !SCAFFOLD_BLOCKS.includes(block.name)) continue;
    if ((await digBlock(ctx, pos)).ok) removed++;
  }
  return removed;
}

// Opens or closes a door, gate or trapdoor (open picks which; left out it toggles), or
// presses a button or flips a lever.
export async function useBlock(ctx, { x, y, z, open }) {
  const { bot } = ctx;
  let block = bot.blockAt(new Vec3(x, y, z), false);
  if (!block) return fail(`position not loaded: ${x} ${y} ${z}`);
  if (AIR.has(block.name)) return fail(`nothing at ${x} ${y} ${z}`);
  if (block.name.endsWith('_door') && block.getProperties().half === 'upper') block = bot.blockAt(block.position.offset(0, -1, 0), false);
  if (block.name === 'iron_door' || block.name === 'iron_trapdoor') return fail(`${block.name} only opens with redstone, like a button or lever next to it`);
  const openable = block.name.endsWith('_door') || block.name.endsWith('_trapdoor') || isGate(block.name);
  const pos = block.position;
  if (openable && open !== undefined && isOpen(block) === open) return ok(`${block.name} at ${posText(pos)} is already ${open ? 'open' : 'closed'}`);

  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalNear(pos.x, pos.y, pos.z, 2), { place: false });
    if (!walked.ok && !inReach(bot, pos)) return fail(`could not get close enough to ${posText(pos)}: ${walked.message}`);
  }
  // A player asked for this one, so walking shouldn't undo it later.
  bot.openedPassages?.delete(pos.toString());
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
  await pause(150, 350);
  await bot.activateBlock(bot.blockAt(pos, false));
  await pause(300);
  const now = bot.blockAt(pos, false);
  if (openable) return ok(`${now.name} at ${posText(pos)} is now ${isOpen(now) ? 'open' : 'closed'}`);
  return ok(`used ${now.name} at ${posText(pos)}`);
}
