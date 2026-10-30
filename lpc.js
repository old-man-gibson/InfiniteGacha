// Race-driven character generator on top of the Universal LPC Spritesheet Character Generator assets.
// Reads catalog.json (built by build_catalog.py) and composites layers from ulpc/spritesheets/.
// LPC art is CC-BY-SA 3.0 / GPL 3.0 / OGA-BY 3.0: ship ulpc/CREDITS.csv with any build.

const SHEETS = 'ulpc/spritesheets/';
const ANIM = 'walk';           // 9 frames x 4 rows (up, left, down, right), 64x64 each
const FRAME = 64, FRAMES = 9, ROW_DOWN = 2;

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const chance = (p) => Math.random() < p;

let CAT = null;
const imgCache = new Map();
const recolorCache = new Map();

// ---------- races: which LPC items each race may use ----------
// skin: [paletteRef, colorName] pairs applied to the body and every match_body_color part.
// parts: { slotName: { items:[ids], p: probability } }  (p defaults to 1)
const RACES = {
  human: {
    bodyTypes: ['male', 'female', 'muscular'],
    heroic: { key: 'starborn',     title: 'Starborn human',   p: 0.02 },
    heads: { male: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_gaunt', 'head/heads/human/heads_human_male_plump'], female: ['head/heads/human/heads_human_female'], muscular: ['head/heads/human/heads_human_male'] },
    skin: [['ulpc', 'light'], ['ulpc', 'amber'], ['ulpc', 'olive'], ['ulpc', 'taupe'], ['ulpc', 'bronze'], ['ulpc', 'brown'], ['ulpc', 'black']],
    hair: 0.95, clothes: 1,
    parts: {},
  },
  draconic: {
    bodyTypes: ['male', 'female', 'muscular'],
    heroic: { key: 'dragonblooded', title: 'Dragon-blooded',  face: 'human' },
    // one in five is dragon-blooded rather than dragon-faced: a human face under the horns,
    // and the heroic stat bonus (not printed on the card)
    humanFace: 0.2,
    humanHeads: { male: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_gaunt'], female: ['head/heads/human/heads_human_female'], muscular: ['head/heads/human/heads_human_male'] },
    humanSkin: [['ulpc', 'light'], ['ulpc', 'amber'], ['ulpc', 'olive'], ['ulpc', 'bronze'], ['all.lpcr', 'ivory'], ['ulpc', 'lavender']],
    heads: { male: ['head/heads/reptile/heads_lizard_male'], female: ['head/heads/reptile/heads_lizard_female'], muscular: ['head/heads/reptile/heads_lizard_male'] },
    skin: [['ulpc', 'green'], ['ulpc', 'dark_green'], ['ulpc', 'bright_green'], ['ulpc', 'blue'], ['ulpc', 'lavender'], ['all.lpcr', 'garnet'], ['all.lpcr', 'amber'], ['all.lpcr', 'charcoal']],
    hair: 0.05, clothes: 1,
    parts: {
      tail: { items: ['body/tails/tail_lizard_alt', 'body/lizard/tail_lizard'] },
      wings: { items: ['body/wings/wings_lizard_alt', 'body/lizard/wings_lizard', 'body/lizard/wings_lizard_bat', 'body/wings/wings_bat'], p: 0.6 },
      horns: { items: ['head/appendages/head_horns_backwards', 'head/appendages/head_horns_curled'], p: 0.7 },
      fins: { items: ['head/appendages/head_fins_fin', 'head/appendages/head_fins_fin_short'], p: 0.4, when: (ch) => !ch.humanFace },
      ears: { items: ['head/ears/head_ears_dragon'], p: 0.5 },
    },
  },
  therian: {
    bodyTypes: ['male', 'female', 'muscular'],
    heroic: { key: 'wildheart',    title: 'Wildheart',        p: 0.03 },
    // four in five therians have a human face and only the ears and tail give them away
    humanFace: 0.8,
    humanHeads: { male: ['head/heads/human/heads_human_male'], female: ['head/heads/human/heads_human_female'], muscular: ['head/heads/human/heads_human_male'] },
    humanSkin: [['ulpc', 'light'], ['ulpc', 'amber'], ['ulpc', 'olive'], ['ulpc', 'taupe'], ['ulpc', 'bronze'], ['ulpc', 'brown']],
    heads: {
      male: ['head/heads/beast/heads_wolf_male', 'head/heads/beast/heads_boarman', 'head/heads/beast/heads_minotaur', 'head/heads/farm/heads_rabbit', 'head/heads/farm/heads_mouse', 'head/heads/farm/heads_rat'],
      female: ['head/heads/beast/heads_wolf_female', 'head/heads/beast/heads_minotaur_female', 'head/heads/farm/heads_rabbit', 'head/heads/farm/heads_mouse'],
      muscular: ['head/heads/beast/heads_wolf_male', 'head/heads/beast/heads_minotaur', 'head/heads/beast/heads_boarman'],
    },
    skin: [['ulpc', 'fur_black'], ['ulpc', 'fur_brown'], ['ulpc', 'fur_tan'], ['ulpc', 'fur_copper'], ['ulpc', 'fur_gold'], ['ulpc', 'fur_grey'], ['ulpc', 'fur_white']],
    hair: 0.3, clothes: 1,
    parts: {
      tail: { items: ['body/tails/tail_wolf', 'body/tails/tail_wolf_fluffy', 'body/tails/tail_cat'] },
      furryEars: { items: ['head/furry_ears/top/head_ears_wolf', 'head/furry_ears/top/head_ears_cat', 'head/furry_ears/side/head_ears_lykon', 'head/furry_ears/side/head_ears_avyon', 'head/furry_ears/side/head_ears_zabos'], p: 0.8 },
    },
  },
  demonic: {
    bodyTypes: ['male', 'female', 'muscular'],
    heroic: { key: 'pitborn',      title: 'Pitborn',          p: 0.05 },
    heads: { male: ['head/heads/human/heads_human_male', 'head/heads/undead/heads_vampire', 'head/heads/human/heads_human_male_gaunt'], female: ['head/heads/human/heads_human_female'], muscular: ['head/heads/human/heads_human_male', 'head/heads/beast/heads_minotaur'] },
    skin: [['all.lpcr', 'garnet'], ['all.lpcr', 'cerise'], ['all.lpcr', 'amethyst'], ['all.lpcr', 'charcoal'], ['all.lpcr', 'indigo'], ['ulpc', 'black'], ['ulpc', 'lavender']],
    hair: 0.6, clothes: 1,
    parts: {
      horns: { items: ['head/appendages/head_horns_curled', 'head/appendages/head_horns_backwards'], p: 0.85 },
      wings: { items: ['body/wings/wings_bat', 'body/lizard/wings_lizard_bat'], p: 0.6 },
      tail: { items: ['body/tails/tail_lizard_alt', 'body/lizard/tail_lizard'], p: 0.6 },
    },
  },
  celestial: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'firstlight',   title: 'Firstlight',       p: 0.05 },
    heads: { male: ['head/heads/human/heads_human_male'], female: ['head/heads/human/heads_human_female'] },
    skin: [['all.lpcr', 'ivory'], ['all.lpcr', 'porcelain'], ['all.lpcr', 'ice'], ['ulpc', 'light'], ['all.lpcr', 'lavender']],
    hair: 0.95, clothes: 1,
    hairColors: [['ulpc', 'platinum'], ['ulpc', 'white'], ['ulpc', 'gold'], ['ulpc', 'blonde']],
    parts: {
      wings: { items: ['body/wings/wings_feathered', 'body/wings/wings_lunar', 'body/wings/pixie/wings_pixie', 'body/wings/pixie/wings_pixie_transparent'], p: 0.9 },
    },
  },
  android: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'awakened',     title: 'Awakened',         p: 0.05 },
    heads: { male: ['head/heads/human/heads_human_male'], female: ['head/heads/human/heads_human_female'] },
    skin: [['all.lpcr', 'gray'], ['all.lpcr', 'dove'], ['all.lpcr', 'ice'], ['all.lpcr', 'charcoal'], ['ulpc', 'light']],
    hair: 0.5, clothes: 1,
    parts: {
      visor: { items: 'type:visor', p: 0.7 },
      armour: { items: ['torso/armour/torso_armour_plate', 'torso/armour/torso_armour_legion'], p: 0.5 },
    },
  },
  robot: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'awakened',     title: 'Awakened',         p: 0.05 },
    heads: { male: ['head/heads/undead/heads_skeleton', 'head/heads/reptile/heads_alien'], female: ['head/heads/undead/heads_skeleton'] },
    bodies: ['body/special/body_skeleton'],
    skin: [['all.lpcr', 'gray'], ['all.lpcr', 'dove'], ['all.lpcr', 'charcoal'], ['all.lpcr', 'black'], ['all.lpcr', 'coffee']],
    hair: 0, clothes: 0.3,
    parts: {
      armour: { items: ['torso/armour/torso_armour_plate'], p: 0.9 },
      legsArmour: { items: ['legs/legs_armour'], p: 0.9 },
      feetArmour: { items: ['feet/feet_armour'], p: 0.9 },
      armsArmour: { items: ['arms/arms_armour'], p: 0.8 },
      visor: { items: 'type:visor', p: 0.6 },
    },
  },
  bug: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'hivemind',     title: 'Hivemind',         p: 0.03 },
    heads: { male: ['head/heads/reptile/heads_alien'], female: ['head/heads/reptile/heads_alien'] },
    skin: [['ulpc', 'dark_green'], ['ulpc', 'green'], ['ulpc', 'blue'], ['ulpc', 'black'], ['all.lpcr', 'emerald'], ['all.lpcr', 'indigo'], ['all.lpcr', 'amber']],
    hair: 0, clothes: 0.7,
    parts: {
      wings: { items: ['body/wings/dragonfly/wings_dragonfly', 'body/wings/dragonfly/wings_dragonfly_transparent', 'body/wings/monarch/wings_monarch', 'body/wings/pixie/wings_pixie'], p: 0.8 },
      fins: { items: ['head/appendages/head_fins_fin', 'head/appendages/head_fins_fin_short'], p: 0.6 },
    },
  },
  orc: {
    bodyTypes: ['male', 'muscular', 'female'],
    heroic: { key: 'tuskblooded',  title: 'Tuskblooded orc',  p: 0.03 },
    heads: { male: ['head/heads/fantasy/heads_orc_male'], muscular: ['head/heads/fantasy/heads_orc_male'], female: ['head/heads/fantasy/heads_orc_female'] },
    skin: [['ulpc', 'green'], ['ulpc', 'dark_green'], ['ulpc', 'pale_green'], ['ulpc', 'olive'], ['all.lpcr', 'fern']],
    hair: 0.6, clothes: 1,
    parts: { ears: { items: ['head/ears/head_ears_big', 'head/ears/head_ears_long'], p: 0.5 } },
  },
  goblin: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'kingsblood',   title: 'Kingsblood goblin', p: 0.03 },
    heads: { male: ['head/heads/fantasy/heads_goblin', 'head/heads/fantasy/heads_troll'], female: ['head/heads/fantasy/heads_goblin'] },
    skin: [['ulpc', 'bright_green'], ['ulpc', 'pale_green'], ['ulpc', 'green'], ['ulpc', 'zombie_green'], ['all.lpcr', 'apple']],
    hair: 0.3, clothes: 1,
    parts: { ears: { items: ['head/ears/head_ears_long', 'head/ears/head_ears_big', 'head/ears/head_ears_down'], p: 0.7 } },
  },
  elf: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'trueelf',      title: 'True elf',         p: 0.03 },
    heads: { male: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_gaunt'], female: ['head/heads/human/heads_human_female', 'head/heads/human/heads_human_female_small'] },
    skin: [['ulpc', 'light'], ['all.lpcr', 'ivory'], ['all.lpcr', 'porcelain'], ['all.lpcr', 'peach'], ['ulpc', 'amber'], ['ulpc', 'olive']],
    hair: 1, clothes: 1,
    hairColors: [['ulpc', 'blonde'], ['ulpc', 'platinum'], ['ulpc', 'sandy'], ['ulpc', 'ash'], ['ulpc', 'redhead'], ['ulpc', 'white']],
    parts: { ears: { items: ['head/ears/head_ears_elven', 'head/ears/head_ears_medium', 'head/ears/head_ears_down'] } },
  },
  darkelf: {
    bodyTypes: ['male', 'female'],
    heroic: { key: 'voidtouched',  title: 'Voidtouched',      p: 0.03 },
    heads: { male: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_gaunt'], female: ['head/heads/human/heads_human_female'] },
    skin: [['ulpc', 'lavender'], ['ulpc', 'blue'], ['ulpc', 'black'], ['all.lpcr', 'charcoal'], ['all.lpcr', 'indigo'], ['all.lpcr', 'heather']],
    hair: 1, clothes: 1,
    hairColors: [['ulpc', 'white'], ['ulpc', 'platinum'], ['ulpc', 'ash'], ['ulpc', 'gray']],
    parts: { ears: { items: ['head/ears/head_ears_hang', 'head/ears/head_ears_down', 'head/ears/head_ears_elven'] } },
  },
  dwarf: {
    bodyTypes: ['teen'],   // the short adult body
    heroic: { key: 'deepforged',   title: 'Deepforged dwarf', p: 0.03 },
    heads: { teen: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_plump', 'head/heads/human/heads_human_female', 'head/heads/human/heads_human_female_small'] },
    skin: [['ulpc', 'light'], ['ulpc', 'amber'], ['ulpc', 'olive'], ['ulpc', 'taupe'], ['ulpc', 'bronze'], ['all.lpcr', 'peach']],
    hair: 0.9, clothes: 1,
    hairColors: [['ulpc', 'redhead'], ['ulpc', 'ginger'], ['ulpc', 'carrot'], ['ulpc', 'chestnut'], ['ulpc', 'dark brown'], ['ulpc', 'black'], ['ulpc', 'gray'], ['ulpc', 'white']],
    parts: {
      beard: { items: ['hair/beards/beards_beard', 'hair/beards/beards_medium', 'hair/beards/beards_winter', 'hair/beards/beards_trimmed'], p: 0.95, when: (ch) => /_male/.test(ch.headId || '') },
      mustache: { items: 'type:mustache', p: 0.5, when: (ch) => /_male/.test(ch.headId || '') },
    },
  },
  halfgiant: {
    bodyTypes: ['muscular'],
    heroic: { key: 'titanblood',   title: 'Titanblood',       p: 0.03 },
    heads: { muscular: ['head/heads/human/heads_human_male', 'head/heads/human/heads_human_male_plump', 'head/heads/human/heads_human_male_gaunt'] },
    skin: [['ulpc', 'taupe'], ['ulpc', 'bronze'], ['ulpc', 'brown'], ['ulpc', 'olive'], ['all.lpcr', 'tawny'], ['all.lpcr', 'coffee']],
    hair: 0.7, clothes: 1,
    parts: { beard: { items: 'type:beard', p: 0.4 } },
  },
};

const CLOTHING_SLOTS = [
  { types: ['clothes'], prefix: 'torso/shirts', p: 1 },
  { types: ['legs'], prefix: 'legs/', p: 0.95 },
  { types: ['shoes'], prefix: 'feet/', p: 0.8 },
];

// ---------- palette helpers ----------
function paletteTable(material, ref) {
  // ref: "ulpc" (same material) | "all.lpcr" | "body.ulpc" (other material)
  let mat = material, version = ref;
  if (ref.includes('.')) [mat, version] = ref.split('.');
  const t = CAT.palettes[mat] && CAT.palettes[mat][version];
  return t ? { mat, version, table: t } : null;
}

function baseColors(recolor) {
  const meta = CAT.materials[recolor.material];
  let version = meta.default, name = meta.base;
  if (recolor.base) {
    if (recolor.base.includes('.')) [version, name] = recolor.base.split('.');
    else name = recolor.base;
  }
  const t = CAT.palettes[recolor.material] && CAT.palettes[recolor.material][version];
  return t && t[name] ? t[name] : null;
}

function randomTarget(recolor) {
  for (let i = 0; i < 6; i++) {
    const p = paletteTable(recolor.material, pick(recolor.palettes));
    if (p) { const keys = Object.keys(p.table); return { ref: `${p.mat}.${p.version}`, name: pick(keys) }; }
  }
  return null;
}

function targetColors(recolor, target) {
  if (!target) return null;
  const p = paletteTable(recolor.material, target.ref);
  if (!p) return null;
  return p.table[target.name] || null;
}

// ---------- image loading & recoloring ----------
function loadImage(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  imgCache.set(src, p);
  return p;
}

function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

function recolorImage(img, mappings, key) {
  // mappings: [{from:[hex...], to:[hex...]}]
  if (recolorCache.has(key)) return recolorCache.get(key);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const pairs = [];
  for (const m of mappings) {
    const n = Math.min(m.from.length, m.to.length);
    for (let i = 0; i < n; i++) pairs.push([hex(m.from[i]), hex(m.to[i])]);
  }
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    for (const [f, t] of pairs) {
      if (Math.abs(r - f[0]) <= 1 && Math.abs(g - f[1]) <= 1 && Math.abs(b - f[2]) <= 1) { d[i] = t[0]; d[i + 1] = t[1]; d[i + 2] = t[2]; break; }
    }
  }
  ctx.putImageData(id, 0, 0);
  recolorCache.set(key, c);
  return c;
}

// ---------- selection ----------
function itemsOfType(type) { return Object.values(CAT.items).filter(i => i.type === type).map(i => i.id); }
function supports(item, bodyType) { return item.layers.some(l => l.paths[bodyType]); }

function resolveItems(spec) {
  if (typeof spec === 'string' && spec.startsWith('type:')) return itemsOfType(spec.slice(5));
  return spec;
}

function pickSupported(ids, bodyType) {
  const ok = ids.filter(id => CAT.items[id] && supports(CAT.items[id], bodyType));
  return ok.length ? pick(ok) : null;
}

// A selection = { id, variant, targets: { slotIndex: {ref,name} } }
function selectItem(id, bodyType, ch, opts = {}) {
  const item = CAT.items[id];
  if (!item || !supports(item, bodyType)) return null;
  const sel = { id, targets: {} };
  const layer = item.layers.find(l => l.paths[bodyType]);
  if (layer.mode === 'variants' && layer.variants) sel.variant = opts.variant || pick(layer.variants);
  item.recolors.forEach((rc, i) => {
    if (item.matchBody && rc.material === 'body') sel.targets[i] = ch.skinTarget;
    else if (opts.hairColor && rc.material === 'hair') sel.targets[i] = opts.hairColor;
    else if (opts.metal && rc.palettes.some(p => p.startsWith('metal'))) sel.targets[i] = { ref: 'metal.ulpc', name: pick(['steel', 'iron', 'silver', 'gold', 'brass', 'copper', 'bronze']) };
    else sel.targets[i] = randomTarget(rc);
  });
  return sel;
}

const SKIPPED_RACES = ['bug', 'robot']; // parts too rough in the LPC set for now
const activeRaces = () => Object.keys(RACES).filter(r => !SKIPPED_RACES.includes(r));

// How common each race is at the gate. Humans are the crowd; the classic humanoids next;
// orcs a step rarer; therians and goblins rare; the otherworldly rarest of all.
const RACE_WEIGHTS = {
  human: 52,
  elf: 8, darkelf: 6, dwarf: 8, halfgiant: 6,
  orc: 6,
  therian: 4, goblin: 3,
  draconic: 1.5, celestial: 1.5, demonic: 1.5, android: 1.5,
};
const HEROIC_BONUS = 4;   // base-stat points a heroic bloodline adds (not printed on the card)

/** The bloodline mark for a race, or null. Draconics earn it with the face; everyone else rolls. */
function rollHeroic(raceName, humanFace) {
  const hero = RACES[raceName] && RACES[raceName].heroic;
  if (!hero) return null;
  const isHero = hero.face ? (hero.face === 'human') === !!humanFace : chance(hero.p || 0);
  return isHero ? { key: hero.key, title: hero.title, bonus: hero.bonus == null ? HEROIC_BONUS : hero.bonus } : null;
}

/** A few extra points on the stats they are already strongest in, capped like everything else. */
function applyHeroicBonus(stats, bonus = HEROIC_BONUS) {
  const base = stats.base;
  const order = [...Stats.BASE_STATS].sort((a, b) => base[b] - base[a]);
  let left = bonus, guard = 0;
  while (left > 0 && guard++ < 50) for (const k of order) { if (left > 0 && base[k] < Stats.STAT_MAX) { base[k]++; left--; } }
  stats.derived = Stats.deriveStats(base);
  return stats;
}

function rollRace() {
  const races = activeRaces();
  const total = races.reduce((a, r) => a + (RACE_WEIGHTS[r] || 1), 0);
  let x = Math.random() * total;
  for (const r of races) { x -= (RACE_WEIGHTS[r] || 1); if (x < 0) return r; }
  return 'human';
}

function generate(raceName, stars = null) {
  raceName = raceName || rollRace();
  const race = RACES[raceName];
  const bodyType = pick(race.bodyTypes);
  const humanFace = !!(race.humanFace && chance(race.humanFace));
  const [ref, name] = pick(humanFace && race.humanSkin ? race.humanSkin : race.skin);
  const ch = { race: raceName, bodyType, skinTarget: { ref: ref.includes('.') ? ref : `body.${ref}`, name }, selections: [] };
  // validate skin colour exists, else fall back
  if (!targetColors({ material: 'body' }, ch.skinTarget)) ch.skinTarget = { ref: 'body.ulpc', name: 'light' };

  const add = (id, opts) => { const s = selectItem(id, bodyType, ch, opts); if (s) ch.selections.push(s); return s; };

  add(race.bodies ? pick(race.bodies) : 'body/body');
  const headId = pickSupported((humanFace ? race.humanHeads : race.heads)[bodyType] || [], bodyType);
  if (headId) add(headId);
  ch.headId = headId;
  ch.humanFace = humanFace;

  const hairColor = race.hairColors ? (() => { const [r, n] = pick(race.hairColors); return { ref: `hair.${r}`, name: n }; })() : null;
  if (chance(race.hair)) {
    const h = pickSupported(itemsOfType('hair'), bodyType);
    if (h) add(h, { hairColor });
  }
  for (const [slot, def] of Object.entries(race.parts)) {
    if (def.when && !def.when(ch)) continue;
    if (!chance(def.p == null ? 1 : def.p)) continue;
    const id = pickSupported(resolveItems(def.items), bodyType);
    if (id) add(id, { hairColor, metal: /armour|visor/.test(id) });
  }
  if (chance(race.clothes)) {
    const hasArmourTorso = ch.selections.some(s => s.id.startsWith('torso/armour'));
    for (const slot of CLOTHING_SLOTS) {
      if (slot.prefix === 'torso/shirts' && hasArmourTorso) continue;
      if (!chance(slot.p)) continue;
      const ids = Object.values(CAT.items).filter(i => slot.types.includes(i.type) && i.id.startsWith(slot.prefix) && !/child|pregnant/.test(i.id)).map(i => i.id);
      const id = pickSupported(ids, bodyType);
      if (id) add(id);
    }
  }
  ch.stats = Stats.rollCharacterStats(raceName, (typeof Rng !== 'undefined' ? Rng.rand : Math.random), stars);
  // Exceptional heroic potential. Every race has a rare bloodline; it is rolled here, written on
  // the character, and never printed on a card. For draconics it IS the human face.
  ch.heroic = rollHeroic(raceName, humanFace);
  if (ch.heroic) applyHeroicBonus(ch.stats, ch.heroic.bonus);
  // Everything that is part of being born has now happened, so the roll is stamped. Nothing after
  // this point writes to it. See Stats.freezeBorn.
  Stats.freezeBorn(ch.stats);
  return ch;
}

// ---------- compositing ----------
async function buildLayers(ch) {
  const out = [];
  // equipped gear rides on top of the character's own look (gear.js)
  const gear = (typeof Gear !== 'undefined' && ch.equipment) ? Gear.selections(ch, CAT) : [];
  for (const sel of [...ch.selections, ...gear]) {
    const item = CAT.items[sel.id];
    for (const layer of item.layers) {
      const path = layer.paths[ch.bodyType];
      if (!path) continue;
      const src = layer.mode === 'variants'
        ? `${SHEETS}${path}${ANIM}/${sel.variant}.png`
        : `${SHEETS}${path}${ANIM}.png`;
      let img = await loadImage(src);
      if (!img) continue;
      if (layer.mode === 'single' && item.recolors.length) {
        const mappings = [];
        item.recolors.forEach((rc, i) => {
          if (!sel.targets[i]) return;
          const from = baseColors(rc), to = targetColors(rc, sel.targets[i]);
          if (from && to) mappings.push({ from, to });
        });
        if (mappings.length) img = recolorImage(img, mappings, src + '|' + JSON.stringify(sel.targets));
      }
      out.push({ z: layer.z, img });
    }
  }
  out.sort((a, b) => a.z - b.z);
  return out;
}

function drawFrame(ctx, layers, row, frame) {
  ctx.clearRect(0, 0, FRAME, FRAME);
  for (const l of layers) {
    if (l.img.width < (frame + 1) * FRAME) continue;
    ctx.drawImage(l.img, frame * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
  }
}

// ---------- public API ----------
async function loadCatalog() {
  if (!CAT) {
    const res = await fetch('catalog.json');
    // a missing file on an http server answers 404 with an HTML page, which would fail in json() with a parse error
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    CAT = await res.json();
  }
  return CAT;
}
window.LPC = { loadCatalog, catalog: () => CAT, generate, buildLayers, drawFrame, activeRaces, rollRace, rollHeroic, applyHeroicBonus, RACE_WEIGHTS, FRAME, FRAMES, ROW_DOWN, itemName: (id) => (CAT.items[id] || {}).name || id };

// ---------- page ----------
// A grid of sprites all walking at once is a recomposite per canvas per frame, enough to make the
// page stutter. Each one holds frame 0 until the pointer is on it, and the loop idles otherwise.
const cards = [];
const walking = new Set();            // entries under the pointer right now
let raf = 0, tick = 0;
function animate() {
  tick++;
  const frame = 1 + (Math.floor(tick / 8) % (FRAMES - 1));
  for (const c of walking) if (c.layers) drawFrame(c.ctx, c.layers, ROW_DOWN, frame);
  raf = walking.size ? requestAnimationFrame(animate) : 0;
}

async function roll() {
  const gridEl = document.getElementById('grid');
  gridEl.innerHTML = '';
  cards.length = 0;
  walking.clear();   // the hovered canvas may have just been thrown away
  const raceFilter = document.getElementById('race').value;
  for (let i = 0; i < 18; i++) {
    const ch = generate(raceFilter || null);
    const card = document.createElement('div');
    card.className = 'card';
    const canvas = document.createElement('canvas');
    canvas.width = FRAME; canvas.height = FRAME;
    const st = ch.stats;
    card.style.borderTop = `3px solid ${Stats.STARS[st.stars].color}`;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${ch.race} / ${ch.bodyType}`;
    const rarity = document.createElement('div');
    rarity.className = 'rarity';
    rarity.style.color = Stats.STARS[st.stars].color;
    rarity.textContent = Stats.starString(st.stars);
    rarity.title = `${st.stars} star`;
    const base = document.createElement('div');
    base.className = 'stats';
    base.innerHTML = Stats.BASE_STATS.map(k => `<span><b>${k.toUpperCase()}</b> ${st.base[k]}</span>`).join('');
    card.append(canvas, label, rarity, base);
    gridEl.append(card);
    const entry = { ctx: canvas.getContext('2d'), layers: null };
    cards.push(entry);
    canvas.addEventListener('pointerenter', () => {
      if (!walking.size) tick = 0;    // start on the first stride, not mid-step
      walking.add(entry);
      if (!raf) raf = requestAnimationFrame(animate);
    });
    canvas.addEventListener('pointerleave', () => {
      walking.delete(entry);
      if (entry.layers) drawFrame(entry.ctx, entry.layers, ROW_DOWN, 0);
    });
    buildLayers(ch).then(layers => { entry.layers = layers; if (!walking.has(entry)) drawFrame(entry.ctx, layers, ROW_DOWN, 0); });
  }
}

async function init() {
  await loadCatalog();
  const sel = document.getElementById('race');
  for (const r of activeRaces()) { const o = document.createElement('option'); o.value = r; o.textContent = r; sel.append(o); }
  document.getElementById('roll').addEventListener('click', roll);
  sel.addEventListener('change', roll);
  roll();
}
if (document.getElementById('roll')) init();
