import { Vec3 } from 'vec3';
import { ok } from './util.js';
import { isNaturalBlock } from './movement.js';
import { signText, otherChestHalf, assignSigns } from '../perception.js';

const H_RANGE = 24;
const V_RANGE = 20;
const MAX_CELLS = 8000;
const SIX = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0), new Vec3(0, -1, 0)];
const SIDES = SIX.slice(0, 4);
const STORAGE = (n) => n === 'chest' || n === 'trapped_chest' || n === 'barrel' || n.endsWith('shulker_box');
const UTILITY = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'brewing_stand', 'smithing_table', 'stonecutter', 'cartography_table', 'loom', 'lectern', 'composter', 'jukebox']);

function isTreeBlock(name) {
  return name.endsWith('_leaves') || name.endsWith('_log') || name.endsWith('_stem');
}

// Cells a player can move through, including doors, gates, trapdoors and ladders.
function isOpenCell(block) {
  if (!block) return false;
  if (block.boundingBox !== 'block') return !block.name.includes('lava') && block.name !== 'water';
  const n = block.name;
  return n.endsWith('_door') || n.endsWith('_fence_gate') || n.endsWith('_trapdoor') || n === 'ladder' || n === 'scaffolding';
}

const text = (p) => `${p.x} ${p.y} ${p.z}`;

// Groups positions into runs: ladders by column, stairs by touching blocks.
function ladderRuns(positions) {
  const byColumn = new Map();
  for (const p of positions) {
    const k = `${p.x},${p.z}`;
    if (!byColumn.has(k)) byColumn.set(k, []);
    byColumn.get(k).push(p.y);
  }
  const runs = [];
  for (const [k, ys] of byColumn) {
    const [x, z] = k.split(',').map(Number);
    ys.sort((a, b) => a - b);
    let from = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i === ys.length || ys[i] !== ys[i - 1] + 1) {
        runs.push({ x, z, from, to: ys[i - 1] });
        from = ys[i];
      }
    }
  }
  return runs;
}

function stairFlights(positions) {
  const left = new Map(positions.map((p) => [p.toString(), p]));
  const flights = [];
  while (left.size > 0) {
    const [firstKey, first] = left.entries().next().value;
    left.delete(firstKey);
    const flight = [first];
    for (let i = 0; i < flight.length; i++) {
      for (const [k, p] of left) {
        if (Math.abs(p.x - flight[i].x) <= 1 && Math.abs(p.y - flight[i].y) <= 1 && Math.abs(p.z - flight[i].z) <= 1) {
          flight.push(p);
          left.delete(k);
        }
      }
    }
    flight.sort((a, b) => a.y - b.y);
    if (flight.at(-1).y > flight[0].y) flights.push({ bottom: flight[0], top: flight.at(-1) });
  }
  return flights;
}

// Floor heights with enough standing room to count as a level, lowest first.
export function findLevels(floorCounts, minCells = 4) {
  const ys = [...floorCounts].filter(([, n]) => n >= minCells).map(([y]) => y).sort((a, b) => a - b);
  const levels = [];
  for (const y of ys) {
    if (levels.length && y - levels.at(-1) <= 1) continue;
    levels.push(y);
  }
  return levels;
}

function levelOf(levels, y) {
  let index = 0;
  for (let i = 0; i < levels.length; i++) if (levels[i] <= y) index = i;
  return index;
}

// Maps the building around the bot: flood-fills the rooms it can walk to without leaving the
// roof, then lists what is in them, floor by floor.
export async function survey({ bot }) {
  const start = bot.entity.position.floored();
  const getBlock = (p) => bot.blockAt(p, false);
  const columns = new Map();
  const roofOver = (p) => {
    const k = `${p.x},${p.z}`;
    let solid = columns.get(k);
    if (!solid) {
      solid = [];
      for (let y = start.y - V_RANGE; y <= start.y + V_RANGE + 12; y++) {
        const b = getBlock(new Vec3(p.x, y, p.z));
        if (b && b.boundingBox === 'block' && !isTreeBlock(b.name)) solid.push({ y, name: b.name });
      }
      columns.set(k, solid);
    }
    return solid.find((s) => s.y > p.y && s.y <= p.y + 12) ?? null;
  };

  if (!roofOver(start)) return ok(outdoors(bot, start));

  const inBounds = (p) => Math.abs(p.x - start.x) <= H_RANGE && Math.abs(p.z - start.z) <= H_RANGE && Math.abs(p.y - start.y) <= V_RANGE;
  const seen = new Set([start.toString()]);
  const queue = [start];
  const cells = [];
  const found = new Map();
  const outside = new Set();
  let built = 0;
  let natural = 0;
  while (queue.length > 0 && cells.length < MAX_CELLS) {
    const c = queue.shift();
    cells.push(c);
    const roof = roofOver(c);
    if (isNaturalBlock(roof.name)) natural++;
    else built++;
    for (const d of SIX) {
      const n = c.plus(d);
      const k = n.toString();
      if (seen.has(k) || !inBounds(n)) continue;
      seen.add(k);
      const b = getBlock(n);
      if (!b) continue;
      if (!isOpenCell(b)) {
        found.set(k, b);
        continue;
      }
      if (!roofOver(n)) {
        outside.add(k);
        continue;
      }
      queue.push(n);
    }
  }

  // Things inside the rooms: the open cells themselves (doors, ladders, signs...) and the solid
  // blocks around them (chests, stairs...).
  const floorCounts = new Map();
  const cellSet = new Set(cells.map((c) => c.toString()));
  for (const c of cells) {
    const b = getBlock(c);
    if (b && b.boundingBox !== 'block' && !AIR(b.name)) found.set(c.toString(), b);
    else if (b && isOpenCell(b) && b.boundingBox === 'block') found.set(c.toString(), b);
    // A standing spot: something solid below and room for a player's head above.
    const below = getBlock(c.offset(0, -1, 0));
    if (below && !isOpenCell(below) && cellSet.has(c.offset(0, 1, 0).toString())) floorCounts.set(c.y, (floorCounts.get(c.y) ?? 0) + 1);
  }
  const levels = findLevels(floorCounts);
  if (levels.length === 0) levels.push(start.y);

  const perLevel = levels.map(() => []);
  const add = (pos, line) => perLevel[levelOf(levels, pos.y)].push(line);
  const ladders = [];
  const stairs = [];
  const doneChests = new Set();
  const signs = [];
  const containers = [];
  for (const b of found.values()) {
    const n = b.name;
    const p = b.position;
    if (n.endsWith('_sign')) {
      const t = signText(bot.blockAt(p)?.blockEntity);
      if (t) signs.push({ pos: p, name: n, facing: b.getProperties().facing, text: t });
    } else if (STORAGE(n) && !doneChests.has(p.toString())) {
      const parts = [p];
      const other = n.endsWith('chest') ? otherChestHalf(p, b.getProperties()) : null;
      if (other && getBlock(other)?.name === n) parts.push(other);
      parts.forEach((q) => doneChests.add(q.toString()));
      containers.push({ name: n, parts, labels: [] });
    }
  }
  assignSigns(signs, containers);
  for (const c of containers) {
    const labelText = c.labels.length ? ` (${c.labels.join(', ')})` : '';
    add(c.parts[0], `${c.parts.length > 1 ? 'double ' : ''}${c.name} at ${c.parts.map(text).join(' + ')}${labelText}`);
  }
  for (const b of found.values()) {
    const n = b.name;
    const p = b.position;
    if (UTILITY.has(n) || (n.endsWith('_bed') && b.getProperties().part !== 'head')) {
      add(p, `${n} at ${text(p)}`);
    } else if (n.endsWith('_door') && b.getProperties().half !== 'upper') {
      const exit = SIDES.some((d) => outside.has(p.plus(d).toString()));
      add(p, `${n} at ${text(p)}${exit ? ' (leads outside)' : ''}`);
    } else if (n.endsWith('_trapdoor')) {
      add(p, `${n} at ${text(p)}`);
    } else if (n === 'ladder') {
      ladders.push(p);
    } else if (n.endsWith('_stairs')) {
      stairs.push(p);
    }
  }
  for (const r of ladderRuns(ladders)) {
    const up = levels.findIndex((y) => y > r.from && y <= r.to + 1);
    add(new Vec3(r.x, r.from, r.z), `ladder at ${r.x} ${r.z} from y ${r.from} to ${r.to}${up > 0 ? ` (up to level ${up + 1})` : ''}`);
  }
  for (const f of stairFlights(stairs)) {
    add(f.bottom, `stairs from ${text(f.bottom)} up to ${text(f.top)}`);
  }
  for (const s of signs) {
    if (!s.used) add(s.pos, `sign "${s.text}" at ${text(s.pos)}`);
  }

  const xs = cells.map((c) => c.x);
  const zs = cells.map((c) => c.z);
  const size = `${Math.max(...xs) - Math.min(...xs) + 1} x ${Math.max(...zs) - Math.min(...zs) + 1}`;
  const kind = built >= natural ? 'a building' : 'an underground or covered area';
  const cut = queue.length > 0 ? ' It goes on further than I checked.' : '';
  const lines = [`Inside ${kind}, about ${size} blocks, ${levels.length} level${levels.length > 1 ? 's' : ''}. You are on level ${levelOf(levels, start.y) + 1}.${cut}`];
  levels.forEach((y, i) => {
    const things = perLevel[i].slice(0, 25);
    const more = perLevel[i].length > 25 ? `; and ${perLevel[i].length - 25} more` : '';
    lines.push(`Level ${i + 1} (stand at y ${y}): ${things.length ? things.join('; ') + more : 'nothing notable'}`);
  });
  return ok(lines.join('\n'));
}

function AIR(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air';
}

function outdoors(bot, start) {
  const ids = bot.registry.blocksArray.filter((b) => b.name.endsWith('_door')).map((b) => b.id);
  const doors = bot
    .findBlocks({ matching: ids, maxDistance: H_RANGE, count: 40 })
    .filter((p) => bot.blockAt(p, false)?.getProperties().half !== 'upper')
    .sort((a, b) => a.distanceTo(start) - b.distanceTo(start))
    .slice(0, 4);
  const doorText = doors.length ? ` Nearest doors: ${doors.map((p) => `${text(p)} (${Math.round(p.distanceTo(start))} away)`).join('; ')}.` : '';
  return `You're outdoors here, not inside a building. Walk inside first (through a door), then survey again.${doorText}`;
}
