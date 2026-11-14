import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail, posText, pause, customName } from './util.js';
import { useMoveMode } from './movement.js';
import { collectDrops } from './items.js';

const { GoalFollow } = pathfinderPkg.goals;

const SEARCH_RANGE = 32;
const REACH = 3;

// Best first, with the wait between full-strength hits in ms.
const WEAPONS = [
  ['netherite_sword', 625], ['diamond_sword', 625], ['netherite_axe', 1000], ['iron_sword', 625], ['trident', 910],
  ['diamond_axe', 1000], ['iron_axe', 1110], ['copper_sword', 625], ['stone_sword', 625], ['copper_axe', 1250],
  ['stone_axe', 1250], ['golden_axe', 1000], ['golden_sword', 625], ['wooden_sword', 625], ['wooden_axe', 1250]
];

// Hostile mobs that minecraft-data files under another type.
const ALSO_HOSTILE = new Set(['slime', 'magma_cube', 'ghast', 'phantom', 'shulker', 'hoglin', 'ender_dragon', 'wither']);
const MOB_TYPES = new Set(['hostile', 'mob', 'animal', 'passive', 'ambient', 'water_creature']);

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
  if (wanted === 'hostile' || wanted === 'monster' || wanted === 'mob') return isHostile(entity);
  return entity.name === wanted || entity.name === wanted.replace(/s$/, '');
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

// Chases one mob and hits it at full strength until it dies, runs off, or things go badly.
async function fight(ctx, mob, cooldown, minHealth = 6) {
  const { bot, signal } = ctx;
  let dead = false;
  const onGone = (e) => {
    if (e.id === mob.id) dead = true;
  };
  bot.on('entityDead', onGone);
  bot.on('entityGone', onGone);
  useMoveMode(bot, false);
  bot.pathfinder.setGoal(new GoalFollow(mob, 1.5), true);
  const deadline = Date.now() + 60000;
  try {
    while (!dead) {
      if (signal?.aborted) return 'stopped';
      if (!bot.entities[mob.id]) return 'killed';
      if (bot.health <= minHealth) return 'low health';
      if (Date.now() > deadline) return 'took too long';
      if (mob.position.distanceTo(bot.entity.position) > SEARCH_RANGE) return 'got away';
      if (reachTo(bot, mob) <= REACH) {
        await bot.lookAt(mob.position.offset(0, (mob.height ?? 1.8) * 0.8, 0), true);
        bot.attack(mob);
        await pause(cooldown, cooldown + 150);
      } else {
        await pause(100);
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
// choose the mob themselves.
export async function attackEntity(ctx, mob, { minHealth } = {}) {
  const weapon = await equipWeapon(ctx.bot);
  const result = await fight(ctx, mob, weapon ? weapon[1] : 300, minHealth);
  if (result === 'killed') await collectDrops(ctx, { radius: 8, max: 8 });
  return result;
}

export async function attack(ctx, { target, count }) {
  const { bot } = ctx;
  const wanted = Math.min(Math.max(count ?? 1, 1), 10);
  const label = target ?? 'hostile mob';

  const weapon = await equipWeapon(bot);
  const cooldown = weapon ? weapon[1] : 300;

  let kills = 0;
  let stopReason = '';
  const skip = new Set();
  while (kills < wanted) {
    const here = bot.entity.position;
    const mob = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && !skip.has(e.id) && isTarget(e, target))
      .filter((e) => e.position.distanceTo(here) <= SEARCH_RANGE)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
    if (!mob) {
      stopReason = kills ? `no more ${label} within ${SEARCH_RANGE} blocks` : `no ${label} within ${SEARCH_RANGE} blocks`;
      break;
    }
    const result = await fight(ctx, mob, cooldown);
    if (result === 'killed') kills++;
    else if (result === 'got away' || result === 'took too long') skip.add(mob.id);
    else {
      stopReason = result === 'low health' ? `my health is low (${Math.round(bot.health)}/20), so I backed off` : result;
      break;
    }
  }
  if (kills) await collectDrops(ctx, { radius: 8, max: 8 });

  const using = weapon ? ` with my ${weapon[0]}` : ' bare-handed';
  const summary = `killed ${kills} ${label}${using}, now at ${posText(bot.entity.position)}`;
  if (kills >= wanted) return ok(summary);
  return kills ? ok(`${summary}. Stopped early: ${stopReason}`) : fail(`${summary}. ${stopReason}`);
}
