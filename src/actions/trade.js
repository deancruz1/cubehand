import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, guarded, customName, AbortedError, TimeoutError } from './util.js';
import { walkTo } from './movement.js';
import { openWindow, countItems } from './containers.js';
import { isBaby } from './combat.js';

const { GoalFollow } = pathfinderPkg.goals;

const SEARCH_RANGE = 32;
const TRADE_REACH = 3;
const TRADE_MS = 10000;
const TRADERS = new Set(['villager', 'wandering_trader']);
// Villager professions by their id in the game's registry, which lists them in this order.
export const PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'];
const NO_TRADES = new Set(['none', 'nitwit']);

// A villager's profession from its metadata, or null when it can't be read.
export function professionOf(bot, entity) {
  if (entity.name !== 'villager') return null;
  const index = bot.registry?.entitiesByName?.villager?.metadataKeys?.indexOf('villager_data') ?? -1;
  const id = index >= 0 ? entity.metadata?.[index]?.villagerProfession : undefined;
  if (typeof id === 'number') return PROFESSIONS[id] ?? null;
  if (typeof id === 'string') return id.replace(/^minecraft:/, '');
  return null;
}

// What a player calls it: its name tag, its profession, or what it is.
function traderText(bot, entity) {
  const tag = customName(entity);
  if (tag) return tag;
  if (entity.name === 'wandering_trader') return 'wandering trader';
  const job = professionOf(bot, entity);
  return job && job !== 'none' ? job : 'villager';
}

// Villagers and wandering traders within range that can trade, nearest to near (where she is,
// unless a spot is given) first. villager narrows it: a name tag, a profession (librarian),
// "villager" or "wandering_trader". Babies, nitwits and villagers with no job have no trades.
export function pickTraders(bot, villager, near = bot.entity.position, range = SEARCH_RANGE) {
  const wanted = villager?.toLowerCase().trim().replace(/^minecraft:/, '').replace(/ /g, '_').replace(/s$/, '');
  const here = bot.entity.position;
  const fits = (e) => {
    if (!wanted) return true;
    if (customName(e)?.toLowerCase() === villager.toLowerCase().trim()) return true;
    if (wanted === 'villager') return e.name === 'villager';
    if (wanted === 'wandering_trader' || wanted === 'trader') return e.name === 'wandering_trader';
    return professionOf(bot, e) === wanted;
  };
  return Object.values(bot.entities ?? {})
    .filter((e) => e !== bot.entity && TRADERS.has(e.name) && e.position && e.position.distanceTo(here) <= range)
    .filter((e) => !isBaby(bot, e) && !NO_TRADES.has(professionOf(bot, e)) && fits(e))
    .sort((a, b) => a.position.distanceTo(near) - b.position.distanceTo(near));
}

function enchantText(item) {
  try {
    const list = item.enchants ?? [];
    return list.length ? ` (${list.map((e) => `${e.name} ${e.lvl}`).join(', ')})` : '';
  } catch {
    return '';
  }
}

// One offer as plain data: what it costs (the first price as the villager has adjusted it), what
// it gives and how many more times it can be done.
export function offerOf(trade, index) {
  const first = trade.inputItem1;
  const inputs = [{ name: first?.name, count: trade.realPrice ?? first?.count, base: first?.count }];
  if (trade.hasItem2 && trade.inputItem2) inputs.push({ name: trade.inputItem2.name, count: trade.inputItem2.count, base: trade.inputItem2.count });
  const left = Math.max(0, (trade.maximumNbTradeUses ?? 0) - (trade.nbTradeUses ?? 0));
  const out = trade.outputItem;
  return {
    index,
    inputs,
    output: { name: out?.name, count: out?.count ?? 1, extra: out ? enchantText(out) : '' },
    left,
    soldOut: Boolean(trade.tradeDisabled) || left <= 0
  };
}

export function offerText(offer) {
  const cost = offer.inputs.map((i) => `${i.count} ${i.name}${i.count !== i.base ? ` (usually ${i.base})` : ''}`).join(' + ');
  const state = offer.soldOut ? 'sold out' : `${offer.left} ${offer.left === 1 ? 'use' : 'uses'} left`;
  return `${cost} -> ${offer.output.count} ${offer.output.name}${offer.output.extra} (${state})`;
}

const sameItem = (name, query) => name === query || name.endsWith(`_${query}`);

// The offer to take for item, or { problem }. Exact names go before short ones (book also
// matching enchanted_book). pay picks by what is paid; else the cheapest per item got. Offers that
// would use something kept (keeps(name)) are passed over.
export function chooseOffer(offers, item, { pay, keeps = () => false } = {}) {
  const exact = offers.filter((o) => o.output.name === item);
  let found = exact.length ? exact : offers.filter((o) => sameItem(o.output.name, item));
  if (!found.length) return { problem: `does not sell ${item}` };
  if (pay) {
    const paid = found.filter((o) => o.inputs.some((i) => i.name === pay || sameItem(i.name, pay)));
    if (!paid.length) return { problem: `does not sell ${item} for ${pay}. Its offers for ${item}: ${found.map(offerText).join('; ')}` };
    found = paid;
  }
  const kept = found.filter((o) => o.inputs.some((i) => keeps(i.name)));
  found = found.filter((o) => !kept.includes(o));
  if (!found.length) return { problem: `would have to pay with ${kept[0].inputs.filter((i) => keeps(i.name)).map((i) => i.name).join(' and ')}, which I am keeping for the build I am working on` };
  const open = found.filter((o) => !o.soldOut);
  if (!open.length) return { problem: `has sold out of ${item} (${found.map(offerText).join('; ')}). A villager restocks when it works at its job block, a wandering trader never does` };
  const cost = (o) => o.inputs.reduce((n, i) => n + i.count, 0) / (o.output.count || 1);
  return { offer: open.sort((a, b) => cost(a) - cost(b))[0] };
}

// How many times she can pay for offer from carried (a Map of name to count).
export function timesAffordable(offer, carried) {
  return Math.min(...offer.inputs.map((i) => Math.floor((carried.get(i.name) ?? 0) / Math.max(i.count, 1))));
}

function shortText(offer, carried) {
  const need = offer.inputs.map((i) => `${i.count} ${i.name}`).join(' and ');
  const have = offer.inputs.map((i) => `${carried.get(i.name) ?? 0} ${i.name}`).join(' and ');
  return `one trade costs ${need} and I have ${have}`;
}

function changeText(before, after, sign) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .map((n) => [n, sign * ((after.get(n) ?? 0) - (before.get(n) ?? 0))])
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
}

// Trades with the nearest villager or wandering trader (or the one villager names, nearest x y z
// when given). With list, or no item, says what it offers. Else buys item count times from the
// offer that gives it, as far as the uses left and what she carries allow. The trade window is
// always closed again.
export async function trade(ctx, { villager, item, count = 1, pay, list = false, x, y, z }) {
  const { bot, signal } = ctx;
  const near = x !== undefined && y !== undefined && z !== undefined ? new Vec3(x, y, z) : bot.entity.position;
  const target = pickTraders(bot, villager, near)[0];
  if (!target) return fail(`no ${villager ?? 'villager or wandering trader'} that trades within ${SEARCH_RANGE} blocks (babies, nitwits and villagers without a job have no trades)`);
  const who = () => `the ${traderText(bot, target)} at ${posText(target.position)}`;

  if (target.position.distanceTo(bot.entity.position) > TRADE_REACH) {
    const walked = await walkTo(ctx, new GoalFollow(target, 2), { place: false });
    if (signal?.aborted) return fail('stopped');
    if (!bot.entities[target.id] || target.position.distanceTo(bot.entity.position) > TRADE_REACH + 0.5) return fail(`could not get to ${who()}: ${walked.message}`);
  }
  // An item in hand could be used on it instead, like a name tag.
  if (bot.heldItem) {
    try {
      await bot.unequip('hand');
    } catch {}
  }

  // mineflayer only opens an entity whose type is villager, though a wandering trader's window
  // is the same.
  const villagerId = bot.registry.entitiesByName.villager.id;
  const asVillager = target.entityType === villagerId ? target : Object.create(target, { entityType: { value: villagerId } });
  const before = countItems(bot.inventory.items());
  let window;
  try {
    await pause(200, 400);
    window = await openWindow(ctx, () => bot.openVillager(asVillager));
  } catch (err) {
    if (err instanceof AbortedError) return fail('stopped');
    if (err instanceof TimeoutError) return fail(`${who()} did not open a trade window`);
    return fail(`could not open the trade window of ${who()}: ${err.message}`);
  }

  let offers = [];
  let chosen = null;
  let wanted = 0;
  let done = 0;
  let problem = '';
  let short = '';
  try {
    offers = (window.trades ?? []).map(offerOf);
    if (list || !item) return offers.length ? ok(`${who()} offers:\n${offers.map(offerText).join('\n')}`) : ok(`${who()} has no offers`);
    const keep = bot.buildKeep;
    const picked = chooseOffer(offers, item, { pay, keeps: (name) => Boolean(keep?.has(bot.registry.itemsByName[name]?.id)) });
    if (picked.problem) return fail(`${who()} ${picked.problem}`);
    chosen = picked.offer;
    const carried = countItems(window.items?.() ?? bot.inventory.items());
    const can = timesAffordable(chosen, carried);
    wanted = Math.min(Math.max(count ?? 1, 1), chosen.left, can);
    if (wanted < 1) return fail(`can't pay for ${chosen.output.name} from ${who()}: ${shortText(chosen, carried)}`);
    if (wanted < count && can < Math.min(count, chosen.left)) short = `I could only pay for ${can}: ${shortText(chosen, carried)}`;
    else if (wanted < count) short = `Only ${chosen.left} ${chosen.left === 1 ? 'use was' : 'uses were'} left`;
    for (let i = 0; i < wanted; i++) {
      if (signal?.aborted) {
        problem = 'stopped';
        break;
      }
      try {
        await guarded(() => bot.trade(window, chosen.index, 1), { ms: ctx.tradeMs ?? TRADE_MS, signal });
      } catch (err) {
        problem = err instanceof AbortedError ? 'stopped' : err instanceof TimeoutError ? 'the trade did not go through in time' : `the trade failed: ${err.message}`;
        break;
      }
      done++;
      ctx.status?.progress(`traded ${done} of ${wanted} for ${chosen.output.name} with ${who()}`);
      await pause(200, 400);
    }
    const now = window.trades?.[chosen.index];
    if (now) chosen = { ...chosen, left: offerOf(now, chosen.index).left };
  } finally {
    await pause(200, 400);
    window.close();
  }

  // The inventory is only up to date once the window is closed.
  const after = countItems(bot.inventory.items());
  const paid = changeText(before, after, -1) || 'nothing';
  const got = changeText(before, after, 1) || 'nothing';
  let message = `traded ${done} ${done === 1 ? 'time' : 'times'} with ${who()}: paid ${paid}, got ${got}. That offer has ${chosen.left} ${chosen.left === 1 ? 'use' : 'uses'} left`;
  if (short) message += `. ${short}`;
  if (problem) message += `. Stopped early: ${problem}`;
  return done ? ok(message) : fail(message);
}
