import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// Enough for dozens of large builds. The oldest entries go first once it's full.
const MAX_ENTRIES = 100000;

// Blocks the bot placed itself, saved to a file, so it may break them again later (like its
// own crafting table) even when that kind of block is protected.
export class PlacedLog {
  constructor(path = 'placed.json') {
    this.path = path;
    this.blocks = new Map(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
    this.timer = null;
  }

  key(pos) {
    return `${pos.x},${pos.y},${pos.z}`;
  }

  add(name, pos) {
    const key = this.key(pos);
    this.blocks.delete(key);
    this.blocks.set(key, name);
    if (this.blocks.size > MAX_ENTRIES) this.blocks.delete(this.blocks.keys().next().value);
    this.saveSoon();
  }

  // Only counts if the same kind of block is still there.
  has(pos, name) {
    return this.blocks.get(this.key(pos)) === name;
  }

  remove(pos) {
    if (this.blocks.delete(this.key(pos))) this.saveSoon();
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
      writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.blocks]));
      renameSync(`${this.path}.tmp`, this.path);
    }, 2000);
    this.timer.unref?.();
  }
}
