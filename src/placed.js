import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// Enough for dozens of large builds. The oldest entries go first once it's full.
const MAX_ENTRIES = 100000;

// Blocks the bot placed itself, saved to a file, so it may break them again later (like its
// own crafting table) even when that kind of block is protected. Filler (rock she put back where
// she dug ore out of a tunnel wall) is marked: digging treats it as terrain.
export class PlacedLog {
  constructor(path = 'placed.json') {
    this.path = path;
    const list = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    this.blocks = new Map(list);
    this.fill = new Set(list.filter((e) => e[2] === 'fill').map((e) => e[0]));
    this.timer = null;
  }

  key(pos) {
    return `${pos.x},${pos.y},${pos.z}`;
  }

  add(name, pos) {
    const key = this.key(pos);
    this.blocks.delete(key);
    this.fill.delete(key);
    this.blocks.set(key, name);
    if (this.blocks.size > MAX_ENTRIES) {
      const oldest = this.blocks.keys().next().value;
      this.blocks.delete(oldest);
      this.fill.delete(oldest);
    }
    this.saveSoon();
  }

  // Only counts if the same kind of block is still there.
  has(pos, name) {
    return this.blocks.get(this.key(pos)) === name;
  }

  markFill(pos) {
    const key = this.key(pos);
    if (!this.blocks.has(key)) return;
    this.fill.add(key);
    this.saveSoon();
  }

  isFill(pos, name) {
    return this.has(pos, name) && this.fill.has(this.key(pos));
  }

  remove(pos) {
    this.fill.delete(this.key(pos));
    if (this.blocks.delete(this.key(pos))) this.saveSoon();
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
      writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.blocks].map(([k, n]) => (this.fill.has(k) ? [k, n, 'fill'] : [k, n]))));
      renameSync(`${this.path}.tmp`, this.path);
    }, 2000);
    this.timer.unref?.();
  }
}

const SCAFFOLD_MAX = 500;
const SCAFFOLD_TRIES = 3;
const SCAFFOLD_RETRY_MS = 24 * 3600000;
const SCAFFOLD_MAX_AGE = 7 * 24 * 3600000;

// Grass grows over a dirt block, and it is still the same block.
export function sameScaffold(name, now) {
  return now === name || (name === 'dirt' && now === 'grass_block');
}

// Blocks her walks put down to climb or bridge, kept until they come down again, saved to a file
// so a restart doesn't forget them. Each entry: x, y, z, name, dim (the dimension), at (when),
// around (the names of the six blocks next to it then, in the order movement.js's FACES6 has
// them), tries and next (when to try taking it down again).
export class ScaffoldLog {
  constructor(path = 'scaffold.json') {
    this.path = path;
    const list = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    this.blocks = new Map(list.map((e) => [this.key(e, e.dim), e]));
    this.timer = null;
  }

  key(pos, dim) {
    return `${dim ?? ''}|${pos.x},${pos.y},${pos.z}`;
  }

  add(name, pos, dim, around = []) {
    const key = this.key(pos, dim);
    this.blocks.delete(key);
    this.blocks.set(key, { x: pos.x, y: pos.y, z: pos.z, name, dim, at: Date.now(), around, tries: 0, next: 0 });
    if (this.blocks.size > SCAFFOLD_MAX) this.blocks.delete(this.blocks.keys().next().value);
    this.saveSoon();
  }

  get(pos, dim) {
    return this.blocks.get(this.key(pos, dim)) ?? null;
  }

  // Only counts if her block is still there.
  has(pos, name, dim) {
    const e = this.get(pos, dim);
    return Boolean(e && sameScaffold(e.name, name));
  }

  remove(pos, dim) {
    if (this.blocks.delete(this.key(pos, dim))) this.saveSoon();
  }

  // Drops pos and her blocks straight under it, for a pillar that has to stay up.
  removeColumn(pos, dim) {
    for (let y = pos.y; this.get({ x: pos.x, y, z: pos.z }, dim); y--) this.blocks.delete(this.key({ x: pos.x, y, z: pos.z }, dim));
    this.saveSoon();
  }

  // The block at pos is now name: the entry goes when that isn't hers any more.
  check(pos, dim, name) {
    const e = this.get(pos, dim);
    if (e && !sameScaffold(e.name, name)) this.remove(pos, dim);
  }

  // Taking it down failed: another try a day later. After a few it is let go, with her blocks
  // under it, which hold it up.
  failed(pos, dim) {
    const e = this.get(pos, dim);
    if (!e) return;
    e.tries = (e.tries ?? 0) + 1;
    e.next = Date.now() + SCAFFOLD_RETRY_MS;
    if (e.tries >= SCAFFOLD_TRIES) this.removeColumn(pos, dim);
    this.saveSoon();
  }

  // The entries in dim still standing. nameAt(entry) gives the block there now, or null when it
  // isn't loaded (kept as it was). Ones whose block changed, or a week old, are dropped.
  standing(dim, nameAt) {
    const out = [];
    let dropped = false;
    for (const [key, e] of this.blocks) {
      if (Date.now() - e.at > SCAFFOLD_MAX_AGE) {
        this.blocks.delete(key);
        dropped = true;
        continue;
      }
      if ((e.dim ?? null) !== (dim ?? null)) continue;
      const name = nameAt(e);
      if (name != null && !sameScaffold(e.name, name)) {
        this.blocks.delete(key);
        dropped = true;
        continue;
      }
      out.push(e);
    }
    if (dropped) this.saveSoon();
    return out;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.blocks.values()]));
    renameSync(`${this.path}.tmp`, this.path);
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 2000);
    this.timer.unref?.();
  }
}
