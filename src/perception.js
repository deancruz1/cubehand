import { Vec3 } from 'vec3';
import { reasonText } from './connection.js';
import { customName } from './actions/util.js';
import { isNaturalBlock } from './actions/movement.js';
import { droppedItem } from './actions/items.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const FACINGS = ['north', 'west', 'south', 'east'];
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

export function facingFromYaw(yaw) {
  const quarter = Math.round(yaw / (Math.PI / 2));
  return FACINGS[((quarter % 4) + 4) % 4];
}

export function timeLabel(timeOfDay) {
  if (timeOfDay < 12000) return 'day';
  if (timeOfDay < 13000) return 'sunset';
  if (timeOfDay < 23000) return 'night';
  return 'sunrise';
}

export function inventorySummary(items, heldItem) {
  const held = heldItem ? heldItem.name : 'nothing';
  if (items.length === 0) return `Inventory: empty\nHolding: ${held}`;

  const counts = new Map();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  const lines = [...counts].map(([name, count]) => `${name}: ${count}`);
  return `Inventory: ${lines.join(', ')}\nHolding: ${held}`;
}

// getName(x, y, z) returns a block name, or null when the position is not loaded.
export function countNearbyBlocks(getName, origin, radius) {
  const counts = new Map();
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
        const name = getName(origin.x + dx, origin.y + dy, origin.z + dz);
        if (!name || AIR.has(name)) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function blocksSummary(counts, underName, radius) {
  const under = `Standing on: ${underName ?? 'unknown'}`;
  if (counts.length === 0) return `${under}\nBlocks within ${radius}: none`;
  const list = counts.map(([name, count]) => `${name}: ${count}`).join(', ');
  return `${under}\nBlocks within ${radius}: ${list}`;
}

// entities: [{ name, kind, position, named }] where kind is 'player' or a mob type.
// Players and mobs with a name tag get a line each, other mobs of one kind share a line.
export function entitiesSummary(entities, origin, radius, max) {
  const near = entities
    .map((e) => ({ ...e, distance: e.position.distanceTo(origin) }))
    .filter((e) => e.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  const groups = new Map();
  for (const e of near) {
    const key = e.kind === 'player' || e.named ? `${groups.size}:${e.name}` : e.kind;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { ...e, count: 1 });
  }
  const lines = [...groups.values()].slice(0, max).map((e) => {
    const p = e.position.floored();
    const where = `at ${p.x} ${p.y} ${p.z}, ${e.distance.toFixed(1)} away`;
    if (e.count > 1) return `- ${e.count} ${e.kind}, nearest ${where}`;
    if (e.named) return `- ${e.name} (${e.kind} with a name tag) ${where}`;
    return `- ${e.name} (${e.kind}) ${where}`;
  });

  if (lines.length === 0) return `Nearby players and mobs (within ${radius}): none`;
  return `Nearby players and mobs (within ${radius}):\n${lines.join('\n')}`;
}

// items: [{ name, count, position }], grouped by name with the nearest spot.
export function droppedItemsSummary(items, origin, radius) {
  const groups = new Map();
  const near = items
    .map((i) => ({ ...i, distance: i.position.distanceTo(origin) }))
    .filter((i) => i.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
  for (const i of near) {
    const group = groups.get(i.name);
    if (group) group.count += i.count;
    else groups.set(i.name, { ...i });
  }
  if (groups.size === 0) return `Dropped items on the ground within ${radius}: none`;
  const lines = [...groups.values()].slice(0, 8).map((g) => {
    const p = g.position.floored();
    return `${g.count} ${g.name} (nearest at ${p.x} ${p.y} ${p.z}, ${Math.round(g.distance)} away)`;
  });
  return `Dropped items on the ground within ${radius}: ${lines.join('; ')}`;
}

export function statusSummary({ position, yaw, health, food, dimension, gameMode, timeOfDay }) {
  const p = position.floored();
  return [
    `Position: ${p.x} ${p.y} ${p.z}`,
    `Facing: ${facingFromYaw(yaw)}`,
    `Health: ${Math.round(health)}/20, Food: ${food}/20`,
    `Dimension: ${dimension}, Game mode: ${gameMode}`,
    `Time: ${timeLabel(timeOfDay)} (${timeOfDay})`
  ].join('\n');
}

export function chatSummary(messages) {
  if (messages.length === 0) return 'Recent chat: none';
  const lines = messages.map((m) => `<${m.username}> ${m.message}`);
  return `Recent chat:\n${lines.join('\n')}`;
}

const MOB_TYPES = new Set(['mob', 'hostile', 'animal', 'passive', 'ambient', 'water_creature']);

function liveEntities(bot) {
  const list = [];
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    if (e.type === 'player') {
      list.push({ name: e.username, kind: 'player', position: e.position });
      continue;
    }
    const tag = customName(e);
    // Armor stands only matter when someone named them, as a label.
    if (!MOB_TYPES.has(e.type) && !(tag && e.type === 'living')) continue;
    list.push({ name: tag ?? e.displayName ?? e.name, kind: e.name ?? e.type, position: e.position, named: Boolean(tag) });
  }
  return list;
}

function droppedItems(bot) {
  const list = [];
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'item' || !e.position) continue;
    const item = droppedItem(e);
    if (item) list.push({ name: item.name, count: item.count, position: e.position });
  }
  return list;
}

// The text on a sign, front then back, from its block entity data. Empty lines are dropped.
export function signText(blockEntity) {
  if (!blockEntity) return '';
  const lines = [];
  for (const side of [blockEntity.front_text, blockEntity.back_text]) {
    for (const message of side?.messages ?? []) {
      const value = message && typeof message === 'object' && '' in message ? message[''] : message;
      const text = reasonText(value).trim();
      if (text) lines.push(text);
    }
  }
  return lines.join(' / ');
}

// The other half of a double chest, or null for a single chest.
export function otherChestHalf(pos, { type, facing }) {
  if (type !== 'left' && type !== 'right') return null;
  const clockwise = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[facing];
  if (!clockwise) return null;
  const s = type === 'left' ? 1 : -1;
  return pos.offset(clockwise[0] * s, 0, clockwise[1] * s);
}

function isStorage(name) {
  return name === 'chest' || name === 'trapped_chest' || name === 'barrel' || name.endsWith('shulker_box');
}

// Gives each sign ({ pos, name, facing, text }) to the one container ({ parts, labels }) it
// labels: the one a wall sign hangs on or a standing sign stands on, or else the nearest one
// just below or beside it.
export function assignSigns(signs, containers) {
  for (const sign of signs) {
    const dir = DIRS[sign.facing];
    const holder = sign.name.includes('wall_sign') && dir ? sign.pos.offset(-dir[0], 0, -dir[1]) : sign.pos.offset(0, -1, 0);
    let best = null;
    let bestScore = Infinity;
    for (const c of containers) {
      for (const part of c.parts) {
        const dx = sign.pos.x - part.x;
        const dy = sign.pos.y - part.y;
        const dz = sign.pos.z - part.z;
        const score = part.equals(holder) ? 0 : Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= 0 && dy <= 2 ? Math.hypot(dx, dy, dz) : Infinity;
        if (score < bestScore) {
          best = c;
          bestScore = score;
        }
      }
    }
    if (best) {
      best.labels.push(`sign "${sign.text}"`);
      sign.used = true;
    }
  }
}

function frameItem(bot, entity) {
  const index = bot.registry.entitiesByName[entity.name]?.metadataKeys?.indexOf('item') ?? -1;
  const slot = index >= 0 ? entity.metadata?.[index] : null;
  const id = slot?.itemId ?? slot?.blockId;
  if (id == null || id < 0 || slot.itemCount === 0) return null;
  return bot.registry.items[id]?.name ?? null;
}

function findSigns(bot, range) {
  const ids = bot.registry.blocksArray.filter((b) => b.name.endsWith('_sign')).map((b) => b.id);
  const here = bot.entity.position;
  return bot
    .findBlocks({ matching: ids, maxDistance: range, count: 100 })
    .map((pos) => {
      const block = bot.blockAt(pos);
      return { pos, name: block?.name ?? '', facing: block?.getProperties().facing, text: signText(block?.blockEntity), distance: pos.distanceTo(here) };
    })
    .filter((s) => s.text);
}

// Chests, barrels and shulker boxes, one entry per double chest, labeled with the signs
// above or in front of them and the items shown in item frames on them.
function findStorage(bot, range, signs) {
  const ids = bot.registry.blocksArray.filter((b) => isStorage(b.name)).map((b) => b.id);
  const here = bot.entity.position;
  const seen = new Set();
  const containers = [];
  for (const pos of bot.findBlocks({ matching: ids, maxDistance: range, count: 300 })) {
    if (seen.has(pos.toString())) continue;
    const block = bot.blockAt(pos, false);
    if (!block) continue;
    seen.add(pos.toString());
    const parts = [pos];
    if (block.name === 'chest' || block.name === 'trapped_chest') {
      const other = otherChestHalf(pos, block.getProperties());
      if (other && bot.blockAt(other, false)?.name === block.name) {
        parts.push(other);
        seen.add(other.toString());
      }
    }
    const distance = Math.min(...parts.map((p) => p.offset(0.5, 0.5, 0.5).distanceTo(here)));
    containers.push({ name: block.name, parts, distance, labels: [] });
  }

  assignSigns(signs, containers);

  for (const e of Object.values(bot.entities)) {
    if ((e.name !== 'item_frame' && e.name !== 'glow_item_frame') || !e.position) continue;
    const item = frameItem(bot, e);
    if (!item) continue;
    const holder = containers.find((c) => c.parts.some((p) => p.offset(0.5, 0.5, 0.5).distanceTo(e.position) <= 1));
    if (holder) holder.labels.push(`item frame showing ${item}`);
  }

  return containers.sort((a, b) => a.distance - b.distance);
}

export function storageSummary(containers, range, max = 12) {
  if (containers.length === 0) return `Storage within ${range}: none`;
  const lines = containers.slice(0, max).map((c) => {
    const where = c.parts.map((p) => `${p.x} ${p.y} ${p.z}`).join(' + ');
    const kind = c.parts.length > 1 ? `double ${c.name}` : c.name;
    const label = c.labels.length ? `, ${c.labels.join(', ')}` : '';
    return `- ${kind} at ${where} (${Math.round(c.distance)} away)${label}`;
  });
  const more = containers.length > max ? `\n(${containers.length - max} more further away)` : '';
  return `Storage within ${range}:\n${lines.join('\n')}${more}`;
}

const LANDMARK_TYPES = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'brewing_stand', 'smithing_table', 'stonecutter'];
const LANDMARK_RANGE = 48;

// found is a list of { name, pos, distance }, closest first.
export function landmarksSummary(found, range) {
  if (found.length === 0) return `Other useful blocks within ${range}: none`;
  const lines = found.map((f) => `${f.name} at ${f.pos.x} ${f.pos.y} ${f.pos.z} (${Math.round(f.distance)} away)`);
  return `Other useful blocks within ${range}: ${lines.join('; ')}`;
}

function findLandmarks(bot) {
  const ids = LANDMARK_TYPES.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  ids.push(...bot.registry.blocksArray.filter((b) => b.name.endsWith('_bed')).map((b) => b.id));
  const here = bot.entity.position;
  const perType = new Map();
  const found = bot
    .findBlocks({ matching: ids, maxDistance: LANDMARK_RANGE, count: 200 })
    .map((pos) => ({ name: bot.blockAt(pos)?.name, pos, distance: pos.distanceTo(here) }))
    .filter((f) => f.name && !(f.name.endsWith('_bed') && bot.blockAt(f.pos).getProperties().part === 'head'))
    .sort((a, b) => a.distance - b.distance);
  // Two of each kind is enough to pick from.
  return found.filter((f) => {
    const seen = perType.get(f.name) ?? 0;
    perType.set(f.name, seen + 1);
    return seen < 2;
  });
}

export function signsSummary(signs, range) {
  const free = signs.filter((s) => !s.used).sort((a, b) => a.distance - b.distance).slice(0, 6);
  if (free.length === 0) return null;
  const lines = free.map((s) => `"${s.text}" at ${s.pos.x} ${s.pos.y} ${s.pos.z} (${Math.round(s.distance)} away)`);
  return `Other signs within ${range}: ${lines.join('; ')}`;
}

// Leaves and logs over your head are trees, not a roof.
function isTreeBlock(name) {
  return name.endsWith('_leaves') || name.endsWith('_log') || name.endsWith('_stem');
}

// Where the bot is: inside something built, underground, under trees, or in the open. Inside,
// it also counts the floors below to guess which floor the bot is on.
export function surroundingsSummary(getBlock, feet) {
  let roof = null;
  for (let dy = 2; dy <= 24; dy++) {
    const b = getBlock(feet.offset(0, dy, 0));
    if (!b) break;
    if (b.boundingBox === 'block') {
      roof = b;
      break;
    }
  }
  if (!roof) return 'Surroundings: outdoors, open sky above';
  if (isTreeBlock(roof.name)) return 'Surroundings: outdoors, under trees';
  if (isNaturalBlock(roof.name)) return `Surroundings: underground or under rock (${roof.name} above)`;

  let floors = 0;
  let gap = 0;
  for (let dy = -1; dy >= -48; dy--) {
    const b = getBlock(feet.offset(0, dy, 0));
    if (!b) break;
    if (b.boundingBox === 'block') {
      if (floors === 0 || gap >= 2) floors++;
      if (isNaturalBlock(b.name)) break;
      gap = 0;
    } else {
      gap++;
    }
  }
  const floor = floors > 1 ? `, on floor ${floors} counting from the ground` : '';
  return `Surroundings: indoors, under a built roof (${roof.name})${floor}. Use survey to see the rooms, levels and what's in them.`;
}

export function buildSnapshot(bot, config, chatMessages, memories) {
  const origin = bot.entity.position.floored();
  const radius = config.perception.blockRadius;
  const entityRadius = config.perception.entityRadius;
  const pos = new Vec3(0, 0, 0);
  const getName = (x, y, z) => {
    pos.set(x, y, z);
    const id = bot.world.getBlockStateId(pos);
    return id == null ? null : (bot.registry.blocksByStateId[id]?.name ?? null);
  };
  const under = bot.blockAt(origin.offset(0, -1, 0), false)?.name;
  const signs = findSigns(bot, LANDMARK_RANGE);
  const storage = findStorage(bot, LANDMARK_RANGE, signs);

  return [
    statusSummary({
      position: bot.entity.position,
      yaw: bot.entity.yaw,
      health: bot.health,
      food: bot.food,
      dimension: bot.game.dimension,
      gameMode: bot.game.gameMode,
      timeOfDay: bot.time.timeOfDay
    }),
    inventorySummary(bot.inventory.items(), bot.heldItem),
    surroundingsSummary((p) => bot.blockAt(p, false), origin),
    blocksSummary(countNearbyBlocks(getName, origin, radius), under, radius),
    storageSummary(storage, LANDMARK_RANGE),
    landmarksSummary(findLandmarks(bot), LANDMARK_RANGE),
    signsSummary(signs, LANDMARK_RANGE),
    entitiesSummary(liveEntities(bot), bot.entity.position, entityRadius, config.perception.maxEntities),
    droppedItemsSummary(droppedItems(bot), bot.entity.position, Math.min(entityRadius, 32)),
    memories ?? 'Memories: none',
    chatSummary(chatMessages)
  ]
    .filter(Boolean)
    .join('\n\n');
}
