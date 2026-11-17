import { turnState } from './shapes.js';
import { parseBlock, blockText } from './states.js';

// Five house designs, each returning a build_structure plan { origin, palette, parts, blocks }
// with framed roofs, furnished interiors and surroundings. Built in a south-facing frame
// (0..W-1 across, 0..D-1 back-to-front with the front at dz = D - 1, dy = 0 the base course and
// floor, dy = -1 the ground layer where paths go) and then turned to the chosen door side.

export const HOUSE_DESIGNS = ['cottage', 'cabin', 'l_house', 'two_storey', 'desert'];

const DESIGN_ALIASES = {
  cottage: 'cottage', small: 'cottage', simple: 'cottage',
  cabin: 'cabin', lodge: 'cabin', porch: 'cabin',
  l_house: 'l_house', l_plan: 'l_house', 'l-plan': 'l_house', 'l-house': 'l_house', cross_gable: 'l_house', farmhouse: 'l_house',
  two_storey: 'two_storey', two_floor: 'two_storey', 'two-storey': 'two_storey', 'two-floor': 'two_storey', townhouse: 'two_storey',
  desert: 'desert', sandstone: 'desert', parapet: 'desert', flat: 'desert', adobe: 'desert'
};

// Size limits per design (always odd so doors and gables centre).
export const DESIGN_LIMITS = {
  cottage: { minW: 7, maxW: 11, defW: 9, minD: 7, maxD: 9, defD: 7, floors: 1, cutY: 2 },
  cabin: { minW: 7, maxW: 11, defW: 9, minD: 7, maxD: 9, defD: 7, floors: 1, cutY: 2 },
  l_house: { minW: 11, maxW: 15, defW: 11, minD: 9, maxD: 13, defD: 11, floors: 1, cutY: 2 },
  two_storey: { minW: 7, maxW: 13, defW: 9, minD: 7, maxD: 11, defD: 7, floors: 2, cutY: 7 },
  desert: { minW: 7, maxW: 13, defW: 9, minD: 7, maxD: 11, defD: 9, floors: 1, cutY: 2 }
};

export const HOUSE_PALETTES = {
  oak_stone: {
    name: 'oak, spruce and stone bricks',
    roles: {
      foundation: '85%stone_bricks,15%cobblestone',
      frame: 'oak_log',
      wall: 'oak_planks',
      roof: 'stone_brick_stairs',
      trim: 'spruce_stairs',
      floor: 'spruce_planks',
      glass: 'glass_pane',
      light: 'lantern',
      accent: 'bricks',
      accent2: 'spruce_trapdoor'
    }
  },
  birch_spruce: {
    name: 'birch, spruce and stone bricks',
    roles: {
      foundation: '85%stone_bricks,15%cobblestone',
      frame: 'spruce_log',
      wall: 'birch_planks',
      roof: 'spruce_stairs',
      trim: 'cobblestone_stairs',
      floor: 'oak_planks',
      glass: 'glass_pane',
      light: 'lantern',
      accent: 'stone_bricks',
      accent2: 'spruce_trapdoor'
    }
  },
  spruce_deepslate: {
    name: 'spruce and deepslate',
    roles: {
      foundation: 'deepslate_bricks',
      frame: 'spruce_log',
      wall: 'spruce_planks',
      roof: 'deepslate_brick_stairs',
      trim: 'spruce_stairs',
      floor: 'oak_planks',
      glass: 'glass_pane',
      light: 'lantern',
      accent: 'deepslate_bricks',
      accent2: 'spruce_trapdoor'
    }
  },
  sandstone: {
    name: 'smooth and cut sandstone',
    roles: {
      foundation: 'sandstone',
      frame: 'cut_sandstone',
      wall: 'smooth_sandstone',
      roof: 'smooth_sandstone_stairs',
      trim: 'cut_sandstone_slab',
      floor: 'birch_planks',
      glass: 'glass_pane',
      light: 'lantern',
      accent: 'blue_terracotta',
      accent2: 'oak_trapdoor'
    }
  },
  red_sandstone: {
    name: 'red sandstone and spruce',
    roles: {
      foundation: 'red_sandstone',
      frame: 'cut_red_sandstone',
      wall: 'smooth_red_sandstone',
      roof: 'smooth_red_sandstone_stairs',
      trim: 'cut_red_sandstone_slab',
      floor: 'spruce_planks',
      glass: 'glass_pane',
      light: 'lantern',
      accent: 'cyan_terracotta',
      accent2: 'spruce_trapdoor'
    }
  }
};

const WOOD_ORDER = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'cherry', 'pale_oak', 'mangrove', 'dark_oak'];
const CONTRAST_WOOD = {
  oak: 'spruce', birch: 'spruce', spruce: 'oak', jungle: 'spruce',
  acacia: 'oak', cherry: 'spruce', pale_oak: 'spruce', mangrove: 'oak', dark_oak: 'birch'
};

// Candidate fallback steps for a house from what she carries and where she is:
// Step 1: two woods + stone bricks (or smooth/cut sandstone in desert)
// Step 2: one wood + stone bricks (or sandstone + wood)
// Step 3: one wood + cobblestone that still has a framed roof (tier 3)
export function paletteStepsFor(inventory = new Map(), { design, desert = false } = {}) {
  const count = (n) => inventory.get(n) ?? 0;
  const woodScore = (w) => count(`${w}_planks`) + count(`${w}_stairs`) + count(`${w}_slab`) + count(`${w}_log`) * 4;
  const rankedWoods = [...WOOD_ORDER].sort((a, b) => woodScore(b) - woodScore(a));
  const wood1 = woodScore(rankedWoods[0]) > 0 ? rankedWoods[0] : 'oak';
  const second = rankedWoods.find((w) => w !== wood1 && woodScore(w) > 0);
  const wood2 = second ?? CONTRAST_WOOD[wood1] ?? 'spruce';
  const hasLantern = count('lantern') >= 2;
  const hasLog = count(`${wood1}_log`) >= 12;
  const hasBricks = count('bricks') + count('brick_stairs') >= 16;
  const deepslate = count('deepslate_bricks') + count('deepslate_brick_stairs') > count('stone_bricks') + count('stone_brick_stairs');

  if (design === 'desert' || desert) {
    const red = count('red_sandstone') + count('smooth_red_sandstone') > count('sandstone') + count('smooth_sandstone');
    const base = red ? 'red_sandstone' : 'sandstone';
    return [
      {
        look: red ? 'red sandstone and spruce' : 'smooth and cut sandstone',
        tier: 1,
        roles: { ...(red ? HOUSE_PALETTES.red_sandstone.roles : HOUSE_PALETTES.sandstone.roles) }
      },
      {
        look: `${base.replace('_', ' ')} and ${wood1}`,
        tier: 2,
        roles: {
          foundation: base,
          frame: `cut_${base}`,
          wall: base,
          roof: `${base}_stairs`,
          trim: `${base}_slab`,
          floor: `${wood1}_planks`,
          glass: 'glass_pane',
          light: hasLantern ? 'lantern' : 'torch',
          accent: base,
          accent2: `${wood1}_trapdoor`
        }
      },
      {
        look: `${wood1} and cobblestone`,
        tier: 3,
        roles: {
          foundation: 'cobblestone',
          frame: hasLog ? `${wood1}_log` : `${wood1}_planks`,
          wall: `${wood1}_planks`,
          roof: 'cobblestone_stairs',
          trim: `${wood1}_stairs`,
          floor: `${wood1}_planks`,
          glass: 'glass_pane',
          light: hasLantern ? 'lantern' : 'torch',
          accent: 'cobblestone',
          accent2: `${wood1}_trapdoor`
        }
      }
    ];
  }

  const stoneBase = deepslate ? 'deepslate_bricks' : 'stone_bricks';
  const stoneStairs = deepslate ? 'deepslate_brick_stairs' : 'stone_brick_stairs';
  const stoneName = deepslate ? 'deepslate bricks' : 'stone bricks';

  return [
    {
      look: `${wood1}, ${wood2} and ${stoneName}`,
      tier: 1,
      roles: {
        foundation: deepslate ? 'deepslate_bricks' : '85%stone_bricks,15%cobblestone',
        frame: `${wood1}_log`,
        wall: `${wood1}_planks`,
        roof: stoneStairs,
        trim: `${wood2}_stairs`,
        floor: `${wood2}_planks`,
        glass: 'glass_pane',
        light: 'lantern',
        accent: hasBricks ? 'bricks' : stoneBase,
        accent2: `${wood2}_trapdoor`
      }
    },
    {
      look: `${wood1} and ${stoneName}`,
      tier: 2,
      roles: {
        foundation: stoneBase,
        frame: `${wood1}_log`,
        wall: `${wood1}_planks`,
        roof: stoneStairs,
        trim: `${wood1}_stairs`,
        floor: `${wood1}_planks`,
        glass: 'glass_pane',
        light: hasLantern ? 'lantern' : 'torch',
        accent: stoneBase,
        accent2: `${wood1}_trapdoor`
      }
    },
    {
      look: `${wood1} and cobblestone`,
      tier: 3,
      roles: {
        foundation: 'cobblestone',
        frame: hasLog ? `${wood1}_log` : `${wood1}_planks`,
        wall: `${wood1}_planks`,
        roof: 'cobblestone_stairs',
        trim: `${wood1}_stairs`,
        floor: `${wood1}_planks`,
        glass: 'glass_pane',
        light: hasLantern ? 'lantern' : 'torch',
        accent: 'cobblestone',
        accent2: `${wood1}_trapdoor`
      }
    }
  ];
}

const O = (dx, dy, dz) => ({ dx, dy, dz });
const TURNS = { south: 0, west: 1, north: 2, east: 3 };
const SIDES = ['south', 'west', 'north', 'east'];

// Deterministic 32-bit hash from coordinates so two spots differ but the same spot always
// produces the exact same house.
export function spotSeed(x = 0, y = 0, z = 0) {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

export function resolveDesignName(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/\s+/g, '_');
  return DESIGN_ALIASES[key] ?? null;
}

// Clamps v to [min, max] and rounds to an odd integer within [min, max].
export function oddSize(v, min, max, def) {
  let n = v === undefined || v === null ? def : Math.round(Number(v));
  n = Math.max(min, Math.min(max, n));
  if (n % 2 === 0) n = n + 1 <= max ? n + 1 : n - 1;
  return n;
}

// Picks a design when none was named, from floors, roof, biome/inventory hint, size and seed.
export function pickDesignName({ design, width, depth, floors, roof, desert = false, x = 0, y = 0, z = 0 } = {}) {
  const explicit = resolveDesignName(design);
  if (explicit) return explicit;
  if (roof === 'flat' || desert) return 'desert';
  if ((floors ?? 1) >= 2) return 'two_storey';
  const span = Math.max(width ?? 0, depth ?? 0);
  if (span >= 11) return 'l_house';
  const seed = spotSeed(x, y, z);
  return seed % 2 === 0 ? 'cottage' : 'cabin';
}

function turnText(text, turns) {
  if (!text || typeof text !== 'string' || turns === 0) return text;
  return text.split(/,(?![^\[]*\])/g).map((piece) => {
    const m = /^(\s*(?:\d+(?:\.\d+)?%\s*)?)(.*?)(\s*)$/.exec(piece);
    if (!m || m[2].startsWith('@')) {
      if (m && m[2].includes('[')) {
        const idx = m[2].indexOf('[');
        const head = m[2].slice(0, idx);
        const { props } = parseBlock(`x${m[2].slice(idx)}`);
        const turned = turnState(props, turns);
        const entries = Object.entries(turned);
        return `${m[1]}${head}${entries.length ? `[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}${m[3]}`;
      }
      return piece;
    }
    const { name, props } = parseBlock(m[2]);
    return `${m[1]}${blockText(name, turnState(props, turns))}${m[3]}`;
  }).join(',');
}

// Rotates a south-facing plan (box 0..W-1 by 0..D-1) by turns quarter-turns clockwise so its
// footprint stays anchored at 0,0.
function turnPlan({ parts, blocks, W, D, doorSpot, outsideSpot, wallsBox }, turns) {
  const turnCoord = (dx, dz) => {
    switch (turns % 4) {
      case 1: return [D - 1 - dz, dx];
      case 2: return [W - 1 - dx, D - 1 - dz];
      case 3: return [dz, W - 1 - dx];
      default: return [dx, dz];
    }
  };
  const turnPt = (pt) => {
    const [dx, dz] = turnCoord(pt.dx, pt.dz);
    return { dx, dy: pt.dy, dz };
  };
  const turnFacing = (f) => (f ? SIDES[(SIDES.indexOf(f) + turns) % 4] : f);
  const turnAxis = (a) => (turns % 2 === 1 ? (a === 'x' ? 'z' : a === 'z' ? 'x' : a) : a);

  const turnedParts = parts.map((p) => {
    const next = { ...p, from: turnPt(p.from), to: turnPt(p.to ?? p.from) };
    if (next.facing) next.facing = turnFacing(next.facing);
    if (next.axis) next.axis = turnAxis(next.axis);
    for (const k of ['block', 'fill', 'edge']) if (next[k]) next[k] = turnText(next[k], turns);
    return next;
  });
  const turnedBlocks = blocks.map((b) => {
    const [dx, dz] = turnCoord(b.dx, b.dz);
    return { dx, dy: b.dy, dz, block: turnText(b.block, turns) };
  });
  const b0 = turnPt({ dx: wallsBox.x0, dy: wallsBox.y0, dz: wallsBox.z0 });
  const b1 = turnPt({ dx: wallsBox.x1, dy: wallsBox.y1, dz: wallsBox.z1 });
  return {
    parts: turnedParts,
    blocks: turnedBlocks,
    W: turns % 2 === 1 ? D : W,
    D: turns % 2 === 1 ? W : D,
    doorSpot: turnPt(doorSpot),
    outsideSpot: turnPt(outsideSpot),
    wallsBox: {
      x0: Math.min(b0.dx, b1.dx), x1: Math.max(b0.dx, b1.dx),
      y0: wallsBox.y0, y1: wallsBox.y1,
      z0: Math.min(b0.dz, b1.dz), z1: Math.max(b0.dz, b1.dz)
    }
  };
}

// Wall or ceiling light (never a floor torch).
function roomLight(parts, blocks, { x, y, z, wallZ, tier }) {
  if (tier >= 3) {
    blocks.push({ dx: x, dy: y - 1, dz: wallZ, block: 'wall_torch[facing=south]' });
  } else {
    parts.push({
      shape: 'kit', kind: 'ceiling_light',
      from: O(x, y, z), to: O(x, y, z),
      block: '@floor', fill: '@light', variant: 1
    });
  }
}

// Standard interior for a single rectangular room (x0+1..x1-1, z0+1..z1-1) at floor level fy
// (furniture sits at fy + 1, ceiling at fy + 4), with the doorway at (doorX, fy + 1, z1).
function roomInterior(parts, blocks, { x0, x1, z0, z1, fy = 0, bedColor = 'red_bed', tier = 1 }) {
  const rw = x1 - x0 - 1;
  const rd = z1 - z0 - 1;
  const midX = Math.floor((x0 + x1) / 2);
  const midZ = Math.floor((z0 + z1) / 2);
  const y = fy + 1;

  // Bed nook in the back-left corner (head against north wall z0 + 1).
  if (tier >= 3) {
    blocks.push(
      { dx: x0 + 1, dy: y, dz: z0 + 2, block: `${bedColor}[facing=north]` },
      { dx: x0 + 2, dy: y, dz: z0 + 1, block: '@floor.slab[type=top]' }
    );
  } else {
    parts.push({
      shape: 'kit', kind: 'bed_nook',
      from: O(x0 + 1, y, z0 + 1), to: O(x0 + 2, y, z0 + 2),
      block: '@floor', fill: bedColor, facing: 'south', variant: 1
    });
  }

  // Storage wall along the west wall, keeping the middle aisle open.
  if (rw >= 7 && tier < 3) {
    parts.push({
      shape: 'kit', kind: 'storage_wall',
      from: O(x0 + 1, y, z0 + 3), to: O(x0 + 1, y + 1, z1 - 1),
      block: '@floor', facing: 'east', variant: 1
    });
  } else {
    blocks.push(
      { dx: x0 + 1, dy: y, dz: z0 + 3, block: 'chest[facing=east]' },
      { dx: x0 + 1, dy: y, dz: z1 - 1, block: tier >= 3 ? 'chest[facing=east]' : 'barrel[facing=east]' }
    );
  }

  // Kitchen corner in the back-right: furnace and crafting table.
  if (rw >= 7 && rd >= 5 && tier === 1) {
    parts.push({
      shape: 'kit', kind: 'kitchen',
      from: O(x1 - 3, y, z0 + 1), to: O(x1 - 1, y + 2, z0 + 1),
      block: '@floor', fill: '@foundation', facing: 'south', variant: 1
    });
  } else {
    blocks.push(
      { dx: x1 - 1, dy: y, dz: z0 + 1, block: 'furnace[facing=west]' },
      { dx: x1 - 1, dy: y, dz: z0 + 2, block: 'crafting_table' },
      { dx: x1 - 1, dy: y + 2, dz: z0 + 1, block: '@foundation' }
    );
  }

  // Table and chair in the front-right corner, away from the doorway at midX.
  blocks.push(
    { dx: x1 - 1, dy: y, dz: z1 - 1, block: '@floor.fence' },
    { dx: x1 - 1, dy: y + 1, dz: z1 - 1, block: '@floor.pressure_plate' },
    { dx: x1 - 1, dy: y, dz: z1 - 2, block: '@floor.stairs[facing=north,half=bottom]' }
  );

  // Rug in the middle when the room is at least 7 wide on full tier.
  if (rw >= 7 && rd >= 5 && tier === 1) {
    parts.push({
      shape: 'kit', kind: 'rug',
      from: O(midX - 1, y, midZ), to: O(midX + 1, y, midZ + 1),
      block: bedColor, fill: 'white_carpet', variant: 1
    });
  }

  // Overhead light (never a floor torch).
  roomLight(parts, blocks, { x: midX, y: fy + 3, z: midZ, wallZ: z0 + 1, tier });
}

function buildCottage({ W, D, interior, surroundings, seed, tier = 1 }) {
  const parts = [];
  const blocks = [];
  const midX = Math.floor(W / 2);
  const midZ = Math.floor(D / 2);
  const winVariant = (seed % 2) + 1;
  const bedColor = tier >= 3 ? 'red_bed' : ['red_bed', 'blue_bed', 'yellow_bed'][seed % 3];

  parts.push(
    { shape: 'walls', from: O(0, 0, 0), to: O(W - 1, 0, D - 1), block: '@foundation' },
    { shape: 'fill', from: O(1, 0, 1), to: O(W - 2, 0, D - 2), block: '@floor' },
    { shape: 'fill', from: O(1, 1, 1), to: O(W - 2, 4, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 1, 0), to: O(W - 1, 4, D - 1), block: '@wall' },
    { shape: 'posts', from: O(0, 0, 0), to: O(W - 1, 4, D - 1), block: '@frame', every: Math.max(W, D) },
    { shape: 'line', from: O(1, 4, 0), to: O(W - 2, 4, 0), block: '@frame' },
    { shape: 'line', from: O(1, 4, D - 1), to: O(W - 2, 4, D - 1), block: '@frame' },
    { shape: 'kit', kind: 'door', from: O(midX, 1, D - 1), to: O(midX, 2, D - 1), block: '@wall', fill: '@frame', facing: 'south', variant: tier >= 3 ? 1 : 2, extra: true },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 2, 0), to: O(midX + 1, 3, 0), block: '@wall', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(W - 1, 2, midZ - 1), to: O(W - 1, 3, midZ + 1), block: '@wall', facing: 'east', variant: 1, every: 2 }
  );
  if (W >= 9) {
    parts.push({ shape: 'kit', kind: 'window', from: O(1, 2, D - 1), to: O(W - 2, 3, D - 1), block: '@wall', facing: 'south', variant: winVariant, every: W - 3, extra: winVariant === 1 && tier === 1 });
  }
  const ridgeY = 5 + Math.floor((D + 2) / 2);
  parts.push(
    { shape: 'roof', from: O(0, 5, 0), to: O(W - 1, 5, D - 1), block: '@roof', edge: '@trim', fill: '@wall', style: 'gable', axis: 'x', overhang: 1 },
    { shape: 'kit', kind: 'chimney', from: O(-1, 0, midZ - 1), to: O(-1, ridgeY + 1, midZ), block: '@accent', fill: '@foundation', facing: 'west', variant: 1, extra: tier === 1 }
  );

  if (interior) roomInterior(parts, blocks, { x0: 0, x1: W - 1, z0: 0, z1: D - 1, fy: 0, bedColor, tier });
  if (surroundings) {
    const pathEnd = D + 3 + Math.floor(W / 3);
    if (tier >= 3) {
      parts.push({ shape: 'fill', from: O(midX - 1, -1, D + 1), to: O(midX + 1, -1, pathEnd), block: '@foundation' });
    } else {
      parts.push({ shape: 'kit', kind: 'path', from: O(midX, -1, D + 1), to: O(midX, -1, pathEnd), block: '80%dirt_path,20%coarse_dirt', width: 3, variant: 1 });
      if (W >= 9) parts.push({ shape: 'kit', kind: 'lamp_post', from: O(midX + 3, 0, D + 2), to: O(midX + 3, 3, D + 2), block: '@wall', fill: '@foundation', facing: 'west', variant: 3 });
      blocks.push(
        { dx: midX - 2, dy: 0, dz: D, block: 'barrel' },
        { dx: 0, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: W - 1, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: W - 1, dy: 0, dz: -1, block: 'azalea_leaves' }
      );
    }
  }
  return {
    parts, blocks, W, D,
    doorSpot: O(midX, 1, D - 1),
    outsideSpot: O(midX, 1, D),
    wallsBox: { x0: 0, x1: W - 1, y0: 0, y1: ridgeY, z0: 0, z1: D - 1 }
  };
}

function buildCabin({ W, D, interior, surroundings, seed, tier = 1 }) {
  const parts = [];
  const blocks = [];
  const midX = Math.floor(W / 2);
  const midZ = Math.floor(D / 2);
  const porchVariant = (seed % 2) + 1;
  const bedColor = tier >= 3 ? 'red_bed' : ['red_bed', 'blue_bed', 'green_bed'][seed % 3];

  parts.push(
    { shape: 'walls', from: O(0, 0, 0), to: O(W - 1, 0, D - 1), block: '@foundation' },
    { shape: 'fill', from: O(1, 0, 1), to: O(W - 2, 0, D - 2), block: '@floor' },
    { shape: 'fill', from: O(1, 1, 1), to: O(W - 2, 4, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 1, 0), to: O(W - 1, 4, D - 1), block: '@wall' },
    { shape: 'posts', from: O(0, 0, 0), to: O(W - 1, 4, D - 1), block: '@frame', every: Math.max(W, D) },
    { shape: 'line', from: O(1, 4, 0), to: O(W - 2, 4, 0), block: '@frame' },
    { shape: 'line', from: O(1, 4, D - 1), to: O(W - 2, 4, D - 1), block: '@frame' },
    { shape: 'kit', kind: 'door', from: O(midX, 1, D - 1), to: O(midX, 2, D - 1), block: '@wall', fill: '@frame', facing: 'south', variant: 1, extra: false },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 2, 0), to: O(midX + 1, 3, 0), block: '@wall', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(W - 1, 2, midZ - 1), to: O(W - 1, 3, midZ + 1), block: '@wall', facing: 'east', variant: 1, every: 2 }
  );
  if (W >= 9) {
    parts.push({ shape: 'kit', kind: 'window', from: O(1, 2, D - 1), to: O(W - 2, 3, D - 1), block: '@wall', facing: 'south', variant: 1, every: W - 3 });
  }
  const ridgeY = 5 + Math.floor((D + 2) / 2);
  parts.push(
    { shape: 'roof', from: O(0, 5, 0), to: O(W - 1, 5, D - 1), block: '@roof', edge: '@trim', fill: '@wall', style: 'gable', axis: 'x', overhang: 1 },
    { shape: 'kit', kind: 'porch', from: O(1, 0, D), to: O(W - 2, 3, D + 1), block: '@trim', fill: '@frame', facing: 'south', variant: porchVariant, extra: true },
    { shape: 'kit', kind: 'chimney', from: O(-1, 0, midZ - 1), to: O(-1, ridgeY + 1, midZ), block: '@accent', fill: '@foundation', facing: 'west', variant: 1, extra: tier === 1 }
  );

  if (interior) roomInterior(parts, blocks, { x0: 0, x1: W - 1, z0: 0, z1: D - 1, fy: 0, bedColor, tier });
  if (surroundings) {
    if (tier >= 3) {
      parts.push({ shape: 'fill', from: O(midX - 1, -1, D + 3), to: O(midX + 1, -1, D + 6), block: '@foundation' });
    } else {
      parts.push({ shape: 'kit', kind: 'path', from: O(midX, -1, D + 3), to: O(midX, -1, D + 7), block: '80%dirt_path,20%coarse_dirt', width: 3, variant: 1 });
      blocks.push(
        { dx: 0, dy: 0, dz: D, block: 'barrel' },
        { dx: W - 1, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: 0, dy: 0, dz: D + 1, block: 'azalea_leaves' },
        { dx: W - 1, dy: 0, dz: D + 1, block: 'azalea_leaves' }
      );
    }
  }
  return {
    parts, blocks, W, D: D + 2,
    doorSpot: O(midX, 1, D - 1),
    outsideSpot: O(midX, 1, D + 2),
    wallsBox: { x0: 0, x1: W - 1, y0: 0, y1: ridgeY, z0: 0, z1: D - 1 }
  };
}

function buildLHouse({ W, D, interior, surroundings, seed, tier = 1 }) {
  const parts = [];
  const blocks = [];
  const mainD = 7;
  const wingW = 5;
  const doorX = wingW + Math.floor((W - 1 - wingW) / 2);
  const mainMidZ = Math.floor(mainD / 2);
  const wingMidX = Math.floor(wingW / 2);
  const bedColor = tier >= 3 ? 'red_bed' : ['red_bed', 'blue_bed', 'yellow_bed'][seed % 3];

  // Main rear wing (0..W-1, 0..mainD-1) and front-left wing (0..wingW-1, mainD-1..D-1).
  parts.push(
    { shape: 'walls', from: O(0, 0, 0), to: O(W - 1, 0, mainD - 1), block: '@foundation' },
    { shape: 'walls', from: O(0, 0, mainD - 1), to: O(wingW - 1, 0, D - 1), block: '@foundation' },
    { shape: 'fill', from: O(1, 0, 1), to: O(W - 2, 0, mainD - 2), block: '@floor' },
    { shape: 'fill', from: O(1, 0, mainD - 2), to: O(wingW - 2, 0, D - 2), block: '@floor' },
    { shape: 'fill', from: O(1, 1, 1), to: O(W - 2, 4, mainD - 2), block: 'air' },
    { shape: 'fill', from: O(1, 1, mainD - 1), to: O(wingW - 2, 4, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 1, 0), to: O(W - 1, 4, mainD - 1), block: '@wall' },
    { shape: 'walls', from: O(0, 1, mainD - 1), to: O(wingW - 1, 4, D - 1), block: '@wall' },
    // Open the shared wall between the main box and the wing.
    { shape: 'fill', from: O(1, 1, mainD - 1), to: O(wingW - 2, 3, mainD - 1), block: 'air' },
    { shape: 'posts', from: O(0, 0, 0), to: O(W - 1, 4, mainD - 1), block: '@frame', every: Math.max(W, mainD) },
    { shape: 'posts', from: O(0, 0, mainD - 1), to: O(wingW - 1, 4, D - 1), block: '@frame', every: Math.max(wingW, D) },
    { shape: 'kit', kind: 'door', from: O(doorX, 1, mainD - 1), to: O(doorX, 2, mainD - 1), block: '@wall', fill: '@frame', facing: 'south', variant: tier >= 3 ? 1 : 2, extra: true },
    { shape: 'kit', kind: 'window', from: O(Math.floor(W / 2) - 1, 2, 0), to: O(Math.floor(W / 2) + 1, 3, 0), block: '@wall', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(wingMidX - 1, 2, D - 1), to: O(wingMidX + 1, 3, D - 1), block: '@wall', facing: 'south', variant: 2 },
    { shape: 'kit', kind: 'window', from: O(0, 2, Math.floor((mainD - 1 + D - 1) / 2)), to: O(0, 3, Math.floor((mainD - 1 + D - 1) / 2)), block: '@wall', facing: 'west', variant: 1 },
    { shape: 'kit', kind: 'window', from: O(0, 2, 2), to: O(0, 3, 4), block: '@wall', facing: 'west', variant: 1, every: 2 }
  );

  const ridgeY = 5 + Math.floor((mainD + 2) / 2);
  parts.push(
    { shape: 'roof', from: O(0, 5, mainMidZ + 1), to: O(wingW - 1, 5, D - 1), block: '@roof', edge: '@trim', fill: '@wall', style: 'gable', axis: 'z', overhang: 1 },
    { shape: 'fill', from: O(-1, 5, mainMidZ), to: O(0, ridgeY - 1, mainD - 2), block: 'air' },
    { shape: 'roof', from: O(0, 5, 0), to: O(W - 1, 5, mainD - 1), block: '@roof', edge: '@trim', fill: '@wall', style: 'gable', axis: 'x', overhang: 1 },
    { shape: 'kit', kind: 'chimney', from: O(W, 0, mainMidZ - 1), to: O(W, ridgeY + 1, mainMidZ), block: '@accent', fill: '@foundation', facing: 'east', variant: 1, extra: tier === 1 }
  );

  if (interior) {
    if (tier >= 3) {
      blocks.push(
        { dx: 1, dy: 1, dz: D - 2, block: `${bedColor}[facing=south]` },
        { dx: 3, dy: 1, dz: 1, block: 'chest[facing=south]' },
        { dx: W - 2, dy: 1, dz: 1, block: 'furnace[facing=south]' },
        { dx: W - 3, dy: 1, dz: 1, block: 'crafting_table' }
      );
    } else {
      parts.push(
        { shape: 'kit', kind: 'bed_nook', from: O(1, 1, D - 3), to: O(3, 1, D - 2), block: '@floor', fill: bedColor, facing: 'north', variant: 1 },
        { shape: 'kit', kind: 'storage_wall', from: O(2, 1, 1), to: O(4, 2, 1), block: '@floor', facing: 'south', variant: 1 },
        { shape: 'kit', kind: 'kitchen', from: O(W - 4, 1, 1), to: O(W - 2, 3, 1), block: '@floor', fill: '@foundation', facing: 'south', variant: 1 }
      );
    }
    roomLight(parts, blocks, { x: wingMidX, y: 4, z: mainD, wallZ: D - 2, tier });
    roomLight(parts, blocks, { x: doorX, y: 4, z: mainMidZ, wallZ: 1, tier });
    blocks.push(
      { dx: W - 2, dy: 1, dz: mainD - 2, block: '@floor.fence' },
      { dx: W - 2, dy: 2, dz: mainD - 2, block: '@floor.pressure_plate' },
      { dx: W - 2, dy: 1, dz: mainD - 3, block: '@floor.stairs[facing=north,half=bottom]' }
    );
  }
  if (surroundings) {
    if (tier >= 3) {
      parts.push({ shape: 'fill', from: O(doorX - 1, -1, mainD + 1), to: O(doorX + 1, -1, D + 2), block: '@foundation' });
    } else {
      parts.push(
        { shape: 'kit', kind: 'path', from: O(doorX, -1, mainD + 1), to: O(doorX, -1, D + 3), block: '80%dirt_path,20%coarse_dirt', width: 3, variant: 1 },
        { shape: 'kit', kind: 'lamp_post', from: O(W - 1, 0, D - 1), to: O(W - 1, 3, D - 1), block: '@wall', fill: '@foundation', facing: 'west', variant: 3 }
      );
      blocks.push(
        { dx: wingW, dy: 0, dz: mainD, block: 'barrel' },
        { dx: W - 1, dy: 0, dz: mainD, block: 'azalea_leaves' },
        { dx: 0, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: wingW - 1, dy: 0, dz: D, block: 'azalea_leaves' }
      );
    }
  }
  return {
    parts, blocks, W, D,
    doorSpot: O(doorX, 1, mainD - 1),
    outsideSpot: O(doorX, 1, mainD),
    wallsBox: { x0: 0, x1: W - 1, y0: 0, y1: ridgeY, z0: 0, z1: D - 1 }
  };
}

function buildTwoStorey({ W, D, interior, surroundings, seed, tier = 1 }) {
  const parts = [];
  const blocks = [];
  const midX = Math.floor(W / 2);
  const midZ = Math.floor(D / 2);
  const bedColor = tier >= 3 ? 'red_bed' : ['red_bed', 'blue_bed', 'yellow_bed'][seed % 3];
  const ridgeY = 10 + Math.floor((D + 2) / 2);

  parts.push(
    // Ground floor (dy 0..4)
    { shape: 'walls', from: O(0, 0, 0), to: O(W - 1, 0, D - 1), block: '@foundation' },
    { shape: 'fill', from: O(1, 0, 1), to: O(W - 2, 0, D - 2), block: '@floor' },
    { shape: 'fill', from: O(1, 1, 1), to: O(W - 2, 4, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 1, 0), to: O(W - 1, 4, D - 1), block: '@foundation' },
    { shape: 'posts', from: O(0, 0, 0), to: O(W - 1, 4, D - 1), block: '@frame', every: Math.max(W, D) },
    // Second floor deck and timber band (dy 5)
    { shape: 'fill', from: O(1, 5, 1), to: O(W - 2, 5, D - 2), block: '@floor' },
    { shape: 'band', from: O(0, 5, 0), to: O(W - 1, 5, D - 1), block: '@frame' },
    // Upper floor walls (dy 6..9)
    { shape: 'fill', from: O(1, 6, 1), to: O(W - 2, 9, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 6, 0), to: O(W - 1, 9, D - 1), block: '@wall' },
    { shape: 'posts', from: O(0, 5, 0), to: O(W - 1, 9, D - 1), block: '@frame', every: Math.max(W, D) },
    { shape: 'line', from: O(1, 9, 0), to: O(W - 2, 9, 0), block: '@frame' },
    { shape: 'line', from: O(1, 9, D - 1), to: O(W - 2, 9, D - 1), block: '@frame' },
    // Door and windows on both storeys
    { shape: 'kit', kind: 'door', from: O(midX, 1, D - 1), to: O(midX, 2, D - 1), block: '@wall', fill: '@frame', facing: 'south', variant: tier >= 3 ? 1 : 2, extra: true },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 2, 0), to: O(midX + 1, 3, 0), block: '@wall', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(W - 1, 2, midZ - 1), to: O(W - 1, 3, midZ + 1), block: '@wall', facing: 'east', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 7, D - 1), to: O(midX + 1, 8, D - 1), block: '@wall', facing: 'south', variant: 2, every: 2 },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 7, 0), to: O(midX + 1, 8, 0), block: '@wall', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(W - 1, 7, midZ - 1), to: O(W - 1, 8, midZ + 1), block: '@wall', facing: 'east', variant: 1, every: 2 },
    ...(W >= 9 ? [{ shape: 'kit', kind: 'window', from: O(1, 2, D - 1), to: O(W - 2, 3, D - 1), block: '@wall', facing: 'south', variant: 1, every: W - 3 }] : []),
    // Framed gable roof and chimney
    { shape: 'roof', from: O(0, 10, 0), to: O(W - 1, 10, D - 1), block: '@roof', edge: '@trim', fill: '@wall', style: 'gable', axis: 'x', overhang: 1 },
    { shape: 'kit', kind: 'chimney', from: O(-1, 0, midZ - 1), to: O(-1, ridgeY + 1, midZ), block: '@accent', fill: '@foundation', facing: 'west', variant: 1, extra: tier === 1 },
    // Ladder up the north-west corner (dx 1, dz 1) through the upper floor at dy 5
    { shape: 'line', from: O(1, 1, 1), to: O(1, 5, 1), block: 'ladder[facing=south]' }
  );

  if (interior) {
    // Ground floor: kitchen on north-east, storage on west wall, table in front-right.
    if (W >= 9 && tier === 1) {
      parts.push({ shape: 'kit', kind: 'kitchen', from: O(W - 4, 1, 1), to: O(W - 2, 3, 1), block: '@floor', fill: '@foundation', facing: 'south', variant: 1 });
    } else {
      blocks.push(
        { dx: W - 2, dy: 1, dz: 1, block: 'furnace[facing=west]' },
        { dx: W - 2, dy: 1, dz: 2, block: 'crafting_table' },
        { dx: W - 2, dy: 3, dz: 1, block: '@foundation' }
      );
    }
    blocks.push(
      { dx: 1, dy: 1, dz: 3, block: 'chest[facing=east]' },
      { dx: 1, dy: 1, dz: D - 2, block: tier >= 3 ? 'chest[facing=east]' : 'barrel[facing=east]' },
      { dx: W - 2, dy: 1, dz: D - 2, block: '@floor.fence' },
      { dx: W - 2, dy: 2, dz: D - 2, block: '@floor.pressure_plate' },
      { dx: W - 2, dy: 1, dz: D - 3, block: '@floor.stairs[facing=north,half=bottom]' }
    );
    roomLight(parts, blocks, { x: midX, y: 4, z: midZ, wallZ: 1, tier });
    // Upper floor (dy 6): bed nook in back-right, bookshelf wall, ceiling light.
    if (tier >= 3) {
      blocks.push({ dx: W - 2, dy: 6, dz: 2, block: `${bedColor}[facing=north]` });
    } else {
      parts.push(
        { shape: 'kit', kind: 'bed_nook', from: O(W - 3, 6, 1), to: O(W - 2, 6, 2), block: '@floor', fill: bedColor, facing: 'south', variant: 1 },
        { shape: 'kit', kind: 'bookshelf_wall', from: O(1, 6, D - 2), to: O(3, 7, D - 2), block: '@floor', fill: '@frame', facing: 'north', variant: 1 }
      );
    }
    roomLight(parts, blocks, { x: midX, y: 9, z: midZ, wallZ: 1, tier });
  }
  if (surroundings) {
    if (tier >= 3) {
      parts.push({ shape: 'fill', from: O(midX - 1, -1, D + 1), to: O(midX + 1, -1, D + 4), block: '@foundation' });
    } else {
      parts.push({ shape: 'kit', kind: 'path', from: O(midX, -1, D + 1), to: O(midX, -1, D + 5), block: '80%dirt_path,20%coarse_dirt', width: 3, variant: 1 });
      blocks.push(
        { dx: midX - 2, dy: 0, dz: D, block: 'barrel' },
        { dx: 0, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: W - 1, dy: 0, dz: D, block: 'azalea_leaves' }
      );
    }
  }
  return {
    parts, blocks, W, D,
    doorSpot: O(midX, 1, D - 1),
    outsideSpot: O(midX, 1, D),
    wallsBox: { x0: 0, x1: W - 1, y0: 0, y1: ridgeY, z0: 0, z1: D - 1 }
  };
}

function buildDesert({ W, D, interior, surroundings, seed, tier = 1 }) {
  const parts = [];
  const blocks = [];
  const midX = Math.floor(W / 2);
  const midZ = Math.floor(D / 2);
  const bedColor = tier >= 3 ? 'red_bed' : ['blue_bed', 'cyan_bed', 'yellow_bed'][seed % 3];

  parts.push(
    { shape: 'walls', from: O(0, 0, 0), to: O(W - 1, 0, D - 1), block: '@foundation' },
    { shape: 'fill', from: O(1, 0, 1), to: O(W - 2, 0, D - 2), block: '@accent' },
    { shape: 'fill', from: O(2, 0, 2), to: O(W - 3, 0, D - 3), block: '@floor' },
    { shape: 'fill', from: O(1, 1, 1), to: O(W - 2, 4, D - 2), block: 'air' },
    { shape: 'walls', from: O(0, 1, 0), to: O(W - 1, 4, D - 1), block: '@wall' },
    { shape: 'posts', from: O(0, 0, 0), to: O(W - 1, 5, D - 1), block: '@frame', every: Math.max(W, D) },
    { shape: 'walls', from: O(0, 4, 0), to: O(W - 1, 4, D - 1), block: '@frame' },
    { shape: 'fill', from: O(0, 5, 0), to: O(W - 1, 5, D - 1), block: '@frame' },
    { shape: 'fill', from: O(1, 5, 1), to: O(W - 2, 5, D - 2), block: '@wall' },
    { shape: 'kit', kind: 'battlements', from: O(0, 6, 0), to: O(W - 1, 6, D - 1), block: '@frame', variant: 2 },
    { shape: 'kit', kind: 'door', from: O(midX, 1, D - 1), to: O(midX, 2, D - 1), block: '@floor', fill: '@frame', facing: 'south', variant: tier >= 3 ? 1 : 2, extra: true },
    { shape: 'kit', kind: 'window', from: O(midX - 1, 2, 0), to: O(midX + 1, 3, 0), block: '@roof', facing: 'north', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(0, 2, midZ - 1), to: O(0, 3, midZ + 1), block: '@roof', facing: 'west', variant: 1, every: 2 },
    { shape: 'kit', kind: 'window', from: O(W - 1, 2, midZ - 1), to: O(W - 1, 3, midZ + 1), block: '@roof', facing: 'east', variant: 1, every: 2 }
  );
  if (W >= 9) {
    parts.push({ shape: 'kit', kind: 'window', from: O(1, 2, D - 1), to: O(W - 2, 3, D - 1), block: '@roof', facing: 'south', variant: 1, every: W - 3 });
  }
  // Trapdoor shades over the side windows.
  blocks.push(
    { dx: -1, dy: 4, dz: midZ - 1, block: '@accent2[facing=west,half=top,open=false]' },
    { dx: -1, dy: 4, dz: midZ + 1, block: '@accent2[facing=west,half=top,open=false]' },
    { dx: W, dy: 4, dz: midZ - 1, block: '@accent2[facing=east,half=top,open=false]' },
    { dx: W, dy: 4, dz: midZ + 1, block: '@accent2[facing=east,half=top,open=false]' }
  );

  if (interior) roomInterior(parts, blocks, { x0: 0, x1: W - 1, z0: 0, z1: D - 1, fy: 0, bedColor, tier });
  if (surroundings) {
    if (tier >= 3) {
      parts.push({ shape: 'fill', from: O(midX - 1, -1, D + 1), to: O(midX + 1, -1, D + 4), block: '@foundation' });
    } else {
      parts.push({ shape: 'kit', kind: 'path', from: O(midX, -1, D + 1), to: O(midX, -1, D + 5), block: '80%sandstone,20%smooth_sandstone', width: 3, variant: 1 });
      blocks.push(
        { dx: midX - 2, dy: 0, dz: D, block: 'barrel' },
        { dx: 0, dy: 0, dz: D, block: 'azalea_leaves' },
        { dx: W - 1, dy: 0, dz: D, block: 'azalea_leaves' }
      );
    }
  }
  return {
    parts, blocks, W, D,
    doorSpot: O(midX, 1, D - 1),
    outsideSpot: O(midX, 1, D),
    wallsBox: { x0: 0, x1: W - 1, y0: 0, y1: 7, z0: 0, z1: D - 1 }
  };
}

const BUILDERS = {
  cottage: buildCottage,
  cabin: buildCabin,
  l_house: buildLHouse,
  two_storey: buildTwoStorey,
  desert: buildDesert
};

// Builds a build_structure plan for the named or picked house design centered on (x, y, z).
export function designHousePlan(opts = {}) {
  const {
    x = 0, y = 64, z = 0,
    door = 'south',
    interior = true,
    surroundings = true,
    palette,
    tier = 1,
    look
  } = opts;
  const design = pickDesignName(opts);
  const limits = DESIGN_LIMITS[design];
  const turns = TURNS[door] ?? 0;
  // Width is along x and depth along z in world coordinates; in the south-facing frame when turned
  // 90 or 270 degrees, swap the requested width and depth before clamping.
  const rawW = turns % 2 === 1 ? opts.depth : opts.width;
  const rawD = turns % 2 === 1 ? opts.width : opts.depth;
  const W = oddSize(rawW, limits.minW, limits.maxW, limits.defW);
  const D = oddSize(rawD, limits.minD, limits.maxD, limits.defD);
  const seed = opts.seed ?? spotSeed(x, y, z);

  const south = BUILDERS[design]({ W, D, interior: interior !== false, surroundings: surroundings !== false, seed, tier });
  const turned = turnPlan(south, turns);
  const worldW = turns % 2 === 1 ? D : W;
  const worldD = turns % 2 === 1 ? W : D;
  const origin = {
    x: x - Math.floor(worldW / 2),
    y,
    z: z - Math.floor(worldD / 2)
  };
  const defaultEntry = design === 'desert' ? HOUSE_PALETTES.sandstone : HOUSE_PALETTES.oak_stone;
  return {
    origin,
    palette: { ...defaultEntry.roles, ...(palette ?? {}) },
    parts: turned.parts,
    blocks: turned.blocks,
    design,
    look: look ?? defaultEntry.name,
    tier,
    seed,
    width: worldW,
    depth: worldD,
    floors: limits.floors,
    door: TURNS[door] !== undefined ? door : 'south',
    interior: interior !== false,
    surroundings: surroundings !== false,
    cutY: limits.cutY,
    doorSpot: turned.doorSpot,
    outsideSpot: turned.outsideSpot,
    wallsBox: turned.wallsBox
  };
}
