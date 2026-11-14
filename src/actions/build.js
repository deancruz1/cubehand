import { Vec3 } from 'vec3';
import { ok, fail } from './util.js';
import { placeOne } from './blocks.js';

// Pure planning step so it can be tested without a server.
export function planBuild({ origin, blocks, botPos, getName, inventory, maxBlocks, isKnownBlock }) {
  if (blocks.length > maxBlocks) {
    return { error: `structure has ${blocks.length} blocks, the limit is ${maxBlocks}` };
  }
  const unknown = [...new Set(blocks.map((b) => b.block).filter((name) => !isKnownBlock(name)))];
  if (unknown.length > 0) return { error: `unknown block: ${unknown.join(', ')}` };

  const byPos = new Map();
  for (const b of blocks) {
    const x = origin.x + b.dx;
    const y = origin.y + b.dy;
    const z = origin.z + b.dz;
    byPos.set(`${x},${y},${z}`, { x, y, z, block: b.block });
  }

  const placements = [];
  let skipped = 0;
  for (const p of byPos.values()) {
    if (getName(p.x, p.y, p.z) === p.block) skipped++;
    else placements.push(p);
  }

  const dist = (p) => (p.x - botPos.x) ** 2 + (p.y - botPos.y) ** 2 + (p.z - botPos.z) ** 2;
  placements.sort((a, b) => a.y - b.y || dist(a) - dist(b));

  const needed = new Map();
  for (const p of placements) needed.set(p.block, (needed.get(p.block) ?? 0) + 1);
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
// against yet are retried once the rest of their layer is down.
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

  outer: for (const layer of layers.values()) {
    let pending = layer;
    while (pending.length > 0) {
      const retry = [];
      let progress = false;
      for (const p of pending) {
        if (signal?.aborted) {
          stoppedReason = 'stopped';
          break outer;
        }
        const result = await placeOne(ctx, p.block, new Vec3(p.x, p.y, p.z), { attach: p.attach });
        if (result.ok) {
          placed++;
          progress = true;
          ctx.status?.progress(`placed ${placed} of ${placements.length} blocks`);
        } else if (result.message.startsWith('missing item')) {
          const left = placements.filter((q) => q.block === p.block && !q.done).length;
          stoppedReason = `ran out of ${p.block}, need ${left} more`;
          break outer;
        } else if (result.message.startsWith('no block to place against')) {
          retry.push(p);
        } else {
          failures.push(result.message);
        }
        if (result.ok) p.done = true;
      }
      if (!progress) {
        for (const p of retry) failures.push(`no block to place against at ${p.x} ${p.y} ${p.z}`);
        break;
      }
      pending = retry;
    }
  }
  return { placed, failures, stoppedReason };
}

export async function buildStructure(ctx, { origin, blocks }) {
  const { bot, config } = ctx;
  const plan = planBuild({
    origin,
    blocks,
    botPos: bot.entity.position.floored(),
    getName: (x, y, z) => bot.blockAt(new Vec3(x, y, z), false)?.name ?? null,
    inventory: inventoryCounts(bot.inventory.items()),
    maxBlocks: config.limits.maxBuildBlocks,
    isKnownBlock: (name) => Boolean(bot.registry.blocksByName[name])
  });

  if (plan.error) return fail(plan.error);
  if (plan.missing.length > 0) {
    const list = plan.missing.map((m) => `${m.block} (need ${m.need}, have ${m.have}, ${m.need - m.have} more)`).join(', ');
    return fail(`missing items: ${list}. Nothing was placed.`);
  }

  const { placed, failures, stoppedReason } = await placeAll(ctx, plan.placements);
  let message = `placed ${placed}, skipped ${plan.skipped}, failed ${failures.length}`;
  if (failures.length > 0) message += `. First failures: ${failures.slice(0, 5).join('; ')}`;
  if (stoppedReason) message += `. Stopped early: ${stoppedReason}`;
  return stoppedReason || failures.length > 0 ? fail(message) : ok(message);
}
