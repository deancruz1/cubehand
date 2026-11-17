import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { trade, pickTraders, professionOf, offerOf, offerText, chooseOffer, timesAffordable, PROFESSIONS } from '../src/actions/trade.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);

const KEYS = ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health', 'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'mob_flags', 'baby', 'age_locked', 'unhappy_counter', 'villager_data', 'villager_finalized'];
const VILLAGER_ID = 139;
const TRADER_ID = 141;
const ITEM_IDS = { emerald: 1, book: 2, enchanted_book: 3, paper: 4, wheat: 5, bread: 6, bookshelf: 7, glass: 8 };

let nextId = 10;
function villager(job, at, { baby = false, tag = null, wandering = false } = {}) {
  const metadata = [];
  metadata[16] = baby;
  if (!wandering) metadata[19] = { villagerType: 0, villagerProfession: PROFESSIONS.indexOf(job), level: 1 };
  if (tag) metadata[2] = tag;
  return {
    id: nextId++,
    name: wandering ? 'wandering_trader' : 'villager',
    entityType: wandering ? TRADER_ID : VILLAGER_ID,
    type: 'passive',
    position: at,
    metadata,
    getCustomName: () => tag
  };
}

const item = (name, count) => ({ name, count, type: ITEM_IDS[name] });
// One trade as mineflayer gives it: realPrice is the first price as the villager adjusted it.
function offer(input1, output, { input2 = null, uses = 0, max = 12, price = input1[1], disabled = false } = {}) {
  return {
    inputItem1: item(...input1),
    inputItem2: input2 ? item(...input2) : undefined,
    hasItem2: Boolean(input2),
    outputItem: item(...output),
    realPrice: price,
    nbTradeUses: uses,
    maximumNbTradeUses: max,
    tradeDisabled: disabled
  };
}

// A bot standing at 0 64 0 with the given entities and items. openVillager opens a window with the
// trades of that entity (from trades, by its id), and only for a villager's entity type, as
// mineflayer does. Trading takes the inputs and gives the output.
function fakeBot(entities, trades, items, { failTrade = null } = {}) {
  const inventory = items.map(([name, count]) => ({ name, count }));
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    registry: {
      entitiesByName: { villager: { id: VILLAGER_ID, metadataKeys: KEYS }, wandering_trader: { id: TRADER_ID, metadataKeys: KEYS.slice(0, 19) } },
      itemsByName: Object.fromEntries(Object.entries(ITEM_IDS).map(([name, id]) => [name, { id, name }]))
    },
    inventory: { items: () => inventory.filter((i) => i.count > 0) },
    heldItem: null,
    opened: [],
    closed: 0,
    tradesDone: [],
    openVillager: async (e) => {
      if (e.entityType !== VILLAGER_ID) throw new Error('not a villager');
      bot.opened.push(e.id);
      return {
        trades: trades[e.id] ?? [],
        items: () => bot.inventory.items(),
        close: () => {
          bot.closed++;
        }
      };
    },
    trade: async (window, index, count) => {
      if (failTrade) throw new Error(failTrade);
      const t = window.trades[index];
      const pay = (name, n) => {
        let left = n;
        for (const i of inventory) {
          if (i.name !== name || !left) continue;
          const take = Math.min(i.count, left);
          i.count -= take;
          left -= take;
        }
        if (left) throw new Error(`Not enough ${name}`);
      };
      for (let k = 0; k < count; k++) {
        pay(t.inputItem1.name, t.realPrice);
        if (t.hasItem2) pay(t.inputItem2.name, t.inputItem2.count);
        const have = inventory.find((i) => i.name === t.outputItem.name);
        if (have) have.count += t.outputItem.count;
        else inventory.push({ name: t.outputItem.name, count: t.outputItem.count });
        t.nbTradeUses++;
        bot.tradesDone.push(index);
      }
    }
  };
  return { bot, inventory };
}

function fakeCtx(bot) {
  const progress = [];
  return { bot, progress, config: { limits: { moveTimeoutSeconds: 5 } }, status: { progress: (text) => progress.push(text) } };
}

test('a villager profession is read from its metadata, and traders are picked by job, name tag or kind, nearest first', () => {
  const librarian = villager('librarian', new Vec3(2, 64, 0));
  const farFarmer = villager('farmer', new Vec3(10, 64, 0));
  const farmer = villager('farmer', new Vec3(-3, 64, 0));
  const nitwit = villager('nitwit', new Vec3(1, 64, 1));
  const jobless = villager('none', new Vec3(1, 64, -1));
  const baby = villager('farmer', new Vec3(0, 64, 2), { baby: true });
  const bob = villager('mason', new Vec3(5, 64, 5), { tag: 'Bob' });
  const trader = villager(null, new Vec3(6, 64, 0), { wandering: true });
  const far = villager('librarian', new Vec3(40, 64, 0));
  const { bot } = fakeBot([librarian, farFarmer, farmer, nitwit, jobless, baby, bob, trader, far], {}, []);
  assert.equal(professionOf(bot, librarian), 'librarian');
  assert.equal(professionOf(bot, trader), null);
  const ids = (list) => list.map((e) => e.id);
  assert.deepEqual(ids(pickTraders(bot)), ids([librarian, farmer, trader, bob, farFarmer]));
  assert.deepEqual(ids(pickTraders(bot, 'farmers')), ids([farmer, farFarmer]));
  assert.deepEqual(ids(pickTraders(bot, 'farmer', new Vec3(9, 64, 0))), ids([farFarmer, farmer]));
  assert.deepEqual(ids(pickTraders(bot, 'Bob')), ids([bob]));
  assert.deepEqual(ids(pickTraders(bot, 'wandering trader')), ids([trader]));
  assert.deepEqual(ids(pickTraders(bot, 'villager')), ids([librarian, farmer, bob, farFarmer]));
  assert.deepEqual(pickTraders(bot, 'cleric'), []);
});

test('offers read the adjusted price and the uses left, and the cheapest offer for an item is taken unless pay says otherwise', () => {
  const offers = [
    offer(['emerald', 12], ['enchanted_book', 1], { input2: ['book', 1], price: 9, uses: 1, max: 12 }),
    offer(['paper', 24], ['emerald', 1], { uses: 16, max: 16 }),
    offer(['emerald', 1], ['bookshelf', 1], { max: 12 }),
    offer(['emerald', 5], ['bookshelf', 1], { input2: ['book', 3] }),
    offer(['emerald', 2], ['glass', 4])
  ].map(offerOf);
  assert.equal(offerText(offers[0]), '9 emerald (usually 12) + 1 book -> 1 enchanted_book (11 uses left)');
  assert.equal(offerText(offers[1]), '24 paper -> 1 emerald (sold out)');
  assert.equal(chooseOffer(offers, 'bookshelf').offer.index, 2);
  assert.equal(chooseOffer(offers, 'bookshelf', { pay: 'book' }).offer.index, 3);
  assert.match(chooseOffer(offers, 'bookshelf', { pay: 'paper' }).problem, /does not sell bookshelf for paper/);
  // book matches enchanted_book only when nothing sells plain books.
  assert.equal(chooseOffer(offers, 'book').offer.index, 0);
  assert.match(chooseOffer(offers, 'emerald').problem, /has sold out of emerald \(24 paper -> 1 emerald \(sold out\)\)/);
  assert.equal(chooseOffer(offers, 'diamond').problem, 'does not sell diamond');
  assert.match(chooseOffer(offers, 'glass', { keeps: (name) => name === 'emerald' }).problem, /pay with emerald, which I am keeping for the build/);
  assert.equal(timesAffordable(offers[0], new Map([['emerald', 30], ['book', 2]])), 2);
  assert.equal(timesAffordable(offers[0], new Map([['emerald', 30]])), 0);
});

test('trade lists what the nearest villager offers and closes the window, buying nothing', async () => {
  const librarian = villager('librarian', new Vec3(2, 64, 0));
  const trades = { [librarian.id]: [offer(['paper', 24], ['emerald', 1], { max: 16 }), offer(['emerald', 12], ['enchanted_book', 1], { input2: ['book', 1], price: 10, uses: 12 })] };
  const { bot, inventory } = fakeBot([librarian], trades, [['emerald', 20]]);
  const result = await trade(fakeCtx(bot), { list: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'the librarian at 2 64 0 offers:\n24 paper -> 1 emerald (16 uses left)\n10 emerald (usually 12) + 1 book -> 1 enchanted_book (sold out)');
  assert.equal(bot.closed, 1);
  assert.deepEqual(bot.tradesDone, []);
  assert.deepEqual(inventory, [{ name: 'emerald', count: 20 }]);
  // No item is a list too.
  assert.match((await trade(fakeCtx(bot), {})).message, /^the librarian at 2 64 0 offers:/);
  assert.equal(bot.closed, 2);
});

test('trade buys count times, reports what went and came from the inventory, and the uses left', async () => {
  const farmer = villager('farmer', new Vec3(2, 64, 0));
  const trades = { [farmer.id]: [offer(['wheat', 20], ['emerald', 1], { max: 16, uses: 2 }), offer(['emerald', 1], ['bread', 6])] };
  const { bot, inventory } = fakeBot([farmer], trades, [['wheat', 64], ['emerald', 2]]);
  const ctx = fakeCtx(bot);
  const result = await trade(ctx, { villager: 'farmer', item: 'emerald', count: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, 'traded 3 times with the farmer at 2 64 0: paid 60 wheat, got 3 emerald. That offer has 11 uses left');
  assert.deepEqual(inventory, [{ name: 'wheat', count: 4 }, { name: 'emerald', count: 5 }]);
  assert.deepEqual(ctx.progress, ['traded 1 of 3 for emerald with the farmer at 2 64 0', 'traded 2 of 3 for emerald with the farmer at 2 64 0', 'traded 3 of 3 for emerald with the farmer at 2 64 0']);
  assert.equal(bot.closed, 1);
});

test('trade stops at what she can pay and the uses left, and says what she is short of', async () => {
  const librarian = villager('librarian', new Vec3(2, 64, 0));
  const trades = { [librarian.id]: [offer(['emerald', 12], ['enchanted_book', 1], { input2: ['book', 1], price: 10, max: 12, uses: 0 }), offer(['emerald', 1], ['bookshelf', 1], { max: 12, uses: 10 })] };
  const { bot } = fakeBot([librarian], trades, [['emerald', 25], ['book', 5]]);
  const partly = await trade(fakeCtx(bot), { item: 'enchanted_book', count: 4 });
  assert.equal(partly.ok, true, partly.message);
  assert.equal(partly.message, 'traded 2 times with the librarian at 2 64 0: paid 20 emerald, 2 book, got 2 enchanted_book. That offer has 10 uses left. I could only pay for 2: one trade costs 10 emerald and 1 book and I have 25 emerald and 5 book');
  const none = await trade(fakeCtx(bot), { item: 'enchanted_book' });
  assert.equal(none.ok, false);
  assert.equal(none.message, "can't pay for enchanted_book from the librarian at 2 64 0: one trade costs 10 emerald and 1 book and I have 5 emerald and 3 book");
  const uses = await trade(fakeCtx(bot), { item: 'bookshelf', count: 5 });
  assert.equal(uses.ok, true, uses.message);
  assert.match(uses.message, /^traded 2 times .*paid 2 emerald, got 2 bookshelf\. That offer has 0 uses left\. Only 2 uses were left$/);
  assert.equal(bot.closed, 3);
});

test('a sold-out offer, an item nobody sells and no trader in range are failures with the reason', async () => {
  const smith = villager('toolsmith', new Vec3(2, 64, 0));
  const trades = { [smith.id]: [offer(['emerald', 1], ['stone_axe', 1], { max: 12, uses: 12 })] };
  const { bot } = fakeBot([smith], trades, [['emerald', 10]]);
  const soldOut = await trade(fakeCtx(bot), { item: 'stone_axe' });
  assert.equal(soldOut.ok, false);
  assert.match(soldOut.message, /^the toolsmith at 2 64 0 has sold out of stone_axe .*restocks when it works at its job block/);
  const unsold = await trade(fakeCtx(bot), { item: 'diamond' });
  assert.equal(unsold.message, 'the toolsmith at 2 64 0 does not sell diamond');
  assert.equal(bot.closed, 2);
  const nobody = await trade(fakeCtx(bot), { villager: 'cleric', item: 'redstone' });
  assert.equal(nobody.ok, false);
  assert.match(nobody.message, /^no cleric that trades within 32 blocks/);
});

test('a wandering trader opens like a villager, and the window closes when a trade throws or the job is stopped', async () => {
  const trader = villager(null, new Vec3(2, 64, 0), { wandering: true });
  const trades = { [trader.id]: [offer(['emerald', 1], ['glass', 4], { max: 5 })] };
  const { bot } = fakeBot([trader], trades, [['emerald', 3]]);
  const bought = await trade(fakeCtx(bot), { villager: 'wandering_trader', item: 'glass', count: 2 });
  assert.equal(bought.ok, true, bought.message);
  assert.match(bought.message, /^traded 2 times with the wandering trader at 2 64 0: paid 2 emerald, got 8 glass\. That offer has 3 uses left$/);
  assert.deepEqual(bot.opened, [trader.id]);

  const broken = fakeBot([trader], trades, [['emerald', 3]], { failTrade: 'Not enough item 1 to trade' }).bot;
  const failed = await trade(fakeCtx(broken), { item: 'glass' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^traded 0 times .*paid nothing, got nothing\..*Stopped early: the trade failed: Not enough item 1 to trade$/);
  assert.equal(broken.closed, 1);

  const slow = fakeBot([trader], trades, [['emerald', 3]]).bot;
  const controller = new AbortController();
  slow.trade = () => {
    controller.abort();
    return new Promise(() => {});
  };
  const stopped = await trade({ ...fakeCtx(slow), signal: controller.signal }, { item: 'glass', count: 2 });
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /Stopped early: stopped$/);
  assert.equal(slow.closed, 1);
});

test('she never pays with something a build she is working on keeps', async () => {
  const mason = villager('mason', new Vec3(2, 64, 0));
  const trades = { [mason.id]: [offer(['emerald', 1], ['glass', 4])] };
  const { bot, inventory } = fakeBot([mason], trades, [['emerald', 3]]);
  bot.buildKeep = new Set([ITEM_IDS.emerald]);
  const result = await trade(fakeCtx(bot), { item: 'glass' });
  assert.equal(result.ok, false);
  assert.match(result.message, /^the mason at 2 64 0 would have to pay with emerald, which I am keeping for the build I am working on$/);
  assert.deepEqual(inventory, [{ name: 'emerald', count: 3 }]);
  assert.equal(bot.closed, 1);
});

test('she walks up to a villager out of reach before opening its window', async () => {
  const butcher = villager('butcher', new Vec3(12, 64, 0));
  const trades = { [butcher.id]: [offer(['emerald', 1], ['bread', 6])] };
  const { bot } = fakeBot([butcher], trades, [['emerald', 1]]);
  const goals = [];
  bot.moveModes = Object.fromEntries(['walk', 'climb', 'noPlace', 'follow'].map((n) => [n, { exclusionAreasBreak: [] }]));
  bot.pathfinder = {
    setGoal: () => {},
    setMovements: () => {},
    isMining: () => false,
    isBuilding: () => false,
    goto: async (goal) => {
      goals.push(goal);
      bot.entity.position = goal.entity.position.offset(-1.5, 0, 0.5);
    }
  };
  const result = await trade(fakeCtx(bot), { villager: 'butcher', item: 'bread' });
  assert.equal(result.ok, true, result.message);
  assert.equal(goals[0].entity, butcher);
  assert.match(result.message, /^traded 1 time with the butcher at 12 64 0: paid 1 emerald, got 6 bread/);
});
