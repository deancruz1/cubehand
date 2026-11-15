import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay } from './util.js';
import { walkTo, isGate, isOpen, SCAFFOLD_BLOCKS } from './movement.js';
import { collectDrops } from './items.js';
import { parseBlock, blockText, stateText, stateProblem, matchesState, placementOptions, itemFor } from './states.js';
import { isAdmin } from '../guard.js';

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

  // Runs of the same block along z share a line, so big boxes stay short.
  const lines = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      let start = az;
      let last = null;
      for (let z = az; z <= bz + 1; z++) {
        const block = z <= bz ? bot.blockAt(new Vec3(x, y, z), false) : null;
        const text = z <= bz ? (block ? stateText(block) : 'not loaded') : null;
        if (z > az && text !== last) {
          lines.push(`${x} ${y} ${start === z - 1 ? start : `${start}..${z - 1}`}: ${last}`);
          start = z;
        }
        last = text;
      }
    }
  }
  return ok(`${volume > 1 ? 'x y z: block, where z a..b is a run along z\n' : ''}${lines.join('\n')}`);
}

function isFullBlock(block) {
  const s = block.shapes;
  return s.length === 1 && s[0][0] === 0 && s[0][1] === 0 && s[0][2] === 0 && s[0][3] === 1 && s[0][4] === 1 && s[0][5] === 1;
}

// A solid neighbor to place against, from the ways to place the block (see placementOptions).
// Ladders only go on the side of a full block; attach (a direction like 0 0 -1) picks which
// side when it matters. A slab clicked onto the same slab would join it into a double slab.
export function findReference(bot, pos, name, attach, options) {
  const ladder = name === 'ladder';
  const ways = attach ? [{ dir: attach }] : options ?? (ladder ? FACES.filter((f) => f.y === 0) : FACES).map((dir) => ({ dir }));
  for (const how of ways) {
    const neighbor = bot.blockAt(pos.plus(how.dir), false);
    if (!neighbor || neighbor.boundingBox !== 'block') continue;
    if (ladder && !isFullBlock(neighbor)) continue;
    if (name.endsWith('_slab') && neighbor.name === name) continue;
    return { reference: neighbor, face: how.dir.scaled(-1), how };
  }
  return null;
}

// Clicks the reference block so the new block comes out in the wanted state: on the upper or
// lower half of a side face for top and bottom halves, looking the wanted way for stairs,
// doors and the like.
async function clickToPlace(bot, ref) {
  const { how, reference, face } = ref;
  if (how.yaw === undefined && !how.half) return bot.placeBlock(reference, face);
  let dy = 0.5 + face.y * 0.5;
  if (face.y === 0 && how.half) dy += how.half === 'top' ? 0.25 : -0.25;
  let forceLook;
  if (how.yaw !== undefined) {
    const point = reference.position.offset(0.5 + face.x * 0.5, dy, 0.5 + face.z * 0.5);
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const d = point.minus(eye);
    await bot.look(how.yaw, Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)));
    forceLook = 'ignore';
  }
  return bot._placeBlockWithOptions(reference, face, { half: how.half, forceLook, swingArm: 'right' });
}

// True when the bot's body is in the block at pos, so nothing can be placed there.
function standingIn(bot, pos) {
  const p = bot.entity.position;
  return pos.x + 1 > p.x - 0.3 && pos.x < p.x + 0.3 && pos.z + 1 > p.z - 0.3 && pos.z < p.z + 0.3 && pos.y + 1 > p.y && pos.y < p.y + 1.8;
}

// Shared by place_block, build_structure and build_house. Assumes the block name is known.
// props is the wanted state (facing, half, axis, type, open, hanging), see states.js.
export async function placeOne(ctx, name, pos, { attach, props } = {}) {
  const { bot } = ctx;
  let target = bot.blockAt(pos, false);
  if (!target) return fail(`position not loaded: ${posText(pos)}`);
  if (matchesState(target, name, props)) return ok(`already ${name} at ${posText(pos)}`);
  // The right block turned the wrong way: its own blocks get redone, anyone else's stay.
  if (target.name === name) {
    if (!ctx.placed?.has(pos, name)) return fail(`position occupied by ${stateText(target)}: ${posText(pos)}`);
    const dug = await digBlock(ctx, pos, { anyTool: true });
    if (!dug.ok) return dug;
    target = bot.blockAt(pos, false);
  }
  // Snow deeper than one layer can't be built into, so dig it out first.
  if (target.name === 'snow' && target.getProperties().layers > 1) {
    const dug = await digBlock(ctx, pos);
    if (!dug.ok) return dug;
    target = bot.blockAt(pos, false);
  }
  if (!REPLACEABLE.has(target.name)) return fail(`position occupied by ${target.name}: ${posText(pos)}`);

  const itemName = itemFor(name, bot.registry);
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return fail(`missing item: ${itemName}`);

  const options = props && Object.keys(props).length ? placementOptions(name, props) : undefined;
  if (!findReference(bot, pos, name, attach, options)) return fail(`no block to place against at ${posText(pos)}`);

  if (!inReach(bot, pos) || standingIn(bot, pos)) {
    const walked = await walkTo(ctx, new GoalPlaceBlock(pos, bot.world, { range: 4 }), { place: 'climb' });
    if (standingIn(bot, pos)) return { ...fail(`could not step out of the way of ${posText(pos)}: ${walked.message}`), reason: walked.reason ?? 'in_the_way' };
    if (!walked.ok && !inReach(bot, pos)) return { ...fail(`could not get close enough to ${posText(pos)}: ${walked.message}`), reason: walked.reason };
  }

  // Re-check after walking, the pathfinder may have changed things nearby.
  const ref = findReference(bot, pos, name, attach, options);
  if (!ref) return fail(`no block to place against at ${posText(pos)}`);

  try {
    await bot.equip(item, 'hand');
    await clickToPlace(bot, ref);
  } catch (err) {
    const placed = bot.blockAt(pos, false);
    if (placed?.name !== name) return fail(`could not place at ${posText(pos)}: ${err.message}`);
  }
  ctx.placed?.add(name, pos);
  await pause(80, 200);

  let placed = bot.blockAt(pos, false);
  if (props?.open !== undefined && placed?.name === name && !name.startsWith('iron_') && String(placed.getProperties?.().open) !== props.open) {
    try {
      await bot.activateBlock(placed);
      await delay(150, 250);
      placed = bot.blockAt(pos, false);
    } catch {}
  }
  if (props && !matchesState(placed, name, props)) {
    return { ...ok(`placed ${name} at ${posText(pos)}, but it came out as ${stateText(placed)} instead of ${blockText(name, props)}`), wrong: true };
  }
  return ok(`placed ${props ? blockText(name, props) : name} at ${posText(pos)}`);
}

export async function placeBlock(ctx, { block, x, y, z }) {
  const { name, props } = parseBlock(block);
  if (!ctx.bot.registry.blocksByName[name]) return fail(`unknown block: ${name}`);
  const problem = stateProblem(ctx.bot.registry, name, props);
  if (problem) return fail(problem);
  return placeOne(ctx, name, new Vec3(x, y, z), { props });
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
  if (isProtected(block.name, config.protectedBlocks) && !mine) {
    if (!confirmed) return fail(`protected block: ${block.name}. Only break it if a player clearly asked for this one (then set confirmed), or if you placed it yourself.`);
    if (!ctx.requester) return fail(`protected block: ${block.name}. Nobody asked for this job, so you can't break someone's ${block.name}. Only an admin's request can.`);
    if (!isAdmin(config, ctx.requester)) return fail(`protected block: ${block.name}. Only an admin can have you break someone's ${block.name}, and ${ctx.requester} isn't one.`);
  }
  const result = await digBlock(ctx, pos);
  if (result.ok) await collectDrops(ctx, { radius: 3, center: pos.offset(0.5, 0.5, 0.5), max: 3 });
  return result;
}

// True when the tool type can't harvest the block and breaking it anyway would take long. Without
// the right tool a block takes 5 seconds per point of hardness, so soft ones like snow layers
// and snow blocks go in a second and aren't worth refusing.
export function needsBetterTool(block, type) {
  if (!block.harvestTools || block.canHarvest(type)) return false;
  return !(block.hardness <= 0.2);
}

// Walks over and digs the block with the best tool. No protection checks. anyTool digs it even
// when the tools can't harvest it, for blocks where getting them out matters more than the drop.
export async function digBlock(ctx, pos, { anyTool = false } = {}) {
  const { bot, signal } = ctx;
  const { y } = pos;
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  if (AIR.has(block.name)) return fail(`nothing to break at ${posText(pos)}`);

  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: 'climb', dig: true });
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
  if (!anyTool && needsBetterTool(fresh, bot.heldItem?.type ?? null)) {
    const needs = Object.keys(fresh.harvestTools).map((id) => bot.registry.items[id]?.name).filter(Boolean);
    return fail(`need a better tool to break ${fresh.name} at ${posText(pos)}: with ${bot.heldItem?.name ?? 'my hand'} it would take long and drop nothing${needs.length ? `. It takes one of: ${needs.join(', ')}` : ''}`);
  }

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
    if ((await digBlock(ctx, pos, { anyTool: true })).ok) removed++;
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
  await delay(300);
  const now = bot.blockAt(pos, false);
  if (openable) return ok(`${now.name} at ${posText(pos)} is now ${isOpen(now) ? 'open' : 'closed'}`);
  return ok(`used ${now.name} at ${posText(pos)}`);
}
