import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { digArea, digReason, holdsUp, lavaNext, dropBelow, leftText, falls } from '../src/actions/dig.js';
import { digBlock, removeScaffold, needsBetterTool, breakBlock } from '../src/actions/blocks.js';
import { validateConfig } from '../src/config.js';
import { setPauseScale } from '../src/actions/util.js';

setPauseScale(0);

const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);

const key = (p) => `${p.x},${p.y},${p.z}`;
const boxOf = (name) => (['air', 'cave_air', 'water', 'lava', 'short_grass'].includes(name) ? 'empty' : 'block');

// A tiny world: blocks set in the map, dirt below y 64 and air above. Digging sand or gravel
// out from under more of it drops the column straight away.
function fakeBot(blocks, { at = new Vec3(0.5, 64, 0.5), spots = [] } = {}) {
  const world = new Map(Object.entries(blocks));
  const nameAt = (p) => world.get(key(p)) ?? (p.y < 64 ? 'dirt' : 'air');
  const dug = [];
  const bot = {
    world,
    dug,
    entity: { position: at.clone() },
    entities: {},
    players: {},
    registry: { items: {}, blocksArray: [], itemsByName: {} },
    inventory: { items: () => [] },
    heldItem: null,
    pathfinder: {
      bestHarvestTool: () => null,
      setGoal: () => {},
      isMining: () => false,
      isBuilding: () => false,
      // Stands on the first spot that ends the walk.
      goto: async (goal) => {
        const spot = spots.find((s) => goal.isEnd(s));
        if (!spot) {
          const err = new Error('no path');
          err.name = 'NoPath';
          throw err;
        }
        bot.entity.position = spot.offset(0.5, 0, 0.5);
      }
    },
    blockAt: (p) => {
      const name = nameAt(p);
      return { name, position: p, boundingBox: boxOf(name), getProperties: () => ({}) };
    },
    canDigBlock: () => true,
    equip: async () => {},
    dig: async (block) => {
      const p = block.position;
      dug.push({ pos: key(p), from: key(bot.entity.position.floored()) });
      world.set(key(p), 'air');
      let y = p.y;
      while (falls(nameAt(new Vec3(p.x, y + 1, p.z)))) {
        world.set(key(new Vec3(p.x, y, p.z)), nameAt(new Vec3(p.x, y + 1, p.z)));
        world.set(key(new Vec3(p.x, y + 1, p.z)), 'air');
        y++;
      }
    },
    on: () => {},
    removeListener: () => {}
  };
  // Steps along the ray and reports the first block that isn't open.
  bot.world.raycast = (start, dir, range) => {
    for (let t = 0; t <= range; t += 0.02) {
      const p = start.plus(dir.scaled(t)).floored();
      if (boxOf(nameAt(p)) === 'block') return { position: p };
    }
    return null;
  };
  return bot;
}

function fakeCtx(bot, own = new Set()) {
  const progress = [];
  return {
    bot,
    progress,
    config: { protectedBlocks: ['chest'], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 100 } },
    placed: { has: (p) => own.has(key(p)), add: () => {}, remove: () => {} },
    status: { progress: (text) => progress.push(text) }
  };
}

test('dig_area takes terrain and plants and says why it leaves the rest', () => {
  assert.equal(digReason('stone'), null);
  assert.equal(digReason('coal_ore'), null);
  assert.equal(digReason('sand'), null);
  assert.equal(digReason('air'), '');
  assert.equal(digReason('water'), 'water');
  assert.equal(digReason('lava'), 'lava');
  assert.equal(digReason('oak_planks'), 'not natural terrain');
  assert.equal(digReason('cobblestone'), 'not natural terrain');
  assert.equal(digReason('oak_log'), 'logs');
  assert.equal(digReason('chest', { protectedBlocks: ['chest'] }), 'protected');
  assert.equal(digReason('stone', { own: true }), 'placed by me');
  assert.equal(digReason('stone', { touchesBuild: () => true }), 'touching something built');
  assert.equal(digReason('poppy'), null);
  assert.equal(digReason('poppy', { touchesBuild: () => true }), 'touching something built');
  assert.equal(digReason('short_grass', { touchesBuild: () => true }), null);
  assert.equal(digReason('sandstone'), null);
  assert.equal(digReason('sandstone', { nearBuilt: () => true }), 'build material near a build');
  assert.equal(digReason('obsidian', { canHarvest: () => false }), 'need a better tool');
  assert.equal(digReason('cactus'), null);
  assert.equal(digReason('bee_nest'), 'wild');
  assert.equal(digReason('sculk_shrieker'), 'wild');
  assert.equal(digReason('tube_coral_block'), 'wild');
});

test('the block the bot stands on, or the one under its sand, holds it up', () => {
  const names = new Map([['0,63,0', 'sand']]);
  const getName = (p) => names.get(key(p)) ?? 'dirt';
  const feet = new Vec3(0.5, 64, 0.5);
  assert.equal(holdsUp(feet, new Vec3(0, 63, 0), getName), true);
  assert.equal(holdsUp(feet, new Vec3(0, 62, 0), getName), true);
  assert.equal(holdsUp(feet, new Vec3(1, 63, 0), getName), false);
  assert.equal(holdsUp(feet, new Vec3(0, 64, 0), getName), false);
  names.set('0,62,0', 'dirt');
  assert.equal(holdsUp(feet, new Vec3(0, 61, 0), getName), false);
  // Standing on the edge between two blocks, both count.
  assert.equal(holdsUp(new Vec3(0.9, 64, 0.5), new Vec3(1, 63, 0), getName), true);
});

test('lava next to a block and an open drop under it are found', () => {
  const names = new Map([['1,64,0', 'lava'], ['5,63,0', 'air'], ['5,62,0', 'air'], ['5,61,0', 'air'], ['7,63,0', 'air']]);
  const getName = (p) => names.get(key(p)) ?? 'stone';
  assert.equal(lavaNext(getName, new Vec3(0, 64, 0)), true);
  assert.equal(lavaNext(getName, new Vec3(0, 65, 1)), false);
  assert.equal(dropBelow(getName, new Vec3(5, 64, 0)), 3);
  assert.equal(dropBelow(getName, new Vec3(7, 64, 0)), 1);
  const text = leftText(new Map([['1,2,3', 'lava next to it'], ['1,2,4', 'lava next to it'], ['5,5,5', 'logs']]));
  assert.equal(text, '2 blocks with lava next to them (at 1 2 3; 1 2 4), 1 logs (use chop_tree) (at 5 5 5)');
});

test('dig_area works the top layer first, nearest block first', async () => {
  const blocks = {};
  for (const x of [2, 3]) for (const z of [-1, 0]) blocks[`${x},64,${z}`] = 'stone';
  const bot = fakeBot(blocks);
  const ctx = fakeCtx(bot);
  const result = await digArea(ctx, { x1: 3, y1: 63, z1: 0, x2: 2, y2: 64, z2: -1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /dug 8 blocks from 2 63 -1 to 3 64 0 \(4 stone, 4 dirt\)/);
  assert.deepEqual(bot.dug.map((d) => d.pos), ['2,64,0', '2,64,-1', '3,64,0', '3,64,-1', '2,63,0', '2,63,-1', '3,63,0', '3,63,-1']);
  assert.match(ctx.progress.at(-1), /dug 8 of about 8 blocks, layer 2 of 2/);
});

test('dig_area leaves built, own, lava-side and cave-top blocks and lists them', async () => {
  const bot = fakeBot({
    '2,64,0': 'stone',
    '3,64,0': 'stone',
    '3,64,1': 'lava',
    '4,64,0': 'stone',
    '2,64,-1': 'stone',
    '2,63,-1': 'air',
    '2,62,-1': 'air',
    '2,61,-1': 'air',
    '9,64,-1': 'oak_planks'
  });
  const result = await digArea(fakeCtx(bot, new Set(['4,64,0'])), { x1: 2, y1: 64, z1: -1, x2: 4, y2: 64, z2: 0 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /dug 1 blocks/);
  assert.match(result.message, /1 blocks with lava next to them \(at 3 64 0\)/);
  assert.match(result.message, /1 blocks I placed \(at 4 64 0\)/);
  assert.match(result.message, /a cave below\) \(at 2 64 -1\)/);
  assert.equal(bot.world.get('3,64,0'), 'stone');
  assert.equal(bot.world.get('4,64,0'), 'stone');

  const built = fakeBot({ '2,64,0': 'oak_planks', '3,64,0': 'stone' });
  const left = await digArea(fakeCtx(built), { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 0 });
  assert.equal(left.ok, false);
  assert.match(left.message, /dug 0 blocks/);
  assert.match(left.message, /not natural terrain/);
  assert.match(left.message, /terrain touching something built \(at 3 64 0\)/);
});

test("dig_area leaves terrain against someone's cobblestone wall, but not against its own", async () => {
  const wall = fakeBot({ '2,64,0': 'stone', '3,64,0': 'cobblestone' });
  const left = await digArea(fakeCtx(wall), { x1: 2, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });
  assert.match(left.message, /terrain touching something built \(at 2 64 0\)/);
  assert.equal(wall.world.get('2,64,0'), 'stone');
  const own = fakeBot({ '2,64,0': 'stone', '3,64,0': 'cobblestone' });
  const dug = await digArea(fakeCtx(own, new Set(['3,64,0'])), { x1: 2, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });
  assert.equal(dug.ok, true, dug.message);
  assert.equal(own.world.get('2,64,0'), 'air');
});

test('dig_area steps off the block it stands on before digging it', async () => {
  const bot = fakeBot({ '2,64,0': 'stone', '3,64,0': 'stone' }, { at: new Vec3(2.5, 65, 0.5), spots: [new Vec3(2, 65, 0), new Vec3(0, 64, 0)] });
  const result = await digArea(fakeCtx(bot), { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 0 });
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.dug[0].pos, '2,64,0');
  assert.equal(bot.dug[0].from, '0,64,0');
  assert.match(result.message, /now at 0 64 0/);
});

test('sand falling into the box is dug too', async () => {
  const bot = fakeBot({ '2,64,0': 'stone', '2,65,0': 'sand', '2,66,0': 'gravel' });
  const result = await digArea(fakeCtx(bot), { x1: 2, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /dug 3 blocks .*1 stone, 1 sand, 1 gravel/);
  assert.equal(bot.world.get('2,64,0'), 'air');
});

test('a box over the limit is refused, and the limit defaults to 1000', async () => {
  const bot = fakeBot({});
  const result = await digArea(fakeCtx(bot), { x1: 0, y1: 60, z1: 0, x2: 9, y2: 64, z2: 9 });
  assert.equal(result.ok, false);
  assert.match(result.message, /box is 500 blocks, the limit is 100/);

  const raw = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
  const env = { ANTHROPIC_API_KEY: 'test-key' };
  assert.equal(validateConfig(raw, env).limits.maxDigBlocks, 1000);
  delete raw.limits.maxDigBlocks;
  assert.equal(validateConfig(raw, env).limits.maxDigBlocks, 1000);
  raw.limits.maxDigBlocks = 0;
  assert.throws(() => validateConfig(raw, env), /maxDigBlocks/);
});

test('digging a block the held tool cannot harvest is refused before it starts', async () => {
  const bot = fakeBot({ '1,64,0': 'obsidian' });
  bot.registry.items = { 7: { name: 'diamond_pickaxe' } };
  bot.heldItem = { name: 'iron_pickaxe', type: 5 };
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => ({ ...blockAt(p), harvestTools: { 7: true }, canHarvest: (type) => type === 7 });
  const result = await digBlock(fakeCtx(bot), new Vec3(1, 64, 0));
  assert.equal(result.ok, false);
  assert.match(result.message, /need a better tool to break obsidian at 1 64 0: with iron_pickaxe it would take long and drop nothing. It takes one of: diamond_pickaxe/);
  assert.equal(bot.dug.length, 0);
  const anyway = await digBlock(fakeCtx(bot), new Vec3(1, 64, 0), { anyTool: true });
  assert.equal(anyway.ok, true, anyway.message);
  assert.equal(bot.world.get('1,64,0'), 'air');
});

test('snow goes without a shovel, stone and netherrack without a pickaxe are refused', async () => {
  const block = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
  assert.equal(needsBetterTool(block('snow'), null), false);
  assert.equal(needsBetterTool(block('snow_block'), null), false);
  assert.equal(needsBetterTool(block('stone'), null), true);
  assert.equal(needsBetterTool(block('netherrack'), null), true);
  assert.equal(needsBetterTool(block('stone'), registry.itemsByName.wooden_pickaxe.id), false);
  assert.equal(needsBetterTool(block('dirt'), null), false);

  const bot = fakeBot({ '1,64,0': 'snow' });
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => {
    const b = blockAt(p);
    return b.name === 'snow' ? { ...b, harvestTools: block('snow').harvestTools, hardness: 0.1, canHarvest: () => false } : b;
  };
  const result = await digBlock(fakeCtx(bot), new Vec3(1, 64, 0));
  assert.equal(result.ok, true, result.message);
  assert.equal(bot.world.get('1,64,0'), 'air');
});

test("break_block never breaks someone's protected block for a job nobody asked for", async () => {
  const bot = fakeBot({ '1,64,0': 'chest' });
  const config = { protectedBlocks: ['chest'], admins: ['Steve'], limits: { moveTimeoutSeconds: 5 } };
  const ctx = { ...fakeCtx(bot), config };
  const chore = await breakBlock({ ...ctx, requester: null }, { x: 1, y: 64, z: 0, confirmed: true });
  assert.equal(chore.ok, false);
  assert.match(chore.message, /Nobody asked for this job/);
  assert.equal(bot.world.get('1,64,0'), 'chest');
  const asked = await breakBlock({ ...ctx, requester: 'Steve' }, { x: 1, y: 64, z: 0, confirmed: true });
  assert.equal(asked.ok, true, asked.message);
  assert.equal(bot.world.get('1,64,0'), 'air');
});

test('scaffolding comes down even without a pickaxe to harvest it', async () => {
  const bot = fakeBot({ '1,64,0': 'cobblestone', '1,65,0': 'cobblestone' });
  const blockAt = bot.blockAt;
  bot.blockAt = (p) => {
    const b = blockAt(p);
    return b.name === 'cobblestone' ? { ...b, harvestTools: { 7: true }, canHarvest: () => false } : b;
  };
  const removed = await removeScaffold(fakeCtx(bot), [new Vec3(1, 64, 0), new Vec3(1, 65, 0)]);
  assert.equal(removed, 2);
  assert.deepEqual(bot.dug.map((d) => d.pos), ['1,65,0', '1,64,0']);
});
