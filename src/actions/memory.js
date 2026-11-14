import { ok, fail } from './util.js';
import { findPlayer } from './movement.js';
import { outlineFrom, areaBounds } from '../areas.js';
import { isAdmin } from '../guard.js';

export async function remember({ memory, config, requester }, input) {
  const entry = memory.remember({ ...input, by: requester ?? undefined, admin: isAdmin(config ?? {}, requester) });
  const where = entry.pos ? ` at ${entry.pos.x} ${entry.pos.y} ${entry.pos.z}` : '';
  return ok(`remembered ${entry.name}${entry.area ? ' as an area' : ''}${where}`);
}

export async function forget({ memory }, { name }) {
  return memory.forget(name) ? ok(`forgot ${name}`) : fail(`no memory called ${name}`);
}

// Tracks where a player (or the bot) walks, then saves the loop they walked as a named area.
export async function recordArea({ bot, memory, areas, config, requester }, { action, name, note, player }) {
  if (action === 'start') {
    if (player && !findPlayer(bot, player)) return fail(`player not found: ${player}`);
    areas.start(name, () => (player ? findPlayer(bot, player) : bot.entity), player ?? 'myself');
    return ok(`recording the outline as ${player ?? 'I'} walk${player ? 's' : ''} around${name ? ` ${name}` : ''}`);
  }
  if (action === 'cancel') {
    return areas.stop() ? ok('stopped recording without saving') : fail('was not recording an area');
  }

  const rec = areas.active;
  if (!rec) return fail('not recording an area, start one first');
  const label = name ?? rec.name;
  if (!label) return fail('give the area a name to save it under');
  areas.stop();
  const area = outlineFrom(rec.points);
  if (!area) return fail(`only got ${rec.points.length} points, too little to make an outline. They need to walk all the way around it.`);
  const { width, depth, center } = areaBounds(area);
  memory.remember({ name: label, note: note ?? '', x: center.x, y: center.y, z: center.z, area, by: requester ?? undefined, admin: isAdmin(config ?? {}, requester) });
  return ok(`saved ${label}: about ${width} x ${depth} blocks around ${center.x} ${center.y} ${center.z}, ${area.corners.length} corners`);
}
