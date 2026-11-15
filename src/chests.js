import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// Plenty for a few bases. The longest unseen go first once it's full.
const MAX_CHESTS = 500;

const isStorageName = (name) => name === 'chest' || name === 'trapped_chest' || name === 'barrel' || name.endsWith('shulker_box');

// One key for both halves of a double chest: the half with the lowest x, then z.
export function chestKey(parts, dim) {
  const [p] = [...parts].sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  return `${dim ?? ''}:${p.x},${p.y},${p.z}`;
}

export function partsDistance(parts, here) {
  return Math.min(...parts.map((p) => Math.hypot(p.x + 0.5 - here.x, p.y + 0.5 - here.y, p.z + 0.5 - here.z)));
}

// What the bot saw inside each chest, barrel or shulker box it opened, with when it looked and
// the labels on it, saved to a file so it survives restarts.
export class ChestIndex {
  constructor(path = 'chests.json') {
    this.path = path;
    this.chests = new Map(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
    this.timer = null;
  }

  // items is a Map of name to count, free the number of empty slots.
  record({ dim, name, parts, items, free, labels }, now = Date.now()) {
    const plain = parts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const old = this.find(plain[0], dim) ?? (plain[1] && this.find(plain[1], dim));
    for (const p of plain) this.remove(p, dim, false);
    const key = chestKey(plain, dim);
    this.chests.set(key, {
      dim: dim ?? null,
      name,
      parts: plain,
      items: [...items].sort((a, b) => b[1] - a[1]),
      free,
      labels: labels ?? old?.labels ?? [],
      seen: now
    });
    while (this.chests.size > MAX_CHESTS) this.chests.delete(this.chests.keys().next().value);
    this.saveSoon();
    return key;
  }

  find(pos, dim) {
    for (const [key, c] of this.chests) {
      if (c.dim === (dim ?? null) && c.parts.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z)) return { key, ...c };
    }
    return null;
  }

  remove(pos, dim, save = true) {
    const found = this.find(pos, dim);
    if (!found) return false;
    this.chests.delete(found.key);
    if (save) this.saveSoon();
    return true;
  }

  list(dim) {
    return [...this.chests].filter(([, c]) => c.dim === (dim ?? null)).map(([key, c]) => ({ key, ...c }));
  }

  // Drops chests within range of origin that are gone. getName(pos) returns null when not loaded.
  prune(dim, origin, range, getName) {
    let dropped = 0;
    for (const c of this.list(dim)) {
      if (partsDistance(c.parts, origin) > range) continue;
      const name = getName(c.parts[0]);
      if (name !== null && name !== undefined && !isStorageName(name)) {
        this.chests.delete(c.key);
        dropped++;
      }
    }
    if (dropped) this.saveSoon();
    return dropped;
  }

  save() {
    // Written beside the file and then swapped in, so a crash mid-write can't leave half a file.
    writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.chests]));
    renameSync(`${this.path}.tmp`, this.path);
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 2000);
    this.timer.unref?.();
  }
}

export function agoText(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function contentsText(entry, now = Date.now(), max = 8) {
  const ago = agoText(now - entry.seen);
  if (!entry.items.length) return `seen ${ago}: empty`;
  const shown = entry.items.slice(0, max).map(([name, count]) => `${name} ${count}`);
  const more = entry.items.length > max ? `, +${entry.items.length - max} more kinds` : '';
  return `seen ${ago}: ${shown.join(', ')}${more}`;
}

// The nearest known container holding any of the wanted items, skipping the tried ones and
// trapped chests (opening one sends a redstone signal).
export function pickSource(entries, wanted, here, tried = new Set(), range = Infinity) {
  let best = null;
  let bestDistance = Infinity;
  for (const e of entries) {
    if (e.name === 'trapped_chest' || tried.has(e.key) || !e.items.some(([name]) => wanted.has(name))) continue;
    const d = partsDistance(e.parts, here);
    if (d <= range && d < bestDistance) {
      best = e;
      bestDistance = d;
    }
  }
  return best;
}

const FOOD = /^(cooked_\w+|bread|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|potato|baked_potato|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|cake|honey_bottle|dried_kelp|beef|porkchop|chicken|mutton|rabbit|cod|salmon|tropical_fish|chorus_fruit)$/;
const JUNK_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']);

export function isGoodFood(name, isFood) {
  return !JUNK_FOOD.has(name) && (isFood ? isFood(name) : FOOD.test(name));
}

const TOOL = /_(pickaxe|axe|shovel|hoe)$|^(shears|flint_and_steel|fishing_rod|brush|spyglass|compass|recovery_compass|clock|lead|filled_map)$/;
const WEAPON = /_sword$|^(bow|crossbow|trident|mace|arrow|spectral_arrow|tipped_arrow|shield)$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(elytra|totem_of_undying)$/;

// Why stash keeps an item by default, or null to put it away.
export function keepReason(name, isFood) {
  if (TOOL.test(name)) return 'tools';
  if (WEAPON.test(name)) return 'weapons';
  if (ARMOR.test(name)) return 'armor';
  if (isGoodFood(name, isFood)) return 'food';
  if (name === 'torch' || name === 'soul_torch') return 'torches';
  if (name.endsWith('bucket')) return 'buckets';
  return null;
}

// Item kinds and the words players write on signs for them, most specific first.
const CATEGORIES = [
  { name: 'ores', words: ['ore', 'ores', 'mineral', 'minerals', 'metal', 'metals', 'ingot', 'ingots', 'gem', 'gems', 'valuables', 'mining'],
    test: (n) => /_ore$|^raw_|_ingot$|_nugget$|^(coal|charcoal|diamond|emerald|lapis_lazuli|redstone|quartz|amethyst_shard|ancient_debris|netherite_scrap)$|^(coal|iron|gold|copper|diamond|emerald|lapis|redstone|netherite|raw_iron|raw_gold|raw_copper)_block$/.test(n) },
  { name: 'fuel', words: ['fuel', 'fuels', 'coal', 'smelting', 'furnace'], test: (n) => /^(coal|charcoal|coal_block|blaze_rod)$/.test(n) },
  { name: 'wood', words: ['wood', 'woods', 'log', 'logs', 'plank', 'planks', 'lumber', 'timber', 'tree', 'trees'],
    test: (n) => /_(log|wood|stem|hyphae|planks)$|^(stick|bamboo_block)$/.test(n) },
  { name: 'stone', words: ['stone', 'stones', 'cobble', 'cobblestone', 'rock', 'rocks', 'masonry'],
    test: (n) => /^(stone|cobblestone|mossy_cobblestone|cobbled_deepslate|deepslate|andesite|diorite|granite|tuff|calcite|blackstone|basalt|smooth_basalt|netherrack|end_stone|sandstone|red_sandstone|obsidian|dripstone_block|bricks)$|_stone$|_bricks$/.test(n) },
  { name: 'dirt', words: ['dirt', 'sand', 'gravel', 'earth', 'soil', 'mud', 'clay'],
    test: (n) => /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|sand|red_sand|gravel|clay|clay_ball|soul_sand|soul_soil|moss_block)$/.test(n) },
  { name: 'food', words: ['food', 'foods', 'kitchen', 'meat', 'meats', 'snacks', 'pantry', 'fridge'], test: (n, isFood) => isGoodFood(n, isFood) },
  { name: 'farm', words: ['farm', 'farming', 'crop', 'crops', 'seed', 'seeds', 'plant', 'plants', 'garden', 'sapling', 'saplings'],
    test: (n) => /_seeds$|_sapling$|_propagule$|^(wheat|sugar_cane|pumpkin|melon|cactus|bamboo|cocoa_beans|bone_meal|nether_wart|kelp|hay_block)$/.test(n) },
  { name: 'mob', words: ['mob', 'mobs', 'drop', 'drops', 'loot', 'monster', 'monsters'],
    test: (n) => /^(rotten_flesh|bone|string|spider_eye|gunpowder|ender_pearl|slime_ball|feather|leather|blaze_rod|ghast_tear|phantom_membrane|ink_sac|rabbit_hide|magma_cream)$/.test(n) },
  { name: 'junk', words: ['junk', 'trash', 'garbage', 'rubbish', 'waste'],
    test: (n) => /^(rotten_flesh|poisonous_potato|dead_bush|spider_eye|bone|string|feather|wheat_seeds|flint)$/.test(n) },
  { name: 'redstone', words: ['redstone', 'circuits', 'circuit'],
    test: (n) => /^(redstone|repeater|comparator|piston|sticky_piston|observer|hopper|dropper|dispenser|lever|redstone_torch|redstone_block|daylight_detector|target|tripwire_hook)$|_button$|_pressure_plate$|rail$/.test(n) },
  { name: 'gear', words: ['tool', 'tools', 'weapon', 'weapons', 'armor', 'armour', 'gear', 'equipment'],
    test: (n) => TOOL.test(n) || WEAPON.test(n) || ARMOR.test(n) },
  { name: 'building', words: ['building', 'build', 'blocks', 'construction'],
    test: (n) => /_(planks|bricks|slab|stairs|wall|fence|glass|glass_pane|concrete|terracotta|wool)$|^(glass|cobblestone|stone|bricks)$/.test(n) }
];
const CATEGORY_WORDS = new Map(CATEGORIES.map((c) => [c.name, new Set(c.words)]));
const CATCH_ALL = new Set(['misc', 'miscellaneous', 'other', 'others', 'overflow', 'mixed', 'random', 'general', 'stuff', 'extra', 'extras', 'anything', 'spare']);
const GENERIC_TOKENS = new Set(['block', 'raw', 'item']);

export function itemCategories(name, isFood) {
  return CATEGORIES.filter((c) => c.test(name, isFood)).map((c) => c.name);
}

// A word on a sign names the item: its full name or one part of it, singular or plural.
function namesItem(word, item) {
  if (word === item) return true;
  return item.split('_').some((t) => !GENERIC_TOKENS.has(t) && (word === t || word === `${t}s` || word === `${t}es` || t === `${word}s`));
}

// 'fits' when a label on the container fits the item, 'open' when it has no label or a
// catch-all one ("misc"), and 'other' when it is labeled for something else.
export function labelFit(labels, item, isFood) {
  if (!labels?.length) return 'open';
  const cats = itemCategories(item, isFood);
  let catchAll = false;
  for (const label of labels) {
    const frame = /^item frame showing (\S+)$/.exec(label);
    if (frame) {
      const shown = frame[1];
      if (shown === item || (cats.length && itemCategories(shown, isFood)[0] === cats[0])) return 'fits';
      continue;
    }
    const words = label.replace(/^sign /, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((w) => CATCH_ALL.has(w))) catchAll = true;
    if (words.some((w) => namesItem(w, item) || cats.some((c) => CATEGORY_WORDS.get(c).has(w)))) return 'fits';
  }
  return catchAll ? 'open' : 'other';
}

// Where stash tries to put an item, best first: containers that already hold it (unless
// labeled for something else), then ones whose label fits, then unlabeled ones, each nearest
// first. containers: [{ key, parts, labels, items }] with items as [name, count] pairs or null.
export function stashTargets(item, containers, here, isFood) {
  const tiers = [[], [], []];
  for (const c of containers) {
    const fit = labelFit(c.labels, item, isFood);
    if (fit === 'other') continue;
    const holds = Boolean(c.items?.some(([name]) => name === item));
    tiers[holds ? 0 : fit === 'fits' ? 1 : 2].push(c);
  }
  const byDistance = (a, b) => partsDistance(a.parts, here) - partsDistance(b.parts, here);
  return tiers.flatMap((t) => t.sort(byDistance));
}
