import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { tendAnimals, tendPens, pensDue, penRecord, nextVisit, animalKind, penAnimals, penArea } from '../src/actions/husbandry.js';
import { attack, isBaby } from '../src/actions/combat.js';
import { Tended } from '../src/tended.js';

const keys = (...more) => [...Array(16).fill('other'), 'baby', ...more];
const REGISTRY = {
  entitiesByName: {
    cow: { metadataKeys: keys('variant') },
    sheep: { metadataKeys: keys('wool') },
    pig: { metadataKeys: keys() },
    chicken: { metadataKeys: keys() }
  },
  blocksArray: [{ name: 'smoker', id: 1 }]
};

let nextId = 1;
// An animal at x z, a baby or named when asked, and for sheep sheared or not.
function animal(name, x, z, { baby = false, tag = null, sheared = false } = {}) {
  const metadata = [];
  metadata[16] = baby;
  if (name === 'sheep') metadata[17] = sheared ? 0x10 : 0;
  if (tag) metadata[2] = tag;
  const id = nextId++;
  return { id, uuid: `u${id}`, name, type: 'animal', position: new Vec3(x, 64, z), height: 1.4, width: 0.9, metadata, getCustomName: () => tag };
}

// A bot in the pen carrying items, and runners that only note what they were asked to do.
function setup(animals, items = []) {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    players: {},
    health: 20,
    game: { dimension: 'overworld' },
    registry: REGISTRY,
    inventory: { items: () => items.filter((i) => i.count > 0) },
    findBlocks: () => [new Vec3(0, 64, 6)]
  };
  bot.entities[0] = bot.entity;
  for (const a of animals) bot.entities[a.id] = a;
  const calls = { use: [], kill: [], smelt: [], walks: 0, collect: 0 };
  const take = (name) => {
    const item = items.find((i) => i.name === name && i.count > 0);
    item.count--;
  };
  const runners = {
    walk: async (ctx, goal) => {
      calls.walks++;
      const p = goal.entity?.position ?? new Vec3(goal.x, goal.y, goal.z);
      bot.entity.position = p.clone();
      return { ok: true, message: 'arrived' };
    },
    use: async (ctx, item, mob) => {
      calls.use.push({ item, mob });
      take(item === 'shears' || item === 'bucket' ? 'none' : item);
      return { ok: true, message: `used ${item}` };
    },
    kill: async (ctx, mob) => {
      calls.kill.push(mob);
      delete bot.entities[mob.id];
      items.push({ name: mob.name === 'cow' ? 'beef' : 'mutton', count: 2 });
      return 'killed';
    },
    smelt: async (ctx, input) => {
      calls.smelt.push(input);
      return { ok: true, message: `put ${input.item} in the smoker at 0 64 6` };
    },
    collect: async () => calls.collect++
  };
  // Shears and buckets are never used up in these tests.
  items.push({ name: 'none', count: 1000 });
  return { bot, ctx: { bot, signal: null, status: null }, runners, calls, items };
}

const box = { x: -4, y: 64, z: -4, x2: 4, y2: 65, z2: 4 };

test('a pen of cows gets its pairs fed, the surplus culled and the meat put on to cook', async () => {
  const cows = [0, 1, 2, 3, 4, 5].map((i) => animal('cow', i * 0.5, 0.5));
  const calf = animal('cow', 0.5, 1, { baby: true });
  const s = setup([...cows, calf], [{ name: 'wheat', count: 10 }, { name: 'coal', count: 4 }]);
  const result = await tendAnimals(s.ctx, { ...box }, s.runners);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.kinds.cow, { adults: 6, babies: 1, pairs: 2, culled: 2, kept: 4 });
  assert.equal(s.calls.use.length, 4);
  assert.ok(s.calls.use.every((u) => u.item === 'wheat' && cows.includes(u.mob)));
  assert.equal(new Set(s.calls.use.map((u) => u.mob.id)).size, 4);
  assert.equal(s.calls.kill.length, 2);
  assert.ok(!s.calls.kill.includes(calf));
  assert.deepEqual(s.calls.smelt, [{ item: 'beef', wait: false, make: false }]);
  assert.match(result.message, /cow: 6 adults, 1 babies, 2 pairs fed, 2 culled, 4 kept/);
  assert.match(result.message, /put beef in the smoker at 0 64 6/);
  assert.match(result.message, /Now carrying 4 beef/);
});

test('culling never takes babies, named animals or the ones just fed, and keeps at least 2', async () => {
  const named = animal('cow', 1, 1, { tag: 'Bessie' });
  const plain = [animal('cow', 0.5, 0.5), animal('cow', 1.5, 0.5)];
  const calves = [animal('cow', 0, 1, { baby: true }), animal('cow', 1, 0, { baby: true })];
  const s = setup([named, ...plain, ...calves]);
  const result = await tendAnimals(s.ctx, { ...box, keep: 0, breed: false, cook: false }, s.runners);
  assert.equal(result.kinds.cow.culled, 1);
  assert.equal(result.kinds.cow.kept, 2);
  assert.ok(plain.includes(s.calls.kill[0]));

  const fed = [0, 1, 2, 3].map((i) => animal('pig', i * 0.4, 0.5));
  const p = setup(fed, [{ name: 'carrot', count: 8 }]);
  await tendAnimals(p.ctx, { ...box, cull: false, cook: false }, p.runners);
  const again = await tendAnimals(p.ctx, { ...box, keep: 2, breed: false, cook: false }, p.runners);
  assert.equal(again.kinds.pig.culled, 0);
  assert.match(again.message, /2 more pig over the 2 to keep are named, just fed or got away/);
});

test('breeding says what food is missing or ran out, and leaves the fed ones out of the next go', async () => {
  const none = setup([animal('cow', 0.5, 0.5), animal('cow', 1, 0.5)]);
  const r1 = await tendAnimals(none.ctx, { ...box, cook: false }, none.runners);
  assert.equal(r1.ok, true);
  assert.match(r1.message, /no wheat to breed the cow/);

  const chickens = [0, 1, 2, 3].map((i) => animal('chicken', i * 0.4, 0.5));
  const short = setup(chickens, [{ name: 'wheat_seeds', count: 3 }]);
  const r2 = await tendAnimals(short.ctx, { ...box, cook: false }, short.runners);
  assert.equal(r2.kinds.chicken.pairs, 1);
  assert.match(r2.message, /fed 1 chicken with no partner/);
  assert.match(r2.message, /ran out of wheat_seeds and melon_seeds/);

  const more = setup(chickens, [{ name: 'wheat_seeds', count: 8 }]);
  await tendAnimals(more.ctx, { ...box, cook: false }, more.runners);
  const r3 = await tendAnimals(more.ctx, { ...box, cook: false }, more.runners);
  assert.equal(r3.kinds.chicken.pairs, 0);
});

test('sheep are sheared before culling, and only ones with wool; cows are only milked when asked', async () => {
  const flock = [animal('sheep', 0.5, 0.5), animal('sheep', 1, 0.5, { sheared: true }), animal('sheep', 1.5, 0.5), animal('sheep', 0.5, 1)];
  const s = setup(flock, [{ name: 'shears', count: 1 }]);
  const result = await tendAnimals(s.ctx, { ...box, keep: 2, breed: false, cook: false }, s.runners);
  const shears = s.calls.use.filter((u) => u.item === 'shears');
  assert.equal(shears.length, 3);
  assert.equal(result.kinds.sheep.sheared, 3);
  assert.equal(result.kinds.sheep.culled, 2);
  assert.ok(s.calls.use.length + s.calls.kill.length === 5);

  const cows = [animal('cow', 0.5, 0.5), animal('cow', 1, 0.5)];
  const c = setup(cows, [{ name: 'bucket', count: 2 }]);
  await tendAnimals(c.ctx, { ...box, breed: false, cook: false }, c.runners);
  assert.equal(c.calls.use.length, 0);
  const milked = await tendAnimals(c.ctx, { ...box, breed: false, cook: false, milk: true }, c.runners);
  assert.equal(milked.kinds.cow.milked, 2);
});

test('the pen is a box, or the animals around one spot, and one kind can be picked', async () => {
  const inside = animal('cow', 3, 3);
  const outside = animal('cow', 6, 6);
  const pig = animal('pig', 2, 2);
  const s = setup([inside, outside, pig]);
  assert.deepEqual(penAnimals(s.bot, penArea(box)).map((e) => e.id), [inside.id, pig.id]);
  assert.deepEqual(penAnimals(s.bot, penArea(box), 'cow').map((e) => e.id), [inside.id]);
  assert.deepEqual(penAnimals(s.bot, penArea({ x: 0, y: 64, z: 0 })).map((e) => e.id).sort(), [inside.id, outside.id, pig.id].sort());
  assert.equal(animalKind('Chickens'), 'chicken');
  assert.equal(animalKind('sheep'), 'sheep');
  assert.equal(animalKind('horse'), null);

  const result = await tendAnimals(s.ctx, { ...box, animal: 'pigs', cook: false }, s.runners);
  assert.deepEqual(Object.keys(result.kinds), ['pig']);
});

test('nothing to do is fine, and bad input or a huge pen is refused', async () => {
  const s = setup([animal('cow', 10, 10)]);
  const empty = await tendAnimals(s.ctx, { ...box }, s.runners);
  assert.equal(empty.ok, true);
  assert.match(empty.message, /no farm animals in the pen -4 64 -4 to 4 65 4, nothing to do/);
  assert.equal((await tendAnimals(s.ctx, { ...box, animal: 'horse' }, s.runners)).ok, false);
  assert.equal((await tendAnimals(s.ctx, { x: 0, y: 64 }, s.runners)).ok, false);
  assert.match((await tendAnimals(s.ctx, { x: 0, y: 64, z: 0, x2: 60, y2: 64, z2: 0 }, s.runners)).message, /limit is 48/);
});

test('a stop ends the job with what was done so far', async () => {
  const cows = [0, 1, 2, 3, 4, 5].map((i) => animal('cow', i * 0.4, 0.5));
  const s = setup(cows, [{ name: 'wheat', count: 10 }]);
  const controller = new AbortController();
  s.ctx.signal = controller.signal;
  const use = s.runners.use;
  s.runners.use = async (ctx, input) => {
    const r = await use(ctx, input);
    if (s.calls.use.length === 2) controller.abort();
    return r;
  };
  const result = await tendAnimals(s.ctx, { ...box }, s.runners);
  assert.equal(result.kinds.cow.pairs, 1);
  assert.equal(s.calls.kill.length, 0);
  assert.match(result.message, /Stopped early: stopped/);
});

test('remembered pens are due by time, dimension and distance, and a visit sets the next one', async () => {
  const now = 10_000_000;
  const bot = { entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' } };
  const near = { x: 10, y: 64, z: 0, nextAt: now - 1 };
  const later = { x: 5, y: 64, z: 0, nextAt: now + 60000 };
  const nether = { x: 5, y: 64, z: 0, dimension: 'the_nether', nextAt: 0 };
  const far = { x: 500, y: 64, z: 0 };
  const fresh = { x: 3, y: 64, z: 0 };
  assert.deepEqual(pensDue(bot, [near, later, nether, far, fresh], now), [fresh, near]);
  assert.deepEqual(pensDue(bot, [], now), []);

  assert.equal(nextVisit({ cow: { pairs: 1 } }, now), now + 5 * 60000);
  assert.equal(nextVisit({ cow: { pairs: 0 } }, now), now + 20 * 60000);
  const record = penRecord({ x: 1, y: 64, z: 2, x2: 5, animal: 'cow', keep: 3 }, bot, now);
  assert.deepEqual(record, { x: 1, y: 64, z: 2, x2: 5, y2: 64, z2: 2, dimension: 'overworld', lastTended: now, nextAt: now + 5 * 60000, animal: 'cow', keep: 3 });

  const s = setup([animal('cow', 0.5, 0.5), animal('cow', 1, 0.5)], [{ name: 'wheat', count: 2 }]);
  const pen = { ...box };
  const done = await tendPens(s.ctx, [pen], s.runners);
  assert.equal(done.ok, true);
  assert.ok(pen.nextAt > Date.now() + 4 * 60000 && pen.nextAt <= Date.now() + 5 * 60000);
  assert.match((await tendPens(s.ctx, [pen], s.runners)).message, /no pen is due/);
});

test('in a crowded pen the food, shears and bucket go to the exact animal chosen', async () => {
  // A calf and a cow outside the pen stand closer to her than the adults she feeds.
  const calf = animal('cow', 0.5, 0.5, { baby: true });
  const stray = animal('cow', 0.6, -4.5);
  const cows = [animal('cow', 2, 2), animal('cow', 3, 2)];
  const flock = [animal('sheep', 2, 3), animal('sheep', 3, 3, { sheared: true })];
  const s = setup([calf, stray, ...cows, ...flock], [{ name: 'wheat', count: 4 }, { name: 'shears', count: 1 }, { name: 'bucket', count: 2 }]);
  const pen = { x: -1, y: 64, z: -1, x2: 4, y2: 65, z2: 4 };
  await tendAnimals(s.ctx, { ...pen, cull: false, cook: false, milk: true }, s.runners);
  const used = (item) => s.calls.use.filter((u) => u.item === item).map((u) => u.mob.id).sort();
  assert.deepEqual(used('wheat'), [...cows, ...flock].map((e) => e.id).sort());
  assert.deepEqual(used('shears'), [flock[0].id]);
  assert.deepEqual(used('bucket'), cows.map((c) => c.id).sort());
  assert.ok(s.calls.use.every((u) => u.mob !== calf && u.mob !== stray));
});

test('a player\'s pen is remembered once, a new call replaces it, and tend false lets it go', async () => {
  const tended = new Tended();
  const s = setup([animal('cow', 0.5, 0.5), animal('cow', 1, 0.5)], [{ name: 'wheat', count: 4 }]);
  s.ctx.tended = tended;
  const self = await tendAnimals(s.ctx, { ...box, cook: false }, s.runners);
  assert.doesNotMatch(self.message, /tend this pen/);
  assert.equal(tended.list('pens', 'overworld').length, 0);

  s.ctx.requester = 'Steve';
  const first = await tendAnimals(s.ctx, { ...box, animal: 'cow', cook: false }, s.runners);
  assert.match(first.message, /I will tend this pen from now on$/);
  const [pen] = tended.list('pens', 'overworld');
  assert.equal(pen.animal, 'cow');
  assert.equal(pen.dimension, 'overworld');
  await tendAnimals(s.ctx, { ...box, animal: 'cow', keep: 6, cook: false }, s.runners);
  assert.equal(tended.list('pens', 'overworld').length, 1);
  assert.equal(tended.list('pens', 'overworld')[0].keep, 6);
  assert.equal(pensDue(s.bot, tended.list('pens', 'overworld'), Date.now()).length, 0);

  const off = await tendAnimals(s.ctx, { x: 0, y: 64, z: 0, x2: 1, y2: 64, z2: 1, cook: false, tend: false }, s.runners);
  assert.match(off.message, /Stopped tending 1 pen there$/);
  assert.equal(tended.list('pens', 'overworld').length, 0);
});

test('the attack tool leaves baby farm animals alone unless asked for babies or named', async () => {
  const adult = animal('cow', 1.5, 0.5);
  const calf = animal('cow', 1, 0.5, { baby: true });
  const tagged = animal('cow', 2, 0.5, { baby: true, tag: 'Moo' });
  const s = setup([adult, calf, tagged]);
  const bot = s.bot;
  assert.equal(isBaby(bot, calf), true);
  assert.equal(isBaby(bot, adult), false);
  const hits = [];
  Object.assign(bot, {
    on: () => {},
    removeListener: () => {},
    pathfinder: { setGoal: () => {} },
    lookAt: async () => {},
    attack: (mob) => {
      hits.push(mob.id);
      delete bot.entities[mob.id];
    }
  });
  const ctx = { bot, signal: null };
  const first = await attack(ctx, { target: 'cow', count: 2 });
  assert.deepEqual(hits, [adult.id]);
  assert.match(first.message, /Left 1 baby cow alone/);
  await attack(ctx, { target: 'baby_cow' });
  assert.deepEqual(hits, [adult.id, calf.id]);
  await attack(ctx, { target: 'Moo' });
  assert.deepEqual(hits, [adult.id, calf.id, tagged.id]);
});
