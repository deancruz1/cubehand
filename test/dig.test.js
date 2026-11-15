import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { digArea, digReason, holdsUp, lavaNext, dropBelow, leftText, falls } from '../src/actions/dig.js';
import { digBlock, removeScaffold, needsBetterTool, breakBlock, fixToolMaterials } from '../src/actions/blocks.js';
import { validateConfig } from '../src/config.js';
import { setPauseScale } from '../src/actions/util.js';
import { Status } from '../src/status.js';

setPauseScale(0);

const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);

const key = (p) => `${p.x},${p.y},${p.z}`;
const boxOf = (name) => (['air', 'cave_air', 'water', 'lava', 'short_grass'].includes(name) ? 'empty' : 'block');
const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const noPath = () => {
  const err = new Error('no path');
  err.name = 'NoPath';
  return err;
};

// A tiny world: blocks set in the map, and fill (dirt below y 64 and air above) everywhere else.
// Digging sand or gravel out from under more of it drops the column straight away. With spots,
// a walk stands on the first spot that ends it. Without, it walks there on foot like a player
// (steps, one-block step ups, drops of up to 3) when it can, and with tunnel set it digs a
// straight 2-high tunnel at its feet to a spot it can't walk to, unless the walk may not break
// those blocks.
function fakeBot(blocks, { at = new Vec3(0.5, 64, 0.5), spots = null, fill = (p) => (p.y < 64 ? 'dirt' : 'air'), tunnel = false, items = [] } = {}) {
  const world = new Map(Object.entries(blocks));
  const nameAt = (p) => world.get(key(p)) ?? fill(p);
  const open = (p) => boxOf(nameAt(p)) === 'empty' && nameAt(p) !== 'lava';
  const stand = (p) => open(p) && open(p.offset(0, 1, 0)) && boxOf(nameAt(p.offset(0, -1, 0))) === 'block';
  const onFoot = (from, isEnd) => {
    const seen = new Set([key(from)]);
    const queue = [from];
    for (let i = 0; i < queue.length && i < 50000; i++) {
      const p = queue[i];
      if (isEnd(p)) return p;
      for (const d of DIRS) {
        const n = p.plus(d);
        let to = null;
        if (stand(n)) to = n;
        else if (stand(n.offset(0, 1, 0)) && open(p.offset(0, 2, 0))) to = n.offset(0, 1, 0);
        else if (open(n) && open(n.offset(0, 1, 0))) {
          for (let k = 1; k <= 3 && !to; k++) {
            const m = n.offset(0, -k, 0);
            if (stand(m)) to = m;
            else if (!open(m)) break;
          }
        }
        if (to && !seen.has(key(to))) {
          seen.add(key(to));
          queue.push(to);
        }
      }
    }
    return null;
  };
  const listeners = new Map();
  const dug = [];
  const walks = [];
  const walkDug = [];
  const bot = {
    world,
    dug,
    walks,
    walkDug,
    entity: { position: at.clone() },
    entities: {},
    players: {},
    registry: { items: {}, blocksArray: [], itemsByName: {} },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    stopDigging: () => {},
    placeBlock: async (ref, face) => {
      world.set(key(ref.position.plus(face)), items[0].name);
      items[0].count--;
    },
    moveModes: Object.fromEntries(['walk', 'climb', 'noPlace', 'follow'].map((n) => [n, { exclusionAreasBreak: [] }])),
    pathfinder: {
      bestHarvestTool: () => null,
      setGoal: () => {},
      setMovements: (m) => { bot.pathfinder.movements = m; },
      isMining: () => false,
      isBuilding: () => false,
      goto: async (goal) => {
        const from = bot.entity.position.floored();
        if (spots) {
          const spot = spots.find((s) => goal.isEnd(s));
          if (!spot) throw noPath();
          bot.entity.position = spot.offset(0.5, 0, 0.5);
          return;
        }
        let spot = onFoot(from, (p) => goal.isEnd(p));
        if (!spot && tunnel && goal.x !== undefined) {
          const cut = [];
          for (let p = from; ; ) {
            if (p.x === goal.x && p.z === goal.z) break;
            p = p.x !== goal.x ? p.offset(Math.sign(goal.x - p.x), 0, 0) : p.offset(0, 0, Math.sign(goal.z - p.z));
            for (const c of [p, p.offset(0, 1, 0)]) if (!open(c)) cut.push(c);
          }
          const rules = bot.pathfinder.movements?.exclusionAreasBreak ?? [];
          if (cut.some((c) => rules.some((rule) => rule({ position: c }) >= 100))) throw noPath();
          for (const c of cut) {
            world.set(key(c), 'air');
            walkDug.push(key(c));
            for (const fn of listeners.get('blockUpdate') ?? []) fn({ position: c, boundingBox: 'block' }, { position: c, boundingBox: 'empty' });
          }
          spot = new Vec3(goal.x, goal.y, goal.z);
        }
        if (!spot) throw noPath();
        walks.push(key(spot));
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
    on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    removeListener: (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn))
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
  const bot = fakeBot({ '2,64,0': 'stone', '3,64,0': 'stone' }, { at: new Vec3(2.5, 65, 0.5) });
  const result = await digArea(fakeCtx(bot), { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 0 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.dug, [{ pos: '2,64,0', from: '1,64,0' }, { pos: '3,64,0', from: '2,64,0' }]);
  assert.match(result.message, /now at 2 64 0/);
});

test('sand falling into the box is dug too', async () => {
  const bot = fakeBot({ '2,64,0': 'stone', '2,65,0': 'sand', '2,66,0': 'gravel' });
  const result = await digArea(fakeCtx(bot), { x1: 2, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /dug 3 blocks .*1 stone, 1 sand, 1 gravel/);
  assert.equal(bot.world.get('2,64,0'), 'air');
});

test('dig_area stops after the same thrown error twice and says what it was', async () => {
  const blocks = { '2,64,0': 'stone', '3,64,0': 'stone', '2,64,1': 'stone', '3,64,1': 'stone' };
  const bot = fakeBot(blocks);
  let tries = 0;
  bot.dig = async () => {
    tries++;
    throw new TypeError('enchantments.concat is not a function');
  };
  const ctx = fakeCtx(bot);
  const status = new Status({ getBot: () => bot, say: () => {} });
  status.run = { name: 'dig_area', started: Date.now(), progress: null };
  ctx.status = {
    progress: (text) => {
      ctx.progress.push(text);
      status.progress(text);
    }
  };
  const result = await digArea(ctx, { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 1 });
  assert.equal(result.ok, false);
  assert.equal(tries, 2);
  assert.match(result.message, /dug 0 blocks .*Left 2 blocks that would not break/);
  assert.match(result.message, /Stopped early: breaking failed twice in a row with the same error: enchantments.concat is not a function$/);
  assert.deepEqual(ctx.progress, ['dug 0 of about 4 blocks, 1 failed', 'dug 0 of about 4 blocks, 2 failed']);
  assert.match(status.summary(), /running dig_area for \d+s, dug 0 of about 4 blocks, 2 failed/);
});

test('one thrown error in a run of good digs does not stop dig_area', async () => {
  const bot = fakeBot({ '2,64,0': 'stone', '3,64,0': 'stone', '2,64,1': 'stone' });
  const dig = bot.dig;
  let tries = 0;
  bot.dig = async (block) => {
    if (++tries === 1) throw new Error('Digging aborted');
    return dig(block);
  };
  const ctx = fakeCtx(bot);
  const result = await digArea(ctx, { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 1 });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /dug 2 blocks .*Left 1 blocks that would not break/);
  assert.match(ctx.progress.at(-1), /dug 2 of about 3 blocks, 1 failed/);
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

test('ores dig at pickaxe speed, and a dig waits until she is on the ground', async () => {
  const block = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
  const diamond = registry.itemsByName.diamond_pickaxe.id;
  assert.equal(block('deepslate_diamond_ore').digTime(diamond, false, false, false, [], {}), 6750);
  fixToolMaterials(registry);
  assert.equal(block('deepslate_diamond_ore').digTime(diamond, false, false, false, [], {}), 850);
  assert.equal(block('deepslate').digTime(diamond, false, false, false, [], {}), 600);
  assert.equal(block('obsidian').digTime(diamond, false, false, false, [], {}), 9400);
  assert.equal(block('iron_ore').digTime(registry.itemsByName.stone_pickaxe.id, false, false, false, [], {}), 1150);

  const bot = fakeBot({ '1,64,0': 'stone' });
  bot.entity.onGround = false;
  let groundAtDig = null;
  const dig = bot.dig;
  bot.dig = async (b) => {
    groundAtDig = bot.entity.onGround;
    return dig(b);
  };
  setTimeout(() => { bot.entity.onGround = true; }, 120);
  const result = await digBlock(fakeCtx(bot), new Vec3(1, 64, 0));
  assert.equal(result.ok, true, result.message);
  assert.equal(groundAtDig, true);
});

// Solid deepslate with the given boxes dug out as air.
function mineWorld(...boxes) {
  const blocks = {};
  for (const [x1, y1, z1, x2, y2, z2] of boxes) {
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) blocks[`${x},${y},${z}`] = 'air';
  }
  return blocks;
}
const rock = () => 'deepslate';
const inside = (box) => (k) => {
  const [x, y, z] = k.split(',').map(Number);
  return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2 && z >= box.z1 && z <= box.z2;
};

test('dig_area digs a 2-high tunnel in rock from the end it walks in by, standing on the floor', async () => {
  // A corridor along x 0, the tunnel runs east from it.
  const bot = fakeBot(mineWorld([0, 64, -5, 0, 65, 5]), { at: new Vec3(0.5, 64, 3.5), fill: rock, tunnel: true });
  const box = { x1: 1, y1: 64, z1: 0, x2: 30, y2: 65, z2: 0 };
  const result = await digArea({ ...fakeCtx(bot), config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } }, box);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^dug 60 blocks from 1 64 0 to 30 65 0 \(60 deepslate\)\. Picked up nothing, now at 29 64 0$/);
  assert.equal(bot.dug.every((d) => inside(box)(d.pos)), true);
  assert.deepEqual(bot.walkDug, []);
  const expected = [];
  for (let x = 1; x <= 30; x++) expected.push({ pos: `${x},65,0`, from: `${x - 1},64,0` }, { pos: `${x},64,0`, from: `${x - 1},64,0` });
  assert.deepEqual(bot.dug, expected);
});

test('dig_area stopped half-way through a tunnel leaves her on its floor', async () => {
  const bot = fakeBot(mineWorld([0, 64, -5, 0, 65, 5]), { at: new Vec3(0.5, 64, 3.5), fill: rock });
  const controller = new AbortController();
  const dig = bot.dig;
  bot.dig = async (block) => {
    await dig(block);
    if (bot.dug.length === 31) controller.abort();
  };
  const box = { x1: 1, y1: 64, z1: 0, x2: 30, y2: 65, z2: 0 };
  const ctx = { ...fakeCtx(bot), signal: controller.signal, config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } };
  const result = await digArea(ctx, box);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^dug 31 blocks .*now at 15 64 0\. Stopped early: stopped$/);
  assert.equal(bot.dug.every((d) => inside(box)(d.pos) && d.from.split(',')[1] === '64'), true);
  assert.equal(bot.entity.position.floored().y, 64);
});

test('a 1-high box digs only what she can reach from beside it and says why the rest stays', async () => {
  const bot = fakeBot(mineWorld([0, 64, -5, 0, 65, 5]), { at: new Vec3(0.5, 64, 3.5), fill: rock });
  const box = { x1: 1, y1: 64, z1: 0, x2: 30, y2: 64, z2: 0 };
  const result = await digArea({ ...fakeCtx(bot), config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } }, box);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(bot.dug, [{ pos: '1,64,0', from: '0,64,0' }]);
  assert.match(result.message, /Left 29 blocks of a 1-high run, which I can't walk into \(a tunnel to walk in is 2 high: y to y\+1\)/);
});

test('dig_area walks round by the corridor to the end of the next tunnel instead of digging through the wall', async () => {
  // Tunnel A along z 0 is dug, the corridor along x 0 joins it, tunnel B along z 3 is the box.
  const bot = fakeBot(mineWorld([1, 64, 0, 30, 65, 0], [0, 64, -1, 0, 65, 4]), { at: new Vec3(28.5, 64, 0.5), fill: rock, tunnel: true });
  const box = { x1: 1, y1: 64, z1: 3, x2: 30, y2: 65, z2: 3 };
  const result = await digArea({ ...fakeCtx(bot), config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } }, box);
  assert.equal(result.ok, true, result.message);
  assert.doesNotMatch(result.message, /dug my way in/);
  assert.deepEqual(bot.walkDug, []);
  assert.equal(bot.walks[0], '0,64,3');
  assert.deepEqual(bot.dug[0], { pos: '1,65,3', from: '0,64,3' });
  assert.equal(bot.dug.length, 60);
  assert.equal(bot.dug.every((d) => inside(box)(d.pos)), true);
  for (const z of [1, 2]) assert.equal(bot.world.get(`10,64,${z}`), undefined);
});

test('with no open way to the box she digs her way in and says where', async () => {
  const bot = fakeBot(mineWorld([0, 64, 0, 0, 65, 0]), { at: new Vec3(0.5, 64, 0.5), fill: rock, tunnel: true });
  const box = { x1: 5, y1: 64, z1: 0, x2: 10, y2: 65, z2: 0 };
  const result = await digArea({ ...fakeCtx(bot), config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } }, box);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^dug 12 blocks from 5 64 0 to 10 65 0 \(12 deepslate\)\. There was no open way to the box on foot, so I dug my way in: 8 blocks from 0 64 0 to 4 64 0\./);
  assert.deepEqual(bot.walkDug.sort(), ['1,64,0', '1,65,0', '2,64,0', '2,65,0', '3,64,0', '3,65,0', '4,64,0', '4,65,0']);
  assert.equal(bot.dug.every((d) => inside(box)(d.pos)), true);
});

test('a pit dug from above and a room dug from the side both come out whole', async () => {
  const pitBot = fakeBot({}, { at: new Vec3(-1.5, 64, 1.5) });
  const pit = { x1: 0, y1: 61, z1: 0, x2: 2, y2: 63, z2: 2 };
  const dugPit = await digArea(fakeCtx(pitBot), pit);
  assert.equal(dugPit.ok, true, dugPit.message);
  assert.match(dugPit.message, /^dug 27 blocks .*\(27 dirt\)/);
  assert.equal(pitBot.dug.every((d) => inside(pit)(d.pos)), true);
  // Top layer first.
  assert.deepEqual([...new Set(pitBot.dug.map((d) => d.pos.split(',')[1]))], ['63', '62', '61']);
  assert.equal(pitBot.entity.position.floored().y, 61);

  const roomBot = fakeBot(mineWorld([0, 64, -4, 0, 65, 4]), { at: new Vec3(0.5, 64, 3.5), fill: rock });
  const room = { x1: 1, y1: 64, z1: -2, x2: 5, y2: 66, z2: 2 };
  const dugRoom = await digArea({ ...fakeCtx(roomBot), config: { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } } }, room);
  assert.equal(dugRoom.ok, true, dugRoom.message);
  assert.match(dugRoom.message, /^dug 75 blocks/);
  assert.doesNotMatch(dugRoom.message, /Left/);
  assert.equal(roomBot.dug.every((d) => inside(room)(d.pos) && d.from.split(',')[1] === '64'), true);
});

test('dig_area with ores takes a vein it uncovers in the wall and floor and carries on, without ores it lists it', async () => {
  const ores = {
    '5,66,0': 'deepslate_diamond_ore', '5,67,0': 'deepslate_diamond_ore', '6,67,0': 'deepslate_diamond_ore',
    '8,64,1': 'deepslate_redstone_ore', '8,63,0': 'deepslate_redstone_ore'
  };
  const config = { protectedBlocks: [], limits: { moveTimeoutSeconds: 5, maxDigBlocks: 1000 } };
  const box = { x1: 1, y1: 64, z1: 0, x2: 10, y2: 65, z2: 0 };
  const bot = fakeBot({ ...mineWorld([0, 64, -5, 0, 65, 5]), ...ores }, { at: new Vec3(0.5, 64, 3.5), fill: rock, items: [{ name: 'cobbled_deepslate', count: 4 }] });
  const own = new Set();
  const ctx = { ...fakeCtx(bot, own), config };
  ctx.placed.add = (name, p) => own.add(key(p));
  const result = await digArea(ctx, { ...box, ores: true });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^dug 20 blocks .*Mined out the ore I uncovered: 3 deepslate_diamond_ore, 2 deepslate_redstone_ore \(put 1 blocks back in the floor where ore came out\)\..*now at 9 64 0$/);
  for (const k of Object.keys(ores)) assert.notEqual(bot.world.get(k), ores[k], k);
  assert.equal(bot.world.get('8,63,0'), 'cobbled_deepslate');
  assert.equal(bot.dug.filter((d) => inside(box)(d.pos)).length, 20);

  const leave = fakeBot({ ...mineWorld([0, 64, -5, 0, 65, 5]), ...ores }, { at: new Vec3(0.5, 64, 3.5), fill: rock });
  const listed = await digArea({ ...fakeCtx(leave), config }, box);
  assert.equal(listed.ok, true, listed.message);
  assert.match(listed.message, /Ore showing in the walls, left in place: 1 deepslate_diamond_ore \(at 5 66 0\), 2 deepslate_redstone_ore \(at 8 63 0; 8 64 1\)/);
  assert.equal(leave.dug.every((d) => inside(box)(d.pos)), true);
});
