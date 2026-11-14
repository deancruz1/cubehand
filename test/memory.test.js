import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory } from '../src/memory.js';

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-'));
  return { path: join(dir, 'memory.json'), cleanup: () => rmSync(dir, { recursive: true }) };
}

test('memories survive a restart', () => {
  const { path, cleanup } = tempPath();
  new Memory(path).remember({ name: 'quarry', note: 'mine stone here', x: 1, y: 64, z: -3 });
  const reloaded = new Memory(path);
  assert.match(reloaded.summary(), /quarry \(1 64 -3\): mine stone here/);
  cleanup();
});

test('saving the same name replaces it, and forget removes it', () => {
  const { path, cleanup } = tempPath();
  const memory = new Memory(path);
  memory.remember({ name: 'Quarry', note: 'old' });
  memory.remember({ name: 'quarry', note: 'new' });
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].note, 'new');
  assert.equal(memory.forget('QUARRY'), true);
  assert.equal(memory.summary(), 'Memories: none');
  cleanup();
});
