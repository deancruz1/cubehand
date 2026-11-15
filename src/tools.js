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
    'Get the block at x1 y1 z1, or every block in the box from x1 y1 z1 to x2 y2 z2 (small boxes only), with the way stairs, slabs, logs and trapdoors are turned.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int },
    ['x1', 'y1', 'z1']
  ),
  tool(
    'place_block',
    'Place one block from the inventory at x y z. The spot must be empty and next to a solid block. The block can carry a state, like oak_stairs[facing=north,half=top] (see build_structure).',
    { block: str, x: int, y: int, z: int },
    ['block', 'x', 'y', 'z']
  ),
  tool(
    'break_block',
    'Break the block at x y z and pick up what drops. Equips the best tool in the inventory automatically (pickaxe for stone, axe for wood, shovel for dirt). Protected blocks (chests, beds, furnaces, crafting tables...) are refused unless you placed them yourself or confirmed is true, which you may only set when a player clearly asked you to break that block.',
    { x: int, y: int, z: int, confirmed: { type: 'boolean' } },
    ['x', 'y', 'z']
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
    'build_structure',
    'Build a structure relative to origin (dx, dy, dz offsets), from parts (shapes) and single blocks. Use this for anything bigger than a few blocks. Parts are boxes from one corner to the other: fill (solid), hollow (a closed shell), walls (four walls, no floor or top), frame (only the edges, for beams and posts), line (a straight or diagonal line), and roof (a gable roof of stairs over the walls from..to: from.dy is the layer just above the wall tops; the ridge runs along the longer side, slabs go on an odd ridge, overhang is 0 to 2, default 1, and fill closes the gable ends and the wall tops under the eaves). Later parts and single blocks win where they overlap, and "air" takes out what came before (doorways, windows). A block can carry a state, like the game writes it: spruce_stairs[facing=east,half=top], oak_slab[type=top], stripped_oak_log[axis=x], spruce_trapdoor[facing=south,half=top,open=true], lantern[hanging=true], oak_door[facing=north]. Stairs face the way they climb (the tall side); half=top is upside down. Trapdoors and wall torches face away from the block they hang on. Logs take axis x, y or z. Placed bottom layer first, then every block is checked and fixed once. Set dry_run to get the exact items needed without building.',
    {
      origin: {
        type: 'object',
        properties: { x: int, y: int, z: int },
        required: ['x', 'y', 'z'],
        additionalProperties: false
      },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            shape: { type: 'string', enum: ['fill', 'hollow', 'walls', 'frame', 'line', 'roof'] },
            from: { type: 'object', properties: { dx: int, dy: int, dz: int }, required: ['dx', 'dy', 'dz'], additionalProperties: false },
            to: { type: 'object', properties: { dx: int, dy: int, dz: int }, required: ['dx', 'dy', 'dz'], additionalProperties: false },
            block: str,
            fill: str,
            overhang: int
          },
          required: ['shape', 'from', 'to', 'block'],
          additionalProperties: false
        }
      },
      blocks: {
        type: 'array',
        items: {
          type: 'object',
          properties: { dx: int, dy: int, dz: int, block: str },
          required: ['dx', 'dy', 'dz', 'block'],
          additionalProperties: false
        }
      },
      dry_run: { type: 'boolean' }
    },
    ['origin']
  ),
  tool(
    'build_house',
    'Build a simple survival house: floor, walls, windows, a door, torches, and a flat or stepped gable roof, with ladders between floors. x y z is the middle of the floor at foot level (a standing player\'s position); the floor replaces the ground under it. Clears grass, dirt and other natural blocks out of the way first, and also blocks you placed yourself that don\'t fit the plan, so calling it again over your own house changes that house in place (bigger, more floors, a basement, another door side) and keeps what already fits. Refuses if anything else built or a tree is in the way. Materials default to what you carry most of; give materials to choose (use "none" to leave out the floor, windows or door). Set dry_run to only check the site and get the exact blocks needed. Width and depth are 5 to 15 (default 7), floors 1 to 3, height is the wall height inside each floor, 3 to 5 (default 3). door is the side the door faces (default south). basement digs out one more storey under the ground floor, joined by the ladder. attic lays a floor over the top storey under a gable roof, with a ladder up (needs width and depth of 7 or more). Accent materials: corners for the corner posts (like logs), foundation for the bottom row of the walls and the basement walls (like cobblestone), trim for a band at each floor line and along the top of the walls (logs lie along the wall). Details: a stairs block as roof (like spruce_stairs) makes a stair roof that hangs over the walls, with a slab ridge; sills puts a trapdoor, stairs or slab under each window outside; shutters puts open trapdoors beside each window; porch puts a roof (a slab is best) over the door, held up by posts (like a fence) if given; chimney runs a column (like cobblestone or bricks) up the gable end away from the door; lights picks torch or lantern for inside.',
    {
      x: int,
      y: int,
      z: int,
      width: int,
      depth: int,
      floors: int,
      height: int,
      door: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      roof: { type: 'string', enum: ['gable', 'flat'] },
      basement: { type: 'boolean' },
      attic: { type: 'boolean' },
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
    'Walk to a chest, barrel, or shulker box and put items from the inventory into it. Leave x y z out to use the nearest one that is not a trapped chest (searches 64 blocks). Leave count out to store all of that item.',
    { x: int, y: int, z: int, items: itemList },
    ['items']
  ),
  tool(
    'take_items',
    'Walk to a chest, barrel, or shulker box and take items out of it. Leave x y z out to find each item yourself: takes from the nearest containers you remember holding it, from several if one has too little, then looks in the nearest one you know nothing about (searches 64 blocks), and says what came from where and what is still missing. A trapped chest is only opened when its x y z is given. Leave count out to take all of that item from one container.',
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
    'Mine natural blocks of a type nearby like a player: terrain (stone, deepslate, dirt, sand, gravel...), ores, and natural blocks that double as build materials (sandstone, red_sandstone, obsidian, ice, packed_ice, blue_ice, basalt, blackstone, terracotta, glowstone, magma_block, amethyst_block...). Picks the easiest visible ones first, walks around to reach them, follows veins, grabs ores it passes, avoids lava, and picks up the drops. Never takes blocks you placed or anything in or next to a build, and skips build materials like sandstone or obsidian with anything built within 5 blocks. Crafted blocks like planks, glass, bricks or cobblestone are refused: use break_block on specific blocks once a player has confirmed. Searches 32 blocks around you, so walk to the right area first. Leave block out for stone, count out for 16 (max 64). Use a short name like coal_ore or ore to match every kind. For logs use chop_tree.',
    { block: str, count: int },
    []
  ),
  tool(
    'dig_area',
    'Dig out every block in the box between x1 y1 z1 and x2 y2 z2 in one call: clearing a spot, a hole (a 5x5 hole 3 deep is the box from the top layer down 3), a trench from one point to another, or flattening ground (the box over everything above the new ground level). Works the top layer first and each layer nearest block first, never digs the block it stands on, and picks up the drops. Takes natural terrain like mine does (dirt, stone, sand, gravel, ores, and build materials like sandstone only away from builds) plus grass, flowers, snow and other plants. Leaves everything else and lists it with the reason and where: built or crafted blocks, protected blocks, blocks you placed, logs (use chop_tree), terrain touching a build, blocks with lava next to them or a cave right under them, and blocks your tools can\'t harvest; use break_block for those only once a player confirms. Sand or gravel falling in from above is dug too. Big boxes are refused with the limit, then do it in parts. Returns how many it dug of what, what was left and why, what it picked up and where you are.',
    { x1: int, y1: int, z1: int, x2: int, y2: int, z2: int },
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
    'attack',
    'Fight mobs: chases the nearest matching mob, hits it at full strength with your best sword or axe until it dies, then picks up the drops. target is a mob type like zombie or cow, or a name tag. Leave it out for the nearest hostile mob; creepers, neutral mobs (enderman, piglin, zombified_piglin), the warden, the creaking, the wither and the ender dragon are only attacked when named. count is how many (default 1, max 10). Never attacks players, and skips mobs with name tags unless you name them. Stops when your health gets low.',
    { target: str, count: int },
    []
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
    'sleep',
    'Sleep in a bed at night: your own bed, the nearest free one, or the one at x y z. Using a bed also sets your spawn point there, which works in the daytime too.',
    { x: int, y: int, z: int },
    []
  ),
  tool(
    'find_block',
    'Find the nearest blocks of a type, up to 128 blocks away (default 64). Give a full name like oak_log, or a short one like log, chest, or stone to match every kind.',
    { block: str, maxDistance: int },
    ['block']
  )
];
