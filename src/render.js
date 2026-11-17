import { deflateSync } from 'node:zlib';
import { parseBlock } from './actions/states.js';
import { blockStyle, shapeOf } from './blockcolors.js';

// Draws a list of blocks as pictures: isometric views from the four corners, a plan from above
// and straight-on elevations. Every block becomes one or more boxes inside its cell, the faces
// of the boxes are drawn with a depth buffer, and see-through faces are blended on top far to
// near. No textures: flat colours with light procedural patterns and dark edge lines.

const BACKGROUND = [240, 238, 232];
const GROUND = [214, 211, 202];
const MARGIN = 14;
// Pixels per block at most, so a small build is drawn large but not huge.
const MAX_BLOCK = 64;
// How far muted cells (the world round a plan) are blended toward the background.
const MUTE = 0.5;

// +x, -x, +y, -y, +z, -z.
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const AXIS = [0, 0, 1, 1, 2, 2];
const SIGN = [1, -1, 1, -1, 1, -1];
// The two axes lying in a face, per face axis: the first runs across, the second is y on side
// faces (so patterns have rows) and z on top faces.
const PLANE_A = [2, 0, 0];
const PLANE_B = [1, 2, 1];
// Same light in every view: top brightest, faces along z lighter than faces along x.
const SHADE = [0.68, 0.68, 1, 0.5, 0.84, 0.84];
const OPPOSITE = { east: 'west', west: 'east', south: 'north', north: 'south', up: 'down', down: 'up' };

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function camera(f, kind) {
  const fw = norm(f);
  const r = norm(cross(fw, [0, 1, 0]));
  return { f: fw, r, c: cross(r, fw), kind };
}
// Isometric from a corner, looking down at 30 degrees, so a block's top is twice as wide as tall.
const iso = (sx, sz) => camera([-sx, -Math.SQRT2 * Math.tan(Math.PI / 6), -sz], 'iso');
const CAMERAS = {
  'south-east': iso(1, 1),
  'south-west': iso(-1, 1),
  'north-east': iso(1, -1),
  'north-west': iso(-1, -1),
  top: { f: [0, -1, 0], r: [1, 0, 0], c: [0, 0, -1], kind: 'top' },
  south: camera([0, 0, -1], 'side'),
  north: camera([0, 0, 1], 'side'),
  east: camera([-1, 0, 0], 'side'),
  west: camera([1, 0, 0], 'side')
};

const P = {
  none: 0, noise: 1, cobble: 2, bricks: 3, stonebricks: 4, tiles: 5, polished: 6, chiseled: 7, cracked: 8, mossy: 9,
  mossy_bricks: 10, ore: 11, planks: 12, stripes: 13, pillar_side: 14, rings: 15, pillar_end: 16, grass: 17, wool: 18,
  leaves: 19, glazed: 20, books: 21
};

function hash(a, b, c) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const frac = (x) => x - Math.floor(x);
const tex = (h, w, n, seed) => hash(Math.floor(h * n), Math.floor(w * n), seed);

// Set by pattern() when the pixel takes the face's second colour (mortar, moss, ore, bark rim).
let alt = false;

// A brightness factor for a point on a face. h runs across the face, w along its rows (up on
// side faces), both in block units inside the cell; lw is one pixel in block units.
function pattern(p, h, w, seed, lw, vary) {
  alt = false;
  switch (p) {
    case P.noise: return 0.95 + tex(h, w, 16, seed) * 0.1;
    case P.wool: return 0.97 + tex(h, w, 16, seed) * 0.06;
    case P.cobble: {
      const r = Math.floor(w * 4);
      const x = h * 4 + (r & 1) * 0.5;
      return 0.8 + 0.34 * hash(Math.floor(x), r, seed);
    }
    case P.bricks: {
      const r = Math.floor(w * 4);
      const x = (h + (r & 1) * 0.25) * 2;
      if (frac(w * 4) < lw * 4 || frac(x) < lw * 2) {
        alt = true;
        return 1;
      }
      return 0.93 + 0.14 * hash(Math.floor(x), r, seed);
    }
    case P.stonebricks:
    case P.cracked:
    case P.mossy_bricks: {
      const r = Math.floor(w * 2);
      const x = h + (r & 1) * 0.5;
      if (frac(w * 2) < lw * 2 || frac(x) < lw) return 0.74;
      let m = 0.95 + 0.1 * hash(Math.floor(x), r, seed);
      // Cracks are a few thin dark specks and moss a few soft patches, as in game a mix reads
      // as gentle variation.
      if (p === P.cracked && tex(h, w, 16, seed) > 0.93) m *= 0.84;
      if (p === P.mossy_bricks && tex(h, w, 8, seed + 7) > 0.7) alt = true;
      return m;
    }
    case P.tiles: {
      if (frac(w * 2) < lw * 2 || frac(h * 2) < lw * 2) return 0.74;
      return 0.95 + 0.1 * hash(Math.floor(h * 2), Math.floor(w * 2), seed);
    }
    case P.polished: {
      const edge = 1 / 16;
      if (h < edge || h > 1 - edge || w < edge || w > 1 - edge) return 0.9;
      return 0.98 + tex(h, w, 16, seed) * 0.04;
    }
    case P.chiseled: {
      const d = Math.max(Math.abs(h - 0.5), Math.abs(w - 0.5));
      if (Math.abs(d - 0.3) < lw || Math.abs(d - 0.12) < lw) return 0.72;
      return 0.95 + tex(h, w, 16, seed) * 0.1;
    }
    case P.mossy: {
      if (tex(h, w, 8, seed + 7) > 0.65) alt = true;
      const r = Math.floor(w * 4);
      return 0.84 + 0.26 * hash(Math.floor(h * 4 + (r & 1) * 0.5), r, seed);
    }
    case P.ore: {
      if (tex(h, w, 8, seed + 3) > 0.8) alt = true;
      return 0.95 + tex(h, w, 16, seed) * 0.1;
    }
    case P.planks: {
      const r = Math.floor(w * 4);
      if (frac(w * 4) < lw * 4) return 0.76;
      const x = h + (r & 1) * 0.5;
      if (frac(x) < lw) return 0.8;
      return 0.95 + 0.1 * hash(Math.floor(x), r, seed);
    }
    case P.stripes: {
      const x = vary ? w : h;
      return 0.84 + 0.26 * hash(Math.floor(x * 8), 0, seed);
    }
    case P.pillar_side: {
      const x = vary ? w : h;
      return frac(x * 4) < lw * 4 ? 0.86 : 1;
    }
    case P.rings: {
      const d = Math.max(Math.abs(h - 0.5), Math.abs(w - 0.5));
      if (d > 0.42) {
        alt = true;
        return 1;
      }
      return Math.abs(d - 0.28) < lw || Math.abs(d - 0.13) < lw ? 0.8 : 1;
    }
    case P.pillar_end: return Math.max(Math.abs(h - 0.5), Math.abs(w - 0.5)) > 0.4 ? 0.88 : 1;
    case P.grass: {
      if (w > 0.75 + (tex(h, 0, 16, seed) > 0.5 ? 0.07 : 0)) alt = true;
      return 0.95 + tex(h, w, 16, seed) * 0.1;
    }
    case P.leaves: return 0.7 + tex(h, w, 8, seed) * 0.5;
    case P.glazed: {
      if (((Math.floor(h * 2) + Math.floor(w * 2)) & 1) === 1) alt = true;
      return Math.abs(h - w) < lw || Math.abs(h + w - 1) < lw ? 0.8 : 1;
    }
    case P.books: {
      const y = frac(w);
      if (y < 0.12 || (y > 0.44 && y < 0.56) || y > 0.9) return 0.85;
      alt = true;
      return 0.65 + 0.55 * hash(Math.floor(h * 6), Math.floor(w * 2), seed);
    }
    default: return 1;
  }
}

// A box hugging one side of the cell: t thick, from y0 to y1, and from a to b along the side.
function sideBox(side, t, y0, y1, a = 0, b = 1) {
  switch (side) {
    case 'east': return [1 - t, y0, a, 1, y1, b];
    case 'west': return [0, y0, a, t, y1, b];
    case 'south': return [a, y0, 1 - t, b, y1, 1];
    default: return [a, y0, 0, b, y1, t];
  }
}

// An arm from the middle of the cell out to one side, w wide either side of the middle.
function arm(side, w, y0, y1) {
  const lo = 0.5 - w;
  const hi = 0.5 + w;
  switch (side) {
    case 'east': return [0.5, y0, lo, 1, y1, hi];
    case 'west': return [0, y0, lo, 0.5, y1, hi];
    case 'south': return [lo, y0, 0.5, hi, y1, 1];
    default: return [lo, y0, 0, hi, y1, 0.5];
  }
}

const SIDES = ['east', 'west', 'south', 'north'];
const px = (n) => n / 16;
const STEP = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1], up: [0, 1, 0], down: [0, -1, 0] };
const STICK = [112, 82, 46];
const METAL = [58, 58, 62];
const PILLOW = [236, 236, 236];
const POT = [124, 68, 49];
const LATCH = [196, 196, 186];

// The boxes a block is drawn as, in cell units, with an optional colour of their own.
function boxesFor(c, at) {
  const { props } = c;
  const near = (side) => {
    const d = STEP[side];
    return at(c.x + d[0], c.y + d[1], c.z + d[2]);
  };
  const solidSide = () => SIDES.find((s) => near(s)?.solid);
  switch (c.shape) {
    case 'slab':
      if (props.type === 'double') return [{ b: [0, 0, 0, 1, 1, 1] }];
      return [{ b: props.type === 'top' ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1] }];
    case 'stairs': {
      const top = props.half === 'top';
      const f = SIDES.includes(props.facing) ? props.facing : 'north';
      const [y0, y1] = top ? [0, 0.5] : [0.5, 1];
      const base = { b: top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1] };
      const corner = stairCorner(c, f, near);
      if (!corner) return [base, { b: arm(f, 0.5, y0, y1) }];
      // Outer corners keep the quarter towards both facings, inner ones add it to the half step.
      const q = quarter(f, corner.side, y0, y1);
      if (corner.outer) return [base, { b: q }];
      return [base, { b: arm(f, 0.5, y0, y1) }, { b: quarter(OPPOSITE[f], corner.side, y0, y1) }];
    }
    case 'fence': {
      const out = [{ b: [px(6), 0, px(6), px(10), 1, px(10)] }];
      for (const s of SIDES) {
        const n = near(s);
        if (n && (n.solid || n.shape === 'fence' || n.shape === 'gate')) {
          out.push({ b: arm(s, px(1), px(6), px(9)) }, { b: arm(s, px(1), px(12), px(15)) });
        }
      }
      return out;
    }
    case 'wall': {
      const joins = SIDES.filter((s) => {
        const n = near(s);
        return n && (n.solid || n.shape === 'wall' || n.shape === 'pane' || n.shape === 'gate');
      });
      const straight = joins.length === 2 && OPPOSITE[joins[0]] === joins[1] && !near('up');
      const out = straight ? [] : [{ b: [0.25, 0, 0.25, 0.75, 1, 0.75] }];
      for (const s of joins) out.push({ b: arm(s, px(3), 0, px(14)) });
      return out;
    }
    case 'pane': {
      const out = [{ b: [px(7), 0, px(7), px(9), 1, px(9)] }];
      for (const s of SIDES) {
        const n = near(s);
        if (n && (n.solid || n.shape === 'pane' || n.shape === 'wall' || n.name.includes('glass'))) out.push({ b: arm(s, px(1), 0, 1) });
      }
      return out;
    }
    case 'gate': {
      const alongX = props.facing === 'north' || props.facing === 'south' || !props.facing;
      return [{ b: alongX ? [0, px(5), px(7), 1, px(15), px(9)] : [px(7), px(5), 0, px(9), px(15), 1] }];
    }
    case 'door': {
      if (props.half === 'upper' && at(c.x, c.y - 1, c.z)?.name === c.name) return [];
      const tall = props.half === 'upper' ? 1 : 2;
      if (SIDES.includes(props.facing)) return [{ b: sideBox(OPPOSITE[props.facing], px(3), 0, tall) }];
      // No facing given: stand it in the middle of the wall it sits in.
      const inX = near('east')?.solid || near('west')?.solid;
      return [{ b: inX ? [0, 0, px(6.5), 1, tall, px(9.5)] : [px(6.5), 0, 0, px(9.5), tall, 1] }];
    }
    case 'trapdoor': {
      if (props.open === 'true' && SIDES.includes(props.facing)) return [{ b: sideBox(OPPOSITE[props.facing], px(3), 0, 1) }];
      return [{ b: props.half === 'top' ? [0, px(13), 0, 1, 1, 1] : [0, 0, 0, 1, px(3), 1] }];
    }
    case 'torch':
      return [{ b: [px(7), 0, px(7), px(9), px(8), px(9)], color: STICK }, { b: [px(6.5), px(8), px(6.5), px(9.5), px(11), px(9.5)] }];
    case 'wall_torch': {
      const side = SIDES.includes(props.facing) ? OPPOSITE[props.facing] : solidSide() ?? 'north';
      const [x0, , z0, x1, , z1] = sideBox(side, px(3), 0, 1, px(7), px(9));
      return [{ b: [x0, px(3), z0, x1, px(11), z1], color: STICK }, { b: [x0, px(11), z0, x1, px(14), z1] }];
    }
    case 'lantern':
      if (props.hanging === 'true') {
        return [{ b: [px(5), px(2), px(5), px(11), px(9), px(11)] }, { b: [px(7), px(9), px(7), px(9), 1, px(9)], color: METAL }];
      }
      return [{ b: [px(5), 0, px(5), px(11), px(7), px(11)] }, { b: [px(6), px(7), px(6), px(10), px(9), px(10)], color: METAL }];
    case 'pot': {
      const out = [{ b: [px(5), 0, px(5), px(11), px(6), px(11)], color: POT }];
      if (c.name !== 'flower_pot') out.push({ b: [px(6.5), px(6), px(6.5), px(9.5), px(14), px(9.5)] });
      return out;
    }
    case 'button': {
      if (props.face === 'ceiling') return [{ b: [px(5), px(14), px(6), px(11), 1, px(10)] }];
      if (props.face === 'wall' && SIDES.includes(props.facing)) return [{ b: sideBox(OPPOSITE[props.facing], px(2), px(6), px(10), px(5), px(11)) }];
      return [{ b: [px(5), 0, px(6), px(11), px(2), px(10)] }];
    }
    case 'carpet':
      return [{ b: [0, 0, 0, 1, px(1), 1] }];
    case 'plate':
      return [{ b: [px(1), 0, px(1), px(15), px(1), px(15)] }];
    case 'snow':
      return [{ b: [0, 0, 0, 1, Math.min(8, Math.max(1, Number(props.layers) || 1)) / 8, 1] }];
    case 'ladder': {
      const side = SIDES.includes(props.facing) ? OPPOSITE[props.facing] : solidSide() ?? 'north';
      return [{ b: sideBox(side, px(2), 0, 1) }];
    }
    case 'vine': {
      let sides = [...SIDES, 'up'].filter((s) => props[s] === 'true');
      if (!sides.length) sides = [solidSide() ?? 'north'];
      return sides.map((s) => ({ b: s === 'up' ? [0, px(15), 0, 1, 1, 1] : sideBox(s, px(1), 0, 1) }));
    }
    case 'bed': {
      const f = SIDES.includes(props.facing) ? props.facing : null;
      if (!f) return [{ b: [0, 0, 0, 1, px(9), 1] }];
      const d = STEP[f];
      if (props.part === 'head') {
        if (at(c.x - d[0], c.y, c.z - d[2])?.name === c.name) return [];
        return [{ b: [0, 0, 0, 1, px(9), 1] }, { b: pillow(f, 0), color: PILLOW }];
      }
      const box = [Math.min(0, d[0]), 0, Math.min(0, d[2]), 1 + Math.max(0, d[0]), px(9), 1 + Math.max(0, d[2])];
      return [{ b: box }, { b: pillow(f, 1), color: PILLOW }];
    }
    case 'chest': {
      // A lid over a body with a latch on the front; two chests side by side join into one.
      const f = SIDES.includes(props.facing) ? props.facing : 'south';
      const [low, high] = STEP[f][0] === 0 ? ['west', 'east'] : ['north', 'south'];
      const partner = chestPartner(c, f, low, high, at);
      const box = [px(1), 0, px(1), px(15), px(14), px(15)];
      if (partner) {
        const ax = STEP[partner][0] ? 0 : 2;
        if (STEP[partner][ax] < 0) box[ax] = 0;
        else box[ax + 3] = 1;
      }
      const latch = [0, px(7), 0, 1, px(11), 1];
      const fa = STEP[f][0] ? 0 : 2;
      const ca = 2 - fa;
      if (STEP[f][fa] > 0) latch[fa] = px(15);
      else latch[fa + 3] = px(1);
      const [a, b] = !partner ? [px(7), px(9)] : STEP[partner][ca] < 0 ? [0, px(1)] : [px(15), 1];
      latch[ca] = a;
      latch[ca + 3] = b;
      return [{ b: [box[0], 0, box[2], box[3], px(10), box[5]] }, { b: [box[0], px(10), box[2], box[3], px(14), box[5]] }, { b: latch, color: LATCH }];
    }
    case 'sign':
      if (c.name.endsWith('_banner')) return [{ b: [px(1), 0, px(7), px(15), 2, px(9)] }];
      return [{ b: [0, px(8), px(7), 1, px(16), px(9)] }, { b: [px(7), 0, px(7), px(9), px(8), px(9)] }];
    case 'wall_sign': {
      const side = SIDES.includes(props.facing) ? OPPOSITE[props.facing] : solidSide() ?? 'north';
      return [{ b: c.name.endsWith('_banner') ? sideBox(side, px(1), -1, 1, px(1), px(15)) : sideBox(side, px(2), px(4.5), px(12.5)) }];
    }
    case 'candle':
      return [{ b: [px(7), 0, px(7), px(9), px(6), px(9)] }];
    case 'chain':
      return [{ b: [px(6.5), 0, px(6.5), px(9.5), 1, px(9.5)] }];
    case 'rod':
      return [{ b: [px(7), 0, px(7), px(9), 1, px(9)] }];
    case 'campfire':
      return [{ b: [0, 0, 0, 1, px(7), 1] }];
    case 'head':
      return [{ b: [px(4), 0, px(4), px(12), px(8), px(12)] }];
    case 'cake':
      return [{ b: [px(1), 0, px(1), px(15), px(8), px(15)] }];
    case 'path':
      return [{ b: [0, 0, 0, 1, px(15), 1] }];
    case 'table':
      return [{ b: [0, 0, 0, 1, px(12), 1] }];
    case 'plant': {
      const tall = /sugar_cane|bamboo|tall_|large_|sunflower|lilac|rose_bush|peony/.test(c.name) ? 1 : px(12);
      return [{ b: [px(2), 0, px(7), px(14), tall, px(9)] }, { b: [px(7), 0, px(2), px(9), tall, px(14)] }];
    }
    case 'liquid': {
      const above = at(c.x, c.y + 1, c.z);
      return [{ b: [0, 0, 0, 1, above?.name === c.name ? 1 : px(14), 1] }];
    }
    default:
      return [{ b: [0, 0, 0, 1, 1, 1] }];
  }
}

// The game's rule for stair corners: a stair turned across this one behind it makes an outer
// corner, one in front makes an inner corner, unless a stair like this one sits beside it.
function stairCorner(c, f, near) {
  const isStair = (n) => n?.shape === 'stairs' && (n.props.half === 'top') === (c.props.half === 'top');
  const across = (n) => isStair(n) && SIDES.includes(n.props.facing) && (STEP[n.props.facing][0] === 0) !== (STEP[f][0] === 0);
  const like = (side) => {
    const n = near(side);
    return isStair(n) && (n.props.facing ?? 'north') === f;
  };
  const back = near(f);
  if (across(back) && !like(OPPOSITE[back.props.facing])) return { outer: true, side: back.props.facing };
  const front = near(OPPOSITE[f]);
  if (across(front) && !like(front.props.facing)) return { outer: false, side: front.props.facing };
  return null;
}

// The side a chest pairs up on, or null. Like chests in a row pair off from the low end
// (west or north), two by two, as the game would join them when placed in that order.
function chestPartner(c, f, low, high, at) {
  if (c.props.type === 'single' || c.name === 'ender_chest') return null;
  const like = (n) => n?.name === c.name && (SIDES.includes(n.props.facing) ? n.props.facing : 'south') === f;
  const step = (side, k) => at(c.x + STEP[side][0] * k, c.y, c.z + STEP[side][2] * k);
  let before = 0;
  while (before < 64 && like(step(low, before + 1))) before++;
  if (before % 2 === 1) return low;
  return like(step(high, 1)) ? high : null;
}

// The quarter of a cell towards two sides at right angles, from y0 to y1.
function quarter(a, b, y0, y1) {
  const box = [0, y0, 0, 1, y1, 1];
  for (const s of [a, b]) {
    if (s === 'east') box[0] = 0.5;
    else if (s === 'west') box[3] = 0.5;
    else if (s === 'south') box[2] = 0.5;
    else box[5] = 0.5;
  }
  return box;
}

// The pillow at the head end of a bed facing f; offset 1 when the head is the next cell over.
function pillow(f, offset) {
  const d = STEP[f];
  const span = (sign) => (sign > 0 ? [offset + px(9), offset + px(14)] : [-offset + px(2), -offset + px(7)]);
  if (d[0]) {
    const x = span(d[0]);
    return [x[0], px(9), px(2), x[1], px(11), px(14)];
  }
  const z = span(d[2]);
  return [px(2), px(9), z[0], px(14), px(11), z[1]];
}

const PATTERNED = new Set(['cube', 'slab', 'stairs', 'liquid', 'wall', 'path', 'door', 'trapdoor', 'table']);

function faceLook(style, dir, axis, shape) {
  const faceAxis = AXIS[dir];
  let color = style.color;
  let color2 = style.color2 ?? null;
  let pat = P[style.pattern] ?? 0;
  let vary = 0;
  if (style.pattern === 'log' || style.pattern === 'pillar') {
    if (faceAxis === axis) {
      color = style.end ?? color;
      color2 = style.pattern === 'log' ? style.color : null;
      pat = style.pattern === 'log' ? P.rings : P.pillar_end;
    } else {
      pat = style.pattern === 'log' ? P.stripes : P.pillar_side;
      vary = PLANE_A[faceAxis] === axis ? 1 : 0;
    }
  } else if (style.pattern === 'bark') {
    pat = P.stripes;
  } else if (style.pattern === 'grass') {
    if (dir === 2) {
      color = style.top;
      pat = P.noise;
    } else if (dir === 3) pat = P.noise;
    else color2 = style.top;
  } else if (style.pattern === 'books' && faceAxis === 1) {
    pat = P.planks;
  } else if (style.top && dir === 2) color = style.top;
  // Small shapes keep their colour plain; a pattern would be noise at that size.
  if (!PATTERNED.has(shape)) pat = 0;
  return { color, color2, pat, vary };
}

function buildScene(blocks, maxY) {
  const list = [];
  for (const b of blocks ?? []) {
    if (maxY !== null && maxY !== undefined && b.y > maxY) continue;
    const { name, props } = parseBlock(b.block);
    if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
    list.push({ x: Math.round(b.x), y: Math.round(b.y), z: Math.round(b.z), name, props, text: String(b.block).trim(), muted: b.muted === true });
  }
  const scene = { faces: [], unknown: [] };
  if (!list.length) return scene;
  let [minX, minY, minZ, maxX, maxYY, maxZ] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxYY = Math.max(maxYY, b.y);
    maxZ = Math.max(maxZ, b.z);
  }
  const SX = maxX - minX + 3;
  const SZ = maxZ - minZ + 3;
  const key = (x, y, z) => x - minX + 1 + SX * (z - minZ + 1 + SZ * (y - minY + 1));
  const cells = new Map();
  const unknown = new Set();
  for (const b of list) {
    const style = blockStyle(b.name);
    if (!style.known && !b.muted) unknown.add(b.name);
    const shape = shapeOf(b.name);
    const cube = shape === 'cube' || (shape === 'slab' && b.props.type === 'double');
    const clear = Boolean(style.alpha && style.alpha < 1);
    const family = b.name.replace(/^(mossy|cracked|chiseled|infested)_/, '');
    const c = { ...b, style, shape, cube, family, solid: cube && !clear, clearCube: (cube && clear) || shape === 'liquid' };
    const k = key(b.x, b.y, b.z);
    cells.delete(k);
    cells.set(k, c);
  }
  const inRange = (x, y, z) => x >= minX - 1 && x <= maxX + 1 && z >= minZ - 1 && z <= maxZ + 1 && y >= minY - 1;
  const at = (x, y, z) => (inRange(x, y, z) ? cells.get(key(x, y, z)) : undefined);
  // A neighbour hides the face between them when it is a full opaque block, or the same
  // see-through block (glass next to glass, water next to water).
  const hides = (c, n) => Boolean(n && (n.solid || (c.clearCube && n.clearCube && n.name === c.name)));

  for (const c of cells.values()) {
    const axis = { x: 0, y: 1, z: 2 }[c.props.axis] ?? 1;
    const boxes = boxesFor(c, at);
    const fullBox = boxes.length === 1 && c.cube;
    // Glass keeps a frame round every block; other full blocks merge with the same block.
    const merge = fullBox && !(c.clearCube && c.name.includes('glass'));
    const seed = hash(c.x, c.y, c.z) * 1e6;
    const tone = 0.965 + hash(c.x * 7, c.y * 13, c.z * 3) * 0.07;
    for (const { b, color: own } of boxes) {
      for (let dir = 0; dir < 6; dir++) {
        const ax = AXIS[dir];
        const s = SIGN[dir];
        const onEdge = s > 0 ? b[ax + 3] === 1 : b[ax] === 0;
        const d = DIRS[dir];
        if (onEdge && hides(c, at(c.x + d[0], c.y + d[1], c.z + d[2]))) continue;
        const A = PLANE_A[ax];
        const B = PLANE_B[ax];
        const look = own ? { color: own, color2: null, pat: 0, vary: 0 } : faceLook(c.style, dir, axis, c.shape);
        const o = [c.x - minX + b[0], c.y - minY + b[1], c.z - minZ + b[2]];
        if (s > 0) o[ax] += b[ax + 3] - b[ax];
        let edges = 15;
        // Faint lines between cells of the same block, so sizes can still be counted.
        let faint = 0;
        if (merge) {
          edges = 0;
          const bits = [[A, -1, 1], [A, 1, 2], [B, -1, 4], [B, 1, 8]];
          for (const [e, es, bit] of bits) {
            const step = [0, 0, 0];
            step[e] = es;
            const n = at(c.x + step[0], c.y + step[1], c.z + step[2]);
            // Mossy and cracked kinds of a block count as the same block here, so a mix of them
            // reads as one wall.
            const same = n && n.cube && n.muted === c.muted && (n.text === c.text || (n.family === c.family && !n.props.axis));
            const covered = same && hides(n, at(c.x + step[0] + d[0], c.y + step[1] + d[1], c.z + step[2] + d[2]));
            if (!same || covered) edges |= bit;
            else faint |= bit;
          }
        }
        scene.faces.push({
          dir, o, A, B, la: b[A + 3] - b[A], lb: b[B + 3] - b[B], a0: b[A], b0: b[B],
          color: look.color.map((v) => v * tone), color2: look.color2 ? look.color2.map((v) => v * tone) : null,
          pat: look.pat, vary: look.vary, edges, faint, alpha: own ? 1 : c.style.alpha ?? 1, light: Boolean(c.style.light && !own),
          seed: seed | 0, ground: false, muted: c.muted
        });
      }
    }
  }

  // The footprint of the build, as a thin pale sheet just under its lowest layer.
  const cols = new Set();
  for (const c of cells.values()) cols.add(c.x - minX + 1 + SX * (c.z - minZ + 1));
  const T = 0.08;
  for (const k of cols) {
    const x = (k % SX) - 1;
    const z = Math.floor(k / SX) - 1;
    const has = (dx, dz) => cols.has(x + dx + 1 + SX * (z + dz + 1));
    const sides = [[0, 1, 0], [1, -1, 0], [4, 0, 1], [5, 0, -1]];
    // Edges: across the top face, A is x and B is z.
    const topEdges = (has(-1, 0) ? 0 : 1) | (has(1, 0) ? 0 : 2) | (has(0, -1) ? 0 : 4) | (has(0, 1) ? 0 : 8);
    scene.faces.push({ dir: 2, o: [x, 0, z], A: 0, B: 2, la: 1, lb: 1, a0: 0, b0: 0, color: GROUND, color2: null, pat: 0, vary: 0, edges: topEdges, faint: 0, alpha: 1, light: false, seed: 0, ground: true });
    for (const [dir, dx, dz] of sides) {
      const ax = AXIS[dir];
      if (ax === 0 ? has(dx, 0) : has(0, dz)) continue;
      const o = [x + (dir === 0 ? 1 : 0), -T, z + (dir === 4 ? 1 : 0)];
      scene.faces.push({ dir, o, A: PLANE_A[ax], B: 1, la: 1, lb: T, a0: 0, b0: 0, color: GROUND, color2: null, pat: 0, vary: 0, edges: 0, faint: 0, alpha: 1, light: false, seed: 0, ground: true });
    }
  }
  scene.unknown = [...unknown];
  scene.height = maxYY - minY + 1;
  return scene;
}

function renderView(scene, view, maxSize) {
  const cam = CAMERAS[view];
  if (!cam) throw new Error(`unknown view: ${view} (one of ${Object.keys(CAMERAS).join(', ')})`);
  const { f, r, c } = cam;
  const dot = (v, w) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
  const faces = scene.faces.filter((fc) => dot(DIRS[fc.dir], f) < -1e-6);
  if (!faces.length) {
    const w = 64;
    const rgba = new Uint8Array(w * w * 4);
    for (let i = 0; i < w * w; i++) rgba.set([...BACKGROUND, 255], i * 4);
    return { view, png: encodePng(rgba, w, w), width: w, height: w, unknown: scene.unknown };
  }

  // Project the corners: screen x, screen y (down) and depth, in block units.
  const sx = (p) => p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
  const sy = (p) => -(p[0] * c[0] + p[1] * c[1] + p[2] * c[2]);
  const sd = (p) => p[0] * f[0] + p[1] * f[1] + p[2] * f[2];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  let nearest = Infinity;
  for (const fc of faces) {
    const ea = [0, 0, 0];
    const eb = [0, 0, 0];
    ea[fc.A] = fc.la;
    eb[fc.B] = fc.lb;
    fc.sx = sx(fc.o);
    fc.sy = sy(fc.o);
    fc.sd = sd(fc.o);
    fc.e1 = [sx(ea), sy(ea), sd(ea)];
    fc.e2 = [sx(eb), sy(eb), sd(eb)];
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const px = fc.sx + u * fc.e1[0] + v * fc.e2[0];
      const py = fc.sy + u * fc.e1[1] + v * fc.e2[1];
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
    if (!fc.ground) nearest = Math.min(nearest, fc.sd + Math.min(0, fc.e1[2]) + Math.min(0, fc.e2[2]));
  }
  const extent = Math.max(x1 - x0, y1 - y0, 1);
  const s = Math.min((maxSize - 2 * MARGIN) / extent, MAX_BLOCK);
  const width = Math.max(1, Math.min(maxSize, Math.ceil((x1 - x0) * s + 2 * MARGIN)));
  const height = Math.max(1, Math.min(maxSize, Math.ceil((y1 - y0) * s + 2 * MARGIN)));
  const ox = MARGIN - x0 * s + (width - Math.ceil((x1 - x0) * s + 2 * MARGIN)) / 2;
  const oy = MARGIN - y0 * s;

  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = BACKGROUND[0];
    rgb[i * 3 + 1] = BACKGROUND[1];
    rgb[i * 3 + 2] = BACKGROUND[2];
  }
  const zbuf = new Float32Array(width * height).fill(Infinity);
  const line = Math.min(2.2, Math.max(0.7, s * 0.045));
  const faintLine = Math.max(0.5, line * 0.5);
  const lw = Math.min(1 / 8, Math.max(1 / 16, 1 / s));
  const patterns = s >= 9;

  const shadeOf = (fc) => {
    if (fc.ground) return cam.kind === 'iso' ? SHADE[fc.dir] : 1;
    let k;
    if (cam.kind === 'iso') k = SHADE[fc.dir];
    else if (cam.kind === 'top') k = 0.55 + (0.45 * (fc.o[1] + 0.001)) / Math.max(1, scene.height);
    // Straight-on: farther back is darker, so depth in a wall shows.
    else k = 0.95 * Math.max(0.45, 1 - 0.1 * (fc.sd - nearest));
    return fc.light ? Math.max(k, 0.95) : k;
  };

  const draw = (fc, blend) => {
    const e1x = fc.e1[0] * s;
    const e1y = fc.e1[1] * s;
    const e2x = fc.e2[0] * s;
    const e2y = fc.e2[1] * s;
    const det = e1x * e2y - e1y * e2x;
    if (Math.abs(det) < 0.05) return;
    const inv = 1 / det;
    const fx = fc.sx * s + ox;
    const fy = fc.sy * s + oy;
    const px = [fx, fx + e1x, fx + e2x, fx + e1x + e2x];
    const py = [fy, fy + e1y, fy + e2y, fy + e1y + e2y];
    const xa = Math.max(0, Math.floor(Math.min(...px)));
    const xb = Math.min(width - 1, Math.ceil(Math.max(...px)));
    const ya = Math.max(0, Math.floor(Math.min(...py)));
    const yb = Math.min(height - 1, Math.ceil(Math.max(...py)));
    const area = Math.abs(det);
    const tu = (line * Math.hypot(e2x, e2y)) / area;
    const tv = (line * Math.hypot(e1x, e1y)) / area;
    const fu = tu * faintLine / line;
    const fv = tv * faintLine / line;
    const k = shadeOf(fc);
    const [cr, cg, cb] = fc.color;
    // On a dark face a dark line can't be seen, so its lines are lighter instead.
    const dark = (0.3 * cr + 0.59 * cg + 0.11 * cb) * k < 55;
    const c2 = fc.color2;
    const alpha = fc.alpha;
    const pat = patterns ? fc.pat : 0;
    const { edges, la, lb, a0, b0, seed, vary } = fc;
    const muted = fc.muted;
    const faint = s >= 7 && !muted ? fc.faint : 0;
    // See-through faces are faint already, so water is muted less to still read as water.
    const mute = muted ? (alpha < 1 ? MUTE * 0.6 : MUTE) : 0;
    const keep = 1 - mute;
    const [br, bg, bbk] = BACKGROUND.map((v) => v * mute);
    const d0 = fc.sd;
    const d1 = fc.e1[2];
    const d2 = fc.e2[2];
    for (let y = ya; y <= yb; y++) {
      const cy = y + 0.5 - fy;
      for (let x = xa; x <= xb; x++) {
        const cx = x + 0.5 - fx;
        const u = (cx * e2y - cy * e2x) * inv;
        if (u < -1e-4 || u > 1.0001) continue;
        const v = (e1x * cy - e1y * cx) * inv;
        if (v < -1e-4 || v > 1.0001) continue;
        const i = y * width + x;
        const depth = d0 + u * d1 + v * d2;
        if (depth >= zbuf[i] - 1e-5) continue;
        let m = k;
        let rr = cr;
        let gg = cg;
        let bb = cb;
        if (pat) {
          const h = a0 + u * la;
          const w = b0 + v * lb;
          m *= pattern(pat, frac(h), w >= 1 ? frac(w) : w, seed, lw, vary);
          if (alt) {
            if (c2) {
              rr = c2[0];
              gg = c2[1];
              bb = c2[2];
            } else m *= 0.75;
          }
        }
        const edge = ((edges & 1) && u < tu) || ((edges & 2) && u > 1 - tu) || ((edges & 4) && v < tv) || ((edges & 8) && v > 1 - tv);
        let a = alpha;
        if (edge && muted) m *= dark ? 1.3 : 0.84;
        else if (edge) {
          m *= fc.ground ? 0.82 : dark ? 1.8 : 0.5;
          a = Math.max(a, 0.8);
        } else if (faint && (((faint & 1) && u < fu) || ((faint & 2) && u > 1 - fu) || ((faint & 4) && v < fv) || ((faint & 8) && v > 1 - fv))) {
          m *= dark ? 1.3 : 0.86;
        }
        const j = i * 3;
        const fr = rr * m * keep + br;
        const fg = gg * m * keep + bg;
        const fb = bb * m * keep + bbk;
        if (blend) {
          rgb[j] = rgb[j] * (1 - a) + fr * a;
          rgb[j + 1] = rgb[j + 1] * (1 - a) + fg * a;
          rgb[j + 2] = rgb[j + 2] * (1 - a) + fb * a;
        } else {
          zbuf[i] = depth;
          rgb[j] = fr;
          rgb[j + 1] = fg;
          rgb[j + 2] = fb;
        }
      }
    }
  };

  const clear = [];
  for (const fc of faces) {
    if (fc.alpha < 1) clear.push(fc);
    else draw(fc, false);
  }
  const centre = (fc) => fc.sd + (fc.e1[2] + fc.e2[2]) / 2;
  clear.sort((a, b) => centre(b) - centre(a));
  for (const fc of clear) draw(fc, true);

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = Math.min(255, rgb[i * 3]);
    rgba[i * 4 + 1] = Math.min(255, rgb[i * 3 + 1]);
    rgba[i * 4 + 2] = Math.min(255, rgb[i * 3 + 2]);
    rgba[i * 4 + 3] = 255;
  }
  return { view, png: encodePng(rgba, width, height), width, height, unknown: scene.unknown };
}

// blocks: [{ x, y, z, block }] with block in the game's text form, like
// 'spruce_stairs[facing=east,half=top]'. Views are named for where the viewer stands.
export function renderViews(blocks, { views = ['south-east', 'north-west'], maxSize = 900, maxY = null } = {}) {
  const scene = buildScene(blocks, maxY);
  return views.map((view) => renderView(scene, view, maxSize));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// An 8-bit RGBA PNG from width * height * 4 bytes.
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
