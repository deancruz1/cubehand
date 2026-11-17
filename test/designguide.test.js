import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideFor, checklistText, CHECKLIST, STRUCTURES, STYLES, TOPICS, METHOD } from '../src/designguide.js';
import { kitInfo } from '../src/actions/kits.js';
import { designGuide } from '../src/actions/design.js';
import { expandParts } from '../src/actions/build.js';

const require = createRequire(import.meta.url);
const blocks = createRequire(require.resolve('mineflayer'))('minecraft-data')('26.1').blocksByName;

// The longest a guide may get, so fetching it stays cheap.
const MAX_GUIDE = 6000;
const TRIALS = fileURLToPath(new URL('../docs/renders/trial/', import.meta.url));
const TRIAL_2 = fileURLToPath(new URL('../docs/renders/trial-2/', import.meta.url));

// Block names in a mix like "85%stone_bricks,15%cobblestone" or a plain name.
const namesIn = (text) => text.split(',').map((p) => p.replace(/^\s*\d+(\.\d+)?%/, '').replace(/\[.*$/, '').trim());

// Words with underscores in the guide that are tool or field names, not blocks.
const NOT_BLOCKS = new Set(['preview_structure', 'build_structure', 'view_area', 'design_guide', 'cut_above', 'dry_run']);

test('every structure and style gives a guide under 6,000 characters with the method, topics and kits', () => {
  for (const structure of Object.keys(STRUCTURES)) {
    for (const style of Object.keys(STYLES)) {
      const text = guideFor({ structure, style });
      assert.ok(text.length <= MAX_GUIDE, `${structure}/${style} is ${text.length} characters`);
      assert.match(text, /Method:/);
      assert.match(text, /Checklist/);
      assert.match(text, /Ready-made details:/);
      for (const topic of STRUCTURES[structure].topics) assert.ok(text.includes(`${TOPICS[topic].title}:`), `${structure} lacks ${topic}`);
      for (const [kind] of STRUCTURES[structure].kits) assert.ok(text.includes(kitInfo(kind).line), `${structure} lacks kit line for ${kind}`);
    }
  }
});

test('every block name in the palettes is in the game, and every pitched style has roof and frame roles', () => {
  const missing = [];
  for (const [key, style] of Object.entries(STYLES)) {
    assert.ok(style.palettes.length >= 2, `${key} needs at least 2 palettes`);
    for (const p of style.palettes) {
      if (!style.flat) {
        assert.ok(p.roles.roof, `${key}/${p.label} lacks roof`);
        assert.ok(p.roles.trim, `${key}/${p.label} lacks trim for roof edge`);
      }
      for (const text of Object.values(p.roles)) {
        for (const name of namesIn(text)) if (!blocks[name]) missing.push(`${key}: ${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every block name written in the guide text is in the game', () => {
  const missing = new Set();
  const texts = [
    ...METHOD,
    ...CHECKLIST,
    ...Object.values(TOPICS).flatMap((t) => t.lines),
    ...Object.values(STRUCTURES).flatMap((s) => s.lines),
    ...Object.values(STYLES).flatMap((s) => s.lines)
  ];
  for (const text of texts) {
    for (const word of text.match(/[a-z]+(?:_[a-z]+)+/g) ?? []) if (!NOT_BLOCKS.has(word) && !blocks[word]) missing.add(word);
  }
  assert.deepEqual([...missing], []);
});

test('palettes only use roles the plan knows', () => {
  const roles = ['wall', 'frame', 'trim', 'roof', 'foundation', 'floor', 'glass', 'light', 'accent', 'accent2'];
  for (const style of Object.values(STYLES)) {
    for (const p of style.palettes) for (const role of Object.keys(p.roles)) assert.ok(roles.includes(role), role);
  }
});

test('structures and styles are found by name, alias or a word of the request', () => {
  assert.match(guideFor({ structure: 'watchtower' }), /For a tower:/);
  assert.match(guideFor({ structure: 'market stall' }), /For a shop:/);
  assert.match(guideFor({ structure: 'storehouse' }), /For a barn:/);
  assert.match(guideFor({ structure: 'wall and gate' }), /For a wall:/);
  assert.match(guideFor({ structure: 'small log cabin' }), /For a cabin:/);
  assert.match(guideFor({ style: 'Viking' }), /The nordic style:/);
});

test('an unknown structure or style falls back to the general guide and lists what exists', () => {
  const text = guideFor({ structure: 'spaceship', style: 'steampunk' });
  assert.ok(text.length <= MAX_GUIDE);
  assert.match(text, /no section for structure "spaceship"/);
  assert.match(text, /Structures: house, cabin, tower/);
  assert.match(text, /no style "steampunk"/);
  assert.match(text, /Styles: rustic, medieval/);
  assert.match(text, /Other builds:/);
  assert.equal(guideFor({}), guideFor({ structure: 'other', style: 'other' }));
  assert.doesNotMatch(guideFor({}), /no section|no style/);
});

test('the checklist is exported for the preview and covers roof frame, lights, plants and conditional openings', () => {
  assert.ok(CHECKLIST.length >= 10);
  const text = checklistText();
  for (const line of CHECKLIST) assert.ok(text.includes(line));
  assert.match(text, /framed in another on the eaves, gable ends and ridge/);
  assert.match(text, /Light:/);
  assert.match(text, /Surroundings:/);
  assert.match(text, /Windows, on a building:/);
  assert.match(text, /Entrance, where there is one:/);
  assert.ok(!guideFor({ structure: 'house' }).includes(text));
});

test('design_guide returns the guide as an ok result', async () => {
  const result = await designGuide({}, { structure: 'bridge', style: 'medieval' });
  assert.equal(result.ok, true);
  assert.equal(result.message, guideFor({ structure: 'bridge', style: 'medieval' }));
});

test('every trial plan expands without error', () => {
  for (const dir of [TRIALS, TRIAL_2]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const plan = JSON.parse(readFileSync(join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
      const out = expandParts(plan.parts, plan.blocks, { palette: plan.palette, mirror: plan.mirror });
      assert.ok(out.length > 0, file);
    }
  }
});
