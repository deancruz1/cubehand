import { Vec3 } from 'vec3';
import { ok, fail, posText } from './util.js';
import { isNaturalBlock, watchScaffold } from './movement.js';
import { digBlock, removeScaffold, isReplaceable, isProtected } from './blocks.js';
import { placeAll, inventoryCounts } from './build.js';
import { collectDrops } from './items.js';

const SIDES = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const BUILDING_BLOCKS = new Set([
  'cobblestone', 'stone', 'stone_bricks', 'bricks', 'cobbled_deepslate', 'deepslate_bricks', 'polished_deepslate',
  'sandstone', 'red_sandstone', 'smooth_stone', 'mud_bricks', 'tuff_bricks', 'polished_tuff', 'polished_andesite',
  'polished_diorite', 'polished_granite', 'blackstone', 'polished_blackstone_bricks', 'end_stone_bricks', 'prismarine_bricks'
]);
const PLANTS = new Set([
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower',
  'lilac', 'rose_bush', 'peony', 'sweet_berry_bush', 'sugar_cane', 'pumpkin', 'melon', 'bamboo', 'torchflower', 'pitcher_plant',
  'pink_petals', 'wildflowers', 'bush', 'firefly_bush', 'cactus_flower', 'moss_carpet', 'mangrove_propagule', 'glow_lichen', 'vine',
  'leaf_litter', 'short_dry_grass', 'tall_dry_grass', 'spore_blossom', 'hanging_roots', 'big_dripleaf', 'small_dripleaf', 'azalea',
  'flowering_azalea', 'cactus'
]);

function isBuildingBlock(name) {
  return BUILDING_BLOCKS.has(name) || name.endsWith('_planks') || name.endsWith('_log');
}

// Natural stuff that may be dug out of the way: terrain and plants. Logs are not, they could be
// someone's log cabin; trees have to be chopped first.
export function isClearable(name) {
  return isNaturalBlock(name) || PLANTS.has(name) || name.endsWith('_sapling') || name.endsWith('_tulip') || name.endsWith('_mushroom');
}

const keyOf = (x, y, z) => `${x},${y},${z}`;
export const HOUSE_MEMORY = 'house build';

// The layout of a simple survival house, as a list of blocks. x y z is the middle of the floor
// at foot level: the floor goes in at y - 1, in place of the ground, and the walls start at y.
// Each floor is height blocks tall inside. Floors are joined by a ladder in a back corner.
// The roof is flat, or a stepped gable along the longer side. A basement is one more storey
// dug out below the ground floor, and an attic is a floor laid over the top storey, under a
// gable roof. Missing materials (floor, windows, door, torch) are left out: no floor keeps the
// ground, no door leaves a doorway.
export function planHouse({ x, y, z, width = 7, depth = 7, floors = 1, height = 3, door = 'south', roof = 'gable', basement = false, attic = false, materials }) {
  const m = materials;
  const x0 = x - Math.floor(width / 2);
  const z0 = z - Math.floor(depth / 2);
  const x1 = x0 + width - 1;
  const z1 = z0 + depth - 1;
  const base = y - 1;
  const storey = height + 1;
  const top = base + floors * storey;
  const bottom = basement ? base - storey : base;
  const blocks = new Map();
  const put = (bx, by, bz, block, attach) => {
    if (block) blocks.set(keyOf(bx, by, bz), { x: bx, y: by, z: bz, block, attach });
  };
  const onEdge = (bx, bz) => bx === x0 || bx === x1 || bz === z0 || bz === z1;
  const isCorner = (bx, bz) => (bx === x0 || bx === x1) && (bz === z0 || bz === z1);
  const windowSpot = (bx, bz) => {
    const along = bz === z0 || bz === z1;
    const i = along ? bx - x0 : bz - z0;
    const length = along ? width : depth;
    return i % 2 === 0 && i >= 2 && i <= length - 3;
  };

  const [ddx, ddz] = SIDES[door];
  const doorX = ddx === 0 ? x0 + Math.floor(width / 2) : ddx > 0 ? x1 : x0;
  const doorZ = ddz === 0 ? z0 + Math.floor(depth / 2) : ddz > 0 ? z1 : z0;

  // The ladder goes in a corner against the back wall, the one across from the door.
  let ladderX;
  let ladderZ;
  let attach;
  if (ddx === 0) {
    ladderX = x0 + 1;
    ladderZ = ddz > 0 ? z0 + 1 : z1 - 1;
    attach = new Vec3(0, 0, -ddz);
  } else {
    ladderX = ddx > 0 ? x0 + 1 : x1 - 1;
    ladderZ = z0 + 1;
    attach = new Vec3(-ddx, 0, 0);
  }
  const torchSpots = [[x0 + 1, z0 + 1], [x1 - 1, z1 - 1], [x0 + 1, z1 - 1], [x1 - 1, z0 + 1]]
    .filter(([tx, tz]) => !(tx === ladderX && tz === ladderZ))
    .slice(0, 2);

  // The attic ladder goes halfway along a gable end, away from the door, where the roof is
  // high enough to climb out.
  const alongX = width >= depth;
  let atticLadder = null;
  if (attic && alongX) {
    const end = door === 'west' ? 1 : -1;
    atticLadder = { x: end < 0 ? x0 + 1 : x1 - 1, z: z0 + Math.floor(depth / 2), attach: new Vec3(end, 0, 0) };
  } else if (attic) {
    const end = door === 'north' ? 1 : -1;
    atticLadder = { x: x0 + Math.floor(width / 2), z: end < 0 ? z0 + 1 : z1 - 1, attach: new Vec3(0, 0, end) };
  }
  const behindAtticLadder = (f, bx, bz) =>
    atticLadder && f === floors - 1 && bx === atticLadder.x + atticLadder.attach.x && bz === atticLadder.z + atticLadder.attach.z;

  for (let f = 0; f < floors; f++) {
    const fy = base + f * storey;
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (f === 0) put(bx, fy, bz, m.floor);
        else if (onEdge(bx, bz)) put(bx, fy, bz, m.walls);
        else if (!(bx === ladderX && bz === ladderZ)) put(bx, fy, bz, m.floor ?? m.walls);
      }
    }
    for (let wy = fy + 1; wy <= fy + height; wy++) {
      for (let bx = x0; bx <= x1; bx++) {
        for (let bz = z0; bz <= z1; bz++) {
          if (!onEdge(bx, bz)) continue;
          if (f === 0 && bx === doorX && bz === doorZ && wy <= fy + 2) {
            if (wy === fy + 1) put(bx, wy, bz, m.door);
            continue;
          }
          if (m.windows && wy === fy + 2 && !isCorner(bx, bz) && windowSpot(bx, bz) && !behindAtticLadder(f, bx, bz)) put(bx, wy, bz, m.windows);
          else put(bx, wy, bz, isCorner(bx, bz) && m.corners ? m.corners : m.walls);
        }
      }
    }
    for (const [tx, tz] of torchSpots) put(tx, fy + 1, tz, m.torch);
    if (f < floors - 1) {
      for (let ly = fy + 1; ly <= fy + storey; ly++) put(ladderX, ly, ladderZ, 'ladder', attach);
    }
  }

  if (basement) {
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        put(bx, bottom, bz, m.floor ?? m.walls);
        if (onEdge(bx, bz)) for (let wy = bottom + 1; wy < base; wy++) put(bx, wy, bz, m.walls);
      }
    }
    for (const [tx, tz] of torchSpots) put(tx, bottom + 1, tz, m.torch);
    for (let ly = bottom + 1; ly <= base; ly++) put(ladderX, ly, ladderZ, 'ladder', attach);
  }

  if (atticLadder) {
    for (let bx = x0 + 1; bx < x1; bx++) {
      for (let bz = z0 + 1; bz < z1; bz++) {
        if (bx !== atticLadder.x || bz !== atticLadder.z) put(bx, top, bz, m.floor ?? m.walls);
      }
    }
    for (let ly = top - storey + 1; ly <= top; ly++) put(atticLadder.x, ly, atticLadder.z, 'ladder', atticLadder.attach);
    // A torch at the far end, so nothing spawns up there.
    if (alongX) put(x0 + x1 - atticLadder.x, top + 1, atticLadder.z, m.torch);
    else put(atticLadder.x, top + 1, z0 + z1 - atticLadder.z, m.torch);
  }

  let roofTop = top;
  const roofMaterial = m.roof ?? m.walls;
  if (roof === 'flat') {
    for (let bx = x0; bx <= x1; bx++) for (let bz = z0; bz <= z1; bz++) put(bx, top, bz, roofMaterial);
  } else if (width >= depth) {
    for (let k = 0; z0 + k <= z1 - k; k++) {
      const ry = top + k;
      roofTop = ry;
      for (let bx = x0; bx <= x1; bx++) {
        put(bx, ry, z0 + k, roofMaterial);
        put(bx, ry, z1 - k, roofMaterial);
      }
      for (let bz = z0 + k + 1; bz <= z1 - k - 1; bz++) {
        put(x0, ry, bz, m.walls);
        put(x1, ry, bz, m.walls);
      }
    }
  } else {
    for (let k = 0; x0 + k <= x1 - k; k++) {
      const ry = top + k;
      roofTop = ry;
      for (let bz = z0; bz <= z1; bz++) {
        put(x0 + k, ry, bz, roofMaterial);
        put(x1 - k, ry, bz, roofMaterial);
      }
      for (let bx = x0 + k + 1; bx <= x1 - k - 1; bx++) {
        put(bx, ry, z0, m.walls);
        put(bx, ry, z1, m.walls);
      }
    }
  }

  // Accents: a foundation course along the bottom of the walls (and the basement walls), and
  // trim at each floor line and along the top of the walls.
  const trimLine = (by) => by === top || (by > base && by < top && (by - base) % storey === 0);
  for (const b of blocks.values()) {
    if (!onEdge(b.x, b.z) || b.block === m.door) continue;
    if (m.foundation && b.y <= base + 1) b.block = m.foundation;
    else if (m.trim && trimLine(b.y)) b.block = m.trim;
  }

  const counts = new Map();
  for (const b of blocks.values()) counts.set(b.block, (counts.get(b.block) ?? 0) + 1);
  return {
    blocks: [...blocks.values()],
    counts,
    min: new Vec3(x0, bottom, z0),
    max: new Vec3(x1, roofTop, z1),
    door: new Vec3(doorX, base + 1, doorZ),
    outside: new Vec3(doorX + ddx, base + 1, doorZ + ddz)
  };
}

// Materials to use: what the player asked for, otherwise what the bot carries most of.
// "none" leaves a part out.
export function pickMaterials(inventory, given = {}) {
  const pick = (value, fallback) => (value === 'none' ? null : value ?? fallback);
  const blocks = [...inventory].filter(([n]) => isBuildingBlock(n)).sort((a, b) => b[1] - a[1]);
  const walls = pick(given.walls, blocks[0]?.[0] ?? null);
  const planks = blocks.find(([n]) => n.endsWith('_planks'))?.[0];
  const door = [...inventory.keys()].find((n) => n.endsWith('_door') && n !== 'iron_door');
  return {
    walls,
    floor: pick(given.floor, planks ?? walls),
    roof: pick(given.roof, walls),
    corners: pick(given.corners, null),
    foundation: pick(given.foundation, null),
    trim: pick(given.trim, null),
    windows: pick(given.windows, inventory.has('glass_pane') ? 'glass_pane' : inventory.has('glass') ? 'glass' : null),
    door: pick(given.door, door ?? null),
    torch: inventory.has('torch') ? 'torch' : null
  };
}

// The order to place a layer in: walls and floor edges first, going around the house, then
// the middle, then things that hang on the walls or stand on the floor.
function placeOrder(plan) {
  const cx = (plan.min.x + plan.max.x) / 2;
  const cz = (plan.min.z + plan.max.z) / 2;
  const rank = (b) => {
    if (b.block === 'ladder' || b.block === 'torch' || b.block.endsWith('_door')) return 2;
    const edge = b.x === plan.min.x || b.x === plan.max.x || b.z === plan.min.z || b.z === plan.max.z;
    return edge ? 0 : 1;
  };
  return (a, b) => a.y - b.y || rank(a) - rank(b) || Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx);
}

export async function buildHouse(ctx, input) {
  const { bot, signal } = ctx;
  const clamp = (v, lo, hi, d) => Math.min(Math.max(Math.round(v ?? d), lo), hi);
  const width = clamp(input.width, 5, 15, 7);
  const depth = clamp(input.depth, 5, 15, 7);
  const floors = clamp(input.floors, 1, 3, 1);
  const height = clamp(input.height, 3, 5, 3);
  const door = SIDES[input.door] ? input.door : 'south';
  const basement = Boolean(input.basement);
  const attic = Boolean(input.attic);
  const roof = input.roof === 'flat' && !attic ? 'flat' : 'gable';
  if (attic && Math.min(width, depth) < 7) return fail('an attic needs a house at least 7 wide and 7 deep');

  const inventory = inventoryCounts(bot.inventory.items());
  const materials = pickMaterials(inventory, input.materials ?? {});
  if (!materials.walls) return fail('I have no building blocks to build with (planks, cobblestone, bricks and so on)');
  const unknown = Object.values(materials).filter((n) => n && !bot.registry.blocksByName[n]);
  if (unknown.length) return fail(`unknown block: ${unknown.join(', ')}`);

  const plan = planHouse({ x: input.x, y: input.y, z: input.z, width, depth, floors, height, door, roof, basement, attic, materials });
  const planned = new Map(plan.blocks.map((b) => [keyOf(b.x, b.y, b.z), b]));

  // Blocks the bot placed itself may come down when they don't fit the plan, so its own house
  // can be changed in place, but never its chests, beds or other protected blocks. The top half
  // of its own door counts too.
  const ownBlock = (pos, name) => {
    if (isProtected(name, ctx.config.protectedBlocks)) return false;
    if (ctx.placed?.has(pos, name)) return true;
    // A torch put against a wall turns into a wall_torch.
    if (name === 'wall_torch' && ctx.placed?.has(pos, 'torch')) return true;
    return name.endsWith('_door') && Boolean(ctx.placed?.has(pos.offset(0, -1, 0), name));
  };

  // Look over the site: what is already done, what natural stuff has to go, and what's in the way.
  const todo = [];
  const toDig = [];
  const blocked = [];
  const recovered = new Map();
  let own = 0;
  const check = (pos) => {
    const block = bot.blockAt(pos, false);
    if (!block) return 'not loaded';
    const want = planned.get(keyOf(pos.x, pos.y, pos.z));
    if (want && block.name === want.block) return null;
    if (want) todo.push(want);
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'water' || block.name === 'lava') return null;
    if (want && isReplaceable(block.name)) return null;
    if (isClearable(block.name) || isReplaceable(block.name)) toDig.push(pos);
    else if (ownBlock(pos, block.name)) {
      toDig.push(pos);
      own++;
      // What comes down goes back into the house. Glass breaks into nothing.
      if (!block.name.includes('glass') && !block.name.endsWith('_door')) recovered.set(block.name, (recovered.get(block.name) ?? 0) + 1);
    } else blocked.push(`${block.name} at ${posText(pos)}`);
    return null;
  };
  for (let px = plan.min.x; px <= plan.max.x; px++) {
    for (let py = plan.min.y; py <= plan.max.y; py++) {
      for (let pz = plan.min.z; pz <= plan.max.z; pz++) {
        if (check(new Vec3(px, py, pz)) === 'not loaded') return fail('part of that area is not loaded');
      }
    }
  }
  check(plan.outside);
  check(plan.outside.offset(0, 1, 0));

  const where = `centered on ${input.x} ${input.y} ${input.z}`;
  if (blocked.length) {
    const more = blocked.length > 5 ? ` and ${blocked.length - 5} more` : '';
    const trees = blocked.some((b) => /_log |_stem /.test(b)) ? ' Trees can be chopped first with chop_tree.' : '';
    return fail(`can't build a ${width}x${depth} house ${where}, these are in the way: ${blocked.slice(0, 5).join('; ')}${more}. Pick a clearer spot.${trees}`);
  }

  const needed = new Map();
  for (const b of todo) needed.set(b.block, (needed.get(b.block) ?? 0) + 1);
  const have = (n) => (inventory.get(n) ?? 0) + (recovered.get(n) ?? 0);
  const missing = [...needed]
    .filter(([n, c]) => have(n) < c)
    .map(([n, c]) => `${n} (need ${c}, have ${inventory.get(n) ?? 0}${recovered.get(n) ? ` plus ${recovered.get(n)} from taking down my own blocks` : ''})`);
  const parts = [
    `walls ${materials.walls}`,
    `floor ${materials.floor ?? 'none, keeps the ground'}`,
    `roof ${materials.roof ?? materials.walls}`,
    `windows ${materials.windows ?? 'none'}`,
    `door ${materials.door ?? 'none, leaves a doorway'}`
  ];
  for (const key of ['corners', 'foundation', 'trim']) if (materials[key]) parts.push(`${key} ${materials[key]}`);
  const extras = [basement && 'a basement', attic && 'an attic'].filter(Boolean);
  const needText = [...needed].map(([n, c]) => `${c} ${n}`).join(', ');
  const clearing = [toDig.length > own && `${toDig.length - own} natural blocks`, own && `${own} of my own blocks that don't fit the plan`].filter(Boolean);
  const summary = `${width}x${depth} house ${where}, ${floors} floor${floors > 1 ? 's' : ''}${extras.length ? ` plus ${extras.join(' and ')}` : ''}, ${roof} roof, door on the ${door} side at ${posText(plan.door)}. ${parts.join(', ')}. Needs ${needText || 'nothing more'}${clearing.length ? `, and ${clearing.join(' and ')} cleared first` : ''}.`;
  if (input.dry_run) return ok(`Plan: ${summary}${missing.length ? ` Missing: ${missing.join(', ')}.` : ' I have everything.'}`);
  if (missing.length) return fail(`missing items: ${missing.join(', ')}. Nothing was built. Plan: ${summary}`);

  // The exact settings of a real build go into memory, so carrying on later never depends on
  // the bot remembering to save them.
  const used = Object.fromEntries(Object.entries(materials).filter(([k]) => k !== 'torch').map(([k, v]) => [k, v ?? 'none']));
  const settings = { x: input.x, y: input.y, z: input.z, width, depth, floors, height, door, roof, basement, attic, materials: used };
  const clock = () => new Date().toLocaleTimeString();
  const record = (outcome) =>
    ctx.memory?.remember({
      name: HOUSE_MEMORY,
      note: `Exact settings of my last real build_house run (${outcome}). To carry on with this house, call build_house with exactly these: ${JSON.stringify(settings)}`,
      x: input.x,
      y: input.y,
      z: input.z
    });
  record(`started ${clock()}`);

  // While building, the bot may stand on scaffolding near its own walls, but never use the
  // building materials for it.
  bot.buildZone = { min: plan.min.offset(-2, -1, -2), max: plan.max.offset(2, 2, 2) };
  bot.buildKeep = new Set(Object.values(materials).filter(Boolean).map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined));
  const scaffold = watchScaffold(bot, (p) => !planned.has(keyOf(p.x, p.y, p.z)) && p.x >= plan.min.x - 2 && p.x <= plan.max.x + 2 && p.z >= plan.min.z - 2 && p.z <= plan.max.z + 2);
  let result = { placed: 0, failures: [], stoppedReason: null };
  let digProblem = null;
  try {
    // Clear the site from the top down so nothing falls on the bot.
    let digFailures = 0;
    for (const [i, pos] of toDig.sort((a, b) => b.y - a.y).entries()) {
      if (signal?.aborted) break;
      const block = bot.blockAt(pos, false);
      if (!block || block.name === 'air' || block.name === 'cave_air') continue;
      ctx.status?.progress(`clearing the site: ${i + 1} of ${toDig.length} blocks`);
      const dug = await digBlock(ctx, pos);
      if (!dug.ok && ++digFailures >= 8) {
        digProblem = `couldn't clear the site: ${dug.message}`;
        break;
      }
    }
    if (own && !digProblem && !signal?.aborted) {
      await collectDrops(ctx, { radius: Math.max(width, depth) + 4, center: new Vec3(input.x + 0.5, input.y, input.z + 0.5), max: 48 });
    }
    if (!digProblem && !signal?.aborted) result = await placeAll(ctx, todo.sort(placeOrder(plan)));
  } finally {
    scaffold.stop();
    bot.buildZone = null;
    bot.buildKeep = null;
  }
  const removed = await removeScaffold(ctx, scaffold.placed);

  const { placed, failures, stoppedReason } = result;
  let message = `${summary} Placed ${placed} of ${todo.length} blocks`;
  if (removed) message += `, took down ${removed} scaffolding blocks`;
  if (failures.length) message += `. ${failures.length} failed, first: ${failures.slice(0, 4).join('; ')}`;
  const stopped = digProblem ?? stoppedReason ?? (signal?.aborted ? 'stopped' : null);
  if (stopped) message += `. Stopped early: ${stopped}`;
  record(stopped || failures.length ? `stopped at ${clock()} with ${placed} of ${todo.length} blocks placed${stopped ? `, ${stopped}` : ''}` : `finished at ${clock()}`);
  return stopped || failures.length ? fail(message) : ok(message);
}
