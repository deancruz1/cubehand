import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import { ok, fail, botPos, posText, guarded, customName, TimeoutError, AbortedError, StalledError } from './util.js';
import { leaveDrops } from './items.js';
import { digBlock, inReach } from './blocks.js';

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

const lowerHalf = (b) => (b.getProperties().half === 'upper' ? b.position.offset(0, -1, 0) : b.position);

// The cell in front of a door on the side of pos, at the door's floor.
function frontOf(door, facing, pos) {
  if (facing === 'east' || facing === 'west') return door.offset(pos.x < door.x + 0.5 ? -1 : 1, 0, 0);
  return door.offset(0, 0, pos.z < door.z + 0.5 ? -1 : 1);
}

const doorSide = (door, front) => `${door.x},${door.y},${door.z}>${front.x},${front.z}`;

// What opens the iron door at door for someone standing in front, the cell in front of it on
// their side: a pressure plate in that cell (walked onto), or a button or a lever that is off,
// on that side of the wall within two blocks of the doorway, from the floor to just over the door.
export function doorOpener(bot, door, front) {
  const at = (p) => bot.blockAt(p, false);
  if (at(front)?.name.endsWith('_pressure_plate')) return { plate: front };
  const along = door.x === front.x ? [1, 0] : [0, 1];
  for (let a = -2; a <= 2; a++) {
    for (let dy = 0; dy <= 2; dy++) {
      const b = at(front.offset(along[0] * a, dy, along[1] * a));
      if (!b || !(b.name.endsWith('_button') || b.name === 'lever')) continue;
      if (b.name === 'lever' && String(b.getProperties().powered) === 'true') continue;
      return { press: b.position, lever: b.name === 'lever' };
    }
  }
  return null;
}

// Whether the walk may go through the iron door at door from front: it's open, or there is
// something on that side to open it with that hasn't already failed to.
function canPassIron(bot, door, front) {
  const b = bot.blockAt(door, false);
  if (b && isOpen(b)) return true;
  if ((bot.ironDoorFails?.get(doorSide(door, front)) ?? 0) > Date.now()) return false;
  return doorOpener(bot, door, front) !== null;
}

// Blocks that sit on or hang from the block next to them and pop off when it is dug.
const ATTACHED = /(_door|torch|lantern|sign|rail|ladder|banner|button|lever|pressure_plate|redstone_wire|_bed)$/;
// Natural blocks the walk doesn't dig, which are no sign of a build either.
const WILD_SOLID = /sandstone$|terracotta$|ice$|obsidian$|basalt$|^blackstone$|^bedrock$|^magma_block$|^glowstone$|amethyst|mushroom|^infested_|coral_block$|^sculk|^suspicious_|_nylium$|wart_block$|^shroomlight$/;
const FACES6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// True when a block touching pos face to face is part of a build: a door, torch, ladder or
// other block that would pop off, or, unless attachedOnly, a solid block that isn't terrain
// (cobblestone counts unless the bot placed it).
function touchesBuild(bot, pos, attachedOnly) {
  for (const [dx, dy, dz] of FACES6) {
    const p = pos.offset(dx, dy, dz);
    const b = bot.blockAt(p, false);
    if (!b) continue;
    if (ATTACHED.test(b.name)) return true;
    if (attachedOnly || b.boundingBox !== 'block') continue;
    if (b.name === 'cobblestone' || b.name === 'cobbled_deepslate') {
      if (!bot.placedLog?.has(p, b.name)) return true;
    } else if (!looksNatural(b.name) && !WILD_SOLID.test(b.name)) {
      return true;
    }
  }
  return false;
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
    if (b.name.endsWith('_door') || isGate(b.name)) {
      // Iron doors only count as a way through from a side that can open them (ironShut).
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
  // like a tuff wall, or what a player just put down (see watchPlayerBlocks).
  // Nor terrain touching a build: a dug block under a door or behind a torch drops it, and a
  // hole next to a wall opens up someone's house. A dig walk only keeps to the first part.
  safeToBreak(block) {
    if (block.position && this.bot.placedLog?.has(block.position, block.name)) return false;
    if (block.position && playerPlaced(this.bot, block.position)) return false;
    if (!super.safeToBreak(block)) return false;
    return !(block.position && touchesBuild(this.bot, block.position, this.digWalk));
  }

  // Doors and gates can only be walked through straight on, along the way they face. From the
  // side, the frame or the open door itself is in the way. Checks the block the move starts in
  // and the given heights of the block it goes to.
  intoPassageSideways(node, dir, dys) {
    const along = dir.x !== 0 ? ['east', 'west'] : ['north', 'south'];
    const cells = [this.getBlock(node, 0, 0, 0), ...dys.map((dy) => this.getBlock(node, dir.x, dy, dir.z))];
    return cells.some((b) => b.passage && (b.name.endsWith('_door') || isGate(b.name)) && !along.includes(b.getProperties().facing));
  }

  // A closed iron door at the given heights of the block the move goes to, with nothing on
  // this side to open it.
  ironShut(node, dir, dys) {
    for (const dy of dys) {
      const b = this.getBlock(node, dir.x, dy, dir.z);
      if (!b.passage || b.name !== 'iron_door') continue;
      const door = lowerHalf(b);
      const front = door.offset(-dir.x, 0, -dir.z);
      if (canPassIron(this.bot, door, front)) continue;
      this.onRefusedDoor?.(door, front);
      return true;
    }
    return false;
  }

  // A door's lower half counts as no floor, so a jump over it looks fine, but the body goes
  // through the upper half and stops at the door.
  getMoveParkourForward(node, dir, neighbors) {
    for (let d = 1; d <= 4; d++) {
      for (const dy of [-1, 0, 1]) {
        const b = this.getBlock(node, dir.x * d, dy, dir.z * d);
        if (b.name === 'iron_door' || b.passage) return;
      }
    }
    super.getMoveParkourForward(node, dir, neighbors);
  }

  // A ladder counts as solid to the pathfinder, so it would happily walk across the top of a
  // ladder shaft and drop down it. Only climbing or dropping into the shaft is allowed.
  overLadder(node, dx, dy, dz) {
    return this.getBlock(node, dx, dy - 1, dz).climbable && !this.getBlock(node, dx, dy, dz).climbable;
  }

  getMoveForward(node, dir, neighbors) {
    if (this.overLadder(node, dir.x, 0, dir.z) || this.intoPassageSideways(node, dir, [0, 1]) || this.ironShut(node, dir, [0, 1])) return;
    super.getMoveForward(node, dir, neighbors);
  }

  getMoveDropDown(node, dir, neighbors) {
    if (this.intoPassageSideways(node, dir, [0, 1]) || this.ironShut(node, dir, [0, 1])) return;
    super.getMoveDropDown(node, dir, neighbors);
  }

  getMoveJumpUp(node, dir, neighbors) {
    if (this.overLadder(node, dir.x, 1, dir.z) || this.intoPassageSideways(node, dir, [1, 2]) || this.ironShut(node, dir, [1, 2])) return;
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
    if (!b || !(b.name.endsWith('_door') || isGate(b.name))) continue;
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
  const pressed = new Map();
  const levers = new Map();
  bot.openedPassages = opened;
  bot.ironDoorFails = new Map();
  bot.leverWait = levers;
  bot.leversLeftOn = [];

  // An iron door ahead opens with what is on the bot's side of it, once she stands in front of
  // it: a plate needs nothing, a button or lever gets pressed. A button only holds the door for
  // a second or so, so she presses again when it shut before she got through. When two presses
  // in a row left it shut, the door doesn't open from this side and walks leave it for 5 minutes.
  const openIron = (door, here) => {
    const block = bot.blockAt(door, false);
    if (!block || block.name !== 'iron_door') return;
    const key = door.toString();
    const press = pressed.get(key);
    if (isOpen(block)) {
      if (press) press.opened = true;
      return;
    }
    const front = frontOf(door, block.getProperties().facing, here);
    if (Math.hypot(here.x - front.x - 0.5, here.z - front.z - 0.5) > 1.2 || Math.abs(here.y - front.y) > 1) return;
    const opener = doorOpener(bot, door, front);
    if (!opener?.press || (press && Date.now() - press.at < 1500)) return;
    const tries = press && !press.opened ? press.tries : 0;
    if (tries >= 2) {
      bot.ironDoorFails.set(doorSide(door, front), Date.now() + 300000);
      pressed.delete(key);
      return;
    }
    pressed.set(key, { at: Date.now(), tries: tries + 1, opened: false });
    if (opener.lever) levers.set(key, { lever: opener.press, door, at: Date.now() });
    bot.activateBlock(bot.blockAt(opener.press, false)).catch(() => {});
  };
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
          if (block?.name === 'iron_door') openIron(lowerHalf(block), here);
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

    for (const [key, { lever, door, at }] of levers) {
      if (Date.now() - at < 800 || door.offset(0.5, 0.5, 0.5).distanceTo(here) < 2.5 || replanning) continue;
      if (path.slice(0, 4).some((n) => Math.floor(n.x) === door.x && Math.floor(n.z) === door.z && Math.abs(n.y - door.y) <= 1)) continue;
      if (Object.values(bot.players).some((p) => p.entity && p.entity !== bot.entity && p.entity.position.distanceTo(door.offset(0.5, 0, 0.5)) < 2)) continue;
      levers.delete(key);
      putLeverBack(bot, { lever, door });
    }
    for (const [key, { at }] of pressed) if (Date.now() - at > 60000) pressed.delete(key);
  });
}

// A lever the bot switched on to get through an iron door goes back off when she can still
// reach it and see it from where she is now. Otherwise it stays on, and the walk says so.
function putLeverBack(bot, { lever, door }) {
  const b = bot.blockAt(lever, false);
  if (!b || b.name !== 'lever' || String(b.getProperties().powered) !== 'true') return;
  if (inSight(bot, lever)) {
    bot.activateBlock(b).catch(() => {});
    return;
  }
  bot.leversLeftOn.push({ lever, door });
}

function inSight(bot, pos) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const dir = pos.offset(0.5, 0.5, 0.5).minus(eye);
  const dist = dir.norm();
  if (dist > 4.5) return false;
  const hit = bot.world?.raycast?.(eye, dir.normalize(), dist);
  return !hit || hit.position.equals(pos);
}

// Levers still waiting to go back off when a walk ends, sorted out right away.
function settleLevers(bot) {
  for (const [key, l] of bot.leverWait ?? []) {
    bot.leverWait.delete(key);
    putLeverBack(bot, l);
  }
}

// Cheap blocks the pathfinder may place to tower up or bridge gaps.
export const SCAFFOLD_BLOCKS = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone',
  'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'coarse_dirt', 'blackstone'
];

// Notes where the pathfinder puts scaffolding blocks down inside inArea(pos) until stop() is
// called, so a job can clean up after itself. A build's watcher (one started while
// bot.buildZone is set) claims what it notes in bot.scaffoldClaims: the build takes that down
// itself, so it is no walk scaffolding.
export function watchScaffold(bot, inArea) {
  const placed = [];
  const claims = bot.buildZone ? (bot.scaffoldClaims ??= new Set()) : null;
  const onUpdate = (oldBlock, newBlock) => {
    if (!newBlock || !SCAFFOLD_BLOCKS.includes(newBlock.name)) return;
    if (oldBlock && oldBlock.boundingBox === 'block') return;
    if (!pathfinderPlacing(bot, newBlock.position) || !inArea(newBlock.position)) return;
    placed.push(newBlock.position.clone());
    claims?.add(cellKey(newBlock.position));
  };
  bot.on('blockUpdate', onUpdate);
  const stop = () => {
    bot.removeListener('blockUpdate', onUpdate);
    for (const p of placed) claims?.delete(cellKey(p));
  };
  return { placed, stop };
}

const AIR = new Set(['air', 'cave_air', 'void_air']);

// The pathfinder's own placing (isBuilding) is over by the time any other blockUpdate listener
// hears of the block: its own listener comes first and resets the path. So its blocks are
// caught where it calls placeBlock instead. The spot goes in bot.pathfinderPlaces from just
// before the call until PLACING_GRACE_MS after it settles (an update can come after a timed out
// call), for every listener to check with pathfinderPlacing. The block goes in bot.walkScaffold
// (a ScaffoldLog), and in bot.walkPlacements for the walk going on.
const PLACING_GRACE_MS = 2000;

export function markPathfinderPlace(bot, pos, until = Infinity) {
  const places = (bot.pathfinderPlaces ??= new Map());
  for (const [key, t] of places) if (t <= Date.now()) places.delete(key);
  places.set(cellKey(pos), until);
}

export function pathfinderPlacing(bot, pos) {
  return (bot.pathfinderPlaces?.get(cellKey(pos)) ?? 0) > Date.now();
}

function watchWalkScaffold(bot) {
  const placeBlock = bot.placeBlock;
  if (placeBlock) {
    bot.placeBlock = async (reference, face, ...rest) => {
      const walk = bot.pathfinder.isBuilding();
      const pos = reference.position.plus(face);
      const before = bot.blockAt(pos, false);
      if (walk) markPathfinderPlace(bot, pos);
      try {
        return await placeBlock(reference, face, ...rest);
      } finally {
        if (walk) {
          markPathfinderPlace(bot, pos, Date.now() + PLACING_GRACE_MS);
          if (before && before.boundingBox !== 'block') noteWalkScaffold(bot, pos);
        }
      }
    };
  }
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (newBlock?.position) bot.walkScaffold?.check(newBlock.position, bot.game?.dimension, newBlock.name);
  });
}

function noteWalkScaffold(bot, pos) {
  const log = bot.walkScaffold;
  const block = bot.blockAt(pos, false);
  if (!log || !block || !SCAFFOLD_BLOCKS.includes(block.name) || bot.scaffoldClaims?.has(cellKey(pos))) return;
  const around = FACES6.map(([dx, dy, dz]) => bot.blockAt(pos.offset(dx, dy, dz), false)?.name ?? null);
  log.add(block.name, pos, bot.game?.dimension, around);
  bot.walkPlacements?.push(pos);
}

// True when pos is the block the bot stands on, or one further down under her.
export function underBot(bot, pos) {
  const p = bot.entity.position;
  if (pos.y > Math.floor(p.y - 0.01)) return false;
  return pos.x >= Math.floor(p.x - 0.3) && pos.x <= Math.floor(p.x + 0.3) && pos.z >= Math.floor(p.z - 0.3) && pos.z <= Math.floor(p.z + 0.3);
}

// Whether her walk scaffolding at pos may come down now. 'wait' while a build going on is round
// it, a block of hers on top of it still stands (top first), or a neighbour isn't loaded.
// 'unsafe' when something that isn't terrain or hers has turned up against it since she put it
// there, like a player's torch or block: then it stays up for good. A neighbour that was already
// there can't hang from her block, which wasn't there yet.
export function scaffoldRemovable(bot, pos) {
  const log = bot.walkScaffold;
  const dim = bot.game?.dimension;
  const entry = log?.get(pos, dim);
  if (!entry || inZone(bot.buildZone, pos)) return 'wait';
  for (let i = 0; i < FACES6.length; i++) {
    const p = pos.offset(...FACES6[i]);
    const b = bot.blockAt(p, false);
    if (!b) return 'wait';
    if (log.has(p, b.name, dim)) {
      if (FACES6[i][1] === 1) return 'wait';
      continue;
    }
    if (b.name === entry.around?.[i] || AIR.has(b.name) || b.name === 'water') continue;
    if (ATTACHED.test(b.name)) return 'unsafe';
    if (bot.placedLog?.has(p, b.name)) continue;
    if (playerPlaced(bot, p)) return 'unsafe';
    if (isNaturalBlock(b.name)) continue;
    return 'unsafe';
  }
  return 'ok';
}

// Right after a walk she takes down this many of its blocks at most, the ones in reach that each
// break within QUICK_DIG_MS. The rest are left for free time (the tidy chore in idle.js).
const TAKE_DOWN_MAX = 4;
const QUICK_DIG_MS = 1500;

function slowToBreak(bot, block) {
  const tool = bot.pathfinder.bestHarvestTool?.(block);
  return block.digTime(tool?.type ?? null, false, false, false, [], {}) > QUICK_DIG_MS;
}

// Takes down what a walk just put down, top first, from where she stands: never the block under
// her or one holding it up.
async function takeDownBehind(ctx, placed) {
  const { bot } = ctx;
  const log = bot.walkScaffold;
  const dim = bot.game?.dimension;
  let removed = 0;
  for (const pos of [...placed].sort((a, b) => b.y - a.y)) {
    if (removed >= TAKE_DOWN_MAX || ctx.signal?.aborted || bot.pathfinder.goal) break;
    const block = bot.blockAt(pos, false);
    if (!block || !log.has(pos, block.name, dim) || underBot(bot, pos) || !inReach(bot, pos) || slowToBreak(bot, block)) continue;
    const safe = scaffoldRemovable(bot, pos);
    if (safe === 'unsafe') log.removeColumn(pos, dim);
    if (safe !== 'ok') continue;
    if ((await digBlock(ctx, pos, { anyTool: true })).ok) {
      log.remove(pos, dim);
      removed++;
    }
  }
  return removed;
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

// Costs are in blocks of walking. The pathfinder charges (1 + 3 x seconds to break) x digCost
// for a dug block, and most blocks take about half a second with the right tool, so a digCost
// of 8 makes breaking a block worth about 20 blocks of walking: the bot goes round anything
// shorter. Slow blocks cost more, and a step over 100 is never taken, so it never digs stone
// by hand. Jobs that have to reach high places (tall trees, building) use climb, where a dug
// block is worth about 7. Nothing is ever placed next to builds.
//
// MODES are for the pathfinder's own searches, which follow a moving goal (a player, a mob)
// as they go, in follow, which never digs or places. Walks to a fixed spot
// are planned in full first (planRoute) with PLAN_MODES: on foot first, so digging and placing
// only come in when no existing way is short enough, and then a placed block can be cheap (one
// extra block of walking). The search has to rule out everything cheaper before it settles on
// a climb: at a placeCost of 12 an 18 block pillar isn't found in 20 s, at 1 in about a second.
const MODES = {
  walk: { digCost: 8, placeCost: 40, place: true },
  climb: { digCost: 3, placeCost: 12, place: true },
  noPlace: { digCost: 8, place: false },
  follow: { dig: false, place: false }
};

const PLAN_MODES = {
  onFoot: { dig: false, place: false },
  walk: { digCost: 8, placeCost: 1, place: true },
  climb: { digCost: 3, placeCost: 1, place: true },
  noPlace: { digCost: 8, place: false },
  digClimb: { digCost: 2, placeCost: 1, place: true, digWalk: true },
  digNoPlace: { digCost: 2, place: false, digWalk: true }
};

function makeMovements(bot, cantBreak, { digCost = 0, placeCost = 0, place, dig = true, digWalk = false }) {
  const m = new DoorMovements(bot);
  m.canDig = dig;
  m.digWalk = digWalk;
  m.digCost = digCost;
  m.placeCost = placeCost;
  // Plan around players and mobs where there's room, so someone standing in one half of a
  // double door doesn't block the way.
  m.entityCost = 4;
  m.blocksCantBreak = cantBreak;
  m.allow1by1towers = place;
  m.scafoldingBlocks = place ? SCAFFOLD_BLOCKS.map((name) => bot.registry.itemsByName[name]?.id).filter((id) => id !== undefined) : [];
  // Inside the area of a house it is building, the bot may put up scaffolding next to its own walls.
  m.exclusionAreasPlace = [(block) => {
    if (inZone(bot.buildZone, block.position) || !nearBuild(bot, block.position)) return 0;
    m.onRefusedPlace?.(block.position);
    return 100;
  }];
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

// Steps after the first one that digs or places keep the pathfinder's raw block coordinates,
// which are the corner of the block, not its middle, because it normally plans again after
// every dig or place. When it doesn't (the block was already gone, so nothing changed, or a
// planned walk carries on with the rest of its steps), the bot heads for the corner: on a step
// down it stays on the edge of the blocks around and never drops.
export function centreRawSteps(path) {
  const first = path.findIndex((n) => n.toBreak.length > 0 || n.toPlace.length > 0);
  if (first < 0) return;
  for (const n of path.slice(first)) {
    n.x = Math.floor(n.x) + 0.5;
    n.z = Math.floor(n.z) + 0.5;
  }
}

// The pathfinder aims a step up a ladder at the middle of the ladder's thin plate, on the wall
// side of the block, so the bot presses on the plate and climbs. Coming from the side, along
// the wall, the bot's body runs into the end of the plate at the edge of the block and never
// gets onto the ladder. A step into the middle of the ladder's block at the floor goes first,
// and from there the climb presses on the plate.
export function ladderEntrySteps(path, from, getBlock) {
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    if (step.toBreak.length > 0 || step.toPlace.length > 0) return;
    const prev = i > 0 ? path[i - 1] : from;
    const ladder = new Vec3(Math.floor(step.x), Math.floor(step.y) - 1, Math.floor(step.z));
    if (step.y - prev.y < 0.5 || (Math.floor(prev.x) === ladder.x && Math.floor(prev.z) === ladder.z)) continue;
    const floor = new Vec3(ladder.x, Math.floor(prev.y), ladder.z);
    if (floor.y > ladder.y || getBlock(ladder)?.name !== 'ladder' || getBlock(floor)?.name !== 'ladder') continue;
    const entry = copyStep(step);
    entry.x = floor.x + 0.5;
    entry.y = floor.y;
    entry.z = floor.z + 0.5;
    path.splice(i, 0, entry);
    i++;
  }
}

// A block that fills an empty spot with a player close by, like dirt patched into a hole. It
// looks like terrain, so walks would dig it, but someone put it there: walks leave it for an
// hour. Not a block the pathfinder put down there itself (pathfinderPlacing).
const PLAYER_BLOCK_MS = 3600000;
const PLAYER_BLOCK_MAX = 5000;

function watchPlayerBlocks(bot) {
  const blocks = new Map();
  bot.playerBlocks = blocks;
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock?.position || !bot.entity) return;
    const key = cellKey(newBlock.position);
    if (newBlock.boundingBox !== 'block') {
      blocks.delete(key);
      return;
    }
    if (oldBlock.boundingBox !== 'empty') return;
    const centre = newBlock.position.offset(0.5, 0.5, 0.5);
    if (pathfinderPlacing(bot, newBlock.position)) return;
    if (!Object.values(bot.players).some((p) => p.entity && p.entity !== bot.entity && p.entity.position.distanceTo(centre) <= 6)) return;
    blocks.delete(key);
    blocks.set(key, Date.now() + PLAYER_BLOCK_MS);
    if (blocks.size > PLAYER_BLOCK_MAX) blocks.delete(blocks.keys().next().value);
  });
}

export function playerPlaced(bot, pos) {
  const key = cellKey(pos);
  const until = bot.playerBlocks?.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  bot.playerBlocks.delete(key);
  return false;
}

export function setupMovements(bot) {
  const cantBreak = new Set(bot.registry.blocksArray.filter((b) => !isNaturalBlock(b.name)).map((b) => b.id));
  bot.moveModes = Object.fromEntries(Object.entries(MODES).map(([name, mode]) => [name, makeMovements(bot, cantBreak, mode)]));
  bot.planModes = Object.fromEntries(Object.entries(PLAN_MODES).map(([name, mode]) => [name, makeMovements(bot, cantBreak, mode)]));
  bot.pathfinder.setMovements(bot.moveModes.walk);
  bot.moveMode = 'walk';
  bot.pathfinder.thinkTimeout = 10000;
  // A planned walk hands the pathfinder its own steps instead of a search of its own.
  const getPathTo = bot.pathfinder.getPathTo;
  if (getPathTo) {
    bot.pathfinder.getPathTo = (movements, goal, timeout) => {
      const walk = bot.plannedWalk;
      return walk && walk.goal === goal ? walk.handOut() : getPathTo(movements, goal, timeout);
    };
  }
  bot.on('path_update', (results) => {
    centreRawSteps(results.path);
    if (bot.entity) ladderEntrySteps(results.path, bot.entity.position, (p) => bot.blockAt(p, false));
  });
  // A moving goal (a player or mob to keep up with) never digs: wherever they went there is a
  // way that needs none, and when the bot can't keep up it waits there instead of tunnelling.
  const setGoal = bot.pathfinder.setGoal;
  if (setGoal) {
    bot.pathfinder.setGoal = (goal, dynamic) => {
      if (goal && 'entity' in goal && bot.pathfinder.movements?.canDig) {
        bot.pathfinder.setMovements(bot.moveModes.follow);
        bot.moveMode = 'follow';
      }
      setGoal(goal, dynamic);
    };
  }
  watchPlayerBlocks(bot);
  watchWalkScaffold(bot);
  passagesOnPath(bot);
  watchStalls(bot);
}

function modeName(place) {
  return place === 'climb' ? 'climb' : place ? 'walk' : 'noPlace';
}

function planModeName(place, dig) {
  if (dig) return place ? 'digClimb' : 'digNoPlace';
  return modeName(place);
}

// place is true for an everyday walk (blocks only as a last resort), 'climb' for jobs that
// need scaffolding, and false for no placing at all.
export function useMoveMode(bot, place) {
  const name = modeName(place);
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

// How long a planned walk may search, in ms: first for a way on foot, then for one that digs
// or places.
export const PLAN_BUDGET = { onFoot: 2500, build: 5000 };

// A way on foot counts as long as it is at most twice the straight distance plus 24 blocks
// (stairs cost 2 a block up, so this takes in a staircase too). Past that, digging or placing
// is the better deal. Returns the pathfinder's searchRadius, which it adds to the distance.
export function onFootRadius(distance) {
  return distance + 24;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// Runs one search a slice at a time (tickTimeout each), so the bot keeps ticking while it
// thinks. Null when stopped.
async function search(bot, movements, goal, timeout, radius, stopped) {
  const slices = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout, searchRadius: radius });
  let { result } = slices.next().value;
  while (result.status === 'partial') {
    await nextTurn();
    if (stopped()) return null;
    result = slices.next().value.result;
  }
  return result;
}

// True when the bot could stand at cell, as the pathfinder sees it.
function standable(m, cell) {
  const feet = m.getBlock(cell, 0, 0, 0);
  const head = m.getBlock(cell, 0, 1, 0);
  const below = m.getBlock(cell, 0, -1, 0);
  return feet.safe && head.safe && (below.physical || below.climbable || feet.climbable || feet.liquid);
}

// For a goal around one spot (GoalNear, GoalBlock): true when no cell that ends it has room to stand.
function nowhereToStand(m, goal) {
  if (goal.x === undefined || goal.y === undefined || goal.z === undefined) return false;
  const r = Math.ceil(Math.sqrt(goal.rangeSq ?? 0));
  if (r > 3) return false;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = new Vec3(goal.x + dx, goal.y + dy, goal.z + dz);
        if (goal.isEnd(cell) && standable(m, cell)) return false;
      }
    }
  }
  return true;
}

function noRouteText(bot, goal, m, tried, refused, doors = new Map()) {
  const parts = [`no route found, so nothing was dug or placed. Tried ${tried.join(', then ')}`];
  const here = bot.entity.position;
  const door = [...doors.values()].sort((a, b) => a.door.distanceTo(here) - b.door.distanceTo(here))[0];
  if (door) {
    const failed = (bot.ironDoorFails?.get(doorSide(door.door, door.front)) ?? 0) > Date.now();
    parts.push(failed
      ? `The iron door at ${posText(door.door)} didn't open with the button or lever on this side`
      : `There is an iron door at ${posText(door.door)} with no button, lever or pressure plate on this side`);
  }
  const target = goalPos(goal);
  if (target && nowhereToStand(m, goal)) {
    const r = Math.round(Math.sqrt(goal.rangeSq ?? 0));
    parts.push(`There is nowhere to stand ${r ? `within ${r} of` : 'at'} ${posText(target)}`);
  }
  const up = target ? Math.floor(target.y) - Math.floor(bot.entity.position.y) : 0;
  if (up >= 3) parts.push(`The spot is ${up} blocks above my feet`);
  if (!m.allow1by1towers) {
    parts.push('Placing blocks is off for this walk');
  } else {
    const blocks = m.countScaffoldingItems();
    parts.push(blocks ? `I had ${blocks} blocks to build up with` : 'I have no spare dirt, cobblestone or similar to build up with');
  }
  if (refused) parts.push("Placing blocks against the build near the spot was ruled out, I only do that inside a build job's area");
  return parts.join('. ');
}

// The search's goal for a walk that digs its way to a block. A look goal raycasts the world as
// it is, so a buried block is never in sight from anywhere and the search can't end. A spot
// whose feet or head touch the block (or with it right over the head) counts too, since the
// route has dug those open by the time the bot stands there. In rock every step costs about
// the same, so a plain search digs out a ball around the bot before it goes anywhere; the
// heuristic is weighted by DIG_WEIGHT to send it straight at the block.
export const DIG_WEIGHT = 16;

function digGoal(goal, weight) {
  const t = goal.pos;
  const touches = (n) => {
    const dx = Math.abs(n.x - t.x);
    const dz = Math.abs(n.z - t.z);
    const dy = t.y - n.y;
    if (dx === 0 && dz === 0) return dy === 2;
    return dx + dz === 1 && (dy === 0 || dy === 1);
  };
  return {
    heuristic: (n) => goal.heuristic(n) * weight,
    isEnd: (n) => goal.isEnd(n) || touches(n),
    hasChanged: () => false,
    isValid: () => true
  };
}

// Works out a route to goal before the bot takes a step. First on foot (no digging, no
// placing) within onFootRadius, then with the digging and placing the walk allows. Gives
// { status: 'success', path } for a complete route, { status: 'partial', path, left } for a
// way that only gets closer (left is the distance it leaves), or { status: 'none', message }
// when there is nothing worth walking. A partial way is on foot, except on a dig walk (dig set,
// for a block to dig out), where it may dig: it only goes through what the walk may dig anyway.
// With onFoot set there is only the first search. Null when stopped.
export async function planRoute(bot, goal, place, options = {}) {
  const doors = new Map();
  const m = options.onFoot ? bot.planModes.onFoot : bot.planModes[planModeName(place, options.dig)];
  const onDoor = (door, front) => doors.set(doorSide(door, front), { door, front });
  bot.planModes.onFoot.onRefusedDoor = onDoor;
  m.onRefusedDoor = onDoor;
  try {
    return await planSearches(bot, goal, place, m, doors, options);
  } finally {
    bot.planModes.onFoot.onRefusedDoor = null;
    m.onRefusedDoor = null;
  }
}

async function planSearches(bot, goal, place, m, doors, { dig = false, onFoot = false, onFootMs = PLAN_BUDGET.onFoot, buildMs = PLAN_BUDGET.build, stopped = () => false }) {
  const here = bot.entity.position.floored();
  if (goal.isEnd(here)) return { status: 'success', path: [] };
  const digging = dig && goal.pos;
  const footGoal = digging ? digGoal(goal, 1) : goal;
  const h = goal.heuristic(here);
  const foot = await search(bot, bot.planModes.onFoot, footGoal, onFootMs, onFootRadius(h), stopped);
  if (!foot) return null;
  if (foot.status === 'success') return { status: 'success', path: foot.path };

  const left = foot.context.bestNode.h;
  const tried = [foot.status === 'noPath'
    ? `on foot (no way within ${Math.round(h + onFootRadius(h))} blocks of walking)`
    : `on foot (nothing complete after ${onFootMs / 1000}s)`];
  const closer = foot.path.length > 0 && h - left >= 2 ? { status: 'partial', path: foot.path, left } : null;
  // Still getting closer on foot when time ran out: keep walking and look again from there.
  if (foot.status === 'timeout' && closer && h - left >= Math.max(8, h / 4)) return { ...closer, message: noRouteText(bot, goal, m, tried, 0, doors) };
  if (onFoot) {
    const message = noRouteText(bot, goal, m, tried, 0, doors);
    return closer ? { ...closer, message } : { status: 'none', message };
  }

  let refused = 0;
  const target = goalPos(goal);
  m.onRefusedPlace = target ? (p) => { if (p.distanceTo(target) <= 5) refused++; } : null;
  const build = await search(bot, m, digging ? digGoal(goal, DIG_WEIGHT) : goal, buildMs, -1, stopped);
  m.onRefusedPlace = null;
  if (!build) return null;
  if (build.status === 'success') return { status: 'success', path: build.path };
  const how = m.allow1by1towers ? 'digging and placing' : 'digging';
  tried.push(build.status === 'noPath' ? `${how} (no way at all)` : `${how} (nothing complete after ${buildMs / 1000}s)`);
  const message = noRouteText(bot, goal, m, tried, refused, doors);
  if (build.status === 'timeout' && digging && build.path.length > 0) {
    const dug = goal.heuristic(build.context.bestNode.data);
    if (h - dug >= 2) return { status: 'partial', path: build.path, left: dug, message };
  }
  if (build.status === 'timeout' && closer) return { ...closer, message };
  return { status: 'none', message };
}

function cellKey(p) {
  return `${p.x},${p.y},${p.z}`;
}

// The blocks a path digs out or puts down itself.
function ownChanges(path) {
  const cells = new Set();
  for (const step of path) {
    for (const b of step.toBreak) cells.add(cellKey(b));
    for (const p of step.toPlace) if (!p.useOne) cells.add(cellKey({ x: p.x + p.dx, y: p.y + p.dy, z: p.z + p.dz }));
  }
  return cells;
}

function pathError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

// Walks to a fixed goal along a route planned in full first (planRoute), standing still while
// it plans. The pathfinder still does the walking: getPathTo hands it the planned steps (see
// setupMovements). It plans again after every dig or place, so after one of the route's own
// it gets the rest of the same steps back. Any other reason (stuck, a block on the way changed
// by someone else, out of blocks, the steps ran out short of the goal) makes the bot stand
// still and plan again from where it is.
async function plannedGoto(bot, goal, place, dig, onFoot) {
  const walk = { goal, ready: null, steps: [], expected: new Set(), reset: null, dirty: false, following: false, replan: false, end: null };
  let wake = () => {};
  const again = () => {
    walk.following = false;
    walk.replan = true;
    wake();
  };
  walk.handOut = () => {
    if (walk.ready) {
      walk.steps = walk.ready.path;
      walk.ready = null;
      walk.expected = ownChanges(walk.steps);
      walk.reset = null;
      walk.dirty = false;
      walk.following = true;
      return { status: 'success', path: walk.steps };
    }
    if (walk.following && walk.reset === 'block_updated' && !walk.dirty && walk.steps.length > 0) {
      walk.reset = null;
      return { status: 'success', path: walk.steps };
    }
    bot.clearControlStates();
    if (walk.following) again();
    return { status: 'planning', path: [] };
  };

  const onReached = (g) => {
    if (g !== goal) return;
    walk.end = 'reached';
    wake();
  };
  const onGoal = (g) => {
    if (g === goal) return;
    walk.end = 'changed';
    wake();
  };
  const onStop = () => {
    walk.end = 'stopped';
    wake();
  };
  const onReset = (reason) => { walk.reset = reason; };
  const onBlock = (oldBlock, newBlock) => {
    if (!walk.following || !oldBlock || !newBlock || oldBlock.type === newBlock.type) return;
    const p = oldBlock.position;
    if (walk.expected.has(cellKey(p))) return;
    if (walk.steps.some((s) => Math.abs(s.x - p.x - 0.5) <= 2 && Math.abs(s.y - p.y) <= 3 && Math.abs(s.z - p.z - 0.5) <= 2)) walk.dirty = true;
  };
  const onTick = () => {
    if (walk.following) {
      if (walk.steps.length === 0 && !bot.pathfinder.isMoving() && bot.pathfinder.goal === goal) again();
    } else if (bot.entity?.isInWater) {
      bot.setControlState('jump', true);
    }
  };
  const events = { goal_reached: onReached, goal_updated: onGoal, path_stop: onStop, path_reset: onReset, blockUpdate: onBlock, physicsTick: onTick };
  for (const [name, fn] of Object.entries(events)) bot.on(name, fn);
  bot.plannedWalk = walk;
  try {
    bot.pathfinder.setGoal(goal);
    let best = Infinity;
    while (!walk.end) {
      walk.replan = false;
      const plan = await planRoute(bot, goal, place, { dig, onFoot, stopped: () => walk.end !== null });
      if (!plan || walk.end) break;
      if (plan.status === 'none') throw pathError('NoRoute', plan.message);
      if (plan.path.length === 0) break;
      if (plan.status === 'partial') {
        if (plan.left > best - 1) throw pathError('NoRoute', `${plan.message}. Walked as close as I could on foot`);
        best = plan.left;
      }
      walk.ready = plan;
      bot.pathfinder.setGoal(goal);
      await new Promise((resolve) => {
        wake = resolve;
        if (walk.end || walk.replan) resolve();
      });
    }
  } finally {
    for (const [name, fn] of Object.entries(events)) bot.removeListener(name, fn);
    if (bot.plannedWalk === walk) bot.plannedWalk = null;
    if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
  }
  if (walk.end === 'changed') throw pathError('GoalChanged', 'The goal was changed before it could be completed!');
  if (walk.end === 'stopped') throw pathError('PathStopped', 'Path was stopped before it could be completed!');
}

// A failed walk says why in reason: 'no_route' (planned, nothing found), 'no_path' (the
// pathfinder's own search), 'stuck', 'timeout', 'short' (ended before the goal), 'stopped',
// 'interrupted' (another goal took over) or 'error'.
function walkFail(reason, message) {
  return { ...fail(message), reason };
}

// Walks to a goal and turns the usual failures into a result message. With place off, the
// bot never puts blocks down on the way (used when carrying items to hand over, and so on).
// A long walk is fine as long as the bot keeps getting closer; it gives up once it hasn't
// for moveTimeoutSeconds, or a short walk sooner (see walkPatience), not counting time spent
// digging or placing blocks on the way. A fixed goal gets its route planned first
// (plannedGoto); a moving one (an entity) is left to the pathfinder, which keeps up with it.
// Set dig when the walk is to a block the bot will dig out, so a buried one can be dug to, and
// onFoot for a walk that neither digs nor places. A lever left on to get through an iron door is
// mentioned at the end. Scaffolding the walk put down comes down again where she can reach it
// from where she ends up, unless the walk was stopped for something else.
export async function walkTo(ctx, goal, options = {}) {
  const { bot } = ctx;
  bot.leversLeftOn?.splice(0);
  const placed = [];
  const outer = bot.walkPlacements;
  bot.walkPlacements = placed;
  let result;
  try {
    result = await walkOnce(ctx, goal, options);
  } finally {
    bot.walkPlacements = outer;
  }
  settleLevers(bot);
  if (placed.length && bot.walkScaffold && result.reason !== 'stopped' && result.reason !== 'interrupted') await takeDownBehind(ctx, placed);
  const left = bot.leversLeftOn?.splice(0) ?? [];
  if (left.length === 0) return result;
  const text = left.map(({ lever, door }) => `I left the lever at ${posText(lever)} on, so the iron door at ${posText(door)} stays open`).join('. ');
  return { ...result, message: `${result.message}. ${text}` };
}

async function walkOnce(ctx, goal, { place = true, dig = false, onFoot = false }) {
  const { bot, config, signal } = ctx;
  if (!onFoot) useMoveMode(bot, place);
  else if (bot.moveModes && bot.moveMode !== 'follow') {
    bot.pathfinder.setMovements(bot.moveModes.follow);
    bot.moveMode = 'follow';
  }
  const planned = bot.planModes && !('entity' in goal);
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
    await guarded(() => (planned ? plannedGoto(bot, goal, place, dig, onFoot) : bot.pathfinder.goto(goal)), {
      ms: target ? full * 8 : full,
      signal,
      stalled: target ? stalled : undefined,
      onCancel: () => bot.pathfinder.setGoal(null)
    });
    // goto also resolves when the best path is empty, so check the bot really got there.
    const p = bot.entity.position.floored();
    if (!goal.isEnd(p) && !goal.isEnd(p.offset(0, 1, 0))) {
      return walkFail('short', `could not get all the way there, ${botPos(bot)}`);
    }
    return ok(`arrived, ${botPos(bot)}`);
  } catch (err) {
    if (err instanceof AbortedError) return walkFail('stopped', 'stopped');
    if (err instanceof StalledError) return walkFail('stuck', `stuck, got no closer for ${Math.round((Date.now() - bestAt) / 1000)}s, ${botPos(bot)}`);
    if (err instanceof TimeoutError) return walkFail('timeout', `timed out walking, ${botPos(bot)}`);
    if (err.name === 'NoRoute') return walkFail('no_route', `${err.message}, ${botPos(bot)}`);
    if (err.name === 'NoPath' || err.name === 'Timeout') return walkFail('no_path', `no path, ${botPos(bot)}`);
    if (err.name === 'GoalChanged' || err.name === 'PathStopped') return walkFail('interrupted', `movement was interrupted, ${botPos(bot)}`);
    return walkFail('error', `could not walk there: ${err.message}`);
  } finally {
    // Left set, the pathfinder would keep walking (and digging) the last path after the walk gave up.
    if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
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
