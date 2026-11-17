import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { brew, parsePotion, brewSteps, potionLabel, itemLabel, POTION_IDS, BREW_TIMES } from '../src/actions/brew.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);
Object.assign(BREW_TIMES, { start: 150, step: 1500, tick: 10 });

const STAND = new Vec3(2, 64, 0);
const WATER = new Vec3(-2, 63, 0);
const id = (name) => POTION_IDS.indexOf(name);
const bottle = (makes, name = 'potion') => ({ name, count: 1, stackSize: 1, componentMap: new Map([['potion_contents', { type: 'potion_contents', data: { potionId: id(makes) } }]]) });
const stack = (name, count) => ({ name, count, stackSize: 64 });

// What each ingredient turns a bottle into, as far as these tests need.
const TURNS = {
  nether_wart: { water: 'awkward' },
  sugar: { awkward: 'swiftness' },
  redstone: { swiftness: 'long_swiftness' },
  glowstone_dust: { swiftness: 'strong_swiftness' },
  fermented_spider_eye: { water: 'weakness', swiftness: 'slowness' }
};

// A bot next to a brewing stand, carrying items. The stand brews like the game's, only quicker:
// it takes blaze powder for fuel, starts when the ingredient works on a bottle, and sends its
// brew time and fuel as window properties. brewMs is how long a brew takes.
function fakeBot(items, { stand = [], fuel = 0, brewMs = 40, water = true } = {}) {
  const slots = Array(41).fill(null);
  stand.forEach((item, i) => (slots[i] = item));
  items.forEach((item, i) => (slots[5 + i] = item));
  const client = new EventEmitter();
  const window = {
    id: 3,
    type: 'minecraft:brewing_stand',
    slots,
    inventoryStart: 5,
    inventoryEnd: 41,
    selectedItem: null,
    closed: 0,
    items: () => slots.map((item, slot) => item && Object.assign(item, { slot })).slice(5).filter(Boolean),
    firstEmptySlotRange: (start, end) => {
      for (let s = start; s < end; s++) if (!slots[s]) return s;
      return null;
    },
    close: () => window.closed++
  };
  const props = { fuel, brewing: 0 };
  const send = (property, value) => client.emit('craft_progress_bar', { windowId: window.id, property, value });
  const timer = setInterval(() => {
    if (!slots[4] && props.fuel === 0) return;
    if (props.brewing) return;
    const ingredient = slots[3];
    const turns = ingredient && TURNS[ingredient.name];
    const bottles = [0, 1, 2].filter((s) => slots[s]);
    const works = ingredient?.name === 'gunpowder' ? bottles.length > 0 : bottles.some((s) => turns?.[POTION_IDS[slots[s].componentMap.get('potion_contents').data.potionId]]);
    if (!works) return;
    if (props.fuel === 0) {
      slots[4].count--;
      if (!slots[4].count) slots[4] = null;
      props.fuel = 20;
      send(1, 20);
    }
    props.brewing = 400;
    send(0, 400);
    setTimeout(() => {
      props.brewing = 0;
      send(0, 0);
      // Taking a bottle or the ingredient out stops the brew.
      if (!slots[3] || bottles.some((s) => !slots[s])) return;
      for (const s of bottles) {
        const makes = POTION_IDS[slots[s].componentMap.get('potion_contents').data.potionId];
        if (ingredient.name === 'gunpowder') slots[s] = bottle(makes, 'splash_potion');
        else if (turns[makes]) slots[s] = bottle(turns[makes], slots[s].name);
      }
      if (--slots[3].count === 0) slots[3] = null;
      props.fuel--;
      send(1, props.fuel);
    }, brewMs);
  }, 5);
  const bot = {
    slots,
    window,
    _client: client,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry: { blocksByName: { water: { id: 9 } }, blocksArray: [{ id: 9, name: 'water' }, { id: 20, name: 'brewing_stand' }] },
    inventory: { items: () => window.items() },
    blockAt: (p) => {
      if (p.equals(STAND)) return { name: 'brewing_stand', position: p, boundingBox: 'block' };
      if (water && p.equals(WATER)) return { name: 'water', position: p, boundingBox: 'empty', getProperties: () => ({ level: 0 }) };
      return { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) };
    },
    findBlocks: ({ matching }) => {
      const found = [];
      if (water && matching === 9) found.push(WATER);
      if (matching.includes?.(20)) found.push(STAND);
      return found;
    },
    lookAt: async () => {},
    equip: async () => {},
    openBlock: async () => {
      setImmediate(() => {
        send(0, props.brewing);
        send(1, props.fuel);
      });
      return window;
    },
    clickWindow: async (slot, button) => {
      const here = slots[slot];
      const held = window.selectedItem;
      if (button === 0) {
        if (held && here && here.name === held.name && held.stackSize > 1) {
          here.count += held.count;
          window.selectedItem = null;
        } else {
          slots[slot] = held;
          window.selectedItem = here;
        }
      } else if (held) {
        if (!here) slots[slot] = { ...held, count: 1 };
        else if (here.name === held.name) here.count++;
        else return;
        if (--held.count === 0) window.selectedItem = null;
      }
    },
    activateItem: () => {
      const glass = window.items().find((i) => i.name === 'glass_bottle');
      if (!glass) return;
      if (--glass.count === 0) slots[glass.slot] = null;
      slots[window.firstEmptySlotRange(5, 41)] = bottle('water');
    },
    stop: () => clearInterval(timer)
  };
  return bot;
}

const ctxFor = (bot, extra = {}) => {
  const progress = [];
  return { bot, progress, openMs: 500, config: { limits: { moveTimeoutSeconds: 5 } }, status: { progress: (text) => progress.push(text) }, ...extra };
};
const at = { x: STAND.x, y: STAND.y, z: STAND.z };

async function withBot(bot, run) {
  try {
    return await run(bot);
  } finally {
    bot.stop();
  }
}

test('potion names are read with long, strong and splash, and each has its chain of steps', () => {
  assert.deepEqual(parsePotion('Long Swiftness'), { name: 'swiftness', long: true, strong: false, splash: false });
  assert.deepEqual(parsePotion('splash potion of fire resistance'), { name: 'fire_resistance', long: false, strong: false, splash: true });
  assert.deepEqual(parsePotion('strong_turtle_master'), { name: 'turtle_master', long: false, strong: true, splash: false });
  assert.equal(parsePotion('luck'), null);
  const ingredients = (text) => brewSteps(parsePotion(text)).map((s) => s.ingredient);
  assert.deepEqual(ingredients('weakness'), ['fermented_spider_eye']);
  assert.deepEqual(ingredients('long invisibility'), ['nether_wart', 'golden_carrot', 'fermented_spider_eye', 'redstone']);
  assert.deepEqual(ingredients('splash strong harming'), ['nether_wart', 'glistering_melon_slice', 'fermented_spider_eye', 'glowstone_dust', 'gunpowder']);
  assert.equal(potionLabel('long_swiftness'), 'potion of long swiftness');
  assert.equal(itemLabel(bottle('water')), 'water bottle');
  assert.equal(itemLabel(bottle('awkward')), 'awkward potion');
  assert.equal(itemLabel(bottle('healing', 'splash_potion')), 'splash potion of healing');
});

test('names she cannot brew, or a long or strong that does not exist, are turned down', async () => {
  const bot = fakeBot([]);
  await withBot(bot, async () => {
    assert.match((await brew(ctxFor(bot), { potion: 'luck', ...at })).message, /^I don't know a potion called "luck"/);
    assert.equal((await brew(ctxFor(bot), { potion: 'long healing', ...at })).message, "there's no long potion of healing");
    assert.equal((await brew(ctxFor(bot), { potion: 'strong fire resistance', ...at })).message, "there's no strong potion of fire resistance");
    assert.equal((await brew(ctxFor(bot), { potion: 'long strong swiftness', ...at })).message, 'a potion can be long or strong, not both');
  });
});

test('what the whole chain is short of is listed before anything goes in', async () => {
  const bot = fakeBot([bottle('water'), stack('nether_wart', 1), stack('sugar', 3)], { water: false });
  await withBot(bot, async () => {
    const before = bot.slots.map((s) => s && `${s.name}:${s.count}`);
    const result = await brew(ctxFor(bot), { potion: 'long swiftness', count: 6, ...at });
    assert.deepEqual(result, {
      ok: false,
      message: "can't brew 6 potion of long swiftness at the brewing stand at 2 64 0 yet. Short of: 1 nether_wart, 2 redstone, 1 blaze_powder (1 of it for fuel), 5 water bottles (or glass bottles to fill). Get them with obtain, then brew again"
    });
    assert.deepEqual(bot.slots.map((s) => s && `${s.name}:${s.count}`), before);
    assert.equal(bot.window.closed, 1);
  });
});

test('she brews the chain step by step, fills glass bottles at water first, and takes the potions back', async () => {
  const bot = fakeBot([stack('glass_bottle', 3), stack('nether_wart', 2), stack('sugar', 2), stack('blaze_powder', 1)]);
  await withBot(bot, async () => {
    const ctx = ctxFor(bot);
    const result = await brew(ctx, { potion: 'swiftness', ...at });
    assert.deepEqual(result, { ok: true, message: 'brewed 3 potions of swiftness at the brewing stand at 2 64 0' });
    assert.deepEqual([0, 1, 2, 3].map((s) => bot.slots[s]), [null, null, null, null]);
    assert.equal(bot.slots[4], null);
    const left = Object.fromEntries(bot.window.items().map((i) => [i.name, i.count]));
    assert.equal(left.nether_wart, 1);
    assert.equal(left.sugar, 1);
    assert.ok(ctx.progress.some((line) => /^brewing at the brewing stand at 2 64 0: nether_wart in, \d+ s left$/.test(line)));
    assert.ok(ctx.progress.includes('brewing at the brewing stand at 2 64 0: 3 awkward potions now'));
    assert.ok(bot.window.closed >= 2);
  });
});

test('more than 3 bottles go in batches, and fuel already in the stand is used first', async () => {
  const items = [...Array(5)].map(() => bottle('water'));
  const bot = fakeBot([...items, stack('fermented_spider_eye', 2)], { fuel: 5 });
  await withBot(bot, async () => {
    const result = await brew(ctxFor(bot), { potion: 'weakness', count: 5, ...at });
    assert.deepEqual(result, { ok: true, message: 'brewed 5 potions of weakness at the brewing stand at 2 64 0' });
  });
});

test('with wait false the first step is loaded and left, and brewing again carries on from it', async () => {
  const bot = fakeBot([bottle('water'), bottle('water'), stack('nether_wart', 1), stack('sugar', 1), stack('redstone', 1), stack('blaze_powder', 1)]);
  await withBot(bot, async () => {
    const first = await brew(ctxFor(bot), { potion: 'long swiftness', count: 2, wait: false, ...at });
    assert.deepEqual(first, {
      ok: true,
      message: 'put 2 water bottles and nether_wart in the brewing stand at 2 64 0. In about 20 s they will be awkward potion. Still to add after it, one at a time: sugar, redstone. Run brew with the same potion again to carry on'
    });
    assert.equal(bot.slots[3].name, 'nether_wart');
    await new Promise((r) => setTimeout(r, 150));
    const rest = await brew(ctxFor(bot), { potion: 'long swiftness', count: 2, ...at });
    assert.deepEqual(rest, { ok: true, message: 'brewed 2 potions of long swiftness at the brewing stand at 2 64 0' });
  });
});

test("a player's brew in the stand is left alone", async () => {
  const bot = fakeBot([stack('sugar', 1)], { stand: [bottle('healing'), null, null], fuel: 10 });
  await withBot(bot, async () => {
    const result = await brew(ctxFor(bot), { potion: 'swiftness', count: 1, ...at });
    assert.deepEqual(result, { ok: false, message: "the brewing stand at 2 64 0 holds 1 potion of healing, which isn't on the way to potion of swiftness. Take them out first" });
    assert.equal(itemLabel(bot.slots[0]), 'potion of healing');
  });
});

test('stopped mid-chain, she takes the bottles back, says what they are now and closes the stand', async () => {
  const bot = fakeBot([bottle('water'), stack('nether_wart', 1), stack('sugar', 1), stack('blaze_powder', 1)], { brewMs: 30 });
  await withBot(bot, async () => {
    const controller = new AbortController();
    const ctx = ctxFor(bot, { signal: controller.signal });
    const watch = setInterval(() => {
      if (ctx.progress.some((l) => / now$/.test(l))) controller.abort();
    }, 5);
    let result;
    try {
      result = await brew(ctx, { potion: 'swiftness', count: 1, ...at });
    } finally {
      clearInterval(watch);
    }
    assert.equal(result.ok, false);
    assert.match(result.message, /^stopped brewing potion of swiftness: stopped \(at the sugar step\)\. The bottles are now 1 (awkward potion|potion of swiftness), back in my inventory$/);
    assert.deepEqual([0, 1, 2, 3].map((s) => bot.slots[s]), [null, null, null, null]);
    assert.equal(bot.window.closed, 1);
  });
});

test('an ingredient that never starts a brew ends it with the bottles and the ingredient back', async () => {
  // This stand has no rule for pufferfish, so the second step never starts.
  const bot = fakeBot([bottle('water'), stack('nether_wart', 1), stack('pufferfish', 1)], { fuel: 10 });
  await withBot(bot, async () => {
    const result = await brew(ctxFor(bot), { potion: 'water breathing', count: 1, ...at });
    assert.deepEqual(result, {
      ok: false,
      message: 'stopped brewing potion of water breathing: pufferfish does nothing to 1 awkward potion (at the pufferfish step). The bottles are now 1 awkward potion, back in my inventory'
    });
    assert.deepEqual([0, 1, 2, 3].map((s) => bot.slots[s]), [null, null, null, null]);
    assert.ok(bot.window.items().some((i) => i.name === 'pufferfish'));
  });
});
