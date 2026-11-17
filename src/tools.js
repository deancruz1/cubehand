import { SKILL_TOOL } from './skills.js';
import { KIT_KINDS, kitSummary } from './actions/kits.js';

const int = { type: 'integer' };
const str = { type: 'string' };
const itemList = {
  type: 'array',
  items: {
    type: 'object',
    properties: { item: str, count: int },
    required: ['item'],
    additionalProperties: false
  }
};

const offset = { type: 'object', properties: { dx: int, dy: int, dz: int }, required: ['dx', 'dy', 'dz'], additionalProperties: false };
const mirror = { type: 'object', properties: { x: int, z: int }, required: [], additionalProperties: false };
const side = { type: 'string', enum: ['north', 'south', 'east', 'west'] };
const roles = ['wall', 'frame', 'trim', 'roof', 'foundation', 'floor', 'glass', 'light', 'accent', 'accent2'];

const viewList = { type: 'array', items: { type: 'string', enum: ['south-east', 'south-west', 'north-east', 'north-west', 'top', 'south', 'north', 'east', 'west'] } };

// A build_structure plan, shared with the tools that take the same plan.
const buildPlan = {
  origin: {
    type: 'object',
    properties: { x: int, y: int, z: int },
    required: ['x', 'y', 'z'],
    additionalProperties: false
  },
  palette: {
    type: 'object',
    properties: Object.fromEntries(roles.map((r) => [r, str])),
    required: [],
    additionalProperties: false
  },
  mirror,
  clear: { type: 'boolean' },
  foundation: str,
  replace: { type: 'boolean', description: 'set only when a player said to build over what stands there; lifts the limit' },
  parts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['fill', 'hollow', 'walls', 'frame', 'line', 'roof', 'circle', 'sphere', 'dome', 'cone', 'pyramid', 'arch', 'staircase', 'posts', 'windows', 'band', 'kit'] },
        from: offset,
        to: offset,
        block: str,
        fill: str,
        overhang: int,
        style: { type: 'string', enum: ['gable', 'hip', 'pyramid', 'shed', 'flat'] },
        pitch: { type: 'number', enum: [0.5, 1, 2] },
        facing: side,
        axis: { type: 'string', enum: ['x', 'y', 'z'] },
        hollow: { type: 'boolean' },
        rise: int,
        every: int,
        width: int,
        proud: { type: 'boolean' },
        edge: str,
        stepped: { type: 'boolean' },
        once: { type: 'boolean' },
        kind: { type: 'string', enum: KIT_KINDS },
        variant: { type: 'integer', enum: [1, 2, 3] },
        extra: { type: 'boolean' },
        repeat: { type: 'object', properties: { count: int, dx: int, dy: int, dz: int }, required: ['count'], additionalProperties: false },
        mirror
      },
      required: ['shape', 'from', 'to', 'block'],
      additionalProperties: false
    }
  },
  blocks: {
    type: 'array',
    items: {
      type: 'object',
      properties: { dx: int, dy: int, dz: int, block: str, once: { type: 'boolean' } },
      required: ['dx', 'dy', 'dz', 'block'],
      additionalProperties: false
    }
  }
};

function tool(name, description, properties, required) {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}

export const TOOLS = [
  tool(
    'say',
    'Send a chat message mid-job, only for progress updates during long jobs. Never use it for questions or your final answer; your final reply is sent to chat automatically.',
    { message: str },
    ['message']
  ),
  tool('whisper', 'Send a private message to one player.', { player: str, message: str }, ['player', 'message']),
  tool(
    'move_to',
    'Walk to block coordinates, finding a path around obstacles. range is how close to get (default 1).',
    { x: int, y: int, z: int, range: int },
    ['x', 'y', 'z']
  ),
  tool(
    'go_to_player',
    'Walk to a player by name, or to a mob by its name tag. range is how close to get (default 2).',
    { player: str, range: int },
    ['player']
  ),
  tool(
    'follow_player',
    'Keep following a player (or a mob with a name tag) until stop_moving or another movement. Returns right away.',
    { player: str, range: int },
    ['player']
  ),
  tool('stop_moving', 'Stop walking or following.', {}, []),
  tool(
    'look_at',
    'Turn to face a player or named mob (give player) or a block position (give x, y, z).',
    { player: str, x: int, y: int, z: int },
    []
  ),
  tool('eat', 'Eat food from the inventory. Leave food out to eat any food the bot has.', { food: str }, []),
  tool(
    'give_item',
    'Walk to a player and toss them items from the inventory. Leave count out to give all of that item.',
    { player: str, item: str, count: int },
    ['player', 'item']
  ),
  tool(
    'inspect_blocks',
    'Get the block at x1 y1 z1, or every block in the box from x1 y1 z1 to x2 y2 z2, with the way stairs, slabs, logs and trapdoors are turned. A box of more than 600 blocks gets a summary instead: for each y layer, how many of each block and the x and z it spans (layers that are the same share a line), up to 32768 blocks. Inspect a smaller box inside it for the exact blocks and states.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int },
    ['x1', 'y1', 'z1']
  ),
  tool(
    'place_block',
    'Place one block from the inventory at x y z. The spot must be empty and next to a solid block (a door, trapdoor, gate, chest or the like opens instead, so it does not count). The block can carry a state, like oak_stairs[facing=north,half=top] (see build_structure).',
    { block: str, x: int, y: int, z: int },
    ['block', 'x', 'y', 'z']
  ),
  tool(
    'break_block',
    'Break the block at x y z and pick up what drops. If you stand on it, steps beside it first. Equips the best tool in the inventory automatically (pickaxe for stone, axe for wood, shovel for dirt). Protected blocks (chests, beds, furnaces, crafting tables...) are refused unless you placed them yourself or confirmed is true, which you may only set when a player clearly asked you to break that block.',
    { x: int, y: int, z: int, confirmed: { type: 'boolean' } },
    ['x', 'y', 'z']
  ),
  tool(
    'break_blocks',
    'Break every block of one kind in the box between x1 y1 z1 and x2 y2 z2 and pick up what drops: built blocks dig_area leaves, like the cobblestone in a wall or an old floor. With replace_with, puts that block (it can carry a state, see build_structure) in each spot right after breaking it, to swap one material for another. block is an exact name like cobblestone; everything else in the box stays. Only for blocks a player clearly asked you to break or replace: before breaking anything someone built, ask the player to confirm first, and without an admin never break someone\'s build. Protected blocks (chests, beds, furnaces, crafting tables...) are left unless you placed them yourself or confirmed is true, which you may only set when a player clearly asked you to break those blocks; someone else\'s need an admin\'s request. Replacing goes bottom up and only does as many spots as you carry blocks for, each new block going in right after the old one comes out; breaking goes top down. Never breaks the block you stand on: steps off onto ground that stays first, or leaves that spot for last. Big boxes are refused with the limit, then do it in parts. Returns how many it broke or replaced, what was left and why, what it picked up and where you are.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int, block: str, replace_with: str, confirmed: { type: 'boolean' } },
    ['x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'block']
  ),
  tool(
    'use_block',
    'Use the block at x y z like a right click: open or close a door, fence gate or trapdoor (open true or false, left out it toggles), press a button, or flip a lever. Walking opens and closes doors and gates on its own, so this is only for when a player asks.',
    { x: int, y: int, z: int, open: { type: 'boolean' } },
    ['x', 'y', 'z']
  ),
  tool(
    'use_item',
    'Use an item you carry like a right click; walks over, holds it, uses it and says what changed. On the block at x y z: bucket picks up water or lava (give the source), water_bucket or lava_bucket pours into that empty spot, a hoe tills dirt or grass, bone_meal grows a crop or sapling, seeds, carrots, potatoes, saplings, sweet_berries and nether_wart are planted on farmland, soil or soul sand (give the ground or the spot on it), flint_and_steel or fire_charge lights a campfire, candle or nether portal (click the obsidian under the opening) or sets fire on netherrack; other items are clicked on the block. Give x2 y2 z2 as well to till, plant or bone meal every fitting block in that box in one go. With target (a mob type like sheep or cow, or a name tag): shears on sheep, a bucket or bowl on cows, food to feed or breed animals, on the count nearest that it works on (default 1, max 10), skipping ones it does nothing to. With only item: throws it (snowball, egg, ender_pearl, splash potions; x y z aims and is needed for splash potions, count is how many) or drinks it (potion, milk_bucket, honey_bottle). Leave item out with a target to get in a boat or minecart or onto a saddled mount (you can\'t steer), and leave everything out to get off. Never on players, and mobs with name tags only when named. Lighting a campfire or candle is always fine; other fire and lava are refused near anything that burns or was built, and lava, and fire on anything but netherrack, soul sand or a portal, need an admin. Never uses TNT. Doors, buttons and levers are use_block; to eat, use eat.',
    { item: str, x: int, y: int, z: int, x2: int, y2: int, z2: int, target: str, count: int },
    []
  ),
  tool(
    'harvest',
    'Harvest the ripe crops in a box from x y z to x2 y2 z2 (leave x2 y2 z2 out for one block; the box can be the crops or the farmland under them, at most 512 blocks) and plant them again from what you carry, picking up the drops on the way. Takes wheat, carrots, potatoes, beetroots and nether wart when fully grown, melons and pumpkins a stem grows (never the stem), sugar cane, bamboo, cactus and kelp from the second block up, ripe sweet berries off the bush, and ripe cocoa (planted again on the same log). Unripe plants are left and counted. crop limits it to one kind; replant false leaves the spots empty. Walks without jumping, so the farmland stays. The field is remembered and looked after in your free time (ripe crops harvested and planted again) unless tend is false; tend false on a box stops you looking after the fields in it.',
    { x: int, y: int, z: int, x2: int, y2: int, z2: int, crop: str, replant: { type: 'boolean' }, tend: { type: 'boolean' } },
    ['x', 'y', 'z']
  ),
  tool(
    'build_structure',
    'Build a structure relative to origin (dx, dy, dz offsets) from parts (shapes filling a box from..to) and single blocks; use it for anything bigger than a few blocks. Shapes: fill, hollow (a closed shell), walls (no floor or top), frame (edges only), line (straight or diagonal). roof: stairs over the walls from..to, its eave row at from.dy (the layer over the wall tops), overhang 0-2 (default 1) blocks out at that height; style gable (default; ridge along the longer side, or along axis x or z), hip, pyramid (square box), shed (climbs toward facing from its low eave row at from.dy on the other side; row k is k up, so its top row is from.dy+rows-1, rows counting overhang: put that one under a main eave) or flat (a deck, upside-down stairs round it, a parapet of fill); pitch 1, 2 (row k is 2k up) or 0.5 (slabs, bottom then top: k/2 up); fill closes the walls up to it; edge (a block, mix or role) frames it in a second block: the eaves, gable ends (upside-down stairs under an overhang), hips and ridge, a flat roof\'s rim. circle (across axis, default y; a tall box makes a cylinder), sphere, dome (from.dy its base), cone, pyramid (stepped), each solid or with hollow a shell. arch: an opening seen along axis (default through the wall round it, else the thin side), curving over its top rise blocks (default half the span); air cuts it, hollow is only its outline (two legs and the curve, one block thick); each step of the curve becomes an upside-down stair of the wall (stepped true keeps square steps). staircase: foot at from, top at to, one up per block across; fill fills under it. posts: both ends of each wall and evenly between, (length-1)/every gaps rounded (default 4); a post touching an earlier posts part\'s post is left out. windows: width wide (default 1), the box\'s height, as many as fit every apart start to start (default width+2, or every+1 if that fits more), mirrored about each wall\'s middle, 2+ from the corners; one is left out where a door or earlier air is in its columns up to 3 below it, or behind an earlier post. band: trim round the walls; logs lie along, stairs face the wall upside down ([half=bottom]: an upright cap). proud true stands posts or band a block out; a box one block thick is one wall (proud then needs facing). A field a shape does not use is refused. repeat {"count":4,"dx":3}: 4 in all, each 3 further. mirror {"x":8} adds the image at 8-dx (z likewise), facings turned; on the plan it mirrors every part and block but those with once true, so write half. Later parts win; "air" takes out what came before. A mix like 85%stone_bricks,15%cobblestone goes in small patches, the same every time; scatter:70%gravel,30%coarse_dirt picks each block alone. palette roles (wall, frame, trim, roof, foundation, floor, glass, light, accent, accent2) go in as @wall, @roof[facing=north], or a form on any role: .stairs, .slab, .wall, .fence, .fence_gate, .door, .trapdoor, .button, .pressure_plate, .pane, .planks, .log, .block (full). Example: {"palette":{"wall":"spruce_planks","roof":"dark_oak_stairs","trim":"spruce_planks"},"parts":[{"shape":"walls","from":{"dx":0,"dy":0,"dz":0},"to":{"dx":8,"dy":3,"dz":6},"block":"@wall"},{"shape":"roof","from":{"dx":0,"dy":4,"dz":0},"to":{"dx":8,"dy":4,"dz":6},"block":"@roof","fill":"@wall","edge":"@trim"}]}. States as the game writes them: spruce_stairs[facing=east,half=top], oak_slab[type=top] (double: two in a spot), oak_log[axis=x], spruce_trapdoor[facing=south,half=top,open=true], lantern[hanging=true]. Stairs face the way they climb; half=top is upside down; trapdoors and wall torches face away from their block. A door is one block, oak_door[facing=north], and both halves come; two chests side by side facing the same way join as a double chest. Whatever stands in planned and air spots is dug out first, others\' blocks too, up to 32 a call (more: all left and listed); chests, signs, protected blocks and blocks a build leans on stay and are listed. Elsewhere in the box only plants and snow go; clear true digs all natural blocks there (for a slope). foundation (a block or mix) fills down from the bottom layer to the ground, 6 deep at most. Builds the nearest cluster first, bottom up, propping on dirt or cobblestone that comes out again; then up to three checks put back what got knocked out and sweep snow and plants off. Anything placed counts: what is left is listed with the reason, and the same call again skips what is in place. Short of items it takes them from chests you remember, then builds what they cover and says what is short. dry_run gives the items needed and the site work without building. Kits: shape kit, kind picks one, variant (default 1) its look, extra its option; from..to boxes what each names; facing is where its front looks (out of the wall, or into the room); block and fill are its materials (forms come from them; roles work). ' + kitSummary() + '.',
    { ...buildPlan, dry_run: { type: 'boolean' } },
    ['origin']
  ),
  tool(
    'design_guide',
    'Get the design guide before you design anything bigger than a few blocks with build_structure: how to work (plan in layers, preview, check, revise), what makes that kind of build look good, palettes for the style with the cheap ones first, and the checklist to judge previews by. structure is what you are building (house, cabin, tower, wall, bridge, barn, farm, shop, monument, interior, garden or other; words like watchtower, storehouse, gatehouse or stall work too) and style the look (rustic, medieval, modern, fantasy, japanese, desert, nordic or other); leave either out for the general guide.',
    { structure: str, style: str },
    []
  ),
  tool(
    'preview_structure',
    'Draw a build_structure plan as pictures without placing anything or walking, from wherever you are. Takes the same plan as build_structure and checks it the same way. views picks the pictures, at most 4: south-east, south-west, north-east and north-west look down at a corner from above, top looks straight down, and south, north, east and west look straight at one side; left out, it draws two opposite corners, and the top too when the plan is at most 32 blocks wide and deep. cut_above leaves out every block above that dy, to look inside. Returns the pictures with the size, the block count, the items needed and what you are short of. Look the pictures over before building: fix what looks plain or wrong and preview again, then build_structure the same plan.',
    { ...buildPlan, views: viewList, cut_above: int },
    ['origin']
  ),
  tool(
    'view_area',
    'Draw what stands in the box between x1 y1 z1 and x2 y2 z2 as pictures, terrain and all, to check a build you finished or look at one before changing it. At most 48 blocks on each side, and all of it has to be loaded. views works as in preview_structure; cut_above leaves out every block more than that many blocks above the bottom of the box. Returns the pictures and what the box holds: how many of each main kind of block.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int, views: viewList, cut_above: int },
    ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']
  ),
  tool(
    'copy_structure',
    'Build a copy of what is in the box between x1 y1 z1 and x2 y2 z2, with the copy\'s lowest north-west corner at origin. It reads the box into a build_structure plan, block states included (stairs, slabs and double slabs, doors, trapdoors, the way logs lie and blocks face), and builds it the same way: from what you carry, taking what is short from chests you remember, and building what the items cover if still short. rotate turns the copy 90, 180 or 270 degrees clockwise seen from above, states and all. Air in the source is skipped; with clear true, blocks at the copy that stand where the source has air are listed, never broken (break_blocks or dig_area can clear them once a player confirms). Containers are built empty. Blocks no item places (water, lava, fire, crops and the like) are left out and listed. The box and the number of blocks have the same limits as build_structure, so copy a big build in parts. Set dry_run to get the items needed and what you are short of without building.',
    {
      x1: int, y1: int, z1: int, x2: int, y2: int, z2: int,
      origin: {
        type: 'object',
        properties: { x: int, y: int, z: int },
        required: ['x', 'y', 'z'],
        additionalProperties: false
      },
      rotate: { type: 'integer', enum: [0, 90, 180, 270] },
      clear: { type: 'boolean' },
      dry_run: { type: 'boolean' }
    },
    ['x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'origin']
  ),
  tool(
    'build_house',
    'Build a furnished survival house centered on x y z (foot level). Designs: cottage (one box, framed gable roof, chimney), cabin (with a front porch), l_house (medium L-plan with a cross gable), two_storey (two floors with a ladder), desert (flat-roofed sandstone with a parapet). Leave design out to pick one that suits the size, floors, roof and site, with small variations by position; calling again at the same spot continues the same house. Odd widths and depths (7 to 15) so the door and gable centre. Picks a palette from what you carry and where you are (light walls with a contrasting roof frame), falling back in steps to one wood and cobblestone with a framed roof when items are short, and reports which look was built. Includes a furnished interior (bed nook, storage, kitchen with furnace and crafting table, table, ceiling light, distinct floor) and surroundings (path, light, bushes, barrel); set interior or surroundings to false to leave either out. Clears natural blocks and your own blocks that don\'t fit; refuses if someone else\'s build, a protected block or a tree is in the way. Set dry_run to check the site and get the exact items needed.',
    {
      x: int,
      y: int,
      z: int,
      design: { type: 'string', enum: ['cottage', 'cabin', 'l_house', 'two_storey', 'desert'] },
      width: int,
      depth: int,
      floors: int,
      height: int,
      door: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      roof: { type: 'string', enum: ['gable', 'flat'] },
      interior: { type: 'boolean' },
      surroundings: { type: 'boolean' },
      basement: { type: 'boolean' },
      attic: { type: 'boolean' },
      palette: {
        type: 'object',
        properties: {
          wall: str, frame: str, trim: str, roof: str, foundation: str, floor: str, glass: str, light: str, accent: str, accent2: str
        },
        additionalProperties: false
      },
      materials: {
        type: 'object',
        properties: {
          walls: str, floor: str, roof: str, corners: str, foundation: str, trim: str, windows: str, door: str,
          sills: str, shutters: str, porch: str, posts: str, chimney: str, lights: str
        },
        additionalProperties: false
      },
      dry_run: { type: 'boolean' }
    },
    ['x', 'y', 'z']
  ),
  tool(
    'survey',
    'Look around the building or cave you are in: walks the rooms in your head and lists each level (floor) with its chests and their sign labels, crafting tables, furnaces, beds, doors, ladders and stairs. Use it when asked to check or fetch something inside a building, or to find the way to another floor.',
    {},
    []
  ),
  tool(
    'open_container',
    'Walk to a chest, barrel, or shulker box and list what is inside. Leave x y z out to use the nearest one that is not a trapped chest (searches 64 blocks).',
    { x: int, y: int, z: int },
    []
  ),
  tool(
    'store_items',
    'Walk to a chest, barrel, or shulker box and put items from the inventory into it. Leave x y z out to use the nearest one that is not a trapped chest (searches 64 blocks). Leave count out to store all of that item. Says how much went in when the container fills up.',
    { x: int, y: int, z: int, items: itemList },
    ['items']
  ),
  tool(
    'take_items',
    'Walk to a chest, barrel, or shulker box and take items out of it. Leave x y z out to find each item yourself: takes from the nearest containers you remember holding it, from several if one has too little, then looks in up to 4 nearby ones you know nothing about, nearest first (searches 64 blocks), and says what came from where and what is still missing. Takes only what fits in your inventory and says when it is full; stash frees room. A trapped chest is only opened when its x y z is given. Leave count out to take all of that item from one container.',
    { x: int, y: int, z: int, items: itemList },
    ['items']
  ),
  tool(
    'stash',
    'Put away everything you don\'t need to carry in one call, into containers within 48 blocks (never trapped chests). Each kind goes to one that already holds it, else one whose sign or item frame fits it, else the nearest unlabeled one, moving on when one is full. Keeps tools, weapons, armor, food, torches and buckets. items puts away only those (short names like log match every kind, count is how many), keep names more to hold on to.',
    { items: itemList, keep: { type: 'array', items: str } },
    []
  ),
  tool(
    'mine',
    'Mine natural blocks of a type nearby like a player: terrain (stone, deepslate, dirt, sand, gravel...), ores, and natural blocks that double as build materials (sandstone, red_sandstone, obsidian, ice, packed_ice, blue_ice, basalt, blackstone, terracotta, glowstone, magma_block, amethyst_block...). Only takes blocks exposed to open space you can walk to, nearest and easiest first, never ore buried in rock; takes the whole vein of an ore and comes back. It eats into any exposed wall, the walls of dug tunnels too, so use dig_area for tunnels and strip mines. Grabs ores it passes, avoids lava, and picks up the drops. Where it is dark underground it puts up torches you carry, and says when you have none. When your inventory fills up it empties it into a chest you remember within 32 blocks (up to three times) and carries on, or stops and says how many are still to mine and where the drops are. Never takes blocks you placed or anything in or next to a build, and skips build materials like sandstone or obsidian with anything built within 5 blocks. Crafted blocks like planks, glass, bricks or cobblestone are refused: use break_block on specific blocks once a player has confirmed. Searches 32 blocks around you, so walk to the right area first. Leave block out for stone, count out for 16 (max 64). Use a short name like coal_ore or ore to match every kind. For logs use chop_tree.',
    { block: str, count: int },
    []
  ),
  tool(
    'dig_area',
    'Dig out exactly the box between x1 y1 z1 and x2 y2 z2 and nothing outside it: a tunnel, strip mine, room, a hole (a 5x5 hole 3 deep is the box from the top layer down 3), a trench, or flattening ground (the box over everything above the new ground level). y is the floor where feet go, so a tunnel you can walk is 2 high: y1 = y, y2 = y+1; a 1-high box can\'t be walked into. Walks round through open space to reach it; tunnels and rooms are dug face by face standing on the floor from the end it gets to, holes from the top layer down. Never digs the block it stands on, and picks up the drops. Takes natural terrain like mine does (dirt, stone, sand, gravel, ores, and build materials like sandstone only away from builds) plus grass, flowers, snow and other plants. Leaves everything else and lists it with the reason and where: built or crafted blocks, protected blocks, blocks you placed, logs (use chop_tree), terrain touching a build, blocks with lava next to them or a cave right under them, and blocks your tools can\'t harvest; use break_block, or break_blocks for many of one kind, for those only once a player confirms. Sand or gravel falling in from above is dug too. ores true also mines out ore veins the dig uncovers in the walls, floor and ceiling and fills the holes they leave in the sides with matching rock it carries, then carries on; without it they are listed with where they are. Underground it puts up torches you carry where the dug space is dark, about every 8 blocks, and says when it is dark and you have none. When your inventory fills up it empties it into a chest you remember within 32 blocks (up to three times) and carries on, or stops and says how much is dug, how much is left and where the drops are. Big boxes are refused with the limit, then do it in parts. Returns how many it dug of what, what was left and why, what it picked up and where you are.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int, ores: { type: 'boolean' } },
    ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']
  ),
  tool(
    'chop_tree',
    'Chop down whole trees like a player: the tree with a log at x y z, or the nearest trees within 32 blocks. Works from the bottom up, climbs on dirt or cobblestone for the high logs, takes that back down, and picks up the logs. trees is how many (default 1, max 5). Never takes logs you placed, stripped logs, low sideways logs or logs touching a build as part of a tree. Plants a sapling of the same wood where the trunk stood if you carry one.',
    { x: int, y: int, z: int, trees: int },
    []
  ),
  tool(
    'collect_items',
    'Walk over dropped items on the ground to pick them up. Leave item out to take everything, radius is how far to look (default 16, max 32).',
    { item: str, radius: int },
    []
  ),
  tool(
    'fish',
    'Fish with a fishing rod at open water nearby: walks to the dry bank (never into the water) and casts until count catches (default 1) or minutes pass (default and most 10). Needs a fishing rod; it never makes one.',
    { count: int, minutes: int },
    []
  ),
  tool(
    'attack',
    'Fight mobs: chases the nearest matching mob, hits it at full strength with your best sword or axe until it dies, then picks up the drops. target is a mob type like zombie or cow, or a name tag. Leave it out for the nearest hostile mob; creepers, neutral mobs (enderman, piglin, zombified_piglin), the warden, the creaking, the wither and the ender dragon are only attacked when named. count is how many (default 1, max 10). Never attacks players, and skips mobs with name tags unless you name them. Baby farm animals are left alone unless target says baby (like baby cow) or names a name tag. Stops when your health gets low. With a bow and arrows it shoots targets more than 6 blocks away, flying ones and creepers (never with a player, named mob or farm animal near the line), and fights hand to hand inside 4 blocks; a shield you carry goes in your off hand and is raised between swings and against skeletons and other shooters. The result says how many arrows were shot and how many are left.',
    { target: str, count: int },
    []
  ),
  tool(
    'tend_animals',
    'Look after a pen of farm animals (cow, mooshroom, sheep, pig, chicken, rabbit, goat) in one call: the box from x y z to x2 y2 z2, or the animals within 8 blocks of x y z. animal limits it to one kind. Feeds adults in pairs with the right food you carry (wheat for cows, mooshrooms, sheep and goats; carrots, potatoes or beetroot for pigs; seeds for chickens; dandelions or carrots for rabbits) so they breed, shears sheep if you carry shears, milks into empty buckets only with milk true, then kills adults past keep of each kind (default 4, never below 2), never babies, named animals or ones just fed, and picks up the drops. With cook (default true) puts the raw meat in a furnace or smoker within 32 blocks to cook while you do other things. Set breed or cull false to skip that part. The pen is remembered and looked after in your free time unless tend is false; tend false on a box stops you looking after the pens in it. Returns for each kind the adults, babies, pairs fed, culled and kept, what food was missing or ran out, where the meat is cooking and how much meat you carry. Only when a player asks you to look after, breed or cull their animals.',
    { x: int, y: int, z: int, x2: int, y2: int, z2: int, animal: str, keep: int, breed: { type: 'boolean' }, cull: { type: 'boolean' }, cook: { type: 'boolean' }, milk: { type: 'boolean' }, tend: { type: 'boolean' } },
    ['x', 'y', 'z']
  ),
  tool(
    'equip',
    'Hold an item or wear armor. Leave slot out to pick the right one (armor goes on the body, shield in the off hand, everything else in the main hand).',
    { item: str, slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } },
    ['item']
  ),
  tool(
    'unequip',
    'Take off armor or empty a hand (default hand).',
    { slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } },
    []
  ),
  tool('drop_item', 'Drop items on the ground where you stand. Leave count out to drop all of that item.', { item: str, count: int }, ['item']),
  tool(
    'craft',
    'Craft an item, count is how many you want (default 1). Makes missing parts first when it can (planks from logs, sticks from planks), uses a crafting table within 32 blocks, or makes and places one if there is none.',
    { item: str, count: int },
    ['item']
  ),
  tool(
    'obtain',
    'Get count of an item (default 1, max 256) into your inventory in one call, working out the whole chain: counts what you carry, takes it from chests you remember, crafts it from parts it gets the same way (putting down a crafting table or furnace when needed), smelts it with fuel, or mines and chops the raw materials within 32 blocks, making a good enough pickaxe first. Takes and gathers by the same rules as take_items, mine and chop_tree. Plans again when a step comes up short. Mob drops and anything with no source nearby are left out: it says what is missing and why, along with what it got. plan_only lists the steps and what would be missing without doing anything.',
    { item: str, count: int, plan_only: { type: 'boolean' } },
    ['item']
  ),
  tool(
    'trade',
    'Trade with a villager or wandering trader within 32 blocks, walking up to it: the nearest, the one nearest x y z, or one picked by villager (a profession like librarian, a name tag, villager or wandering_trader). With list, or no item, says what it offers: the cost at the price that villager asks now, what it gives and the uses left. With item, buys it count times (default 1, one trade each), as far as the uses left and what you carry allow; when several offers give it, pay names what to pay with, else the cheapest is taken. Says what you are short of when you cannot pay.',
    { villager: str, item: str, count: int, pay: str, list: { type: 'boolean' }, x: int, y: int, z: int },
    []
  ),
  tool(
    'remember',
    'Save something a player wants you to keep, like a named place ("quarry", "storage chest"), a standing order, or the plan for a build. Kept across restarts and shown in every request. Saving the same name again replaces it. Give x y z for places, and also x2 y2 z2 for a box-shaped area between two corners.',
    { name: str, note: str, x: int, y: int, z: int, x2: int, y2: int, z2: int },
    ['name', 'note']
  ),
  tool('forget', 'Delete a saved memory by name.', { name: str }, ['name']),
  tool(
    'record_area',
    "Learn an area's outline by tracking where someone walks. action start begins tracking player (or yourself if player is left out); use it together with follow_player when a player asks you to follow them around an area to learn it. action save, once they say they're done, saves the walked outline in your memories under name with note. action cancel stops without saving.",
    { action: { type: 'string', enum: ['start', 'save', 'cancel'] }, name: str, note: str, player: str },
    ['action']
  ),
  tool(
    'smelt',
    'Smelt or cook in a furnace: ores and raw metal into ingots, sand into glass, cobblestone into stone, logs into charcoal, raw meat into cooked food. item is what to put in or what you want out (raw_iron and iron_ingot both work), taken from your inventory, so take ores and fuel out of chests first. Burns coal or charcoal you carry (planks, sticks or logs if you have none). Uses the nearest free furnace (a blast furnace for ores, a smoker for food), the one at x y z, or makes and puts one down. Short jobs wait and take the results, long ones keep cooking while you do other things. Leave item out to take finished items out of your furnace (or the one at x y z).',
    { item: str, count: int, x: int, y: int, z: int, wait: { type: 'boolean' } },
    []
  ),
  tool(
    'brew',
    'Brew potions at a brewing stand (the one at x y z, else the nearest). potion is a plain name like healing, swiftness, fire resistance, night vision, water breathing, strength, regeneration, slow falling, poison, weakness, invisibility, leaping, slowness, harming or turtle master, with long, strong or splash in front if wanted. count is how many bottles (default 3, at most 9). It first checks for everything the whole chain needs (water bottles, or glass bottles and water nearby, each ingredient, blaze powder for fuel) and says what is short without making or fetching anything. wait false loads the first step and returns; brew again with the same potion carries on.',
    { potion: str, count: int, x: int, y: int, z: int, wait: { type: 'boolean' } },
    ['potion']
  ),
  tool(
    'enchant',
    'Enchant an item at an enchanting table (the one at x y z, else the nearest within 32 blocks) with lapis lazuli and experience levels you carry. Leave choice out to see the three offers: the level each needs, what it costs and the enchantment the table hints at; nothing is spent. choice 1 to 3 takes that offer (it costs that many levels and lapis) and says what the item has now. Only unenchanted items and books can be enchanted.',
    { item: str, choice: int, x: int, y: int, z: int },
    ['item']
  ),
  tool(
    'repair',
    'Use an anvil (the one at x y z, else the nearest within 32 blocks) on an item you carry. with is a second one of the same item, its repair material (diamond for diamond tools, iron_ingot for iron ones) or an enchanted_book to apply; name renames it, alone or together with with. Says the level cost first and does nothing when you are short of levels or the anvil says it is too expensive (40 levels or more). Reports durability, enchantments and name afterwards.',
    { item: str, with: str, name: str, x: int, y: int, z: int },
    ['item']
  ),
  tool(
    'sleep',
    'Sleep in a bed at night: your own bed, the nearest free one, or the one at x y z. Using a bed also sets your spawn point there, which works in the daytime too.',
    { x: int, y: int, z: int },
    []
  ),
  tool(
    'find_block',
    'Find the nearest blocks of a type, up to 128 blocks away (default 64). Give a full name like oak_log, or a short one like log, chest, or stone to match every kind. Ores only count when exposed to open space you can walk to.',
    { block: str, maxDistance: int },
    ['block']
  ),
  SKILL_TOOL
];
