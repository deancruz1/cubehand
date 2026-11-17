import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { useItem, useOnEntity, useKind, plantFor, findItem, fireSafe, dangerProblem, pickMobs, isMount, growable } from '../src/actions/use.js';
import { Tended } from '../src/tended.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);

const key = (p) => `${p.x},${p.y},${p.z}`;
const count = (items, name) => items.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);

test('items are sorted into the uses they get', () => {
  assert.equal(useKind('bucket'), 'fill');
  assert.equal(useKind('water_bucket'), 'pour');
  assert.equal(useKind('lava_bucket'), 'pour');
  assert.equal(useKind('iron_hoe'), 'till');
  assert.equal(useKind('bone_meal'), 'grow');
  assert.equal(useKind('wheat_seeds'), 'plant');
  assert.equal(useKind('carrot'), 'plant');
  assert.equal(useKind('oak_sapling'), 'plant');
  assert.equal(useKind('flint_and_steel'), 'fire');
  assert.equal(useKind('snowball'), 'throw');
  assert.equal(useKind('potion'), 'drink');
  assert.equal(useKind('tnt'), 'banned');
  assert.equal(useKind('shears'), 'other');
});

test('crops, saplings and nether wart only go on the right ground', () => {
  assert.equal(plantFor('wheat_seeds').block, 'wheat');
  assert.equal(plantFor('wheat_seeds').fits('farmland'), true);
  assert.equal(plantFor('wheat_seeds').fits('grass_block'), false);
  assert.equal(plantFor('potato').block, 'potatoes');
  assert.equal(plantFor('oak_sapling').fits('grass_block'), true);
  assert.equal(plantFor('oak_sapling').fits('stone'), false);
  assert.equal(plantFor('nether_wart').fits('soul_sand'), true);
  assert.equal(plantFor('shears'), null);
  assert.equal(growable('wheat', 3, 7), true);
  assert.equal(growable('wheat', 7, 7), false);
  assert.equal(growable('oak_sapling'), true);
  assert.equal(growable('stone'), false);
});

test('short item names match, but never to fire, lava or TNT', () => {
  const items = [{ name: 'iron_hoe' }, { name: 'lava_bucket' }, { name: 'wheat_seeds' }];
  assert.equal(findItem(items, 'hoe').name, 'iron_hoe');
  assert.equal(findItem(items, 'seeds').name, 'wheat_seeds');
  assert.equal(findItem(items, 'bucket'), undefined);
  assert.equal(findItem(items, 'lava_bucket').name, 'lava_bucket');
  // A real item name only means that item.
  const names = { bucket: {}, potion: {}, iron_hoe: {} };
  assert.equal(findItem([{ name: 'water_bucket' }, { name: 'milk_bucket' }], 'bucket', names), undefined);
  assert.equal(findItem([{ name: 'splash_potion' }], 'potion', names), undefined);
  assert.equal(findItem([{ name: 'bucket' }, { name: 'water_bucket' }], 'bucket', names).name, 'bucket');
  assert.equal(findItem(items, 'hoe', names).name, 'iron_hoe');
});

// Stone all around, except what is set.
function world(blocks) {
  const map = new Map(Object.entries(blocks));
  return (p) => map.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air');
}

test('fire only goes where nothing near can burn or was built', () => {
  assert.equal(fireSafe('stone'), true);
  assert.equal(fireSafe('obsidian'), true);
  assert.equal(fireSafe('grass_block'), true);
  assert.equal(fireSafe('netherrack'), true);
  for (const name of ['short_grass', 'oak_log', 'oak_leaves', 'oak_planks', 'white_wool', 'glass', 'tnt', undefined]) assert.equal(fireSafe(name), false, name);

  const nobody = () => false;
  const spot = new Vec3(0, 64, 0);
  const open = world({ '0,63,0': 'obsidian' });
  const fire = (extra) => ({ item: 'flint_and_steel', clicked: 'obsidian', spot, getName: open, admin: false, playerNear: nobody, ...extra });
  assert.equal(dangerProblem(fire()), null);
  assert.match(dangerProblem(fire({ getName: world({ '0,63,0': 'obsidian', '2,65,1': 'oak_planks' }) })), /oak_planks at 2 65 1 could catch fire or is built/);
  assert.match(dangerProblem(fire({ getName: world({ '1,69,0': 'oak_leaves' }) })), /oak_leaves/);
  assert.match(dangerProblem(fire({ playerNear: () => true })), /player/);
  assert.match(dangerProblem(fire({ clicked: 'stone' })), /only an admin can have me start a fire on stone/);
  assert.equal(dangerProblem(fire({ clicked: 'stone', admin: true })), null);
  assert.equal(dangerProblem(fire({ clicked: 'netherrack' })), null);
  assert.match(dangerProblem(fire({ clicked: 'tnt', admin: true })), /never light TNT/);
  assert.equal(dangerProblem(fire({ clicked: 'campfire', lit: false, getName: world({ '1,64,0': 'oak_planks' }) })), null);
  assert.match(dangerProblem(fire({ clicked: 'campfire', lit: true })), /already lit/);
  assert.match(dangerProblem({ item: 'tnt', admin: true }), /never use tnt/);
});

test('lava is admin-only, needs a wide clear area and no players close', () => {
  const spot = new Vec3(0, 64, 0);
  const lava = (extra) => ({ item: 'lava_bucket', spot, getName: world({}), admin: true, playerNear: () => false, ...extra });
  assert.equal(dangerProblem(lava()), null);
  assert.match(dangerProblem(lava({ admin: false })), /only an admin can have me pour lava/);
  assert.match(dangerProblem(lava({ getName: world({ '5,65,-4': 'oak_planks' }) })), /oak_planks at 5 65 -4/);
  assert.match(dangerProblem(lava({ playerNear: () => true })), /player is within 6 blocks/);
  assert.equal(dangerProblem({ item: 'water_bucket', spot, getName: world({ '1,64,0': 'oak_planks' }), admin: false, playerNear: () => true }), null);
});

function mob(id, name, x, tag) {
  return {
    id, name, type: name === 'player' ? 'player' : 'animal', position: new Vec3(x, 64, 0.5), height: 1.3,
    metadata: tag ? [null, null, tag] : [], getCustomName: () => tag
  };
}

test('mob uses pick the nearest matching mobs, never players, traders or other names', () => {
  const self = { position: new Vec3(0.5, 64, 0.5) };
  const near = mob(1, 'sheep', 2);
  const far = mob(2, 'sheep', 10);
  const named = mob(3, 'sheep', 1, 'Bob');
  const villager = { ...mob(4, 'villager', 1), type: 'passive' };
  const player = mob(5, 'player', 1);
  const all = [self, far, named, villager, player, near];
  assert.deepEqual(pickMobs(all, self, self.position, 'sheep').map((e) => e.id), [1, 2]);
  assert.deepEqual(pickMobs(all, self, self.position, 'bob').map((e) => e.id), [3]);
  assert.deepEqual(pickMobs(all, self, self.position, 'villager'), []);
  assert.deepEqual(pickMobs(all, self, self.position, 'sheep', 5).map((e) => e.id), [1]);
  assert.equal(isMount({ name: 'oak_boat', type: 'other', metadata: [] }, 'boat'), true);
  assert.equal(isMount({ name: 'chest_minecart', type: 'other', metadata: [] }, 'minecart'), false);
  assert.equal(isMount({ name: 'tnt_minecart', type: 'other', metadata: [] }, 'minecart'), false);
  assert.equal(isMount({ name: 'pig', type: 'animal', metadata: [] }, 'pig'), true);
});

function fakeBot(blocks, items, { entities = {}, players = {} } = {}) {
  const map = new Map(Object.entries(blocks));
  const nameAt = (p) => map.get(key(p)) ?? (p.y < 64 ? 'dirt' : 'air');
  const self = { id: 0, position: new Vec3(0.5, 64, 0.5) };
  const bot = {
    map,
    clicks: [],
    entity: self,
    entities: { 0: self, ...entities },
    players,
    registry: { blocksByName: {}, foodsByName: {}, items: {} },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    blockAt: (p) => {
      const name = nameAt(p);
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({}) };
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    lookAt: async () => {},
    activateBlock: async (block) => {
      bot.clicks.push(key(block.position));
      if (bot.heldItem.name.endsWith('_hoe') && block.name === 'grass_block') map.set(key(block.position), 'farmland');
    },
    useOn: (target) => {
      if (bot.heldItem.name === 'shears' && !target.sheared) {
        target.sheared = true;
        items.push({ name: 'white_wool', count: 2 });
      }
    },
    on: () => {},
    removeListener: () => {}
  };
  return bot;
}

function fakeCtx(bot, requester = 'Ann') {
  const progress = [];
  return {
    bot,
    requester,
    progress,
    config: { protectedBlocks: ['chest'], admins: ['Admin'], limits: { moveTimeoutSeconds: 5 } },
    placed: { has: () => false },
    status: { progress: (text) => progress.push(text) }
  };
}

test('a hoe on a box tills the grass and leaves the rest', async () => {
  const blocks = { '1,63,0': 'grass_block', '2,63,0': 'grass_block', '1,63,1': 'stone', '2,63,1': 'grass_block', '2,64,1': 'oak_planks' };
  const bot = fakeBot(blocks, [{ name: 'iron_hoe', count: 1 }]);
  const result = await useItem(fakeCtx(bot), { item: 'hoe', x: 1, y: 63, z: 0, x2: 2, z2: 1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /tilled 2 of 2 blocks with iron_hoe/);
  assert.equal(bot.map.get('1,63,0'), 'farmland');
  assert.equal(bot.map.get('2,63,0'), 'farmland');
  assert.equal(bot.map.get('2,63,1'), 'grass_block');

  const one = await useItem(fakeCtx(bot), { item: 'iron_hoe', x: 1, y: 63, z: 1 });
  assert.equal(one.ok, false);
  assert.match(one.message, /stone can't be tilled/);
});

test('shearing skips a sheep that is already sheared and reports the wool', async () => {
  const sheared = { ...mob(1, 'sheep', 1.5), sheared: true };
  const woolly = mob(2, 'sheep', 2.5);
  const items = [{ name: 'shears', count: 1 }];
  const bot = fakeBot({}, items, { entities: { 1: sheared, 2: woolly } });
  const result = await useItem(fakeCtx(bot), { item: 'shears', target: 'sheep', count: 2 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /used shears on 1 sheep, got 2 white_wool. 1 didn't change/);
  assert.match(result.message, /no more sheep/);
});

test('an item can go to one given mob, not the nearest, and never to a player', async () => {
  const near = mob(1, 'sheep', 1.5);
  const chosen = mob(2, 'sheep', 2.5);
  const steve = mob(3, 'player', 1);
  const items = [{ name: 'shears', count: 1 }, { name: 'tnt', count: 1 }];
  const bot = fakeBot({}, items, { entities: { 1: near, 2: chosen, 3: steve } });
  const result = await useOnEntity(fakeCtx(bot), 'shears', chosen);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /used shears on the sheep at 2 64 0/);
  assert.equal(chosen.sheared, true);
  assert.equal(near.sheared, undefined);
  assert.equal((await useOnEntity(fakeCtx(bot), 'shears', steve)).ok, false);
  assert.match((await useOnEntity(fakeCtx(bot), 'tnt', near)).message, /never use tnt/);
  assert.match((await useOnEntity(fakeCtx(bot), 'wheat', near)).message, /missing item: wheat/);
  delete bot.entities[1];
  assert.match((await useOnEntity(fakeCtx(bot), 'shears', near)).message, /gone/);
});

test('a player\'s tilled box is kept as a field to tend, a single block or her own job is not', async () => {
  const blocks = { '1,63,0': 'grass_block', '2,63,0': 'grass_block', '3,63,0': 'grass_block', '1,63,2': 'grass_block' };
  const bot = fakeBot(blocks, [{ name: 'iron_hoe', count: 1 }]);
  bot.game = { dimension: 'overworld' };
  const tended = new Tended();
  const ctx = { ...fakeCtx(bot), tended };
  const tilled = await useItem(ctx, { item: 'hoe', x: 1, y: 63, z: 0, x2: 2, z2: 0 });
  assert.match(tilled.message, /I will tend this field from now on$/);
  assert.deepEqual(tended.list('fields', 'overworld'), [{ x: 1, y: 63, z: 0, x2: 2, y2: 63, z2: 0, dimension: 'overworld' }]);
  await useItem(ctx, { item: 'hoe', x: 3, y: 63, z: 0 });
  assert.equal(tended.list('fields', 'overworld').length, 1);
  const own = await useItem({ ...ctx, requester: null }, { item: 'hoe', x: 1, y: 63, z: 2, x2: 1, z2: 2 });
  assert.equal(own.ok, true, own.message);
  assert.equal(tended.list('fields', 'overworld').length, 1);
});

test('use_item never works on players, and fire needs an admin away from netherrack', async () => {
  const bot = fakeBot({}, [{ name: 'shears', count: 1 }, { name: 'flint_and_steel', count: 1 }, { name: 'tnt', count: 1 }], { players: { Steve: {} } });
  const player = await useItem(fakeCtx(bot), { item: 'shears', target: 'steve' });
  assert.equal(player.ok, false);
  assert.match(player.message, /steve is a player, and I never use items on players/);
  const lighter = await useItem(fakeCtx(bot), { item: 'flint_and_steel', target: 'sheep' });
  assert.match(lighter.message, /never use flint_and_steel on mobs/);
  const stone = await useItem(fakeCtx(bot), { item: 'flint_and_steel', x: 3, y: 63, z: 0 });
  assert.equal(stone.ok, false);
  assert.match(stone.message, /only an admin/);
  assert.deepEqual(bot.clicks, []);
  const tnt = await useItem(fakeCtx(bot, 'Admin'), { item: 'tnt', x: 3, y: 63, z: 0 });
  assert.match(tnt.message, /never use tnt/);
});

test('a bucket only means an empty bucket, and pouring into a source of the same fluid is refused', async () => {
  const items = [{ name: 'water_bucket', count: 1 }, { name: 'milk_bucket', count: 1 }];
  const bot = fakeBot({ '2,64,0': 'water' }, items);
  bot.registry.itemsByName = { bucket: {}, water_bucket: {}, milk_bucket: {} };
  const empty = await useItem(fakeCtx(bot), { item: 'bucket', x: 2, y: 64, z: 0 });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /missing item: bucket/);
  const pour = await useItem(fakeCtx(bot), { item: 'water_bucket', x: 2, y: 64, z: 0 });
  assert.equal(pour.ok, false);
  assert.match(pour.message, /already a water source at 2 64 0/);
  assert.equal(count(items, 'water_bucket'), 1);
});

test('splash potions need somewhere to land with no player near it or on the way', async () => {
  const items = [{ name: 'splash_potion', count: 2 }];
  const players = {};
  const bot = fakeBot({}, items, { players });
  bot.registry.itemsByName = { potion: {}, splash_potion: {} };
  bot.activateItem = () => {
    items[0].count--;
  };
  bot.deactivateItem = () => {};
  const potion = await useItem(fakeCtx(bot), { item: 'potion' });
  assert.match(potion.message, /missing item: potion/);
  const anywhere = await useItem(fakeCtx(bot), { item: 'splash_potion' });
  assert.equal(anywhere.ok, false);
  assert.match(anywhere.message, /say where to throw the splash_potion/);
  // Halfway along a throw to 20 blocks away, far from where it is aimed.
  players.Steve = { entity: { position: new Vec3(10.5, 64, 1.5) } };
  const between = await useItem(fakeCtx(bot), { item: 'splash_potion', x: 20, y: 64, z: 0 });
  assert.equal(between.ok, false);
  assert.match(between.message, /a player is close to where the splash_potion would land/);
  players.Steve.entity.position = new Vec3(-12.5, 64, 0.5);
  const clear = await useItem(fakeCtx(bot), { item: 'splash_potion', x: 20, y: 64, z: 0 });
  assert.equal(clear.ok, true, clear.message);
  assert.equal(count(items, 'splash_potion'), 1);
});

test('fire is checked again once in reach, in case a player came close on the way', async () => {
  const players = {};
  const bot = fakeBot({ '10,63,0': 'netherrack' }, [{ name: 'flint_and_steel', count: 1 }], { players });
  bot.pathfinder.goto = async () => {
    bot.entity.position = new Vec3(9.5, 64, 2.5);
    players.Steve = { entity: { position: new Vec3(10.5, 64, 0.5) } };
  };
  const result = await useItem(fakeCtx(bot), { item: 'flint_and_steel', x: 10, y: 63, z: 0 });
  assert.equal(result.ok, false);
  assert.match(result.message, /won't use flint_and_steel at 10 63 0: a player is standing right there/);
  assert.deepEqual(bot.clicks, []);
});

test('honey and ominous bottles are drunk even with a full food bar', async () => {
  const items = [{ name: 'ominous_bottle', count: 1 }, { name: 'honey_bottle', count: 2 }];
  const bot = fakeBot({}, items);
  Object.assign(bot, { food: 20, health: 20 });
  bot.consume = async () => {
    throw new Error('Food is full');
  };
  bot.activateItem = () => {
    bot.heldItem.count--;
  };
  bot.deactivateItem = () => {};
  const honey = await useItem(fakeCtx(bot), { item: 'honey_bottle' });
  assert.equal(honey.ok, true, honey.message);
  assert.equal(count(items, 'honey_bottle'), 1);
  const ominous = await useItem(fakeCtx(bot), { item: 'ominous_bottle' });
  assert.equal(ominous.ok, true, ominous.message);
});
