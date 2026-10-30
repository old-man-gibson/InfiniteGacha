// Map tokens: how a mission map draws the people standing on it. Browser only (it needs
// canvas and the LPC sheets): window.Tokens. Depends on lpc.js.
//
// The two sides are drawn by deliberately different rules.
//
// OURS ARE POGS. The head is cropped out of the character's down-facing LPC frame, dropped in
// a disc with a rim and a name tag, and the disc is what moves. A whole 64x64 body at map scale
// is a smear — six of them shuffling around is unreadable — while a head at the same size is a
// face the player can name, which is the only thing they actually need to track in a log-driven
// fight. The rim carries state (fine, hurt, down, the ward) because a colour ring reads at any
// zoom and a health bar does not.
//
// Enemy tokens are sprites drawn at their own size, because size shows what the enemy is: a rat and a
// colossus should not be the same disc. The art in assets/enemies all faces LEFT, so a sprite
// is flipped horizontally when it stands to the LEFT of the party, which turns it to face them.
// The reference point is the party's centre of mass, so the whole line turns together as the
// squad crosses it rather than each enemy pivoting on its own nearest target.
//
// Pogs are expensive (a crop, a scale, a rounded rect and text) and are built ONCE per
// character, then blitted. Nothing in here allocates during a frame.

(() => {
const TILE = 24;                                   // px per map tile at 1x
// Head box inside a 64x64 LPC down-facing frame. Measured off the sheets rather than guessed:
// the drawn body starts at y 13-16, the eyes sit around y 24 and the shoulders flare at y 28-33.
// The box is placed so the eyes land at ~45% of its height, which is where a portrait wants
// them — a box that merely contains the head puts the face at the bottom under a pile of hair.
// A tall hat loses a row or two off the top; that is the right trade. Heads run 20-22px wide
// and are centred on x 32, which is where the 19..45 band comes from.
const HEAD = { x: 19, y: 13, w: 26, h: 24 };

// Rim colours. State first, then role: a downed ward is still down.
const RINGS = {
  squad:   '#6ea8ff',
  hurt:    '#e0a33a',
  down:    '#8a3a3a',
  ward:    '#ffd740',
  ally:    '#5fbf7f',
  carrier: '#c07de0',   // whoever is holding the prize
};

// Enemy draw height as a multiple of a tile, by bestiary grade (missions.js TIERS).
const GRADE_SIZE = { basic: 1.5, veteran: 1.8, elite: 2.2, ancient: 3.0, legendary: 4.2 };

const scratch = () => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  return c;
};
let SCRATCH = null;

/** The head alone, cropped out of an LPC frame, at native resolution. */
function headCanvas(layers, { row = null, frame = 0, box = HEAD } = {}) {
  if (!SCRATCH) SCRATCH = scratch();
  const sctx = SCRATCH.getContext('2d');
  LPC.drawFrame(sctx, layers, row == null ? LPC.ROW_DOWN : row, frame);
  const out = document.createElement('canvas');
  out.width = box.w; out.height = box.h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(SCRATCH, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Build one character's token: a head in a disc with a name tag under it. Returns a canvas
 * carrying `anchor`, the point inside it that sits on the character's map position (the centre
 * of the disc — the tag hangs below and is never what the geometry is about).
 */
function pog(layers, { name = '', size = 40, ring = RINGS.squad, tag = true, font = 11, box = HEAD } = {}) {
  const head = headCanvas(layers, { box });
  const pad = 3;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `600 ${font}px system-ui, sans-serif`;
  const tw = tag && name ? Math.ceil(probe.measureText(name).width) + 10 : 0;
  const tagH = tag && name ? font + 6 : 0;

  const out = document.createElement('canvas');
  out.width = Math.max(size + pad * 2, tw);
  out.height = size + pad * 2 + (tagH ? tagH + 2 : 0);
  const ctx = out.getContext('2d');
  const cx = out.width / 2, cy = pad + size / 2, r = size / 2;

  // disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1b22';
  ctx.fill();
  ctx.clip();
  // the head fills the disc: scale so the crop's larger side covers the circle. The framing is
  // already in HEAD, so this is a straight centre — no second fudge on top of the first.
  ctx.imageSmoothingEnabled = false;
  const s = (size * 1.15) / Math.max(head.width, head.height);
  ctx.drawImage(head, cx - head.width * s / 2, cy - head.height * s / 2, head.width * s, head.height * s);
  ctx.restore();

  // rim
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ring;
  ctx.stroke();

  // name tag
  if (tagH) {
    const ty = pad + size + 2;
    roundRect(ctx, cx - tw / 2, ty, tw, tagH, 3);
    ctx.fillStyle = 'rgba(12,12,16,.82)';
    ctx.fill();
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.fillStyle = '#e6e6ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, cx, ty + tagH / 2 + 0.5);
  }

  out.anchor = { x: out.width / 2, y: pad + size / 2 };
  return out;
}

/** Blit a built pog so its disc centre lands on (x, y). */
function drawPog(ctx, token, x, y, k = 1) {
  if (k === 1) { ctx.drawImage(token, Math.round(x - token.anchor.x), Math.round(y - token.anchor.y)); return; }
  // Stretched rather than rebuilt: the zoom rebuilds pogs at the new size (FieldView.rescale),
  // and this only covers the frames between a zoom and the rebuild. Nearest-neighbour, because
  // the art underneath is pixel art and a smoothed half-second of blur reads as a bug.
  const sm = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(token, Math.round(x - token.anchor.x * k), Math.round(y - token.anchor.y * k),
    Math.round(token.width * k), Math.round(token.height * k));
  ctx.imageSmoothingEnabled = sm;
}

/** Centre of mass of whoever is still on the map. Enemies face this. */
function centroid(actors) {
  const live = actors.filter(a => a.alive !== false);
  if (!live.length) return { x: 0, y: 0 };
  return {
    x: live.reduce((s, a) => s + a.x, 0) / live.length,
    y: live.reduce((s, a) => s + a.y, 0) / live.length,
  };
}

/** The sprites face left as drawn, so one standing left of the party has to be mirrored. */
const facesRight = (x, refX) => x < refX;

const enemyHeight = (grade, tile = TILE) => tile * (GRADE_SIZE[grade] || GRADE_SIZE.basic);

/**
 * Draw an enemy standing at (x, y) — its feet, not its middle. `faceX` is the party centroid;
 * pass `flip` instead to override. Enemy art is illustration rather than pixel art, so it is
 * scaled smoothly; the LPC pogs above are not.
 */
function drawEnemy(ctx, img, x, y, { height, faceX = null, flip = null, alpha = 1 } = {}) {
  if (!img || !img.width) return;
  const h = height || TILE * 1.5;
  const w = h * (img.width / img.height);
  const mirror = flip == null ? facesRight(x, faceX == null ? x : faceX) : flip;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.translate(Math.round(x), Math.round(y));
  if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h, w, h);
  ctx.restore();
}

/** A soft ellipse under a sprite, so it reads as standing on the ground rather than floating. */
function drawShadow(ctx, x, y, w, alpha = 0.35) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(x, y, w / 2, w / 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

window.Tokens = { TILE, HEAD, RINGS, GRADE_SIZE, headCanvas, pog, drawPog, drawEnemy, drawShadow, centroid, facesRight, enemyHeight };
})();
