import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { harvest, planHarvest, cropName, cropOf, ripeNear, tendFields } from '../src/actions/farm.js';
import { setPauseScale } from '../src/actions/util.js';
import { Tended } from '../src/tended.js';

setPauseScale(0);

const key = (p) => `${p.x},${p.y},${p.z}`;
const TALL = new Set(['sugar_cane', 'bamboo', 'cactus', 'kelp', 'kelp_plant']);
const PLANTS = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots', nether_wart: 'nether_wart' };
const DROPS = {
  wheat: [['wheat', 1], ['wheat_seeds', 2]], carrots: [['carrot', 3]], potatoes: [['potato', 3]], beetroots: [['beetroot', 1], ['beetroot_seeds', 2]],
  melon: [['melon_slice', 5]], cocoa: [['cocoa_beans', 2]], sugar_cane: [['sugar_cane', 1]]
};
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const FACING = { '0,0,-1': 'north', '0,0,1': 'south', '-1,0,0': 'west', '1,0,0': 'east' };

// Blocks are 'name' or [name, properties]; dirt below y 63, air above. Digging puts the drops
// straight into the inventory, as if they were picked up.
function fakeBot(blocks, items = [], { drops = DROPS, registry = {} } = {}) {
  const map = new Map(Object.entries(blocks).map(([k, v]) => [k, Array.isArray(v) ? v : [v, {}]]));
  const at = (p) => map.get(key(p)) ?? [p.y < 63 ? 'dirt' : 'air', {}];
  const give = (name, n) => {
    const have = items.find((i) => i.name === name);
    if (have) have.count += n;
    else items.push({ name, count: n });
  };
  const take = (name) => {
    items.find((i) => i.name === name && i.count > 0).count--;
  };
  const self = { id: 0, position: new Vec3(0.5, 64, 0.5) };
  const bot = {
    map,
    dug: [],
    entity: self,
    entities: { 0: self },
    game: { dimension: 'overworld' },
    registry: { blocksByName: registry, items: {} },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    planModes: { onFoot: { allowParkour: true, allowSprinting: true } },
    moveModes: { noPlace: { allowParkour: true, allowSprinting: true } },
    pathfinder: { setGoal: () => {}, goto: async () => {}, bestHarvestTool: () => null },
    blockAt: (p) => {
      const [name, props] = at(p);
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => props };
    },
    canDigBlock: () => true,
    dig: async (block) => {
      bot.dug.push(key(block.position));
      bot.onDig?.(block);
      let p = block.position;
      const name = block.name;
      do {
        map.set(key(p), ['air', {}]);
        p = p.offset(0, 1, 0);
      } while (TALL.has(name) && TALL.has(at(p)[0]));
      for (const [item, n] of drops[name] ?? []) give(item, n);
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    unequip: async () => {
      bot.heldItem = null;
    },
    lookAt: async () => {},
    activateBlock: async (block, face) => {
      const p = block.position;
      const [name, props] = at(p);
      const held = bot.heldItem?.name;
      const above = p.offset(0, 1, 0);
      if (name === 'sweet_berry_bush' && Number(props.age) >= 2) {
        map.set(key(p), [name, { age: 1 }]);
        give('sweet_berries', 2);
      } else if (PLANTS[held] && ['farmland', 'soul_sand'].includes(name) && at(above)[0] === 'air') {
        map.set(key(above), [PLANTS[held], { age: 0 }]);
        take(held);
      } else if (held === 'cocoa_beans' && name === 'jungle_log') {
        map.set(key(p.plus(face)), ['cocoa', { age: 0, facing: OPPOSITE[FACING[key(face)]] }]);
        take(held);
      }
    },
    setControlState: () => {},
    on: () => {},
    removeListener: () => {}
  };
  return bot;
}

function fakeCtx(bot, extra = {}) {
  const progress = [];
  return {
    bot,
    progress,
    config: { protectedBlocks: ['chest'], limits: { moveTimeoutSeconds: 5 } },
    placed: { has: () => false, remove: () => {} },
    status: { progress: (text) => progress.push(text) },
    ...extra
  };
}

const ripe = (name, age) => [name, { age }];

test('crop names and the crops blocks belong to', () => {
  assert.equal(cropName('carrot'), 'carrots');
  assert.equal(cropName('Sweet Berries'), 'sweet_berries');
  assert.equal(cropName('cocoa_beans'), 'cocoa');
  assert.equal(cropName('wheat'), 'wheat');
  assert.equal(cropName('stone'), null);
  assert.equal(cropOf('kelp_plant'), 'kelp');
  assert.equal(cropOf('attached_melon_stem'), null);
  assert.equal(cropOf('pumpkin_stem'), 'pumpkin');
  assert.equal(cropOf('bamboo_sapling'), 'bamboo');
});

test('only what is ripe is planned, and how each kind is taken', () => {
  const blocks = {
    // Wheat's age comes from the registry, carrots fall back to the known last age.
    '0,64,0': ripe('wheat', 7), '1,64,0': ripe('wheat', 5), '2,64,0': ripe('carrots', 7),
    // A stem's melon is taken, a pumpkin with no stem is someone's.
    '0,64,2': ['attached_melon_stem', { facing: 'east' }], '1,64,2': 'melon', '3,64,2': 'pumpkin', '4,64,2': ripe('pumpkin_stem', 7),
    // Three high cane is cut at the second block, a single one is left to grow.
    '0,64,4': 'sugar_cane', '0,65,4': 'sugar_cane', '0,66,4': 'sugar_cane', '2,64,4': 'sugar_cane', '3,64,4': 'bamboo_sapling',
    '0,64,6': ripe('sweet_berry_bush', 3), '1,64,6': ripe('sweet_berry_bush', 2),
    '3,64,6': 'jungle_log', '3,64,5': ['cocoa', { age: 2, facing: 'south' }], '4,64,6': ['cocoa', { age: 1, facing: 'west' }]
  };
  const bot = fakeBot(blocks, [], { registry: { wheat: { states: [{ name: 'age', num_values: 8 }] } } });
  const { jobs, unripe } = planHarvest(bot, new Vec3(0, 64, 0), new Vec3(4, 66, 6));
  const planned = jobs.map((j) => `${j.crop} ${j.how} ${key(j.pos)}`).sort();
  assert.deepEqual(planned, [
    'carrots break 2,64,0', 'cocoa break 3,64,5', 'melon break 1,64,2', 'sugar_cane break 0,65,4', 'sweet_berries pick 0,64,6', 'wheat break 0,64,0'
  ]);
  assert.deepEqual(Object.fromEntries(unripe), { wheat: 1, pumpkin: 1, sugar_cane: 1, bamboo: 1, sweet_berries: 1, cocoa: 1 });
  assert.equal(key(jobs.find((j) => j.crop === 'cocoa').log), '3,64,6');

  const onlyWheat = planHarvest(bot, new Vec3(0, 64, 0), new Vec3(4, 66, 6), 'wheat');
  assert.deepEqual(onlyWheat.jobs.map((j) => j.crop), ['wheat']);
  assert.deepEqual(Object.fromEntries(onlyWheat.unripe), { wheat: 1 });

  // A box at the farmland covers the crops on it.
  const low = fakeBot({ '0,63,0': 'farmland', '0,64,0': ripe('wheat', 7) });
  assert.equal(planHarvest(low, new Vec3(0, 63, 0), new Vec3(0, 63, 0)).jobs.length, 1);
});

test('harvest takes the ripe crops, replants them, and leaves stems and bases', async () => {
  const blocks = {
    '0,63,1': 'farmland', '0,64,1': ripe('wheat', 7), '1,63,1': 'farmland', '1,64,1': ripe('wheat', 7), '2,63,1': 'farmland', '2,64,1': ripe('wheat', 3),
    '0,64,-1': ['attached_melon_stem', { facing: 'east' }], '1,64,-1': 'melon',
    '-2,64,0': 'sugar_cane', '-2,65,0': 'sugar_cane',
    '-1,64,2': ripe('sweet_berry_bush', 3),
    '2,64,-2': 'jungle_log', '2,64,-1': ['cocoa', { age: 2, facing: 'north' }]
  };
  const bot = fakeBot(blocks, [{ name: 'wheat_seeds', count: 1 }, { name: 'cocoa_beans', count: 1 }]);
  const ctx = fakeCtx(bot);
  const result = await harvest(ctx, { x: -2, y: 64, z: -2, x2: 2, y2: 64, z2: 2 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^harvested 6 in the box from -2 64 -2 to 2 64 2/);
  assert.match(result.message, /wheat: harvested 2, replanted 2, left unripe 1/);
  assert.match(result.message, /melon: harvested 1, left unripe 0/);
  assert.match(result.message, /sugar_cane: harvested 1, left unripe 0/);
  assert.match(result.message, /sweet_berries: harvested 1, left unripe 0/);
  assert.match(result.message, /cocoa: harvested 1, replanted 1, left unripe 0/);
  assert.doesNotMatch(result.message, /Could not replant/);
  assert.equal(bot.map.get('0,64,1')[0], 'wheat');
  assert.equal(bot.map.get('1,64,1')[0], 'wheat');
  assert.equal(bot.map.get('0,64,-1')[0], 'attached_melon_stem');
  assert.equal(bot.map.get('-2,64,0')[0], 'sugar_cane');
  assert.equal(bot.map.get('-1,64,2')[0], 'sweet_berry_bush');
  assert.deepEqual(bot.map.get('2,64,-1'), ['cocoa', { age: 0, facing: 'north' }]);
  assert.ok(!bot.dug.includes('-2,64,0') && !bot.dug.includes('0,64,-1') && !bot.dug.includes('-1,64,2'));
  assert.equal(bot.planModes.onFoot.allowParkour, true);
  assert.equal(bot.moveModes.noPlace.allowSprinting, true);
  assert.equal(ctx.progress.at(-1), 'harvested 6 of 6');
});

test('the drops replant a spot, and spots that cannot be replanted are counted with why', async () => {
  const blocks = {
    '0,63,1': 'farmland', '0,64,1': ripe('beetroots', 3),
    '1,63,1': 'farmland', '1,64,1': ripe('carrots', 7),
    '2,63,1': 'farmland', '2,64,1': ripe('potatoes', 7)
  };
  // Carrots drop nothing here, and the potato spot is trampled to dirt as it is dug.
  const bot = fakeBot(blocks, [], { drops: { ...DROPS, carrots: [] } });
  bot.onDig = (block) => {
    if (block.name === 'potatoes') bot.map.set('2,63,1', ['dirt', {}]);
  };
  const result = await harvest(fakeCtx(bot), { x: 0, y: 63, z: 1, x2: 2, z2: 1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /beetroots: harvested 1, replanted 1/);
  assert.match(result.message, /Could not replant 2 spots: (1 no carrot left, 1 the ground is dirt now, not farmland|1 the ground is dirt now, not farmland, 1 no carrot left)/);
  assert.equal(bot.map.get('0,64,1')[0], 'beetroots');

  const kept = fakeBot({ '0,63,1': 'farmland', '0,64,1': ripe('wheat', 7) }, [{ name: 'wheat_seeds', count: 5 }]);
  const noReplant = await harvest(fakeCtx(kept), { x: 0, y: 64, z: 1, replant: false });
  assert.match(noReplant.message, /wheat: harvested 1, replanted 0/);
  assert.equal(kept.map.get('0,64,1')[0], 'air');
});

test('nothing ripe is fine, and the box, crop and stop are checked', async () => {
  const bot = fakeBot({ '0,64,1': ripe('wheat', 2), '1,64,1': 'sugar_cane' });
  const none = await harvest(fakeCtx(bot), { x: 0, y: 64, z: 1, x2: 1, z2: 1 });
  assert.equal(none.ok, true);
  assert.match(none.message, /^nothing ripe in the box from 0 64 1 to 1 64 1\. wheat: harvested 0, replanted 0, left unripe 1; sugar_cane: harvested 0, left unripe 1/);
  assert.match((await harvest(fakeCtx(bot), { x: 5, y: 64, z: 5, crop: 'carrots' })).message, /no carrots there at all/);
  assert.match((await harvest(fakeCtx(bot), { x: 0, y: 64, z: 0, crop: 'stone' })).message, /stone is not a crop I harvest/);
  const big = await harvest(fakeCtx(bot), { x: 0, y: 64, z: 0, x2: 20, y2: 64, z2: 30 });
  assert.equal(big.ok, false);
  assert.match(big.message, /box is 651 blocks, the limit is 512/);

  const field = fakeBot({ '0,64,1': ripe('wheat', 7), '1,64,1': ripe('wheat', 7), '2,64,1': ripe('wheat', 7) }, [{ name: 'wheat_seeds', count: 9 }]);
  const controller = new AbortController();
  const ctx = fakeCtx(field, { signal: controller.signal, status: { progress: () => controller.abort() } });
  const stopped = await harvest(ctx, { x: 0, y: 64, z: 1, x2: 2, z2: 1, crop: 'wheat' });
  assert.equal(stopped.ok, true, stopped.message);
  assert.match(stopped.message, /wheat: harvested 1, replanted 0, left unripe 0/);
  assert.match(stopped.message, /Could not replant 1 spots: 1 stopped\. Stopped early: stopped/);
  assert.equal(field.dug.length, 1);
});

test('a box a player had her harvest is kept for tending, and tend false lets it go', async () => {
  const tended = new Tended();
  const bot = fakeBot({ '0,63,1': 'farmland', '0,64,1': ripe('wheat', 7), '1,63,1': 'farmland', '1,64,1': ripe('wheat', 2) }, [{ name: 'wheat_seeds', count: 4 }]);
  const field = { x: 0, y: 63, z: 1, x2: 1, y2: 63, z2: 1 };
  const own = await harvest(fakeCtx(bot, { tended }), field);
  assert.doesNotMatch(own.message, /tend this field/);
  assert.equal(tended.list('fields', 'overworld').length, 0);

  const asked = await harvest(fakeCtx(bot, { tended, requester: 'Steve' }), { ...field, crop: 'carrot' });
  assert.equal(asked.ok, true, asked.message);
  assert.match(asked.message, /I will tend this field from now on$/);
  assert.deepEqual(tended.list('fields', 'overworld'), [{ ...field, dimension: 'overworld', crop: 'carrots' }]);
  assert.doesNotMatch((await harvest(fakeCtx(bot, { tended, requester: 'Steve' }), { ...field, crop: 'carrots' })).message, /tend this field/);
  await harvest(fakeCtx(bot, { tended, requester: 'Steve' }), { x: 0, y: 63, z: 1 });
  assert.equal(tended.list('fields', 'overworld').length, 1);

  const off = await harvest(fakeCtx(bot, { tended, requester: 'Steve' }), { x: 1, y: 63, z: 1, tend: false });
  assert.equal(off.ok, true);
  assert.match(off.message, /Stopped tending 1 field there$/);
  assert.equal(tended.list('fields', 'overworld').length, 0);
});

test('ripeNear finds a remembered field with something ripe, and tendFields harvests it', async () => {
  const bot = fakeBot({
    '0,63,1': 'farmland', '0,64,1': ripe('wheat', 7), '1,63,1': 'farmland', '1,64,1': ripe('carrots', 3)
  }, [{ name: 'wheat_seeds', count: 2 }]);
  const wheat = { x: 0, y: 63, z: 1, x2: 1, y2: 63, z2: 1 };
  const carrotsOnly = { ...wheat, crop: 'carrots' };
  const nether = { ...wheat, dimension: 'the_nether' };
  const far = { x: 200, y: 64, z: 0 };
  assert.equal(ripeNear(bot, [carrotsOnly, nether, far]), null);
  assert.equal(ripeNear(bot, [carrotsOnly, far, wheat]), wheat);
  assert.equal(ripeNear(bot, []), null);

  const result = await tendFields(fakeCtx(bot), [carrotsOnly, wheat]);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /wheat: harvested 1, replanted 1/);
  assert.equal(bot.map.get('0,64,1')[0], 'wheat');
  assert.equal(ripeNear(bot, [wheat]), null);
  assert.match((await tendFields(fakeCtx(bot), [wheat])).message, /nothing ripe in the fields nearby/);
});
