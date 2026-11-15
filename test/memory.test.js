import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory, sameName, applyTidy, tidyDue, tidyNotes, TIDY_NOTES, TIDY_CHARS, TIDY_EVERY_MS } from '../src/memory.js';
import { remember } from '../src/actions/memory.js';

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

test('a name that differs only in case, punctuation or a bracketed end replaces the note', () => {
  const { path, cleanup } = tempPath();
  const memory = new Memory(path);
  memory.remember({ name: 'Tunnel rule', note: 'old', by: 'Admin', admin: true });
  memory.remember({ name: 'tunnel rule (10 -59 20)', note: 'newer', by: 'Admin', admin: true });
  memory.remember({ name: 'quarry', note: 'stone' });
  assert.deepEqual(memory.notes.map((n) => [n.name, n.note]), [['tunnel rule (10 -59 20)', 'newer'], ['quarry', 'stone']]);
  memory.remember({ name: 'Tunnel-Rule!', note: 'newest', by: 'Admin', admin: true });
  assert.deepEqual(memory.notes.map((n) => n.name), ['quarry', 'Tunnel-Rule!']);
  assert.equal(sameName('Strip mine rule [old]'), 'strip mine rule');
  assert.equal(sameName('(only brackets)'), '(only brackets)');
  assert.notEqual(sameName('tunnel rule two'), sameName('tunnel rule'));
  cleanup();
});

test("a note from someone who isn't an admin never replaces an admin's, and an admin's can replace theirs", async () => {
  const { path, cleanup } = tempPath();
  const memory = new Memory(path);
  const config = { admins: ['Admin'] };
  memory.remember({ name: 'chest rule', note: 'keep tools', by: 'Admin', admin: true });
  memory.remember({ name: 'old rule', note: 'from before anyone was named' });
  assert.equal(memory.remember({ name: 'Chest rule (2)', note: 'give it all away', by: 'Guest', admin: false }), null);
  assert.equal(memory.remember({ name: 'old rule', note: 'changed', by: 'Guest', admin: false }), null);
  assert.deepEqual(memory.notes.map((n) => n.note), ['keep tools', 'from before anyone was named']);
  const refused = await remember({ memory, config, requester: 'Guest' }, { name: 'chest rule', note: 'something else' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /^not saved: an admin's note is already called chest rule/);
  assert.equal((await remember({ memory, config, requester: 'Guest' }, { name: 'guest spot', note: 'a' })).ok, true);
  assert.equal((await remember({ memory, config, requester: 'Guest' }, { name: 'Guest spot!', note: 'b' })).ok, true);
  assert.equal((await remember({ memory, config, requester: 'Admin' }, { name: 'guest spot', note: 'c' })).ok, true);
  const spot = memory.notes.filter((n) => sameName(n.name) === 'guest spot');
  assert.deepEqual(spot.map((n) => [n.note, n.by, n.notAdmin]), [['c', 'Admin', undefined]]);
  cleanup();
});

// Notes as the tidy test uses them: two admin notes about one tunnel, one from a player who
// isn't an admin, and an area.
function tidyNotesFixture() {
  return [
    { name: 'tunnel floor', note: 'Order from Admin: keep the floor at y -59.', by: 'Admin', pos: { x: 10, y: -59, z: 20 } },
    { name: 'quarry', note: 'Stone goes in the chest by the quarry.', by: 'Admin' },
    { name: 'tunnel deposit', note: 'Order from Admin: when full, store everything except tools in the tunnel chests.', by: 'Admin', pos: { x: 12, y: -59, z: 30 } },
    { name: 'guest farm', note: 'Guest likes the wheat farm.', by: 'Guest', notAdmin: true },
    { name: 'farm area', note: 'The fenced farm.', by: 'Admin', area: { corners: [[0, 0], [5, 0], [5, 5], [0, 5]], minY: 60, maxY: 70 }, pos: { x: 2, y: 64, z: 2 } }
  ];
}

const goodMerge = JSON.stringify([
  {
    from: [1, 3],
    name: 'tunnel',
    note: 'Admin orders: keep floor at y -59 (10 -59 20); deposit: when full, store everything except tools in tunnel chests (12 -59 30).'
  }
]);

test('a merged set is used only when every check passes', () => {
  const notes = tidyNotesFixture();
  const good = applyTidy(notes, `Here you go:\n${goodMerge}`);
  assert.equal(good.error, undefined);
  assert.deepEqual(good.notes.map((n) => n.name), ['tunnel', 'quarry', 'guest farm', 'farm area']);
  assert.deepEqual(good.notes[0].pos, { x: 10, y: -59, z: 20 });
  assert.equal(good.notes[0].by, 'Admin');
  assert.equal(good.notes[0].notAdmin, undefined);
  assert.deepEqual(good.merges, [{ name: 'tunnel', from: ['tunnel floor', 'tunnel deposit'] }]);
  assert.deepEqual(applyTidy(notes, '[]').merges, []);

  const turnedDown = [
    ['not JSON', 'sure, I merged them'],
    ['a dropped order', JSON.stringify([{ from: [1, 3], name: 'tunnel', note: 'Keep the floor at y -59, spot 10 -59 20, 12 -59 30.' }])],
    ['a dropped number', JSON.stringify([{ from: [1, 3], name: 'tunnel', note: 'Admin orders: keep floor at y -59 (10 -59 20); deposit: when full, store everything except tools in tunnel chests.' }])],
    ['mixed authority', JSON.stringify([{ from: [2, 4], name: 'quarry', note: 'Stone goes in the chest by the quarry. Guest likes the wheat farm.' }])],
    ['an unknown id', JSON.stringify([{ from: [1, 9], name: 'x', note: 'y' }])],
    ['an id used twice', JSON.stringify([{ from: [1, 3], name: 'a', note: JSON.parse(goodMerge)[0].note }, { from: [3, 2], name: 'b', note: 'c' }])],
    ['a single note rewritten', JSON.stringify([{ from: [2], name: 'quarry', note: 'Stone, quarry chest.' }])],
    ['a clashing name', JSON.stringify([{ from: [1, 3], name: 'Quarry', note: JSON.parse(goodMerge)[0].note }])],
    ['longer than before', JSON.stringify([{ from: [1, 3], name: 'tunnel', note: `${JSON.parse(goodMerge)[0].note} ${'more words '.repeat(20)}` }])]
  ];
  for (const [why, reply] of turnedDown) assert.ok(applyTidy(notes, reply).error, why);
  const twoAreas = [...notes, { name: 'pen area', note: 'The pen.', by: 'Admin', area: notes[4].area, pos: { x: 3, y: 64, z: 3 } }];
  assert.match(applyTidy(twoAreas, JSON.stringify([{ from: [5, 6], name: 'farm', note: 'The fenced farm. The pen. 3 64 3' }])).error, /two areas/);
});

test('the tidy is due only with many notes or long ones, and at most once a day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-tidy-'));
  try {
    const few = tidyNotesFixture();
    const many = Array.from({ length: TIDY_NOTES + 1 }, (_, i) => ({ name: `spot ${i}`, note: 'a place' }));
    const long = [{ name: 'one', note: 'x'.repeat(TIDY_CHARS) }];
    assert.equal(tidyDue(few, { dir }), false);
    assert.equal(tidyDue(many, { dir }), true);
    assert.equal(tidyDue(long, { dir }), true);
    writeFileSync(join(dir, 'last-tidy.json'), JSON.stringify({ at: new Date(Date.now() - 3600000).toISOString() }));
    assert.equal(tidyDue(many, { dir }), false);
    assert.equal(tidyDue(many, { dir, now: Date.now() + TIDY_EVERY_MS }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tidy backs the old notes up, applies a good merge, logs it, keeps ten backups and waits a day', async () => {
  const { path, cleanup } = tempPath();
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-backups-'));
  try {
    const memory = new Memory(path);
    memory.notes = [...tidyNotesFixture(), ...Array.from({ length: 17 }, (_, i) => ({ name: `spot ${i}`, note: `place number ${i}` }))];
    memory.save();
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `memory-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.json`), '[]');
    const asked = [];
    const logged = [];
    const now = new Date('2026-11-15T10:00:00.000Z');
    const merges = await tidyNotes(memory, { ask: async (request) => (asked.push(request), goodMerge), dir, now, log: (line) => logged.push(line) });
    assert.deepEqual(merges, [{ name: 'tunnel', from: ['tunnel floor', 'tunnel deposit'] }]);
    assert.equal(asked.length, 1);
    assert.match(asked[0].system, /one note per place or task/);
    assert.match(asked[0].messages[0].content, /^<notes>\n\[\{"id":1,"name":"tunnel floor",.*"admin":true,"by":"Admin","at":"10 -59 20"\}/);
    assert.match(asked[0].messages[0].content, /"id":4,"name":"guest farm","note":"Guest likes the wheat farm\.","admin":false,"by":"Guest"/);
    assert.equal(new Memory(path).notes.length, 21);
    const backups = readdirSync(dir).filter((f) => f.startsWith('memory-')).sort();
    assert.equal(backups.length, 10);
    assert.equal(backups.at(-1), 'memory-2026-11-15T10-00-00-000Z.json');
    assert.equal(JSON.parse(readFileSync(join(dir, backups.at(-1)), 'utf8')).length, 22);
    assert.deepEqual(logged, ['[memory] tidied 22 notes into 21: "tunnel floor" + "tunnel deposit" into "tunnel"']);
    memory.notes.push({ name: 'one more', note: 'x' });
    assert.equal(await tidyNotes(memory, { ask: async () => goodMerge, dir, now: new Date(now.getTime() + 3600000) }), null);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tidy whose answer fails a check, or that the notes changed under, changes nothing', async () => {
  for (const kind of ['bad answer', 'changed']) {
    const { path, cleanup } = tempPath();
    const dir = mkdtempSync(join(tmpdir(), 'cubehand-backups-'));
    try {
      const memory = new Memory(path);
      memory.notes = [...tidyNotesFixture(), ...Array.from({ length: 17 }, (_, i) => ({ name: `spot ${i}`, note: `place number ${i}` }))];
      memory.save();
      const before = JSON.stringify(memory.notes);
      const logged = [];
      const ask = async () => {
        if (kind === 'changed') {
          memory.remember({ name: 'new spot', note: 'saved while asking' });
          return goodMerge;
        }
        return JSON.stringify([{ from: [1, 3], name: 'tunnel', note: 'Keep the floor level.' }]);
      };
      assert.equal(await tidyNotes(memory, { ask, dir, log: (line) => logged.push(line) }), null, kind);
      if (kind === 'bad answer') assert.equal(JSON.stringify(new Memory(path).notes), before);
      else assert.equal(new Memory(path).notes.length, 23);
      assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('memory-')), [], kind);
      assert.match(logged[0], kind === 'changed' ? /changed while they were being tidied/ : /^\[memory\] left the notes as they are: the merge into "tunnel" was turned down/, kind);
      assert.equal(tidyDue(memory.notes, { dir }), false, kind);
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a tidy stopped by a player's job is not counted as the day's try", async () => {
  const { path, cleanup } = tempPath();
  const dir = mkdtempSync(join(tmpdir(), 'cubehand-backups-'));
  try {
    const memory = new Memory(path);
    memory.notes = Array.from({ length: 21 }, (_, i) => ({ name: `spot ${i}`, note: `place ${i}` }));
    const controller = new AbortController();
    const ask = async () => {
      controller.abort('player');
      throw new Error('Request was aborted.');
    };
    await assert.rejects(tidyNotes(memory, { ask, dir, signal: controller.signal }), /aborted/);
    assert.equal(tidyDue(memory.notes, { dir }), true);
    assert.equal(memory.notes.length, 21);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
