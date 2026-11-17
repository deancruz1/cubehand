import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, delay, customName } from './util.js';
import { useMoveMode } from './movement.js';
import { collectDrops } from './items.js';

const { GoalFollow } = pathfinderPkg.goals;

const SEARCH_RANGE = 32;
const REACH = 3;
const OFF_HAND = 45;
// Mobs whose shots or throws a shield stops, and how close one has to be to raise it.
const SHOOTERS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'illusioner', 'blaze', 'ghast', 'shulker']);
const SHIELD_RANGE = 16;
const FLYING = new Set(['phantom', 'ghast', 'blaze', 'vex', 'bee', 'bat', 'parrot']);
const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
// A full bow draw: 20 ticks, then the arrow leaves at 3 blocks a tick.
const DRAW_MS = 1100;
const ARROW_SPEED = 3;
const GRAVITY = 0.05;
const DRAG = 0.99;
// The bow is for targets further than BOW_MIN, and never inside MELEE_INSIDE.
const BOW_MIN = 6;
const MELEE_INSIDE = 4;
const LINE_CLEARANCE = 2;

// Best first, with the wait between full-strength hits in ms.
const WEAPONS = [
  ['netherite_sword', 625], ['diamond_sword', 625], ['netherite_axe', 1000], ['iron_sword', 625], ['trident', 910],
  ['diamond_axe', 1000], ['iron_axe', 1110], ['copper_sword', 625], ['stone_sword', 625], ['copper_axe', 1250],
  ['stone_axe', 1250], ['golden_axe', 1000], ['golden_sword', 625], ['wooden_sword', 625], ['wooden_axe', 1250]
];

// Hostile mobs that minecraft-data files under another type.
const ALSO_HOSTILE = new Set(['slime', 'magma_cube', 'ghast', 'phantom', 'shulker', 'hoglin', 'ender_dragon', 'wither']);
const MOB_TYPES = new Set(['hostile', 'mob', 'animal', 'passive', 'ambient', 'water_creature']);
const ANY_HOSTILE = new Set(['hostile', 'monster', 'mob']);
// Left out of "any hostile mob": creepers blow up next to builds, neutral mobs only fight once
// provoked, the warden and the bosses are far too strong, and the creaking can't be hurt.
// They are still attacked when named.
const ONLY_BY_NAME = new Set(['creeper', 'enderman', 'piglin', 'zombified_piglin', 'warden', 'wither', 'ender_dragon', 'creaking']);

export const FARM_ANIMALS = ['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit', 'goat'];

// A mob that is still a baby, by its metadata.
export function isBaby(bot, entity) {
  return metaValue(bot, entity, 'baby') === true;
}

export function isHostile(entity) {
  return entity.type === 'hostile' || ALSO_HOSTILE.has(entity.name);
}

// The best weapon name in a list of item names, or null to fight bare-handed.
export function bestWeapon(names) {
  return WEAPONS.find(([name]) => names.includes(name)) ?? null;
}

// target is a mob type (zombie, cow), a name tag, or "hostile" for any hostile mob.
// Players are never targets, and mobs with a name tag only when asked for by that name.
export function isTarget(entity, target) {
  if (entity.type === 'player' || !MOB_TYPES.has(entity.type)) return false;
  const tag = customName(entity)?.toLowerCase();
  const wanted = (target ?? 'hostile').toLowerCase();
  if (tag) return tag === wanted;
  if (ANY_HOSTILE.has(wanted)) return isHostile(entity) && !ONLY_BY_NAME.has(entity.name);
  return entity.name === wanted || entity.name === wanted.replace(/s$/, '');
}

// A hostile mob that would have been a target, but is only attacked when asked for by name.
export function leftAlone(entity, target) {
  if (!ANY_HOSTILE.has((target ?? 'hostile').toLowerCase()) || !MOB_TYPES.has(entity.type) || customName(entity)) return false;
  return isHostile(entity) && ONLY_BY_NAME.has(entity.name);
}

function reachTo(bot, entity) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const half = (entity.width ?? 0.6) / 2;
  const p = entity.position;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dx = eye.x - clamp(eye.x, p.x - half, p.x + half);
  const dy = eye.y - clamp(eye.y, p.y, p.y + (entity.height ?? 1.8));
  const dz = eye.z - clamp(eye.z, p.z - half, p.z + half);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function metaValue(bot, entity, key) {
  const index = bot.registry?.entitiesByName?.[entity.name]?.metadataKeys?.indexOf(key) ?? -1;
  return index >= 0 ? entity.metadata?.[index] : undefined;
}

// A creeper that has started to swell or was lit.
export function swelling(bot, creeper) {
  return Number(metaValue(bot, creeper, 'swell_dir') ?? -1) > 0 || metaValue(bot, creeper, 'is_ignited') === true;
}

const eyeOf = (entity) => entity.position.offset(0, (entity.height ?? 1.8) * 0.85, 0);

// Nothing solid on the straight line from a to b. With no world to look in, it counts as clear.
function clearLine(bot, a, b) {
  if (!bot.world?.raycast) return true;
  const dir = b.minus(a);
  const dist = dir.norm();
  return dist < 0.01 || !bot.world.raycast(a, dir.normalize(), dist);
}

// A mob that shoots or throws (skeletons, pillagers, blazes...) with a clear line to her within
// 16 blocks, or a creeper about to blow within 4: what a raised shield is for.
export function incoming(bot) {
  const here = bot.entity.position;
  const eye = here.offset(0, 1.62, 0);
  return (
    Object.values(bot.entities).find((e) => {
      if (e === bot.entity || !e.position || customName(e)) return false;
      const dist = e.position.distanceTo(here);
      if (e.name === 'creeper') return dist <= 4 && swelling(bot, e);
      return SHOOTERS.has(e.name) && dist <= SHIELD_RANGE && clearLine(bot, eyeOf(e), eye);
    }) ?? null
  );
}

// Puts a shield she carries in her off hand for a fight, unless a totem is there. Returns a
// handle to raise and lower it and to put back what was in the off hand, or null.
export async function takeShield(bot) {
  if (!bot.inventory?.items) return null;
  const before = bot.inventory.slots?.[OFF_HAND] ?? null;
  if (before?.name === 'totem_of_undying') return null;
  if (before?.name !== 'shield') {
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (!shield) return null;
    try {
      await bot.equip(shield, 'off-hand');
    } catch {
      return null;
    }
  }
  const back = before && before.name !== 'shield' ? before.name : null;
  let up = false;
  return {
    get up() {
      return up;
    },
    raise() {
      if (up) return;
      bot.activateItem(true);
      up = true;
    },
    lower() {
      if (!up) return;
      bot.deactivateItem();
      up = false;
    },
    async restore() {
      this.lower();
      const item = back && bot.inventory.items().find((i) => i.name === back);
      if (item) await bot.equip(item, 'off-hand').catch(() => {});
    }
  };
}

// Where an arrow loosed at pitch (radians, up is positive) is tick by tick, as [distance across,
// height] from where it leaves the bow: it moves, then slows by drag and drops by gravity, as in
// the game.
export function arrowPath(pitch, { speed = ARROW_SPEED, gravity = GRAVITY, drag = DRAG, ticks = 100 } = {}) {
  let h = 0;
  let y = 0;
  let vh = speed * Math.cos(pitch);
  let vy = speed * Math.sin(pitch);
  const points = [[0, 0]];
  for (let t = 0; t < ticks; t++) {
    h += vh;
    y += vy;
    vh *= drag;
    vy = vy * drag - gravity;
    points.push([h, y]);
  }
  return points;
}

// The height and flight ticks of the arc at distance across, or null if it never gets there.
function arcAt(pitch, distance, options) {
  const points = arrowPath(pitch, options);
  for (let i = 1; i < points.length; i++) {
    const [h1, y1] = points[i];
    if (h1 < distance) continue;
    const [h0, y0] = points[i - 1];
    const f = (distance - h0) / (h1 - h0 || 1);
    return { y: y0 + (y1 - y0) * f, ticks: i - 1 + f };
  }
  return null;
}

// The low-arc pitch that puts an arrow distance across and rise up, with the ticks it flies, or
// null when that is out of range. Height there grows with pitch up to the longest-reach angle,
// so the first pitch that gets high enough is the flat shot.
export function arrowPitch(distance, rise, options = {}) {
  const reaches = (p) => (arcAt(p, distance, options)?.y ?? -Infinity) >= rise;
  const step = Math.PI / 180;
  let lo = null;
  let hi = null;
  for (let p = -80 * step; p <= 80 * step; p += step) {
    if (reaches(p)) {
      hi = p;
      break;
    }
    lo = p;
  }
  if (hi === null) return null;
  if (lo === null) lo = hi - step;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (reaches(mid)) hi = mid;
    else lo = mid;
  }
  return { pitch: hi, ticks: arcAt(hi, distance, options).ticks };
}

// Yaw and pitch (as bot.look takes them) to hit target from where the arrow leaves, leading a
// target moving at velocity (blocks per tick), with the ticks it flies and the point aimed at.
export function aimAt(from, target, velocity = null, options = {}) {
  let point = target;
  let shot = null;
  for (let i = 0; i < 4; i++) {
    const dx = point.x - from.x;
    const dz = point.z - from.z;
    const arc = arrowPitch(Math.hypot(dx, dz), point.y - from.y, options);
    if (!arc) return null;
    shot = { yaw: Math.atan2(-dx, -dz), pitch: arc.pitch, ticks: arc.ticks, point };
    if (!velocity) break;
    point = new Vec3(target.x + velocity.x * arc.ticks, target.y + velocity.y * arc.ticks, target.z + velocity.z * arc.ticks);
  }
  return shot;
}

// The arc of a shot in the world, from where the arrow leaves to the point aimed at.
export function arcPoints(from, shot, options = {}) {
  const dx = shot.point.x - from.x;
  const dz = shot.point.z - from.z;
  const across = Math.hypot(dx, dz) || 1;
  const points = arrowPath(shot.pitch, options).filter(([h]) => h < across);
  return [...points.map(([h, y]) => new Vec3(from.x + (dx / across) * h, from.y + y, from.z + (dz / across) * h)), new Vec3(shot.point.x, shot.point.y, shot.point.z)];
}

export function segmentDistance(p, a, b) {
  const ab = b.minus(a);
  const len2 = ab.dot(ab) || 1;
  const t = Math.min(Math.max(p.minus(a).dot(ab) / len2, 0), 1);
  return p.distanceTo(a.plus(ab.scaled(t)));
}

// Why the shot along points mustn't be taken, or null: a block in the way, or a player, a named
// mob or a farm animal within 2 blocks of the line.
export function shotProblem(bot, points, target) {
  for (let i = 1; i < points.length; i++) if (!clearLine(bot, points[i - 1], points[i])) return 'no clear shot';
  const close = Object.values(bot.entities).find((e) => {
    if (e === bot.entity || e === target || !e.position) return false;
    if (e.type !== 'player' && !customName(e) && !FARM_ANIMALS.includes(e.name)) return false;
    const middle = e.position.offset(0, (e.height ?? 1.8) / 2, 0);
    return points.some((p, i) => i > 0 && segmentDistance(middle, points[i - 1], p) <= LINE_CLEARANCE);
  });
  return close ? `${close.type === 'player' ? close.username ?? 'a player' : customName(close) ?? `a ${close.name}`} is too close to the line` : null;
}

export const arrowCount = (bot) => bot.inventory.items().filter((i) => ARROWS.includes(i.name)).reduce((sum, i) => sum + i.count, 0);
const bowOf = (bot) => bot.inventory.items().find((i) => i.name === 'bow') ?? null;

// A target for the bow: far off, flying, high up out of reach, or a creeper, and never one that
// has come inside 4 blocks.
function bowTarget(bot, mob) {
  if (!bowOf(bot) || !arrowCount(bot)) return false;
  const dist = reachTo(bot, mob);
  if (dist < MELEE_INSIDE) return false;
  return dist > BOW_MIN || FLYING.has(mob.name) || mob.name === 'creeper' || mob.position.y - bot.entity.position.y > 3;
}

// The shot at mob from here, leading it by velocity, or { why } when it can't be taken.
function planShot(bot, mob, velocity) {
  const from = bot.entity.position.offset(0, 1.52, 0);
  const shot = aimAt(from, mob.position.offset(0, (mob.height ?? 1.8) / 2, 0), velocity);
  if (!shot) return { why: 'out of range' };
  const why = shotProblem(bot, arcPoints(from, shot), mob);
  return why ? { why } : { shot };
}

// Draws the bow for a full second while keeping the aim on mob, then looses if the shot is still
// clear. A draw that has to be called off is ended by putting the bow away. Returns 'shot', or why
// not.
async function shoot(ctx, mob, shield) {
  const { bot, signal } = ctx;
  const first = planShot(bot, mob, null);
  if (!first.shot) return first.why;
  bot.pathfinder.setGoal(null);
  shield?.lower();
  const bow = bowOf(bot);
  if (bot.heldItem?.name !== 'bow') await bot.equip(bow, 'hand');
  const start = mob.position.clone();
  const began = Date.now();
  const velocity = () => {
    const ticks = Math.max((Date.now() - began) / 50, 1);
    return new Vec3((mob.position.x - start.x) / ticks, 0, (mob.position.z - start.z) / ticks);
  };
  await bot.look(first.shot.yaw, first.shot.pitch, true);
  bot.activateItem();
  let plan = first;
  while (Date.now() - began < DRAW_MS) {
    if (signal?.aborted || !bot.entities[mob.id]) break;
    plan = planShot(bot, mob, velocity());
    if (plan.shot) await bot.look(plan.shot.yaw, plan.shot.pitch, true);
    await delay(100);
  }
  if (!signal?.aborted && bot.entities[mob.id]) plan = planShot(bot, mob, velocity());
  if (signal?.aborted || !bot.entities[mob.id] || !plan.shot) {
    await bot.unequip('hand').catch(() => {});
    return signal?.aborted ? 'stopped' : 'called off';
  }
  await bot.look(plan.shot.yaw, plan.shot.pitch, true);
  bot.deactivateItem();
  await delay(300);
  return 'shot';
}

// Chases one mob and hits it at full strength until it dies, runs off, or things go badly. With
// ranged, the bow takes the targets bowTarget picks. With a shield it is raised between swings
// and against anything incoming, and only lowered to strike. tally counts the arrows shot.
async function fight(ctx, mob, { minHealth = 6, ranged = false, shield = null, tally = { shot: 0 } } = {}) {
  const { bot, signal } = ctx;
  let dead = false;
  const onGone = (e) => {
    if (e.id === mob.id) dead = true;
  };
  bot.on('entityDead', onGone);
  bot.on('entityGone', onGone);
  useMoveMode(bot, false);
  let cooldown = 300;
  let melee = false;
  const closeIn = async () => {
    if (melee) return;
    melee = true;
    const weapon = await equipWeapon(bot);
    cooldown = weapon ? weapon[1] : 300;
    bot.pathfinder.setGoal(new GoalFollow(mob, 1.5), true);
  };
  const deadline = Date.now() + 60000;
  try {
    while (!dead) {
      if (signal?.aborted) return 'stopped';
      if (!bot.entities[mob.id]) return 'killed';
      if (bot.health <= minHealth) return 'low health';
      if (Date.now() > deadline) return 'took too long';
      if (mob.position.distanceTo(bot.entity.position) > SEARCH_RANGE) return 'got away';
      const threat = shield ? incoming(bot) : null;
      // A creeper about to blow is faced with the shield up until it has gone off or calmed down.
      if (threat?.name === 'creeper') {
        bot.pathfinder.setGoal(null);
        melee = false;
        await bot.lookAt(eyeOf(threat), true);
        shield.raise();
        await delay(100);
        continue;
      }
      if (ranged && bowTarget(bot, mob)) {
        const shot = await shoot(ctx, mob, shield);
        if (shot === 'stopped') return 'stopped';
        // Drawing took the sword out of her hand and stopped the chase.
        if (shot === 'shot' || shot === 'called off') melee = false;
        if (shot === 'shot') {
          tally.shot++;
          continue;
        }
      }
      await closeIn();
      if (reachTo(bot, mob) <= REACH) {
        shield?.lower();
        await bot.lookAt(mob.position.offset(0, (mob.height ?? 1.8) * 0.8, 0), true);
        bot.attack(mob);
        shield?.raise();
        await delay(cooldown, cooldown + 150);
      } else {
        if (threat) shield.raise();
        else shield?.lower();
        await delay(100);
      }
    }
    return 'killed';
  } finally {
    bot.removeListener('entityDead', onGone);
    bot.removeListener('entityGone', onGone);
    bot.pathfinder.setGoal(null);
  }
}

async function equipWeapon(bot) {
  const weapon = bestWeapon(bot.inventory.items().map((i) => i.name));
  if (weapon) await bot.equip(bot.inventory.items().find((i) => i.name === weapon[0]), 'hand');
  return weapon;
}

// Fights one particular mob and picks up what it drops. Used by the bot's own routines, which
// choose the mob themselves. The bow is only for hostile mobs unless ranged says otherwise, so
// hunting and culling stay hand to hand.
export async function attackEntity(ctx, mob, { minHealth, ranged = isHostile(mob) } = {}) {
  const shield = await takeShield(ctx.bot);
  let result;
  try {
    result = await fight(ctx, mob, { minHealth, ranged, shield });
  } finally {
    await shield?.restore();
  }
  if (result === 'killed') await collectDrops(ctx, { radius: 8, max: 8 });
  return result;
}

// Babies of farm animals only when asked for as babies ("baby cow") or by their name tag.
function babyAllowed(bot, entity, wantsBabies) {
  if (!FARM_ANIMALS.includes(entity.name)) return true;
  const baby = isBaby(bot, entity);
  if (wantsBabies) return baby;
  return !baby || Boolean(customName(entity));
}

export async function attack(ctx, { target, count }) {
  const { bot } = ctx;
  const wanted = Math.min(Math.max(count ?? 1, 1), 10);
  const label = target ?? 'hostile mob';
  const wantsBabies = /^baby[ _]/i.test(target ?? '');
  const kind = wantsBabies ? target.replace(/^baby[ _]/i, '') : target;

  const weapon = bestWeapon(bot.inventory.items().map((i) => i.name));
  const shield = await takeShield(bot);
  const tally = { shot: 0 };

  let kills = 0;
  let stopReason = '';
  const skip = new Set();
  const spared = new Map();
  const babies = new Map();
  try {
    while (kills < wanted) {
      const here = bot.entity.position;
      const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.position.distanceTo(here) <= SEARCH_RANGE);
      for (const e of near) if (leftAlone(e, kind)) spared.set(e.id, e.name);
      const matching = near.filter((e) => !skip.has(e.id) && isTarget(e, kind));
      if (!wantsBabies) for (const e of matching) if (!babyAllowed(bot, e, false)) babies.set(e.id, e.name);
      const mob = matching
        .filter((e) => babyAllowed(bot, e, wantsBabies))
        .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
      if (!mob) {
        stopReason = kills ? `no more ${label} within ${SEARCH_RANGE} blocks` : `no ${label} within ${SEARCH_RANGE} blocks`;
        break;
      }
      const result = await fight(ctx, mob, { ranged: true, shield, tally });
      if (result === 'killed') kills++;
      else if (result === 'got away' || result === 'took too long') skip.add(mob.id);
      else {
        stopReason = result === 'low health' ? `my health is low (${Math.round(bot.health)}/20), so I backed off` : result;
        break;
      }
    }
  } finally {
    await shield?.restore();
  }
  if (kills) await collectDrops(ctx, { radius: 8, max: 8 });

  const using = weapon ? ` with my ${weapon[0]}` : ' bare-handed';
  const arrows = tally.shot ? `, shot ${tally.shot} arrow${tally.shot === 1 ? '' : 's'} (${arrowCount(bot)} left)` : '';
  const summary = `killed ${kills} ${label}${using}${arrows}, now at ${posText(bot.entity.position)}`;
  const note = sparedText(spared) + babyText(babies);
  if (kills >= wanted) return ok(`${summary}${note}`);
  return kills ? ok(`${summary}. Stopped early: ${stopReason}${note}`) : fail(`${summary}. ${stopReason}${note}`);
}

function babyText(babies) {
  if (!babies.size) return '';
  const counts = new Map();
  for (const name of babies.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const list = [...counts].map(([name, n]) => `${n} baby ${name}`).join(', ');
  return `. Left ${list} alone: babies of farm animals are only attacked when you ask for baby ones (like baby_cow) or name them`;
}

export function sparedText(spared) {
  if (!spared.size) return '';
  const counts = new Map();
  for (const name of spared.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const list = [...counts].map(([name, n]) => `${n} ${name}`).join(', ');
  return `. Left ${list} alone: creepers, neutral mobs, wardens, creakings and bosses are only attacked when you name them as the target`;
}
