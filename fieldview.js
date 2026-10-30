// Drawing a mission field, and naming the things on it. Browser only: window.FieldView.
// Depends on mapgen.js (tile codes), tokens.js (pogs and sprites) and, for names and art,
// missions.js and bestiary.js.
//
// field.js deals in grades — basic, veteran, elite — because a mission type should not have to
// know a bestiary exists. This is the join: `namer` picks a bestiary entry whose tier matches
// the grade and whose tags overlap the mission's theme, then takes its art from the bestiary's
// portrait table (Bestiary.portrait). That is why a warren extermination fills with slimes and
// spiders while a siege fills with goblins, without either type naming a monster.

(() => {
const T = Mapgen.T;

// Tile colours by archetype family. Outdoors is green, built is stone, underground is dark.
const PALETTE = {
  outdoor: { [T.FLOOR]: '#3b4d35', [T.WALL]: '#1c2419', [T.DOOR]: '#8a6a3e', [T.COVER]: '#2c3a26', [T.ROAD]: '#6b6148', [T.GATE]: '#a07a42', [T.DOWN]: '#6a5a9a', [T.UP]: '#4a4a6a' },
  built:   { [T.FLOOR]: '#403e4a', [T.WALL]: '#5c5a68', [T.DOOR]: '#9a7742', [T.COVER]: '#332f3c', [T.ROAD]: '#55525e', [T.GATE]: '#b08a4a', [T.DOWN]: '#6a5a9a', [T.UP]: '#4a4a6a' },
  under:   { [T.FLOOR]: '#35323e', [T.WALL]: '#17161d', [T.DOOR]: '#8a6a3e', [T.COVER]: '#282630', [T.ROAD]: '#3a3743', [T.GATE]: '#8a6a3e', [T.DOWN]: '#8a7ad0', [T.UP]: '#5a5a80' },
};
const FAMILY = {
  wilds: 'outdoor', road: 'outdoor', ruins: 'outdoor',
  settlement: 'built', outpost: 'built', stronghold: 'built', arena: 'built',
  dungeon: 'under', warren: 'under',
};

// ---------- names and art ----------

const spriteCache = new Map();         // species id -> Image, or null for a species with no portrait

/** The map sprite for a bestiary entry: an Image of the file Bestiary.portrait(def.id) names. */
function spriteFor(def) {
  if (spriteCache.has(def.id)) return spriteCache.get(def.id);
  // asked before the index arrived: answer nothing, but do NOT remember the nothing, or every
  // sprite stays missing for the rest of the session
  if (!Bestiary.ready()) return null;
  const src = Bestiary.portrait(def.id);
  const img = src ? Object.assign(new Image(), { src }) : null;
  spriteCache.set(def.id, img);
  return img;
}

/**
 * Field.start's `name` option: grade + theme in, a species out.
 *
 * A group that already carries a species keeps it. That is not an optimisation — the contract
 * board decides what is out there when the contract is WRITTEN (sortie.js nameCast), because a
 * brief that says "Cave Spider ×12" and then fields wolves is a brief that lies. Rolling here is
 * the fallback for anything that arrives unnamed: a wave, a floor, the field test page.
 */
function namer(group, mission) {
  const all = Object.values(Missions.BESTIARY);
  if (group.species && Missions.BESTIARY[group.species]) {
    const d = Missions.BESTIARY[group.species];
    return { id: d.id, label: d.name, icon: d.icon, sprite: spriteFor(d), attrs: d.attrs, tags: d.tags };
  }
  const tier = MissionTypes.SPECIES_TIER[group.grade] || 'basic';
  const themed = all.filter(m => m.tier === tier && m.tags.some(t => mission.theme.includes(t)));
  const pool = themed.length ? themed : all.filter(m => m.tier === tier);
  const def = pool.length ? pool[Math.floor(Rng.rand() * pool.length)] : all[0];
  // attrs and tags go with it: field.js reads a mind and legs off them (makeActor wits, speedOf)
  return { id: def.id, label: def.name, icon: def.icon, sprite: spriteFor(def), attrs: def.attrs, tags: def.tags };
}

// ---------- drawing ----------

/**
 * The camera. With no options it does what it always did: fit the whole map in the canvas.
 * `zoom` multiplies that fit and `cx, cy` are the tile the view is centred on — clamped so the
 * window never slides off the map, and ignored on an axis the map still fits on. `fit` and
 * `scale` come back out so a caller can tell how far in it is.
 */
function layout(cv, map, { pad = 8, zoom = 1, cx = null, cy = null } = {}) {
  const fit = Math.min((cv.width - pad * 2) / map.w, (cv.height - pad * 2) / map.h);
  const scale = fit * Math.max(1, zoom);
  const axis = (span, tiles, centre) => {
    const total = tiles * scale;
    if (total <= span || centre == null) return (span - total) / 2;
    return Math.max(span - total, Math.min(0, span / 2 - (centre + 0.5) * scale));
  };
  return { scale, fit, zoom: scale / fit, ox: axis(cv.width, map.w, cx), oy: axis(cv.height, map.h, cy) };
}

function drawMap(fx, s, view, { zones = true } = {}) {
  const { scale, ox, oy } = view;
  const pal = PALETTE[FAMILY[s.map.archetype] || 'outdoor'];
  const px = Math.ceil(scale);
  fx.fillStyle = '#15151b';
  fx.fillRect(0, 0, fx.canvas.width, fx.canvas.height);
  for (let y = 0; y < s.map.h; y++) {
    for (let x = 0; x < s.map.w; x++) {
      fx.fillStyle = pal[s.map.at(x, y)] || pal[T.FLOOR];
      fx.fillRect(ox + x * scale, oy + y * scale, px, px);
      if (!s.seen[y * s.map.w + x] && s.map.passable(x, y)) {
        fx.fillStyle = 'rgba(10,10,14,.45)';                  // ground nobody has walked yet
        fx.fillRect(ox + x * scale, oy + y * scale, px, px);
      }
    }
  }
  if (zones) drawZones(fx, s, view);
}

/** The zone rings, their names and the portal. Split out so world3d.js can lay them on its ground. */
function drawZones(fx, s, view) {
  const { scale, ox, oy } = view;
  fx.font = '10px system-ui, sans-serif';
  fx.textAlign = 'center';
  const defence = window.Field && Field.defenceProgress ? Field.defenceProgress(s) : null;
  for (const [name, z] of Object.entries(s.map.zones)) {
    const cx = ox + (z.x + .5) * scale, cy = oy + (z.y + .5) * scale, r = z.r * scale;
    // The ground being defended does not get a dashed ring, it gets a ring that CLOSES: the
    // progress bar is drawn round the thing it is measuring, so the only place a player has to
    // look to know how a defence is going is the place the fighting is.
    if (defence && name === defence.zone) progressRing(fx, cx, cy, r, defence.frac, defence.done);
    else if (name !== 'extraction' || !s.portal) {
      fx.strokeStyle = name === 'extraction' ? 'rgba(110,255,168,.45)' : 'rgba(255,215,64,.3)';
      fx.setLineDash([3, 3]);
      fx.beginPath();
      fx.arc(cx, cy, r, 0, Math.PI * 2);
      fx.stroke();
      fx.setLineDash([]);
    }
    if (name === 'extraction' && s.portal) continue;      // drawn as a portal below, with its own label
    fx.fillStyle = 'rgba(255,255,255,.3)';
    fx.fillText(name, cx, cy - r - 3);
  }
  drawPortal(fx, s, view);
}

// A ring that fills along its own perimeter, clockwise from the top. Used for every "this is
// filling up" on the map — ground being held, a way home being opened — because they are the
// same idea and reading two of them should not need two habits.
const RING_BG = 'rgba(255,255,255,.14)';
function progressRing(fx, cx, cy, r, frac, done = false, colour = null) {
  const f = Math.max(0, Math.min(1, frac || 0));
  fx.lineWidth = 3;
  fx.strokeStyle = RING_BG;
  fx.beginPath();
  fx.arc(cx, cy, r, 0, Math.PI * 2);
  fx.stroke();
  if (f > 0) {
    fx.strokeStyle = colour || (done ? 'rgba(110,255,168,.95)' : 'rgba(255,215,64,.9)');
    fx.lineCap = 'round';
    fx.beginPath();
    fx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
    fx.stroke();
    fx.lineCap = 'butt';
  }
  fx.lineWidth = 1;
}

// What the way home looks like, which is the same four things it is: not there yet, being
// forced open, open, or shut with a number on it.
const PORTAL_LOOK = {
  closed:  { colour: 'rgba(110,255,168,.35)', label: 'extraction' },
  opening: { colour: 'rgba(110,255,168,.8)',  label: 'opening' },
  open:    { colour: 'rgba(120,255,200,1)',   label: 'portal' },
  shut:    { colour: 'rgba(255,110,110,.9)',  label: 'shut' },
};

function drawPortal(fx, s, view) {
  const pt = s.portal;
  if (!pt || pt.x == null) return;
  const { scale, ox, oy } = view;
  const cx = ox + (pt.x + .5) * scale, cy = oy + (pt.y + .5) * scale;
  // the drawn ring is exactly the rule: anywhere inside it is through it (field.js inPortal)
  const r = Math.max(6, (pt.r || 3) * scale);
  const look = PORTAL_LOOK[pt.state] || PORTAL_LOOK.closed;
  const P = MissionTypes.PORTAL;
  let frac = 0, note = '';
  if (pt.state === 'opening') { frac = (pt.progress || 0) / P.open; note = Math.round(frac * 100) + '%'; }
  else if (pt.state === 'open') {
    // an open window is running out, and the ring EMPTIES to say so; the other two just stand open
    frac = pt.shutsAt != null ? Math.max(0, (pt.shutsAt - s.clock) / Math.max(1, pt.shutsAt - (pt.openedAt || 0))) : 1;
    note = pt.shutsAt != null ? MissionTypes.realClock(Math.max(0, pt.shutsAt - s.clock) * MissionTypes.TIME.scale) : 'open';
  } else if (pt.state === 'shut') {
    frac = pt.opensAt ? Math.max(0, Math.min(1, 1 - (pt.opensAt - s.clock) / Math.max(1, P.cycle[1]))) : 0;
    note = MissionTypes.realClock(Math.max(0, (pt.opensAt || 0) - s.clock) * MissionTypes.TIME.scale);
  }
  if (pt.state === 'open') {
    const glow = fx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.6);
    glow.addColorStop(0, 'rgba(120,255,200,.35)');
    glow.addColorStop(1, 'rgba(120,255,200,0)');
    fx.fillStyle = glow;
    fx.beginPath(); fx.arc(cx, cy, r * 1.6, 0, Math.PI * 2); fx.fill();
  }
  if (pt.state === 'closed') {
    fx.strokeStyle = look.colour;
    fx.setLineDash([3, 3]);
    fx.beginPath(); fx.arc(cx, cy, r, 0, Math.PI * 2); fx.stroke();
    fx.setLineDash([]);
  } else {
    progressRing(fx, cx, cy, r, frac, pt.state === 'open', look.colour);
  }
  fx.fillStyle = look.colour;
  fx.font = '10px system-ui, sans-serif';
  fx.textAlign = 'center';
  fx.fillText(note ? `${look.label} ${note}` : look.label, cx, cy - r - 4);
}

const ringOf = (a) => a.role === 'ward' ? Tokens.RINGS.ward : a.role === 'prize' ? Tokens.RINGS.carrier : Tokens.RINGS.ally;

// Tokens CHASE their tile rather than being interpolated across one simulation step. At half a
// tile per in-game second most actors stand still on any given step, so a step-locked slide
// reads as lurch-freeze-lurch; an exponential follow spreads the same movement out evenly and
// does not care how the steps fall. `rx, ry` are view state and are never saved.
const SNAP = 3;              // tiles: further than this is a teleport, not a walk
function follow(a, dt) {
  if (a.rx == null || Math.abs(a.x - a.rx) > SNAP || Math.abs(a.y - a.ry) > SNAP) {
    a.rx = a.x; a.ry = a.y;                       // new floor, a respawn, a first sighting
    return;
  }
  // frame-rate independent: closes ~90% of the gap over one simulation step, whatever the fps
  const k = 1 - Math.pow(0.1, Math.min(80, dt) / MissionTypes.TIME.stepMs);
  a.rx += (a.x - a.rx) * k;
  a.ry += (a.y - a.ry) * k;
}

function drawActors(fx, s, view, dt = 16) {
  const { scale, ox, oy } = view;
  for (const a of s.actors) follow(a, dt);
  const sx = (a) => ox + (a.rx + .5) * scale;
  const sy = (a) => oy + (a.ry + .5) * scale;
  const live = s.actors.filter(a => (a.alive || a.subdued) && !a.extracted);
  const ours = live.filter(a => a.role === 'squad');
  const faceX = ours.length ? ours.reduce((n, a) => n + sx(a), 0) / ours.length : fx.canvas.width / 2;

  for (const a of live.filter(x => x.side !== 'ours')) {
    const x = sx(a), y = sy(a);
    const lit = s.seen[a.y * s.map.w + a.x] ? 1 : 0.38;       // unscouted things are ghosts
    if (a.role === 'structure') {
      fx.globalAlpha = lit;
      fx.fillStyle = a.done || !a.alive ? 'rgba(90,90,100,.6)' : '#c08a3a';
      fx.fillRect(x - scale, y - scale, scale * 2, scale * 2);
      fx.globalAlpha = 1;
      continue;
    }
    const h = Math.max(16, Tokens.enemyHeight(a.grade, scale));
    if (a.sprite && a.sprite.complete && a.sprite.naturalWidth) {
      Tokens.drawShadow(fx, x, y + h * 0.06, h * 0.4, 0.3 * lit);
      Tokens.drawEnemy(fx, a.sprite, x, y + h * 0.06, { height: h, faceX, alpha: (a.subdued ? 0.5 : 1) * lit });
    } else {
      fx.globalAlpha = lit;
      fx.font = `${Math.round(h * 0.8)}px system-ui`;
      fx.textAlign = 'center';
      fx.fillText(a.icon || '•', x, y + h * 0.3);
      fx.globalAlpha = 1;
    }
  }

  for (const a of live.filter(x => x.side === 'ours' && x.role !== 'squad')) {
    fx.fillStyle = ringOf(a);
    fx.beginPath();
    fx.arc(sx(a), sy(a), Math.max(4, scale * .7), 0, Math.PI * 2);
    fx.fill();
  }
  // the squad walks one distance field and would stack into a single disc: fan the pogs out at
  // DRAW time only, so a party reads as people without the simulation caring where they stand
  for (const a of ours) {
    if (!a.token) continue;
    // Spread by the size of the pogs rather than the size of a tile: a zoomed-in party whose
    // faces are three times bigger needs three times the elbow room to still read as four people.
    const fan = Math.max(11, pogSize * 0.45);
    // keyed on the actor, not its place in the list: indexing by position means everyone shifts
    // sideways the moment somebody dies or walks off the map
    const i = a.id % 6;
    Tokens.drawPog(fx, a.token, sx(a) + ((i % 3) - 1) * fan, sy(a) + (Math.floor(i / 3) - 0.5) * fan * 1.5);
  }
}

// Pogs are baked canvases, not vector art, so a zoomed-in view wants them REBUILT rather than
// stretched. This is the size they are currently drawn at; rescale() changes it and re-bakes.
let pogSize = 30;
const pogFont = (size) => Math.max(9, Math.round(size / 3));
const bake = (a, size) => Tokens.pog(a.layers, {
  name: a.label, size, font: pogFont(size), ring: Tokens.RINGS[a.ring] || Tokens.RINGS.squad,
});

/** Build the pog for each squad member. Faces come from the character's own LPC layers. */
function faces(s, { size = null } = {}) {
  for (const a of s.actors.filter(x => x.role === 'squad' && !x.token)) {
    const ch = a.char && a.char.selections ? a.char : LPC.generate();
    if (ch !== a.char) a.lookChar = ch;          // world3d.js builds the 3D model from the same roll
    LPC.buildLayers(ch).then(layers => {
      a.layers = layers;
      // pogSize is read HERE, not when faces() was called: a zoom while the art was still
      // loading would otherwise bake the face at the size the view has already left behind.
      a.token = bake(a, size || pogSize);
    });
  }
}

/**
 * Re-bake every squad pog at a new size. Called when the view zooms — not per frame, only when
 * the number actually changes. Returns whether anything was rebuilt.
 */
function rescale(s, size) {
  size = Math.max(16, Math.round(size));
  if (size === pogSize) return false;
  pogSize = size;
  for (const a of s.actors) if (a.role === 'squad' && a.layers) a.token = bake(a, size);
  return true;
}

/** A resumed run has species but no art: hand the sprites back. */
function rehydrate(a) {
  if (!a.species || a.sprite) return;
  const def = Missions.BESTIARY[a.species];
  if (!def) return;
  a.sprite = spriteFor(def);
  if (!a.icon) a.icon = def.icon;
}

/** Rebuild one pog with a different rim, when someone is hurt or down. */
function reface(a, ring, { size = null } = {}) {
  a.ringColour = ring;                  // the 3D view draws the rim as a ring on the ground
  if (!a.layers) return;
  const px = size || pogSize;
  a.token = Tokens.pog(a.layers, { name: a.label, size: px, font: pogFont(px), ring });
}

window.FieldView = { PALETTE, FAMILY, layout, drawMap, drawZones, drawActors, follow, drawPortal, progressRing, faces, reface, rescale, rehydrate, namer, spriteFor };
})();
