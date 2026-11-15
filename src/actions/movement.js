import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import { ok, fail, botPos, guarded, customName, TimeoutError, AbortedError, StalledError } from './util.js';
import { leaveDrops } from './items.js';

const { GoalNear, GoalFollow } = pathfinderPkg.goals;
const { Movements } = pathfinderPkg;

// The pathfinder moves each step of a path it hands out (onto the block below, into the doorway)
// by changing the step itself. A long search hands out its path several times, so the same steps
// got moved again each time: steps up a ladder crept a block higher every round until they all
// sat at the top of the shaft. Each path now gets its own copies of the steps.
const makeResult = AStar.prototype.makeResult;
AStar.prototype.makeResult = function (...args) {
  const result = makeResult.apply(this, args);
  result.path = result.path.map(copyStep);
  return result;
};

export function copyStep(m) {
  return new Move(m.x, m.y, m.z, m.remainingBlocks, m.cost, [...m.toBreak], [...m.toPlace], m.parkour);
}

export function isHandDoor(name) {
  return name.endsWith('_door') && name !== 'iron_door';
}

export function isGate(name) {
  return name.endsWith('_fence_gate');
}

export function isHandTrapdoor(name) {
  return name.endsWith('_trapdoor') && name !== 'iron_trapdoor';
}

// Snow up to 5 layers is low enough to step onto; deeper snow has to be dug out of the way.
export function deepSnow(layers) {
  return layers >= 6;
}

// The pathfinder treats doors, gates and trapdoors as walls. This lets it plan through
// wooden doors and gates, and through trapdoor hatches on top of ladders (an open trapdoor
// above a ladder is climbable in vanilla). passagesOnPath opens them as the bot arrives.
class DoorMovements extends Movements {
  getBlock(pos, dx, dy, dz) {
    const b = super.getBlock(pos, dx, dy, dz);
    if (!b.name) return b;
    if (isHandDoor(b.name) || isGate(b.name)) {
      b.safe = true;
      b.physical = false;
      b.openable = false;
      b.passage = true;
      b.height = pos.y + dy;
    } else if (isHandTrapdoor(b.name) && this.bot.blockAt(b.position.offset(0, -1, 0), false)?.name === 'ladder') {
      b.safe = true;
      b.physical = false;
      b.climbable = true;
      b.passage = true;
      b.height = pos.y + dy;
    } else if (b.name.endsWith('_trapdoor') && isOpen(b)) {
      // An open trapdoor, like a window shutter, is a thin panel on one side of its block:
      // nothing to stand on and no room to walk through.
      b.safe = false;
      b.physical = false;
    } else if (b.name === 'snow' && deepSnow(b.getProperties().layers)) {
      b.safe = false;
      b.physical = false;
    }
    return b;
  }

  // Never dig what the bot built itself, even when it's made of something that looks natural,
  // like a tuff wall.
  safeToBreak(block) {
    if (block.position && this.bot.placedLog?.has(block.position, block.name)) return false;
    return super.safeToBreak(block);
  }

  // Doors and gates can only be walked through straight on, along the way they face. From the
  // side, the frame or the open door itself is in the way. Checks the block the move starts in
  // and the given heights of the block it goes to.
  intoPassageSideways(node, dir, dys) {
    const along = dir.x !== 0 ? ['east', 'west'] : ['north', 'south'];
    const cells = [this.getBlock(node, 0, 0, 0), ...dys.map((dy) => this.getBlock(node, dir.x, dy, dir.z))];
    return cells.some((b) => b.passage && (isHandDoor(b.name) || isGate(b.name)) && !along.includes(b.getProperties().facing));
  }

  // A ladder counts as solid to the pathfinder, so it would happily walk across the top of a
  // ladder shaft and drop down it. Only climbing or dropping into the shaft is allowed.
  overLadder(node, dx, dy, dz) {
    return this.getBlock(node, dx, dy - 1, dz).climbable && !this.getBlock(node, dx, dy, dz).climbable;
  }

  getMoveForward(node, dir, neighbors) {
    if (this.overLadder(node, dir.x, 0, dir.z) || this.intoPassageSideways(node, dir, [0, 1])) return;
    super.getMoveForward(node, dir, neighbors);
  }

  getMoveDropDown(node, dir, neighbors) {
    if (this.intoPassageSideways(node, dir, [0, 1])) return;
    super.getMoveDropDown(node, dir, neighbors);
  }

  getMoveJumpUp(node, dir, neighbors) {
    if (this.overLadder(node, dir.x, 1, dir.z) || this.intoPassageSideways(node, dir, [1, 2])) return;
    const before = neighbors.length;
    super.getMoveJumpUp(node, dir, neighbors);
    // Three or more snow layers on the step make the jump too high, so clear them first.
    const move = neighbors[before];
    const feet = this.getBlock(node, dir.x, 1, dir.z);
    if (move && feet.name === 'snow' && feet.getProperties().layers >= 3 && this.safeToBreak(feet)) {
      move.toBreak.push(feet.position);
      move.cost += this.digCost;
    }
  }

  // Door frames block diagonal movement, so only go through passages straight on.
  getMoveDiagonal(node, dir, neighbors) {
    for (const [x, z] of [[dir.x, dir.z], [dir.x, 0], [0, dir.z]]) {
      if (this.getBlock(node, x, 0, z).passage || this.getBlock(node, x, 1, z).passage) return;
    }
    if (this.overLadder(node, dir.x, 0, dir.z)) return;
    super.getMoveDiagonal(node, dir, neighbors);
  }

  // Never use blocks a build still needs as scaffolding (bot.buildKeep holds their item ids).
  scaffoldIds() {
    const keep = this.bot.buildKeep;
    return keep ? this.scafoldingBlocks.filter((id) => !keep.has(id)) : this.scafoldingBlocks;
  }

  countScaffoldingItems() {
    const ids = new Set(this.scaffoldIds());
    return this.bot.inventory.items().filter((i) => ids.has(i.type)).reduce((sum, i) => sum + i.count, 0);
  }

  getScaffoldingItem() {
    const ids = this.scaffoldIds();
    const items = this.bot.inventory.items();
    for (const id of ids) {
      const item = items.find((i) => i.type === id);
      if (item) return item;
    }
    return null;
  }
}

export function isOpen(block) {
  return String(block.getProperties().open) === 'true';
}

function isPassage(block) {
  return isHandDoor(block.name) || isGate(block.name) || isHandTrapdoor(block.name);
}

const cellOf = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

// The pathfinder lifts each step onto whatever has a shape in its cell, so a step through a
// door lands a block above the floor (a closed gate one and a half), and the bot can only
// reach it by jumping in the doorway. Put those steps back on the floor.
export function fixPassageSteps(path, getBlock) {
  for (const node of path) {
    const cell = new Vec3(Math.floor(node.x), Math.floor(node.y) - 1, Math.floor(node.z));
    const b = getBlock(cell);
    if (!b || !(isHandDoor(b.name) || isGate(b.name))) continue;
    node.x = cell.x + 0.5;
    node.y = cell.y;
    node.z = cell.z + 0.5;
  }
}

// Opens closed doors, gates and trapdoors on the path ahead, and closes the ones it opened
// once the bot is past them, like a player would.
function passagesOnPath(bot) {
  let path = [];
  const lastTry = new Map();
  const opened = new Map();
  bot.openedPassages = opened;
  bot.on('path_update', (results) => {
    path = results.path;
    fixPassageSteps(path, (p) => bot.blockAt(p, false));
  });
  bot.on('path_reset', () => { path = []; });
  bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const here = bot.entity.position;

    if (bot.pathfinder.isMoving()) {
      // The cell she stands in counts too: once she is in the doorway the door is no longer ahead.
      for (const cell of [cellOf(here), ...path.slice(0, 3).map(cellOf)]) {
        for (const dy of [0, 1]) {
          let block = bot.blockAt(cell.offset(0, dy, 0));
          if (!block || !isPassage(block)) continue;
          // Both halves toggle the same door, so always use the bottom half. Using both
          // in one tick opens the door and shuts it again straight away.
          if (isHandDoor(block.name) && block.getProperties().half === 'upper') block = bot.blockAt(block.position.offset(0, -1, 0));
          if (!block || !isPassage(block) || isOpen(block)) continue;
          if (block.position.offset(0.5, 0.5, 0.5).distanceTo(here) > 3) continue;
          const key = block.position.toString();
          if (Date.now() - (lastTry.get(key) ?? 0) < 1500) continue;
          lastTry.set(key, Date.now());
          opened.set(key, { pos: block.position, at: Date.now() });
          bot.activateBlock(block).catch(() => {});
        }
      }
    }

    // Right after a path reset the new path isn't there yet, so it's unknown whether a door is still needed.
    const replanning = bot.pathfinder.goal && path.length === 0;
    for (const [key, { pos, at }] of opened) {
      const age = Date.now() - at;
      if (age > 300000) {
        opened.delete(key);
        continue;
      }
      const distance = pos.offset(0.5, 0.5, 0.5).distanceTo(here);
      if (age < 800 || distance < 2.5 || replanning) continue;
      if (path.slice(0, 4).some((n) => Math.floor(n.x) === pos.x && Math.floor(n.z) === pos.z && Math.abs(n.y - pos.y) <= 1)) continue;
      // Don't shut it in the face of someone coming through behind.
      if (Object.values(bot.players).some((p) => p.entity && p.entity !== bot.entity && p.entity.position.distanceTo(pos.offset(0.5, 0, 0.5)) < 2)) continue;
      opened.delete(key);
      if (distance > 4.5) continue;
      const block = bot.blockAt(pos);
      if (block && isPassage(block) && isOpen(block)) bot.activateBlock(block).catch(() => {});
    }
  });
}

// Cheap blocks the pathfinder may place to tower up or bridge gaps.
export const SCAFFOLD_BLOCKS = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone',
  'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'coarse_dirt', 'blackstone'
];

// Notes where scaffolding blocks appear inside inArea(pos) until stop() is called, so a job
// can clean up after itself.
export function watchScaffold(bot, inArea) {
  const placed = [];
  const onUpdate = (oldBlock, newBlock) => {
    if (!newBlock || !SCAFFOLD_BLOCKS.includes(newBlock.name)) return;
    if (oldBlock && oldBlock.boundingBox === 'block') return;
    if (inArea(newBlock.position)) placed.push(newBlock.position.clone());
  };
  bot.on('blockUpdate', onUpdate);
  return { placed, stop: () => bot.removeListener('blockUpdate', onUpdate) };
}

// Terrain the pathfinder may dig through while walking. Anything else, like planks, glass,
// cobblestone or other building blocks, is never dug, so builds stay safe.
export function isNaturalBlock(name) {
  if (NATURAL_BLOCKS.has(name)) return true;
  return name.endsWith('_ore') || name.endsWith('_leaves');
}

const NATURAL_BLOCKS = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud', 'clay',
  'gravel', 'sand', 'red_sand', 'snow', 'snow_block', 'powder_snow', 'moss_block',
  'netherrack', 'soul_sand', 'soul_soil', 'end_stone', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush'
]);

// Blocks that don't look like part of a build. Logs count, so the bot can still pillar
// up next to a tree trunk.
export function looksNatural(name) {
  return isNaturalBlock(name) || SCAFFOLD_BLOCKS.includes(name) || name.endsWith('_log');
}

// True when any block touching pos (corners included) looks like part of a build.
function nearBuild(bot, pos) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz), false);
        if (b && b.boundingBox === 'block' && !looksNatural(b.name)) return true;
      }
    }
  }
  return false;
}

// Walking prefers existing paths and the ground: a dug block costs about 3 steps and, on an
// everyday walk, a placed block about 40, so the bot walks around or jumps up and only builds
// a pillar or bridge when there's no other way. Jobs that have to reach high places (tall
// trees, building) use the climb mode, where scaffolding costs about 12. Nothing is ever
// placed next to builds.
const MODES = {
  walk: { placeCost: 40, place: true },
  climb: { placeCost: 12, place: true },
  noPlace: { placeCost: 12, place: false }
};

function makeMovements(bot, cantBreak, { placeCost, place }) {
  const m = new DoorMovements(bot);
  m.canDig = true;
  m.digCost = 3;
  m.placeCost = placeCost;
  // Plan around players and mobs where there's room, so someone standing in one half of a
  // double door doesn't block the way.
  m.entityCost = 4;
  m.blocksCantBreak = cantBreak;
  m.allow1by1towers = place;
  m.scafoldingBlocks = place ? SCAFFOLD_BLOCKS.map((name) => bot.registry.itemsByName[name]?.id).filter((id) => id !== undefined) : [];
  // Inside the area of a house it is building, the bot may put up scaffolding next to its own walls.
  m.exclusionAreasPlace = [(block) => (!inZone(bot.buildZone, block.position) && nearBuild(bot, block.position) ? 100 : 0)];
  // Steps the bot recently got stuck on cost more, so the next path tries another way.
  m.exclusionAreasStep = [(block) => {
    const a = block.position && bot.avoidSteps?.get(block.position.toString());
    return a && a.until > Date.now() ? 15 * a.tries : 0;
  }];
  // Powder snow looks like air to the pathfinder, but anything without leather boots sinks in it.
  const powder = bot.registry.blocksByName.powder_snow;
  if (powder) m.blocksToAvoid.add(powder.id);
  return m;
}

function inZone(zone, pos) {
  if (!zone) return false;
  return pos.x >= zone.min.x && pos.x <= zone.max.x && pos.y >= zone.min.y && pos.y <= zone.max.y && pos.z >= zone.min.z && pos.z <= zone.max.z;
}

// The first stair or slab the player hitbox at p would be inside, or null.
export function insidePartialBlock(p, getBlock) {
  const e = 1e-3;
  const box = [p.x - 0.3, p.y, p.z - 0.3, p.x + 0.3, p.y + 1.8, p.z + 0.3];
  for (let x = Math.floor(box[0] + e); x <= Math.floor(box[3] - e); x++) {
    for (let y = Math.floor(box[1] + e); y <= Math.floor(box[4] - e); y++) {
      for (let z = Math.floor(box[2] + e); z <= Math.floor(box[5] - e); z++) {
        const b = getBlock(new Vec3(x, y, z));
        if (!b || !(b.name.endsWith('_stairs') || b.name.endsWith('_slab'))) continue;
        for (const s of b.shapes) {
          if (x + s[0] < box[3] - e && x + s[3] > box[0] + e && y + s[1] < box[4] - e && y + s[4] > box[1] + e && z + s[2] < box[5] - e && z + s[5] > box[2] + e) return b;
        }
      }
    }
  }
  return null;
}

function describeBlock(block) {
  if (!block) return 'unloaded';
  const props = Object.entries(block.getProperties()).filter(([k]) => k !== 'waterlogged').map(([k, v]) => `${k}=${v}`);
  return props.length ? `${block.name}[${props.join(',')}]` : block.name;
}

function stuckReport(bot, target, tries) {
  const here = bot.entity.position;
  const at = (p) => describeBlock(bot.blockAt(p, false));
  const feet = cellOf(here);
  const to = cellOf(target);
  const near = Object.values(bot.players)
    .filter((pl) => pl.entity && pl.entity !== bot.entity && pl.entity.position.distanceTo(here) < 3)
    .map((pl) => pl.username);
  const xyz = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`;
  return `stuck at ${xyz(here)} (try ${tries}), next step ${xyz(target)}. ` +
    `Here: below ${at(feet.offset(0, -1, 0))}, feet ${at(feet)}, head ${at(feet.offset(0, 1, 0))}. ` +
    `Next: below ${at(to.offset(0, -1, 0))}, feet ${at(to)}, head ${at(to.offset(0, 1, 0))}, above ${at(to.offset(0, 2, 0))}` +
    (near.length ? `. Players close: ${near.join(', ')}` : '');
}

// Helps when the bot stands still on a path, like a player would: jumps when the next step is
// higher, asks a player in the way to move, and when the pathfinder gives up on a step, makes
// the next path try another way. Also undoes the pathfinder's snap to the middle of a block
// when that would put the bot inside a stair or slab, which the server refuses.
function watchStalls(bot) {
  let path = [];
  let anchor = null;
  let stillSince = 0;
  let jumpUntil = 0;
  let lastJump = 0;
  let lastAsk = 0;
  let lastFree = null;
  const avoid = new Map();
  bot.avoidSteps = avoid;
  const getBlock = (p) => bot.blockAt(p, false);

  bot.on('path_update', (results) => { path = results.path; });
  bot.on('path_reset', (reason) => {
    const target = path[0];
    path = [];
    if (reason !== 'stuck' || !target) return;
    const key = cellOf(target).toString();
    const tries = (avoid.get(key)?.tries ?? 0) + 1;
    avoid.set(key, { tries, until: Date.now() + 60000 });
    bot.emit('move_stuck', stuckReport(bot, target, tries));
  });

  bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (!insidePartialBlock(p, getBlock)) lastFree = p.clone();
    else if (lastFree && Math.abs(lastFree.y - p.y) < 0.01 && lastFree.distanceTo(p) <= 0.6) {
      p.x = lastFree.x;
      p.z = lastFree.z;
    }

    if (!bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) {
      anchor = null;
      return;
    }
    const now = Date.now();
    if (!anchor || anchor.distanceTo(p) > 0.2) {
      anchor = p.clone();
      stillSince = now;
    }
    if (now < jumpUntil) {
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      return;
    }
    const next = path[0];
    if (!next || now - stillSince < 1000) return;
    if (next.y - p.y > 0.4 && now - lastJump > 2500) {
      lastJump = now;
      jumpUntil = now + 350;
    }
    // Not the player she's walking to or following, they're meant to be there.
    const dest = bot.pathfinder.goal ? goalPos(bot.pathfinder.goal) : null;
    const blocker = Object.values(bot.players).find((pl) => pl.entity && pl.entity !== bot.entity && pl.entity.position.distanceTo(next) < 1.3 && !(dest && pl.entity.position.distanceTo(dest) < 3));
    if (blocker && now - lastAsk > 30000) {
      lastAsk = now;
      bot.emit('move_blocked', blocker.username);
    }
  });
}

export function setupMovements(bot) {
  const cantBreak = new Set(bot.registry.blocksArray.filter((b) => !isNaturalBlock(b.name)).map((b) => b.id));
  bot.moveModes = Object.fromEntries(Object.entries(MODES).map(([name, mode]) => [name, makeMovements(bot, cantBreak, mode)]));
  bot.pathfinder.setMovements(bot.moveModes.walk);
  bot.moveMode = 'walk';
  bot.pathfinder.thinkTimeout = 10000;
  passagesOnPath(bot);
  watchStalls(bot);
}

// place is true for an everyday walk (blocks only as a last resort), 'climb' for jobs that
// need scaffolding, and false for no placing at all.
export function useMoveMode(bot, place) {
  const name = place === 'climb' ? 'climb' : place ? 'walk' : 'noPlace';
  if (!bot.moveModes || bot.moveMode === name) return;
  bot.pathfinder.setMovements(bot.moveModes[name]);
  bot.moveMode = name;
}

// A player by username, or else the nearest mob with that name tag.
export function findPlayer(bot, name) {
  const wanted = String(name).toLowerCase();
  const player = bot.players[name] ?? Object.values(bot.players).find((p) => p.username.toLowerCase() === wanted);
  if (player?.entity) return player.entity;
  const here = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && customName(e)?.toLowerCase() === wanted)
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] ?? null;
}

function goalPos(goal) {
  if (goal.entity?.position) return goal.entity.position;
  if (goal.pos) return goal.pos;
  if (goal.x !== undefined && goal.z !== undefined) return new Vec3(goal.x, goal.y ?? 0, goal.z);
  return null;
}

// How long a walk of this many blocks may go without getting closer: 3 s a block, at least
// 20 s (a couple of path searches and a retry), at most maxSeconds.
export function walkPatience(distance, maxSeconds) {
  return Math.min(maxSeconds, Math.max(20, distance * 3)) * 1000;
}

// Walks to a goal and turns the usual failures into a result message. With place off, the
// bot never puts blocks down on the way (used when carrying items to hand over, and so on).
// A long walk is fine as long as the bot keeps getting closer; it gives up once it hasn't
// for moveTimeoutSeconds, or a short walk sooner (see walkPatience), not counting time spent
// digging or placing blocks on the way.
export async function walkTo(ctx, goal, { place = true } = {}) {
  const { bot, config, signal } = ctx;
  useMoveMode(bot, place);
  const full = config.limits.moveTimeoutSeconds * 1000;
  const target = goalPos(goal);
  const patience = target ? walkPatience(bot.entity.position.distanceTo(target), config.limits.moveTimeoutSeconds) : full;
  let best = Infinity;
  let bestAt = Date.now();
  let waited = 0;
  let checkedAt = Date.now();
  const stalled = () => {
    const now = Date.now();
    const d = bot.entity.position.distanceTo(target);
    if (d < best - 1) {
      best = d;
      bestAt = now;
      waited = 0;
    } else if (!bot.pathfinder.isMining() && !bot.pathfinder.isBuilding()) {
      waited += now - checkedAt;
    }
    checkedAt = now;
    return now - bestAt > full || waited > patience;
  };
  try {
    await guarded(() => bot.pathfinder.goto(goal), {
      ms: target ? full * 8 : full,
      signal,
      stalled: target ? stalled : undefined,
      onCancel: () => bot.pathfinder.setGoal(null)
    });
    // goto also resolves when the best path is empty, so check the bot really got there.
    const p = bot.entity.position.floored();
    if (!goal.isEnd(p) && !goal.isEnd(p.offset(0, 1, 0))) {
      return fail(`could not get all the way there, ${botPos(bot)}`);
    }
    return ok(`arrived, ${botPos(bot)}`);
  } catch (err) {
    if (err instanceof AbortedError) return fail('stopped');
    if (err instanceof StalledError) return fail(`stuck, got no closer for ${Math.round((Date.now() - bestAt) / 1000)}s, ${botPos(bot)}`);
    if (err instanceof TimeoutError) return fail(`timed out walking, ${botPos(bot)}`);
    if (err.name === 'NoPath' || err.name === 'Timeout') return fail(`no path, ${botPos(bot)}`);
    if (err.name === 'GoalChanged' || err.name === 'PathStopped') return fail(`movement was interrupted, ${botPos(bot)}`);
    return fail(`could not walk there: ${err.message}`);
  }
}

export async function moveTo(ctx, { x, y, z, range }) {
  return walkTo(ctx, new GoalNear(x, y, z, range ?? 1));
}

export async function goToPlayer(ctx, { player, range }, options) {
  const entity = findPlayer(ctx.bot, player);
  if (!entity) return fail(`player not found: ${player} (offline or too far away to see)`);
  const p = entity.position;
  return walkTo(ctx, new GoalNear(p.x, p.y, p.z, range ?? 2), options);
}

// Follows someone by name. Once they go out of view their entity is dropped, so the goal keeps
// the last one seen (the bot heads to where they were) and takes the new one when they're back.
export class GoalFollowPlayer extends GoalFollow {
  constructor(bot, name, entity, range) {
    super(entity, range);
    this.bot = bot;
    this.name = name;
  }

  get entity() {
    const seen = this.seen;
    if (this.bot && !(seen && this.bot.entities[seen.id] === seen)) this.seen = findPlayer(this.bot, this.name) ?? seen;
    return this.seen;
  }

  set entity(entity) {
    this.seen = entity;
  }
}

export async function followPlayer({ bot }, { player, range }) {
  const entity = findPlayer(bot, player);
  if (!entity) return fail(`player not found: ${player} (offline or too far away to see)`);
  useMoveMode(bot, false);
  bot.pathfinder.setGoal(new GoalFollowPlayer(bot, player, entity, range ?? 2), true);
  return ok(`following ${player}`);
}

// Walks up to the player, faces them and tosses the items so they land at their feet.
export async function giveItem(ctx, { player, item, count }) {
  const { bot } = ctx;
  const matching = bot.inventory.items().filter((i) => i.name === item);
  const have = matching.reduce((sum, i) => sum + i.count, 0);
  if (!have) return fail(`missing item: ${item}`);
  const amount = Math.min(count ?? have, have);
  if (amount < 1) return fail('count must be at least 1');

  // No placing on the way, or the walk could use up the very blocks being delivered.
  const walked = await goToPlayer(ctx, { player, range: 2 }, { place: false });
  if (!walked.ok) return walked;
  const entity = findPlayer(bot, player);
  if (entity) await bot.lookAt(entity.position.offset(0, entity.height ?? 1.6, 0));

  const left = bot.inventory.items().filter((i) => i.name === item);
  const now = left.reduce((sum, i) => sum + i.count, 0);
  if (!now) return fail(`missing item: ${item} (had ${have} before walking over)`);
  const give = Math.min(amount, now);
  await bot.toss(left[0].type, null, give);
  leaveDrops(bot);
  return ok(`gave ${give} ${item} to ${player}`);
}

export async function stopMoving({ bot }) {
  bot.pathfinder.setGoal(null);
  return ok(`stopped, ${botPos(bot)}`);
}

export async function lookAt({ bot }, { player, x, y, z }) {
  let target;
  if (player) {
    const entity = findPlayer(bot, player);
    if (!entity) return fail(`player not found: ${player}`);
    target = entity.position.offset(0, entity.height ?? 1.6, 0);
  } else if (x !== undefined && y !== undefined && z !== undefined) {
    target = new Vec3(x + 0.5, y + 0.5, z + 0.5);
  } else {
    return fail('give a player name or x, y and z');
  }
  await bot.lookAt(target);
  return ok(player ? `looking at ${player}` : `looking at ${x} ${y} ${z}`);
}
