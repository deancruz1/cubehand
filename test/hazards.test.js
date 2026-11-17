import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { hazard, swimPath, standSpots, waterSpots, getOut, escapeReport, Survival } from '../src/survival.js';
import { wetDrop, collectItems } from '../src/actions/items.js';

const SOLID = new Set(['stone', 'ice', 'dirt']);
const key = (p) => `${p.x},${p.y},${p.z}`;

// A world from fill(x, y, z), which names the block there. Bodies move a little each tick: forward
// along the yaw, up while jump is held in water or lava, out onto a block in the way from water,
// and down onto the ground otherwise.
function fakeBot(fill, { at = new Vec3(0.5, 60, 0.5), health = 20, food = 20, oxygen = 20, burning = false } = {}) {
  const set = new Map();
  const nameAt = (p) => set.get(key(p)) ?? fill(p.x, p.y, p.z);
  const blockAt = (p) => {
    const f = p.floored();
    const name = nameAt(f);
    return { name, position: f, boundingBox: SOLID.has(name) ? 'block' : 'empty', getProperties: () => ({}) };
  };
  const solid = (p) => blockAt(p).boundingBox === 'block';
  const liquid = (p) => ['water', 'lava'].includes(blockAt(p).name);
  const controls = {};
  const trail = [];
  const entity = {
    position: at.clone(),
    yaw: 0,
    eyeHeight: 1.62,
    get isInWater() {
      return blockAt(this.position).name === 'water';
    },
    get isInLava() {
      return blockAt(this.position).name === 'lava';
    },
    get onGround() {
      return Number.isInteger(this.position.y) && solid(this.position.offset(0, -1, 0));
    },
    get metadata() {
      return [bot.burning && !this.isInWater ? 1 : 0];
    }
  };
  const step = () => {
    const p = entity.position;
    if (controls.forward) {
      const next = p.offset(-Math.sin(entity.yaw) * 0.3, 0, -Math.cos(entity.yaw) * 0.3);
      if (!solid(next) && !solid(next.offset(0, 1, 0))) entity.position = next;
      else if (liquid(p) && !solid(next.offset(0, 1, 0)) && !solid(next.offset(0, 2, 0))) entity.position = new Vec3(next.x, Math.floor(p.y) + 1, next.z);
    }
    const q = entity.position;
    if (controls.jump && liquid(q) && !solid(q.offset(0, 2.05, 0))) entity.position = q.offset(0, 0.25, 0);
    else if (!liquid(q) && !entity.onGround) {
      let y = Math.floor(q.y);
      while (!solid(new Vec3(q.x, y - 1, q.z)) && !liquid(new Vec3(q.x, y - 1, q.z)) && y > 0) y--;
      entity.position = new Vec3(q.x, y, q.z);
    }
    trail.push(entity.position.clone());
  };
  const bot = {
    entity,
    health,
    food,
    oxygenLevel: oxygen,
    burning,
    trail,
    controls,
    set,
    entities: {},
    players: {},
    blockAt,
    pathfinder: { goal: null, setGoal: (goal) => (bot.pathfinder.goal = goal) },
    registry: { foodsByName: { bread: { foodPoints: 5, saturation: 6 } } },
    inventory: { items: () => [{ name: 'bread', count: 3 }] },
    heldItem: null,
    equip: async () => {},
    consume: async () => {
      bot.food = Math.min(20, bot.food + 5);
      bot.health += 4;
    },
    look: async (yaw) => {
      entity.yaw = yaw;
    },
    setControlState: (name, value) => {
      controls[name] = value;
      if (name === 'jump') step();
    },
    clearControlStates: () => {
      for (const name of Object.keys(controls)) controls[name] = false;
    }
  };
  return bot;
}

const headIn = (bot) => bot.blockAt(bot.entity.position.offset(0, 1.62, 0)).name;

// A lake of water from y 60 to 62 on stone, frozen over at y 63 except for a hole at x 4,
// with stone banks past x 8 and z 8 either way.
function frozenLake(x, y, z, { hole = true } = {}) {
  if (Math.abs(x) > 8 || Math.abs(z) > 8) return y <= 63 ? 'stone' : 'air';
  if (y <= 59) return 'stone';
  if (y <= 62) return 'water';
  if (y === 63) return hole && x === 4 && z === 0 ? 'water' : 'ice';
  return 'air';
}

// Open water from y 60 to 62 with air above, and a stone shore from x 3 on, level with the water.
function openWater(x, y, z) {
  if (y <= 59) return 'stone';
  if (x >= 3) return y <= 62 ? 'stone' : 'air';
  return y <= 62 ? 'water' : 'air';
}

const quietBrain = (calls = []) => ({
  busy: true,
  holds: new Set(),
  pause: async (reason) => calls.push(['pause', reason]),
  resume: (reason, report) => calls.push(['resume', reason, report])
});

const survivalFor = (bot, brain) =>
  new Survival({ getBot: () => bot, brain, config: { survival: { criticalHealth: 8, eatAtFood: 14 } }, makeCtx: () => ({ bot }), log: () => {}, say: () => {} });

test('her head under water is only a danger once air runs low or she gets hurt there', () => {
  const bot = fakeBot(frozenLake);
  assert.equal(hazard(bot), null);
  assert.equal(hazard(bot, { hurt: true }), 'air');
  assert.equal(hazard(bot, { strict: true }), 'air');
  bot.oxygenLevel = 10;
  assert.equal(hazard(bot), 'air');

  // Wading with her head out: nothing, unless she is healing and must not stand there.
  const wading = fakeBot((x, y) => (y <= 59 ? 'stone' : y === 60 ? 'water' : 'air'), { oxygen: 3 });
  assert.equal(hazard(wading, { hurt: true }), null);
  assert.equal(hazard(wading, { strict: true }), 'water');
});

test('lava, fire and burning out of water are dangers, burning in water is not', () => {
  assert.equal(hazard(fakeBot((x, y) => (y <= 59 ? 'stone' : y === 60 ? 'lava' : 'air'))), 'lava');
  assert.equal(hazard(fakeBot((x, y) => (y <= 59 ? 'stone' : y === 60 ? 'fire' : 'air'))), 'fire');
  const field = (x, y) => (y <= 59 ? 'stone' : 'air');
  assert.equal(hazard(fakeBot(field, { burning: true })), 'burning');
  assert.equal(hazard(fakeBot(field)), null);
  assert.equal(hazard(fakeBot((x, y) => (y <= 59 ? 'stone' : y === 60 ? 'water' : 'air'), { burning: true })), null);
});

test('under ice the way to air goes round to the hole, never up through the ice', () => {
  const bot = fakeBot(frozenLake);
  const path = swimPath((p) => bot.blockAt(p), new Vec3(0, 61, 0));
  assert.ok(path);
  assert.deepEqual(path.at(-1), new Vec3(4, 64, 0));
  for (const p of path) assert.notEqual(frozenLake(p.x, p.y, p.z), 'ice');

  const shut = fakeBot((x, y, z) => frozenLake(x, y, z, { hole: false }));
  assert.equal(swimPath((p) => shut.blockAt(p), new Vec3(0, 61, 0)), null);

  // In open water it is straight up.
  const open = fakeBot(openWater);
  assert.deepEqual(swimPath((p) => open.blockAt(p), new Vec3(0, 61, 0)), [new Vec3(0, 61, 0), new Vec3(0, 62, 0), new Vec3(0, 63, 0)]);
});

test('places to stand and water to put a fire out in are found closest first', () => {
  const bot = fakeBot(openWater);
  const get = (p) => bot.blockAt(p);
  assert.deepEqual(standSpots(get, new Vec3(0, 62, 0), 6)[0], new Vec3(3, 63, 0));
  const field = (x, y, z) => (y <= 59 ? 'stone' : y === 60 && x === -3 && z === 0 ? 'water' : 'air');
  const dry = fakeBot(field);
  // Lava and fire are never somewhere to stand.
  dry.set.set('1,60,0', 'fire');
  assert.deepEqual(waterSpots((p) => dry.blockAt(p), new Vec3(0, 60, 0)), [new Vec3(-3, 60, 0)]);
  assert.ok(!standSpots((p) => dry.blockAt(p), new Vec3(0, 60, 0), 2).some((p) => p.equals(new Vec3(1, 60, 0))));
});

test('out of air under ice she swims to the hole, gets her head out and climbs onto the ice', async () => {
  const bot = fakeBot(frozenLake, { oxygen: 8 });
  const what = await getOut(bot, 'air');
  assert.match(what, /^swam up to air at 4 6\d 0, then got out onto ice at \d+ 64 0$/);
  assert.equal(bot.entity.onGround, true);
  assert.equal(bot.entity.isInWater, false);
  for (const p of bot.trail) assert.notEqual(headIn({ ...bot, entity: { position: p } }), 'ice');
});

test('a job running under water is told to stop and she swims up without waiting for it', async () => {
  const bot = fakeBot(openWater, { oxygen: 10 });
  const calls = [];
  // The tool never finishes stopping, which must not hold her under.
  const brain = { ...quietBrain(calls), pause: (reason) => (calls.push(['pause', reason]), new Promise(() => {})) };
  const survival = survivalFor(bot, brain);
  survival.check();
  assert.ok(survival.escaping);
  await survival.escaping;
  await new Promise((r) => setImmediate(r));
  assert.notEqual(headIn(bot), 'water');
  assert.deepEqual(calls[0], ['pause', 'hazard']);
  assert.equal(calls[1][1], 'hazard');
  assert.match(calls[1][2], /^Your air ran low under water, so you stopped to get out\. You swam up to air at .*, then got out onto stone at 3 63 0\. Health is now 20\/20/);
  assert.equal(survival.escaping, null);
});

test('with air to spare and nothing hurting her, a job under water carries on', () => {
  const bot = fakeBot(openWater, { oxygen: 18 });
  const calls = [];
  const survival = survivalFor(bot, quietBrain(calls));
  survival.check();
  assert.equal(survival.escaping, null);
  assert.deepEqual(calls, []);
});

test('hurt under water, recovery gets her to air before it waits for the job to stop or heals', async () => {
  const bot = fakeBot(openWater, { health: 5, food: 10 });
  const order = [];
  const brain = {
    ...quietBrain(),
    pause: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      order.push('stopped');
    },
    resume: (reason, report) => order.push(['resume', reason, report])
  };
  const survival = survivalFor(bot, brain);
  const watch = setInterval(() => {
    if (headIn(bot) !== 'water' && !order.includes('air')) order.push('air');
  }, 20);
  try {
    await survival.recover(bot, true);
  } finally {
    clearInterval(watch);
  }
  assert.equal(order[0], 'air');
  assert.equal(order[1], 'stopped');
  assert.equal(order[2][1], 'danger');
  assert.match(order[2][2], /^Your health got down to 5\/20, so you stopped to look after yourself\. You swam up to air at .*, then got out onto stone at 3 63 0, then ate 2 bread\./);
});

test('in lava she climbs out, then puts the fire out in water close by', async () => {
  // A lava pit at x 0, a stone floor round it at y 60 and a pond at x -3.
  const pit = (x, y, z) => {
    if (y <= 59) return x === 0 && z === 0 && y === 59 ? 'lava' : 'stone';
    if (y === 60 && x === 0 && z === 0) return 'lava';
    if (y === 60 && x === -3 && z === 0) return 'water';
    return y < 60 ? 'stone' : 'air';
  };
  const bot = fakeBot(pit, { at: new Vec3(0.5, 59.5, 0.5), burning: true });
  assert.equal(hazard(bot), 'lava');
  const what = await getOut(bot, 'lava');
  assert.match(what, /^got out of the lava at -?\d+ 60 -?\d+, then put the fire out in the water at -3 60 0$/);
  assert.equal(bot.entity.isInWater, true);
});

test('the account of getting out says what the danger was, what she did and where she is', () => {
  assert.equal(
    escapeReport('air', 'swam up to air at 4 63 0', { health: 6.4, position: new Vec3(4.5, 63, 0.5) }),
    "Your air ran low under water, so you stopped to get out. You swam up to air at 4 63 0. Health is now 6/20, and you're at 4 63 0."
  );
});

test('drops sunk in water, held under ice or in lava are wet, floating ones are not', () => {
  const pond = (x, y, z) => {
    if (y <= 59) return 'stone';
    if (x === 0) return y <= 61 ? 'water' : 'air';
    if (x === 1) return y <= 61 ? 'water' : y === 62 ? 'ice' : 'air';
    if (x === 2) return y === 60 ? 'lava' : 'air';
    return 'air';
  };
  const bot = fakeBot(pond, { at: new Vec3(5.5, 60, 0.5) });
  const drop = (x, y) => ({ position: new Vec3(x + 0.5, y + 0.2, 0.5) });
  assert.equal(wetDrop(bot, drop(0, 60)), true);
  assert.equal(wetDrop(bot, drop(0, 61)), false);
  assert.equal(wetDrop(bot, drop(1, 61)), true);
  assert.equal(wetDrop(bot, drop(2, 60)), true);
  assert.equal(wetDrop(bot, drop(4, 60)), false);
});

test('collect_items with nothing dropped is fine, and leaves wet drops where they are, saying so', async () => {
  const pond = (x, y) => (y <= 59 ? 'stone' : x <= -2 ? (y <= 62 ? 'water' : 'air') : 'air');
  const items = [];
  const bot = fakeBot(pond, { at: new Vec3(0.5, 60, 0.5) });
  bot.inventory.items = () => items;
  const ctx = { bot, config: { limits: { moveTimeoutSeconds: 5 } } };

  const none = await collectItems(ctx, {});
  assert.deepEqual(none, { ok: true, message: 'no dropped items within 16 blocks' });

  const item = (id, name, p) => ({ id, name: 'item', position: p, getDroppedItem: () => ({ name, count: 1 }) });
  bot.entities = { 1: item(1, 'cobblestone', new Vec3(0.5, 60, 0.5)), 2: item(2, 'diamond_boots', new Vec3(-4.5, 60.2, 0.5)) };
  setTimeout(() => {
    delete bot.entities[1];
    items.push({ name: 'cobblestone', count: 1 });
  }, 100);
  const some = await collectItems(ctx, {});
  assert.equal(some.ok, true);
  assert.equal(some.message, 'picked up 1 cobblestone, 1 left under water or in lava, where I could drown or burn getting it');
  assert.equal(bot.trail.length, 0);

  const wet = await collectItems(ctx, {});
  assert.deepEqual(wet, { ok: false, message: 'picked up nothing, 1 left under water or in lava, where I could drown or burn getting it' });
});
