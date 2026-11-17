import { createRequire } from 'node:module';
import { parseBlock, blockText } from './states.js';
import { kitShape } from './kits.js';

// A plan that can't be expanded, with a message for the model that names the part.
export class PlanError extends Error {}

export const ROLES = ['wall', 'frame', 'trim', 'roof', 'foundation', 'floor', 'glass', 'light', 'accent', 'accent2'];
export const FORMS = ['block', 'stairs', 'slab', 'wall', 'fence', 'fence_gate', 'door', 'trapdoor', 'button', 'pressure_plate', 'pane', 'planks', 'log'];
export const SHAPES = ['fill', 'hollow', 'walls', 'frame', 'line', 'roof', 'circle', 'sphere', 'dome', 'cone', 'pyramid', 'arch', 'staircase', 'posts', 'windows', 'band', 'kit'];
export const ROOF_STYLES = ['gable', 'hip', 'pyramid', 'shed', 'flat'];
const SIDES = ['north', 'south', 'east', 'west'];

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

const TURN = { north: 'east', east: 'south', south: 'west', west: 'north' };
const MIRROR = { x: { east: 'west', west: 'east' }, z: { north: 'south', south: 'north' } };
const OUTWARD = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

// A block's state turned a quarter clockwise (seen from above) times times.
export function turnState(props, times) {
  const out = { ...props };
  for (let i = 0; i < times; i++) {
    if (TURN[out.facing]) out.facing = TURN[out.facing];
    if (out.axis === 'x') out.axis = 'z';
    else if (out.axis === 'z') out.axis = 'x';
  }
  return out;
}

// A block's state seen in a mirror across a plane square to axis (x or z). Logs keep their axis.
export function mirrorState(props, axis) {
  const out = { ...props };
  if (MIRROR[axis][out.facing]) out.facing = MIRROR[axis][out.facing];
  return out;
}

const range = (a, b) => {
  const out = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
  return out;
};

// A number in [0, 1) that only depends on the spot and the salt, so a mix picks the same block
// for a spot every time.
function cellHash(x, y, z, salt) {
  let h = salt >>> 0;
  for (const v of [x, y, z]) {
    h = Math.imul(h ^ (v | 0), 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

// How far apart, in blocks, the seeds of a mix's patches are.
const PATCH = 2.2;

// Like cellHash, but the same for every spot of a small patch round a seed point, so the blocks
// of a mix come in clusters of a few instead of as single odd blocks.
function patchHash(x, y, z, salt) {
  const [gx, gy, gz] = [Math.floor(x / PATCH), Math.floor(y / PATCH), Math.floor(z / PATCH)];
  let best = Infinity;
  let seed = null;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const [cx, cy, cz] = [gx + i, gy + j, gz + k];
        const px = (cx + cellHash(cx, cy, cz, salt ^ 0x1b873593)) * PATCH;
        const py = (cy + cellHash(cx, cy, cz, salt ^ 0x68e31da4)) * PATCH;
        const pz = (cz + cellHash(cx, cy, cz, salt ^ 0x3c6ef372)) * PATCH;
        const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 + (z + 0.5 - pz) ** 2;
        if (d < best) {
          best = d;
          seed = [cx, cy, cz];
        }
      }
    }
  }
  // An even spread over the seeds rather than a coin toss for each, so a small wall still gets
  // its share of patches.
  const v = seed[0] * 0.8191725134 + seed[1] * 0.6710436067 + seed[2] * 0.5497004779 + cellHash(0, 0, 0, salt);
  return v - Math.floor(v);
}

function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// Splits on commas outside the [state] brackets.
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

const WOOD = /^(?:stripped_)?([a-z_]+?)_(?:planks|log|wood|stem|hyphae)$/;

// The name of a block's other form (its stairs, slab, wall, door...), or null when the game has
// none. Tried on the name and the name with its plural, _block or _planks taken off, and on the
// wood it is made of, then the same from its full block, so a stairs role gives its slab too.
export function formName(name, form, known = knownInGame) {
  const full = (n) => {
    const stem = n.replace(/_(stairs|slab|wall)$/, '');
    return [`${stem}_planks`, stem, `${stem}s`, `${stem}_block`].find(known) ?? null;
  };
  if (form === 'block') return full(name);
  const stems = (n) => {
    const out = [n, n.replace(/s$/, ''), n.replace(/_block$/, ''), n.replace(/_planks$/, '')];
    const wood = WOOD.exec(n)?.[1] ?? (n === 'bamboo_block' ? 'bamboo' : null);
    if (wood) out.push(wood);
    return out;
  };
  const ends = form === 'log' ? ['log', 'stem'] : [form];
  const base = full(name);
  const tried = new Set();
  for (const stem of [...stems(name), ...(base && base !== name ? stems(base) : [])]) {
    if (tried.has(stem)) continue;
    tried.add(stem);
    for (const end of ends) if (known(`${stem}_${end}`)) return `${stem}_${end}`;
  }
  if (form === 'log' && name === 'bamboo_planks' && known('bamboo_block')) return 'bamboo_block';
  return null;
}

// A block field as a list of { name, props, w } to pick from: one block, a weighted mix like
// "70%stone_bricks,20%cracked_stone_bricks,10%mossy_stone_bricks", or palette roles like
// "@wall" and "@wall.stairs[facing=east]". A plain block keeps its text as given. A mix comes
// in small patches; written "scatter:70%gravel,30%coarse_dirt" it picks each spot on its own.
export function material(whole, { palette = {}, known = knownInGame } = {}, where = 'block') {
  if (typeof whole !== 'string' || !whole.trim()) throw new PlanError(`${where} is empty, give a block name`);
  const scatter = /^\s*scatter\s*:/.test(whole);
  const text = scatter ? whole.replace(/^\s*scatter\s*:\s*/, '') : whole;
  if (!text.trim()) throw new PlanError(`${where}: "${whole}" has no block after scatter:`);
  const pieces = splitTop(text);
  const entries = [];
  entries.salt = textHash(text);
  entries.scatter = scatter;
  if (pieces.length === 1 && !/[%@]/.test(text)) {
    entries.push({ ...parseBlock(text), w: 1, text });
    return entries;
  }
  for (const piece of pieces) {
    const m = /^\s*(?:(\d+(?:\.\d+)?)\s*%)?\s*(.*?)\s*$/.exec(piece);
    const w = m[1] === undefined ? 1 : Number(m[1]);
    const body = m[2];
    if (!body) throw new PlanError(`${where}: "${piece.trim()}" in "${text}" has no block name`);
    if (w <= 0) continue;
    if (!body.startsWith('@')) {
      entries.push({ ...parseBlock(body), w });
      continue;
    }
    const r = /^@([a-z0-9_]+?)(?:\.([a-z_]+))?\s*(\[[^\]]*\])?$/.exec(body);
    if (!r) throw new PlanError(`${where}: "${body}" is not a role, write @role or @role.form like @wall.stairs`);
    const [, role, form, state] = r;
    if (!ROLES.includes(role)) throw new PlanError(`${where}: @${role} is not a palette role; the roles are ${ROLES.join(', ')}`);
    const given = palette?.[role];
    if (!given) throw new PlanError(`${where}: @${role} is used but the palette has no ${role}`);
    if (/@/.test(given)) throw new PlanError(`palette ${role}: a role can't refer to another role, give block names`);
    if (form && !FORMS.includes(form)) throw new PlanError(`${where}: ${form} is not a form; the forms are ${FORMS.join(', ')}`);
    const extra = parseBlock(`x${state ?? ''}`).props;
    const base = material(given, { palette, known }, `palette ${role}`);
    if (base.scatter) entries.scatter = true;
    let made = base;
    if (form) {
      made = base.map((e) => ({ ...e, name: formName(e.name, form, known) })).filter((e) => e.name);
      if (!made.length) {
        const has = FORMS.filter((f) => ![null, base[0].name].includes(formName(base[0].name, f, known)));
        throw new PlanError(`${where}: @${role}.${form}: the ${role} role is ${base[0].name}, which has no ${form} form${has.length ? `; it has ${has.join(', ')}` : ''}`);
      }
      made = made.map((e) => ({ ...e, props: {} }));
    }
    const total = made.reduce((s, e) => s + e.w, 0);
    for (const e of made) entries.push({ name: e.name, props: { ...e.props, ...extra }, w: (w * e.w) / total });
  }
  if (!entries.length) throw new PlanError(`${where}: "${text}" has no block with a weight above 0`);
  return entries;
}

function choose(mat, total, h) {
  let t = h * total;
  for (let i = 0; i < mat.length; i++) {
    t -= mat[i].w;
    if (t < 0) return i;
  }
  return mat.length - 1;
}

const PLANES = [[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]], [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]], [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]];

// The entry of a mix for a spot. Patches cut by a wall's face can leave a lone block, so a lesser
// block with none of its own kind beside it on one of the three planes through it takes the
// main block instead.
function pick(mat, x, y, z) {
  if (mat.length === 1) return mat[0];
  const total = mat.reduce((s, e) => s + e.w, 0);
  const salt = mat.salt ?? 0;
  if (mat.scatter) return mat[choose(mat, total, cellHash(x, y, z, salt))];
  const at = (a, b, c) => choose(mat, total, patchHash(a, b, c, salt));
  const main = mat.reduce((m, e, i) => (e.w > mat[m].w ? i : m), 0);
  const i = at(x, y, z);
  if (i === main) return mat[i];
  for (const plane of PLANES) {
    if (!plane.some(([a, b, c]) => at(x + a, y + b, z + c) === i)) return mat[main];
  }
  return mat[i];
}

const asText = (e) => e.text ?? blockText(e.name, e.props);

// The block a mix or role (see material) gives at a spot, as text.
export function blockFor(mat, dx, dy, dz) {
  return asText(pick(mat, dx, dy, dz));
}

// The cells of one part, later ones winning. make turns the picked entry of mat into block text.
function cellSet() {
  const cells = new Map();
  const put = (dx, dy, dz, mat, make = asText) => {
    const key = `${dx},${dy},${dz}`;
    cells.delete(key);
    cells.set(key, { dx, dy, dz, mat, make });
  };
  return { cells, put };
}

function intOr(value, fallback, where, field, min = 1) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min) throw new PlanError(`${where}: ${field} is ${value}, it must be a whole number of at least ${min}`);
  return value;
}

// The box of a part as numbers, low to high.
function boxOf(part) {
  const { from, to = from } = part;
  return {
    x0: Math.min(from.dx, to.dx), x1: Math.max(from.dx, to.dx),
    y0: Math.min(from.dy, to.dy), y1: Math.max(from.dy, to.dy),
    z0: Math.min(from.dz, to.dz), z1: Math.max(from.dz, to.dz)
  };
}

// Every cell of the box that inside() takes. With hollow only the ones with a face on a cell it
// doesn't take; faces in skip (like the underside of a dome) don't count.
function solid(b, inside, put, mat, { hollow = false, faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] } = {}) {
  for (let x = b.x0; x <= b.x1; x++) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let z = b.z0; z <= b.z1; z++) {
        if (!inside(x, y, z)) continue;
        if (hollow && faces.every(([fx, fy, fz]) => inside(x + fx, y + fy, z + fz))) continue;
        put(x, y, z, mat);
      }
    }
  }
}

const inBox = (b, x, y, z) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;
const half = (a0, a1) => ({ c: (a0 + a1) / 2, r: (a1 - a0 + 1) / 2 });

// The wall lines of a box seen from above: its four sides, or one line when it is a single
// block thick. Each line has its cells in order and the way out from it.
function wallLines(b) {
  if (b.x0 === b.x1 || b.z0 === b.z1) {
    const alongX = b.x1 - b.x0 >= b.z1 - b.z0;
    const cells = alongX ? range(b.x0, b.x1).map((x) => [x, b.z0]) : range(b.z0, b.z1).map((z) => [b.x0, z]);
    return [{ cells, alongX, out: null }];
  }
  return [
    { cells: range(b.z0, b.z1).map((z) => [b.x0, z]), alongX: false, out: 'west' },
    { cells: range(b.z0, b.z1).map((z) => [b.x1, z]), alongX: false, out: 'east' },
    { cells: range(b.x0, b.x1).map((x) => [x, b.z0]), alongX: true, out: 'north' },
    { cells: range(b.x0, b.x1).map((x) => [x, b.z1]), alongX: true, out: 'south' }
  ];
}

// The side a single wall's posts or band stand out to.
function singleOut(part, where) {
  if (!part.facing) throw new PlanError(`${where}: proud on a single wall needs facing, the side it stands out to (north, south, east or west)`);
  if (!SIDES.includes(part.facing)) throw new PlanError(`${where}: facing is ${part.facing}, it is north, south, east or west`);
  return part.facing;
}

const isStairs = (name) => name.endsWith('_stairs');
const AXIS_BLOCK = /_log$|_wood$|_stem$|_hyphae$|basalt$|^bone_block$|_pillar$|^hay_block$|^bamboo_block$|^chain$|^iron_chain$|^muddy_mangrove_roots$|^deepslate$|^froglight$|_froglight$/;

// Whether a gable's ridge runs along x: as axis says, else along the longer side.
const ridgeAlongX = (part, w, d) => (part.axis ? part.axis === 'x' : w >= d);

// The old gable roof, kept as it was: stairs over the walls from..to (outer wall corners, dy is
// the layer just above the wall tops), the ridge along the longer side and an overhang all round.
// The ridge row gets slabs when the span is odd. fill closes the gable ends and the wall tops
// under the eaves. With E (the edge) the eave rows, the gable-end rows and the ridge are of E,
// and under an overhanging gable end an upside-down E stair sits in each step.
function gableRoof(part, put, S, fill, slabFor, alongX, E) {
  const { from, to } = part;
  const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
  const y0 = from.dy;
  const [ax0, ax1] = [Math.min(from.dx, to.dx), Math.max(from.dx, to.dx)];
  const [az0, az1] = [Math.min(from.dz, to.dz), Math.max(from.dz, to.dz)];
  // Work in (u, v): u runs along the ridge, v across it.
  const [u0, u1, v0, v1] = alongX ? [ax0, ax1, az0, az1] : [az0, az1, ax0, ax1];
  const at = (u, y, v, mat, make) => (alongX ? put(u, y, v, mat, make) : put(v, y, u, mat, make));
  const up = alongX ? ['south', 'north'] : ['east', 'west'];
  const stair = (facing, half = 'bottom') => (e) => blockText(e.name, { facing, half });
  const ridge = (e) => {
    const slab = slabFor(e.name);
    return slab ? blockText(slab, { type: 'bottom' }) : blockText(e.name, { facing: up[0], half: 'bottom' });
  };
  for (let k = 0; ; k++) {
    const a = v0 - o + k;
    const b = v1 + o - k;
    if (a > b) break;
    const y = y0 + k;
    for (let u = u0 - o; u <= u1 + o; u++) {
      const end = u === u0 - o || u === u1 + o;
      const M = E && (k === 0 || end || b - a <= 1) ? E : S;
      if (a === b) at(u, y, a, M, ridge);
      else {
        at(u, y, a, M, stair(up[0]));
        at(u, y, b, M, stair(up[1]));
        if (E && end && o > 0 && k > 0) {
          at(u, y - 1, a, E, stair(up[1], 'top'));
          at(u, y - 1, b, E, stair(up[0], 'top'));
        }
      }
    }
    if (fill) {
      for (let v = Math.max(v0, a + 1); v <= Math.min(v1, b - 1); v++) {
        at(u0, y, v, fill);
        at(u1, y, v, fill);
      }
    }
  }
  if (fill) {
    for (let y = y0; y < y0 + o; y++) {
      for (let u = u0; u <= u1; u++) {
        at(u, y, v0, fill);
        at(u, y, v1, fill);
      }
    }
  }
}

// The other roofs. Each step of the slope is a ring (hip, pyramid) or a row (gable, shed) of
// stairs; with pitch 2 a full block goes under each stair after the eave row, so it climbs two
// for one. A ridge or point gets slabs. fill closes the walls up to the underside of the roof.
function slopedRoof(part, put, S, fill, ctx, where, E) {
  const b = boxOf({ ...part, to: { ...part.to, dy: part.from.dy } });
  const y0 = part.from.dy;
  const style = part.style;
  const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
  const pitch = part.pitch ?? 1;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  if (style === 'pyramid' && w !== d) throw new PlanError(`${where}: style pyramid needs a square box, this one is ${w + 1} by ${d + 1}; use hip for a ridge`);
  const full = (e) => {
    const name = isStairs(e.name) ? ctx.formName(e.name, 'block') : e.name;
    if (!name) throw new PlanError(`${where}: this roof needs the full block of ${e.name} (under steep stairs, or for the top where there is no slab), and there is none; use another stairs block`);
    return name;
  };
  const stair = (facing, half = 'bottom') => (e) => (isStairs(e.name) ? blockText(e.name, { facing, half }) : e.name);
  const cap = (e) => {
    const slab = isStairs(e.name) ? ctx.slabFor(e.name) : null;
    return slab ? blockText(slab, { type: 'bottom' }) : full(e);
  };
  const slab = (type) => (e) => blockText(slabOf(e.name, ctx, where), { type });
  const low = new Map();
  const mark = (x, y, z) => {
    const key = `${x},${z}`;
    if (!low.has(key) || low.get(key) > y) low.set(key, y);
  };
  // One roof cell k steps up: its stair (or cap) and, steep, the block under it; at half pitch a
  // bottom slab, then a top slab one step on. frame puts it in the edge material.
  const step = (x, z, k, make, frame = false) => {
    const M = frame && E ? E : S;
    if (pitch === 0.5) {
      const y = y0 + Math.floor(k / 2);
      put(x, y, z, M, slab(k % 2 ? 'top' : 'bottom'));
      mark(x, y, z);
      return;
    }
    const y = pitch === 2 && k > 0 ? y0 + 2 * k : y0 + k;
    if (pitch === 2 && k > 0) {
      put(x, y - 1, z, M, full);
      mark(x, y - 1, z);
    }
    put(x, y, z, M, make);
    mark(x, y, z);
  };
  // Under an overhanging gable end, an upside-down edge stair in the step below cell k.
  const underStep = (x, z, k, facing) => {
    if (!E || o === 0 || k === 0 || pitch === 0.5) return;
    put(x, pitch === 2 ? y0 + 2 * k - 2 : y0 + k - 1, z, E, stair(facing, 'top'));
  };

  if (style === 'shed') {
    if (!part.facing) throw new PlanError(`${where}: style shed needs facing, the way the roof climbs (north, south, east or west)`);
    if (!SIDES.includes(part.facing)) throw new PlanError(`${where}: facing is ${part.facing}, it is north, south, east or west`);
    const [fx, fz] = OUTWARD[part.facing];
    const alongZ = fx !== 0;
    // v climbs, u runs along each row.
    const [u0, u1] = alongZ ? [b.z0 - o, b.z1 + o] : [b.x0 - o, b.x1 + o];
    const [v0, v1] = alongZ ? [b.x0 - o, b.x1 + o] : [b.z0 - o, b.z1 + o];
    const dir = alongZ ? fx : fz;
    const start = dir > 0 ? v0 : v1;
    for (let k = 0; k <= v1 - v0; k++) {
      const v = start + dir * k;
      for (let u = u0; u <= u1; u++) {
        const side = u === u0 || u === u1;
        step(alongZ ? v : u, alongZ ? u : v, k, stair(part.facing), k === 0 || k === v1 - v0 || side);
        if (side) underStep(alongZ ? v : u, alongZ ? u : v, k, OPPOSITE[part.facing]);
      }
    }
  } else if (style === 'gable') {
    const alongX = ridgeAlongX(part, w, d);
    const [u0, u1] = alongX ? [b.x0 - o, b.x1 + o] : [b.z0 - o, b.z1 + o];
    const [v0, v1] = alongX ? [b.z0, b.z1] : [b.x0, b.x1];
    const up = alongX ? ['south', 'north'] : ['east', 'west'];
    for (let k = 0; ; k++) {
      const a = v0 - o + k;
      const c = v1 + o - k;
      if (a > c) break;
      for (let u = u0; u <= u1; u++) {
        const end = u === u0 || u === u1;
        const frame = k === 0 || end || c - a <= 1;
        const at = (v, make) => step(alongX ? u : v, alongX ? v : u, k, make, frame);
        if (a === c) at(a, cap);
        else {
          at(a, stair(up[0]));
          at(c, stair(up[1]));
          if (end) {
            underStep(alongX ? u : a, alongX ? a : u, k, up[1]);
            underStep(alongX ? u : c, alongX ? c : u, k, up[0]);
          }
        }
      }
    }
  } else {
    // hip and pyramid: rings stepping in, the corners turned like the ends so the game makes
    // them outer corners.
    const alongX = w >= d;
    for (let k = 0; ; k++) {
      const xa = b.x0 - o + k;
      const xb = b.x1 + o - k;
      const za = b.z0 - o + k;
      const zb = b.z1 + o - k;
      if (xa > xb || za > zb) break;
      if (xa === xb || za === zb) {
        for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) step(x, z, k, cap, true);
        continue;
      }
      for (let x = xa; x <= xb; x++) {
        for (let z = za; z <= zb; z++) {
          const west = x === xa;
          const east = x === xb;
          const north = z === za;
          const south = z === zb;
          if (!west && !east && !north && !south) continue;
          let facing;
          if ((west || east) && (north || south)) facing = alongX ? (west ? 'east' : 'west') : (north ? 'south' : 'north');
          else if (west) facing = 'east';
          else if (east) facing = 'west';
          else if (north) facing = 'south';
          else facing = 'north';
          step(x, z, k, stair(facing), k === 0 || ((west || east) && (north || south)) || xb - xa <= 1 || zb - za <= 1);
        }
      }
    }
  }

  if (fill) {
    for (const line of wallLines(b)) {
      for (const [x, z] of line.cells) {
        const top = low.get(`${x},${z}`) ?? y0;
        for (let y = y0; y < top; y++) put(x, y, z, fill);
      }
    }
  }
}

// A flat roof: a deck of the full block over the walls, upside-down stairs round it for the
// overhang (or the full block when the roof block is no stairs), and a parapet one block high
// round the edge of fill (the deck block when there is no fill).
function flatRoof(part, put, S, fill, ctx, E) {
  const b = boxOf({ ...part, to: { ...part.to, dy: part.from.dy } });
  const y0 = part.from.dy;
  const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
  const full = (e) => (isStairs(e.name) ? ctx.formName(e.name, 'block') ?? e.name : e.name);
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      const rim = o === 0 && E && (x === b.x0 || x === b.x1 || z === b.z0 || z === b.z1);
      put(x, y0, z, rim ? E : S, full);
    }
  }
  for (let r = 1; r <= o; r++) {
    for (const line of wallLines({ x0: b.x0 - r, x1: b.x1 + r, z0: b.z0 - r, z1: b.z1 + r })) {
      const facing = OPPOSITE[line.out];
      for (const [x, z] of line.cells) put(x, y0, z, r === o && E ? E : S, (e) => (isStairs(e.name) ? blockText(e.name, { facing, half: 'top' }) : e.name));
    }
  }
  for (const line of wallLines({ x0: b.x0 - o, x1: b.x1 + o, z0: b.z0 - o, z1: b.z1 + o })) {
    for (const [x, z] of line.cells) put(x, y0 + 1, z, fill ?? S, fill ? asText : full);
  }
}

// The slab of a roof block, for half pitch: a stairs block's own slab, else the block's slab form.
function slabOf(name, ctx, where) {
  const viaStairs = isStairs(name) ? ctx.slabFor(name) : null;
  const slab = viaStairs && ctx.known(viaStairs) ? viaStairs : name.endsWith('_slab') ? name : ctx.formName(name, 'slab');
  if (!slab) throw new PlanError(`${where}: pitch 0.5 is made of slabs, and ${name} has no slab form; use a block that has one`);
  return slab;
}

// A roof's edge material, each block as its stairs form so the roof's own steps, caps and slabs
// come from it as they do from the roof block.
function edgeMaterial(mat, ctx, where) {
  const out = mat.map((e) => {
    if (isStairs(e.name)) return e;
    const stairs = ctx.formName(e.name, 'stairs');
    if (!stairs) throw new PlanError(`${where}, edge: ${e.name} has no stairs form for the roof's edge; use a block that has one`);
    return { ...e, name: stairs, props: {}, text: undefined };
  });
  out.salt = mat.salt;
  out.scatter = mat.scatter;
  return out;
}

function roofShape(part, put, mat, ctx, where) {
  const style = part.style ?? 'gable';
  if (!ROOF_STYLES.includes(style)) throw new PlanError(`${where}: style is ${style}, it is one of ${ROOF_STYLES.join(', ')}`);
  if (part.pitch !== undefined && ![0.5, 1, 2].includes(part.pitch)) throw new PlanError(`${where}: pitch is ${part.pitch}, it is 0.5, 1 or 2`);
  if (style === 'flat' && part.pitch !== undefined) throw new PlanError(`${where}: a flat roof has no pitch, take pitch out`);
  if (part.facing !== undefined && style !== 'shed') throw new PlanError(`${where}: facing is only for style shed (the way it climbs), take it out of a ${style} roof`);
  if (part.axis !== undefined) {
    if (style !== 'gable') throw new PlanError(`${where}: axis sets the ridge of a gable roof and does nothing on a ${style} roof${style === 'shed' ? ' (facing sets the way it climbs)' : ''}, take it out`);
    if (part.axis !== 'x' && part.axis !== 'z') throw new PlanError(`${where}: axis is ${part.axis}, a gable's ridge runs along x or z`);
  }
  const S = mat('block');
  const fill = part.fill ? mat('fill') : null;
  const E = part.edge ? edgeMaterial(mat('edge'), ctx, where) : null;
  const b = boxOf(part);
  const flat = { ...part, style, from: { dx: b.x0, dy: part.from.dy, dz: b.z0 }, to: { dx: b.x1, dy: part.from.dy, dz: b.z1 } };
  if (style === 'gable' && (part.pitch ?? 1) === 1) gableRoof(flat, put, S, fill, ctx.slabFor, ridgeAlongX(part, b.x1 - b.x0, b.z1 - b.z0), E);
  else if (style === 'flat') flatRoof(flat, put, S, fill, ctx, E);
  else slopedRoof(flat, put, S, fill, ctx, where, E);
}

const AXES = ['x', 'y', 'z'];

function roundShape(part, put, mat, ctx, where) {
  const b = boxOf(part);
  const M = mat('block');
  const hollow = part.hollow === true;
  const X = half(b.x0, b.x1);
  const Y = half(b.y0, b.y1);
  const Z = half(b.z0, b.z1);
  const sq = (v, a) => ((v - a.c) / a.r) ** 2;
  const all = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const noDown = all.filter(([, fy]) => fy !== -1);
  switch (part.shape) {
    case 'circle': {
      const axis = part.axis ?? 'y';
      if (!AXES.includes(axis)) throw new PlanError(`${where}: axis is ${axis}, it is x, y or z`);
      const inside = (x, y, z) => inBox(b, x, y, z) && (axis === 'x' ? sq(y, Y) + sq(z, Z) : axis === 'y' ? sq(x, X) + sq(z, Z) : sq(x, X) + sq(y, Y)) <= 1;
      const faces = all.filter((f) => f[AXES.indexOf(axis)] === 0);
      solid(b, inside, put, M, { hollow, faces });
      break;
    }
    case 'sphere':
      solid(b, (x, y, z) => inBox(b, x, y, z) && sq(x, X) + sq(y, Y) + sq(z, Z) <= 1, put, M, { hollow });
      break;
    case 'dome': {
      const ry = { c: b.y0, r: b.y1 - b.y0 + 0.5 };
      solid(b, (x, y, z) => inBox(b, x, y, z) && sq(x, X) + sq(y, ry) + sq(z, Z) <= 1, put, M, { hollow, faces: noDown });
      break;
    }
    case 'cone': {
      const h = b.y1 - b.y0 + 1;
      const inside = (x, y, z) => {
        if (!inBox(b, x, y, z)) return false;
        const f = 1 - (y - b.y0) / h;
        return ((x - X.c) / (X.r * f)) ** 2 + ((z - Z.c) / (Z.r * f)) ** 2 <= 1;
      };
      solid(b, inside, put, M, { hollow, faces: noDown });
      break;
    }
    case 'pyramid': {
      const inside = (x, y, z) => {
        const k = y - b.y0;
        return y >= b.y0 && y <= b.y1 && x >= b.x0 + k && x <= b.x1 - k && z >= b.z0 + k && z <= b.z1 - k;
      };
      solid(b, inside, put, M, { hollow, faces: noDown });
      break;
    }
  }
}

// The way through an arch when the part gives none: through the wall earlier parts put round
// it (the side whose flanks are filled runs along the wall), else through the box's thin side.
function archAxis(b, ctx) {
  const filled = (x, y, z) => (ctx.sofar?.out.has(`${x},${y},${z}`) ? 1 : 0);
  let xs = 0;
  let zs = 0;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let z = b.z0; z <= b.z1; z++) xs += filled(b.x0 - 1, y, z) + filled(b.x1 + 1, y, z);
    for (let x = b.x0; x <= b.x1; x++) zs += filled(x, y, b.z0 - 1) + filled(x, y, b.z1 + 1);
  }
  const xShare = xs / (b.z1 - b.z0 + 1);
  const zShare = zs / (b.x1 - b.x0 + 1);
  if (xShare !== zShare) return xShare > zShare ? 'z' : 'x';
  return b.x1 - b.x0 >= b.z1 - b.z0 ? 'z' : 'x';
}

// An arch: the shape of an arched opening, full width up to the spring line and then a curve
// that rises rise blocks to the top of the box. Made of air it cuts a doorway or the hole under a
// bridge; hollow gives only its edge, the legs and the curve, one block thick across. Unless
// stepped, each step of the curve is smoothed with an upside-down stair, its low side away from
// the middle: made of air, the block an earlier part put there turns into its stairs; hollow,
// the edge's own block does. Stepped, a 3 wide arch rises 1 so it has no one-block notch.
function archShape(part, put, mat, ctx, where) {
  const b = boxOf(part);
  const M = mat('block');
  let axis = part.axis;
  if (axis === undefined) axis = archAxis(b, ctx);
  if (axis !== 'x' && axis !== 'z') throw new PlanError(`${where}: axis is ${axis}, an arch runs through x or z`);
  const [s0, s1] = axis === 'z' ? [b.x0, b.x1] : [b.z0, b.z1];
  const span = s1 - s0 + 1;
  const height = b.y1 - b.y0 + 1;
  const stepped = part.stepped === true;
  const rise = Math.min(intOr(part.rise, stepped && span <= 3 ? 1 : Math.ceil(span / 2), where, 'rise', 0), height);
  const spring = b.y1 - rise;
  const c = (s0 + s1) / 2;
  const inside = (x, y, z) => {
    if (!inBox(b, x, y, z)) return false;
    if (y <= spring) return true;
    const s = axis === 'z' ? x : z;
    return ((s - c) / (span / 2)) ** 2 + ((y - spring) / (rise + 0.5)) ** 2 <= 1;
  };
  const faces = (axis === 'z' ? [[1, 0, 0], [-1, 0, 0]] : [[0, 0, 1], [0, 0, -1]]).concat([[0, 1, 0]]);
  const hollow = part.hollow === true;
  solid(b, inside, put, M, { hollow, faces });
  const cut = M.every((e) => e.name === 'air');
  if (stepped || (!cut && !hollow)) return;
  const edge = (x, y, z) => inside(x, y, z) && faces.some(([fx, fy, fz]) => !inside(x + fx, y + fy, z + fz));
  const open = cut ? inside : (x, y, z) => inside(x, y, z) && !edge(x, y, z);
  for (let x = b.x0; x <= b.x1; x++) {
    for (let y = spring + 1; y <= b.y1; y++) {
      for (let z = b.z0; z <= b.z1; z++) {
        const s = axis === 'z' ? x : z;
        if (s === c || open(x, y, z) || (!cut && !edge(x, y, z))) continue;
        const toward = s < c ? 1 : -1;
        if (!open(x, y - 1, z) || !(axis === 'z' ? open(x + toward, y, z) : open(x, y, z + toward))) continue;
        const facing = axis === 'z' ? (s < c ? 'west' : 'east') : (s < c ? 'north' : 'south');
        if (cut) {
          const before = ctx.sofar?.out.get(`${x},${y},${z}`);
          if (!before) continue;
          const name = parseBlock(before.block).name;
          const stairs = isStairs(name) ? name : ctx.formName(name, 'stairs');
          if (stairs) put(x, y, z, [{ name: stairs, props: {}, w: 1 }], () => blockText(stairs, { facing, half: 'top' }));
        } else {
          put(x, y, z, M, (e) => {
            const stairs = isStairs(e.name) ? e.name : ctx.formName(e.name, 'stairs');
            return stairs ? blockText(stairs, { facing, half: 'top' }) : asText(e);
          });
        }
      }
    }
  }
}

// A staircase from from to to, one up for each block across, stairs facing the way up and as
// wide as the box across. fill fills under each step down to the bottom.
function staircaseShape(part, put, mat, ctx, where) {
  const { from, to } = part;
  const rise = to.dy - from.dy;
  const ddx = to.dx - from.dx;
  const ddz = to.dz - from.dz;
  if (rise === 0) throw new PlanError(`${where}: from and to are at the same height, a staircase climbs from one to the other`);
  if (ddx === 0 && ddz === 0) throw new PlanError(`${where}: from and to are one above the other, a staircase needs them apart across`);
  const alongX = Math.abs(ddx) >= Math.abs(ddz);
  const run = alongX ? ddx : ddz;
  if (Math.abs(run) !== Math.abs(rise)) throw new PlanError(`${where}: from and to are ${Math.abs(run)} apart across but ${Math.abs(rise)} apart in height; a staircase climbs one for each block across`);
  const M = mat('block');
  const fill = part.fill ? mat('fill') : null;
  const dir = Math.sign(run);
  const climbs = Math.sign(rise) * dir;
  const facing = alongX ? (climbs > 0 ? 'east' : 'west') : (climbs > 0 ? 'south' : 'north');
  const widths = alongX ? range(from.dz, to.dz) : range(from.dx, to.dx);
  const bottom = Math.min(from.dy, to.dy);
  const make = (e) => (isStairs(e.name) ? blockText(e.name, { ...e.props, facing, half: 'bottom' }) : asText(e));
  for (let i = 0; i <= Math.abs(run); i++) {
    const a = (alongX ? from.dx : from.dz) + dir * i;
    const y = from.dy + Math.sign(rise) * i;
    for (const w of widths) {
      const [x, z] = alongX ? [a, w] : [w, a];
      if (fill) for (let fy = bottom; fy < y; fy++) put(x, fy, z, fill);
      put(x, y, z, M, make);
    }
  }
}

// Spots along a line of length cells, spread evenly about every apart, both ends included.
function spread(length, every) {
  if (length <= 1) return [0];
  const n = Math.max(1, Math.round((length - 1) / every));
  return [...new Set(range(0, n).map((k) => Math.round((k * (length - 1)) / n)))];
}

// Posts at the corners and about every blocks along each wall, the height of the box: both ends
// and evenly between, (length - 1) / every gaps rounded. Proud, they stand one block out from the
// wall, the corners two blocks square. A post touching one an earlier posts part put up (two
// walls' posts meeting at a corner) is left out.
function postsShape(part, put, mat, ctx, where) {
  const b = boxOf(part);
  const M = mat('block');
  const every = intOr(part.every, 4, where, 'every');
  const lines = wallLines(b);
  const single = lines.length === 1;
  if (part.facing !== undefined && !(single && part.proud)) throw new PlanError(`${where}: facing on posts is only for proud on a single wall (a box one block thick), take it out`);
  const taken = (x, z) => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if ((i || j) && ctx.posts?.near(x + i, z + j, b.y0, b.y1)) return true;
      }
    }
    return false;
  };
  const column = (x, z) => {
    if (taken(x, z)) return;
    for (let y = b.y0; y <= b.y1; y++) put(x, y, z, M);
  };
  for (const line of lines) {
    const out = part.proud ? line.out ?? singleOut(part, where) : null;
    const spots = spread(line.cells.length, every);
    for (const i of spots) {
      const [x, z] = line.cells[i];
      const end = i === 0 || i === line.cells.length - 1;
      if (!out) column(x, z);
      else if (end && line.out) {
        const [ox, oz] = [x === b.x0 ? -1 : 1, z === b.z0 ? -1 : 1];
        column(x, z);
        column(x + ox, z);
        column(x, z + oz);
        column(x + ox, z + oz);
      } else column(x + OUTWARD[out][0], z + OUTWARD[out][1]);
    }
  }
}

// Windows width wide and the height of the box along each wall: as many as fit every apart
// (start to start), or every + 1 where that fits more, mirrored about the wall's middle and at
// least two blocks from each corner. A window is left out where the plan has a door or an
// earlier air opening in its columns from 3 below it to its top, or an earlier post stands just
// outside it.
function windowsShape(part, put, mat, ctx, where) {
  const b = boxOf(part);
  const M = mat('block');
  const width = intOr(part.width, 1, where, 'width');
  const every = intOr(part.every, width + 2, where, 'every');
  if (every < width) throw new PlanError(`${where}: every is ${every}, less than the width ${width}, so the windows would overlap`);
  const opening = ctx.openings?.(b.y0 - 3, b.y1) ?? new Set();
  let any = false;
  for (const line of wallLines(b)) {
    const L = line.cells.length;
    let best = null;
    for (const gap of [every, every + 1]) {
      for (let n = Math.floor((L - 4 - width) / gap) + 1; n >= 1; n--) {
        const span = (n - 1) * gap + width;
        if ((L - span) % 2 !== 0 || (L - span) / 2 < 2) continue;
        if (!best || n > best.n) best = { n, gap, span };
        break;
      }
    }
    if (!best) continue;
    any = true;
    const start = (L - best.span) / 2;
    const sides = line.out ? [OUTWARD[line.out]] : line.alongX ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
    for (let k = 0; k < best.n; k++) {
      const cols = range(0, width - 1).map((i) => line.cells[start + k * best.gap + i]);
      if (cols.some(([x, z]) => opening.has(`${x},${z}`) || sides.some(([ox, oz]) => ctx.posts?.near(x + ox, z + oz, b.y0, b.y1)))) continue;
      for (const [x, z] of cols) for (let y = b.y0; y <= b.y1; y++) put(x, y, z, M);
    }
  }
  if (!any) throw new PlanError(`${where}: the walls are too short for windows ${width} wide, mirrored about the middle and two blocks from each corner`);
}

// A band of trim round the walls at the height of the box. Logs lie along each wall, and stairs
// face the wall (upside down unless half is given), both only where the block gives no state of
// its own. Proud, it goes one block out from the walls. Stairs given half=bottom make an upright
// cap sloping up to the wall, the top of a base course.
function bandShape(part, put, mat, ctx, where) {
  let b = boxOf(part);
  const M = mat('block');
  if (part.facing !== undefined && b.x0 !== b.x1 && b.z0 !== b.z1) throw new PlanError(`${where}: facing on a band is only for a single wall (a box one block thick), take it out`);
  if (part.proud) {
    if (b.x0 === b.x1 || b.z0 === b.z1) {
      const [ox, oz] = OUTWARD[singleOut(part, where)];
      b = { ...b, x0: b.x0 + ox, x1: b.x1 + ox, z0: b.z0 + oz, z1: b.z1 + oz };
    } else b = { ...b, x0: b.x0 - 1, x1: b.x1 + 1, z0: b.z0 - 1, z1: b.z1 + 1 };
  }
  for (const line of wallLines(b)) {
    const out = line.out ?? (part.facing && SIDES.includes(part.facing) ? part.facing : null);
    const make = (e) => {
      const own = { ...e.props };
      if (isStairs(e.name) && out) {
        own.facing ??= OPPOSITE[out];
        own.half ??= 'top';
      } else if (AXIS_BLOCK.test(e.name)) own.axis ??= line.alongX ? 'x' : 'z';
      return blockText(e.name, own);
    };
    for (const [x, z] of line.cells) for (let y = b.y0; y <= b.y1; y++) put(x, y, z, M, make);
  }
}

// The six shapes build_structure always had.
function boxShape(part, put, mat) {
  const { from, to = from } = part;
  const block = mat('block');
  const xs = range(from.dx, to.dx);
  const ys = range(from.dy, to.dy);
  const zs = range(from.dz, to.dz);
  const [x0, x1, y0, y1, z0, z1] = [xs[0], xs.at(-1), ys[0], ys.at(-1), zs[0], zs.at(-1)];
  if (part.shape === 'line') {
    const steps = Math.max(Math.abs(to.dx - from.dx), Math.abs(to.dy - from.dy), Math.abs(to.dz - from.dz));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      put(Math.round(from.dx + (to.dx - from.dx) * t), Math.round(from.dy + (to.dy - from.dy) * t), Math.round(from.dz + (to.dz - from.dz) * t), block);
    }
    return;
  }
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const sideX = x === x0 || x === x1;
        const sideZ = z === z0 || z === z1;
        const sideY = y === y0 || y === y1;
        const keep = {
          fill: true,
          hollow: sideX || sideZ || sideY,
          walls: sideX || sideZ,
          frame: (sideX && sideZ) || (sideX && sideY) || (sideZ && sideY)
        }[part.shape ?? 'fill'];
        if (keep) put(x, y, z, block);
      }
    }
  }
}

const MAKERS = {
  fill: boxShape, hollow: boxShape, walls: boxShape, frame: boxShape, line: boxShape,
  roof: roofShape,
  circle: roundShape, sphere: roundShape, dome: roundShape, cone: roundShape, pyramid: roundShape,
  arch: archShape, staircase: staircaseShape, posts: postsShape, windows: windowsShape, band: bandShape,
  kit: kitShape
};

// The mirror planes a part is copied across: its own, else the plan's, per axis. { x: 8 } copies
// a block at dx to 8 - dx.
function mirrorsOf(own, plan, where) {
  const out = {};
  for (const axis of ['x', 'z']) {
    const at = own?.[axis] ?? plan?.[axis];
    if (at === undefined || at === null) continue;
    if (!Number.isInteger(at)) throw new PlanError(`${where}: mirror ${axis} is ${at}, it must be a whole number (dx or dz + its mirror image)`);
    out[axis] = at;
  }
  return out;
}

// How many times a part's cells are laid down, for the size check before expanding. once keeps
// a part out of the plan's mirror.
export function partCopies(part, planMirror) {
  const count = Number.isInteger(part.repeat?.count) && part.repeat.count > 1 ? part.repeat.count : 1;
  let mirrors = 0;
  for (const axis of ['x', 'z']) if (Number.isInteger(part.mirror?.[axis] ?? (part.once ? undefined : planMirror?.[axis]))) mirrors++;
  return count * 2 ** mirrors;
}

// The positions a single cell is laid at under mirror, itself first.
function mirrorSpots(dx, dz, mirror) {
  const spots = [[dx, dz]];
  if (mirror.x !== undefined) spots.push([mirror.x - dx, dz]);
  if (mirror.z !== undefined) spots.push([dx, mirror.z - dz]);
  if (mirror.x !== undefined && mirror.z !== undefined) spots.push([mirror.x - dx, mirror.z - dz]);
  return spots;
}

// Lays one part's cells into out: the repeats first, each shifted by the step, then the mirror
// images of whatever spots the part doesn't fill itself. A mix picks by the final spot. Returns
// the cells laid.
function commit(out, cells, { repeat, mirror, where, air }) {
  let laid = cells;
  if (repeat) {
    const count = intOr(repeat.count, 1, where, 'repeat count');
    const [rx, ry, rz] = [repeat.dx ?? 0, repeat.dy ?? 0, repeat.dz ?? 0];
    if (count > 1) {
      laid = new Map();
      for (let i = 0; i < count; i++) {
        for (const c of cells.values()) {
          const moved = { ...c, dx: c.dx + rx * i, dy: c.dy + ry * i, dz: c.dz + rz * i };
          const key = `${moved.dx},${moved.dy},${moved.dz}`;
          laid.delete(key);
          laid.set(key, moved);
        }
      }
    }
  }
  const all = [...laid.values()];
  const taken = new Set(laid.keys());
  const flips = [];
  if (mirror.x !== undefined) flips.push(['x']);
  if (mirror.z !== undefined) flips.push(['z']);
  if (mirror.x !== undefined && mirror.z !== undefined) flips.push(['x', 'z']);
  for (const axes of flips) {
    for (const c of laid.values()) {
      const dx = axes.includes('x') ? mirror.x - c.dx : c.dx;
      const dz = axes.includes('z') ? mirror.z - c.dz : c.dz;
      const key = `${dx},${c.dy},${dz}`;
      if (taken.has(key)) continue;
      taken.add(key);
      all.push({ ...c, dx, dz, flip: axes });
    }
  }
  const done = [];
  for (const c of all) {
    let block = c.make(pick(c.mat, c.dx, c.dy, c.dz));
    if (c.flip) {
      const { name, props } = parseBlock(block);
      let turned = props;
      for (const axis of c.flip) turned = mirrorState(turned, axis);
      if (turned.facing !== props.facing) block = blockText(name, turned);
    }
    const key = `${c.dx},${c.dy},${c.dz}`;
    out.delete(key);
    air.delete(key);
    if (parseBlock(block).name !== 'air') out.set(key, { dx: c.dx, dy: c.dy, dz: c.dz, block });
    else air.set(key, { dx: c.dx, dy: c.dy, dz: c.dz });
    done.push({ dx: c.dx, dy: c.dy, dz: c.dz, block });
  }
  return done;
}

// The fields every part takes, and the ones each shape uses besides; any other field given is
// refused rather than quietly left unused. Kits check their own.
const COMMON = ['shape', 'from', 'to', 'block', 'repeat', 'mirror', 'once'];
const USES = {
  fill: [], hollow: [], walls: [], frame: [], line: [],
  roof: ['fill', 'overhang', 'style', 'pitch', 'facing', 'axis', 'edge'],
  circle: ['axis', 'hollow'], sphere: ['hollow'], dome: ['hollow'], cone: ['hollow'], pyramid: ['hollow'],
  arch: ['axis', 'hollow', 'rise', 'stepped'], staircase: ['fill'], posts: ['every', 'proud', 'facing'],
  windows: ['width', 'every'], band: ['proud', 'facing']
};

function checkFields(part, shape, where) {
  const uses = USES[shape];
  if (!uses) return;
  for (const [field, value] of Object.entries(part)) {
    if (COMMON.includes(field) || uses.includes(field) || value === undefined || value === null || value === false) continue;
    const by = Object.keys(USES).filter((s) => USES[s].includes(field));
    const kit = ['kind', 'variant', 'extra'].includes(field);
    throw new PlanError(`${where}: ${field} does nothing on ${shape}${by.length || kit ? ` (it is for ${kit ? 'kit' : [...new Set(by)].join(', ')})` : ''}, take it out`);
  }
}

// Turns a plan's parts and single blocks into single blocks, in order, so later parts win where
// they overlap. A part of "air" takes out what came before it there (doorways, windows); the
// spots it leaves empty are in the result's air (not enumerable, so the list compares as before).
// A part or block with once true is left out of the plan's mirror. Throws a PlanError naming the
// part when the plan can't be read.
export function expandShapes(parts = [], blocks = [], { slabFor = (s) => s.replace(/_stairs$/, '_slab'), palette, mirror, isKnownBlock = knownInGame } = {}) {
  const ctx = { palette: palette ?? {}, known: isKnownBlock, slabFor, formName: (name, form) => formName(name, form, isKnownBlock) };
  for (const [role, value] of Object.entries(ctx.palette)) {
    if (!ROLES.includes(role)) throw new PlanError(`palette: ${role} is not a role; the roles are ${ROLES.join(', ')}`);
    if (typeof value === 'string' && value.includes('@')) throw new PlanError(`palette ${role}: a role can't refer to another role, give block names`);
  }
  const out = new Map();
  const air = new Map();
  const planMirror = mirrorsOf(null, mirror, 'mirror');
  // Doors and air among the single blocks, which go in last but stand in the walls already for
  // the windows that are laid out before them.
  const marks = [];
  blocks.forEach((b, i) => {
    const names = material(b.block, ctx, `block ${i + 1} at ${b.dx} ${b.dy} ${b.dz}`).map((e) => e.name);
    const door = names.some((n) => n.endsWith('_door'));
    if (!door && !names.every((n) => n === 'air')) return;
    for (const [dx, dz] of mirrorSpots(b.dx, b.dz, b.once ? {} : planMirror)) marks.push({ dx, dy: b.dy, dz, door });
  });
  // Post columns of the posts parts so far, by x,z, each with the heights it covers.
  const postCells = new Map();
  ctx.sofar = { out, air };
  ctx.posts = {
    near: (x, z, y0, y1) => (postCells.get(`${x},${z}`) ?? []).some((y) => y >= y0 && y <= y1)
  };
  // The x,z of every column with a door, or air from the parts so far, between y0 and y1.
  ctx.openings = (y0, y1) => {
    const cols = new Set();
    for (const c of out.values()) if (c.dy + 1 >= y0 && c.dy <= y1 && parseBlock(c.block).name.endsWith('_door')) cols.add(`${c.dx},${c.dz}`);
    for (const c of air.values()) if (c.dy >= y0 && c.dy <= y1) cols.add(`${c.dx},${c.dz}`);
    for (const m of marks) if ((m.door ? m.dy + 1 >= y0 : m.dy >= y0) && m.dy <= y1) cols.add(`${m.dx},${m.dz}`);
    return cols;
  };
  parts.forEach((part, i) => {
    const shape = part.shape ?? 'fill';
    const where = `part ${i + 1} (${shape})`;
    const make = MAKERS[shape];
    if (!make) throw new PlanError(`${where}: shape is ${shape}, it is one of ${SHAPES.join(', ')}`);
    checkFields(part, shape, where);
    const { cells, put } = cellSet();
    const cache = {};
    const mat = (field) => (cache[field] ??= material(part[field], ctx, `${where}, ${field}`));
    make(part, put, mat, ctx, where);
    const laid = commit(out, cells, { repeat: part.repeat, mirror: mirrorsOf(part.mirror, part.once ? null : mirror, where), where, air });
    if (shape === 'posts') {
      for (const c of laid) {
        if (parseBlock(c.block).name === 'air') continue;
        const key = `${c.dx},${c.dz}`;
        if (!postCells.has(key)) postCells.set(key, []);
        postCells.get(key).push(c.dy);
      }
    }
  });
  blocks.forEach((b, i) => {
    const where = `block ${i + 1} at ${b.dx} ${b.dy} ${b.dz}`;
    const { cells, put } = cellSet();
    put(b.dx, b.dy, b.dz, material(b.block, ctx, where));
    commit(out, cells, { mirror: b.once ? {} : planMirror, where, air });
  });
  return Object.defineProperty([...out.values()], 'air', { value: [...air.values()] });
}