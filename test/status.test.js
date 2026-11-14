import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Status } from '../src/status.js';

function setup({ busy = true } = {}) {
  const said = [];
  const bot = { entity: { position: new Vec3(10, 64, -5) }, inventory: { items: () => [] }, targetDigBlock: null };
  const status = new Status({ getBot: () => bot, say: (t) => said.push(t), isBusy: () => busy, stuckSeconds: 45, quietSeconds: 60 });
  const controller = new AbortController();
  const watch = status.watch('build_house', controller);
  return { said, bot, status, controller, watch, run: status.run, t0: status.run.started };
}

test('a tool that changes nothing for too long is stopped as stuck', () => {
  const { status, controller, watch, run, t0 } = setup();
  status.check(run, t0 + 44000);
  assert.equal(controller.signal.aborted, false);
  status.check(run, t0 + 46000);
  assert.equal(controller.signal.reason, 'stuck');
  watch.stop();
});

test('moving, digging, items changing or progress keep a tool alive', () => {
  const { status, controller, watch, run, bot, t0 } = setup();
  bot.entity.position = new Vec3(12, 64, -5);
  status.check(run, t0 + 40000);
  bot.targetDigBlock = {};
  status.check(run, t0 + 80000);
  bot.targetDigBlock = null;
  bot.inventory.items = () => [{ slot: 9, type: 1, count: 3 }];
  status.check(run, t0 + 120000);
  run.active = t0 + 150000;
  status.check(run, t0 + 160000);
  assert.equal(controller.signal.aborted, false);
  watch.stop();
});

test('a status line goes to chat when she has been quiet for a minute during a job', () => {
  const { status, said, watch, t0 } = setup();
  status.spoke(t0);
  status.progress('placed 10 of 700 blocks');
  status.heartbeat(t0 + 30000);
  assert.deepEqual(said, []);
  status.heartbeat(t0 + 61000);
  assert.deepEqual(said, ['(building the house: placed 10 of 700 blocks)']);
  status.spoke(t0 + 100000);
  status.heartbeat(t0 + 125000);
  assert.equal(said.length, 1);
  watch.stop();
  status.heartbeat(t0 + 200000);
  assert.deepEqual(said.at(-1), '(done building the house, working out the next step)');
});

test('no status lines between jobs', () => {
  const { status, said, watch, t0 } = setup({ busy: false });
  status.heartbeat(t0 + 120000);
  assert.deepEqual(said, []);
  watch.stop();
});

test('the stuck report says where, how far it got, and the last walking problem', () => {
  const { status, watch, run } = setup();
  status.progress('clearing the site: 40 of 900 blocks');
  status.noteStuck('stuck at 10 64 -5 (try 2)');
  const report = watch.report();
  assert.match(report, /nothing changed for 45 seconds/);
  assert.match(report, /I'm at 10 64 -5/);
  assert.match(report, /clearing the site: 40 of 900 blocks/);
  assert.match(report, /last walking problem: stuck at 10 64 -5/);
  assert.match(status.summary(), /running build_house/);
  watch.stop();
  assert.equal(status.summary(), null);
  assert.equal(run.name, 'build_house');
});
