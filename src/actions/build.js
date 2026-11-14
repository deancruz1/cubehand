import { Vec3 } from 'vec3';
import { ok, fail } from './util.js';
import { placeOne } from './blocks.js';
import { parseBlock, itemFor, matchesState, stateProblem } from './states.js';

const range = (a, b) => {
  const out = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
  return out;
};

// A gable roof of stairs over the walls from..to (outer wall corners, dy is the layer just above
// the wall tops), with the ridge along the longer side and an overhang all round. The ridge row
// gets slabs when the span is odd. fill closes the gable ends and the wall tops under the eaves.
function roofBlocks(part, put, slabFor) {
  const { from, to } = part;
  const stairs = parseBlock(part.block).name;
  const slab = slabFor(stairs);
  const o = Math.min(Math.max(part.overhang ?? 1, 0), 2);
  const y0 = from.dy;
  const [ax0, ax1] = [Math.min(from.dx, to.dx), Math.max(from.dx, to.dx)];
  const [az0, az1] = [Math.min(from.dz, to.dz), Math.max(from.dz, to.dz)];
  const alongX = ax1 - ax0 >= az1 - az0;
  // Work in (u, v): u runs along the ridge, v across it.
  const [u0, u1, v0, v1] = alongX ? [ax0, ax1, az0, az1] : [az0, az1, ax0, ax1];
  const at = (u, y, v, block) => (alongX ? put(u, y, v, block) : put(v, y, u, block));
  const up = alongX ? ['south', 'north'] : ['east', 'west'];
  for (let k = 0; ; k++) {
    const a = v0 - o + k;
    const b = v1 + o - k;
    if (a > b) break;
    const y = y0 + k;
    for (let u = u0 - o; u <= u1 + o; u++) {
      if (a === b) at(u, y, a, slab ? `${slab}[type=bottom]` : `${stairs}[facing=${up[0]},half=bottom]`);
      else {
        at(u, y, a, `${stairs}[facing=${up[0]},half=bottom]`);
        at(u, y, b, `${stairs}[facing=${up[1]},half=bottom]`);
      }
    }
    if (part.fill) {
      for (let v = Math.max(v0, a + 1); v <= Math.min(v1, b - 1); v++) {
        at(u0, y, v, part.fill);
        at(u1, y, v, part.fill);
      }
    }
  }
  if (part.fill) {
    for (let y = y0; y < y0 + o; y++) {
      for (let u = u0; u <= u1; u++) {
        at(u, y, v0, part.fill);
        at(u, y, v1, part.fill);
      }
    }
  }
}

// Turns shapes into single blocks, in order, so later parts win where they overlap. A part of
// "air" takes out what came before it there (doorways, windows).
export function expandParts(parts = [], blocks = [], { slabFor = (s) => s.replace(/_stairs$/, '_slab') } = {}) {
  const out = new Map();
  const put = (dx, dy, dz, block) => {
    const key = `${dx},${dy},${dz}`;
    if (parseBlock(block).name === 'air') out.delete(key);
    else {
      out.delete(key);
      out.set(key, { dx, dy, dz, block });
    }
  };
  for (const part of parts) {
    const { from, to = from, block } = part;
    const xs = range(from.dx, to.dx);
    const ys = range(from.dy, to.dy);
    const zs = range(from.dz, to.dz);
    const [x0, x1, y0, y1, z0, z1] = [xs[0], xs.at(-1), ys[0], ys.at(-1), zs[0], zs.at(-1)];
    switch (part.shape) {
      case 'line': {
        const steps = Math.max(Math.abs(to.dx - from.dx), Math.abs(to.dy - from.dy), Math.abs(to.dz - from.dz));
        for (let i = 0; i <= steps; i++) {
          const t = steps ? i / steps : 0;
          put(Math.round(from.dx + (to.dx - from.dx) * t), Math.round(from.dy + (to.dy - from.dy) * t), Math.round(from.dz + (to.dz - from.dz) * t), block);
        }
        break;
      }
      case 'roof':
        roofBlocks({ ...part, from: { dx: x0, dy: from.dy, dz: z0 }, to: { dx: x1, dy: from.dy, dz: z1 } }, put, slabFor);
        break;
      default:
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
  }
  for (const b of blocks) put(b.dx, b.dy, b.dz, b.block);
  return [...out.values()];
}

// Pure planning step so it can be tested without a server. Blocks are text with an optional
// state, like "oak_stairs[facing=north,half=top]".
export function planBuild({ origin, blocks, botPos, getName, getBlock, inventory, maxBlocks, isKnownBlock, checkState = () => null, itemName = (n) => itemFor(n) }) {
  if (blocks.length > maxBlocks) {
    return { error: `structure has ${blocks.length} blocks, the limit is ${maxBlocks}` };
  }
  const parsed = blocks.map((b) => ({ ...b, ...parseBlock(b.block) }));
  const unknown = [...new Set(parsed.map((b) => b.name).filter((name) => !isKnownBlock(name)))];
  if (unknown.length > 0) return { error: `unknown block: ${unknown.join(', ')}` };
  const problems = [...new Set(parsed.map((b) => checkState(b.name, b.props)).filter(Boolean))];
  if (problems.length > 0) return { error: problems.slice(0, 3).join('; ') };

  const byPos = new Map();
  for (const b of parsed) {
    const x = origin.x + b.dx;
    const y = origin.y + b.dy;
    const z = origin.z + b.dz;
    const props = Object.keys(b.props).length ? b.props : undefined;
    byPos.set(`${x},${y},${z}`, { x, y, z, block: b.name, props });
  }

  const blockAt = getBlock ?? ((x, y, z) => ({ name: getName(x, y, z) }));
  const placements = [];
  let skipped = 0;
  for (const p of byPos.values()) {
    if (matchesState(blockAt(p.x, p.y, p.z), p.block, p.props)) skipped++;
    else placements.push(p);
  }

  const dist = (p) => (p.x - botPos.x) ** 2 + (p.y - botPos.y) ** 2 + (p.z - botPos.z) ** 2;
  placements.sort((a, b) => a.y - b.y || dist(a) - dist(b));

  const needed = new Map();
  for (const p of placements) {
    const item = itemName(p.block);
    needed.set(item, (needed.get(item) ?? 0) + 1);
  }
  const missing = [];
  for (const [block, need] of needed) {
    const have = inventory.get(block) ?? 0;
    if (have < need) missing.push({ block, need, have });
  }

  return { placements, skipped, needed, missing };
}

export function inventoryCounts(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

// Places blocks one y layer at a time, in the order given. Blocks with nothing to place
// against yet are retried once the rest of their layer is down, then with the layers above
// (a hanging lantern needs the block over it). Afterwards every block is checked once more,
// and the ones that are missing or turned the wrong way get one more go.
export async function placeAll(ctx, placements) {
  const { signal } = ctx;
  let placed = 0;
  const failures = [];
  let stoppedReason = null;

  const layers = new Map();
  for (const p of placements) {
    if (!layers.has(p.y)) layers.set(p.y, []);
    layers.get(p.y).push(p);
  }

  const place = async (p) => {
    const result = await placeOne(ctx, p.block, new Vec3(p.x, p.y, p.z), { attach: p.attach, props: p.props });
    if (result.ok) p.done = true;
    return result;
  };
  const ranOut = (p) => `ran out of ${itemFor(p.block, ctx.bot.registry)}, need ${placements.filter((q) => q.block === p.block && !q.done).length} more`;

  let carried = [];
  outer: for (const layer of [...layers.values(), []]) {
    let pending = [...carried, ...layer];
    carried = [];
    while (pending.length > 0) {
      const retry = [];
      let progress = false;
      for (const p of pending) {
        if (signal?.aborted) {
          stoppedReason = 'stopped';
          break outer;
        }
        const result = await place(p);
        if (result.ok) {
          placed++;
          progress = true;
          ctx.status?.progress(`placed ${placed} of ${placements.length} blocks`);
        } else if (result.message.startsWith('missing item')) {
          stoppedReason = ranOut(p);
          break outer;
        } else if (result.message.startsWith('no block to place against')) {
          retry.push(p);
        } else {
          failures.push(result.message);
        }
      }
      if (!progress) {
        carried = retry;
        break;
      }
      pending = retry;
    }
  }
  for (const p of carried) failures.push(`no block to place against at ${p.x} ${p.y} ${p.z}`);

  const wrong = [];
  if (!stoppedReason) {
    const bot = ctx.bot;
    const off = placements.filter((p) => p.done && !matchesState(bot.blockAt(new Vec3(p.x, p.y, p.z), false), p.block, p.props));
    for (const p of off) {
      if (signal?.aborted) break;
      ctx.status?.progress(`checking the build: fixing ${off.indexOf(p) + 1} of ${off.length} blocks`);
      const result = await place(p);
      if (result.wrong) wrong.push(result.message);
      else if (!result.ok) failures.push(result.message);
    }
  }
  return { placed, failures, wrong, stoppedReason };
}

function slabFinder(bot) {
  return (stairs) => {
    const slab = stairs.replace(/_stairs$/, '_slab');
    return bot.registry.blocksByName[slab] ? slab : null;
  };
}

export async function buildStructure(ctx, { origin, blocks = [], parts = [], dry_run }) {
  const { bot, config } = ctx;
  const box = (p) => {
    const to = p.to ?? p.from;
    return (Math.abs(to.dx - p.from.dx) + 3) * (Math.abs(to.dy - p.from.dy) + 1) * (Math.abs(to.dz - p.from.dz) + 3);
  };
  if (parts.reduce((sum, p) => sum + box(p), 0) > config.limits.maxBuildBlocks * 20) {
    return fail(`those parts are far too big, the limit is ${config.limits.maxBuildBlocks} blocks`);
  }
  const all = expandParts(parts, blocks, { slabFor: slabFinder(bot) });
  const plan = planBuild({
    origin,
    blocks: all,
    botPos: bot.entity.position.floored(),
    getBlock: (x, y, z) => bot.blockAt(new Vec3(x, y, z), false),
    inventory: inventoryCounts(bot.inventory.items()),
    maxBlocks: config.limits.maxBuildBlocks,
    isKnownBlock: (name) => Boolean(bot.registry.blocksByName[name]),
    checkState: (name, props) => stateProblem(bot.registry, name, props),
    itemName: (name) => itemFor(name, bot.registry)
  });

  if (plan.error) return fail(plan.error);
  const needText = [...plan.needed].map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing';
  const missingText = plan.missing.map((m) => `${m.block} (need ${m.need}, have ${m.have}, ${m.need - m.have} more)`).join(', ');
  if (dry_run) {
    return ok(`Plan: ${all.length} blocks, ${plan.skipped} already in place. Needs ${needText}.${missingText ? ` Missing: ${missingText}.` : ' I have everything.'}`);
  }
  if (plan.missing.length > 0) return fail(`missing items: ${missingText}. Nothing was placed.`);

  const { placed, failures, wrong, stoppedReason } = await placeAll(ctx, plan.placements);
  let message = `placed ${placed}, skipped ${plan.skipped}, failed ${failures.length}`;
  if (wrong.length > 0) message += `. ${wrong.length} came out turned the wrong way, first: ${wrong.slice(0, 3).join('; ')}`;
  if (failures.length > 0) message += `. First failures: ${failures.slice(0, 5).join('; ')}`;
  if (stoppedReason) message += `. Stopped early: ${stoppedReason}`;
  return stoppedReason || failures.length > 0 ? fail(message) : ok(message);
}
