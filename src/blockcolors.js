// Block name to a flat colour, a simple surface pattern and a shape class, for drawing plans
// without textures. Built from name rules: base materials, then wood species, dye colours,
// copper stages and ores, then derived forms (stairs, slabs, walls...) take their base colour.

const DYES = {
  white: [234, 236, 237], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
  brown: [114, 71, 40], green: [84, 109, 27], red: [160, 39, 34], black: [20, 21, 25]
};
const DYE_RE = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(wool|carpet|concrete|concrete_powder|terracotta|glazed_terracotta|stained_glass|stained_glass_pane|bed|banner|wall_banner|candle|shulker_box|candle_cake)$/;

const WOODS = {
  oak: { planks: [162, 130, 78], bark: [109, 85, 50], stripped: [177, 144, 86], leaves: [77, 113, 38] },
  spruce: { planks: [114, 84, 48], bark: [58, 37, 16], stripped: [115, 89, 52], leaves: [54, 84, 54] },
  birch: { planks: [192, 175, 121], bark: [216, 215, 210], stripped: [196, 176, 118], leaves: [100, 138, 62] },
  jungle: { planks: [160, 115, 80], bark: [85, 67, 25], stripped: [171, 132, 84], leaves: [55, 128, 30] },
  acacia: { planks: [168, 90, 50], bark: [103, 96, 86], stripped: [174, 92, 59], leaves: [90, 118, 35] },
  dark_oak: { planks: [66, 43, 20], bark: [60, 46, 26], stripped: [72, 56, 36], leaves: [50, 84, 25] },
  mangrove: { planks: [117, 54, 48], bark: [84, 66, 41], stripped: [119, 54, 47], leaves: [80, 118, 40] },
  cherry: { planks: [226, 178, 172], bark: [54, 33, 44], stripped: [215, 145, 148], leaves: [229, 173, 194] },
  pale_oak: { planks: [226, 216, 213], bark: [88, 79, 77], stripped: [245, 238, 236], leaves: [115, 121, 108] },
  bamboo: { planks: [194, 173, 80], bark: [127, 140, 50], stripped: [192, 172, 82], leaves: [90, 140, 40] },
  crimson: { planks: [101, 48, 70], bark: [92, 25, 29], stripped: [137, 57, 90], leaves: [114, 3, 2] },
  warped: { planks: [43, 104, 99], bark: [58, 58, 77], stripped: [57, 150, 147], leaves: [22, 119, 121] }
};
const WOOD_RE = /^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(planks|log|wood|stem|hyphae|leaves|block|mosaic)$/;

const COPPER = { '': [192, 107, 79], exposed_: [161, 125, 103], weathered_: [108, 153, 110], oxidized_: [82, 162, 132] };
const ORES = {
  coal: [40, 40, 40], iron: [216, 175, 147], copper: [200, 120, 80], gold: [250, 215, 60], redstone: [200, 20, 10],
  lapis: [30, 70, 180], diamond: [100, 235, 225], emerald: [40, 200, 90]
};
const STONE = [125, 125, 125];
const DEEPSLATE = [80, 80, 82];

// Base materials. A style is [colour, pattern, extra], extra holding a second colour, a top
// colour, an end colour for pillars, alpha for see-through blocks or light for light sources.
const T = (color, pattern = 'none', extra = {}) => ({ color, pattern, ...extra });
const BASE = {
  stone: T(STONE, 'noise'),
  cobblestone: T([122, 122, 122], 'cobble'),
  mossy_cobblestone: T([118, 121, 108], 'mossy', { color2: [100, 114, 82] }),
  stone_bricks: T([122, 121, 122], 'stonebricks'),
  mossy_stone_bricks: T([118, 121, 112], 'mossy_bricks', { color2: [101, 113, 86] }),
  cracked_stone_bricks: T([117, 116, 117], 'cracked'),
  chiseled_stone_bricks: T([120, 119, 120], 'chiseled'),
  smooth_stone: T([158, 158, 158], 'polished'),
  andesite: T([136, 136, 137], 'noise'),
  polished_andesite: T([132, 135, 134], 'polished'),
  diorite: T([188, 188, 188], 'noise'),
  polished_diorite: T([192, 193, 194], 'polished'),
  granite: T([149, 103, 85], 'noise'),
  polished_granite: T([154, 106, 89], 'polished'),
  deepslate: T(DEEPSLATE, 'noise'),
  cobbled_deepslate: T([77, 77, 80], 'cobble'),
  polished_deepslate: T([72, 72, 73], 'polished'),
  deepslate_bricks: T([70, 70, 71], 'bricks', { color2: [52, 52, 54] }),
  cracked_deepslate_bricks: T([64, 64, 65], 'cracked'),
  deepslate_tiles: T([54, 54, 55], 'tiles'),
  cracked_deepslate_tiles: T([50, 50, 51], 'cracked'),
  chiseled_deepslate: T([54, 54, 54], 'chiseled'),
  reinforced_deepslate: T([80, 84, 80], 'polished'),
  tuff: T([108, 109, 102], 'noise'),
  polished_tuff: T([97, 104, 99], 'polished'),
  tuff_bricks: T([98, 102, 95], 'stonebricks'),
  chiseled_tuff: T([90, 96, 90], 'chiseled'),
  chiseled_tuff_bricks: T([98, 102, 95], 'chiseled'),
  blackstone: T([42, 36, 41], 'noise'),
  polished_blackstone: T([53, 48, 56], 'polished'),
  polished_blackstone_bricks: T([48, 42, 49], 'stonebricks'),
  cracked_polished_blackstone_bricks: T([44, 38, 44], 'cracked'),
  chiseled_polished_blackstone: T([53, 48, 56], 'chiseled'),
  gilded_blackstone: T([56, 44, 38], 'ore', { color2: [200, 150, 40] }),
  sandstone: T([216, 203, 155], 'polished'),
  cut_sandstone: T([217, 206, 159], 'stonebricks'),
  chiseled_sandstone: T([216, 203, 155], 'chiseled'),
  smooth_sandstone: T([223, 214, 170]),
  red_sandstone: T([186, 99, 29], 'polished'),
  cut_red_sandstone: T([189, 101, 31], 'stonebricks'),
  chiseled_red_sandstone: T([183, 96, 27], 'chiseled'),
  smooth_red_sandstone: T([181, 97, 31]),
  bricks: T([150, 97, 83], 'bricks', { color2: [180, 170, 160] }),
  mud_bricks: T([137, 103, 79], 'bricks', { color2: [110, 82, 62] }),
  packed_mud: T([142, 106, 79], 'noise'),
  mud: T([60, 57, 60], 'noise'),
  nether_bricks: T([44, 21, 26], 'bricks', { color2: [28, 12, 16] }),
  red_nether_bricks: T([69, 7, 9], 'bricks', { color2: [45, 4, 6] }),
  cracked_nether_bricks: T([40, 20, 24], 'cracked'),
  chiseled_nether_bricks: T([47, 23, 28], 'chiseled'),
  netherrack: T([97, 38, 38], 'noise'),
  quartz_block: T([235, 229, 222]),
  quartz_bricks: T([234, 229, 221], 'stonebricks'),
  quartz_pillar: T([235, 230, 224], 'pillar', { end: [231, 226, 218] }),
  chiseled_quartz_block: T([231, 226, 218], 'chiseled'),
  smooth_quartz: T([235, 229, 222]),
  prismarine: T([99, 156, 151], 'noise'),
  prismarine_bricks: T([99, 171, 158], 'stonebricks'),
  dark_prismarine: T([51, 91, 75], 'tiles'),
  end_stone: T([219, 222, 158], 'noise'),
  end_stone_bricks: T([218, 224, 162], 'stonebricks'),
  purpur_block: T([169, 125, 169], 'tiles'),
  purpur_pillar: T([171, 129, 171], 'pillar', { end: [165, 120, 165] }),
  basalt: T([80, 81, 86], 'pillar', { end: [90, 90, 94] }),
  polished_basalt: T([88, 88, 92], 'pillar', { end: [98, 98, 102] }),
  smooth_basalt: T([72, 72, 78], 'noise'),
  calcite: T([223, 224, 220], 'noise'),
  dripstone_block: T([134, 107, 92], 'noise'),
  pointed_dripstone: T([134, 107, 92]),
  obsidian: T([15, 10, 24], 'noise'),
  crying_obsidian: T([32, 10, 60], 'noise'),
  bedrock: T([85, 85, 85], 'cobble'),
  terracotta: T([152, 94, 67]),
  resin_bricks: T([206, 101, 36], 'bricks', { color2: [170, 80, 28] }),
  resin_block: T([217, 99, 25]),
  chiseled_resin_bricks: T([200, 98, 34], 'chiseled'),

  dirt: T([134, 96, 67], 'noise'),
  coarse_dirt: T([119, 85, 59], 'cobble'),
  rooted_dirt: T([144, 103, 76], 'noise'),
  grass_block: T([134, 96, 67], 'grass', { top: [95, 159, 53] }),
  podzol: T([134, 96, 67], 'grass', { top: [91, 63, 24] }),
  mycelium: T([134, 96, 67], 'grass', { top: [111, 99, 105] }),
  dirt_path: T([148, 122, 65], 'grass', { top: [148, 122, 65] }),
  farmland: T([134, 96, 67], 'noise', { top: [82, 44, 15] }),
  sand: T([219, 207, 163], 'noise'),
  red_sand: T([190, 102, 33], 'noise'),
  suspicious_sand: T([217, 203, 158], 'noise'),
  gravel: T([131, 127, 126], 'cobble'),
  suspicious_gravel: T([128, 124, 122], 'cobble'),
  clay: T([160, 166, 179], 'noise'),
  snow_block: T([249, 254, 254]),
  snow: T([249, 254, 254]),
  powder_snow: T([248, 253, 253]),
  ice: T([145, 183, 253], 'none', { alpha: 0.7 }),
  packed_ice: T([141, 180, 250]),
  blue_ice: T([116, 167, 253]),
  frosted_ice: T([140, 181, 252], 'none', { alpha: 0.7 }),
  moss_block: T([89, 109, 45], 'noise'),
  moss_carpet: T([89, 109, 45], 'noise'),
  pale_moss_block: T([107, 114, 104], 'noise'),
  pale_moss_carpet: T([107, 114, 104], 'noise'),
  mangrove_roots: T([74, 59, 38], 'cobble'),
  muddy_mangrove_roots: T([70, 59, 45], 'cobble'),
  soul_sand: T([81, 62, 50], 'noise'),
  soul_soil: T([75, 57, 46], 'noise'),
  crimson_nylium: T([97, 38, 38], 'grass', { top: [130, 31, 31] }),
  warped_nylium: T([97, 38, 38], 'grass', { top: [43, 114, 101] }),
  nether_wart_block: T([114, 3, 2], 'noise'),
  warped_wart_block: T([22, 119, 121], 'noise'),
  magma_block: T([142, 63, 31], 'ore', { color2: [230, 140, 40], light: true }),
  sculk: T([13, 30, 36], 'noise'),
  sponge: T([195, 192, 74], 'noise'),
  wet_sponge: T([171, 181, 70], 'noise'),
  slime_block: T([111, 192, 91], 'none', { alpha: 0.75 }),
  honey_block: T([251, 185, 52], 'none', { alpha: 0.75 }),
  water: T([63, 118, 228], 'none', { alpha: 0.5 }),
  lava: T([207, 92, 20], 'noise', { light: true }),

  glass: T([200, 225, 235], 'none', { alpha: 0.3 }),
  glass_pane: T([200, 225, 235], 'none', { alpha: 0.3 }),
  tinted_glass: T([44, 38, 46], 'none', { alpha: 0.7 }),
  iron_bars: T([120, 122, 124]),
  chain: T([60, 64, 72]),
  iron_chain: T([60, 64, 72]),

  coal_block: T([16, 15, 15], 'noise'),
  iron_block: T([220, 220, 220], 'polished'),
  gold_block: T([246, 208, 61], 'polished'),
  diamond_block: T([98, 237, 228], 'polished'),
  emerald_block: T([42, 203, 87], 'polished'),
  lapis_block: T([30, 67, 140], 'noise'),
  redstone_block: T([175, 24, 5], 'noise'),
  netherite_block: T([66, 61, 63], 'polished'),
  amethyst_block: T([133, 97, 191], 'noise'),
  budding_amethyst: T([132, 96, 186], 'noise'),
  raw_iron_block: T([166, 135, 107], 'cobble'),
  raw_gold_block: T([221, 169, 46], 'cobble'),
  raw_copper_block: T([154, 105, 79], 'cobble'),
  quartz: T([235, 229, 222]),
  heavy_weighted_pressure_plate: T([220, 220, 220]),
  light_weighted_pressure_plate: T([246, 208, 61]),

  torch: T([255, 205, 90], 'none', { light: true }),
  soul_torch: T([110, 220, 230], 'none', { light: true }),
  redstone_torch: T([230, 40, 20], 'none', { light: true }),
  copper_torch: T([160, 240, 140], 'none', { light: true }),
  lantern: T([235, 170, 70], 'none', { light: true }),
  soul_lantern: T([100, 200, 220], 'none', { light: true }),
  glowstone: T([250, 210, 120], 'noise', { light: true }),
  sea_lantern: T([215, 235, 228], 'tiles', { light: true }),
  shroomlight: T([240, 146, 70], 'noise', { light: true }),
  jack_o_lantern: T([228, 150, 40], 'none', { light: true }),
  redstone_lamp: T([95, 54, 30], 'tiles'),
  ochre_froglight: T([245, 230, 160], 'none', { light: true }),
  verdant_froglight: T([215, 240, 200], 'none', { light: true }),
  pearlescent_froglight: T([240, 220, 225], 'none', { light: true }),
  end_rod: T([240, 235, 225], 'none', { light: true }),
  campfire: T([110, 85, 50], 'none', { light: true }),
  soul_campfire: T([90, 85, 70], 'none', { light: true }),
  beacon: T([170, 230, 225], 'none', { light: true }),
  candle: T([225, 205, 165], 'none', { light: true }),

  pumpkin: T([198, 118, 24], 'pillar', { end: [190, 120, 30] }),
  carved_pumpkin: T([198, 118, 24]),
  melon: T([111, 145, 30], 'pillar', { end: [120, 150, 40] }),
  hay_block: T([166, 136, 38], 'pillar', { end: [180, 150, 50] }),
  bone_block: T([229, 225, 207], 'pillar', { end: [210, 206, 190] }),
  dried_kelp_block: T([50, 58, 38], 'noise'),
  cactus: T([85, 127, 43], 'pillar', { end: [110, 150, 60] }),
  bookshelf: T([162, 130, 78], 'books', { color2: [120, 50, 40] }),
  chiseled_bookshelf: T([162, 130, 78], 'books', { color2: [110, 60, 45] }),
  crafting_table: T([150, 105, 60], 'planks'),
  cartography_table: T([100, 80, 60], 'planks'),
  fletching_table: T([195, 180, 130], 'planks'),
  smithing_table: T([55, 55, 65], 'polished'),
  loom: T([150, 120, 90], 'planks'),
  lectern: T([170, 135, 80], 'planks'),
  composter: T([120, 80, 40], 'planks'),
  barrel: T([134, 100, 58], 'planks'),
  beehive: T([180, 145, 80], 'planks'),
  bee_nest: T([200, 160, 70], 'noise'),
  chest: T([162, 115, 48], 'planks'),
  trapped_chest: T([162, 110, 48], 'planks'),
  ender_chest: T([35, 50, 50], 'polished'),
  furnace: T([110, 110, 110], 'cobble'),
  blast_furnace: T([90, 90, 95], 'polished'),
  smoker: T([95, 85, 75], 'cobble'),
  stonecutter: T([130, 130, 130], 'polished'),
  grindstone: T([140, 140, 140], 'polished'),
  anvil: T([68, 68, 68], 'polished'),
  chipped_anvil: T([68, 68, 68], 'polished'),
  damaged_anvil: T([68, 68, 68], 'polished'),
  cauldron: T([60, 60, 64], 'polished'),
  hopper: T([70, 70, 72], 'polished'),
  brewing_stand: T([120, 110, 90]),
  enchanting_table: T([50, 30, 40], 'polished', { top: [160, 30, 40] }),
  bell: T([240, 190, 60]),
  jukebox: T([110, 72, 52], 'planks'),
  note_block: T([110, 72, 52], 'planks'),
  tnt: T([219, 68, 52], 'none', { top: [200, 190, 170] }),
  target: T([230, 200, 190], 'chiseled'),
  dispenser: T([110, 110, 110], 'cobble'),
  dropper: T([110, 110, 110], 'cobble'),
  observer: T([90, 90, 90], 'polished'),
  piston: T([110, 110, 110], 'cobble', { top: [160, 130, 80] }),
  sticky_piston: T([110, 110, 110], 'cobble', { top: [120, 170, 90] }),
  scaffolding: T([170, 132, 73], 'planks'),
  ladder: T([150, 115, 65], 'planks'),
  vine: T([60, 110, 30], 'leaves'),
  glow_lichen: T([110, 140, 120], 'leaves'),
  flower_pot: T([124, 68, 49]),
  lily_pad: T([32, 128, 48]),
  cake: T([240, 230, 220], 'none', { top: [250, 245, 240] }),
  candle_cake: T([240, 230, 220], 'none', { top: [250, 245, 240] }),
  white_bed: T([234, 236, 237]),
  sugar_cane: T([140, 190, 90]),
  bamboo: T([110, 150, 40]),
  wheat: T([200, 180, 80]),
  carrots: T([80, 150, 40]),
  potatoes: T([80, 150, 40]),
  beetroots: T([80, 140, 40]),
  sweet_berry_bush: T([50, 90, 40]),
  short_grass: T([90, 150, 50]),
  tall_grass: T([90, 150, 50]),
  grass: T([90, 150, 50]),
  fern: T([80, 130, 50]),
  large_fern: T([80, 130, 50]),
  dead_bush: T([120, 90, 40]),
  bush: T([80, 130, 50]),
  firefly_bush: T([90, 120, 50]),
  dandelion: T([240, 220, 40]),
  poppy: T([200, 30, 30]),
  blue_orchid: T([40, 160, 230]),
  allium: T([180, 110, 220]),
  azure_bluet: T([220, 230, 240]),
  oxeye_daisy: T([230, 230, 210]),
  cornflower: T([70, 100, 220]),
  lily_of_the_valley: T([235, 235, 235]),
  wither_rose: T([40, 40, 30]),
  sunflower: T([250, 200, 30]),
  lilac: T([200, 150, 200]),
  rose_bush: T([190, 30, 40]),
  peony: T([230, 170, 210]),
  torchflower: T([240, 120, 40]),
  pitcher_plant: T([100, 140, 200]),
  pink_petals: T([240, 170, 200]),
  wildflowers: T([240, 220, 100]),
  leaf_litter: T([150, 105, 55]),
  azalea: T([90, 117, 44]),
  flowering_azalea: T([150, 110, 150]),
  azalea_leaves: T([90, 117, 44], 'leaves', { alpha: 0.85 }),
  flowering_azalea_leaves: T([110, 110, 70], 'leaves', { alpha: 0.85 }),
  rail: T([130, 110, 80]),
  powered_rail: T([170, 140, 60]),
  detector_rail: T([140, 100, 80]),
  activator_rail: T([150, 80, 60]),
  lightning_rod: T([192, 107, 79]),
  player_head: T([120, 90, 70]),
  skeleton_skull: T([200, 200, 200]),
  creeper_head: T([90, 170, 70]),
  zombie_head: T([70, 120, 70]),
  wither_skeleton_skull: T([40, 40, 40]),
  daylight_detector: T([200, 180, 140]),
  dragon_head: T([30, 28, 34]),
  piglin_head: T([215, 150, 130]),
  shulker_box: T([149, 103, 149]),
  brown_mushroom_block: T([149, 111, 81], 'noise'),
  red_mushroom_block: T([200, 46, 45], 'noise'),
  mushroom_stem: T([203, 196, 185], 'noise'),
  honeycomb_block: T([229, 148, 29], 'tiles'),
  ancient_debris: T([96, 64, 56], 'pillar', { end: [110, 80, 70] }),
  respawn_anchor: T([40, 20, 60], 'polished', { light: true }),
  lodestone: T([147, 149, 152], 'chiseled'),
  decorated_pot: T([140, 80, 60]),
  crafter: T([110, 105, 105], 'polished'),
  spawner: T([35, 45, 60], 'tiles'),
  trial_spawner: T([50, 60, 70], 'tiles'),
  vault: T([60, 70, 80], 'tiles'),
  heavy_core: T([70, 72, 78]),
  dragon_egg: T([20, 10, 25]),
  end_portal_frame: T([92, 138, 110], 'polished', { top: [200, 210, 160] }),
  conduit: T([160, 140, 100]),
  sculk_sensor: T([20, 70, 80], 'noise'),
  calibrated_sculk_sensor: T([20, 70, 80], 'noise'),
  sculk_catalyst: T([30, 40, 40], 'noise'),
  sculk_shrieker: T([200, 200, 180], 'noise'),
  sculk_vein: T([13, 30, 36]),
  creaking_heart: T([88, 79, 77], 'pillar', { end: [200, 120, 60] }),
  cobweb: T([225, 225, 225]),
  lever: T([110, 100, 90]),
  redstone_wire: T([180, 20, 10]),
  repeater: T([160, 160, 160]),
  comparator: T([160, 160, 160]),
  tripwire_hook: T([140, 120, 90]),
  tripwire: T([210, 210, 210]),
  chorus_plant: T([94, 57, 94], 'noise'),
  chorus_flower: T([151, 120, 151], 'noise'),
  turtle_egg: T([230, 230, 200]),
  sniffer_egg: T([150, 70, 60]),
  dried_ghast: T([200, 190, 180]),
  sea_pickle: T([100, 120, 40], 'none', { light: true }),
  frogspawn: T([100, 90, 80]),
  bubble_column: T([63, 118, 228], 'none', { alpha: 0.5 }),
  nether_portal: T([90, 10, 180], 'none', { alpha: 0.6, light: true }),
  resin_clump: T([217, 99, 25]),
  fire: T([240, 150, 40], 'none', { light: true }),
  soul_fire: T([80, 200, 220], 'none', { light: true }),
  water_cauldron: T([60, 60, 64], 'polished'),
  lava_cauldron: T([60, 60, 64], 'polished'),
  powder_snow_cauldron: T([60, 60, 64], 'polished')
};
const CORALS = { tube: [49, 87, 207], brain: [207, 91, 159], bubble: [160, 31, 163], fire: [167, 35, 47], horn: [216, 200, 66] };

const PLANT_RE = /(_sapling|_tulip|_mushroom|_propagule|_roots|_fungus|_crop|_coral|_coral_fan|_coral_wall_fan|eyeblossom|_vines|_vines_plant|amethyst_bud)$|^(cobweb|seagrass|kelp_plant|nether_wart|cocoa|nether_sprouts|golden_dandelion|amethyst_cluster|pale_hanging_moss|(attached_)?(pumpkin|melon)_stem|big_dripleaf_stem|fire|soul_fire|short_grass|tall_grass|grass|fern|large_fern|dead_bush|bush|firefly_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|sugar_cane|bamboo|wheat|carrots|potatoes|beetroots|sweet_berry_bush|azalea|flowering_azalea|short_dry_grass|tall_dry_grass|cactus_flower|hanging_roots|spore_blossom|big_dripleaf|small_dripleaf|kelp|seagrass|tall_seagrass)$/;
const DERIVED_RE = /_(stairs|slab|wall|fence_gate|fence|door|trapdoor|pressure_plate|button|wall_hanging_sign|hanging_sign|wall_sign|sign|pane|shelf)$/;

// A colour for a plant with no entry of its own: its dye colour, its tree's leaves, or green.
function plantColor(name) {
  const dye = Object.keys(DYES).find((d) => name.startsWith(`${d}_`));
  if (dye) return DYES[dye];
  const wood = Object.keys(WOODS).sort((a, b) => b.length - a.length).find((w) => name.includes(w));
  if (wood) return WOODS[wood].leaves;
  if (/dry|dead/.test(name)) return [170, 140, 90];
  if (/golden|cocoa|open_eyeblossom/.test(name)) return [235, 170, 50];
  if (/amethyst/.test(name)) return [170, 120, 220];
  if (/wart/.test(name)) return [140, 30, 30];
  return [80, 130, 50];
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const scale = (a, k) => a.map((v) => Math.min(255, Math.round(v * k)));

function dyeStyle(dye, family) {
  const c = DYES[dye];
  switch (family) {
    case 'concrete': return T(scale(c, 0.9));
    case 'concrete_powder': return T(mix(c, [255, 255, 255], 0.2), 'noise');
    case 'terracotta': return T(scale(mix(c, [152, 94, 67], 0.5), 0.85));
    case 'glazed_terracotta': return T(c, 'glazed', { color2: mix(c, [255, 255, 255], 0.45) });
    case 'stained_glass':
    case 'stained_glass_pane': return T(c, 'none', { alpha: 0.45 });
    case 'candle':
    case 'candle_cake': return T(c, 'none', { light: true });
    case 'wool':
    case 'carpet': return T(c, 'wool');
    default: return T(c);
  }
}

function woodStyle(stripped, species, kind) {
  const w = WOODS[species];
  switch (kind) {
    case 'planks':
    case 'mosaic': return T(w.planks, 'planks');
    case 'log':
    case 'stem':
    case 'block':
      return stripped ? T(w.stripped, 'log', { end: w.planks, color2: w.stripped }) : T(w.bark, 'log', { end: w.stripped, color2: w.planks });
    case 'wood':
    case 'hyphae': return stripped ? T(w.stripped, 'bark') : T(w.bark, 'bark');
    case 'leaves': return T(w.leaves, 'leaves', { alpha: 0.85 });
    default: return null;
  }
}

function lookup(name) {
  if (BASE[name]) return BASE[name];
  if (name.startsWith('infested_')) return lookup(name.slice(9));
  let m = /^(dead_)?(tube|brain|bubble|fire|horn)_coral(_block|_fan|_wall_fan)?$/.exec(name);
  if (m) return T(m[1] ? [130, 123, 119] : CORALS[m[2]], m[3] === '_block' ? 'noise' : 'none');
  m = /^(?:waxed_)?(exposed_|weathered_|oxidized_)?lightning_rod$/.exec(name);
  if (m) return T(COPPER[m[1] ?? '']);
  m = DYE_RE.exec(name);
  if (m) return dyeStyle(m[1], m[2]);
  m = WOOD_RE.exec(name);
  if (m) {
    const s = woodStyle(Boolean(m[1]), m[2], m[3]);
    if (s) return s;
  }
  m = /^(deepslate_)?(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore$/.exec(name);
  if (m) return T(m[1] ? DEEPSLATE : STONE, 'ore', { color2: ORES[m[2]] });
  if (name === 'nether_gold_ore') return T([97, 38, 38], 'ore', { color2: ORES.gold });
  if (name === 'nether_quartz_ore') return T([97, 38, 38], 'ore', { color2: [235, 229, 222] });
  m = /^(?:waxed_)?(exposed_|weathered_|oxidized_)?(.*copper.*)$/.exec(name);
  if (m && !/ore|raw/.test(m[2])) {
    const c = COPPER[m[1] ?? ''];
    const rest = m[2];
    if (/lantern|torch|chain|bars/.test(rest)) return null;
    if (rest.includes('cut')) return T(c, 'tiles');
    if (rest.includes('chiseled')) return T(c, 'chiseled');
    if (rest.includes('grate')) return T(c, 'tiles', { alpha: 0.8 });
    if (rest.includes('bulb')) return T(c, 'chiseled', { light: true });
    return T(c, 'polished');
  }
  // A pot shows its plant's colour; the pot itself is drawn in its own colour.
  if (name.startsWith('potted_')) return lookup(name.slice(7)) ?? T(plantColor(name.slice(7)));
  if (PLANT_RE.test(name)) return T(plantColor(name));
  return null;
}

const cache = new Map();

// The look of a block by name: { color, pattern, color2?, top?, end?, alpha?, light?, known }.
// Unknown names get a neutral grey with known false.
export function blockStyle(name) {
  const hit = cache.get(name);
  if (hit) return hit;
  let style = lookup(name);
  if (!style) {
    const plain = name.replace(/^waxed_/, '');
    const base = plain.replace(DERIVED_RE, '');
    if (base !== plain) {
      const wood = WOODS[base.replace(/^petrified_/, '')];
      if (wood) style = T(/_door$/.test(plain) ? scale(wood.planks, 0.88) : wood.planks, 'planks');
      else {
        for (const b of [base, `${base}s`, `${base}_block`, `${base}_planks`, base.replace(/_brick$/, '_bricks'), base.replace(/_tile$/, '_tiles')]) {
          style = lookup(b);
          if (style) break;
        }
      }
    }
    // Wall torches, wall banners and the like look like the standing kind.
    if (!style && plain.includes('wall_')) style = lookup(plain.replace('wall_', ''));
    if (!style && plain.endsWith('lantern')) style = BASE.lantern;
    if (!style && plain.endsWith('torch')) style = BASE.torch;
    if (!style && plain.endsWith('_chain')) style = BASE.chain;
    if (!style && plain.endsWith('_bars')) style = BASE.iron_bars;
  }
  const out = style ? { ...style, known: true } : { color: [168, 160, 170], pattern: 'none', known: false };
  cache.set(name, out);
  return out;
}

// The shape class of a block by name.
export function shapeOf(name) {
  if (name.endsWith('_stairs')) return 'stairs';
  if (name.endsWith('_slab')) return 'slab';
  if (name.endsWith('_fence_gate')) return 'gate';
  if (name.endsWith('_fence')) return 'fence';
  if (name.endsWith('_pane') || /^(?:waxed_)?(?:exposed_|weathered_|oxidized_)?(iron|copper)_bars$/.test(name)) return 'pane';
  if (name.endsWith('_trapdoor')) return 'trapdoor';
  if (name.endsWith('_door')) return 'door';
  if (/(^|_)wall_torch$/.test(name)) return 'wall_torch';
  if (/(^|_)torch$/.test(name)) return 'torch';
  if (name.endsWith('lantern') && name !== 'jack_o_lantern' && name !== 'sea_lantern') return 'lantern';
  if (name === 'flower_pot' || name.startsWith('potted_')) return 'pot';
  if (name.endsWith('_button') || name === 'lever' || name === 'tripwire_hook') return 'button';
  if (name.endsWith('_carpet') || /^(lily_pad|leaf_litter|pink_petals|wildflowers|redstone_wire|tripwire|frogspawn)$|(^|_)rail$/.test(name)) return 'carpet';
  if (name === 'repeater' || name === 'comparator') return 'plate';
  if (/^(sea_pickle|turtle_egg|sniffer_egg|dried_ghast|conduit|heavy_core|dragon_egg)$/.test(name)) return 'head';
  if (name === 'sculk_vein' || name === 'resin_clump') return 'vine';
  if (name === 'end_portal_frame') return 'table';
  if (name.endsWith('_pressure_plate')) return 'plate';
  if (name === 'snow') return 'snow';
  if (name === 'ladder') return 'ladder';
  if (name === 'vine' || name === 'glow_lichen') return 'vine';
  if (name.endsWith('_bed')) return 'bed';
  if (name.endsWith('chest')) return 'chest';
  if (/_wall_(hanging_)?sign$|_wall_banner$/.test(name)) return 'wall_sign';
  if (/_(hanging_)?sign$|_banner$/.test(name)) return 'sign';
  if (name.endsWith('_wall')) return 'wall';
  if (/(^|_)candle$/.test(name)) return 'candle';
  if (/(^|_)chain$/.test(name)) return 'chain';
  if (name === 'end_rod' || name.endsWith('lightning_rod') || name === 'pointed_dripstone') return 'rod';
  if (name.endsWith('campfire')) return 'campfire';
  if (/_(head|skull)$/.test(name)) return 'head';
  if (name === 'cake' || /_candle_cake$|^candle_cake$/.test(name)) return 'cake';
  if (name === 'dirt_path' || name === 'farmland') return 'path';
  if (name === 'enchanting_table') return 'table';
  if (name === 'water' || name === 'lava') return 'liquid';
  if (PLANT_RE.test(name) && name !== 'mangrove_roots' && name !== 'muddy_mangrove_roots') return 'plant';
  return 'cube';
}
