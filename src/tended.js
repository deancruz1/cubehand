import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// Plenty for a few bases. The oldest of a kind goes first once it's full.
const MAX_PER_KIND = 32;
const KINDS = ['fields', 'pens'];
// What limits a place to one kind of crop or animal.
const ONLY = { fields: 'crop', pens: 'animal' };

function boxOf(e) {
  const x2 = e.x2 ?? e.x;
  const y2 = e.y2 ?? e.y;
  const z2 = e.z2 ?? e.z;
  return {
    min: { x: Math.min(e.x, x2), y: Math.min(e.y, y2), z: Math.min(e.z, z2) },
    max: { x: Math.max(e.x, x2), y: Math.max(e.y, y2), z: Math.max(e.z, z2) }
  };
}

const axes = ['x', 'y', 'z'];
const sameBox = (a, b) => axes.every((k) => a.min[k] === b.min[k] && a.max[k] === b.max[k]);
const inside = (a, b) => axes.every((k) => a.min[k] >= b.min[k] && a.max[k] <= b.max[k]);
const overlaps = (a, b) => axes.every((k) => a.min[k] <= b.max[k] && a.max[k] >= b.min[k]);
const sameDimension = (a, b) => (a ?? null) === (b ?? null);

// A field as the store keeps it, from the corners of a box.
export function fieldRecord(min, max, dimension, crop = null) {
  const field = { x: min.x, y: min.y, z: min.z, x2: max.x, y2: max.y, z2: max.z, dimension: dimension ?? null };
  if (crop) field.crop = crop;
  return field;
}

// The fields she was asked to harvest or plant and the pens she was asked to tend, saved to a file
// so the chores that look after them carry on after a restart. A field: x y z x2 y2 z2, crop and
// dimension. A pen is what penRecord in husbandry.js makes: x y z (x2 y2 z2 for a box, else the
// animals around that spot), animal, keep, dimension, and lastTended and nextAt, which the pen
// chore changes in place before calling save().
export class Tended {
  // With no path it lives only in memory.
  constructor(path = null) {
    this.path = path;
    const saved = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    this.places = Object.fromEntries(KINDS.map((k) => [k, saved[k] ?? []]));
  }

  save() {
    if (!this.path) return;
    // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.places));
    renameSync(`${this.path}.tmp`, this.path);
  }

  // One with the same corners is replaced, and one inside a place already kept for the same crop
  // or animal (or for all of them) is dropped. Returns 'added', 'replaced' or null.
  add(kind, entry) {
    const list = this.places[kind];
    const e = { ...entry, dimension: entry.dimension ?? null };
    const box = boxOf(e);
    const only = ONLY[kind];
    const same = list.findIndex((o) => sameDimension(o.dimension, e.dimension) && sameBox(boxOf(o), box));
    if (same >= 0) {
      if (JSON.stringify(list[same]) === JSON.stringify(e)) return null;
      list[same] = e;
      this.save();
      return 'replaced';
    }
    if (list.some((o) => sameDimension(o.dimension, e.dimension) && (o[only] == null || o[only] === e[only]) && inside(box, boxOf(o)))) return null;
    list.push(e);
    while (list.length > MAX_PER_KIND) list.shift();
    this.save();
    return 'added';
  }

  // Drops every place of the kind overlapping the box (x y z x2 y2 z2, and dimension). Returns how
  // many went.
  remove(kind, area) {
    const box = boxOf(area);
    const before = this.places[kind].length;
    this.places[kind] = this.places[kind].filter((o) => !(sameDimension(o.dimension, area.dimension) && overlaps(boxOf(o), box)));
    const removed = before - this.places[kind].length;
    if (removed) this.save();
    return removed;
  }

  // The places of the kind in that dimension, as kept (so changes to them are saved by save()).
  list(kind, dimension) {
    return this.places[kind].filter((o) => sameDimension(o.dimension, dimension));
  }
}
