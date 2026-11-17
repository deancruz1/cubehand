import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { fish, fishingSpot, FISH_TIMES } from '../src/actions/fishing.js';

Object.assign(FISH_TIMES, { land: 20, bite: 100, arrive: 200 });

const SOLID = new Set(['stone', 'dirt']);
const WATER_ID = 9;

// A pond with its surface at y 62, from x -6 to -1 and z -3 to 3, on stone. Stone banks to the
// east are level with the water, with air above.
function pond(x, y, z) {
  if (y > 62) return 'air';
  if (y === 62 && x >= -6 && x <= -1 && z >= -3 && z <= 3) return 'water';
  return 'stone';
}

// bite(bot, n) runs on cast n (from 1) and says what happens: 'bite' after a moment, or nothing,
// leaving the bobber out until it's reeled in. bobberAt is where the bobber comes down.
function fakeBot(fill = pond, { rod = true, bite = () => 'bite', catchName = 'cod', bobberAt = new Vec3(-4.5, 62.9, 0.5) } = {}) {
  const items = rod ? [{ name: 'fishing_rod', count: 1 }] : [];
  const nameAt = (p) => fill(p.x, p.y, p.z);
  let pending = null;
  const bot = {
    entity: { position: new Vec3(0.5, 63, 0.5), isInWater: false },
    entities: {},
    items,
    casts: 0,
    reeled: 0,
    heldItem: null,
    registry: { blocksByName: { water: { id: WATER_ID } } },
    inventory: { items: () => items },
    blockAt: (p) => {
      const f = p.floored();
      const name = nameAt(f);
      return { name, position: f, boundingBox: SOLID.has(name) ? 'block' : 'empty', getProperties: () => ({}) };
    },
    findBlocks: ({ maxDistance }) => {
      const found = [];
      for (let x = -12; x <= 12; x++) for (let y = 58; y <= 66; y++) for (let z = -12; z <= 12; z++) {
        const p = new Vec3(x, y, z);
        if (nameAt(p) === 'water' && p.distanceTo(bot.entity.position) <= maxDistance) found.push(p);
      }
      return found;
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    lookAt: async () => {},
    fish: () =>
      new Promise((resolve, reject) => {
        bot.casts++;
        pending = { resolve, reject };
        bot.entities.bobber = { name: 'fishing_bobber', position: bobberAt };
        if (bite(bot, bot.casts) !== 'bite') return;
        setTimeout(() => {
          if (!pending) return;
          pending = null;
          delete bot.entities.bobber;
          resolve();
          setTimeout(() => {
            const had = items.find((i) => i.name === catchName);
            if (had) had.count++;
            else items.push({ name: catchName, count: 1 });
          }, 10);
        }, 10);
      }),
    activateItem: () => {
      bot.reeled++;
      delete bot.entities.bobber;
      if (pending) pending.reject(new Error('Fishing cancelled'));
      pending = null;
    }
  };
  return bot;
}

const ctxFor = (bot, extra = {}) => {
  const progress = [];
  return { bot, progress, config: { limits: { moveTimeoutSeconds: 5 } }, status: { progress: (text) => progress.push(text) }, ...extra };
};

test('the spot to fish from is dry bank right by the water, aiming at water a few blocks out', () => {
  const bot = fakeBot();
  const waters = bot.findBlocks({ maxDistance: 24 });
  const spot = fishingSpot((p) => bot.blockAt(p), waters, bot.entity.position);
  assert.deepEqual(spot.stand, new Vec3(0, 63, 0));
  assert.equal(bot.blockAt(spot.stand.offset(0, -1, 0)).name, 'stone');
  assert.ok(spot.targets.length > 0);
  for (const t of spot.targets) {
    assert.equal(bot.blockAt(t).name, 'water');
    const d = Math.hypot(t.x - spot.stand.x, t.z - spot.stand.z);
    assert.ok(d >= 2 && d <= 6, `target ${t} is ${d} away`);
  }
  // A puddle is no place to fish.
  const puddle = (x, y, z) => (y > 62 ? 'air' : y === 62 && x === -1 && (z === 0 || z === 1) ? 'water' : 'stone');
  const small = fakeBot(puddle);
  assert.equal(fishingSpot((p) => small.blockAt(p), small.findBlocks({ maxDistance: 24 }), small.entity.position), null);
});

test('no rod or no water near gives a plain reason, and no rod is ever made', async () => {
  const none = await fish(ctxFor(fakeBot(pond, { rod: false })), {});
  assert.deepEqual(none, { ok: false, message: "I don't have a fishing rod" });
  const dry = await fish(ctxFor(fakeBot((x, y) => (y > 62 ? 'air' : 'stone'))), {});
  assert.deepEqual(dry, { ok: false, message: 'no open water within 24 blocks with a dry bank to fish from' });
});

test('she casts until she has as many catches as asked, saying how it goes after each', async () => {
  const bot = fakeBot();
  const ctx = ctxFor(bot);
  const result = await fish(ctx, { count: 2 });
  assert.deepEqual(result, { ok: true, message: 'caught 2 cod in 2 casts from 0 63 0' });
  assert.deepEqual(ctx.progress, ['fishing: caught 1 of 2 so far (1 cod)', 'fishing: caught 2 of 2 so far (2 cod)']);
  assert.equal(bot.heldItem.name, 'fishing_rod');
});

test('a bobber that never bites is reeled in and cast again, until the time is up', async () => {
  const bot = fakeBot(pond, { bite: (b, n) => (n === 3 ? 'bite' : 'wait') });
  const result = await fish(ctxFor(bot), { count: 1, minutes: 0.01 });
  assert.equal(result.ok, true);
  assert.equal(result.message, 'caught 1 cod in 3 casts from 0 63 0');
  assert.equal(bot.reeled, 2);

  const never = fakeBot(pond, { bite: () => 'wait' });
  const nothing = await fish(ctxFor(never), { minutes: 0.005 });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /^caught nothing in \d+ casts from 0 63 0\. Stopped because 0\.005 minutes went by$/);
  assert.equal(never.entities.bobber, undefined);
});

test('stopping reels the bobber in and ends the job', async () => {
  const bot = fakeBot(pond, { bite: () => 'wait' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const result = await fish(ctxFor(bot, { signal: controller.signal }), { count: 5 });
  assert.deepEqual(result, { ok: false, message: 'caught nothing in 1 cast from 0 63 0. Stopped because stopped' });
  assert.equal(bot.reeled, 1);
  assert.equal(bot.entities.bobber, undefined);
});

test('a rod that breaks ends it with what was caught so far', async () => {
  const bot = fakeBot(pond, {
    bite: (b, n) => {
      // The rod wears out on the second catch.
      if (n === 2) setTimeout(() => {
        b.items.splice(b.items.findIndex((i) => i.name === 'fishing_rod'), 1);
        b.heldItem = null;
      }, 15);
      return 'bite';
    },
    catchName: 'salmon'
  });
  const result = await fish(ctxFor(bot), { count: 5 });
  assert.deepEqual(result, { ok: true, message: 'caught 2 salmon in 2 casts from 0 63 0, 2 of the 5 asked for. Stopped because my fishing rod broke' });
});

test('a bobber that keeps landing on the bank is reeled in, and she gives up saying why', async () => {
  const bot = fakeBot(pond, { bite: () => 'wait', bobberAt: new Vec3(2.5, 63, 0.5) });
  const result = await fish(ctxFor(bot), { count: 1 });
  assert.equal(result.ok, false);
  assert.match(result.message, /^caught nothing in \d+ casts from 0 63 0\. Stopped because the bobber kept landing out of the water from 0 63 0$/);
  assert.equal(bot.reeled, bot.casts);
});
