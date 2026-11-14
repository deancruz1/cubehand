import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pathfinderPkg from 'mineflayer-pathfinder';
import { setupMovements } from '../src/actions/movement.js';

// Real 26.1 blocks, loaded the way mineflayer loads them.
const require = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);
const { GoalBlock } = pathfinderPkg.goals;

function world() {
  const blocks = new Map();
  return {
    set: (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, Block.fromProperties(name, props, 0)),
    get: (p) => {
      const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const b = blocks.get(`${f.x},${f.y},${f.z}`);
      const out = b ? Block.fromStateId(b.stateId, 0) : Block.fromProperties('air', {}, 0);
      out.position = f;
      return out;
    },
    floor(y = 63) {
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) this.set(x, y, z, 'stone');
    }
  };
}

function movementsIn(w, extra = {}) {
  const bot = {
    registry, game: { minY: -64 }, entities: {}, players: {},
    entity: { position: new Vec3(0, 64, 0), effects: {} },
    inventory: { items: () => [] },
    blockAt: (p) => w.get(p),
    on: () => {},
    pathfinder: { setMovements() {}, bestHarvestTool: () => ({ type: registry.itemsByName.diamond_pickaxe.id }) },
    ...extra
  };
  setupMovements(bot);
  return bot.moveModes.noPlace;
}

function plan(w, from, goal, extra) {
  return new AStar(new Move(from.x, from.y, from.z, 0, 0), movementsIn(w, extra), goal, 5000, 10000, -1).compute();
}

const cells = (path) => path.map((n) => `${n.x},${n.y},${n.z}`);

test('a path handed out in pieces gets fresh steps each time', () => {
  const w = world();
  w.floor();
  const astar = new AStar(new Move(0, 64, -3, 0, 0), movementsIn(w), new GoalBlock(0, 64, 3), 5000, 0, -1);
  let result = astar.compute();
  assert.equal(result.status, 'partial');
  // The pathfinder moves steps in place (here: up a block). The next piece must not see that.
  while (result.status === 'partial') {
    for (const step of result.path) step.y += 1;
    result = astar.compute();
  }
  assert.equal(result.status, 'success');
  assert.ok(result.path.every((n) => n.y === 64));
});

test('a door is only walked through straight on, never from the side', () => {
  const door = (w, facing) => {
    w.set(0, 64, 0, 'spruce_door', { facing, half: 'lower', hinge: 'left', open: 'true' });
    w.set(0, 65, 0, 'spruce_door', { facing, half: 'upper', hinge: 'left', open: 'true' });
  };
  // A door in a wall, facing the way through it.
  const inWall = world();
  inWall.floor();
  for (let x = -4; x <= 4; x++) if (x !== 0) for (let y = 64; y <= 66; y++) inWall.set(x, y, 0, 'stone');
  door(inWall, 'south');
  assert.ok(cells(plan(inWall, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2)).path).includes('0,64,0'));

  // A door facing east, passed north to south: the open door is in the way, so walk around it.
  const loose = world();
  loose.floor();
  door(loose, 'east');
  const result = plan(loose, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2));
  assert.equal(result.status, 'success');
  assert.ok(!cells(result.path).includes('0,64,0'));
});

test('an open trapdoor is not something to stand on or walk through', () => {
  const w = world();
  w.floor();
  w.set(0, 64, 0, 'spruce_trapdoor', { facing: 'west', half: 'bottom', open: 'true' });
  w.set(1, 64, 0, 'spruce_trapdoor', { facing: 'west', half: 'bottom', open: 'false' });
  const m = movementsIn(w);
  const open = m.getBlock(new Vec3(0, 64, 0), 0, 0, 0);
  assert.equal(open.physical, false);
  assert.equal(open.safe, false);
  // A closed one on the ground is still a low step.
  assert.equal(m.getBlock(new Vec3(1, 64, 0), 0, 0, 0).physical, true);
});

test("the walk never digs through the bot's own blocks, even natural-looking ones", () => {
  const w = world();
  w.floor();
  for (let x = -4; x <= 4; x++) for (let y = 64; y <= 67; y++) w.set(x, y, 0, 'tuff');
  const wild = plan(w, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2));
  assert.equal(wild.status, 'success');
  const own = plan(w, new Vec3(0, 64, -2), new GoalBlock(0, 64, 2), { placedLog: { has: (p, name) => name === 'tuff' && p.z === 0 } });
  assert.notEqual(own.status, 'success');
});
