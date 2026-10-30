// Gear on the sprite: maps a character's equipped items to LPC layers. Browser: window.Gear.
//
// Each item type has a look, and quality picks the metal (copper → iron → steel → silver → gold)
// or, where the sheet has no recolor, a nicer variant at the top of the range. Heavy armour drags
// leg and arm plates along with it; a tower shield gets its trim from Superior up. Layers the body
// type cannot wear (armour torsos have no muscular sheet) are skipped, so a big orc in plate keeps
// the helm, boots and greaves and goes bare-chested until the pack gets that sheet.

(() => {
const METAL = ['copper', 'iron', 'steel', 'silver', 'gold', 'gold'];      // by quality 0..5
const metal = (q) => ({ material: 'metal', target: { ref: 'metal.ulpc', name: METAL[Math.min(5, q)] } });
const leather = () => ({ material: 'cloth', target: { ref: 'cloth.ulpc', name: 'leather' } });

// look(item) -> [{ id, variant?, recolor?: [{material, target}] }]
const LOOKS = {
  // weapons
  sword:   (q) => q >= 5 ? [{ id: 'weapons/sword/weapon_sword_glowsword', variant: 'blue' }]
                         : [{ id: 'weapons/sword/weapon_sword_arming', variant: METAL[q] }],
  axe:     (q) => q >= 4 ? [{ id: 'weapons/blunt/weapon_blunt_waraxe', variant: 'waraxe' }]
                         : [{ id: 'tools/tool_axe', recolor: [metal(q)] }],
  spear:   (q) => [{ id: 'weapons/polearm/weapon_polearm_spear', variant: ['light', 'light', 'medium', 'medium', 'dark', 'red'][q] }],
  bow:     () => [{ id: 'weapons/ranged/weapon_ranged_crossbow', variant: 'crossbow' }],
  dagger:  (q) => q >= 4 ? [{ id: 'weapons/sword/weapon_sword_rapier', variant: 'rapier' }]
                         : [{ id: 'weapons/sword/weapon_sword_dagger', variant: 'dagger' }],
  staff:   (q) => q <= 1 ? [{ id: 'weapons/magic/weapon_magic_simple', variant: 'simple' }]
              : q <= 3 ? [{ id: 'weapons/magic/weapon_magic_gnarled', variant: 'medium' }]
              : q === 4 ? [{ id: 'weapons/magic/weapon_magic_crystal', variant: 'blue' }]
              : [{ id: 'weapons/magic/weapon_magic_diamond', variant: 'light' }],
  // shields
  buckler: () => [{ id: 'weapons/shields/shield_round' }],
  kite:    (q) => [{ id: 'weapons/shields/shield_kite', variant: q >= 3 ? 'kite_blue_blue' : 'kite_gray_gray' }],
  tower:   (q) => [{ id: 'weapons/shields/scutum/shield_scutum', variant: 'scutum' }]
                    .concat(q >= 3 ? [{ id: 'weapons/shields/scutum/shield_scutum_trim', variant: 'scutum_trim' }] : []),
  // armour, keyed by weight + piece
  light_helm:   () => [{ id: 'headwear/coverings/hoods/hat_hood_cloth', recolor: [leather()] }],
  medium_helm:  (q) => [{ id: 'headwear/helmets/helmets/hat_helmet_nasal', recolor: [metal(q)] }],
  heavy_helm:   (q) => [{ id: 'headwear/helmets/helmets/hat_helmet_greathelm', recolor: [metal(q)] }],
  light_mail:   (q) => [{ id: 'torso/armour/torso_armour_leather', recolor: [leather(), metal(q)] }],
  medium_mail:  (q) => [{ id: 'torso/torso_chainmail', recolor: [metal(q)] }, { id: 'arms/wrists/arms_bracers', recolor: [metal(q)] }],
  heavy_mail:   (q) => [{ id: 'torso/armour/torso_armour_plate', recolor: [metal(q)] }, { id: 'legs/legs_armour', recolor: [metal(q)] }, { id: 'arms/arms_armour', recolor: [metal(q)] }],
  light_boots:  () => [{ id: 'feet/boots/feet_boots_basic', recolor: [leather()] }],
  medium_boots: (q) => [{ id: 'feet/boots/feet_boots_rim', recolor: [metal(q)] }],
  heavy_boots:  (q) => [{ id: 'feet/feet_armour', recolor: [metal(q)] }],
};

/**
 * Selections to add on top of a character's own look. Uses the catalog to place recolor targets on
 * the right recolor index and to drop layers the body type has no sheet for.
 */
function selections(c, catalog) {
  const out = [];
  if (!c.equipment || !catalog) return out;
  for (const item of Object.values(c.equipment)) {
    if (!item) continue;
    const look = LOOKS[item.key] || LOOKS[item.type];
    if (!look) continue;
    for (const spec of look(item.quality || 0)) {
      const def = catalog.items[spec.id];
      if (!def || !def.layers.some(l => l.paths[c.bodyType])) continue;
      const sel = { id: spec.id, targets: {}, gear: true };
      if (spec.variant) sel.variant = spec.variant;
      (def.recolors || []).forEach((rc, i) => {
        const want = (spec.recolor || []).find(r => r.material === rc.material);
        if (want) sel.targets[i] = want.target;
      });
      out.push(sel);
    }
  }
  return out;
}

const GearAPI = { LOOKS, METAL, selections };
if (typeof module !== 'undefined') module.exports = GearAPI;
if (typeof window !== 'undefined') window.Gear = GearAPI;
})();
