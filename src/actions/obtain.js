import { Vec3 } from 'vec3';
import { ok, fail, posText } from './util.js';
import { takeItems, countItems, isPickable, lookInUnknown } from './containers.js';
import { craft, carriedItems } from './crafting.js';
import { smelt, smeltOutput, fuelValue, pickFuel, furnaceKind } from './furnace.js';
import { mine, chopTree, isTerrain, isBuildTerrain, isLogName, nextToBuild, treeLogTest, treeAt, mineableBlocks } from './mining.js';
import { findNearest, matchesBlockName, buriedText } from './blocks.js';
import { partsDistance } from '../chests.js';

const MAX_COUNT = 256;
const MAX_ITEMS = 12;
// An iron pickaxe from nothing goes ten deep: ingot, raw iron, stone pickaxe, cobblestone,
// wooden pickaxe, sticks, planks, logs.
const MAX_DEPTH = 10;
// Option lookups and acquisitions per plan, so a big recipe tree can't hang the bot.
const MAX_NODES = 5000;
const MAX_TRIES = 3;
const MAX_PLAN_STEPS = 30;
const MAX_ROUNDS = 6;
const MAX_RUN_STEPS = 40;
// mine and chop_tree search this far, take_items twice as far.
const GATHER_RANGE = 32;
const STORE_RANGE = 64;
const LOGS_PER_TREE = 5;
const MINE_MAX = 64;
const SMELT_MAX = 64;
const FURNACES = ['furnace', 'blast_furnace', 'smoker'];
// Between options that cost the same, gathering comes before smelting and smelting before
// crafting, so an ingot comes from ore before anyone's iron block gets broken up.
const KIND_ORDER = { gather: 0, smelt: 1, craft: 2 };
const BUDGET = new Error('budget');

const get = (m, k) => m.get(k) ?? 0;
function add(m, k, n) {
  const v = get(m, k) + n;
  if (v) m.set(k, v);
  else m.delete(k);
}

function cloneState(s) {
  return {
    ...s,
    inv: new Map(s.inv),
    store: new Map(s.store),
    reserved: new Map(s.reserved),
    takes: new Map(s.takes),
    gathered: new Map(s.gathered),
    steps: [...s.steps],
    missing: [...s.missing]
  };
}

const free = (s, name) => get(s.inv, name) - get(s.reserved, name);

function consume(s, uses) {
  for (const [name, n] of uses) {
    add(s.reserved, name, -n);
    add(s.inv, name, -n);
  }
}

// Plays the steps through from the start inventory to check each one has what it needs.
function replay(steps, start, table) {
  const inv = new Map(start);
  for (const st of steps) {
    if (st.tools && !st.tools.some((t) => get(inv, t) > 0)) return false;
    if (st.needsTable && !table && !st.setsTable) return false;
    for (const [n, c] of st.uses) {
      if (get(inv, n) < c) return false;
      add(inv, n, -c);
    }
    for (const [n, c] of st.gives) add(inv, n, c);
    if (st.setsTable) table = true;
  }
  return true;
}

const usesKey = (st) => st.uses.map(([n]) => n).sort().join(',');

function sameKind(a, b) {
  if (a.action !== b.action || a.item !== b.item || a.setsTable || a.setsFurnace || b.setsTable || b.setsFurnace) return false;
  if (a.action === 'mine') return a.block === b.block;
  if (a.action === 'smelt') return a.input === b.input;
  if (a.action === 'craft') return usesKey(a) === usesKey(b);
  return a.action === 'chop';
}

function sumPairs(a, b) {
  const m = new Map(a);
  for (const [n, c] of b) add(m, n, c);
  return [...m];
}

function combine(a, b) {
  const count = a.count + b.count;
  if ((a.action === 'mine' && count > MINE_MAX) || (a.action === 'smelt' && count > SMELT_MAX) || (a.action === 'chop' && count > 5)) return null;
  const merged = { ...a, count, uses: sumPairs(a.uses, b.uses), gives: sumPairs(a.gives, b.gives) };
  if (a.need !== undefined) merged.need = a.need + b.need;
  return merged;
}

// Folds a later step into an earlier one of the same kind (two rounds of planks become one
// craft, two trips to the same stone become one mine) when everything still adds up.
function mergeSteps(steps, start, table) {
  let list = [...steps];
  for (let i = 1; i < list.length; i++) {
    const j = list.findIndex((o, k) => k < i && sameKind(o, list[i]));
    if (j < 0) continue;
    const merged = combine(list[j], list[i]);
    if (!merged) continue;
    const trial = list.map((o, k) => (k === j ? merged : o)).filter((_, k) => k !== i);
    if (replay(trial, start, table)) {
      list = trial;
      i--;
    }
  }
  return list;
}

function dedupe(missing) {
  const seen = new Map();
  for (const m of missing) {
    const key = `${m.item}|${m.for}|${m.reason}`;
    if (!seen.has(key) || seen.get(key).count < m.count) seen.set(key, m);
  }
  return [...seen.values()];
}

// Works out the steps to end up carrying want of item, without doing anything. world holds
// what the bot knows:
//   have, stored: Maps of item name to count (carried, and in chests it remembers)
//   recipes(name): [{ count, needs: [[name, n]], table }]
//   smeltsFrom(name): item names that smelt into name
//   gather(name): null when no natural block gives it, else { action: 'mine' | 'chop', block,
//     found, distance, tools, pos, reason }, with found 0 and a reason when there is none nearby
//   table: a crafting table nearby; furnaces: names of free furnaces nearby
//   logs: log names nearby, nearest first (for fuel); blocked: Map of 'take:x', 'craft:x',
//     'smelt:x' or 'gather:x' to why that came up short before
//   slots: { total, waste } inventory slots, and how many the carried part stacks take beyond
//     full ones; stackSize(name). Without slots, room isn't checked.
// Cheapest first: carried, then stored, then crafted or smelted from those, then gathered.
export function planObtain(world, item, want) {
  const { have, stored = new Map(), recipes, smeltsFrom = () => [], gather = () => null, blocked = new Map(), logs = [], slots = null, stackSize = () => 64 } = world;
  const optionCache = new Map();
  const memo = new Map();
  let nodes = 0;

  const tick = () => {
    if (++nodes > MAX_NODES) throw BUDGET;
  };

  function options(name) {
    if (optionCache.has(name)) return optionCache.get(name);
    const list = [];
    const g = blocked.has(`gather:${name}`) ? null : gather(name);
    if (g) list.push({ kind: 'gather', info: g });
    if (!blocked.has(`smelt:${name}`)) for (const input of smeltsFrom(name)) list.push({ kind: 'smelt', input });
    if (!blocked.has(`craft:${name}`)) for (const recipe of recipes(name)) list.push({ kind: 'craft', recipe });
    optionCache.set(name, list);
    return list;
  }

  // A rough count of the work to get n of name from the start state, only used to order options.
  function cost(name, n, depth, path) {
    tick();
    // Using up the item being made to make it (an ingot into nuggets into an ingot) gets nowhere.
    if (path.includes(name)) return Infinity;
    const carried = get(have, name);
    if (carried >= n) return 0;
    const inStore = blocked.has(`take:${name}`) ? 0 : get(stored, name);
    const left = n - carried - inStore;
    const base = inStore > 0 ? 1 : 0;
    if (left <= 0) return base;
    if (depth >= MAX_DEPTH) return Infinity;
    const key = `${name}:${left}`;
    if (memo.has(key)) return base + memo.get(key);
    const next = [...path, name];
    let best = Infinity;
    for (const o of options(name)) best = Math.min(best, optionCost(o, left, depth + 1, next));
    if (best < Infinity) memo.set(key, best);
    return base + best;
  }

  function optionCost(o, n, depth, path) {
    if (o.kind === 'gather') {
      if (!o.info.found) return Infinity;
      let c = 8 + (o.info.distance ?? 0) / 64;
      if (o.info.tools && !o.info.tools.some((t) => get(have, t) > 0)) c += Math.min(...o.info.tools.map((t) => cost(t, 1, depth, path)));
      return c;
    }
    if (o.kind === 'smelt') return 5 + cost(o.input, n, depth, path) + (world.furnaces?.length ? 0 : cost('furnace', 1, depth, path));
    const r = o.recipe;
    const times = Math.ceil(n / r.count);
    let c = 2 + (r.table && !world.table ? 1 : 0);
    for (const [ing, k] of r.needs) {
      c += cost(ing, k * times, depth, path);
      if (c === Infinity) break;
    }
    return c;
  }

  // kind 'nearby' means it exists but isn't around, which makes a better answer for the player
  // than 'none' (no source at all), 'loop', 'depth' or 'unmade' (every recipe ends in those).
  function miss(s, name, count, path, reason, kind = 'none') {
    s.missing.push({ item: name, count, for: path[path.length - 1] ?? null, reason, kind });
    return false;
  }

  // craft won't start a batch when there's no room for what comes out.
  function fits(s) {
    if (!slots) return true;
    let used = slots.waste;
    for (const [n, c] of s.inv) if (c > 0) used += Math.ceil(c / stackSize(n));
    return used <= slots.total;
  }

  const DEAD = new Set(['none', 'loop', 'depth', 'unmade']);
  const dead = (list) => list.filter((m) => DEAD.has(m.kind)).length;
  const better = (a, b) => (!b || dead(a) < dead(b) ? a : b);

  function noSource(name) {
    const why = ['take', 'gather', 'smelt', 'craft'].map((k) => blocked.get(`${k}:${name}`)).filter(Boolean);
    return why.length ? why.join('; ') : "none carried or in chests I know of, and it can't be mined, chopped, crafted or smelted";
  }

  // Makes sure n of name are free in the plan's inventory, adding steps as needed, then holds
  // them for the caller. Returns false with s.missing filled in when it can't.
  function acquire(s, name, n, depth, path) {
    tick();
    if (path.includes(name)) return miss(s, name, n, path, `making it would need ${name} itself`, 'loop');
    let short = n - free(s, name);
    if (short > 0 && !blocked.has(`take:${name}`)) {
      const t = Math.min(short, get(s.store, name));
      if (t > 0) {
        add(s.store, name, -t);
        add(s.inv, name, t);
        add(s.takes, name, t);
        short -= t;
      }
    }
    if (short <= 0) {
      add(s.reserved, name, n);
      return true;
    }
    if (depth >= MAX_DEPTH) return miss(s, name, short, path, 'it takes too many steps to make', 'depth');
    const list = options(name);
    if (!list.length) return miss(s, name, short, path, noSource(name));
    const next = [...path, name];
    const ranked = list
      .map((o) => ({ o, c: optionCost(o, short, depth + 1, next) }))
      .sort((a, b) => a.c - b.c || KIND_ORDER[a.o.kind] - KIND_ORDER[b.o.kind]);
    const tries = ranked.filter((r) => r.c < Infinity).slice(0, MAX_TRIES);
    if (!tries.length) tries.push(ranked[0]);
    let failed = null;
    for (const { o } of tries) {
      const t = cloneState(s);
      if (runOption(o, t, name, short, depth + 1, next) && free(t, name) >= n) {
        Object.assign(s, t);
        add(s.reserved, name, n);
        return true;
      }
      failed = better(t.missing.slice(s.missing.length), failed);
    }
    // When every way down only loops back or runs too deep, the item itself is the answer.
    if (failed.every((m) => m.kind === 'loop' || m.kind === 'depth' || m.kind === 'unmade')) {
      return miss(s, name, short, path, 'none carried or in chests I know of, and nothing nearby to make it from', 'unmade');
    }
    s.missing.push(...failed);
    return false;
  }

  function runOption(o, s, name, short, depth, path) {
    if (o.kind === 'craft') return planCraft(s, name, o.recipe, short, depth, path);
    if (o.kind === 'smelt') return planSmelt(s, name, o.input, short, depth, path);
    return planGather(s, name, o.info, short, depth, path);
  }

  function planCraft(s, name, r, short, depth, path) {
    const times = Math.ceil(short / r.count);
    const made = times * r.count;
    for (const [ing, k] of r.needs) if (!acquire(s, ing, k * times, depth, path)) return false;
    const setsTable = r.table && !s.table;
    if (setsTable && !acquire(s, 'crafting_table', 1, depth, path)) return false;
    const uses = r.needs.map(([ing, k]) => [ing, k * times]);
    if (setsTable) {
      uses.push(['crafting_table', 1]);
      s.table = true;
    }
    // The first batch comes out while its ingredients are still carried.
    add(s.inv, name, r.count);
    const roomFirst = fits(s);
    add(s.inv, name, made - r.count);
    consume(s, uses);
    if (!roomFirst || !fits(s)) return miss(s, name, made, path.slice(0, -1), 'no room left in my inventory for them', 'room');
    s.steps.push({ action: 'craft', item: name, count: made, uses, gives: [[name, made]], needsTable: r.table, setsTable, ingredients: r.needs.map(([ing]) => ing) });
    return true;
  }

  // The furnace burns whatever pickFuel picks from everything carried, so the plan picks the
  // same way and makes sure that much of that kind is spare.
  function planFuel(s, input, n, depth, path) {
    const covers = (p) => p && p.count * fuelValue(p.name) >= n;
    let pick = pickFuel(s.inv, n, { exclude: input });
    if (!covers(pick)) {
      const kinds = new Set(['coal', 'charcoal']);
      for (const m of [s.inv, s.store]) for (const k of m.keys()) kinds.add(k);
      for (const log of logs) kinds.add(log.replace(/_(log|stem)$/, '_planks')).add(log);
      const ranked = [...kinds]
        .filter((k) => k !== input && fuelValue(k) > 0)
        .map((k) => ({ k, need: Math.ceil(n / fuelValue(k)) }))
        .map((x) => ({ ...x, c: cost(x.k, x.need, depth, path) }))
        .filter((x) => x.c < Infinity)
        .sort((a, b) => a.c - b.c)
        .slice(0, MAX_TRIES);
      let got = false;
      for (const x of ranked) {
        const t = cloneState(s);
        if (acquire(t, x.k, x.need, depth, path)) {
          add(t.reserved, x.k, -x.need);
          Object.assign(s, t);
          got = true;
          break;
        }
      }
      if (got) pick = pickFuel(s.inv, n, { exclude: input });
      if (!got || !covers(pick)) {
        miss(s, 'fuel', n, [input], 'no coal, charcoal, planks or logs carried or in chests, and none I can get nearby', 'nearby');
        return null;
      }
    }
    if (!acquire(s, pick.name, pick.count, depth, path)) return null;
    return pick;
  }

  function planSmelt(s, name, input, short, depth, path) {
    for (let left = short; left > 0; ) {
      const n = Math.min(left, SMELT_MAX);
      if (!acquire(s, input, n, depth, path)) return false;
      const kinds = [furnaceKind(input), 'furnace'];
      const setsFurnace = !s.furnaces.some((k) => kinds.includes(k));
      if (setsFurnace && !acquire(s, 'furnace', 1, depth, path)) return false;
      const fuel = planFuel(s, input, n, depth, path);
      if (!fuel) return false;
      const uses = [[input, n], [fuel.name, fuel.count]];
      if (setsFurnace) {
        uses.push(['furnace', 1]);
        s.furnaces = [...s.furnaces, 'furnace'];
      }
      consume(s, uses);
      add(s.inv, name, n);
      s.steps.push({ action: 'smelt', item: name, input, count: n, uses, gives: [[name, n]], setsFurnace });
      left -= n;
    }
    return true;
  }

  function planGather(s, name, g, short, depth, path) {
    if (!g.found) return miss(s, name, short, path.slice(0, -1), g.reason, 'nearby');
    let tools = null;
    if (g.tools) {
      tools = g.tools;
      if (!tools.some((t) => get(s.inv, t) > 0)) {
        const ranked = tools.map((t) => ({ t, c: cost(t, 1, depth, path) })).sort((a, b) => a.c - b.c);
        const tries = ranked.filter((r) => r.c < Infinity).slice(0, MAX_TRIES);
        if (!tries.length) tries.push(ranked[0]);
        let got = false;
        let failed = null;
        for (const { t } of tries) {
          const trial = cloneState(s);
          if (acquire(trial, t, 1, depth, path)) {
            add(trial.reserved, t, -1);
            Object.assign(s, trial);
            got = true;
            break;
          }
          failed = better(trial.missing.slice(s.missing.length), failed);
        }
        if (!got) {
          s.missing.push(...failed);
          return false;
        }
      }
    }
    const room = g.found - get(s.gathered, name);
    if (room < short) return miss(s, name, short - Math.max(room, 0), path.slice(0, -1), `only ${g.found} ${g.block} within ${GATHER_RANGE} blocks`, 'nearby');
    if (g.action === 'chop') {
      for (let left = short; left > 0; ) {
        const trees = Math.min(5, Math.ceil(left / LOGS_PER_TREE));
        const need = Math.min(left, trees * LOGS_PER_TREE);
        const gives = Math.min(room, Math.max(need, trees * LOGS_PER_TREE));
        add(s.inv, name, gives);
        add(s.gathered, name, gives);
        s.steps.push({ action: 'chop', item: name, count: trees, need, pos: g.pos, uses: [], gives: [[name, gives]] });
        left -= need;
      }
      return true;
    }
    for (let left = short; left > 0; ) {
      const n = Math.min(left, MINE_MAX);
      add(s.inv, name, n);
      add(s.gathered, name, n);
      s.steps.push({ action: 'mine', item: name, block: g.block, count: n, tools, uses: [], gives: [[name, n]] });
      left -= n;
    }
    return true;
  }

  function attempt(n) {
    nodes = 0;
    const s = {
      inv: new Map(have), store: new Map(stored), reserved: new Map(), takes: new Map(), gathered: new Map(),
      steps: [], missing: [], table: Boolean(world.table), furnaces: world.furnaces ?? []
    };
    let done;
    try {
      done = acquire(s, item, n, 0, []);
    } catch (err) {
      if (err !== BUDGET) throw err;
      done = miss(s, item, n, [], 'working it out took too many steps', 'work');
    }
    if (done && s.steps.length > MAX_PLAN_STEPS) done = miss(s, item, n, [], `it would take more than ${MAX_PLAN_STEPS} steps`, 'work');
    return { s, done };
  }

  function result(s, count, missing) {
    const start = new Map(have);
    for (const [name, n] of s.takes) add(start, name, n);
    const steps = mergeSteps(s.steps, start, Boolean(world.table));
    if (s.takes.size) steps.unshift({ action: 'take', items: [...s.takes], uses: [], gives: [...s.takes] });
    return { item, want, count, steps, missing: dedupe(missing), complete: count >= want };
  }

  const full = attempt(want);
  if (full.done) return result(full.s, want, []);
  // Plans for as many as it can get, so it still brings what there is.
  let lo = Math.min(get(have, item), want);
  let best = null;
  let hi = want - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const a = attempt(mid);
    if (a.done) {
      lo = mid;
      best = a;
    } else {
      hi = mid - 1;
    }
  }
  if (best && best.s.steps.length === 0 && best.s.takes.size === 0) best = null;
  const empty = { takes: new Map(), steps: [] };
  return result(best?.s ?? empty, best ? lo : get(have, item), full.s.missing);
}

// The bot's registry recipes in the planner's shape.
export function recipeShape(registry, r) {
  return {
    count: r.result.count,
    needs: r.delta.filter((d) => d.count < 0 && registry.items[d.id]).map((d) => [registry.items[d.id].name, -d.count]),
    table: Boolean(r.requiresTable)
  };
}

// Items that smelt into each item, from the same table smelt uses.
export function smeltSources(registry) {
  const from = new Map();
  for (const i of registry.itemsArray) {
    const out = smeltOutput(i.name);
    if (!out) continue;
    if (!from.has(out)) from.set(out, []);
    from.get(out).push(i.name);
  }
  // Raw metal before ore blocks, the way players usually have it.
  for (const list of from.values()) list.sort((a, b) => Number(!a.startsWith('raw_')) - Number(!b.startsWith('raw_')));
  return (name) => from.get(name) ?? [];
}

export function harvestToolNames(registry, block) {
  if (!block?.harvestTools) return null;
  return Object.keys(block.harvestTools).map((id) => registry.items[id]?.name).filter(Boolean);
}

const dropsOf = (b) => (b.drops ?? []).map((d) => (typeof d === 'object' ? d.drop?.id ?? d.drop : d));

// The name to give mine: the shortest source name when it matches all of them (iron_ore also
// takes deepslate_iron_ore), else the nearest one's.
function mineQuery(names, nearest) {
  const shortest = [...names].sort((a, b) => a.length - b.length)[0];
  return names.every((n) => matchesBlockName(n, shortest)) ? shortest : nearest;
}

// How mine or chop_tree would get an item here, by the same rules: natural terrain or a tree,
// never the bot's own blocks, and nothing next to a build.
function gatherFor(ctx, name) {
  const { bot } = ctx;
  const reg = bot.registry;
  const here = bot.entity.position;
  const getBlock = (p) => bot.blockAt(p, false);
  const own = (p, n) => Boolean(ctx.placed?.has(p, n));
  if (isLogName(name)) {
    if (!reg.blocksByName[name]) return null;
    const isTreeLog = treeLogTest(ctx);
    const found = findNearest(bot, (n) => n === name, GATHER_RANGE, 64).filter(isTreeLog);
    // The nearest log that belongs to a tree with its leaves, not to a wall.
    const seen = new Set();
    const pos = found.find((p) => {
      if (seen.has(p.toString())) return false;
      const { logs, tree } = treeAt(ctx, p, isTreeLog);
      for (const l of logs) seen.add(l.toString());
      return tree;
    });
    if (!pos) return { action: 'chop', block: name, found: 0, reason: `no ${name} trees within ${GATHER_RANGE} blocks` };
    return { action: 'chop', block: name, found: found.length, pos, distance: pos.distanceTo(here) };
  }
  const item = reg.itemsByName[name];
  if (!item) return null;
  const sources = reg.blocksArray.filter((b) => b.boundingBox === 'block' && !isLogName(b.name) && (isTerrain(b.name) || isBuildTerrain(b.name)) && dropsOf(b).includes(item.id));
  if (!sources.length) return null;
  const names = sources.map((b) => b.name);
  const near = bot.findBlocks({ matching: sources.map((b) => b.id), maxDistance: GATHER_RANGE, count: 128 })
    .filter((p) => {
      const b = getBlock(p);
      return b && names.includes(b.name) && !own(p, b.name) && !nextToBuild(getBlock, p, own);
    })
    .sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  // Only what mine would take: blocks a player can see, not ore buried in the rock.
  const found = mineableBlocks(ctx, near);
  if (!found.length && near.length) return { action: 'mine', block: names[0], found: 0, reason: `${buriedText(names[0], near.length)} (within ${GATHER_RANGE} blocks)` };
  if (!found.length) return { action: 'mine', block: names[0], found: 0, reason: `no ${names.slice(0, 3).join(' or ')} within ${GATHER_RANGE} blocks away from builds` };
  const nearest = getBlock(found[0]).name;
  const query = mineQuery(names, nearest);
  const matching = found.filter((p) => matchesBlockName(getBlock(p).name, query));
  return { action: 'mine', block: query, found: matching.length, distance: found[0].distanceTo(here), tools: harvestToolNames(reg, reg.blocksByName[nearest]) };
}

// What the planner needs to know, read from the bot and its chest index.
export function readWorld(ctx, blocked = new Map(), keep = null) {
  const { bot } = ctx;
  // What a list's earlier items need stays out of the count, so getting a later one doesn't use it up.
  const have = countItems(carriedItems(bot));
  for (const [name, n] of keep ?? []) if (have.has(name)) have.set(name, Math.max(0, have.get(name) - n));
  const reg = bot.registry;
  const here = bot.entity.position;
  const dim = bot.game?.dimension;
  const stored = new Map();
  for (const c of bot.chestIndex?.list(dim) ?? []) {
    if (partsDistance(c.parts, here) > STORE_RANGE) continue;
    // Trapped chests are only opened when a player names one, so take steps can't use them.
    const name = bot.blockAt(new Vec3(c.parts[0].x, c.parts[0].y, c.parts[0].z), false)?.name ?? c.name;
    if (name && !isPickable(name)) continue;
    for (const [item, n] of c.items) add(stored, item, n);
  }
  const gathers = new Map();
  const recipeCache = new Map();
  const logs = [];
  for (const p of findNearest(bot, isLogName, GATHER_RANGE, 50)) {
    const name = bot.blockAt(p, false)?.name;
    if (name && !logs.includes(name) && !ctx.placed?.has(p, name)) logs.push(name);
  }
  const furnaces = findNearest(bot, (n) => FURNACES.includes(n), GATHER_RANGE, 8)
    .filter((p) => ctx.smeltJobs?.has(p.toString()) || !bot.blockAt(p, false)?.getProperties?.().lit)
    .map((p) => bot.blockAt(p, false).name);
  return {
    have,
    stored,
    recipes: (name) => {
      if (!recipeCache.has(name)) {
        const it = reg.itemsByName[name];
        recipeCache.set(name, it ? bot.recipesAll(it.id, null, true).map((r) => recipeShape(reg, r)) : []);
      }
      return recipeCache.get(name);
    },
    smeltsFrom: smeltSources(reg),
    gather: (name) => {
      if (!gathers.has(name)) gathers.set(name, gatherFor(ctx, name));
      return gathers.get(name);
    },
    table: findNearest(bot, (n) => n === 'crafting_table', GATHER_RANGE).length > 0,
    furnaces,
    logs,
    blocked,
    slots: inventorySlots(bot),
    stackSize: (name) => reg.itemsByName[name]?.stackSize ?? 64
  };
}

// The main inventory and hotbar, and the slots part stacks take beyond the full stacks they'd
// pack into.
function inventorySlots(bot) {
  const inv = bot.inventory;
  if (inv.inventoryStart === undefined || !inv.slots) return null;
  const items = inv.slots.slice(inv.inventoryStart, inv.inventoryEnd).filter(Boolean);
  let packed = 0;
  for (const [name, n] of countItems(items)) packed += Math.ceil(n / (bot.registry.itemsByName[name]?.stackSize ?? 64));
  return { total: inv.inventoryEnd - inv.inventoryStart, waste: items.length - packed };
}

function listText(pairs) {
  return pairs.map(([n, c]) => `${c} ${n}`).join(', ');
}

export function stepText(st) {
  if (st.action === 'take') return `take ${listText(st.items)} from chests`;
  if (st.action === 'craft') return `craft ${st.count} ${st.item}${st.setsTable ? ' (putting down a crafting table)' : ''}`;
  if (st.action === 'smelt') return `smelt ${st.count} ${st.input} into ${st.item}${st.setsFurnace ? ' (putting down a furnace)' : ''}`;
  if (st.action === 'mine') return `mine ${st.count} ${st.block}${st.block === st.item ? '' : ` for ${st.item}`}`;
  return `chop ${st.count} ${st.count === 1 ? 'tree' : 'trees'} for ${st.item}${st.pos ? ` at ${posText(st.pos)}` : ''}`;
}

export function missingText(missing) {
  return missing
    .map((m) => {
      const what = m.item === 'fuel' ? `fuel to smelt ${m.count} ${m.for}` : `${m.count} ${m.item}${m.for ? ` for ${m.for}` : ''}`;
      return `${what} (${m.reason})`;
    })
    .join('; ');
}

export function planText(plan) {
  const steps = plan.steps.map((st, i) => `${i + 1}. ${stepText(st)}`).join('; ');
  const head = plan.complete ? `plan for ${plan.want} ${plan.item}` : `plan for ${plan.count} of ${plan.want} ${plan.item}`;
  const body = plan.steps.length ? `${head}: ${steps}` : plan.complete ? `already carrying ${plan.want} ${plan.item}` : `can't get any more ${plan.item}`;
  return plan.missing.length ? `${body}. Would still be missing ${missingText(plan.missing)}` : body;
}

export const RUNNERS = { take: takeItems, craft, smelt, mine, chop: chopTree, look: lookInUnknown };

// A chest she hasn't opened yet could hold what the plan is short of, or what it would mine,
// chop or smelt for.
function worthLooking(plan) {
  return !plan.complete || plan.steps.some((st) => st.action === 'mine' || st.action === 'chop' || st.action === 'smelt');
}

function lookText({ looked, problems }) {
  const parts = [];
  if (looked.length) parts.push(`looked in ${looked.join(', ')}`);
  parts.push(...problems);
  return parts.join('; ');
}

function carriedOf(bot, name) {
  return carriedItems(bot).reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);
}

// What each step should add: [[name, count]].
function expected(st) {
  if (st.action === 'take') return st.items;
  if (st.action === 'chop') return [[st.item, st.need]];
  return [[st.item, st.count]];
}

function hasParts(bot, st) {
  const counts = countItems(carriedItems(bot));
  if (st.tools && !st.tools.some((t) => get(counts, t) > 0)) return false;
  return st.uses.every(([n, c]) => get(counts, n) >= c);
}

function blockKey(st, name) {
  if (st.action === 'take') return `take:${name}`;
  if (st.action === 'mine' || st.action === 'chop') return `gather:${name}`;
  return `${st.action}:${name}`;
}

function shortReason(st, result) {
  if (st.action === 'take' && result.ok) return 'the chests I knew of no longer had it';
  const text = result.message.split('\n')[0];
  return `${st.action === 'take' ? 'take_items' : st.action === 'chop' ? 'chop_tree' : st.action}: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

function doneText(st, got) {
  const gained = got.filter(([, n]) => n > 0);
  if (st.action === 'take') return gained.length ? `took ${listText(gained)}` : 'took nothing';
  const n = got[0][1];
  if (st.action === 'craft') return `crafted ${n} ${st.item}`;
  if (st.action === 'smelt') return `smelted ${n} ${st.item}`;
  if (st.action === 'mine') return `mined ${st.block} for ${n} ${st.item}`;
  return `chopped ${n} ${st.item}`;
}

function runStep(ctx, st, run) {
  if (st.action === 'take') return run.take(ctx, { items: st.items.map(([item, count]) => ({ item, count })) });
  if (st.action === 'craft') return run.craft(ctx, { item: st.item, count: st.count, ingredients: st.ingredients });
  if (st.action === 'smelt') return run.smelt(ctx, { item: st.input, count: st.count, wait: true });
  if (st.action === 'mine') return run.mine(ctx, { block: st.block, count: st.count });
  return run.chop(ctx, st.pos ? { x: st.pos.x, y: st.pos.y, z: st.pos.z, trees: st.count, log: st.item } : { trees: st.count, log: st.item });
}

const wanted = (count) => Math.min(Math.max(count ?? 1, 1), MAX_COUNT);

// Ends with count of item carried, or with every item of items: a list is got one after another
// in the same call, carrying on past one that comes up short, and what an earlier item needed is
// not used up for a later one.
export async function obtain(ctx, { item, count, items, plan_only: planOnly }, runners = {}) {
  const { bot } = ctx;
  const run = { ...RUNNERS, ...runners };
  const list = Array.isArray(items) ? items.filter((e) => e?.item) : [];
  if (!list.length) return item ? obtainOne(ctx, { item, count, planOnly }, run) : fail('give item, or items with a list');
  if (item) return fail('give item and count, or items, not both');
  // The same item twice is one entry for both counts.
  const wants = new Map();
  for (const e of list) wants.set(e.item, Math.min((wants.get(e.item) ?? 0) + wanted(e.count), MAX_COUNT));
  if (wants.size > MAX_ITEMS) return fail(`items takes at most ${MAX_ITEMS} different items a call, this is ${wants.size}`);

  const keep = new Map();
  const lines = [];
  const short = [];
  const names = [...wants.keys()];
  for (const [i, name] of names.entries()) {
    if (ctx.signal?.aborted) {
      lines.push(`stopped before ${names.slice(i).join(', ')}`);
      short.push(...names.slice(i));
      break;
    }
    const head = `item ${i + 1} of ${names.length}`;
    const sub = ctx.status ? { ...ctx, status: { progress: (text) => ctx.status.progress(`${head}: ${text}`) } } : ctx;
    const result = await obtainOne(sub, { item: name, count: wants.get(name), planOnly }, run, keep);
    lines.push(result.message);
    if (!result.ok) short.push(name);
    keep.set(name, Math.min(wants.get(name), carriedOf(bot, name)));
  }
  if (planOnly) return ok(lines.join('\n'));
  const head = short.length ? `got ${names.length - short.length} of ${names.length} items in full, short of ${short.join(', ')}` : `got all ${names.length} items`;
  const text = `${head}.\n${lines.join('\n')}`;
  return short.length ? fail(text) : ok(text);
}

// One item: plans the chain from what it carries and remembers, runs it with the other tools, and
// plans again whenever a step comes up short. keep is what to leave of other items she carries.
async function obtainOne(ctx, { item, count, planOnly }, run, keep = null) {
  const { bot } = ctx;
  if (!bot.registry.itemsByName[item]) return fail(`unknown item: ${item}`);
  const want = wanted(count);
  const start = carriedOf(bot, item);
  if (start >= want) return ok(`already carrying ${start} ${item}`);
  const blocked = new Map();
  let plan = planObtain(readWorld(ctx, blocked, keep), item, want);
  if (planOnly) return ok(planText(plan));

  const done = [];
  if (worthLooking(plan)) {
    const seen = await run.look(ctx);
    if (seen.looked.length) plan = planObtain(readWorld(ctx, blocked, keep), item, want);
    if (seen.looked.length || seen.problems.length) done.push(lookText(seen));
  }
  let ran = 0;
  let rounds = 1;
  let stopped = false;
  let note = null;
  for (;;) {
    let again = false;
    for (const [i, st] of plan.steps.entries()) {
      if (ctx.signal?.aborted) {
        stopped = true;
        break;
      }
      if (ran >= MAX_RUN_STEPS) {
        note = 'it took more steps than one call allows';
        break;
      }
      if (!hasParts(bot, st)) {
        again = true;
        break;
      }
      const head = `${item}, step ${i + 1} of ${plan.steps.length}: ${stepText(st)}`;
      ctx.status?.progress(head);
      const sub = ctx.status ? { ...ctx, status: { progress: (text) => ctx.status.progress(`${head}, ${text}`) } } : ctx;
      const expect = expected(st);
      const before = expect.map(([n]) => carriedOf(bot, n));
      let result;
      try {
        result = await runStep(sub, st, run);
      } catch (err) {
        result = fail(err.message);
      }
      ran++;
      const got = expect.map(([n], k) => [n, Math.max(0, carriedOf(bot, n) - before[k])]);
      const text = doneText(st, got);
      const short = expect.filter(([, c], k) => got[k][1] < c);
      done.push(short.length && !result.ok ? `${text} (${shortReason(st, result)})` : text);
      if (ctx.signal?.aborted) {
        stopped = true;
        break;
      }
      if (short.length) {
        for (const [n] of short) if (got.find(([g]) => g === n)[1] <= 0) blocked.set(blockKey(st, n), shortReason(st, result));
        again = true;
        break;
      }
    }
    if (stopped || note || carriedOf(bot, item) >= want) break;
    if (!again && !plan.complete) break;
    if (rounds >= MAX_ROUNDS) {
      note = 'it kept coming up short';
      break;
    }
    rounds++;
    plan = planObtain(readWorld(ctx, blocked, keep), item, want);
    if (!plan.steps.length) break;
  }

  const now = carriedOf(bot, item);
  const parts = [now >= want ? `now carrying ${now} ${item}` : `carrying ${now} of ${want} ${item}`];
  parts.push(done.length ? `did: ${done.join('; ')}` : 'did nothing');
  if (now < want) {
    if (stopped) parts.push('stopped');
    else if (plan.missing.length) parts.push(`missing ${missingText(plan.missing)}`);
    if (note) parts.push(`gave up because ${note}`);
  }
  return now >= want ? ok(parts.join('. ')) : fail(parts.join('. '));
}
