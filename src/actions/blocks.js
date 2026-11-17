import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay } from './util.js';
import { walkTo, isGate, isOpen, underBot, SCAFFOLD_BLOCKS } from './movement.js';
import { collectDrops } from './items.js';
import { parseBlock, blockText, stateText, stateProblem, matchesState, placementOptions, itemFor } from './states.js';
import { isAdmin } from '../guard.js';

const { GoalPlaceBlock, GoalLookAtBlock, GoalNear, GoalBlock } = pathfinderPkg.goals;

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

export function isAir(name) {
  return AIR.has(name);
}

export function isReplaceable(name) {
  return REPLACEABLE.has(name);
}

export function isProtected(name, protectedBlocks) {
  return protectedBlocks.some((p) => name === p || name.endsWith('_' + p));
}

export function inReach(bot, pos) {
  return bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= REACH;
}

// The 26.1 data gives ores, obsidian and metal blocks the material incorrect_for_wooden_tool (a
// tool tier tag) instead of mineable/pickaxe. That table only lists wooden tools, so a diamond
// pickaxe digs them at the speed of a bare hand: deepslate diamond ore took 6.75 s instead of
// 0.85 s. Every one of them drops only for a pickaxe, so they get the pickaxe's material.
export function fixToolMaterials(registry) {
  if (!registry?.blocksArray || registry.toolMaterialsFixed || !registry.materials?.['mineable/pickaxe']) return;
  registry.toolMaterialsFixed = true;
  for (const b of registry.blocksArray) {
    if (typeof b.material === 'string' && b.material.startsWith('incorrect_for_')) b.material = 'mineable/pickaxe';
  }
}

// Mineflayer works out how long a dig takes when it starts, five times longer when the bot isn't
// on the ground, and waits all of it before telling the server the block is done. So a step or a
// landing finishes first.
export async function settle(bot, ms = 1000) {
  const end = Date.now() + ms;
  while (bot.entity?.onGround === false && Date.now() < end) await delay(50);
}

// Cells a player moves through: anything without a full hitbox (air, water, grass, torches) but
// lava and fire, and doors, gates, trapdoors and ladders.
export function isOpenBlock(block) {
  if (!block || block.name === 'lava' || block.name === 'fire' || block.name === 'soul_fire') return false;
  return block.boundingBox === 'empty' || /_door$|_fence_gate$|_trapdoor$|^ladder$/.test(block.name);
}

// Reads blocks by state id where the bot has a real world (much faster than blockAt over
// thousands of cells), else through blockAt.
export function blockReader(bot) {
  const w = bot.world;
  const byState = bot.registry?.blocksByStateId;
  if (byState && typeof w?.getBlockStateId === 'function' && typeof w.getColumnAt === 'function') {
    return (p) => (w.getColumnAt(p) ? byState[w.getBlockStateId(p)] ?? null : null);
  }
  return (p) => bot.blockAt(p, false);
}

const cellText = (p) => `${p.x},${p.y},${p.z}`;

// The open space the bot can get to from where it stands, for telling which blocks a player
// could see: a flood through open cells, nearest first, within range. When the flood runs out
// before cap cells it is exact. When it doesn't (open ground, big caves), a cell past it still
// counts when it belongs to an open space bigger than a pocket in the rock. add() joins a cell the
// bot dug out.
export function openSpace(bot, { range = 32, cap = 16000, pocket = 64 } = {}) {
  const read = blockReader(bot);
  const open = (p) => isOpenBlock(read(p));
  const start = bot.entity.position.floored();
  const reached = new Set([cellText(start)]);
  const queue = [start];
  let full = true;
  for (let i = 0; i < queue.length; i++) {
    if (reached.size >= cap) {
      full = false;
      break;
    }
    for (const f of FACES) {
      const n = queue[i].plus(f);
      if (Math.abs(n.x - start.x) > range + 1 || Math.abs(n.y - start.y) > range + 1 || Math.abs(n.z - start.z) > range + 1) continue;
      const key = cellText(n);
      if (reached.has(key) || !open(n)) continue;
      reached.add(key);
      queue.push(n);
    }
  }
  const big = new Map();
  const inBigSpace = (p) => {
    const first = cellText(p);
    if (big.has(first)) return big.get(first);
    const seen = new Set([first]);
    const cells = [p];
    let found = false;
    for (let i = 0; i < cells.length && !found; i++) {
      for (const f of FACES) {
        const n = cells[i].plus(f);
        const key = cellText(n);
        if (seen.has(key) || !open(n)) continue;
        seen.add(key);
        cells.push(n);
        if (reached.has(key) || big.get(key) || seen.size >= pocket) found = true;
      }
    }
    for (const key of seen) big.set(key, found);
    return found;
  };
  const reaches = (p) => reached.has(cellText(p)) || (!full && open(p) && inBigSpace(p));
  return {
    add: (p) => reached.add(cellText(p)),
    reaches,
    // A block with a face on that space.
    exposes: (p) => FACES.some((f) => reaches(p.plus(f)))
  };
}

// Where a player strip mines for each ore.
const ORE_LEVELS = { diamond: -59, redstone: -59, lapis: 0, gold: -16, iron: 16, copper: 48, coal: 96, ancient_debris: 15 };

// What a player does when no ore of the kind is in sight.
export function buriedText(query, buried) {
  const kind = Object.keys(ORE_LEVELS).find((k) => query.replace(/^deepslate_/, '').startsWith(k));
  const level = kind ? ` (${kind.replace('_', ' ')} is most common around y ${ORE_LEVELS[kind]})` : '';
  const hidden = buried ? `, only ${buried} buried in rock where no player could see them` : '';
  return `no exposed ${query} in reach on foot${hidden}. To find some, a player digs a 2-high tunnel or strip mine with dig_area${level}`;
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
  if (bot.food >= 20) return ok('already full');

  await bot.equip(item, 'hand');
  try {
    await bot.consume();
  } catch (err) {
    return fail(`could not eat: ${err.message}`);
  }
  return ok(`ate ${item.name}, food is now ${bot.food}/20`);
}

// The biggest box inspect_blocks takes at all, as a summary, and how many kinds of block a layer
// of the summary names before it lumps the rest together.
const MAX_SUMMARY_BLOCKS = 32768;
const SUMMARY_KINDS = 8;

const spanText = (a, b) => (a === b ? `${a}` : `${a}..${b}`);

// A box too big to list block by block: for each y layer, how many of each block and the x and
// z it spans, the most common first and air last (air only counted). Layers that come out the
// same share a line.
function layerSummary(bot, min, max) {
  const read = blockReader(bot);
  const rows = [];
  for (let y = min.y; y <= max.y; y++) {
    const kinds = new Map();
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        const name = read(new Vec3(x, y, z))?.name ?? 'not loaded';
        const k = kinds.get(name);
        if (!k) kinds.set(name, { count: 1, x0: x, x1: x, z0: z, z1: z });
        else {
          k.count++;
          k.x0 = Math.min(k.x0, x);
          k.x1 = Math.max(k.x1, x);
          k.z0 = Math.min(k.z0, z);
          k.z1 = Math.max(k.z1, z);
        }
      }
    }
    const empty = (name) => AIR.has(name) || name === 'not loaded';
    const sorted = [...kinds].sort(([an, a], [bn, b]) => empty(an) - empty(bn) || b.count - a.count);
    const shown = sorted.slice(0, SUMMARY_KINDS).map(([name, k]) => (empty(name) ? `${k.count} ${name}` : `${k.count} ${name} (x ${spanText(k.x0, k.x1)}, z ${spanText(k.z0, k.z1)})`));
    const rest = sorted.slice(SUMMARY_KINDS);
    if (rest.length) shown.push(`${rest.reduce((n, [, k]) => n + k.count, 0)} of ${rest.length} other kinds`);
    const text = shown.join(', ');
    const last = rows.at(-1);
    if (last?.text === text) last.to = y;
    else rows.push({ from: y, to: y, text });
  }
  return rows.map((r) => `y ${spanText(r.from, r.to)}: ${r.text}`).join('\n');
}

export async function inspectBlocks({ bot, config }, { x1, y1, z1, x2, y2, z2 }) {
  const [ax, bx] = [x1, x2 ?? x1].sort((a, b) => a - b);
  const [ay, by] = [y1, y2 ?? y1].sort((a, b) => a - b);
  const [az, bz] = [z1, z2 ?? z1].sort((a, b) => a - b);
  const volume = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
  const limit = config.limits.maxInspectBlocks;
  if (volume > MAX_SUMMARY_BLOCKS) {
    return fail(`box is ${volume} blocks, the limit is ${MAX_SUMMARY_BLOCKS} for a summary and ${limit} for the full listing. Look at it in parts.`);
  }
  if (volume > limit) {
    const head = `box is ${volume} blocks, more than the ${limit} a full listing takes, so this is each y layer: how many of each block and the x and z it spans. A box of ${limit} or fewer gives the full listing with every block's state.`;
    return ok(`${head}\n${layerSummary(bot, new Vec3(ax, ay, az), new Vec3(bx, by, bz))}`);
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

// Blocks a right click uses instead of placing against them: the door or trapdoor swings, the
// chest opens. Iron doors and trapdoors only answer to redstone, so they take the block.
const OPENS_ON_CLICK = /(_door|_trapdoor|_fence_gate|chest|barrel|shulker_box|furnace|^smoker$|crafting_table|^crafter$|anvil$|enchanting_table|brewing_stand|^beacon$|^hopper$|^dispenser$|^dropper$|^lectern$|^loom$|^stonecutter$|^grindstone$|smithing_table|cartography_table|^bell$|^note_block$|^jukebox$|^comparator$|^repeater$|daylight_detector|^lever$|_button$|_bed$|cake$|^respawn_anchor$|^composter$|_sign$|^decorated_pot$|^chiseled_bookshelf$|_shelf$|^redstone_wire$|^dragon_egg$|command_block$|^flower_pot$|^potted_|^vault$)/;

export function opensOnClick(name) {
  return OPENS_ON_CLICK.test(name) && name !== 'iron_door' && name !== 'iron_trapdoor';
}

// The game joins a slab clicked onto the same slab into a double slab when the click is on its
// open half: the top of a bottom slab, the underside of a top one, or a side above or below
// the middle. Then nothing goes in the spot next to it.
function joinsSlab(neighbor, how, name) {
  if (!name.endsWith('_slab') || neighbor.name !== name) return false;
  const type = neighbor.getProperties?.().type;
  if (type === 'double') return false;
  if (how.dir.y !== 0 || type === undefined) return how.dir.y < 0 ? type !== 'top' : how.dir.y > 0 ? type !== 'bottom' : false;
  const y = how.half === 'top' ? 0.75 : how.half === 'bottom' ? 0.25 : 0.5;
  return type === 'bottom' ? y > 0.5 : y <= 0.5;
}

// The ways to place a block, in order: attach (a direction like 0 0 -1) when it matters, else
// the options for its state (see placementOptions), else every side, below first. Ladders only
// go on the side of a full block.
export function referenceWays(name, attach, options) {
  if (attach) return [{ dir: attach }];
  return options ?? (name === 'ladder' ? FACES.filter((f) => f.y === 0) : FACES).map((dir) => ({ dir }));
}

function usableReference(neighbor, how, name) {
  if (!neighbor || neighbor.boundingBox !== 'block') return false;
  if (name === 'ladder' && !isFullBlock(neighbor)) return false;
  return !opensOnClick(neighbor.name) && !joinsSlab(neighbor, how, name);
}

// Every solid neighbor the block can be placed against, in the order of referenceWays.
export function findReferences(bot, pos, name, attach, options) {
  const refs = [];
  for (const how of referenceWays(name, attach, options)) {
    const neighbor = bot.blockAt(pos.plus(how.dir), false);
    if (usableReference(neighbor, how, name)) refs.push({ reference: neighbor, face: how.dir.scaled(-1), how });
  }
  return refs;
}

export function findReference(bot, pos, name, attach, options) {
  return findReferences(bot, pos, name, attach, options)[0] ?? null;
}

const SIDE_NAMES = { '0,-1,0': 'below', '0,1,0': 'above', '1,0,0': 'east', '-1,0,0': 'west', '0,0,1': 'south', '0,0,-1': 'north' };
const sideName = (dir) => SIDE_NAMES[`${dir.x},${dir.y},${dir.z}`];

// Why nothing next to pos will take the block, and what to do about it.
export function noReferenceText(bot, pos, name, attach, options) {
  const ways = referenceWays(name, attach, options);
  const notes = [];
  for (const how of ways) {
    const neighbor = bot.blockAt(pos.plus(how.dir), false);
    if (!neighbor || neighbor.boundingBox !== 'block') continue;
    const where = `the ${neighbor.name} ${sideName(how.dir)}`;
    if (opensOnClick(neighbor.name)) notes.push(`${where} would open instead of taking a block`);
    else if (joinsSlab(neighbor, how, name)) notes.push(`${where} would join it into a double slab`);
    else if (name === 'ladder') notes.push(`${where} is not a full block for a ladder`);
  }
  const allowed = new Set(ways.map((w) => sideName(w.dir)));
  const others = FACES.filter((f) => !allowed.has(sideName(f)) && bot.blockAt(pos.plus(f), false)?.boundingBox === 'block');
  if (others.length > 0) notes.push(`it can only go against the block ${[...allowed].join(', ')} of it for that state, not ${others.map(sideName).join(', ')}`);
  const why = notes.length ? notes.join('; ') : 'nothing solid on any side';
  return `no block to place against at ${posText(pos)}: ${why}. Something has to go next to it first: in build_structure, put what holds it up in the same call; a block of dirt or cobblestone there can be broken again once it is in`;
}

// Where on the reference clickToPlace clicks.
function clickPoint({ how, reference, face }) {
  let dy = 0.5 + face.y * 0.5;
  if (face.y === 0 && how.half) dy += how.half === 'top' ? 0.25 : -0.25;
  return reference.position.offset(0.5 + face.x * 0.5, dy, 0.5 + face.z * 0.5);
}

// True when nothing solid stands between the eyes and the spot clickToPlace clicks, coming at it
// through the cell the block goes in, the way a player has to see a face to click it.
export function inSight(bot, ref, pos) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const end = clickPoint(ref).plus(ref.face.scaled(0.02));
  const d = end.minus(eye);
  const steps = Math.ceil(d.norm() / 0.1);
  for (let i = 1; i < steps; i++) {
    const cell = eye.plus(d.scaled(i / steps)).floored();
    if (cell.equals(pos)) continue;
    if (bot.blockAt(cell, false)?.boundingBox === 'block') return false;
  }
  return true;
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

// Entities the game won't put a block into: players, mobs, boats and minecarts. Dropped items
// and arrows don't count.
const SOLID_ENTITY_TYPES = new Set(['player', 'mob', 'animal', 'hostile', 'passive', 'water_creature', 'ambient', 'living']);

function inTheWay(bot, pos) {
  for (const e of Object.values(bot.entities ?? {})) {
    if (e === bot.entity || !e.position) continue;
    if (!SOLID_ENTITY_TYPES.has(e.type) && !/boat|raft|minecart/.test(e.name ?? '')) continue;
    const half = (e.width ?? 0.6) / 2;
    const p = e.position;
    if (pos.x + 1 > p.x - half && pos.x < p.x + half && pos.z + 1 > p.z - half && pos.z < p.z + half && pos.y + 1 > p.y && pos.y < p.y + (e.height ?? 1.8)) {
      return e.username ?? e.name ?? 'something';
    }
  }
  return null;
}

// Faces it may try in one go when the server turns a click down.
const PLACE_TRIES = 3;

export function isDoubleSlab(name, props) {
  return props?.type === 'double' && name.endsWith('_slab');
}

// stateProblem, but a double slab is fine: it goes in as two slabs (see placeDoubleSlab).
export function blockStateProblem(registry, name, props) {
  if (!isDoubleSlab(name, props)) return stateProblem(registry, name, props);
  const { type, ...rest } = props;
  return stateProblem(registry, name, rest);
}

// A double slab is two slabs in one spot: the first goes in like any slab, the second is
// clicked onto its open face (the top of a bottom slab, the underside of a top one).
async function placeDoubleSlab(ctx, name, pos, target) {
  const { bot } = ctx;
  if (target.name !== name) {
    const first = await placeOne(ctx, name, pos);
    if (!first.ok) return first;
    target = bot.blockAt(pos, false);
    if (target?.name !== name) return fail(`could not place at ${posText(pos)}: the first ${name} did not stay`);
  }
  const done = ok(`placed ${name}[type=double] at ${posText(pos)}`);
  const type = target.getProperties?.().type;
  if (type === 'double') return done;
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return fail(`missing item: ${name}`);
  if (!inReach(bot, pos)) {
    const walked = await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: 'climb' });
    if (!walked.ok && !inReach(bot, pos)) return { ...fail(`could not get close enough to ${posText(pos)}: ${walked.message}`), reason: walked.reason };
    await settle(bot);
  }
  try {
    await bot.equip(item, 'hand');
    await bot._placeBlockWithOptions(bot.blockAt(pos, false), new Vec3(0, type === 'top' ? -1 : 1, 0), { delta: new Vec3(0.5, 0.5, 0.5), swingArm: 'right' });
  } catch (err) {
    // The server answers for the spot across the clicked face, which stays as it was, so a
    // slab that joined still reads as refused.
    if (!matchesState(bot.blockAt(pos, false), name, { type: 'double' })) return fail(`could not place at ${posText(pos)}: ${err.message}`);
  }
  await pause(80, 200);
  if (!matchesState(bot.blockAt(pos, false), name, { type: 'double' })) return fail(`could not place at ${posText(pos)}: the second ${name} did not join the first`);
  ctx.placed?.add(name, pos);
  return done;
}

// Shared by place_block, build_structure and build_house. Assumes the block name is known.
// props is the wanted state (facing, half, axis, type, open, hanging), see states.js.
export async function placeOne(ctx, name, pos, { attach, props } = {}) {
  const { bot } = ctx;
  let target = bot.blockAt(pos, false);
  if (!target) return fail(`position not loaded: ${posText(pos)}`);
  if (matchesState(target, name, props)) return ok(`already ${name} at ${posText(pos)}`);
  if (isDoubleSlab(name, props)) return placeDoubleSlab(ctx, name, pos, target);
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
  const usable = findReferences(bot, pos, name, attach, options);
  if (usable.length === 0) return fail(noReferenceText(bot, pos, name, attach, options));

  if (!inReach(bot, pos) || standingIn(bot, pos)) {
    // Only a spot that sees one of the faces it can use ends the walk.
    const faces = usable.map((r) => r.how.dir);
    const walked = await walkTo(ctx, new GoalPlaceBlock(pos, bot.world, { range: 4, faces }), { place: 'climb' });
    if (standingIn(bot, pos)) return { ...fail(`could not step out of the way of ${posText(pos)}: ${walked.message}`), reason: walked.reason ?? 'in_the_way' };
    if (!walked.ok && !inReach(bot, pos)) return { ...fail(`could not get close enough to ${posText(pos)}: ${walked.message}`), reason: walked.reason };
    await settle(bot);
  }
  for (let i = 0; i < 6 && inTheWay(bot, pos); i++) await delay(250);
  const blocker = inTheWay(bot, pos);
  if (blocker) return fail(`${blocker} is in the way at ${posText(pos)}, nothing can be placed into it`);

  // Re-check after walking, the pathfinder may have changed things nearby. A face in sight goes
  // first; when the server turns a click down, the next face gets a go.
  const refs = findReferences(bot, pos, name, attach, options);
  if (refs.length === 0) return fail(noReferenceText(bot, pos, name, attach, options));
  const ordered = [...refs.filter((r) => inSight(bot, r, pos)), ...refs.filter((r) => !inSight(bot, r, pos))];

  let error = null;
  let tries = 0;
  try {
    await bot.equip(item, 'hand');
    for (const ref of ordered.slice(0, PLACE_TRIES)) {
      tries++;
      try {
        await clickToPlace(bot, ref);
        error = null;
        break;
      } catch (err) {
        error = err;
        if (bot.blockAt(pos, false)?.name === name) {
          error = null;
          break;
        }
        if (!/refused/i.test(err.message)) break;
      }
    }
  } catch (err) {
    if (bot.blockAt(pos, false)?.name !== name) error = err;
  }
  if (error) return fail(`could not place at ${posText(pos)}: ${error.message}${tries > 1 ? ` (tried ${tries} faces)` : ''}`);
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
  const problem = blockStateProblem(ctx.bot.registry, name, props);
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

// Ores only count where a player could see them, unless bot.xray is on.
export async function findBlock({ bot, config }, { block, maxDistance }) {
  const range = Math.min(maxDistance ?? 64, 128);
  const isOreName = (name) => name.endsWith('_ore') || name === 'ancient_debris';
  const matching = bot.registry.blocksArray.filter((b) => matchesBlockName(b.name, block));
  if (matching.length === 0) return fail(`unknown block: ${block}`);
  const ores = matching.length > 0 && matching.every((b) => isOreName(b.name)) && config?.bot?.xray !== true;
  let found = findNearest(bot, (name) => matchesBlockName(name, block), range, ores ? 300 : 5);
  if (ores && found.length) {
    const space = openSpace(bot, { range });
    const all = found.length;
    found = found.filter((p) => space.exposes(p)).slice(0, 5);
    if (found.length === 0) return ok(`${buriedText(block, all)}.`);
  }
  if (found.length === 0) return ok(`no ${block} within ${range} blocks`);
  const here = bot.entity.position;
  const lines = found.map((p) => `${bot.blockAt(p).name} at ${posText(p)} (${Math.round(p.distanceTo(here))} away)`);
  return ok(`nearest ${block}: ${lines.join('; ')}`);
}

// Why the block at pos may not be broken, or null. Protected blocks (chests, beds...) need a
// player's clear go-ahead, and an admin's request at that, unless the bot placed that block itself.
export function protectedReason(ctx, block, pos, confirmed) {
  const { config } = ctx;
  if (!isProtected(block.name, config.protectedBlocks) || ctx.placed?.has(pos, block.name)) return null;
  if (!confirmed) return `protected block: ${block.name}. Only break it if a player clearly asked for this one (then set confirmed), or if you placed it yourself.`;
  if (!ctx.requester) return `protected block: ${block.name}. Nobody asked for this job, so you can't break someone's ${block.name}. Only an admin's request can.`;
  if (!isAdmin(config, ctx.requester)) return `protected block: ${block.name}. Only an admin can have you break someone's ${block.name}, and ${ctx.requester} isn't one.`;
  return null;
}

// Steps off pos (a block under her, see underBot) to a spot within 2 blocks from where it is
// still in reach, on ground that stays(ground) says won't be broken, nearest first. False when
// there is none or the walk didn't get her off it.
export async function stepOff(ctx, pos, stays = () => true) {
  const { bot } = ctx;
  const f = bot.entity.position.floored();
  const spots = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = f.offset(dx, dy, dz);
        const ground = c.offset(0, -1, 0);
        if ((c.x === pos.x && c.z === pos.z) || !stays(ground)) continue;
        if (!isOpenBlock(bot.blockAt(c, false)) || !isOpenBlock(bot.blockAt(c.offset(0, 1, 0), false)) || bot.blockAt(ground, false)?.boundingBox !== 'block') continue;
        if (c.offset(0.5, 1.6, 0.5).distanceTo(pos.offset(0.5, 0.5, 0.5)) > REACH) continue;
        spots.push(c);
      }
    }
  }
  const here = bot.entity.position;
  spots.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(here) - b.offset(0.5, 0, 0.5).distanceTo(here));
  for (const c of spots.slice(0, 3)) {
    if (ctx.signal?.aborted) return false;
    await walkTo(ctx, new GoalBlock(c.x, c.y, c.z), { place: false });
    if (!underBot(bot, pos)) return true;
  }
  return false;
}

// The break_block tool: see protectedReason. Never the block she stands on: she steps off it
// first (see stepOff). Picks up what drops.
export async function breakBlock(ctx, { x, y, z, confirmed }) {
  const { bot } = ctx;
  const pos = new Vec3(x, y, z);
  const block = bot.blockAt(pos, false);
  if (!block) return fail(`position not loaded: ${posText(pos)}`);
  const refused = protectedReason(ctx, block, pos, confirmed);
  if (refused) return fail(refused);
  if (!AIR.has(block.name)) {
    if (!inReach(bot, pos)) await walkTo(ctx, new GoalLookAtBlock(pos, bot.world, { reach: 4 }), { place: 'climb', dig: true });
    if (underBot(bot, pos) && !(await stepOff(ctx, pos))) {
      if (ctx.signal?.aborted) return fail(`stopped before breaking ${block.name}`);
      return fail(`that's the block I'm standing on at ${posText(pos)}, and there is nowhere beside it to stand and still reach it`);
    }
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

  fixToolMaterials(bot.registry);
  const fresh = bot.blockAt(pos, false);
  if (!bot.canDigBlock(fresh)) return fail(`can't break ${fresh.name} at ${posText(pos)}`);

  const tool = bot.pathfinder.bestHarvestTool(fresh);
  if (tool) await bot.equip(tool, 'hand');
  if (!anyTool && needsBetterTool(fresh, bot.heldItem?.type ?? null)) {
    const needs = Object.keys(fresh.harvestTools).map((id) => bot.registry.items[id]?.name).filter(Boolean);
    return fail(`need a better tool to break ${fresh.name} at ${posText(pos)}: with ${bot.heldItem?.name ?? 'my hand'} it would take long and drop nothing${needs.length ? `. It takes one of: ${needs.join(', ')}` : ''}`);
  }

  await settle(bot);
  if (signal?.aborted) return fail(`stopped before breaking ${fresh.name}`);
  const onAbort = () => bot.stopDigging();
  signal?.addEventListener('abort', onAbort);
  try {
    await bot.dig(fresh);
  } catch (err) {
    return { ...fail(`stopped breaking ${fresh.name}: ${err.message}`), error: err.message };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  ctx.placed?.remove(pos);
  return ok(`broke ${fresh.name} at ${posText(pos)}${tool ? ` with ${tool.name}` : ''}`);
}

// Breaks scaffolding the bot put down, top first, so nothing is left behind. removed is how many
// came down; a stop part-way sets stopped and left (how many are still up), and text says so.
export async function takeDownScaffold(ctx, positions) {
  const { bot } = ctx;
  let removed = 0;
  let left = 0;
  let stopped = false;
  for (const pos of [...positions].sort((a, b) => b.y - a.y)) {
    const block = bot.blockAt(pos, false);
    if (!block || !SCAFFOLD_BLOCKS.includes(block.name)) continue;
    if (stopped || ctx.signal?.aborted) {
      stopped = true;
      left++;
      continue;
    }
    if ((await digBlock(ctx, pos, { anyTool: true })).ok) removed++;
  }
  const text = stopped ? `stopped taking down my scaffolding after ${removed}, ${left} still up` : removed ? `took down ${removed} scaffolding blocks` : '';
  return { removed, left, stopped, text };
}

// takeDownScaffold for callers that only want the count.
export async function removeScaffold(ctx, positions) {
  return (await takeDownScaffold(ctx, positions)).removed;
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
