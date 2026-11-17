import { Vec3 } from 'vec3';
import { ok, fail, posText } from './util.js';
import { isNaturalBlock } from './movement.js';
import { digBlock, takeDownScaffold, isReplaceable, isProtected } from './blocks.js';
import { placeAll, inventoryCounts, expandParts, watchBuildScaffold, groundUnder, buildZone, groupBlocks, leftText, missingHelp } from './build.js';
import { collectDrops } from './items.js';
import { parseBlock, dirVector, opposite, matchesState } from './states.js';

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
  const put = (bx, by, bz, block, attach, props) => {
    if (block) blocks.set(keyOf(bx, by, bz), { x: bx, y: by, z: bz, block, attach, props });
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

  // The chimney stands against the middle of a gable end, the one away from the door (the same
  // end as the attic ladder), with no window behind it.
  let chimneySpot = null;
  if (m.chimney && alongX) chimneySpot = { x: door === 'west' ? x1 + 1 : x0 - 1, z: z0 + Math.floor(depth / 2) };
  else if (m.chimney) chimneySpot = { x: x0 + Math.floor(width / 2), z: door === 'north' ? z1 + 1 : z0 - 1 };
  const behindChimney = (bx, bz) => chimneySpot && Math.abs(bx - chimneySpot.x) + Math.abs(bz - chimneySpot.z) === 1;

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
          if (m.windows && wy === fy + 2 && !isCorner(bx, bz) && windowSpot(bx, bz) && !behindAtticLadder(f, bx, bz) && !behindChimney(bx, bz)) put(bx, wy, bz, m.windows);
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
  if (roof !== 'flat' && roofMaterial.endsWith('_stairs')) {
    // Stairs stepping up to the ridge, hanging one block over the walls all round, with the
    // gable ends and the wall tops under the eaves closed off.
    const parts = [{ shape: 'roof', from: { dx: x0, dy: top, dz: z0 }, to: { dx: x1, dy: top, dz: z1 }, block: roofMaterial, fill: m.walls }];
    for (const b of expandParts(parts, [], { slabFor: () => m.ridge ?? null })) {
      const { name, props } = parseBlock(b.block);
      put(b.dx, b.dy, b.dz, name, undefined, Object.keys(props).length ? props : undefined);
      roofTop = Math.max(roofTop, b.dy);
    }
  } else if (roof === 'flat') {
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
  // trim at each floor line and along the top of the walls. Corner posts run straight through
  // the trim, and trim logs lie along their wall.
  const inWalls = (bx, bz) => bx >= x0 && bx <= x1 && bz >= z0 && bz <= z1;
  const trimLine = (by) => by === top || (by > base && by < top && (by - base) % storey === 0);
  for (const b of blocks.values()) {
    if (!onEdge(b.x, b.z) || !inWalls(b.x, b.z) || b.props || b.block === m.door) continue;
    if (m.foundation && b.y <= base + 1) b.block = m.foundation;
    else if (m.corners && isCorner(b.x, b.z) && trimLine(b.y)) b.block = m.corners;
    else if (m.trim && trimLine(b.y)) {
      b.block = m.trim;
      if (hasAxis(m.trim) && !isCorner(b.x, b.z)) b.props = { axis: b.z === z0 || b.z === z1 ? 'x' : 'z' };
    }
  }

  // Details on the outside of the walls: sills under the windows, open shutters beside them,
  // a porch roof over the door, and a chimney up one gable end.
  const outward = (bx, bz) => (bz === z0 ? 'north' : bz === z1 ? 'south' : bx === x0 ? 'west' : 'east');
  const isDoorway = (bx, by, bz) => bx === doorX && bz === doorZ && by <= base + 2;
  const windows = m.windows ? [...blocks.values()].filter((b) => b.block === m.windows && inWalls(b.x, b.z) && onEdge(b.x, b.z)) : [];
  for (const w of windows) {
    const out = outward(w.x, w.z);
    const n = dirVector(out);
    if (m.sills) {
      let props;
      if (m.sills.endsWith('_trapdoor')) props = { facing: out, half: 'top' };
      else if (m.sills.endsWith('_stairs')) props = { facing: opposite(out), half: 'top' };
      else if (m.sills.endsWith('_slab')) props = { type: 'top' };
      put(w.x + n.x, w.y - 1, w.z + n.z, m.sills, undefined, props);
    }
    if (m.shutters) {
      const [tx, tz] = n.x === 0 ? [1, 0] : [0, 1];
      for (const s of [-1, 1]) {
        const bx = w.x + tx * s;
        const bz = w.z + tz * s;
        if (isDoorway(bx, w.y, bz) || blocks.get(keyOf(bx, w.y, bz))?.block === m.windows) continue;
        put(bx + n.x, w.y, bz + n.z, m.shutters, undefined, { facing: out, half: 'bottom', open: 'true' });
      }
    }
  }
  if (m.porch) {
    const [tx, tz] = ddx === 0 ? [1, 0] : [0, 1];
    const props = m.porch.endsWith('_slab') ? { type: 'top' } : undefined;
    for (const s of [-1, 0, 1]) {
      for (const o of [1, 2]) put(doorX + tx * s + ddx * o, base + 3, doorZ + tz * s + ddz * o, m.porch, undefined, props);
    }
    if (m.posts) {
      for (const s of [-1, 1]) {
        for (const py of [base + 1, base + 2]) put(doorX + tx * s + ddx * 2, py, doorZ + tz * s + ddz * 2, m.posts);
      }
    }
  }
  if (m.chimney) {
    const c = chimneySpot;
    for (let cy = base + 1; cy <= roofTop + 2; cy++) put(c.x, cy, c.z, m.chimney);
  }

  const all = [...blocks.values()];
  const counts = new Map();
  for (const b of all) counts.set(b.block, (counts.get(b.block) ?? 0) + 1);
  const xs = all.map((b) => b.x);
  const zs = all.map((b) => b.z);
  return {
    blocks: all,
    counts,
    min: new Vec3(Math.min(x0, ...xs), bottom, Math.min(z0, ...zs)),
    max: new Vec3(Math.max(x1, ...xs), Math.max(roofTop, ...all.map((b) => b.y)), Math.max(z1, ...zs)),
    walls: { min: new Vec3(x0, bottom, z0), max: new Vec3(x1, roofTop, z1) },
    door: new Vec3(doorX, base + 1, doorZ),
    outside: new Vec3(doorX + ddx, base + 1, doorZ + ddz)
  };
}

// Logs, pillars and the like can lie on their side.
export function hasAxis(name) {
  return /_(log|wood|stem|hyphae)$|pillar|basalt|^bone_block$|^hay_block$|^deepslate$|^muddy_mangrove_roots$/.test(name);
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
    sills: pick(given.sills, null),
    shutters: pick(given.shutters, null),
    porch: pick(given.porch, null),
    posts: pick(given.posts, null),
    chimney: pick(given.chimney, null),
    torch: pick(given.lights, inventory.has('torch') ? 'torch' : null)
  };
}

// The order to place a layer in: walls and floor edges first, going around the house, then
// the middle, then things that hang on the walls or stand on the floor.
function placeOrder(plan) {
  const { min, max } = plan.walls;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const rank = (b) => {
    if (/^(ladder|torch|lantern|soul_lantern)$|_door$|_trapdoor$/.test(b.block)) return 3;
    if (b.x < min.x || b.x > max.x || b.z < min.z || b.z > max.z) return 2;
    const edge = b.x === min.x || b.x === max.x || b.z === min.z || b.z === max.z;
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
  if (materials.roof?.endsWith('_stairs')) {
    if (roof === 'flat') return fail('a roof of stairs needs a gable roof, or give a full block for a flat roof');
    const slab = materials.roof.replace(/_stairs$/, '_slab');
    materials.ridge = bot.registry.blocksByName[slab] ? slab : null;
  }
  if (materials.shutters && !materials.shutters.endsWith('_trapdoor')) return fail('shutters have to be a trapdoor, like spruce_trapdoor');
  if (materials.shutters?.startsWith('iron_')) return fail("iron trapdoors can't be opened by hand, pick a wooden trapdoor for shutters");

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
    if (want && matchesState(block, want.block, want.props)) return null;
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
  // Everything inside the walls gets cleared. Outside them (eaves, porch, chimney) only the
  // planned blocks do, so the ground around the house stays as it is.
  const { min, max } = plan.walls;
  const inside = (p) => p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z && p.y >= min.y && p.y <= max.y;
  for (let px = min.x; px <= max.x; px++) {
    for (let py = min.y; py <= max.y; py++) {
      for (let pz = min.z; pz <= max.z; pz++) {
        if (check(new Vec3(px, py, pz)) === 'not loaded') return fail('part of that area is not loaded');
      }
    }
  }
  for (const b of plan.blocks) {
    const pos = new Vec3(b.x, b.y, b.z);
    if (!inside(pos) && check(pos) === 'not loaded') return fail('part of that area is not loaded');
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
  const short = [...needed].filter(([n, c]) => have(n) < c);
  const missing = short.map(([n, c]) => `${n} (need ${c}, have ${inventory.get(n) ?? 0}${recovered.get(n) ? ` plus ${recovered.get(n)} from taking down my own blocks` : ''}, ${c - have(n)} more)`);
  const parts = [
    `walls ${materials.walls}`,
    `floor ${materials.floor ?? 'none, keeps the ground'}`,
    `roof ${materials.roof ?? materials.walls}`,
    `windows ${materials.windows ?? 'none'}`,
    `door ${materials.door ?? 'none, leaves a doorway'}`
  ];
  for (const key of ['corners', 'foundation', 'trim', 'sills', 'shutters', 'porch', 'posts', 'chimney']) if (materials[key]) parts.push(`${key} ${materials[key]}`);
  if (materials.ridge) parts.push(`ridge ${materials.ridge}`);
  const extras = [basement && 'a basement', attic && 'an attic'].filter(Boolean);
  const needText = [...needed].map(([n, c]) => `${c} ${n}`).join(', ');
  const clearing = [toDig.length > own && `${toDig.length - own} natural blocks`, own && `${own} of my own blocks that don't fit the plan`].filter(Boolean);
  const summary = `${width}x${depth} house ${where}, ${floors} floor${floors > 1 ? 's' : ''}${extras.length ? ` plus ${extras.join(' and ')}` : ''}, ${roof} roof, door on the ${door} side at ${posText(plan.door)}. ${parts.join(', ')}. Needs ${needText || 'nothing more'}${clearing.length ? `, and ${clearing.join(' and ')} cleared first` : ''}.`;
  if (input.dry_run) return ok(`Plan: ${summary}${missing.length ? ` Missing: ${missing.join(', ')}.` : ' I have everything.'}`);
  if (missing.length) {
    return fail(`missing items: ${missing.join(', ')}. Nothing was built. ${missingHelp(bot, short.map(([n]) => n), 'build_house with the same settings')} Plan: ${summary}`);
  }

  // The exact settings of a real build go into memory, so carrying on later never depends on
  // the bot remembering to save them.
  const used = Object.fromEntries(Object.entries(materials).filter(([k]) => k !== 'torch' && k !== 'ridge').map(([k, v]) => [k, v ?? 'none']));
  if (materials.torch && materials.torch !== 'torch') used.lights = materials.torch;
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
  const ground = groundUnder(bot, plan.min, plan.max);
  bot.buildZone = buildZone(plan, ground);
  bot.buildKeep = new Set(Object.values(materials).filter(Boolean).map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined));
  const scaffold = watchBuildScaffold(bot, { min: plan.min, max: plan.max, ground }, planned);
  let result = { placed: 0, failures: [], wrong: [], stoppedReason: null };
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
    if (!digProblem && !signal?.aborted) result = await placeAll(ctx, todo.sort(placeOrder(plan)), { strays: scaffold.strays });
  } finally {
    scaffold.stop();
    bot.buildZone = null;
    bot.buildKeep = null;
  }
  const down = await takeDownScaffold(ctx, scaffold.leftover(todo));

  const { placed, wrong, stoppedReason } = result;
  let message = `${summary} Placed ${placed} of ${todo.length} blocks`;
  if (down.removed && !down.stopped) message += `, took down ${down.removed} scaffolding blocks`;
  if (wrong.length) message += `. ${wrong.length} came out turned the wrong way, first: ${wrong.slice(0, 3).join('; ')}`;
  const left = todo.filter((b) => !b.done);
  const groups = groupBlocks(left);
  if (left.length) message += `. Left to do, ${left.length} blocks in ${groups.length} group${groups.length === 1 ? '' : 's'}: ${groups.slice(0, 6).map((g) => leftText({ left: g })).join('. ')}${groups.length > 6 ? `. And ${groups.length - 6} more groups` : ''}`;
  let stopped = digProblem ?? stoppedReason ?? (signal?.aborted ? 'stopped' : null);
  if (down.stopped) stopped = stopped && stopped !== 'stopped' ? `${stopped}; ${down.text}` : down.text;
  if (stopped) message += `. Stopped early: ${stopped}`;
  if (left.length) message += '. build_house with the same settings again keeps what is done and goes on with the rest';
  record(left.length ? `stopped at ${clock()} with ${placed} of ${todo.length} blocks placed${stopped ? `, ${stopped}` : ''}` : `finished at ${clock()}`);
  // Anything placed is progress; only a run that placed nothing of what was left fails.
  return placed > 0 || left.length === 0 ? ok(message) : fail(message);
}
