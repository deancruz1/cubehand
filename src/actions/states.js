import { Vec3 } from 'vec3';

// Block states the bot can choose when it places a block, written like the game's own
// "oak_stairs[facing=north,half=top]". Placement only uses what a normal player does (which
// way it looks, which face it clicks and where on it), so it works the same through
// ViaBackwards. The rest (stair shapes, fence and pane connections) the game works out itself.
export const SETTABLE = ['facing', 'half', 'axis', 'type', 'open', 'hanging'];
// Checked after placing and when looking for what's already done. Doors, gates and trapdoors
// get opened and closed, so open never counts against a block.
const CHECKED = ['facing', 'half', 'axis', 'type', 'hanging'];

const DIRS = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0)
};
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
// mineflayer's yaw: 0 looks north, and it turns counterclockwise.
const YAWS = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
const SIDES = [DIRS.east, DIRS.west, DIRS.south, DIRS.north];
const AXES = { x: [DIRS.west, DIRS.east], y: [DIRS.down, DIRS.up], z: [DIRS.north, DIRS.south] };

export function opposite(facing) {
  return OPPOSITE[facing];
}

export function dirVector(facing) {
  return DIRS[facing];
}

export function parseBlock(text) {
  const m = /^\s*([a-z0-9_:]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(text ?? '');
  if (!m) return { name: String(text ?? '').trim(), props: {} };
  const props = {};
  for (const part of (m[2] ?? '').split(',')) {
    const [k, v] = part.split('=').map((s) => s?.trim());
    if (k && v) props[k] = v.toLowerCase();
  }
  return { name: m[1].replace(/^minecraft:/, ''), props };
}

export function blockText(name, props) {
  const entries = Object.entries(props ?? {});
  return entries.length ? `${name}[${entries.map(([k, v]) => `${k}=${v}`).join(',')}]` : name;
}

// The state of a placed block as text, showing only the parts the bot can set.
export function stateText(block) {
  if (!block) return 'nothing';
  const all = block.getProperties?.() ?? {};
  const shown = Object.fromEntries(SETTABLE.filter((k) => k in all && !(k === 'type' && !block.name.endsWith('_slab'))).map((k) => [k, String(all[k])]));
  return blockText(block.name, shown);
}

// Wall torches, wall signs and so on come from the plain item.
export function itemFor(name, registry) {
  if (registry?.itemsByName?.[name]) return name;
  const plain = name.replace('wall_', '');
  if (plain !== name && (!registry?.itemsByName || registry.itemsByName[plain])) return plain;
  return name;
}

// What's wrong with a requested state, or null. The states come from the bot's own (26.1)
// block data.
export function stateProblem(registry, name, props) {
  const keys = Object.keys(props ?? {});
  if (!keys.length) return null;
  const bad = keys.filter((k) => !SETTABLE.includes(k));
  if (bad.length) return `${name}: can't set ${bad.join(', ')}, only ${SETTABLE.join(', ')} (the game works out the rest)`;
  if (props.type === 'double') return `${name}: double slabs aren't supported, use the full block`;
  if ((props.facing === 'up' || props.facing === 'down') && !name.endsWith('_trapdoor')) return `${name}: facing up or down can't be chosen`;
  if (props.half && !['top', 'bottom'].includes(props.half)) return `${name}: half is top or bottom`;
  const states = registry?.blocksByName?.[name]?.states;
  if (!Array.isArray(states)) return null;
  for (const k of keys) {
    const state = states.find((s) => s.name === k);
    if (!state) {
      const has = states.map((s) => s.name).filter((n) => SETTABLE.includes(n));
      return `${name} has no ${k}${has.length ? ` (it has ${has.join(', ')})` : ', it takes no state'}`;
    }
    const values = state.type === 'bool' ? ['true', 'false'] : state.values;
    if (Array.isArray(values) && !values.map(String).includes(props[k])) return `${name}: ${k} is one of ${values.join(', ')}`;
  }
  return null;
}

export function matchesState(block, name, props) {
  if (!block || block.name !== name) return false;
  const keys = CHECKED.filter((k) => props?.[k] !== undefined);
  if (!keys.length) return true;
  const have = block.getProperties?.() ?? {};
  return keys.every((k) => have[k] === undefined || String(have[k]) === props[k]);
}

const isWallMounted = (name) => name === 'ladder' || /(^|_)wall_(torch|sign|banner|skull|head)$/.test(name);
// Blocks that face the way the player looks. Most others (furnaces, chests, pumpkins) face back
// at the player.
const facesLook = (name) => /_(stairs|door|fence_gate|bed)$/.test(name) || name === 'campfire' || name === 'soul_campfire';

// The ways to place a block so it comes out in the given state: which neighbor to click (dir
// goes from the block to that neighbor), where on the face (half), and which way to look (yaw).
// Tried in order until one has a neighbor to click.
export function placementOptions(name, props = {}) {
  const facing = props.facing;
  const half = props.half ?? (props.type === 'top' || props.type === 'bottom' ? props.type : undefined);

  if (isWallMounted(name) && DIRS[facing]) return [{ dir: DIRS[opposite(facing)] }];
  if (name.endsWith('_trapdoor') && DIRS[facing] && SIDES.includes(DIRS[facing])) {
    // Against the block behind it, or on top of / under a block while looking the other way.
    return [
      { dir: DIRS[opposite(facing)], half: half ?? 'bottom' },
      { dir: half === 'top' ? DIRS.up : DIRS.down, yaw: YAWS[opposite(facing)] }
    ];
  }
  if (props.axis && AXES[props.axis]) return AXES[props.axis].map((dir) => ({ dir }));
  if (props.hanging === 'true') return [{ dir: DIRS.up }];
  if (props.hanging === 'false') return [{ dir: DIRS.down }];

  let dirs = [DIRS.down, ...SIDES, DIRS.up];
  // Clicking the top of a block always gives the bottom half, clicking the underside the top.
  if (half === 'top') dirs = [DIRS.up, ...SIDES];
  else if (half === 'bottom') dirs = [DIRS.down, ...SIDES];
  let yaw;
  if (YAWS[facing] !== undefined) yaw = facesLook(name) ? YAWS[facing] : YAWS[opposite(facing)];
  return dirs.map((dir) => ({ dir, half, yaw }));
}
