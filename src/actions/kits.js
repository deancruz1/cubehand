import { createRequire } from 'node:module';
import { PlanError, material, formName, turnState } from './shapes.js';
import { blockText } from './states.js';

// The game version the bot speaks, for block names when no registry is given.
const GAME_VERSION = '26.1';
let gameBlocks = null;
function knownInGame(name) {
  if (!gameBlocks) {
    const requireMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
    gameBlocks = new Set(Object.keys(requireMf('minecraft-data')(GAME_VERSION)?.blocksByName ?? {}));
  }
  return gameBlocks.has(name);
}

// Ready-made details for a build_structure plan, one part each: a window with its sill and
// shutters, a porch, a lamp post. A kit is drawn in its own frame as if it faced south (its front
// looking +z): u runs to the right as seen from the front, w out toward the front, y is the plan's
// dy. Then every block and state is turned to the part's facing.

const SIDES = ['north', 'south', 'east', 'west'];
const TURNS = { south: 0, west: 1, north: 2, east: 3 };
// The ways in the kit's own frame.
const BACK = 'north';
const OUT = 'south';
const LEFT = 'west';
const RIGHT = 'east';

const AXIS_BLOCK = /_log$|_wood$|_stem$|_hyphae$|basalt$|^bone_block$|_pillar$|^hay_block$|^bamboo_block$|^iron_chain$|^chain$|_froglight$/;
const DYE = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/;
const WOOD = /^(?:stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_/;
const LANTERN = /lantern$/;
// Names of a block's forms rather than the block itself.
const FORM_END = /_(stairs|slab|wall|fence|fence_gate|trapdoor|door|button|pressure_plate|sign|wall_sign|hanging_sign)$/;
// A close block of the same tone, for the odd accent in a path of one block.
const TONE = {
  gravel: ['andesite'], coarse_dirt: ['dirt'], dirt: ['coarse_dirt'], dirt_path: ['coarse_dirt'], rooted_dirt: ['coarse_dirt'],
  packed_mud: ['mud_bricks'], mud_bricks: ['packed_mud'], cobblestone: ['mossy_cobblestone'], stone: ['andesite'],
  stone_bricks: ['cracked_stone_bricks'], mossy_stone_bricks: ['stone_bricks'], andesite: ['stone'], polished_andesite: ['andesite'],
  sand: ['sandstone'], sandstone: ['smooth_sandstone'], deepslate_bricks: ['cracked_deepslate_bricks'],
  cobbled_deepslate: ['deepslate_tiles'], tuff: ['tuff_bricks'], tuff_bricks: ['tuff']
};
const FLOWERS = ['poppy', 'dandelion', 'azure_bluet', 'cornflower', 'oxeye_daisy', 'allium', 'lily_of_the_valley'];

const stair = (facing, half = 'bottom') => ({ facing, half });
const open = (facing) => ({ facing, open: 'true', half: 'bottom' });
const along = (axis) => (e) => (AXIS_BLOCK.test(e.name) ? { axis } : {});
const hanging = { hanging: 'true' };
const standing = { hanging: 'false' };

// A number in [0, 1) for a spot in the kit's own frame, so a kit looks the same wherever it goes
// and whichever way it faces.
function spot(u, y, w, salt = 0) {
  let h = Math.imul(u | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(w | 0, 83492791) ^ Math.imul(salt | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// One entry of a mix, picked by r in [0, 1), for kits that pick in their own frame.
function oneOf(entries, r) {
  const total = entries.reduce((sum, e) => sum + (e.w ?? 1), 0);
  let t = r * total;
  return [entries.find((e) => (t -= e.w ?? 1) < 0) ?? entries.at(-1)];
}

// Spots along a line of length cells, about every apart, both ends included.
function spread(length, every) {
  if (length <= 1) return [0];
  const n = Math.max(1, Math.round((length - 1) / every));
  const out = new Set();
  for (let k = 0; k <= n; k++) out.add(Math.round((k * (length - 1)) / n));
  return [...out];
}

function boxOf(part) {
  const { from, to = from } = part;
  return {
    x0: Math.min(from.dx, to.dx), x1: Math.max(from.dx, to.dx),
    y0: Math.min(from.dy, to.dy), y1: Math.max(from.dy, to.dy),
    z0: Math.min(from.dz, to.dz), z1: Math.max(from.dz, to.dz)
  };
}

// The size of a part's box in the kit's frame: W across, H up, D deep.
export function kitSize(part) {
  const b = boxOf(part);
  const turns = TURNS[part.facing ?? 'south'] ?? 0;
  const [sx, sz] = [b.x1 - b.x0 + 1, b.z1 - b.z0 + 1];
  return { W: turns % 2 ? sz : sx, H: b.y1 - b.y0 + 1, D: turns % 2 ? sx : sz, y0: b.y0, y1: b.y1 };
}

// A spot in the kit's frame as plan offsets [dx, dz], for a box facing that way.
export function kitToPlan(b, facing, u, w) {
  switch (facing) {
    case 'north': return [b.x1 - u, b.z1 - w];
    case 'west': return [b.x1 - w, b.z0 + u];
    case 'east': return [b.x0 + w, b.z1 - u];
    default: return [b.x0 + u, b.z0 + w];
  }
}

// The other way round: plan offsets as [u, w] in the kit's frame.
export function planToKit(b, facing, dx, dz) {
  switch (facing) {
    case 'north': return [b.x1 - dx, b.z1 - dz];
    case 'west': return [dz - b.z0, b.x1 - dx];
    case 'east': return [b.z1 - dz, dx - b.x0];
    default: return [dx - b.x0, dz - b.z0];
  }
}

function makeContext(part, put, mat, ctx, where) {
  const kind = part.kind;
  const facing = part.facing ?? 'south';
  if (!SIDES.includes(facing)) throw new PlanError(`${where}: facing is ${facing}, it is north, south, east or west`);
  const turns = TURNS[facing];
  const b = boxOf(part);
  const size = kitSize(part);
  const palette = ctx.palette ?? {};
  const known = ctx.known ?? knownInGame;
  const named = (text, label) => material(text, ctx, `${where}, ${label}`);
  // A wooden door, fence, trapdoor and the like stand for their wood's planks, so a kit can find
  // any other form of that wood from them.
  const family = (name) => {
    const wood = WOOD.exec(name)?.[1];
    return wood && FORM_END.test(name) && known(`${wood}_planks`) ? `${wood}_planks` : name;
  };
  const air = named('air', 'air');
  const K = {
    kind, where, part, facing, turns, palette, known, ...size,
    variant: part.variant ?? 1,
    extra: part.extra === true,
    // Puts a block at u, y, w of the kit's frame. state is the block's state as if the kit faced
    // south, or a function of the picked block giving it.
    at(u, y, w, entries, state = {}) {
      const [x, z] = kitToPlan(b, facing, u, w);
      put(x, y, z, entries, (e) => {
        if (e.name === 'air') return 'air';
        const own = typeof state === 'function' ? state(e) : state;
        return blockText(e.name, turnState({ ...e.props, ...own }, turns));
      });
    },
    air(u, y, w) {
      K.at(u, y, w, air);
    },
    // A plan field as blocks, or the fallback text when the part leaves it out (null when there
    // is no fallback either).
    mat(field, fallback = null) {
      // A form (oak_door, spruce_stairs, stone_brick_wall) stands for its full block: the kit
      // makes every form it needs from that.
      if (part[field] !== undefined && part[field] !== null && part[field] !== '') return K.full(mat(field));
      return fallback ? named(fallback, `${field} (left out, so ${fallback})`) : null;
    },
    fixed(text) {
      return named(text, text);
    },
    // A palette role when the plan has it, else the fallback block.
    role(role, fallback) {
      return palette[role] ? named(`@${role}`, `@${role}`) : named(fallback, fallback);
    },
    // The first of the names this game has.
    first(...names) {
      const name = names.find((n) => known(n));
      return name ? named(name, name) : null;
    },
    tryForm(entries, form) {
      if (!entries) return null;
      const made = entries.map((e) => ({ ...e, name: formName(family(e.name), form, known), props: {}, text: undefined })).filter((e) => e.name);
      if (!made.length) return null;
      made.salt = entries.salt;
      return made;
    },
    form(entries, form, field) {
      const made = K.tryForm(entries, form);
      if (made) return made;
      const given = part[field] ? `"${part[field]}"` : 'left out';
      const like = ['trapdoor', 'door', 'fence', 'fence_gate', 'log'].includes(form) ? 'a wood like spruce_planks' : 'one, like spruce_planks or stone_bricks';
      throw new PlanError(`${where}: kit ${kind} needs the ${form} of ${field} (${given}, which is ${entries[0].name}) and there is none; give ${field} ${like}`);
    },
    // The full block of stairs, slabs and the like; other blocks as they are.
    full(entries) {
      const made = entries.map((e) => (FORM_END.test(e.name) ? { ...e, name: formName(family(e.name), 'block', known) ?? e.name, props: {}, text: undefined } : e));
      made.salt = entries.salt;
      return made;
    },
    // A floor or deck: the full block, but the planks of a log or stripped log.
    planks(entries) {
      const made = K.full(entries).map((e) => (AXIS_BLOCK.test(e.name) && WOOD.test(e.name) ? { ...e, name: formName(e.name, 'planks', known) ?? e.name, props: {}, text: undefined } : e));
      made.salt = entries.salt;
      return made;
    },
    // A fence of the block, else its wall, for rails and posts.
    rail(entries, field) {
      return K.tryForm(entries, 'fence') ?? K.tryForm(entries, 'wall') ?? K.form(entries, 'fence', field);
    },
    // A light that can hang or stand on a post: the palette's light when it is a lantern.
    lantern() {
      if (palette.light) {
        const own = named('@light', '@light');
        if (own.every((e) => LANTERN.test(e.name) && !/^(sea|jack_o)_lantern$/.test(e.name))) return own;
      }
      return named('lantern', 'lantern');
    },
    torch() {
      return named(/soul/.test(palette.light ?? '') && known('soul_wall_torch') ? 'soul_wall_torch' : 'wall_torch', 'wall torch');
    },
    hash: spot,
    need(ok, text) {
      if (!ok) throw new PlanError(`${where}: kit ${kind} ${text}`);
    },
    // The same kit on another box and facing, for kits made of runs (a fence round a pen).
    sub(over) {
      return makeContext({ ...part, ...over }, put, mat, ctx, where);
    },
    // Puts a block at plan offsets, for kits laid out in the plan's own terms (a path).
    plan(x, y, z, entries, state = {}) {
      put(x, y, z, entries, (e) => (e.name === 'air' ? 'air' : blockText(e.name, { ...e.props, ...(typeof state === 'function' ? state(e) : state) })));
    },
    box: b
  };
  return K;
}

const sizeText = (K) => `${K.W} wide, ${K.H} high and ${K.D} deep`;

// Openings. Box: the opening in the wall (the wall plane, often one block thick), facing out.

function windowKit(K) {
  const { W, H, D, y0, y1, variant, part } = K;
  // every: a row of one-wide windows that far apart across the box, like a pair with one block
  // of wall between (3 wide, every 2).
  if (part.every !== undefined && part.every !== null) {
    K.need(Number.isInteger(part.every) && part.every >= 2, `every is how far apart the windows in the row are, 2 or more; it is ${part.every}`);
    for (let u = 0; u < W; u += part.every) {
      const [ax, az] = kitToPlan(K.box, K.facing, u, 0);
      const [bx, bz] = kitToPlan(K.box, K.facing, u, D - 1);
      windowKit(K.sub({ from: { dx: ax, dy: y0, dz: az }, to: { dx: bx, dy: y1, dz: bz }, every: null }));
    }
    return;
  }
  K.need(variant !== 3 || (W >= 2 && H >= 2), `variant 3 (arched) needs a window at least 2 wide and 2 high, this one is ${W} by ${H}`);
  const F = D - 1;
  const trim = K.mat('block');
  const frame = K.mat('fill') ?? K.full(trim);
  const glass = K.role('glass', 'glass_pane');
  for (let u = 0; u < W; u++) {
    for (let y = y0; y <= y1; y++) {
      for (let w = 0; w < F; w++) K.air(u, y, w);
      K.at(u, y, F, glass);
    }
  }
  const out = F + 1;
  if (variant === 1) {
    // Head and sill in the wall itself: an upside-down stair over, a stair under.
    const stairs = K.form(trim, 'stairs', 'block');
    for (let u = 0; u < W; u++) {
      K.at(u, y0 - 1, F, stairs, stair(BACK));
      K.at(u, y1 + 1, F, stairs, stair(BACK, 'top'));
    }
  } else if (variant === 2) {
    // Shutters beside it, a slab sill and a trapdoor awning over it.
    const trapdoor = K.form(trim, 'trapdoor', 'block');
    const slab = K.form(trim, 'slab', 'block');
    for (let y = y0; y <= y1; y++) {
      K.at(-1, y, out, trapdoor, open(OUT));
      K.at(W, y, out, trapdoor, open(OUT));
    }
    for (let u = -1; u <= W; u++) {
      K.at(u, y0 - 1, out, slab, { type: 'top' });
      K.at(u, y1 + 1, out, trapdoor, { facing: OUT, half: 'top', open: 'false' });
    }
  } else {
    const stairs = K.form(frame, 'stairs', K.part.fill ? 'fill' : 'block');
    const sill = K.form(trim, 'stairs', 'block');
    K.at(0, y1, F, stairs, stair(LEFT, 'top'));
    K.at(W - 1, y1, F, stairs, stair(RIGHT, 'top'));
    for (let u = -1; u <= W; u++) K.at(u, y1 + 1, F, frame, along('x'));
    for (let u = 0; u < W; u++) K.at(u, y0 - 1, out, sill, stair(BACK, 'top'));
  }
  if (K.extra) {
    const trapdoor = K.form(trim, 'trapdoor', 'block');
    const soil = K.fixed('dirt');
    for (let u = 0; u < W; u++) {
      K.at(u, y0 - 1, out, soil);
      K.at(u, y0, out, K.fixed(FLOWERS[Math.floor(K.hash(u, 0, 0, 7) * FLOWERS.length)]));
      K.at(u, y0 - 1, out + 1, trapdoor, open(OUT));
    }
    K.at(-1, y0 - 1, out, trapdoor, open(LEFT));
    K.at(W, y0 - 1, out, trapdoor, open(RIGHT));
  }
}

function bayWindowKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W >= 1 && H >= 1, 'needs an opening');
  const F = D - 1;
  const out = F + 1;
  const frame = K.mat('block');
  const roof = K.mat('fill', K.palette.roof ? '@roof' : null) ?? frame;
  const glass = K.role('glass', 'glass_pane');
  const post = K.full(frame);
  const corbel = K.form(frame, 'stairs', 'block');
  for (let u = 0; u < W; u++) {
    for (let y = y0; y <= y1; y++) {
      for (let w = 0; w <= F; w++) K.air(u, y, w);
      K.at(u, y, out, glass);
    }
  }
  for (let y = y0 - 1; y <= y1; y++) {
    K.at(-1, y, out, post, along('y'));
    K.at(W, y, out, post, along('y'));
  }
  for (let u = 0; u < W; u++) K.at(u, y0 - 1, out, corbel, stair(BACK, 'top'));
  if (variant === 1) {
    const stairs = K.form(roof, 'stairs', K.part.fill ? 'fill' : 'block');
    for (let u = -1; u <= W; u++) K.at(u, y1 + 1, out, stairs, stair(BACK));
    K.at(-1, y0 - 2, out, corbel, stair(BACK, 'top'));
    K.at(W, y0 - 2, out, corbel, stair(BACK, 'top'));
  } else {
    const slab = K.form(roof, 'slab', K.part.fill ? 'fill' : 'block');
    const edge = K.form(roof, 'stairs', K.part.fill ? 'fill' : 'block');
    for (let u = -1; u <= W; u++) {
      K.at(u, y1 + 1, out, slab, { type: 'bottom' });
      K.at(u, y1 + 1, out + 1, edge, stair(BACK, 'top'));
    }
    K.at(-1, y1 + 1, out + 1, edge, stair(LEFT, 'top'));
    K.at(W, y1 + 1, out + 1, edge, stair(RIGHT, 'top'));
    for (let u = -1; u <= W; u++) K.at(u, y0 - 2, out, corbel, stair(BACK, 'top'));
  }
}

function dormerKit(K) {
  const { W, H, D, y0, y1, variant, part } = K;
  K.need(D === 1, `needs a box one block deep (the window in the dormer's face), this one is ${sizeText(K)}`);
  K.need(part.pitch === undefined || part.pitch === 1 || part.pitch === 2, `pitch is ${part.pitch}; a dormer goes on a roof of pitch 1 or 2 only (on a flatter roof it would run far back over it), so give the roof pitch 1 or 2 or leave the dormer out`);
  const wall = K.mat('block');
  const roof = K.mat('fill', K.palette.roof ? '@roof' : null) ?? wall;
  const roofField = part.fill || K.palette.roof ? 'fill' : 'block';
  const stairs = K.form(roof, 'stairs', roofField);
  const slab = K.tryForm(roof, 'slab') ?? K.full(roof);
  const glass = K.role('glass', 'glass_pane');
  const s = part.pitch ?? 1;
  // The main roof is taken to rise s for each block back from the sill at y0 - 1.
  const surface = (j) => y0 - 1 + s * j;
  const reach = (y) => Math.ceil((y - (y0 - 1)) / s);
  const mid = (W - 1) / 2;
  const top = (u) => (variant === 2 ? y1 + 1 : y1 + 1 + Math.min(u + 1, W - u));
  for (let u = 0; u < W; u++) {
    K.at(u, y0 - 1, 0, wall);
    for (let y = y0; y <= y1; y++) K.at(u, y, 0, glass);
    for (let y = y1 + 1; y < top(u); y++) K.at(u, y, 0, wall);
    for (let j = 1; surface(j) < top(u); j++) for (let y = surface(j); y < top(u); y++) K.air(u, y, -j);
  }
  for (const u of [-1, W]) {
    for (let j = 0; surface(j) < top(u); j++) for (let y = surface(j); y < top(u); y++) K.at(u, y, -j, wall);
  }
  for (let u = -1; u <= W; u++) {
    const y = top(u);
    for (let w = 1; w >= -reach(y); w--) {
      if (variant === 2) K.at(u, y, w, stairs, stair(BACK));
      else if (u === mid) K.at(u, y, w, slab, { type: 'bottom' });
      else K.at(u, y, w, stairs, stair(u < mid ? RIGHT : LEFT));
    }
  }
}

function doorKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W <= 2 && H >= 2, `needs a doorway 1 or 2 wide and at least 2 high, this one is ${W} by ${H}`);
  const F = D - 1;
  const out = F + 1;
  const wood = K.mat('block');
  const door = K.form(wood, 'door', 'block');
  const frameText = K.palette.frame ? '@frame' : null;
  const frame = K.mat('fill', frameText) ?? K.tryForm(wood, 'log') ?? K.full(wood);
  const stepFrom = K.tryForm(frame, 'stairs') ? frame : wood;
  const step = K.form(stepFrom, 'stairs', stepFrom === frame ? 'fill' : 'block');
  const glass = K.role('glass', 'glass_pane');
  for (let u = 0; u < W; u++) {
    for (let y = y0; y <= y1; y++) for (let w = 0; w < F; w++) K.air(u, y, w);
    K.at(u, y0, F, door, { facing: OUT });
    K.air(u, y0 + 1, F);
    for (let y = y0 + 2; y <= y1; y++) K.at(u, y, F, glass);
    if (K.extra) K.at(u, y0 - 1, out, step, stair(BACK));
  }
  const framed = () => {
    for (let y = y0; y <= y1; y++) {
      K.at(-1, y, F, frame, along('y'));
      K.at(W, y, F, frame, along('y'));
    }
    for (let u = -1; u <= W; u++) K.at(u, y1 + 1, F, frame, along('x'));
  };
  if (variant === 1) {
    framed();
    K.at(-1, y0 + 1, out, K.torch(), { facing: OUT });
    K.at(W, y0 + 1, out, K.torch(), { facing: OUT });
  } else if (variant === 2) {
    const hood = K.form(K.tryForm(frame, 'stairs') ? frame : wood, 'stairs', 'block');
    for (let u = -1; u <= W; u++) K.at(u, y1 + 1, out, hood, stair(BACK));
    K.at(-1, y1, out, K.lantern(), hanging);
    K.at(W, y1, out, K.lantern(), hanging);
  } else {
    framed();
    const roof = K.form(K.tryForm(frame, 'stairs') ? frame : wood, 'stairs', 'block');
    const slab = K.tryForm(roof, 'slab') ?? K.full(roof);
    const mid = (W - 1) / 2;
    for (let u = -1; u <= W; u++) {
      const k = Math.min(u + 1, W - u);
      if (u === mid) K.at(u, y1 + 2 + k, F, slab, { type: 'bottom' });
      else K.at(u, y1 + 2 + k, F, roof, stair(u < mid ? RIGHT : LEFT));
      for (let y = y1 + 2; y < y1 + 2 + k; y++) K.at(u, y, F, frame, along('x'));
    }
    K.at(-2, y0 + 1, out, K.torch(), { facing: OUT });
    K.at(W + 1, y0 + 1, out, K.torch(), { facing: OUT });
  }
}

function porchKit(K) {
  const { W, H, D, y0, y1, variant, part } = K;
  K.need(W >= 3 && D >= 2 && H >= 4, `needs a deck at least 3 wide and 2 deep with posts 3 high (from.dy the deck, to.dy the post tops), this one is ${sizeText(K)}`);
  const deck = K.mat('block');
  const planks = K.planks(deck);
  const posts = K.mat('fill', K.palette.frame ? '@frame' : null) ?? K.tryForm(deck, 'log') ?? planks;
  const rails = K.rail(part.fill || K.palette.frame ? posts : deck, part.fill ? 'fill' : 'block');
  const stairs = K.form(deck, 'stairs', 'block');
  const slab = K.form(deck, 'slab', 'block');
  const every = part.every ?? 4;
  const postAt = new Set(spread(W, every));
  for (let u = 0; u < W; u++) for (let w = 0; w < D; w++) K.at(u, y0, w, planks);
  // The posts stand on stone set in the deck.
  const foot = footOf(K, null);
  for (const u of postAt) K.at(u, y0, D - 1, foot);
  for (let u = 0; u < W; u++) {
    if (postAt.has(u)) for (let y = y0 + 1; y <= y1; y++) K.at(u, y, D - 1, posts, along('y'));
    else K.at(u, y1, D - 1, posts, along('x'));
  }
  const under = new Map();
  const roofAt = (u, y, w, entries, state) => {
    K.at(u, y, w, entries, state);
    if (!under.has(`${u},${w}`)) under.set(`${u},${w}`, y);
  };
  const mid = (W - 1) / 2;
  if (variant === 1) {
    for (let w = D; w >= 0; w--) {
      const r = D - w;
      const y = y1 + 1 + Math.floor(r / 2);
      for (let u = -1; u <= W; u++) {
        if (r % 2 === 0) roofAt(u, y, w, stairs, stair(BACK));
        else roofAt(u, y, w, slab, { type: 'top' });
      }
    }
  } else if (variant === 2) {
    for (let u = -1; u <= W; u++) {
      const k = Math.min(u + 1, W - u);
      const y = y1 + 1 + k;
      for (let w = 0; w <= D; w++) {
        if (u === mid) roofAt(u, y, w, slab, { type: 'bottom' });
        else roofAt(u, y, w, stairs, stair(u < mid ? RIGHT : LEFT));
      }
      if (u >= 0 && u < W) for (let gy = y1 + 1; gy < y; gy++) K.at(u, gy, D - 1, planks);
    }
  } else {
    for (let u = -1; u <= W; u++) {
      for (let w = 0; w <= D; w++) {
        const edge = u === -1 || u === W || w === D;
        if (!edge) roofAt(u, y1 + 1, w, slab, { type: 'top' });
        else roofAt(u, y1 + 1, w, stairs, stair(w === D ? BACK : u === -1 ? RIGHT : LEFT, 'top'));
      }
    }
    for (let u = -1; u <= W; u++) K.at(u, y1 + 2, D, rails);
    for (let w = 0; w < D; w++) {
      K.at(-1, y1 + 2, w, rails);
      K.at(W, y1 + 2, w, rails);
    }
  }
  const sw = W >= 5 ? (W % 2 ? 3 : 2) : (W % 2 ? 1 : 2);
  const s0 = Math.floor((W - sw) / 2);
  for (let u = s0; u < s0 + sw; u++) K.at(u, y0, D, stairs, stair(BACK));
  if (K.extra) {
    for (let u = 0; u < W; u++) if (!postAt.has(u) && (u < s0 || u >= s0 + sw)) K.at(u, y0 + 1, D - 1, rails);
    for (let w = 0; w < D - 1; w++) {
      K.at(0, y0 + 1, w, rails);
      K.at(W - 1, y0 + 1, w, rails);
    }
  }
  // Lanterns at the front corners, out of the way: hung under the roof's corners, or on the rail
  // posts of a flat roof.
  for (const u of [-1, W]) {
    if (variant === 3) K.at(u, y1 + 3, D, K.lantern(), standing);
    else K.at(u, under.get(`${u},${D}`) - 1, D, K.lantern(), hanging);
  }
}

// The highest open spot of each column of an arch, from the bottom of the box.
function archTops(W, H, variant) {
  const tops = [];
  const c = (W - 1) / 2;
  const rise = Math.min(Math.ceil(W / 2), H - 1);
  for (let u = 0; u < W; u++) {
    const d = Math.abs(u - c) / (W / 2);
    let t;
    if (variant === 1) t = H - 1 - rise + Math.round(rise * Math.sqrt(Math.max(0, 1 - d * d)));
    else if (variant === 2) t = H - 1 - Math.round(rise * d * 1.15);
    else t = H - 1;
    tops.push(Math.max(0, Math.min(H - 1, t)));
  }
  return tops;
}

function archwayKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W >= 2 && H >= 3, `needs an opening at least 2 wide and 3 high, this one is ${W} by ${H}`);
  K.need(variant !== 2 || W >= 4, `variant 2 (pointed) needs an opening at least 4 wide (5 looks best), this one is ${W} wide`);
  const edge = K.mat('block');
  const stairs = K.tryForm(edge, 'stairs');
  const key = K.mat('fill') ?? K.full(edge);
  const tops = archTops(W, H, variant);
  const c = (W - 1) / 2;
  const isOpen = (u, y) => u >= 0 && u < W && y >= 0 && y <= tops[u];
  for (let w = 0; w < D; w++) {
    for (let u = -1; u <= W; u++) {
      for (let y = 0; y <= H; y++) {
        if (isOpen(u, y)) K.air(u, y0 + y, w);
        else if (isOpen(u - 1, y) || isOpen(u + 1, y) || isOpen(u, y - 1) || isOpen(u, y + 1)) K.at(u, y0 + y, w, edge);
      }
    }
  }
  // Stairs where the curve steps, so it reads round; at the corners on the flat top.
  if (stairs) {
    for (const w of [0, D - 1]) {
      for (let u = 0; u < W; u++) {
        const next = u < c ? tops[u + 1] : tops[u - 1];
        if (u === c || next === undefined || next <= tops[u]) continue;
        K.at(u, y0 + tops[u], w, stairs, stair(u < c ? LEFT : RIGHT, 'top'));
      }
      if (variant === 3) {
        K.at(0, y1, w, stairs, stair(LEFT, 'top'));
        K.at(W - 1, y1, w, stairs, stair(RIGHT, 'top'));
      }
    }
  }
  const kw = Math.floor(c);
  const ky = y0 + tops[kw] + 1 <= y1 ? y0 + tops[kw] + 1 : y1 + 1;
  for (let w = 0; w < D; w++) {
    K.at(kw, ky, w, key);
    if (W % 2 === 0) K.at(kw + 1, ky, w, key);
  }
}

// Roof and wall details.

function chimneyKit(K) {
  const { H, D, y0, y1, variant, part } = K;
  // width: how wide the stack is across, from the box's left edge; by default at least 2, which
  // reads as a chimney rather than a stick.
  const W = part.width ?? Math.max(K.W, 2);
  K.need(Number.isInteger(W) && W >= 1 && W <= 3 && K.W <= 3 && D <= 3 && H >= 3, `needs a stack at most 3 by 3 (width 1 to 3 across) and at least 3 high, this one is ${sizeText(K)}${part.width === undefined ? '' : `, width ${part.width}`}`);
  K.need(variant === 2 || H >= 5, `variant ${variant} needs at least 5 high (a base 2 high, then the stack), this one is ${H}`);
  const stack = K.mat('block');
  const cap = K.mat('fill') ?? stack;
  const stairs = K.form(stack, 'stairs', 'block');
  // Variant 3 jogs a block to the right part way up.
  const jog = variant === 3 ? y0 + Math.max(3, Math.min(H - 2, Math.round(H * 0.6))) : Infinity;
  const at = (y) => (y >= jog ? 1 : 0);
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      for (let y = y0; y < y1; y++) K.at(u + at(y), y, w, stack);
      K.at(u + at(y1), y1, w, K.full(cap));
    }
  }
  if (variant !== 2) {
    // A base 2 high, a block wider each side and out, stepped in with stairs.
    const inward = (u, w) => (w === D ? BACK : u === -1 ? RIGHT : LEFT);
    for (let u = -1; u <= W; u++) {
      for (let w = 0; w <= D; w++) {
        if (u >= 0 && u < W && w < D) continue;
        K.at(u, y0, w, stack);
        K.at(u, y0 + 1, w, stack);
        K.at(u, y0 + 2, w, stairs, stair(inward(u, w)));
      }
    }
  }
  if (variant === 3) {
    // The jog: a stair on the ledge it leaves and an upside-down stair under the side it gains.
    for (let w = 0; w < D; w++) {
      K.at(0, jog, w, stairs, stair(RIGHT));
      K.at(W, jog - 1, w, stairs, stair(LEFT, 'top'));
    }
  }
  const s = at(y1);
  const top = [];
  for (let u = 0; u < W; u++) for (let w = 0; w < D; w++) top.push([u + s, w]);
  if (K.extra) {
    // Smoke from a campfire in a collar of open trapdoors.
    const fire = K.first('campfire');
    const trapdoor = K.tryForm(K.role('frame', 'spruce_planks'), 'trapdoor') ?? K.fixed('spruce_trapdoor');
    if (fire) for (const [u, w] of top) K.at(u, y1 + 1, w, fire, { facing: OUT });
    for (let u = s; u < W + s; u++) {
      K.at(u, y1 + 1, -1, trapdoor, open(BACK));
      K.at(u, y1 + 1, D, trapdoor, open(OUT));
    }
    for (let w = 0; w < D; w++) {
      K.at(s - 1, y1 + 1, w, trapdoor, open(LEFT));
      K.at(W + s, y1 + 1, w, trapdoor, open(RIGHT));
    }
  } else if (variant === 2) {
    // Pots of two wall blocks.
    const pot = K.tryForm(cap, 'wall') ?? K.tryForm(stack, 'wall');
    if (pot) for (const [u, w] of top) if ((u + w) % 2 === 0) for (const y of [y1 + 1, y1 + 2]) K.at(u, y, w, pot);
  } else {
    const slab = K.tryForm(cap, 'slab') ?? K.tryForm(stack, 'slab');
    if (slab) for (const [u, w] of top) K.at(u, y1 + 1, w, slab, { type: 'bottom' });
  }
}
function crenels(K, length, start = 0) {
  return (u) => {
    const i = u - start;
    if (i === 0 || i === length - 1) return true;
    if (K.variant === 2) return i % 3 !== 2 && !(i === length - 2 && i % 3 === 1 && length % 3 === 1);
    return i % 2 === 0 && i !== length - 2;
  };
}

// One straight run of battlements on a one-thick box, its front toward facing.
function battlementRun(K) {
  const { W, D, y0 } = K;
  const wall = K.mat('block');
  const F = D - 1;
  if (K.extra) {
    const corbel = K.form(wall, 'stairs', 'block');
    const merlon = crenels(K, W + 2, -1);
    for (let u = -1; u <= W; u++) {
      // A full block under the outer corners, where two runs meet.
      if (u === -1 || u === W) K.at(u, y0 - 1, F + 1, wall);
      else K.at(u, y0 - 1, F + 1, corbel, stair(BACK, 'top'));
      K.at(u, y0, F + 1, wall);
      if (merlon(u)) K.at(u, y0 + 1, F + 1, wall);
    }
    return;
  }
  const merlon = crenels(K, W);
  for (let u = 0; u < W; u++) {
    K.at(u, y0, F, wall);
    if (merlon(u)) K.at(u, y0 + 1, F, wall);
  }
}

function battlementsKit(K) {
  const { W, D, H, y0, box: b } = K;
  K.need(H <= 2, `needs a box one layer high (from.dy the layer above the wall top), this one is ${H} high`);
  if (K.variant === 3) {
    K.need(W >= 5 && D >= 5, `variant 3 (round) needs a box at least 5 by 5, this one is ${W} by ${D}`);
    const wall = K.mat('block');
    const cu = (W - 1) / 2;
    const cw = (D - 1) / 2;
    const inside = (u, w) => u >= 0 && u < W && w >= 0 && w < D && ((u - cu) / (W / 2)) ** 2 + ((w - cw) / (D / 2)) ** 2 <= 1;
    const ring = [];
    for (let u = 0; u < W; u++) {
      for (let w = 0; w < D; w++) {
        if (!inside(u, w) || (inside(u + 1, w) && inside(u - 1, w) && inside(u, w + 1) && inside(u, w - 1))) continue;
        ring.push({ u, w, a: Math.atan2(w - cw, u - cu) });
      }
    }
    // Every other block going round, by angle.
    ring.sort((p, q) => p.a - q.a);
    ring.forEach(({ u, w }, i) => {
      K.at(u, y0, w, wall);
      if (i % 2 === 0) K.at(u, y0 + 1, w, wall);
    });
    return;
  }
  if (W === 1 || D === 1) {
    battlementRun(K);
    return;
  }
  const at = (x0, x1, z0, z1, facing) => battlementRun(K.sub({ from: { dx: x0, dy: y0, dz: z0 }, to: { dx: x1, dy: y0, dz: z1 }, facing }));
  at(b.x0, b.x1, b.z1, b.z1, 'south');
  at(b.x0, b.x1, b.z0, b.z0, 'north');
  at(b.x1, b.x1, b.z0, b.z1, 'east');
  at(b.x0, b.x0, b.z0, b.z1, 'west');
}

function buttressKit(K) {
  const { W, H, D, y0, y1, variant, part } = K;
  K.need(H >= 3, `needs a wall strip at least 3 high, this one is ${H}`);
  const F = D - 1;
  const stone = K.mat('block');
  const stairs = K.form(stone, 'stairs', 'block');
  const depth = part.width ?? (H >= 9 ? 3 : H >= 5 ? 2 : 1);
  K.need(Number.isInteger(depth) && depth >= 1 && depth <= 4, `width is how far it stands out, 1 to 4; it is ${depth}`);
  for (let k = 1; k <= depth; k++) {
    const top = y1 - 1 - Math.floor(((k - 1) * (H - 1)) / depth);
    for (let u = 0; u < W; u++) {
      for (let y = y0; y <= top; y++) K.at(u, y, F + k, stone);
      K.at(u, top + 1, F + k, stairs, stair(BACK));
    }
  }
  if (variant === 2) {
    const base = K.mat('fill') ?? stone;
    const baseStairs = K.tryForm(base, 'stairs') ?? stairs;
    for (let u = -1; u <= W; u++) {
      for (let w = F + 1; w <= F + depth + 1; w++) {
        const edge = u === -1 || u === W || w === F + depth + 1;
        if (!edge) {
          K.at(u, y0, w, base);
          continue;
        }
        K.at(u, y0, w, base);
        K.at(u, y0 + 1, w, baseStairs, stair(w === F + depth + 1 ? BACK : u === -1 ? RIGHT : LEFT));
      }
    }
  }
}

function balconyKit(K) {
  const { W, D, y0, variant, part } = K;
  K.need(W >= 2 && D >= 1, `needs a floor at least 2 wide and 1 deep, this one is ${sizeText(K)}`);
  const floor = K.mat('block');
  const rails = K.mat('fill') ?? floor;
  const corbel = K.form(floor, 'stairs', 'block');
  const every = part.every ?? 3;
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      if (variant === 1) K.at(u, y0, w, K.form(floor, 'slab', 'block'), { type: 'top' });
      else K.at(u, y0, w, K.planks(floor));
    }
  }
  for (const u of spread(W, every)) {
    K.at(u, y0 - 1, 0, corbel, stair(BACK, 'top'));
    if (D >= 2) {
      K.at(u, y0 - 1, 1, corbel, stair(BACK, 'top'));
      K.at(u, y0 - 2, 0, corbel, stair(BACK, 'top'));
    }
  }
  const edges = [];
  for (let u = 0; u < W; u++) edges.push([u, D - 1, 'front']);
  for (let w = 0; w < D - 1; w++) edges.push([0, w, 'left'], [W - 1, w, 'right']);
  if (variant === 1 || variant === 3) {
    const r = variant === 1 ? K.rail(rails, part.fill ? 'fill' : 'block') : K.tryForm(rails, 'wall') ?? K.rail(rails, part.fill ? 'fill' : 'block');
    for (const [u, w] of edges) K.at(u, y0 + 1, w, r);
    if (K.extra) {
      K.at(0, y0 + 2, D - 1, K.lantern(), standing);
      K.at(W - 1, y0 + 2, D - 1, K.lantern(), standing);
    }
  } else {
    const trapdoor = K.form(rails, 'trapdoor', part.fill ? 'fill' : 'block');
    const post = K.rail(rails, part.fill ? 'fill' : 'block');
    for (const [u, w, side] of edges) {
      const corner = w === D - 1 && (u === 0 || u === W - 1);
      if (corner) K.at(u, y0 + 1, w, post);
      else K.at(u, y0 + 1, w, trapdoor, open(side === 'front' ? BACK : side === 'left' ? RIGHT : LEFT));
    }
    if (K.extra) {
      K.at(0, y0 + 2, D - 1, K.lantern(), standing);
      K.at(W - 1, y0 + 2, D - 1, K.lantern(), standing);
    }
  }
}

function eaveBracketsKit(K) {
  const { W, D, y1, variant, part } = K;
  const F = D - 1;
  const wood = K.mat('block');
  const stairs = K.form(wood, 'stairs', 'block');
  const spots = spread(W, part.every ?? 2);
  for (const u of spots) {
    if (variant === 3) {
      const beam = K.mat('fill') ?? K.tryForm(wood, 'log') ?? K.full(wood);
      K.at(u, y1, F + 1, beam, along('z'));
      K.at(u, y1 - 1, F + 1, stairs, stair(BACK, 'top'));
    } else K.at(u, y1, F + 1, stairs, stair(BACK, 'top'));
  }
  if (variant === 2) {
    for (let i = 0; i + 1 < spots.length; i += 2) {
      const gap = spots[i + 1] - spots[i];
      if (gap >= 2) K.at(spots[i] + Math.floor(gap / 2), y1, F + 1, K.lantern(), hanging);
    }
  }
}

// A front layer for a wall: posts of stone and fence, planter boxes between, lanterns at the
// corners. The box is the layer one block out from the wall, facing out.
function facadeKit(K) {
  const { W, H, y0, y1, variant, part } = K;
  K.need(K.D === 1 && W >= 3 && H >= 4, `needs the layer one block out from a wall: one deep, at least 3 wide and 4 high (from.dy the ground, to.dy the eave), this one is ${sizeText(K)}`);
  const every = part.every ?? 2;
  const gap = part.width ?? 0;
  K.need(Number.isInteger(every) && every >= 2, `every is the post spacing, 2 or more; it is ${every}`);
  K.need(Number.isInteger(gap) && gap >= 0 && gap <= 3 && gap <= W - 2, `width is the door gap, 0 to 3 and narrower than the box; it is ${gap}`);
  const stone = K.mat('block');
  const wall = K.tryForm(stone, 'wall') ?? K.full(stone);
  const wood = K.mat('fill', K.palette.frame ? '@frame' : 'spruce_planks');
  const fence = K.tryForm(wood, 'fence') ?? K.fixed('spruce_fence');
  const trapdoor = K.tryForm(wood, 'trapdoor') ?? K.fixed('spruce_trapdoor');
  const soil = K.first('grass_block') ?? K.fixed('dirt');
  const g0 = Math.floor((W - gap) / 2);
  const inGap = (u) => gap > 0 && u >= g0 && u < g0 + gap;
  let postAt = new Set(spread(W, every).filter((u) => !inGap(u)));
  if (gap > 0) {
    postAt = new Set([...postAt].filter((u) => Math.abs(u - (g0 - 1)) !== 1 && Math.abs(u - (g0 + gap)) !== 1));
    postAt.add(g0 - 1);
    postAt.add(g0 + gap);
  }
  for (let u = 0; u < W; u++) {
    if (inGap(u)) continue;
    if (postAt.has(u)) {
      for (let y = y0; y <= y1; y++) K.at(u, y, 0, (y - y0) % 3 === 0 ? wall : fence);
      continue;
    }
    K.at(u, y0, 0, soil);
    K.at(u, y0, 1, trapdoor, open(OUT));
    const r = spot(u, 0, 0, 41);
    const plant = variant === 2 ? K.first('azalea_leaves', 'oak_leaves') : K.fixed(r < 0.3 ? 'allium' : FLOWERS[Math.floor(spot(u, 1, 0, 43) * FLOWERS.length)]);
    if (plant) K.at(u, y0 + 1, 0, plant);
  }
  for (const u of [0, W - 1]) {
    K.at(u, y1 - 1, 1, fence);
    K.at(u, y1 - 2, 1, K.lantern(), hanging);
  }
}

// Cloth for awnings and stalls, one stripe per entry of the field: a carpet, and a dyed block
// for the edge that hangs down.
function clothOf(K, entries, field) {
  return carpetOf(K, entries, field).map((c, i) => {
    const e = entries[i];
    const dye = c.name.replace(/_carpet$/, '');
    const name = !/_carpet$/.test(e.name) ? e.name : /moss$/.test(dye) ? `${dye}_block` : `${dye}_wool`;
    return { carpet: [c], edge: [{ ...e, name, props: {}, text: undefined }] };
  });
}

// Lays cloth with its top at y: a carpet on a thin trapdoor (plate), on a block of its colour
// (edge), on a beam of the wood (beam), or on whatever is already under it (over).
function cloth(K, wood) {
  const support = K.tryForm(wood, 'trapdoor') ?? K.fixed('spruce_trapdoor');
  const beam = K.tryForm(wood, 'log') ?? K.full(wood);
  return {
    plate(u, y, w, s) {
      K.at(u, y - 1, w, support, { facing: OUT, half: 'top', open: 'false' });
      K.at(u, y, w, s.carpet);
    },
    edge(u, y, w, s) {
      K.at(u, y - 1, w, s.edge);
      K.at(u, y, w, s.carpet);
    },
    beam(u, y, w, s) {
      K.at(u, y - 1, w, beam, along('x'));
      K.at(u, y, w, s.carpet);
    },
    over(u, y, w, s) {
      K.at(u, y, w, s.carpet);
    }
  };
}

function awningKit(K) {
  const { W, D, y1, variant, part } = K;
  const F = D - 1;
  const depth = part.width ?? 2;
  K.need(Number.isInteger(depth) && depth >= 1 && depth <= 3, `width is how far it reaches out, 1 to 3; it is ${depth}`);
  if (variant === 1) {
    const stripes = [clothOf(K, K.mat('block'), 'block')[0], clothOf(K, K.mat('fill', 'white_wool'), 'fill')[0]];
    const c = cloth(K, K.role('trim', 'spruce_planks'));
    for (let u = -1; u <= W; u++) {
      const s = stripes[(u + 1) % 2];
      for (let k = 1; k < depth; k++) c.plate(u, y1 + 2, F + k, s);
      c.edge(u, y1 + 2, F + depth, s);
    }
  } else if (variant === 2) {
    const trapdoor = K.form(K.mat('block'), 'trapdoor', 'block');
    for (let u = -1; u <= W; u++) for (let k = 1; k <= depth; k++) K.at(u, y1 + 1, F + k, trapdoor, { facing: OUT, half: 'top', open: 'false' });
  } else {
    const wood = K.mat('block');
    const stairs = K.form(wood, 'stairs', 'block');
    const slab = K.form(wood, 'slab', 'block');
    for (let u = -1; u <= W; u++) {
      K.at(u, y1 + 1, F + 1, stairs, stair(BACK));
      for (let k = 2; k <= depth; k++) K.at(u, y1 + 1, F + k, slab, { type: 'bottom' });
    }
  }
}

// Ground and outside.

function pathKit(K) {
  const { part, variant } = K;
  const { from, to } = part;
  const width = part.width ?? 3;
  K.need(Number.isInteger(width) && width >= 1 && width <= 7, `width is ${width}, a path is 1 to 7 wide`);
  const surface = K.mat('block');
  const edging = K.mat('fill');
  // Calm: mostly the heaviest block of the mix, the rest (or a block of the same tone) only here
  // and there.
  const byWeight = [...surface].sort((a, b) => b.w - a.w);
  const main = [byWeight[0]];
  const others = byWeight.slice(1);
  const accent = (others.length ? others : null) ?? K.first(...(TONE[main[0].name] ?? [])) ?? main;
  const [ax, az, bx, bz] = [from.dx, from.dz, to.dx, to.dz];
  const len = Math.hypot(bx - ax, bz - az);
  const [dx, dz] = len ? [(bx - ax) / len, (bz - az) / len] : [1, 0];
  const hw = (width - 1) / 2;
  const shift = width % 2 ? 0 : 0.5;
  // Everything below goes by the distance along the path (s) and the side, so a turned path is
  // the same. A slow sideways drift:
  const knots = [];
  for (let i = 0; i <= Math.ceil(len / 6) + 1; i++) knots.push(variant === 1 && i > 0 ? Math.round((spot(i, 0, 0, 11) * 2 - 1) * 6) / 10 : 0);
  const drift = (s) => {
    const t = Math.max(0, s) / 6;
    const i = Math.floor(t);
    const f = t - i;
    const g = f * f * (3 - 2 * f);
    return knots[i] * (1 - g) + (knots[i + 1] ?? 0) * g;
  };
  // A ragged edge: each side steps out a block and back in, in stretches 2 to 4 long.
  const ragged = variant === 1 && width >= 3;
  const steps = [1, -1].map((sign) => {
    const out = [];
    let at = 0;
    let d = spot(0, sign, 0, 23) < 0.5 ? 1 : 0;
    while (at <= len + 1) {
      const n = 2 + Math.floor(spot(out.length, sign, 0, 21) * 3);
      out.push({ end: at + n, d });
      at += n;
      d = 1 - d;
    }
    return out;
  });
  const stepOut = (sign, s) => (ragged ? (steps[sign > 0 ? 0 : 1].find((st) => Math.round(s) < st.end) ?? { d: 0 }).d : 0);
  // Stones and bushes along the edges every 3 to 5 blocks, on alternate sides mostly.
  const extras = new Map();
  if (variant === 1) {
    for (let at = 1 + Math.floor(spot(0, 0, 0, 31) * 3), i = 0; at <= len; at += 3 + Math.floor(spot(i, 0, 0, 33) * 3), i++) {
      extras.set(at, { sign: (i + (spot(i, 0, 0, 35) < 0.25 ? 1 : 0)) % 2 ? 1 : -1, bush: spot(i, 0, 0, 37) < 0.4, slab: spot(i, 0, 0, 39) < 0.5 });
    }
  }
  const stone = edging ?? K.fixed('60%cobblestone,40%mossy_cobblestone');
  const stoneSlab = K.tryForm(stone, 'slab');
  const bush = K.first('azalea_leaves', 'oak_leaves');
  const pad = Math.ceil(hw) + 4;
  const b = K.box;
  for (let x = b.x0 - pad; x <= b.x1 + pad; x++) {
    for (let z = b.z0 - pad; z <= b.z1 + pad; z++) {
      const rx = x - ax;
      const rz = z - az;
      const s = rx * dx + rz * dz;
      if (s < -0.5 || s > len + 0.5) continue;
      const side = rx * -dz + rz * dx;
      const t = len ? Math.min(1, Math.max(0, s / len)) : 0;
      const y = Math.round(from.dy + (to.dy - from.dy) * t);
      const rel = side - drift(s) - shift;
      const off = Math.abs(rel);
      const n = spot(Math.round(s), 0, Math.round(side * 2), 5);
      if (variant === 3) {
        if (off <= hw + 0.5 && Math.round(s) % 2 === 0 && n > 0.15) K.plan(x, y, z, surface);
        continue;
      }
      // Half a block of slack, so a path at an angle has no gaps.
      const sign = rel >= 0 ? 1 : -1;
      const limit = hw + 0.5 + stepOut(sign, s);
      if (variant === 2) {
        if (off <= limit) K.plan(x, y, z, surface);
        else if (edging && off <= limit + 1) K.plan(x, y, z, edging);
        continue;
      }
      if (off <= limit) {
        K.plan(x, y, z, spot(Math.round(s), 1, Math.round(side * 2), 7) < 0.18 ? oneOf(accent, spot(Math.round(s), 2, Math.round(side * 2), 9)) : main);
        continue;
      }
      const e = extras.get(Math.round(s));
      if (!e || e.sign !== sign || off > limit + 1) continue;
      if (e.bush && bush) K.plan(x, y + 1, z, bush);
      else if (e.slab && stoneSlab) K.plan(x, y + 1, z, oneOf(stoneSlab, spot(Math.round(s), 3, 0, 45)), { type: 'bottom' });
      else K.plan(x, y + 1, z, oneOf(K.full(stone), spot(Math.round(s), 3, 0, 45)));
    }
  }
}
// The stone a wooden post stands on: the fill when it is not wood, else the foundation role, else
// stone bricks.
function footOf(K, field = 'fill') {
  const given = field && K.mat(field);
  if (given && !given.some((e) => WOOD.test(e.name))) return K.full(given);
  return K.role('foundation', 'stone_bricks');
}

function lampPostKit(K) {
  const { y0, part, variant } = K;
  const H = part.to.dy === part.from.dy ? 5 : K.H;
  K.need(H >= 4, `needs at least 4 high, from.dy the foot and to.dy the arms; this one is ${H}`);
  const y1 = y0 + H - 1;
  const block = K.mat('block');
  const post = K.rail(block, 'block');
  // Arms, cap and bracket are wood: the post's own when it is a fence, else the frame role's.
  const woodOf = post.some((e) => /_fence$/.test(e.name)) ? block : K.role('frame', 'spruce_planks');
  const arm = K.tryForm(woodOf, 'fence') ?? K.fixed('spruce_fence');
  const cap = K.tryForm(woodOf, 'trapdoor') ?? K.fixed('spruce_trapdoor');
  const light = K.lantern();
  const stone = footOf(K);
  let y = y0;
  if (K.extra) {
    // A barrel with four slabs round it on the ground.
    K.at(0, y0, 0, K.first('barrel') ?? stone);
    const slab = K.tryForm(stone, 'slab');
    if (slab) for (const [u, w] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) K.at(u, y0, w, slab, { type: 'bottom' });
    y = y0 + 1;
  } else {
    K.at(0, y0, 0, stone);
    K.at(0, y0 + 1, 0, K.tryForm(stone, 'wall') ?? stone);
    y = y0 + 2;
  }
  for (; y <= y1; y++) K.at(0, y, 0, post);
  const closed = { facing: OUT, half: 'bottom', open: 'false' };
  K.at(0, y1 + 1, 0, cap, closed);
  if (variant === 2) {
    // One long arm of two fences, a trapdoor bracket at its end and a lantern on a chain.
    const chain = K.first('iron_chain', 'chain');
    for (const w of [1, 2]) {
      K.at(0, y1, w, arm);
      K.at(0, y1 + 1, w, cap, closed);
    }
    K.at(0, y1, 3, cap, open(OUT));
    if (chain) K.at(0, y1 - 1, 2, chain, { axis: 'y' });
    K.at(0, y1 - (chain ? 2 : 1), 2, light, hanging);
    return;
  }
  const arms = variant === 1 ? [[-1, 0], [1, 0], [0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  for (const [u, w] of arms) {
    K.at(u, y1, w, arm);
    K.at(u, y1 - 1, w, light, hanging);
    K.at(u, y1 + 1, w, cap, closed);
  }
}

// One straight run of fence on a one-thick box: posts at the ends and about every apart, a gate
// width wide in the middle when gate is true.
function fenceRun(K, gate) {
  const { W, y0, variant, part } = K;
  const rail = K.rail(K.mat('block'), 'block');
  const posts = K.mat('fill');
  const every = part.every ?? 4;
  const width = part.width ?? 0;
  K.need(Number.isInteger(width) && width >= 0 && width <= 2, `width is the gate's width, 0 to 2; it is ${width}`);
  const g0 = Math.floor((W - width) / 2);
  const inGate = (u) => gate && width > 0 && u >= g0 && u < g0 + width;
  let spots = new Set(spread(W, every));
  if (gate && width > 0) {
    spots = new Set([...spots].filter((u) => u === 0 || u === W - 1 || u < g0 - 2 || u > g0 + width + 1));
    spots.add(g0 - 1);
    spots.add(g0 + width);
  }
  for (let u = 0; u < W; u++) {
    if (inGate(u)) {
      const gateBlock = K.tryForm(K.mat('block'), 'fence_gate') ?? (posts && K.tryForm(posts, 'fence_gate'));
      K.need(gateBlock, `needs a fence gate of block or fill for its gate; give a wood, or leave width out`);
      K.at(u, y0, 0, gateBlock, { facing: OUT });
      continue;
    }
    const isPost = spots.has(u);
    if (isPost && posts) {
      // Tall posts stand on a stone foot.
      K.at(u, y0, 0, variant === 2 ? footOf(K) : posts, along('y'));
      if (variant === 2) K.at(u, y0 + 1, 0, posts, along('y'));
    } else K.at(u, y0, 0, rail);
    if (isPost && K.extra) K.at(u, y0 + (posts && variant === 2 ? 2 : 1), 0, K.lantern(), standing);
  }
}

function fenceRunKit(K) {
  const { W, D, y0, box: b, facing } = K;
  K.need(K.H === 1, `needs a box one layer high, this one is ${K.H} high`);
  if (W === 1 || D === 1) {
    if (D > 1) {
      // A run along w: lay it as a run facing across it.
      const side = { south: 'east', north: 'west', east: 'north', west: 'south' }[facing];
      fenceRun(K.sub({ facing: side }), true);
    } else fenceRun(K, true);
    return;
  }
  const run = (x0, x1, z0, z1, side) => fenceRun(K.sub({ from: { dx: x0, dy: y0, dz: z0 }, to: { dx: x1, dy: y0, dz: z1 }, facing: side }), side === facing);
  run(b.x0, b.x1, b.z1, b.z1, 'south');
  run(b.x0, b.x1, b.z0, b.z0, 'north');
  run(b.x1, b.x1, b.z0, b.z1, 'east');
  run(b.x0, b.x0, b.z0, b.z1, 'west');
}

function planterKit(K) {
  const { W, D, y0, variant, part } = K;
  K.need(K.H === 1, `needs a box one layer high (the soil), this one is ${K.H} high`);
  const edge = K.mat('block');
  const plants = K.mat('fill');
  const soil = K.fixed('dirt');
  const plant = (u, w) => {
    const r = spot(u, 0, w, 3);
    if (r > 0.8) return;
    const picks = plants ?? K.fixed(r < 0.22 ? 'azalea_leaves' : FLOWERS[Math.floor(spot(u, 1, w, 9) * FLOWERS.length)]);
    K.at(u, y0 + 1, w, picks);
  };
  if (variant === 1) {
    const trapdoor = K.form(edge, 'trapdoor', 'block');
    for (let u = 0; u < W; u++) {
      for (let w = 0; w < D; w++) {
        K.at(u, y0, w, soil);
        plant(u, w);
      }
      K.at(u, y0, -1, trapdoor, open(BACK));
      K.at(u, y0, D, trapdoor, open(OUT));
    }
    for (let w = 0; w < D; w++) {
      K.at(-1, y0, w, trapdoor, open(LEFT));
      K.at(W, y0, w, trapdoor, open(RIGHT));
    }
    return;
  }
  K.need(W >= 3 && D >= 3, `variant ${variant} needs a bed at least 3 by 3 (its edge is inside the box), this one is ${W} by ${D}`);
  const stairs = variant === 2 ? K.form(edge, 'stairs', 'block') : null;
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      const rim = u === 0 || u === W - 1 || w === 0 || w === D - 1;
      if (!rim) {
        K.at(u, y0, w, soil);
        plant(u, w);
      } else if (variant === 2) {
        const facing = w === 0 ? BACK : w === D - 1 ? OUT : u === 0 ? LEFT : RIGHT;
        K.at(u, y0, w, stairs, stair(facing, 'top'));
      } else K.at(u, y0, w, edge);
    }
  }
}

function wellKit(K) {
  const { W, D, H, y0, y1, variant } = K;
  K.need(W >= 3 && D >= 3 && W <= 7 && D <= 7, `needs a footprint 3 to 7 on each side (4 by 4 rings a 2 by 2 middle), this one is ${W} by ${D}`);
  const stone = K.mat('block');
  const wood = K.mat('fill', K.palette.frame ? '@frame' : 'spruce_planks');
  const rimStairs = K.tryForm(stone, 'stairs');
  // A ring 2 high, its top a rim of stairs; full blocks at the corners for the posts.
  const corner = (u, w) => (u === 0 || u === W - 1) && (w === 0 || w === D - 1);
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      if (!(u === 0 || u === W - 1 || w === 0 || w === D - 1)) continue;
      K.at(u, y0, w, stone);
      const outward = w === 0 ? BACK : w === D - 1 ? OUT : u === 0 ? LEFT : RIGHT;
      if (corner(u, w) || !rimStairs) K.at(u, y0 + 1, w, K.full(stone));
      else K.at(u, y0 + 1, w, rimStairs, stair(outward));
    }
  }
  if (variant === 2) return;
  const eave = y1 - 2;
  K.need(eave >= y0 + 3, `variant 1 needs at least 6 high for the ring, posts and roof, this one is ${H}`);
  const fence = K.rail(wood, 'fill');
  const planks = K.tryForm(wood, 'planks') ?? K.full(wood);
  const stairs = K.form(planks, 'stairs', 'fill');
  // Corner posts: a wall block of the stone under fences.
  for (const u of [0, W - 1]) {
    for (const w of [0, D - 1]) {
      K.at(u, y0 + 2, w, K.tryForm(stone, 'wall') ?? K.full(stone));
      for (let y = y0 + 3; y <= eave; y++) K.at(u, y, w, fence);
    }
  }
  // A low gable: stairs along the eaves, a layer of planks, a ridge of slabs, running front to back.
  const mid = (W - 1) / 2;
  const slab = K.tryForm(planks, 'slab');
  for (let u = -1; u <= W; u++) {
    for (let w = -1; w <= D; w++) {
      if (u === -1 || u === W) K.at(u, eave, w, stairs, stair(u < mid ? RIGHT : LEFT));
      else K.at(u, eave + 1, w, planks);
      if (slab && Math.abs(u - mid) < 1) K.at(u, eave + 2, w, slab, { type: 'bottom' });
    }
  }
  // A chain down the middle.
  const chain = K.first('iron_chain', 'chain');
  const cu = Math.floor(mid);
  const cw = Math.floor((D - 1) / 2);
  if (chain) for (let y = eave; y >= Math.max(y0 + 2, eave - 2); y--) K.at(cu, y, cw, chain, { axis: 'y' });
}
function benchKit(K) {
  const { W, y0, variant, part } = K;
  K.need(K.D === 1, `needs a seat line one block deep, this one is ${K.D} deep`);
  const wood = K.mat('block');
  const stairs = K.form(wood, 'stairs', 'block');
  const arms = K.form(K.mat('fill') ?? wood, 'trapdoor', part.fill ? 'fill' : 'block');
  for (let u = 0; u < W; u++) {
    K.at(u, y0, 0, stairs, stair(BACK));
    if (variant === 2) K.at(u, y0 + 1, 0, arms, open(OUT));
  }
  K.at(-1, y0, 0, arms, open(LEFT));
  K.at(W, y0, 0, arms, open(RIGHT));
}

function marketStallKit(K) {
  const { W, D, H, y0, variant } = K;
  K.need(W >= 3 && D >= 2 && H >= 3, `needs a footprint at least 3 by 2 and 3 high (a stone foot, posts, to.dy the post tops), this one is ${sizeText(K)}`);
  // Small and low: the canopy never stands higher than the stall's longer side.
  const top = Math.min(K.y1, y0 + Math.max(W, D, 4) - 2);
  const wood = K.mat('block');
  const fence = K.rail(wood, 'block');
  const slab = K.tryForm(wood, 'slab') ?? K.full(wood);
  const stripes = clothOf(K, K.mat('fill', 'red_wool,white_wool'), 'fill');
  const foot = footOf(K, null);
  const posts = [[0, D - 1], [W - 1, D - 1], ...(variant !== 3 ? [[0, 0], [W - 1, 0]] : [])];
  for (const [u, w] of posts) {
    K.at(u, y0, w, foot);
    for (let y = y0 + 1; y <= top; y++) K.at(u, y, w, fence);
  }
  // A counter of slabs on barrels along the front.
  const barrel = K.first('barrel') ?? K.full(wood);
  for (let u = 1; u < W - 1; u++) {
    K.at(u, y0, D - 1, barrel);
    K.at(u, y0 + 1, D - 1, slab, { type: 'bottom' });
  }
  // A wool canopy in stripes; peaked lifts the middle row, a lean-to the back row.
  const raised = (w) => (variant === 2 ? Math.abs(w - (D - 1) / 2) < 1 : variant === 3 && w === 0);
  for (let u = 0; u < W; u++) {
    const s = stripes[u % stripes.length];
    for (let w = 0; w < D; w++) {
      K.at(u, top + 1, w, s.edge);
      if (raised(w)) K.at(u, top + 2, w, s.edge);
    }
  }
  // Banners hang round the canopy's edge.
  const banner = (i) => {
    const dye = stripes[i % stripes.length].carpet[0].name.replace(/_carpet$/, '');
    return K.first(`${dye}_wall_banner`);
  };
  const hang = (u, w, i, facing) => {
    const b = banner(i);
    if (b) K.at(u, top + 1, w, b, { facing });
  };
  for (let u = 0; u < W; u++) {
    hang(u, D, u, OUT);
    if (variant !== 3) hang(u, -1, u, BACK);
  }
  for (let w = 0; w < D; w++) {
    hang(-1, w, w, LEFT);
    hang(W, w, w, RIGHT);
  }
}
function treeKit(K) {
  const { W, D, H, y0, y1, variant } = K;
  K.need(W >= 3 && D >= 3 && H >= 4, `needs a box at least 3 by 3 and 4 high (the whole tree), this one is ${sizeText(K)}`);
  const logs = K.mat('block', 'oak_log');
  const wood = WOOD.exec(logs[0].name)?.[1];
  const leafName = wood === 'crimson' ? 'nether_wart_block' : wood === 'warped' ? 'warped_wart_block' : `${wood ?? 'oak'}_leaves`;
  const leaves = K.mat('fill') ?? K.fixed(K.known(leafName) ? leafName : 'oak_leaves');
  const cu = Math.floor((W - 1) / 2);
  const cw = Math.floor((D - 1) / 2);
  const inBox = (u, y, w) => u >= 0 && u < W && w >= 0 && w < D && y >= y0 && y <= y1;
  const leaf = (u, y, w) => inBox(u, y, w) && K.at(u, y, w, leaves);
  const log = (u, y, w, axis = 'y') => inBox(u, y, w) && K.at(u, y, w, logs, along(axis));
  if (variant === 1) {
    const trunkTop = y1 - Math.max(1, Math.floor(H / 4));
    const c0 = y0 + Math.max(1, Math.floor(H * 0.35));
    const cy = (c0 + y1) / 2;
    const [rx, ry, rz] = [W / 2, (y1 - c0 + 1) / 2, D / 2];
    for (let u = 0; u < W; u++) {
      for (let w = 0; w < D; w++) {
        for (let y = c0; y <= y1; y++) {
          const v = ((u - (W - 1) / 2) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((w - (D - 1) / 2) / rz) ** 2;
          if (v > 1 || (v > 0.55 && spot(u, y, w, 1) < 0.4)) continue;
          leaf(u, y, w);
        }
      }
    }
    for (let y = y0; y <= trunkTop; y++) log(cu, y, cw);
    if (W >= 5) {
      log(cu - 1, c0, cw, 'x');
      log(cu + 1, c0 + 1, cw, 'x');
    }
    if (D >= 5) log(cu, c0 + 1, cw + 1, 'z');
  } else if (variant === 2) {
    const R = Math.floor((Math.min(W, D) - 1) / 2);
    const l0 = y0 + Math.max(1, Math.floor(H / 5));
    for (let y = y1; y >= l0; y--) {
      // From the top: 0, 1, 1, 2, 1, 2, 1... a wider ring every other layer, like a spruce.
      const i = y1 - y;
      const grow = Math.min(R, Math.floor((i + 1) / 2));
      const r = i === 0 ? 0 : i % 2 === 1 ? grow : Math.max(1, grow - 1);
      for (let du = -r; du <= r; du++) {
        for (let dw = -r; dw <= r; dw++) {
          const d = du * du + dw * dw;
          if (d > r * r + r * 0.6) continue;
          if (r > 1 && d >= r * r && spot(cu + du, y, cw + dw, 2) < 0.35) continue;
          leaf(cu + du, y, cw + dw);
        }
      }
    }
    for (let y = y0; y < y1; y++) log(cu, y, cw);
  } else {
    const split = y0 + Math.max(1, Math.floor(H / 3));
    for (let y = y0; y <= split; y++) log(cu, y, cw);
    const reachU = Math.max(1, Math.floor((W - 1) / 2) - 1);
    const ends = [];
    for (const dir of [-1, 1]) {
      let u = cu;
      let y = split;
      for (let k = 0; k < reachU; k++) {
        u += dir;
        y += 1;
        log(u, y, cw);
      }
      ends.push([u, y]);
    }
    log(cu, split + 1, cw);
    const top = y1;
    const R = Math.max(2, Math.floor(Math.min(W, D * 2) / 3));
    for (const [eu, ey] of ends) {
      for (let y = Math.min(ey + 1, top - 1); y <= top; y++) {
        const r = y === top ? R - 1 : R;
        for (let du = -r; du <= r; du++) {
          for (let dw = -r; dw <= r; dw++) {
            const d = du * du + dw * dw;
            if (d > r * r + 0.5 || (d >= r * r - 1 && spot(eu + du, y, cw + dw, 4) < 0.3)) continue;
            leaf(eu + du, y, cw + dw);
          }
        }
      }
      for (let y = ey; y < Math.min(ey + 1, top - 1); y++) log(eu, y, cw);
    }
  }
}

// Interior. Box: against a wall at its back, facing into the room.

function fireplaceKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W >= 3 && H >= 3 && D <= 2, `needs a front at least 3 wide and 3 high and 1 or 2 deep, this one is ${sizeText(K)}`);
  const brick = K.mat('block');
  const hearth = K.mat('fill') ?? K.full(brick);
  const mantel = K.form(brick, 'stairs', 'block');
  const oh = H >= 4 ? 2 : 1;
  const F = D - 1;
  const opening = (u, y) => u >= 1 && u <= W - 2 && y >= y0 && y < y0 + oh;
  const narrow = variant === 2 && W >= 5;
  for (let u = 0; u < W; u++) {
    for (let y = y0; y <= y1; y++) {
      const hood = narrow && y > y0 + oh && (u === 0 || u === W - 1);
      for (let w = 0; w < D; w++) {
        if (opening(u, y)) {
          if (w > 0) K.air(u, y, w);
          continue;
        }
        if (hood) continue;
        K.at(u, y, w, brick);
      }
    }
  }
  const fire = K.first('campfire');
  const cu = Math.floor((W - 1) / 2);
  for (let u = 1; u <= W - 2; u++) {
    if (fire && (u === cu || (W % 2 === 0 && u === cu + 1))) K.at(u, y0, 0, fire, { facing: OUT });
    else K.air(u, y0, 0);
    for (let y = y0 + 1; y < y0 + oh; y++) K.air(u, y, 0);
    K.at(u, y0 - 1, F + 1, hearth);
  }
  const my = y0 + oh;
  for (let u = narrow ? 0 : -1; u <= (narrow ? W - 1 : W); u++) K.at(u, my, F + 1, mantel, stair(BACK, 'top'));
  if (narrow) {
    for (let y = my + 1; y <= y1; y++) {
      K.at(0, y, F, mantel, stair(RIGHT));
      K.at(W - 1, y, F, mantel, stair(LEFT));
      if (y > my + 1) break;
    }
  }
  const candle = K.first('candle');
  if (candle) {
    K.at(narrow ? 0 : -1, my + 1, F + 1, candle);
    K.at(narrow ? W - 1 : W, my + 1, F + 1, candle);
  }
}

function tableKit(K) {
  const { W, D, y0, variant, part } = K;
  K.need(W <= 4 && D <= 3, `needs a table at most 4 by 3, this one is ${W} by ${D}`);
  const chairs = K.form(K.mat('block'), 'stairs', 'block');
  const top = K.mat('fill') ?? K.mat('block');
  const field = part.fill ? 'fill' : 'block';
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      if (variant === 1) {
        K.at(u, y0, w, K.rail(top, field));
        K.at(u, y0 + 1, w, K.form(top, 'pressure_plate', field));
      } else if (variant === 2) K.at(u, y0, w, K.form(top, 'slab', field), { type: 'top' });
      else {
        const s = K.form(top, 'stairs', field);
        if (W >= D) K.at(u, y0, w, s, stair(u < W / 2 ? LEFT : RIGHT, 'top'));
        else K.at(u, y0, w, s, stair(w < D / 2 ? BACK : OUT, 'top'));
      }
    }
    K.at(u, y0, -1, chairs, stair(BACK));
    K.at(u, y0, D, chairs, stair(OUT));
  }
  if (K.extra) {
    for (let w = 0; w < D; w++) {
      K.at(-1, y0, w, chairs, stair(LEFT));
      K.at(W, y0, w, chairs, stair(RIGHT));
    }
  }
  if (variant !== 1) K.at(Math.floor((W - 1) / 2), y0 + 1, Math.floor((D - 1) / 2), K.lantern(), standing);
}

// A bed block from a bed name or a dyed block's colour.
function bedOf(K, entries, field) {
  const name = entries[0].name;
  if (/_bed$/.test(name)) return [{ ...entries[0], props: {}, text: undefined }];
  const dye = DYE.exec(name)?.[1];
  K.need(dye, `${field} is the bed: a bed like red_bed or a dyed block like red_wool, not ${name}`);
  return [{ name: `${dye}_bed`, props: {}, w: 1 }];
}

function bedNookKit(K) {
  const { W, D, y0, variant, part } = K;
  K.need(D === 2, `needs a box 2 deep (the bed's length, its head at the back), this one is ${D} deep`);
  const wood = K.mat('block');
  const bed = bedOf(K, K.mat('fill', 'red_bed'), 'fill');
  const lamp = K.lantern();
  const table = (u) => {
    const barrel = K.first('barrel');
    if (barrel) K.at(u, y0, 0, barrel, { facing: OUT });
    else K.at(u, y0, 0, K.form(wood, 'slab', 'block'), { type: 'top' });
    K.at(u, y0 + 1, 0, lamp, standing);
  };
  if (variant === 1) {
    K.need(W >= 2, `variant 1 needs at least 2 wide (a bed and a side table), this one is ${W}`);
    const bu = W >= 3 ? 1 : 0;
    K.at(bu, y0, 1, bed, { facing: BACK });
    table(bu + 1);
    if (W >= 3) table(0);
  } else if (variant === 2) {
    K.need(W >= 4, `variant 2 (double bed) needs at least 4 wide, this one is ${W}`);
    const bu = Math.floor((W - 2) / 2);
    K.at(bu, y0, 1, bed, { facing: BACK });
    K.at(bu + 1, y0, 1, bed, { facing: BACK });
    table(bu - 1);
    table(bu + 2);
  } else {
    K.need(W >= 3, `variant 3 (canopy) needs at least 3 wide, this one is ${W}`);
    const fence = K.rail(wood, 'block');
    const canopy = K.form(wood, 'trapdoor', 'block');
    K.at(1, y0, 1, bed, { facing: BACK });
    for (const u of [0, 2]) for (const w of [0, 1]) for (let y = y0; y <= y0 + 1; y++) K.at(u, y, w, fence);
    for (let u = 0; u <= 2; u++) for (let w = 0; w <= 1; w++) K.at(u, y0 + 2, w, canopy, { facing: OUT, half: 'bottom', open: 'false' });
    if (W >= 4) table(3);
  }
}

function storageWallKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W >= 3 && H >= 2 && D === 1, `needs a wall face at least 3 wide, 2 high and 1 deep, this one is ${sizeText(K)}`);
  const wood = K.mat('block');
  const barrel = K.first('barrel') ?? K.full(wood);
  const chest = K.first('chest');
  const frame = K.tryForm(wood, 'log') ?? K.full(wood);
  const ladder = K.first('ladder');
  if (variant === 1) {
    for (const u of [0, W - 1]) for (let y = y0; y <= y1; y++) K.at(u, y, 0, frame, along('y'));
    // Chests at the bottom, barrels over them, and cupboards (trapdoor doors) along the top.
    const doors = H >= 3 ? K.tryForm(wood, 'trapdoor') : null;
    for (let u = 1; u < W - 1; u++) {
      K.at(u, y0, 0, chest ?? barrel, { facing: OUT });
      for (let y = y0 + 1; y <= y1; y++) {
        if (doors && y === y1) {
          K.at(u, y, 0, K.full(wood));
          K.at(u, y, 1, doors, open(OUT));
        } else K.at(u, y, 0, barrel, { facing: OUT });
      }
    }
  } else {
    const lu = Math.floor((W - 1) / 2);
    for (let u = 0; u < W; u++) {
      for (let y = y0; y <= y1; y++) {
        const pick = (u + y) % 3 === 0 && chest && y === y0 ? chest : barrel;
        K.at(u, y, 0, pick, { facing: OUT });
      }
    }
    if (ladder) for (let y = y0; y <= y1; y++) K.at(lu, y, 1, ladder, { facing: OUT });
    const stairs = K.tryForm(wood, 'stairs');
    if (stairs) for (let u = 0; u < W; u++) if (u !== lu) K.at(u, y1, 1, stairs, stair(BACK, 'top'));
  }
}

function kitchenKit(K) {
  const { W, H, D, y0, y1, variant } = K;
  K.need(W >= 3 && H >= 3 && D === 1, `needs a wall face at least 3 wide, 3 high and 1 deep, this one is ${sizeText(K)}`);
  const wood = K.mat('block');
  const counter = K.form(wood, 'stairs', 'block');
  const hood = K.mat('fill') ?? K.fixed(K.known('bricks') ? 'bricks' : 'stone_bricks');
  const hoodStairs = K.tryForm(hood, 'stairs');
  const cabinet = K.form(wood, 'trapdoor', 'block');
  const fixed = (name) => K.first(name);
  let row;
  if (variant === 1) {
    row = ['smoker', 'furnace', 'crafting_table'];
    while (row.length < W) row.push('counter');
    if (W >= 5) row[W - 2] = 'cauldron';
  } else {
    const mid = Math.floor((W - 1) / 2);
    row = Array.from({ length: W }, (_, u) => (u === mid ? 'furnace' : u === mid - 1 && W >= 5 ? 'smoker' : u === W - 1 ? 'crafting_table' : u === 0 && W >= 5 ? 'cauldron' : 'counter'));
  }
  row = row.slice(0, W);
  row.forEach((what, u) => {
    if (what === 'counter') K.at(u, y0, 0, counter, stair(BACK, 'top'));
    else {
      const block = fixed(what) ?? K.full(wood);
      K.at(u, y0, 0, block, what === 'furnace' || what === 'smoker' ? { facing: OUT } : {});
    }
  });
  const stove = row.map((what, u) => (what === 'furnace' || what === 'smoker' ? u : -1)).filter((u) => u >= 0);
  for (let u = 0; u < W; u++) {
    if (stove.includes(u)) {
      if (hoodStairs) K.at(u, y0 + 2, 1, hoodStairs, stair(BACK, 'top'));
      for (let y = y0 + 2; y <= y1; y++) K.at(u, y, 0, hood);
    } else if (y0 + 2 <= y1) {
      K.at(u, y0 + 2, 0, K.full(wood));
      K.at(u, y0 + 2, 1, cabinet, open(OUT));
    }
  }
  if (!stove.length) return;
  const lu = stove.at(-1) + 1;
  if (lu < W && row[lu] === 'counter' && y0 + 2 <= y1) K.at(lu, y0 + 1, 0, K.lantern(), standing);
}

function bookshelfWallKit(K) {
  const { W, H, D, y0, y1, variant, part } = K;
  K.need(W >= 2 && H >= 2 && D === 1, `needs a wall face at least 2 wide, 2 high and 1 deep, this one is ${sizeText(K)}`);
  const wood = K.mat('block');
  const posts = K.mat('fill') ?? K.tryForm(wood, 'log') ?? K.full(wood);
  const cornice = K.tryForm(wood, 'stairs');
  const plain = K.fixed('bookshelf');
  const chiseled = variant === 2 ? K.first('chiseled_bookshelf') : null;
  const postAt = new Set(spread(W, part.every ?? 4));
  for (let u = 0; u < W; u++) {
    for (let y = y0; y <= y1; y++) {
      if (postAt.has(u)) K.at(u, y, 0, posts, along('y'));
      else if (chiseled && spot(u, y, 0, 13) < 0.4) K.at(u, y, 0, chiseled, { facing: OUT });
      else K.at(u, y, 0, plain);
    }
    if (cornice && H >= 3) K.at(u, y1, 1, cornice, stair(BACK, 'top'));
  }
  if (variant === 2) {
    const lectern = K.first('lectern');
    if (lectern) K.at(Math.floor((W - 1) / 2), y0, 2, lectern, { facing: OUT });
  }
}

// A carpet of a block: a carpet as it is, the carpet of a dyed block's colour, or moss.
function carpetOf(K, entries, field) {
  const made = entries.map((e) => {
    if (/_carpet$/.test(e.name)) return { ...e, props: {}, text: undefined };
    if (e.name === 'moss_block' || e.name === 'pale_moss_block') return { ...e, name: e.name.replace('_block', '_carpet'), props: {}, text: undefined };
    const dye = DYE.exec(e.name)?.[1];
    K.need(dye, `${field} is a carpet or a dyed block like red_wool, not ${e.name}`);
    return { ...e, name: `${dye}_carpet`, props: {}, text: undefined };
  });
  made.salt = entries.salt;
  return made;
}

function rugKit(K) {
  const { W, D, y0, variant } = K;
  K.need(K.H === 1 && W >= 2 && D >= 2, `needs a floor area one layer high and at least 2 by 2, this one is ${sizeText(K)}`);
  const main = carpetOf(K, K.mat('block'), 'block');
  const edge = carpetOf(K, K.mat('fill', 'white_carpet'), 'fill');
  const cu = (W - 1) / 2;
  const cw = (D - 1) / 2;
  for (let u = 0; u < W; u++) {
    for (let w = 0; w < D; w++) {
      const rim = u === 0 || u === W - 1 || w === 0 || w === D - 1;
      let second = rim;
      if (variant === 2 && !rim) second = Math.round(Math.abs(u - cu) + Math.abs(w - cw)) % 2 === 1;
      if (variant === 3) second = (W >= D ? u : w) % 2 === 1;
      K.at(u, y0, w, second ? edge : main);
    }
  }
}

function ceilingLightKit(K) {
  const { W, D, H, y0, y1, variant } = K;
  const chain = K.first('iron_chain', 'chain');
  const light = K.mat('fill') ?? K.lantern();
  if (variant === 1) {
    K.need(W === 1 && D === 1, `variant 1 needs one column (from.dy the lantern, to.dy just under the ceiling), this one is ${W} by ${D}`);
    if (chain) for (let y = y0 + 1; y <= y1; y++) K.at(0, y, 0, chain, { axis: 'y' });
    K.at(0, y0, 0, light, hanging);
    return;
  }
  K.need(W === 3 && D === 3 && H >= 2, `variant 2 (chandelier) needs a box 3 by 3 and at least 2 high, this one is ${sizeText(K)}`);
  const arm = K.rail(K.mat('block'), 'block');
  if (chain) for (let y = y0 + 2; y <= y1; y++) K.at(1, y, 1, chain, { axis: 'y' });
  for (const [u, w] of [[1, 1], [0, 1], [2, 1], [1, 0], [1, 2]]) {
    K.at(u, y0 + 1, w, arm);
    if (u !== 1 || w !== 1) K.at(u, y0, w, light, hanging);
  }
}

// Each kit: what it is, what its box, block and fill are, its looks, and how far past its box it
// reaches (left, right, down, up, back, out in its own frame) for a box W wide, H high, D deep.
export const KITS = [
  {
    kind: 'window', group: 'openings', run: windowKit, variants: ['plain: stair head and sill in the wall', 'shutters (trapdoors), slab sill, trapdoor awning', 'arched top, lintel, sill'],
    brief: 'glass in the wall, block trim wood, every 2 on 3 wide: a pair; 1 plain, 2 shutters, 3 arched; extra flower box',
    line: 'box: glass in the wall; block: trim; fill: lintel; every: 1-wide windows across the box (3 wide, every 2: a pair 1 apart); extra: flower box',
    reach: ({ extra }) => ({ left: 1, right: 1, down: 1, up: 1, back: 0, out: extra ? 2 : 1 })
  },
  {
    kind: 'bay_window', group: 'openings', run: bayWindowKit, variants: ['stair roof', 'slab roof with a trim edge'],
    brief: 'the opening, glass pushed a block out, block the frame wood; 1 stair roof, 2 slab roof',
    line: 'box: the opening in the wall; glass goes one block out between posts, on corbels; block: frame with stairs; fill: roof',
    reach: ({ variant }) => ({ left: 1, right: 1, down: 2, up: 1, back: 0, out: variant === 2 ? 2 : 1 })
  },
  {
    kind: 'dormer', group: 'openings', run: dormerKit, variants: ['gable roof', 'shed roof'],
    brief: 'its window, the sill row on the slope, facing downhill, pitch the roof\'s; 1 gable, 2 shed',
    line: 'box: the window in the dormer face, its sill row on the roof; facing: down the slope; pitch: the main roof\'s pitch; block: walls; fill: roof stairs (default @roof)',
    reach: ({ W, H, part }) => {
      const s = part.pitch ?? 1;
      const up = 1 + Math.ceil(W / 2);
      return { left: 1, right: 1, down: 1, up, back: Math.ceil((H + up) / s), out: 1 };
    }
  },
  {
    kind: 'door', group: 'openings', run: doorKit, variants: ['framed, torches on the posts', 'stair hood, lanterns hung under it', 'framed with a small gable over it, torches beside'],
    brief: 'doorway 1 or 2 wide, block the door wood; 1 framed, torches, 2 hood, lanterns, 3 framed, a gable; extra a step',
    line: 'box: doorway 1 or 2 wide, 2+ high (glass above); block: door wood; fill: frame (default @frame); extra: outside step',
    reach: ({ variant, W }) => ({ left: variant === 3 ? 2 : 1, right: variant === 3 ? 2 : 1, down: 1, up: variant === 3 ? 2 + Math.floor((W + 1) / 2) : 1, back: 0, out: 1 })
  },
  {
    kind: 'porch', group: 'openings', run: porchKit, variants: ['low shed roof', 'gable roof facing out', 'flat roof with a rail on top'],
    brief: 'the deck against the wall, to.dy the post tops; 1 shed, 2 gable, 3 flat roof; extra rails',
    line: 'box: deck outside a wall, from.dy the deck to to.dy the post tops (3+ above); block: deck and roof; fill: posts; every: post spacing; extra: rails',
    reach: ({ W, D, variant }) => ({ left: 1, right: 1, down: 0, up: variant === 1 ? 1 + Math.floor(D / 2) : variant === 2 ? 1 + Math.ceil(W / 2) : 3, back: 0, out: 1 })
  },
  {
    kind: 'archway', group: 'openings', run: archwayKit, variants: ['round', 'pointed (4+ wide)', 'flat with corbels'],
    brief: 'the opening through the wall; 1 round, 2 pointed, 3 flat with corbels',
    line: 'box: the opening through a wall (its depth the wall\'s thickness); block: the arch\'s edge; fill: keystone',
    reach: () => ({ left: 1, right: 1, down: 0, up: 1, back: 0, out: 0 })
  },
  {
    kind: 'chimney', group: 'roof and wall', run: chimneyKit, variants: ['outside a wall, a base 2 high stepped in with stairs, a slab cap', 'through a roof, a stone top and pots', 'outside a wall, jogging a block sideways part way up'],
    brief: 'stack foot to above the ridge, back on the wall, width across (2); 1 stepped base, 2 through a roof, 3 jogs; extra smoke collar',
    line: 'box: stack (up to 3 by 3) foot to above the ridge, back on the wall; width: stack across (default 2); block: stack; fill: top and cap; extra: campfire smoke collar',
    reach: ({ variant, extra, part, W }) => {
      const side = variant === 2 && !extra ? 0 : 1;
      const wider = Math.max(0, (part.width ?? Math.max(W, 2)) - W);
      return { left: side, right: (variant === 3 ? side + 1 : side) + wider, down: 0, up: variant === 2 && !extra ? 2 : 1, back: extra ? 1 : 0, out: side };
    }
  },
  {
    kind: 'battlements', group: 'roof and wall', run: battlementsKit, variants: ['merlons one on, one off', 'merlons two on, one off', 'round tower top in the box'],
    brief: 'the layer over a wall top, one wall or a ring; 1 or 2 merlons on, 3 round; extra out on corbels',
    line: 'box: the layer above a wall top, one wall (facing out) or a ring round a tower; a parapet with merlons; extra: parapet out on corbels, wall top free to walk',
    reach: ({ extra }) => ({ left: extra ? 1 : 0, right: extra ? 1 : 0, down: extra ? 1 : 0, up: 1, back: extra ? 1 : 0, out: extra ? 1 : 0 })
  },
  {
    kind: 'buttress', group: 'roof and wall', run: buttressKit, variants: ['stepped, stairs on each step', 'stepped on a wide base of fill'],
    brief: 'the wall strip it props, width how far out; 1 stepped, 2 on a base',
    line: 'box: the strip of wall it stands against (1-2 wide, full height); width: how far out (default by height)',
    reach: ({ H, part, variant }) => {
      const depth = part.width ?? (H >= 9 ? 3 : H >= 5 ? 2 : 1);
      return { left: variant === 2 ? 1 : 0, right: variant === 2 ? 1 : 0, down: 0, up: 0, back: 0, out: depth + (variant === 2 ? 1 : 0) };
    }
  },
  {
    kind: 'balcony', group: 'roof and wall', run: balconyKit, variants: ['slab floor, fence rail', 'trapdoor rail', 'wall rail (stone)'],
    brief: 'the floor against the wall; 1 fence, 2 trapdoor, 3 wall rail; extra lanterns',
    line: 'box: the floor outside a wall, back row against it, from.dy the floor; brackets under it every blocks; block: floor and brackets (stairs); fill: rail; extra: lanterns on the front corners',
    reach: ({ D }) => ({ left: 0, right: 0, down: D >= 2 ? 2 : 1, up: 2, back: 0, out: 0 })
  },
  {
    kind: 'eave_brackets', group: 'roof and wall', run: eaveBracketsKit, variants: ['upside-down stairs', 'stairs with lanterns hung between', 'beam ends of fill on stairs'],
    brief: 'the top wall row under an overhang, every apart; 1 stairs, 2 with lanterns, 3 beam ends',
    line: 'box: the top row of wall under an overhang; brackets go one out, every blocks apart (default 2); block: stairs wood',
    reach: ({ variant }) => ({ left: 0, right: 0, down: variant === 3 ? 1 : 0, up: 0, back: 0, out: 1 })
  },
  {
    kind: 'awning', group: 'roof and wall', run: awningKit, variants: ['striped cloth (carpets) of block and fill colours, with a hanging front edge', 'flat trapdoors', 'stairs and slabs'],
    brief: 'the opening under it, width how far out; 1 cloth striped block and fill, 2 trapdoors, 3 stairs',
    line: 'box: the window or stall opening, the awning over it; width: how far out (1-3, default 2)',
    reach: ({ part, variant }) => ({ left: 1, right: 1, down: 0, up: variant === 1 ? 2 : 1, back: 0, out: part.width ?? 2 })
  },
  {
    kind: 'facade', group: 'roof and wall', run: facadeKit, variants: ['planters of flowers between the posts', 'planters of bushes between the posts'],
    brief: 'layer one out from a wall, ground to eave, block post stone, width a door gap; 1 flowers, 2 bushes',
    line: 'box: layer 1 out from a wall, 1 deep, ground to eave; stone and fence posts, trapdoor planters between, corner lanterns; block: post stone; fill: wood; every: post spacing (2); width: door gap (1-3)',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 1 })
  },
  {
    kind: 'path', group: 'ground', run: pathKit, variants: ['ragged edge (wide paths), a calm mix, stones and bushes along it', 'neat, edging of fill', 'stepping stones'],
    brief: 'from, to its ends in the ground layer, width; 1 ragged, stones beside, 2 neat, fill edging, 3 stepping stones',
    line: 'from, to: ends in the ground layer (dy -1); width (default 3); block: surface (variant 1 adds stones and bushes); fill: edging (variant 2) or roadside stones',
    reach: ({ part }) => {
      const r = Math.ceil(((part.width ?? 3) - 1) / 2) + 4;
      return { left: r, right: r, down: 0, up: 1, back: r, out: r };
    }
  },
  {
    kind: 'lamp_post', group: 'ground', run: lampPostKit, variants: ['a cross of four arms, lanterns hung under a trapdoor cap', 'one long arm toward facing, a lantern on a chain', 'two arms, two lanterns'],
    brief: 'from its foot, to.dy its arms (same: 5 high); 1 four arms, 2 one long arm, 3 two; extra barrel foot',
    line: 'from: its foot, to.dy the arms (same as from: 5 high); a stone foot, then the post; block: post (fence or wall); fill: foot stone; extra: a barrel foot with slabs round it',
    reach: ({ part, variant, extra }) => ({ left: 1, right: 1, down: 0, up: part.to.dy === part.from.dy ? 5 : 1, back: variant === 1 || extra ? 1 : 0, out: variant === 2 ? 3 : 1 })
  },
  {
    kind: 'fence_run', group: 'ground', run: fenceRunKit, variants: ['posts as high as the fence', 'posts a block higher, on stone feet'],
    brief: 'a row, or a ring round it; fill posts every apart, width a gate, extra lanterns; 1 low, 2 tall posts',
    line: 'box: one row (a run) or a box (a ring round it); block: rail (fence or wall); fill: posts; every: post spacing (4); width: a gate 1-2 wide mid-run (a ring: on the facing side); extra: lanterns on posts',
    reach: ({ extra, variant }) => ({ left: 0, right: 0, down: 0, up: (extra ? 1 : 0) + (variant === 2 ? 1 : 0), back: 0, out: 0 })
  },
  {
    kind: 'planter', group: 'ground', run: planterKit, variants: ['trapdoors round the soil', 'upside-down stair rim', 'block rim'],
    brief: 'the soil, fill the plants; 1 trapdoor, 2 stair, 3 block rim',
    line: 'box: the bed, one layer high; block: edge; fill: plants (default flowers and azalea leaves)',
    reach: ({ variant }) => {
      const r = variant === 1 ? 1 : 0;
      return { left: r, right: r, down: 0, up: 1, back: r, out: r };
    }
  },
  {
    kind: 'well', group: 'ground', run: wellKit, variants: ['corner posts, a small gable roof of planks, a chain', 'the ring only'],
    brief: 'footprint 4 by 4 best, ring foot to ridge, fill roof wood; 1 roofed, 2 ring only',
    line: 'box: the footprint (3-7 a side, 4 by 4 rings a 2 by 2 middle) from the foot of its ring to the roof ridge; block: ring stone; fill: roof wood; the middle is left open (pour water in)',
    reach: ({ variant }) => (variant === 1 ? { left: 1, right: 1, down: 0, up: 0, back: 1, out: 1 } : { left: 0, right: 0, down: 0, up: 0, back: 0, out: 0 })
  },
  {
    kind: 'bench', group: 'ground', run: benchKit, variants: ['stairs with trapdoor arms', 'with a trapdoor back'],
    brief: 'the seat row, facing the way you sit; 1 arms, 2 with a back',
    line: 'box: the seat row, one deep; facing: the way you look sitting; block: stairs wood; fill: trapdoors',
    reach: ({ variant }) => ({ left: 1, right: 1, down: 0, up: variant === 2 ? 1 : 0, back: 0, out: 0 })
  },
  {
    kind: 'market_stall', group: 'ground', run: marketStallKit, variants: ['flat striped canopy', 'canopy raised in the middle', 'lean-to against a wall, front posts only'],
    brief: 'footprint 3 by 3-5, to.dy post tops, fill stripes; 1 flat, 2 peaked, 3 lean-to',
    line: 'box: footprint (3 by 3 to 3 by 5), to.dy the post tops (kept no taller than its longer side); posts on stone feet, barrel and slab counter, striped wool canopy with edge banners; block: wood; fill: canopy stripes (default red_wool,white_wool)',
    reach: ({ variant }) => ({ left: 1, right: 1, down: 0, up: variant === 1 ? 1 : 2, back: variant === 3 ? 0 : 1, out: 1 })
  },
  {
    kind: 'tree', group: 'ground', run: treeKit, variants: ['round crown', 'pointed, layered like a spruce', 'wide, two branches'],
    brief: 'the whole tree, block log, fill leaves; 1 round, 2 spruce, 3 wide',
    line: 'box: the whole tree, trunk in the middle; block: log (default oak_log); fill: leaves (default the log\'s)',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 0 })
  },
  {
    kind: 'fireplace', group: 'interior', run: fireplaceKit, variants: ['square surround', 'narrowing chimney breast'],
    brief: 'against a wall, 3+ by 3+, 1-2 deep; 1 square, 2 chimney breast',
    line: 'box: the front against a wall (3+ wide, 3+ high, 1-2 deep); campfire inside, stair mantel, candles; block: surround; fill: hearth in the floor',
    reach: () => ({ left: 1, right: 1, down: 1, up: 1, back: 0, out: 1 })
  },
  {
    kind: 'table_and_chairs', group: 'interior', run: tableKit, variants: ['fence and pressure plate', 'top slabs and a lantern', 'upside-down stairs and a lantern'],
    brief: 'the table, block chairs, fill table; 1 fence and plate, 2 slab, 3 stairs; extra end chairs',
    line: 'box: the table, up to 4 by 3; chairs front and back; block: chairs (stairs); fill: table; extra: chairs at the ends too',
    reach: ({ extra }) => ({ left: extra ? 1 : 0, right: extra ? 1 : 0, down: 0, up: 1, back: 1, out: 1 })
  },
  {
    kind: 'bed_nook', group: 'interior', run: bedNookKit, variants: ['single bed, side tables', 'double bed, a table each side', 'canopy bed'],
    brief: '2 deep, head at the wall, fill the bed colour; 1 single, 2 double, 3 canopy',
    line: 'box: 2 deep against a wall (bed head at the back), 2-4 wide; block: wood; fill: the bed (red_bed, or a dyed block\'s colour)',
    reach: () => ({ left: 0, right: 0, down: 0, up: 2, back: 0, out: 0 })
  },
  {
    kind: 'storage_wall', group: 'interior', run: storageWallKit, variants: ['chests and barrels between log posts', 'barrels and chests with a ladder'],
    brief: 'against a wall, one deep; 1 chests and barrels, 2 with a ladder',
    line: 'box: the wall face it covers, one deep; block: wood; chests are placed empty',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 1 })
  },
  {
    kind: 'kitchen', group: 'interior', run: kitchenKit, variants: ['stove at one end', 'stove in the middle'],
    brief: 'against a wall, 3+ by 3+; 1 stove at the end, 2 in the middle',
    line: 'box: the wall face (3+ wide, 3+ high, one deep); smoker, furnace, crafting table, stair counters, cabinets, a hood; block: wood; fill: hood stone',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 1 })
  },
  {
    kind: 'bookshelf_wall', group: 'interior', run: bookshelfWallKit, variants: ['shelves between posts', 'with chiseled shelves and a lectern'],
    brief: 'against a wall, fill posts; 1 plain, 2 with a lectern',
    line: 'box: the wall face, one deep; block: wood (stair cornice); fill: posts; every: post spacing (4)',
    reach: ({ variant }) => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: variant === 2 ? 2 : 1 })
  },
  {
    kind: 'rug', group: 'interior', run: rugKit, variants: ['border', 'diamonds in a border', 'stripes'],
    brief: 'the floor, block and fill the colours; 1 border, 2 diamonds, 3 stripes',
    line: 'box: the floor area, one layer; block: main colour; fill: second colour (carpets or dyed blocks)',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 0 })
  },
  {
    kind: 'ceiling_light', group: 'interior', run: ceilingLightKit, variants: ['lantern on a chain (one column)', 'chandelier (3 by 3)'],
    brief: 'to.dy under the ceiling, fill the light; 1 lantern on a chain, 2 chandelier 3 by 3',
    line: 'box: to.dy just under the ceiling, from.dy the lowest lantern; block: arms (fence wood); fill: the light (default lantern)',
    reach: () => ({ left: 0, right: 0, down: 0, up: 0, back: 0, out: 0 })
  }
];

export const KIT_KINDS = KITS.map((k) => k.kind);
const BY_KIND = new Map(KITS.map((k) => [k.kind, k]));

export function kitInfo(kind) {
  return BY_KIND.get(kind) ?? null;
}

// The kit list in full for the design guide, one line per kit.
export function kitLines() {
  return KITS.map((k) => `${k.kind} (${k.variants.map((v, i) => `${i + 1} ${v}`).join('; ')}): ${k.line}`);
}

// The kit list in short for the tool description.
export function kitSummary() {
  return KITS.map((k) => `${k.kind}: ${k.brief}`).join('. ');
}

// A part with shape "kit", in the form expandShapes calls its shape makers.
export function kitShape(part, put, mat, ctx, where) {
  const kit = BY_KIND.get(part.kind);
  if (!kit) throw new PlanError(`${where}: kind is ${part.kind ?? 'missing'}, a kit is one of ${KIT_KINDS.join(', ')}`);
  const v = part.variant ?? 1;
  if (!Number.isInteger(v) || v < 1 || v > kit.variants.length) {
    throw new PlanError(`${where}: kit ${kit.kind} has variants 1 to ${kit.variants.length} (${kit.variants.map((t, i) => `${i + 1} ${t}`).join('; ')}), not ${v}`);
  }
  kit.run(makeContext(part, put, mat, ctx, where));
}

// One kit on its own as single blocks { dx, dy, dz, block }, for tests and pictures. A mix picks
// by spot here too, though not with the same picks as a whole plan. keepAir keeps the spots the
// kit clears (a doorway, the inside of a dormer) as "air".
export function expandKit(part, { palette = {}, isKnownBlock, keepAir = false } = {}) {
  const ctx = { palette, known: isKnownBlock };
  if (!isKnownBlock) delete ctx.known;
  const cells = new Map();
  const put = (dx, dy, dz, entries, make) => {
    const key = `${dx},${dy},${dz}`;
    cells.delete(key);
    cells.set(key, { dx, dy, dz, entries, make });
  };
  const where = `kit ${part.kind}`;
  const cache = {};
  const mat = (field) => (cache[field] ??= material(part[field], ctx, `${where}, ${field}`));
  kitShape({ shape: 'kit', ...part }, put, mat, ctx, where);
  const out = [];
  for (const c of cells.values()) {
    const { entries } = c;
    let e = entries[0];
    if (entries.length > 1) {
      const total = entries.reduce((s, x) => s + x.w, 0);
      let t = spot(c.dx, c.dy, c.dz, entries.salt ?? 0) * total;
      e = entries.find((x) => (t -= x.w) < 0) ?? entries.at(-1);
    }
    const block = c.make(e);
    if (block !== 'air' || keepAir) out.push({ dx: c.dx, dy: c.dy, dz: c.dz, block });
  }
  return out;
}
