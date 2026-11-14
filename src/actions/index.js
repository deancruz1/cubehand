import { say, whisper } from './chat.js';
import { moveTo, goToPlayer, followPlayer, stopMoving, lookAt, giveItem } from './movement.js';
import { eat, inspectBlocks, placeBlock, breakBlock, findBlock, useBlock } from './blocks.js';
import { buildStructure } from './build.js';
import { buildHouse } from './house.js';
import { openContainer, storeItems, takeItems } from './containers.js';
import { mine, chopTree } from './mining.js';
import { collectItems } from './items.js';
import { attack } from './combat.js';
import { survey } from './survey.js';
import { remember, forget, recordArea } from './memory.js';
import { craft } from './crafting.js';
import { smelt } from './furnace.js';
import { sleep } from './bed.js';
import { equip, unequip, dropItem } from './inventory.js';
import { fail } from './util.js';

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
  use_block: useBlock,
  build_structure: buildStructure,
  build_house: buildHouse,
  open_container: openContainer,
  store_items: storeItems,
  take_items: takeItems,
  find_block: findBlock,
  survey,
  mine,
  chop_tree: chopTree,
  collect_items: collectItems,
  attack,
  remember,
  forget,
  record_area: recordArea,
  craft,
  smelt,
  sleep,
  equip,
  unequip,
  drop_item: dropItem
};

export async function runAction(ctx, name, input) {
  const action = ACTIONS[name];
  if (!action) return fail(`unknown action: ${name}`);
  try {
    return await action(ctx, input ?? {});
  } catch (err) {
    return fail(`${name} failed: ${err.message}`);
  }
}
