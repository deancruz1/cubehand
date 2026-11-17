import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tended, fieldRecord } from '../src/tended.js';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tended-'));
  try {
    return fn(join(dir, 'tended.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const field = (x, z, extra = {}) => ({ x, y: 63, z, x2: x + 4, y2: 63, z2: z + 4, dimension: 'overworld', ...extra });

test('fields and pens are kept apart, by dimension, and survive a restart', () => {
  withStore((path) => {
    const store = new Tended(path);
    assert.equal(store.add('fields', field(0, 0, { crop: 'wheat' })), 'added');
    assert.equal(store.add('pens', { x: 10, y: 64, z: 0, x2: 14, y2: 65, z2: 4, animal: 'cow', keep: 4, dimension: 'overworld', lastTended: 1, nextAt: 2 }), 'added');
    assert.equal(store.add('fields', field(0, 0, { dimension: 'the_nether' })), 'added');
    assert.equal(existsSync(`${path}.tmp`), false);
    const back = new Tended(path);
    assert.deepEqual(back.list('fields', 'overworld'), [field(0, 0, { crop: 'wheat' })]);
    assert.equal(back.list('fields', 'the_nether').length, 1);
    assert.equal(back.list('pens', 'overworld')[0].animal, 'cow');
    assert.deepEqual(back.list('pens', 'the_nether'), []);
  });
});

test('duplicates and boxes inside one already kept are dropped, the same corners replace', () => {
  const store = new Tended();
  assert.equal(store.add('fields', field(0, 0)), 'added');
  assert.equal(store.add('fields', field(0, 0)), null);
  assert.equal(store.add('fields', { x: 1, y: 63, z: 1, x2: 2, y2: 63, z2: 2, dimension: 'overworld', crop: 'carrots' }), null);
  assert.equal(store.add('fields', field(0, 0, { crop: 'wheat' })), 'replaced');
  // Inside a wheat field, a carrot field is a field of its own.
  assert.equal(store.add('fields', { x: 1, y: 63, z: 1, x2: 2, y2: 63, z2: 2, dimension: 'overworld', crop: 'carrots' }), 'added');
  assert.equal(store.list('fields', 'overworld').length, 2);

  // A pen tended again keeps one entry, with the new times.
  const pen = { x: 0, y: 64, z: 0, dimension: 'overworld', lastTended: 1, nextAt: 2 };
  store.add('pens', pen);
  assert.equal(store.add('pens', { ...pen, lastTended: 5, nextAt: 9 }), 'replaced');
  assert.deepEqual(store.list('pens', 'overworld'), [{ ...pen, lastTended: 5, nextAt: 9 }]);
  assert.deepEqual(fieldRecord({ x: 1, y: 2, z: 3 }, { x: 4, y: 2, z: 6 }, 'overworld', 'wheat'), { x: 1, y: 2, z: 3, x2: 4, y2: 2, z2: 6, dimension: 'overworld', crop: 'wheat' });
});

test('at most 32 of each kind are kept, the oldest going first', () => {
  const store = new Tended();
  for (let i = 0; i < 34; i++) store.add('fields', field(i * 10, 0));
  store.add('pens', { x: 0, y: 64, z: 0, dimension: 'overworld' });
  const fields = store.list('fields', 'overworld');
  assert.equal(fields.length, 32);
  assert.equal(fields[0].x, 20);
  assert.equal(store.list('pens', 'overworld').length, 1);
});

test('remove drops everything of the kind overlapping a box, and changes in place are saved', () => {
  withStore((path) => {
    const store = new Tended(path);
    store.add('fields', field(0, 0));
    store.add('fields', field(10, 0));
    store.add('fields', field(3, 0, { dimension: 'the_nether' }));
    store.add('pens', { x: 2, y: 64, z: 2, dimension: 'overworld' });
    assert.equal(store.remove('fields', { x: 4, y: 63, z: 4, x2: 11, y2: 63, z2: 4, dimension: 'overworld' }), 2);
    assert.equal(store.remove('fields', { x: 50, y: 63, z: 50, dimension: 'overworld' }), 0);
    assert.equal(store.list('fields', 'overworld').length, 0);
    assert.equal(store.list('fields', 'the_nether').length, 1);
    assert.equal(store.list('pens', 'overworld').length, 1);

    store.list('pens', 'overworld')[0].nextAt = 1234;
    store.save();
    assert.equal(new Tended(path).list('pens', 'overworld')[0].nextAt, 1234);
  });
});
