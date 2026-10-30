// Report: the mission debrief and the bestiary screen. Browser: window.Report.
//
// A run that went through bestiary.record() carries `encounters`: one structured block per fight.
// The debrief reads those and says, per encounter, who they met, who did what, who went down and
// what it cost — and then the whole mission in one line. Older runs without encounters fall back
// to the raw fight log. Every enemy name and fact shown is filtered through Bestiary.knowledge().
//
// renderRun draws a Gate run (missions.js finish) and a sortie report (sortie.js keepReport) with
// the same code. A sortie report differs in these fields: `icon` (the mission's), `party` rows of
// { id, name, role } instead of ids, `fights` (every fight fought, of which `encounters` keeps
// some), and per fight block `width` (ground width) and `startHp` (squad HP percent at the start).
// Every line about a fall states a recorded fact (fight number, killer, source, width, HP) and
// does not give a cause.

(() => {
const $h = (tag, cls, html) => { const el = document.createElement(tag); if (cls) el.className = cls; if (html != null) el.innerHTML = html; return el; };
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const statusName = (id) => (typeof Elements !== 'undefined' && Elements.STATUSES[id]) ? Elements.STATUSES[id].icon + ' ' + Elements.STATUSES[id].name : id;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- debrief ----------
function summary(run) {
  const enc = run.encounters || [];
  const kills = enc.reduce((a, e) => a + e.kills.length, 0);
  const dealt = enc.reduce((a, e) => a + e.party.reduce((x, p) => x + p.dealt, 0), 0);
  const taken = enc.reduce((a, e) => a + e.party.reduce((x, p) => x + p.taken, 0), 0);
  const potions = enc.reduce((a, e) => a + e.party.reduce((x, p) => x + p.potions, 0), 0);
  const downs = enc.reduce((a, e) => a + e.party.filter(p => !p.alive).length, 0);
  return { fights: enc.length, won: enc.filter(e => e.won).length, kills, dealt, taken, potions, downs };
}

const groundText = (w) => `ground width ${w}${typeof Field !== 'undefined' && Field.groundWord ? ', ' + Field.groundWord(w) : ''}`;
const GROUND_TITLE = 'Bodies a side can bring to bear at once, read off the tiles under the squad when the fight opened.';

/** The enemies of a fight as "Name lv 3 ×2, ...", species the town has not seen shown as ???. */
function foeList(e, state) {
  const groups = new Map();
  for (const en of e.enemies) {
    const key = `${en.id}|${en.level}`;
    const g = groups.get(key) || { n: 0, en };
    g.n++;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => `${Bestiary.nameOf(state, g.en.id, g.en.name)} lv ${g.en.level}${g.n > 1 ? ' ×' + g.n : ''}`).join(', ');
}

/**
 * One line per party member who fell, from the fight blocks: the fight, what dropped them and by
 * what, the ground width and the squad's HP when the fight opened, and what the squad was fighting.
 * An unnamed killer (conditions, a trap) is left out of the line.
 */
function fallLines(run, state) {
  const out = [];
  for (const e of run.encounters || []) for (const f of e.falls || []) {
    const by = f.by ? (f.byId ? Bestiary.nameOf(state, f.byId, f.by) : f.by) : null;
    const facts = [
      e.width != null ? groundText(e.width) : null,
      e.startHp != null ? `squad at ${e.startHp}% HP when it opened` : null,
      `against ${foeList(e, state)}`,
    ].filter(Boolean);
    out.push(`${f.name} fell in encounter ${e.n}${by ? ' to ' + by : ''}${f.source ? ' (' + f.source + ')' : ''}. ${cap(facts.join('; '))}.`);
  }
  return out;
}

function renderRun(container, run, state, M) {
  const mm = M.MISSION[run.mission] || { icon: run.icon || '🗺️', name: run.mission };
  const s = summary(run);
  const head = $h('div', 'sub', '');
  head.style.marginTop = '8px';
  const lost = (run.lost || []).length ? ` · <span class="warn">${run.lost.join(', ')} did not come back</span>` : '';
  head.innerHTML = `<b>${mm.icon} ${mm.name}</b> · ${run.result || 'in progress'}${run.encounters ? ` · ${s.won}/${s.fights} fights won · ${s.kills} kills · dealt ${s.dealt}, took ${s.taken}${s.potions ? ` · ${s.potions} potions drunk` : ''}${s.downs ? ` · ${s.downs} knocked down` : ''}` : ''}${lost}`;
  container.append(head);

  // loot line
  const loot = (run.loot || []).reduce((a, d) => { const k = d.kind === 'resource' ? d.key : d.kind; a[k] = (a[k] || 0) + (d.amount || 1); return a; }, {});
  const lootEl = $h('div', 'sub', `Loot: ${Object.entries(loot).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing yet'}${run.rewards && Object.keys(run.rewards).length ? ' · reward ' + Econ.costText(run.rewards) : ''}`);
  container.append(lootEl);

  const squad = (run.party || []).filter(p => p && typeof p === 'object');
  if (squad.length) {
    const roleName = (r) => (r && typeof Outfit !== 'undefined' && Outfit.ROLES[r] ? Outfit.ROLES[r].label : r);
    container.append($h('div', 'sub', 'Squad: ' + squad.map(p => `${p.name}${p.role ? ' (' + roleName(p.role) + ')' : ''}`).join(', ')));
  }
  if (run.fights > s.fights) {
    container.append($h('div', 'sub', `Fights fought: ${run.fights}. Kept: ${s.fights}, the newest ones and every fight in which somebody fell.`));
  }
  const falls = fallLines(run, state);
  if (falls.length) {
    const box = $h('div', 'sub', '<b>Falls</b>');
    for (const t of falls) box.append($h('div', 'warn', t));
    container.append(box);
  }

  if (!run.encounters || !run.encounters.length) {
    if ((run.log || []).length) { const pre = $h('pre', 'fightlog'); pre.textContent = run.log.join('\n'); container.append(pre); }
    return;
  }
  for (const e of run.encounters) container.append(encounterBlock(e, state));
}

function encounterBlock(e, state) {
  const box = $h('div', 'encounter');
  const verdict = e.won ? '<span class="ok">won</span>' : e.timedOut ? '<span class="warn">stalemate</span>' : '<span class="bad">lost</span>';
  const ground = e.width != null ? ` · <span title="${GROUND_TITLE}">${groundText(e.width)}</span>` : '';
  const start = e.startHp != null ? ` · squad at ${e.startHp}% HP at the start` : '';
  box.append($h('div', 'enc-title', `<b>Encounter ${e.n}</b> · ${verdict} in ${(e.ticks / 10).toFixed(1)}s${ground}${start}`));

  // enemies, through the bestiary
  const foes = $h('div', 'enc-foes');
  for (const en of e.enemies) {
    const k = Bestiary.knowledge(state, Missions.BESTIARY[en.id] || { id: en.id, name: en.name, icon: en.icon, tags: [], tier: '?' }, null);
    const img = Bestiary.portrait(en.id);
    const hpLine = k.tier >= 3 ? `${en.hp}/${en.maxHp} hp` : (en.alive ? `${pct(en.hp, en.maxHp)}% hp left` : 'slain');
    foes.append($h('div', 'foe' + (en.alive ? '' : ' dead'),
      `${img ? `<img src="${img}" alt="">` : `<span class="foe-icon">${en.icon}</span>`}<div><b>${en.name}</b> <span class="sub">lv ${en.level}</span><div class="sub">${hpLine}${k.tier >= 2 ? ` · hit us ${en.attacks}× for ${en.dealt}` : ''}</div>${k.tier >= 1 ? `<div class="sub">${(k.tags || []).join(', ')}</div>` : ''}</div>`));
  }
  box.append(foes);

  // party rows
  const tbl = $h('table', 'enc-party');
  tbl.innerHTML = `<tr><th>Member</th><th>HP</th><th>Dealt</th><th>Took</th><th>Hits</th><th>Crits</th><th>Dodged</th><th>Parried</th><th>Casts</th><th>Potions</th><th>Left with</th></tr>` +
    e.party.map(p => `<tr class="${p.alive ? '' : 'down'}"><td>${p.name}${p.alive ? '' : ' <span class="bad">down</span>'}</td><td>${pct(p.hp, p.maxHp)}%</td><td>${p.dealt}</td><td>${p.taken}</td><td>${p.attacks}</td><td>${p.crits}</td><td>${p.dodges}</td><td>${p.parries}</td><td>${p.casts}</td><td>${p.potions || 0}</td><td>${p.conditions.length ? p.conditions.map(statusName).join(', ') : '—'}</td></tr>`).join('');
  box.append(tbl);

  if (e.kills.length) box.append($h('div', 'sub', 'Kills: ' + e.kills.map(k => `${k.name}${k.by ? ' (' + k.by + ')' : ''}`).join(', ')));
  // a sortie report keeps the log only for the fights with a fall (sortie.js keptFights)
  if (e.log && e.log.length) {
    const det = $h('details', '', `<summary class="sub">blow by blow</summary>`);
    const pre = $h('pre', 'fightlog'); pre.textContent = e.log.join('\n');
    det.append(pre);
    box.append(det);
  }
  return box;
}

// ---------- bestiary screen ----------
function renderBestiary(container, state, M, C) {
  container.innerHTML = '';
  const defs = Object.values(M.BESTIARY);
  const known = defs.filter(d => Bestiary.tier(Bestiary.ensure(state)[d.id]) > 0);
  container.append($h('div', 'townhead', `<div><h3>📖 Bestiary <span class="sub">${known.length}/${defs.length} recorded</span></h3>
    <div class="sub">Entries open when a party sees something and fill in as they kill it: one kill tells you how it fights, three how tough it is, five what it resists and what hurts it.</div></div>`));
  const grid = $h('div', 'grid');
  const order = MissionTypes.GRADES;
  for (const def of [...defs].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.name.localeCompare(b.name))) {
    const en = Bestiary.ensure(state)[def.id];
    const t = Bestiary.tier(en);
    const card = $h('div', 'bcard beast' + (t ? '' : ' unknown'));
    if (!t) { card.innerHTML = `<div class="beast-art"><span class="foe-icon">❔</span></div><h3>???</h3><div class="sub">Not yet encountered</div>`; grid.append(card); continue; }
    const sample = C.fromMonster(def, Math.max(1, en.maxLevel), {}, {});
    const k = Bestiary.knowledge(state, def, sample);
    const img = Bestiary.portrait(def.id);
    let html = `<div class="beast-art">${img ? `<img src="${img}" alt="">` : `<span class="foe-icon">${def.icon}</span>`}</div>
      <h3>${def.icon} ${def.name}</h3>
      <div class="sub"><span class="tag">${Bestiary.TIER_LABEL[t]}</span> · ${cap(k.grade)} · ${k.tags.join(', ')}</div>
      <div class="sub">seen ${k.seen} · killed ${k.killed}${k.lostTo ? ` · <span class="warn">beat us ${k.lostTo}</span>` : ''} · up to lv ${k.maxLevel}</div>`;
    if (t >= 2) html += `<div class="sub">Attacks with <b>${k.damageType}</b>${k.inflicts.length ? ` · inflicts ${k.inflicts.map(statusName).join(', ')}` : ''}</div>`;
    if (t >= 3) html += `<div class="sub">At lv ${k.maxLevel}: ${k.hp} hp · hits for ~${k.damage} · armor ${k.armor}</div><div class="stats">${Object.entries(k.attrs).map(([s, v]) => `<span><b>${s.toUpperCase()}</b> ${v}</span>`).join('')}</div>`;
    if (t >= 4) html += `<div class="sub">${k.resists.length ? 'Resists ' + k.resists.map(([e, v]) => `${e} ${Math.round(v * 100)}%`).join(', ') : 'No resistances'}</div><div class="sub ok">${k.weak.length ? 'Weak to ' + k.weak.map(([e, v]) => `${e} ${Math.round(-v * 100)}%`).join(', ') : 'No weaknesses'}</div>`;
    else html += `<div class="sub dim">${Bestiary.TIER_HINT[t + 1]}</div>`;
    card.innerHTML = html;
    grid.append(card);
  }
  container.append(grid);
}

const ReportAPI = { summary, renderRun, encounterBlock, renderBestiary };
if (typeof module !== 'undefined') module.exports = ReportAPI;
if (typeof window !== 'undefined') window.Report = ReportAPI;
})();
