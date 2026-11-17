import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { arrowPath, arrowPitch, aimAt, arcPoints, shotProblem, incoming, takeShield, swelling, attack } from '../src/actions/combat.js';

const deg = (r) => (r * 180) / Math.PI;

// The height of the path at distance across, read off arrowPath the same way a hit would be.
function heightOn(pitch, distance, options) {
  const points = arrowPath(pitch, options);
  const i = points.findIndex(([h]) => h >= distance);
  const [h0, y0] = points[i - 1];
  const [h1, y1] = points[i];
  return y0 + ((y1 - y0) * (distance - h0)) / (h1 - h0);
}

test('with no gravity or drag the aim is the straight line', () => {
  const straight = { gravity: 0, drag: 1 };
  assert.ok(Math.abs(deg(arrowPitch(10, 10, straight).pitch) - 45) < 0.01);
  assert.ok(Math.abs(deg(arrowPitch(20, 0, straight).pitch)) < 0.01);
  assert.ok(Math.abs(deg(arrowPitch(10, -10, straight).pitch) + 45) < 0.01);
  assert.ok(Math.abs(arrowPitch(30, 0, straight).ticks - 10) < 0.01);
});

test('the arc aims above a flat target by a little more the further it is, and lands on it', () => {
  let last = 0;
  for (const distance of [5, 10, 20, 30, 40]) {
    const { pitch } = arrowPitch(distance, 0);
    assert.ok(pitch > last, `${distance}: ${deg(pitch)}`);
    last = pitch;
    for (const rise of [-4, 0, 4]) {
      const aim = arrowPitch(distance, rise);
      assert.ok(Math.abs(heightOn(aim.pitch, distance) - rise) < 0.01, `${distance} ${rise}`);
    }
  }
  assert.ok(deg(arrowPitch(10, 0).pitch) > 1 && deg(arrowPitch(10, 0).pitch) < 1.5);
  assert.ok(deg(arrowPitch(30, 0).pitch) > 4.2 && deg(arrowPitch(30, 0).pitch) < 5);
  assert.equal(arrowPitch(300, 0), null);
});

test('without drag the pitch matches the closed form after a whole number of ticks', () => {
  // After n ticks an arrow loosed at a has gone n*3*cos(a) across and n*3*sin(a) - 0.05*n*(n-1)/2 up.
  for (const [a, n] of [[5, 10], [12, 8], [-3, 6], [20, 15]]) {
    const r = (a * Math.PI) / 180;
    const across = n * 3 * Math.cos(r);
    const up = n * 3 * Math.sin(r) - (0.05 * n * (n - 1)) / 2;
    const aim = arrowPitch(across, up, { drag: 1 });
    assert.ok(Math.abs(deg(aim.pitch) - a) < 0.01, `${a}: ${deg(aim.pitch)}`);
    assert.ok(Math.abs(aim.ticks - n) < 0.01);
  }
});

test('the aim faces the target and leads one that is moving', () => {
  const from = new Vec3(0, 65.5, 0);
  const still = aimAt(from, new Vec3(15, 65.5, 0));
  assert.ok(Math.abs(still.yaw + Math.PI / 2) < 1e-9);
  const north = aimAt(from, new Vec3(0, 65.5, -15));
  assert.ok(Math.abs(north.yaw) < 1e-9);
  const moving = aimAt(from, new Vec3(15, 65.5, 0), new Vec3(0, 0, 0.2));
  assert.ok(moving.point.z > 0.5, `aimed at z ${moving.point.z}`);
  assert.ok(Math.abs(moving.point.z - 0.2 * moving.ticks) < 0.01);
  const points = arcPoints(from, still);
  assert.deepEqual(points.at(-1), new Vec3(15, 65.5, 0));
  assert.ok(points.every((p) => Math.abs(p.z) < 1e-9 && p.y >= 65.5 - 1e-9));
});

const mob = (id, name, x, z, extra = {}) => ({ id, name, type: 'hostile', position: new Vec3(x, 64, z), height: 1.95, width: 0.6, metadata: [], ...extra });

test('a shot is called off for a block in the way or anyone who mustn\'t be hit near the line', () => {
  const self = { position: new Vec3(0, 64, 0) };
  const target = mob(1, 'skeleton', 20, 0);
  const bot = { entity: self, entities: { 0: self, 1: target }, world: { raycast: () => null } };
  const from = new Vec3(0, 65.5, 0);
  const shot = aimAt(from, new Vec3(20, 65, 0));
  const points = arcPoints(from, shot);
  assert.equal(shotProblem(bot, points, target), null);
  bot.entities[2] = { id: 2, type: 'player', username: 'Steve', position: new Vec3(10, 64, 1.5), height: 1.8 };
  assert.match(shotProblem(bot, points, target), /Steve is too close to the line/);
  bot.entities[2].position = new Vec3(10, 64, 4);
  assert.equal(shotProblem(bot, points, target), null);
  bot.entities[3] = { id: 3, name: 'cow', type: 'animal', position: new Vec3(15, 64, -1), height: 1.4, metadata: [] };
  assert.match(shotProblem(bot, points, target), /a cow is too close/);
  delete bot.entities[3];
  bot.entities[4] = mob(4, 'zombie', 5, 1, { metadata: { 2: 'Bob' }, getCustomName: () => 'Bob' });
  assert.match(shotProblem(bot, points, target), /Bob is too close/);
  delete bot.entities[4];
  bot.world.raycast = () => ({ name: 'stone' });
  assert.equal(shotProblem(bot, points, target), 'no clear shot');
});

const KEYS = [...Array(16).fill('other'), 'swell_dir', 'is_powered', 'is_ignited'];

test('a shield goes up for a shooter in sight within 16 blocks and a creeper about to blow', () => {
  const self = { position: new Vec3(0, 64, 0) };
  const bot = { entity: self, entities: { 0: self }, registry: { entitiesByName: { creeper: { metadataKeys: KEYS } } }, world: { raycast: () => null } };
  bot.entities[1] = mob(1, 'skeleton', 12, 0);
  assert.equal(incoming(bot)?.name, 'skeleton');
  bot.world.raycast = () => ({ name: 'stone' });
  assert.equal(incoming(bot), null);
  bot.world.raycast = () => null;
  bot.entities[1].position = new Vec3(20, 64, 0);
  assert.equal(incoming(bot), null);
  delete bot.entities[1];
  const creeper = mob(2, 'creeper', 3, 0);
  creeper.metadata[16] = -1;
  bot.entities[2] = creeper;
  assert.equal(swelling(bot, creeper), false);
  assert.equal(incoming(bot), null);
  creeper.metadata[16] = 1;
  assert.equal(incoming(bot)?.name, 'creeper');
  creeper.position = new Vec3(6, 64, 0);
  assert.equal(incoming(bot), null);
  creeper.metadata[16] = -1;
  creeper.metadata[18] = true;
  assert.equal(swelling(bot, creeper), true);
});

// A bot that fights by itself: equip moves items between the inventory, the hand and the off hand,
// and every use of an item goes in events.
function fighter({ items = [], offHand = null, mobs = [], hitsToKill = 2 } = {}) {
  const self = { position: new Vec3(0, 64, 0), height: 1.8 };
  const events = [];
  const inv = [...items];
  const hits = new Map();
  const bot = {
    entity: self,
    entities: { 0: self },
    players: {},
    health: 20,
    heldItem: null,
    world: { raycast: () => null },
    registry: { entitiesByName: {} },
    inventory: { items: () => inv.filter((i) => i.count > 0), slots: { 45: offHand } },
    pathfinder: { setGoal: () => {} },
    on: () => {},
    removeListener: () => {},
    look: async () => {},
    lookAt: async () => {},
    equip: async (item, where) => {
      events.push(`equip ${item.name} ${where}`);
      inv.splice(inv.indexOf(item), 1);
      if (where === 'off-hand') {
        if (bot.inventory.slots[45]) inv.push(bot.inventory.slots[45]);
        bot.inventory.slots[45] = item;
      } else {
        if (bot.heldItem) inv.push(bot.heldItem);
        bot.heldItem = item;
      }
    },
    unequip: async () => {
      if (bot.heldItem) inv.push(bot.heldItem);
      bot.heldItem = null;
    },
    activateItem: (off = false) => {
      events.push(off ? 'raise' : 'draw');
      bot.drawing = !off;
    },
    deactivateItem: () => {
      if (!bot.drawing) return events.push('lower');
      events.push('loose');
      bot.drawing = false;
      inv.find((i) => i.name === 'arrow').count--;
      const target = Object.values(bot.entities).find((e) => e !== self);
      if (target) delete bot.entities[target.id];
    },
    attack: (target) => {
      events.push('hit');
      hits.set(target.id, (hits.get(target.id) ?? 0) + 1);
      if (hits.get(target.id) >= hitsToKill) delete bot.entities[target.id];
    }
  };
  for (const m of mobs) bot.entities[m.id] = m;
  return { bot, events, ctx: { bot, signal: null } };
}

test('a shield is put in the off hand, raised between swings, lowered to strike, and the old item put back', async () => {
  const torch = { name: 'torch', count: 3 };
  const f = fighter({ items: [{ name: 'shield', count: 1 }], offHand: torch, mobs: [mob(1, 'zombie', 2, 0)] });
  const result = await attack(f.ctx, { target: 'zombie' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.events, ['equip shield off-hand', 'hit', 'raise', 'lower', 'hit', 'raise', 'lower', 'equip torch off-hand']);
  assert.equal(f.bot.inventory.slots[45], torch);

  const bare = fighter({ mobs: [mob(1, 'zombie', 2, 0)] });
  await attack(bare.ctx, { target: 'zombie' });
  assert.deepEqual(bare.events, ['hit', 'hit']);
  assert.equal(await takeShield(fighter({ items: [{ name: 'shield', count: 1 }], offHand: { name: 'totem_of_undying', count: 1 } }).bot), null);
});

test('a far target is shot with a full draw, and the result says how many arrows went and are left', async () => {
  const f = fighter({ items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 5 }], mobs: [mob(1, 'skeleton', 12, 0)] });
  const began = Date.now();
  const result = await attack(f.ctx, { target: 'skeleton' });
  assert.ok(Date.now() - began >= 1000);
  assert.deepEqual(f.events, ['equip bow hand', 'draw', 'loose']);
  assert.match(result.message, /killed 1 skeleton bare-handed, shot 1 arrow \(4 left\)/);
});

test('close in, or out of arrows, it fights hand to hand', async () => {
  const near = fighter({ items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 5 }], mobs: [mob(1, 'skeleton', 2.5, 0)] });
  await attack(near.ctx, { target: 'skeleton' });
  assert.deepEqual(near.events, ['hit', 'hit']);
  const empty = fighter({ items: [{ name: 'bow', count: 1 }], mobs: [mob(1, 'zombie', 2.5, 0)] });
  await attack(empty.ctx, { target: 'zombie' });
  assert.ok(!empty.events.includes('draw'));
});
