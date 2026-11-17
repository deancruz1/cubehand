import { say, whisper } from './chat.js';
import { moveTo, goToPlayer, followPlayer, stopMoving, lookAt, giveItem } from './movement.js';
import { eat, inspectBlocks, placeBlock, breakBlock, findBlock, useBlock } from './blocks.js';
import { buildStructure, breakBlocks, copyStructure } from './build.js';
import { buildHouse } from './house.js';
import { previewStructure, viewArea } from './preview.js';
import { designGuide } from './design.js';
import { openContainer, storeItems, takeItems, stash } from './containers.js';
import { mine, chopTree } from './mining.js';
import { digArea } from './dig.js';
import { useItem } from './use.js';
import { collectItems } from './items.js';
import { fish } from './fishing.js';
import { harvest } from './farm.js';
import { tendAnimals } from './husbandry.js';
import { trade } from './trade.js';
import { enchant, repair } from './enchant.js';
import { brew } from './brew.js';
import { attack } from './combat.js';
import { survey } from './survey.js';
import { remember, forget, recordArea } from './memory.js';
import { craft } from './crafting.js';
import { smelt } from './furnace.js';
import { obtain } from './obtain.js';
import { sleep } from './bed.js';
import { equip, unequip, dropItem } from './inventory.js';
import { fail } from './util.js';
import { takeStock, stateLine } from '../perception.js';
import { skillAction } from '../skills.js';

export const ACTIONS = {
  say,
  whisper,
  move_to: moveTo,
  go_to_player: goToPlayer,
  follow_player: followPlayer,
  stop_moving: stopMoving,
  look_at: lookAt,
  eat,
  give_item: giveItem,
  inspect_blocks: inspectBlocks,
  place_block: placeBlock,
  break_block: breakBlock,
  break_blocks: breakBlocks,
  use_block: useBlock,
  use_item: useItem,
  harvest,
  build_structure: buildStructure,
  copy_structure: copyStructure,
  design_guide: designGuide,
  preview_structure: previewStructure,
  view_area: viewArea,
  build_house: buildHouse,
  open_container: openContainer,
  store_items: storeItems,
  take_items: takeItems,
  stash,
  find_block: findBlock,
  survey,
  mine,
  dig_area: digArea,
  chop_tree: chopTree,
  collect_items: collectItems,
  fish,
  attack,
  tend_animals: tendAnimals,
  remember,
  forget,
  record_area: recordArea,
  craft,
  obtain,
  trade,
  smelt,
  brew,
  enchant,
  repair,
  sleep,
  equip,
  unequip,
  drop_item: dropItem,
  skill: skillAction(runAction)
};

export async function runAction(ctx, name, input) {
  const action = ACTIONS[name];
  if (!action) return fail(`unknown action: ${name}`);
  // Every result ends with the bot's state, so the model needn't look it up and a failure shows
  // where it left the bot.
  const before = takeStock(ctx.bot);
  let result;
  try {
    result = await action(ctx, input ?? {});
  } catch (err) {
    result = fail(`${name} failed: ${err.message}`);
  }
  const state = stateLine(before, takeStock(ctx.bot));
  return state ? { ...result, message: `${result.message}\n${state}` } : result;
}
