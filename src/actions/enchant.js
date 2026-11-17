import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, delay, guarded, TimeoutError, AbortedError } from './util.js';
import { walkTo } from './movement.js';
import { findNearest, inReach } from './blocks.js';
import { openWindow } from './containers.js';
import { carriedItems, settleInventory } from './crafting.js';

const { GoalLookAtBlock } = pathfinderPkg.goals;

const RANGE = 32;
const ANVILS = ['anvil', 'chipped_anvil', 'damaged_anvil'];
const MAX_NAME = 50;
// The anvil shows "Too Expensive!" from this many levels up and gives nothing.
const TOO_EXPENSIVE = 40;
export const ENCHANT_TIMING = { offersMs: 5000, resultMs: 3000, actionMs: 10000 };

// The enchantments on an item. From 1.20.5 they are item components holding registry ids, and
// prismarine-item hands those back unread, so they are read here; older items go through its
// own getter.
export function enchantsOf(bot, item) {
  if (!item) return [];
  const key = item.name === 'enchanted_book' ? 'stored_enchantments' : 'enchantments';
  const data = item.componentMap?.get(key)?.data;
  const list = Array.isArray(data) ? data : data?.enchantments;
  if (list) return list.map((e) => ({ name: enchantName(bot, e.id), level: e.level ?? e.lvl }));
  try {
    const old = item.enchants;
    return Array.isArray(old) ? old.map((e) => ({ name: e.name, level: e.lvl })) : [];
  } catch {
    return [];
  }
}

function enchantName(bot, id) {
  if (typeof id === 'string') return id.replace('minecraft:', '');
  return bot.registry.enchantments?.[id]?.name ?? `enchantment ${id}`;
}

// The custom name as plain text. On 26.1 it is a text component in NBT, before that a string.
export function customNameOf(item) {
  let raw;
  try {
    raw = item?.customName;
  } catch {
    return null;
  }
  if (raw == null) return null;
  const text = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') {
      if (!v.startsWith('{')) return v;
      try {
        return text(JSON.parse(v));
      } catch {
        return v;
      }
    }
    if (Array.isArray(v)) return v.map(text).join('');
    if (v.type && 'value' in v) return text(v.value);
    return `${text(v.text ?? v[''])}${v.extra ? text(v.extra) : ''}`;
  };
  return text(raw) || null;
}

function durabilityOf(bot, item) {
  const max = item.maxDurability ?? bot.registry.itemsByName[item.name]?.maxDurability;
  if (!max) return null;
  let used = 0;
  try {
    used = item.durabilityUsed ?? 0;
  } catch {
    used = 0;
  }
  return { left: max - used, max };
}

const enchantsText = (list) => list.map((e) => `${e.name} ${e.level}`).join(', ');

function describe(bot, item) {
  const parts = [];
  const d = durabilityOf(bot, item);
  if (d) parts.push(`durability ${d.left}/${d.max}`);
  const ench = enchantsOf(bot, item);
  if (ench.length) parts.push(`enchantments: ${enchantsText(ench)}`);
  const name = customNameOf(item);
  if (name) parts.push(`named "${name}"`);
  return parts.join(', ');
}

const signature = (bot, item) => `${item.name}|${JSON.stringify(durabilityOf(bot, item))}|${enchantsText(enchantsOf(bot, item))}|${customNameOf(item) ?? ''}`;

// The carried item of one of names that wasn't there before, matched on what it looks like, so
// a changed copy is found even among several of the same kind.
function changedItem(bot, before, names) {
  const left = [...before];
  for (const item of carriedItems(bot).filter((i) => names.includes(i.name))) {
    const i = left.indexOf(signature(bot, item));
    if (i >= 0) left.splice(i, 1);
    else return item;
  }
  return null;
}

const levels = (bot) => bot.experience?.level ?? 0;
const creative = (bot) => bot.game?.gameMode === 'creative';
const countOf = (bot, name) => carriedItems(bot).reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);

// The block to use: at x y z when given, else the nearest one within RANGE.
function findBlock(bot, names, { x, y, z }) {
  if (x !== undefined && y !== undefined && z !== undefined) {
    const pos = new Vec3(x, y, z);
    const block = bot.blockAt(pos, false);
    if (!block) return { error: `position not loaded: ${posText(pos)}` };
    if (!names.includes(block.name)) return { error: `no ${names[0].replace('_', ' ')} at ${posText(pos)} (found ${block.name})` };
    return { block };
  }
  const pos = findNearest(bot, (n) => names.includes(n), RANGE)[0];
  if (!pos) return { error: `no ${names[0].replace('_', ' ')} within ${RANGE} blocks` };
  return { block: bot.blockAt(pos, false) };
}

async function reach(ctx, block) {
  const { bot } = ctx;
  if (inReach(bot, block.position)) return null;
  const walked = await walkTo(ctx, new GoalLookAtBlock(block.position, bot.world, { reach: 4 }), { place: false });
  if (!walked.ok && !inReach(bot, block.position)) return `couldn't get to the ${block.name} at ${posText(block.position)}: ${walked.message}`;
  return null;
}

// The window slot that shows an inventory slot.
const windowSlot = (bot, window, item) => item.slot - bot.inventory.inventoryStart + window.inventoryStart;

// Moves what is in window slot from into slot to, all of it or one, and puts any rest back.
async function place(bot, window, from, to, one) {
  await bot.clickWindow(from, 0, 0);
  await bot.clickWindow(to, one ? 1 : 0, 0);
  if (window.selectedItem) await bot.clickWindow(from, 0, 0);
}

async function waitFor(ctx, test, ms) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) {
    if (ctx.signal?.aborted) throw new AbortedError('stopped');
    await delay(50);
  }
  return test();
}

// Opens the block's window, runs work(window), and always closes it again. Closing makes the
// server hand back what is left in the slots, and the resync after it pulls the real inventory.
async function atBlock(ctx, block, open, work) {
  const { bot } = ctx;
  let window;
  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    await pause(200, 450);
    window = await openWindow(ctx, () => open(block));
  } catch (err) {
    if (err instanceof AbortedError) return fail('stopped');
    if (err instanceof TimeoutError) return fail(`the ${block.name} at ${posText(block.position)} wouldn't open`);
    return fail(`couldn't open the ${block.name}: ${err.message}`);
  }
  try {
    return await work(window);
  } catch (err) {
    if (err instanceof AbortedError) return fail('stopped');
    if (err instanceof TimeoutError) return fail(`the ${block.name} stopped responding`);
    return fail(`${block.name}: ${err.message}`);
  } finally {
    await pause(200, 400);
    try {
      window.close();
    } catch {}
    await settleInventory(bot);
  }
}

function offerText(bot, offer, i) {
  if (!(offer.level > 0)) return `${i + 1}) not offered`;
  const hint = offer.expected?.enchant >= 0 ? `, ${enchantName(bot, offer.expected.enchant)}${offer.expected.level > 0 ? ` ${offer.expected.level}` : ''} and maybe more` : '';
  return `${i + 1}) needs level ${offer.level}, costs ${i + 1} ${i ? 'levels' : 'level'} and ${i + 1} lapis${hint}`;
}

// Puts an item in the enchanting table and reads its three offers. With choice (1 to 3) it takes
// that offer. Without one nothing is spent.
export async function enchant(ctx, { item, choice, x, y, z }) {
  const { bot } = ctx;
  if (!bot.registry.itemsByName[item]) return fail(`unknown item: ${item}`);
  const pick = choice === undefined || choice === null ? null : Number(choice);
  if (pick !== null && ![1, 2, 3].includes(pick)) return fail('choice is 1, 2 or 3');
  const copies = carriedItems(bot).filter((i) => i.name === item);
  if (!copies.length) return fail(`I'm not carrying any ${item}`);
  const target = copies.find((i) => !enchantsOf(bot, i).length);
  if (!target) return fail(`every ${item} I carry is already enchanted, and the table only takes unenchanted ones`);
  const found = findBlock(bot, ['enchanting_table'], { x, y, z });
  if (found.error) return fail(found.error);
  const { block } = found;
  ctx.status?.progress(`walking to the enchanting table at ${posText(block.position)}`);
  const far = await reach(ctx, block);
  if (far) return fail(far);

  const lapis = countOf(bot, 'lapis_lazuli');
  const names = item === 'book' ? ['book', 'enchanted_book'] : [item];
  const before = carriedItems(bot).filter((i) => names.includes(i.name)).map((i) => signature(bot, i));
  const startLevel = levels(bot);
  let enchanted = false;
  const result = await atBlock(ctx, block, (b) => bot.openEnchantmentTable(b), async (table) => {
    ctx.status?.progress(`putting the ${item} in the enchanting table`);
    await place(bot, table, windowSlot(bot, table, target), 0, true);
    const stacks = table.items().filter((i) => i.name === 'lapis_lazuli').sort((a, b) => b.count - a.count);
    for (const s of stacks) {
      if ((table.slots[1]?.count ?? 0) >= 3) break;
      await place(bot, table, s.slot, 1, false);
    }
    ctx.status?.progress('reading the enchanting offers');
    const offers = table.enchantments;
    if (!(await waitFor(ctx, () => offers.every((o) => o.level >= 0), ENCHANT_TIMING.offersMs))) return fail('the enchanting table showed no offers');
    const text = offers.map((o, i) => offerText(bot, o, i)).join('; ');
    const have = `I have ${startLevel} levels and ${lapis} lapis`;
    if (!offers.some((o) => o.level > 0)) return fail(`the enchanting table offers nothing for ${item}. ${have}`);
    if (pick === null) return ok(`offers for ${item}: ${text}. ${have}`);
    const offer = offers[pick - 1];
    if (!(offer.level > 0)) return fail(`offer ${pick} isn't there. Offers: ${text}`);
    if (!creative(bot)) {
      if (startLevel < offer.level) return fail(`offer ${pick} needs level ${offer.level}, I have ${startLevel}`);
      if (lapis < pick) return fail(`offer ${pick} needs ${pick} lapis, I have ${lapis}`);
    }
    ctx.status?.progress(`enchanting the ${item} with offer ${pick}`);
    await guarded(() => table.enchant(pick - 1), { ms: ENCHANT_TIMING.actionMs, signal: ctx.signal });
    enchanted = true;
    return ok('');
  });
  if (!result.ok || !enchanted) return result;
  const now = changedItem(bot, before, names);
  const spent = startLevel - levels(bot);
  if (!now) return fail(`enchanted the ${item}, but I can't find it in my inventory afterwards`);
  return ok(`enchanted ${now.name}: ${describe(bot, now) || 'no enchantments showing'} (spent ${spent} ${spent === 1 ? 'level' : 'levels'}, ${levels(bot)} left)`);
}

// The second item for the anvil: another copy of the item, its repair material, or a book.
function secondItem(bot, target, material) {
  const others = carriedItems(bot).filter((i) => i.name === material && i !== target && i.slot !== target.slot);
  if (!others.length) return null;
  if (material === target.name) return others.sort((a, b) => (durabilityOf(bot, b)?.left ?? 0) - (durabilityOf(bot, a)?.left ?? 0))[0];
  return others.sort((a, b) => b.count - a.count)[0];
}

// At an anvil: combines the item with a second copy, its repair material or an enchanted book,
// and renames it when name is given. Fails without spending when she can't pay.
export async function repair(ctx, { item, with: material, name, x, y, z }) {
  const { bot } = ctx;
  const info = bot.registry.itemsByName[item];
  if (!info) return fail(`unknown item: ${item}`);
  if (!material && !name) {
    const mats = [...(info.repairWith ?? []), item];
    return fail(`say what to put with the ${item} (with: ${mats.join(', ')} or enchanted_book) or give it a name`);
  }
  if (material && !bot.registry.itemsByName[material]) return fail(`unknown item: ${material}`);
  if (name !== undefined && name !== null && (!String(name).trim() || String(name).length > MAX_NAME)) return fail(`a name is 1 to ${MAX_NAME} characters`);
  const copies = carriedItems(bot).filter((i) => i.name === item);
  if (!copies.length) return fail(`I'm not carrying any ${item}`);
  // The most worn copy is the one that needs it.
  const target = copies.sort((a, b) => (durabilityOf(bot, a)?.left ?? 0) - (durabilityOf(bot, b)?.left ?? 0))[0];
  const second = material ? secondItem(bot, target, material) : null;
  if (material && !second) return fail(material === item ? `I only carry one ${item}` : `I'm not carrying any ${material}`);
  const found = findBlock(bot, ANVILS, { x, y, z });
  if (found.error) return fail(found.error);
  const { block } = found;
  ctx.status?.progress(`walking to the anvil at ${posText(block.position)}`);
  const far = await reach(ctx, block);
  if (far) return fail(far);

  const was = describe(bot, target);
  const before = copies.map((i) => signature(bot, i));
  const startLevel = levels(bot);
  let done = false;
  let costText = '';
  const result = await atBlock(ctx, block, (b) => bot.openAnvil(b), async (anvil) => {
    let cost = null;
    const onProperty = (packet) => {
      if (packet.windowId === anvil.id && packet.property === 0) cost = packet.value;
    };
    bot._client.on('craft_progress_bar', onProperty);
    try {
      ctx.status?.progress(`putting the ${item} on the anvil`);
      await place(bot, anvil, windowSlot(bot, anvil, target), 0, true);
      // A repair material goes in as a whole stack, the anvil takes what it needs.
      if (second) await place(bot, anvil, windowSlot(bot, anvil, second), 1, second.name === item || second.name === 'enchanted_book');
      // The server renames to whatever name it was sent last, and a blank one takes a custom
      // name off, so without a new name the old one is sent.
      bot._client.write('name_item', { name: name ?? customNameOf(target) ?? '' });
      const shown = await waitFor(ctx, () => cost !== null && (cost >= TOO_EXPENSIVE || (anvil.slots[2] && cost > 0)), ENCHANT_TIMING.resultMs);
      if (!shown) return fail(`the anvil can't do anything with the ${item}${second ? ` and ${second.name}` : ''}`);
      if (cost >= TOO_EXPENSIVE && !creative(bot)) return fail(`too expensive: the anvil wants ${cost} levels, and it refuses anything from ${TOO_EXPENSIVE} up`);
      costText = `costs ${cost} ${cost === 1 ? 'level' : 'levels'}`;
      if (!creative(bot) && startLevel < cost) return fail(`that ${costText}: needs ${cost} levels, has ${startLevel}`);
      ctx.status?.progress(`using the anvil, ${costText}`);
      await guarded(() => bot.putAway(2), { ms: ENCHANT_TIMING.actionMs, signal: ctx.signal });
      done = true;
      return ok('');
    } finally {
      bot._client.removeListener('craft_progress_bar', onProperty);
    }
  });
  if (!result.ok || !done) return result;
  const now = changedItem(bot, before, [item]);
  const spent = startLevel - levels(bot);
  if (!now) return fail(`used the anvil (${costText}), but the ${item} looks the same afterwards`);
  return ok(`${item} now: ${describe(bot, now)} (was: ${was || 'plain'}). The anvil ${costText}, spent ${spent}, ${levels(bot)} left`);
}
