import { ok, fail } from './util.js';
import { leaveDrops } from './items.js';

const SLOTS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'];

// Where an item goes when no slot is given: armor on the body, shields in the off hand.
export function defaultSlot(name) {
  if (name.endsWith('_helmet') || name === 'turtle_helmet' || name.endsWith('_head') || name === 'carved_pumpkin') return 'head';
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  if (name === 'shield') return 'off-hand';
  return 'hand';
}

export async function equip({ bot }, { item, slot }) {
  const found = bot.inventory.items().find((i) => i.name === item);
  if (!found) return fail(`missing item: ${item}`);
  const where = slot ?? defaultSlot(item);
  if (!SLOTS.includes(where)) return fail(`unknown slot: ${where}`);
  await bot.equip(found, where);
  return ok(`equipped ${item} (${where})`);
}

export async function unequip({ bot }, { slot }) {
  const where = slot ?? 'hand';
  if (!SLOTS.includes(where)) return fail(`unknown slot: ${where}`);
  await bot.unequip(where);
  return ok(`emptied ${where}`);
}

export async function dropItem({ bot }, { item, count }) {
  const matching = bot.inventory.items().filter((i) => i.name === item);
  const have = matching.reduce((sum, i) => sum + i.count, 0);
  if (!have) return fail(`missing item: ${item}`);
  const amount = Math.min(count ?? have, have);
  await bot.toss(matching[0].type, null, amount);
  leaveDrops(bot);
  return ok(`dropped ${amount} ${item}`);
}
