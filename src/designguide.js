// The design guide the model fetches with design_guide just before it designs a build: how to
// work, what makes a build look good, and the kits that suit it. It lives here and not in the
// system prompt, so a request like "come here" doesn't pay for it. Kept as data so the parts for
// one structure and one style combine into a short text. The checklist is not in the guide: every
// preview ends with it.
import { kitInfo } from './actions/kits.js';

// How to work, for anything that is designed.
export const METHOD = [
  'Stay within the block budget below and what you have or can obtain; when short, shrink the footprint before dropping detail.',
  'Write the plan in layers: massing, base course, walls and posts, door, windows, roof, detail, surroundings. Later parts win; windows skips spots over a door or behind an earlier post. On a symmetric build set mirror at the centre and write half; once true keeps a part or block single.',
  'preview_structure it. Previews draw the plan in colour over the faded world (terrain, water and obstacles, or flat grass if unloaded); faded blocks are the world, not the plan. dy -1 is the ground layer for paths.',
  'Each preview ends with the Checklist: name every failing point, fix it and preview again, 1 to 3 times. Add a straight view (views south) if a porch hides the entrance; use cut_above for interiors. Then build_structure it and check with view_area.',
  'What the players asked for (size, materials, style, plain or quick) always wins over this guide.'
];

// General advice by topic. Each structure picks the topics that apply to it.
export const TOPICS = {
  massing: {
    title: 'Massing',
    lines: [
      'Up to 9 by 9 one box works when the roof, chimney and front give it a silhouette. Over 9 add a lower wing (L or T) or porch; over 15 a side split the roof.',
      'Use odd widths (5, 7, 9, 11) so the door and ridge centre. Make walls 4 to 5 high with the base course; start the roof on the layer above.'
    ]
  },
  depth: {
    title: 'Depth',
    lines: [
      'Get depth from overhang 1 on all sides, an upside-down stair head over every window and door, a sill or stone course below, a log band at the wall top, and a stepped chimney. Corner posts may sit flush.',
      'Put flush posts at corners only (every over the wall length). On a long wall set proud true so later windows skip post spots. Put a front layer (facade kit) on the entrance side only.'
    ]
  },
  palette: {
    title: 'Materials',
    lines: [
      'Two or three families: light plank or stone walls, contrasting wood or stone for the roof and frame, stone for the base course and chimney. Pairs: oak with spruce, birch with oak, oak with jungle, jungle with spruce.',
      'Vary by position, not noise: darker base course, corner posts, floor band, distinct floor. Frames, roofs, trim and windows use one block each. A mixed wall or base uses 10 to 20 percent of one second block (85%stone_bricks,15%cobblestone) in patches.',
      'Cheap: wood, cobblestone, stone_bricks, deepslate_bricks, sandstone, glass; calcite, terracotta and wool as accents; concrete, quartz and copper are costly. Pick by what the players have and what stands nearby, not always the first.'
    ]
  },
  roofs: {
    title: 'Roofs',
    lines: [
      'Frame every pitched roof: one block for the field, a contrasting edge on the eaves, gable ends and ridge: {"shape":"roof","block":"@roof","edge":"@trim","fill":"@wall","overhang":1}.',
      'Use pitch 1 and overhang 1 so the roof is as tall as the walls. gable on houses (axis sets the ridge), hip on square sheds and storehouses, pyramid on square towers, cone on round ones, shed or pitch 0.5 on porches, flat only on desert, modern or fortified builds.',
      'Add a chimney on a house or cabin, outside a gable end or through the roof, 2 above the ridge.'
    ]
  },
  openings: {
    title: 'Openings',
    lines: [
      'Place 1 by 2 windows in pairs or threes, 1 block apart, centred. Every wall over 5 long needs windows; keep glass to 2 to 5 percent of the surface.',
      'A window kit per wall adds glass with stair head and sill: box the centred glass row (3 wide for a pair, 5 for three, 2 high, 1 deep), every 2, facing out. Or use a windows shape (width 1, every 2) for glass alone.',
      'Centre the door under a stair hood or porch, with a light each side and a step if raised.'
    ]
  },
  surroundings: {
    title: 'Surroundings',
    lines: [
      'Add a 3-wide ragged path to the door, leaf bushes at the wall foot, a barrel by the door, and entrance planters.',
      'Place one light per 50 to 90 blocks: at the door, corners and path. On a slope set foundation so the base reaches ground.'
    ]
  },
  interior: {
    title: 'Interior',
    lines: [
      'Use a floor distinct from the walls; make rooms 3 to 4 high inside with a stone lower band in wood rooms.',
      'Hang lanterns from the ceiling, never floor torches. Place two or three kits against the walls and leave a walkway clear.',
      'Make stairs walkable: a staircase part with 3 air blocks above each step, or a ladder under a floor opening.'
    ]
  }
};

const INSIDE = 'For the inside, fetch design_guide with structure interior.';

// One section per kind of structure: which topics apply, its block budget (whole build, inside
// included), what is special about it, and the kits that suit it with a note on each.
export const STRUCTURES = {
  house: {
    aliases: ['home', 'cottage', 'villa', 'mansion', 'inn', 'tavern'],
    topics: ['massing', 'depth', 'palette', 'roofs', 'openings', 'surroundings'],
    budget: '450 to 700 blocks',
    lines: [
      '9 by 9 to 11 by 13. Over 9 use an L or T: main block plus a lower wing under a cross gable, door in the L corner or centred in front.',
      'Give a second floor a floor-line band and lighter infill, or step it out on upside-down stairs. ' + INSIDE
    ],
    kits: [['window', 'variant 1, or 2 for shutters'], ['door', 'variant 2'], ['chimney', ''], ['facade', 'entrance side only'], ['path', '']]
  },
  cabin: {
    aliases: ['log cabin', 'lodge', 'shack', 'hut'],
    topics: ['massing', 'depth', 'palette', 'roofs', 'openings', 'surroundings'],
    budget: '250 to 450 blocks',
    lines: [
      'One box 7 by 6 to 9 by 9: stone base course (dy 0), light plank or stone walls to dy 3 or 4, flush log corners, framed gable roof above.',
      'Give it a front: a porch on the door side, or a stair hood over the door with planters and a barrel. Add a gable-end chimney. ' + INSIDE
    ],
    kits: [['window', 'variant 1, or 2 for shutters'], ['door', 'variant 2'], ['porch', 'variant 1, door side'], ['chimney', ''], ['path', '']]
  },
  tower: {
    aliases: ['watchtower', 'lookout', 'keep', 'lighthouse', 'spire', 'turret'],
    topics: ['depth', 'palette', 'roofs'],
    budget: '900 to 1,200 blocks',
    lines: [
      'A shaft 5 by 5 to 9 by 9, about three times as tall as wide, on a stone base 1 wider and 3 to 5 high. Set timber posts on stone feet, never grass.',
      'Every 5 to 6 blocks add a band or floor jutting out on upside-down stairs; narrow 1 by 2 windows, one per wall per floor.',
      'Corbel the top wider than the shaft: an open lookout on log posts with a fence rail under a steep roof (pitch 2), with a spire on cone roofs. Roof and lookout take about a third of the total height.',
      'Inside, run a ladder up one wall through a hole in each floor.'
    ],
    kits: [['battlements', 'for a stone top instead of a roof'], ['door', 'variant 2'], ['window', '1 wide, variant 1']]
  },
  wall: {
    aliases: ['wall and gate', 'gate', 'gatehouse', 'palisade', 'fort', 'fortification', 'rampart', 'castle wall', 'walls'],
    topics: ['depth', 'palette'],
    budget: 'a stretch 12 long about 150 to 250 blocks, a gatehouse 300 to 500',
    lines: [
      'Sections 9 to 15 long, 5 to 7 high and 2 or 3 thick with a top walkway and a darker stone base course one block out.',
      'Place a buttress or tower every 6 to 10 blocks; never leave a long wall unbroken.',
      'Make the gate a gatehouse taller than the wall and 2 blocks proud on both faces, with a 3 to 5 wide arch framed in lighter stone, lanterns each side, iron_bars across the top and paired banners above.'
    ],
    kits: [['battlements', 'extra on the outer face'], ['buttress', ''], ['archway', 'the gate'], ['lamp_post', '']]
  },
  bridge: {
    aliases: ['crossing', 'footbridge', 'viaduct'],
    topics: ['depth', 'palette'],
    budget: 'about 10 blocks per block of length for a deck 3 wide with rails, plus piers',
    lines: [
      'A deck 3 to 5 wide starting at bank level, rising 1 or 2 toward the middle on stairs or slabs, with solid stone abutments into each bank.',
      'Over 8 blocks of water, add piers every 4 to 6 blocks from the riverbed, or cut arches out of a solid span.',
      'Add fence or wall railings on both edges, a light at each end, and upside-down stairs under the deck edges. Check the faded water and banks in the preview so both ends land on ground.'
    ],
    kits: [['archway', 'for arches through a solid span'], ['lamp_post', 'at each end']]
  },
  barn: {
    aliases: ['storehouse', 'storage', 'warehouse', 'shed', 'stable', 'granary', 'workshop', 'smithy'],
    topics: ['massing', 'depth', 'palette', 'roofs', 'openings'],
    budget: '300 to 550 blocks',
    lines: [
      'A storehouse: 7 by 7 to 9 by 11, walls 4 to 5 high, stone base course, log corners, a framed hip or gable roof, and narrow windows or fence vents with stair heads and sills.',
      'A barn: a long gable building with double doors 2 or 3 wide under a full-width beam and a loft opening above.',
      'Inside: storage walls of chests and barrels along the long walls, a clear 2 to 3 wide aisle, and lanterns hung over the aisle.'
    ],
    kits: [['window', 'variant 1'], ['door', 'variant 2, 2 wide'], ['storage_wall', 'one per long inside wall'], ['ceiling_light', '']]
  },
  farm: {
    aliases: ['field', 'farmland', 'crops', 'pen', 'animal pen', 'orchard'],
    topics: ['palette', 'surroundings'],
    budget: 'a 9 by 9 field with border and fence about 100 to 150 blocks',
    lines: [
      'Fields 9 by 9 round one water block covered with a slab, a log border round each field and paths 1 or 2 wide between.',
      'Ring it with a fence, a gate on the path, lanterns on corner posts, and a small shed or barrel stand.'
    ],
    kits: [['fence_run', 'a ring, extra for lanterns'], ['path', ''], ['planter', '']]
  },
  shop: {
    aliases: ['stall', 'market stall', 'market', 'stand', 'kiosk', 'store', 'trading post'],
    topics: ['palette', 'surroundings'],
    budget: 'a stall 40 to 100 blocks',
    lines: [
      'A stall is 3 by 3 to 3 by 5 and about 4 high, never taller than it is wide or long: use the market stall kit, add goods (barrel, hay_block, chest), bushes, a short path and a lamp post beside it.',
      'A shop building is a house with a display window beside the door and an awning over both.'
    ],
    kits: [['market_stall', 'variant 1'], ['awning', ''], ['lamp_post', '']]
  },
  monument: {
    aliases: ['statue', 'memorial', 'obelisk', 'fountain', 'sculpture', 'shrine', 'altar'],
    topics: ['palette', 'surroundings'],
    budget: '100 to 400 blocks',
    lines: [
      'Start with a stepped plinth 2 or 3 high in a darker stone than the figure.',
      'Compose the figure from shapes: sphere and dome for round forms, cone and pyramid for points, line and posts for limbs; mirror what is symmetric and check all four corner views.'
    ],
    kits: [['planter', 'round the plinth'], ['lamp_post', '']]
  },
  interior: {
    aliases: ['room', 'furniture', 'furnish', 'inside', 'bedroom', 'kitchen', 'hall', 'library'],
    topics: ['interior', 'palette'],
    budget: '30 to 100 blocks a room',
    lines: [
      'Plan the floor first: the doorway, a clear 1 or 2 wide walkway to each feature, furniture against the walls, the middle open.',
      'Give each room one main feature (bed nook, fireplace, table, kitchen, storage wall) with two smaller ones, a rug and a ceiling light. Preview with cut_above just under the ceiling.'
    ],
    kits: [['kitchen', ''], ['fireplace', ''], ['bed_nook', ''], ['table_and_chairs', ''], ['bookshelf_wall', ''], ['ceiling_light', '']]
  },
  garden: {
    aliases: ['path', 'park', 'yard', 'courtyard', 'plaza', 'square', 'pond'],
    topics: ['palette', 'surroundings'],
    budget: '50 to 200 blocks',
    lines: [
      'Lay paths 2 or 3 wide with a curve or turn, flower planters in clusters of 3 to 5, a tree or well, benches and a leaf hedge.'
    ],
    kits: [['path', ''], ['tree', ''], ['bench', ''], ['lamp_post', 'every 6 to 8 blocks'], ['well', '']]
  },
  other: {
    aliases: [],
    topics: ['massing', 'depth', 'palette', 'roofs', 'openings', 'surroundings'],
    budget: 'like the build it most resembles: a cabin 250 to 450, a house 450 to 700',
    lines: ['Match the closest structure (house, tower, wall, monument) and borrow its proportions and details.'],
    kits: [['window', ''], ['door', ''], ['path', '']]
  }
};

// Palettes per style; each palette is ready for plan palette. Pitched styles give every palette
// a roof field (roof) and a roof frame (trim) for the roof part's edge.
export const STYLES = {
  rustic: {
    aliases: ['cottage', 'farmhouse', 'cozy', 'cosy', 'country', 'village', 'wooden', 'wood'],
    lines: ['Light plank walls, flush log corners, stone base course, framed gable roof, planters, barrels and a path to the door.'],
    palettes: [
      { label: 'oak and stone', roles: { foundation: '85%stone_bricks,15%cobblestone', frame: 'oak_log', wall: 'oak_planks', roof: 'stone_brick_stairs', trim: 'spruce_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } },
      { label: 'birch and spruce', roles: { foundation: 'cobblestone', frame: 'spruce_log', wall: 'birch_planks', roof: 'spruce_stairs', trim: 'cobblestone_stairs', floor: 'oak_planks', glass: 'glass_pane', light: 'lantern' } },
      { label: 'all wood', roles: { foundation: 'stone_bricks', frame: 'oak_log', wall: 'stripped_oak_log', roof: 'spruce_stairs', trim: 'oak_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } }
    ]
  },
  medieval: {
    aliases: ['castle', 'tudor', 'timber', 'half-timber', 'stone'],
    lines: ['Stone ground floor, timber-framed upper floor stepped out on upside-down stairs, light infill between dark beams, framed gable roof and chimney.'],
    palettes: [
      { label: 'timber', roles: { foundation: 'stone_bricks', frame: 'spruce_log', wall: 'polished_diorite', roof: 'spruce_stairs', trim: 'stone_brick_stairs', floor: 'oak_planks', glass: 'glass_pane', light: 'lantern' } },
      { label: 'stone', roles: { foundation: 'deepslate_bricks', frame: 'spruce_log', wall: '85%stone_bricks,15%cobblestone', roof: 'deepslate_tile_stairs', trim: 'spruce_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } }
    ]
  },
  modern: {
    aliases: ['contemporary', 'minimal', 'minimalist', 'futuristic'],
    flat: true,
    lines: ['Flat roofs with a parapet, wide windows (2 or 3 wide, often full height), cantilevered upper volumes, two or three clean blocks without mixes, dark wood accents.'],
    palettes: [
      { label: 'cheap', roles: { foundation: 'polished_deepslate', wall: 'polished_diorite', frame: 'stripped_dark_oak_log', roof: 'polished_deepslate_stairs', floor: 'birch_planks', glass: 'glass', light: 'lantern' } },
      { label: 'costly', roles: { foundation: 'gray_concrete', wall: 'white_concrete', frame: 'light_gray_concrete', roof: 'polished_andesite_stairs', floor: 'dark_oak_planks', glass: 'glass', light: 'sea_lantern' } }
    ]
  },
  fantasy: {
    aliases: ['magic', 'magical', 'fairy', 'elven', 'wizard', 'whimsical'],
    lines: ['Steep framed roofs (pitch 2 on spans up to 7), cone roofs with spires on round towers, jutting upper floors, a crooked chimney, leaf vines and lanterns.'],
    palettes: [
      { label: 'cheap', roles: { foundation: 'stone_bricks', frame: 'dark_oak_log', wall: 'stripped_birch_log', roof: 'spruce_stairs', trim: 'birch_stairs', glass: 'glass_pane', light: 'lantern', accent: 'azalea_leaves' } },
      { label: 'costly', roles: { foundation: 'deepslate_bricks', frame: 'stripped_cherry_log', wall: 'calcite', roof: 'deepslate_tile_stairs', trim: 'cherry_stairs', glass: 'glass_pane', light: 'lantern', accent: 'amethyst_block' } }
    ]
  },
  japanese: {
    aliases: ['asian', 'oriental', 'pagoda', 'temple', 'zen'],
    lines: [
      'Low and wide: raise the floor a block on a deck of light stairs and slabs over log beams; dark posts round light panels (stripped_birch_log or calcite); a low hip roof at pitch 0.5 in two alternating dark blocks with corner stairs turned out; trapdoor screens and hanging lanterns.'
    ],
    palettes: [
      { label: 'deepslate', roles: { foundation: 'spruce_log', floor: 'birch_planks', frame: 'spruce_log', wall: 'stripped_birch_log', roof: 'deepslate_brick_stairs', trim: 'cobbled_deepslate_stairs', glass: 'glass_pane', light: 'lantern', accent: 'calcite' } },
      { label: 'dark wood', roles: { foundation: 'stone_bricks', floor: 'spruce_planks', frame: 'stripped_dark_oak_log', wall: 'birch_planks', roof: 'deepslate_tile_stairs', trim: 'dark_oak_stairs', glass: 'glass_pane', light: 'lantern', accent: 'spruce_trapdoor' } }
    ]
  },
  desert: {
    aliases: ['sandstone', 'arabian', 'egyptian', 'mesa', 'adobe'],
    flat: true,
    lines: [
      'Flat walls and flat roofs with a merlon parapet (battlements kit). Recess 1 by 2 windows a block into the wall with cut_sandstone_slab sills and oak_trapdoor shades; frame corners and bands in cut_sandstone; add a terracotta border and azalea_leaves.'
    ],
    palettes: [
      { label: 'sandstone', roles: { foundation: 'sandstone', wall: 'smooth_sandstone', frame: 'cut_sandstone', roof: 'smooth_sandstone_stairs', light: 'lantern', accent: 'blue_terracotta', accent2: 'oak_trapdoor' } },
      { label: 'red sandstone', roles: { foundation: 'red_sandstone', wall: 'smooth_red_sandstone', frame: 'cut_red_sandstone', roof: 'smooth_red_sandstone_stairs', light: 'lantern', accent: 'cyan_terracotta', accent2: 'spruce_trapdoor' } },
      { label: 'mud brick', roles: { foundation: 'packed_mud', wall: 'mud_bricks', frame: 'stripped_jungle_log', roof: 'mud_brick_stairs', floor: 'jungle_planks', light: 'lantern', accent: 'white_terracotta', accent2: 'jungle_trapdoor' } }
    ]
  },
  nordic: {
    aliases: ['viking', 'scandinavian', 'norse', 'longhouse', 'winter'],
    lines: ['Long low halls with walls 3 or 4 high, a framed gable roof reaching low with overhang 2, crossed beams at the gable peaks, and a heavy stone base.'],
    palettes: [
      { label: 'spruce and deepslate', roles: { foundation: 'deepslate_bricks', frame: 'spruce_log', wall: 'spruce_planks', roof: 'spruce_stairs', trim: 'deepslate_brick_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern', accent: 'spruce_trapdoor' } },
      { label: 'dark with light trim', roles: { foundation: 'cobblestone', frame: 'dark_oak_log', wall: 'stripped_spruce_log', roof: 'dark_oak_stairs', trim: 'birch_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } }
    ]
  },
  other: {
    aliases: [],
    lines: ['Match the wood and stone around the site and pick a palette with light walls and a contrasting roof frame.'],
    palettes: [
      { label: 'oak and stone', roles: { foundation: '85%stone_bricks,15%cobblestone', frame: 'oak_log', wall: 'oak_planks', roof: 'stone_brick_stairs', trim: 'spruce_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } },
      { label: 'birch and spruce', roles: { foundation: 'cobblestone', frame: 'spruce_log', wall: 'birch_planks', roof: 'spruce_stairs', trim: 'cobblestone_stairs', floor: 'oak_planks', glass: 'glass_pane', light: 'lantern' } },
      { label: 'spruce and deepslate', roles: { foundation: 'deepslate_bricks', frame: 'spruce_log', wall: 'spruce_planks', roof: 'spruce_stairs', trim: 'deepslate_brick_stairs', floor: 'spruce_planks', glass: 'glass_pane', light: 'lantern' } }
    ]
  }
};

// What to look for in a preview or a view_area picture, each with what failing looks like. The
// preview appends it to every set of pictures.
export const CHECKLIST = [
  'Size: within the block budget and the size the guide gives, and what you can get? Fails on a small build over 11 wide, a stall taller than it is long, or far more blocks than you have.',
  'Silhouette: does the outline read from far off (a roof shape, a chimney, a wing or porch, a tower top)? Fails on a plain box with a lid.',
  'Roof, where there is one: the field in one block framed in another on the eaves, gable ends and ridge, overhang 1, about as tall as the walls? Fails on one grey mass, an edge flush with the wall or open gable ends.',
  'Materials: each block one job, light walls against a darker roof, variation by position (base course, corners, bands)? Fails on one colour over everything or blocks sprinkled at random.',
  'Base: a darker base course, posts on stone, every part resting on something? Fails on wood straight on the grass or a floating part.',
  'Depth: overhangs, heads over openings, a band or rail breaking each long face? Fails on any face over 5 blocks with nothing on it.',
  'Windows, on a building: pairs or threes of 1 by 2, centred, a head and sill each, on every wall over 5 long? Fails on a blank wall, windows off centre or a post across a window.',
  'Entrance, where there is one: found at a glance, under a hood or porch, lit? Fails on a bare hole in the wall.',
  'Broken parts: anything missing, buried, cut off or turned wrong? Fails on a chimney hidden in the roof or a stair facing the wrong way.',
  'Light: about one light for every 50 to 90 blocks, at the entrance and corners? Fails on a build with none outside.',
  'Surroundings: a path, plants along the entrance side, the build sitting on the faded ground? Fails on a build alone on bare ground, or one that floats over or cuts into the terrain.'
];

// The line that opens the kits section of every guide.
export const KIT_INTRO = 'Use a kit wherever one fits: shape kit, kind, variant, extra, facing out.';

const clean = (text) => String(text ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

// The key of the entry the text names, by key or alias or by its words; null when none fits.
function lookup(table, text) {
  const want = clean(text);
  if (!want) return null;
  const names = (key) => [clean(key), ...table[key].aliases.map(clean)];
  for (const key of Object.keys(table)) if (names(key).includes(want)) return key;
  const words = want.split(' ');
  for (const key of Object.keys(table)) if (names(key).some((n) => n.split(' ').every((w) => words.includes(w)))) return key;
  return null;
}

const section = (title, lines) => `${title}:\n${lines.map((l) => `- ${l}`).join('\n')}`;
const paletteText = (roles) => Object.entries(roles).map(([role, block]) => `"${role}":"${block}"`).join(',');

// A kit as the guide shows it: its own placing line from the kit list, and the structure's note.
function kitText([kind, note]) {
  const kit = kitInfo(kind);
  return `${kind}${note ? `, ${note}` : ''}. ${kit.line}`;
}

export function checklistText() {
  return section('Checklist', CHECKLIST);
}

// The guide for a structure and a style, both optional. Unknown ones fall back to the general
// guide (structure other, style other) and say which exist.
export function guideFor({ structure, style } = {}) {
  const notes = [];
  let s = lookup(STRUCTURES, structure);
  if (!s) {
    if (clean(structure)) notes.push(`There is no section for structure "${structure}", so this is the general one. Structures: ${Object.keys(STRUCTURES).join(', ')}.`);
    s = 'other';
  }
  let st = lookup(STYLES, style);
  if (!st) {
    if (clean(style)) notes.push(`There is no style "${style}", so these are general palettes. Styles: ${Object.keys(STYLES).join(', ')}.`);
    st = 'other';
  }
  const S = STRUCTURES[s];
  const T = STYLES[st];
  const out = [`Design guide: ${s === 'other' ? 'any structure' : s}, ${st === 'other' ? 'any style' : `${st} style`}.`];
  if (notes.length) out.push(notes.join(' '));
  out.push(section('Method', METHOD));
  out.push(section(s === 'other' ? 'Other builds' : `For a ${s}`, [`Budget: ${S.budget}, inside included.`, ...S.lines]));
  for (const topic of S.topics) out.push(section(TOPICS[topic].title, TOPICS[topic].lines));
  const looks = [...T.lines, ...T.palettes.map((p) => `Palette, ${p.label}: {${paletteText(p.roles)}}`)];
  out.push(section(st === 'other' ? 'Style' : `The ${st} style`, looks));
  out.push(section('Ready-made details', [KIT_INTRO, ...S.kits.map(kitText)]));
  return out.join('\n\n');
}
