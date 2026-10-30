// Offline calculator: what happened while the player was away, and what will. Browser: window.Offline. Node: module.exports.
//
// The town is simulated tick by tick on return (game.js catchUp), so nothing here invents
// progress: this file only measures it. `snapshot` records the numbers that matter before the
// catch-up, `report` diffs them afterwards into a readable account (resources, crafts, aptitude
// stages, missions, notable log lines), and `estimate` projects the current rota forward so the
// player can see what an hour away is worth before leaving.
//
// Field sorties run in real time and are not simulated offline; the report says so.

(() => {
const HOUR_TICKS = 360;   // ten-second ticks

function snapshot(state, keys = ['gems', 'crops', 'ore', 'herbs']) {
  const profs = {};
  for (const c of state.characters) profs[c.id] = Object.fromEntries(Object.entries(c.profs || {}).map(([k, p]) => [k, p.stage]));
  const inventory = {};
  for (const [id, it] of Object.entries(state.inventory || {})) inventory[id] = it.count;
  return {
    at: Date.now(),
    resources: Object.fromEntries(keys.map(k => [k, state[k] || 0])),
    inventory, profs,
    history: (state.missions && state.missions.history || []).length,
    characters: state.characters.length,
    logLen: (state.log || []).length,
  };
}

/** Diff the town against a snapshot. meta = { elapsedMs, ticks, asked, cap, ms }. */
function report(state, before, meta, { RESOURCES, PROF, STAGES, MISSION, inventoryName } = {}) {
  const resources = [];
  for (const [k, v] of Object.entries(before.resources)) {
    const d = (state[k] || 0) - v;
    if (d !== 0) resources.push({ key: k, delta: d, icon: RESOURCES && RESOURCES[k] ? RESOURCES[k].icon : k, label: RESOURCES && RESOURCES[k] ? RESOURCES[k].label : k });
  }
  const crafted = [], spent = [];
  for (const [id, it] of Object.entries(state.inventory || {})) {
    const d = it.count - (before.inventory[id] || 0);
    if (d > 0) crafted.push({ name: it.name, count: d, quality: it.quality });
    else if (d < 0) spent.push({ name: it.name, count: -d });
  }
  for (const [id, n] of Object.entries(before.inventory)) if (!(state.inventory || {})[id] && n > 0) spent.push({ name: inventoryName ? inventoryName(id) : id, count: n });
  crafted.sort((a, b) => (b.quality || 0) - (a.quality || 0) || b.count - a.count);
  // what was eaten or drunk is one line per thing, whatever its quality
  const byName = {};
  for (const x of spent) byName[x.name] = (byName[x.name] || 0) + x.count;
  spent.length = 0;
  for (const [name, count] of Object.entries(byName)) spent.push({ name, count });
  spent.sort((a, b) => b.count - a.count);
  const stageUps = [];
  for (const c of state.characters) {
    const was = before.profs[c.id];
    if (!was) continue;
    for (const [k, p] of Object.entries(c.profs || {})) {
      if (was[k] !== undefined && p.stage > was[k]) stageUps.push({ name: c.name, prof: PROF && PROF[k] ? PROF[k].label : k, from: STAGES ? STAGES[was[k]] : was[k], to: STAGES ? STAGES[p.stage] : p.stage });
    }
  }
  const hist = (state.missions && state.missions.history || []);
  const missions = hist.slice(0, Math.max(0, hist.length - before.history)).map(h => ({ name: MISSION && MISSION[h.mission] ? MISSION[h.mission].name : h.mission, icon: MISSION && MISSION[h.mission] ? MISSION[h.mission].icon : '', result: h.result, lost: h.lost || [] }));
  const lines = (state.log || []).filter(l => l.t >= before.at).map(l => l.text);
  const lost = state.characters.length - before.characters;
  return { ...meta, at: before.at, resources, crafted, spent, stageUps, missions, lines, roster: lost, active: (state.missions && state.missions.active || []).length };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function span(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return plural(s, 'second');
  const m = Math.round(s / 60);
  if (m < 90) return plural(m, 'minute');
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : plural(h, 'hour');
}

/** The report as HTML. */
function html(r, TICK_MS = 10000) {
  const parts = [];
  const simulated = r.ticks * TICK_MS;
  let head = `Away ${span(r.elapsedMs)} · ${r.ticks} ticks simulated (${span(simulated)})`;
  if (r.asked > r.cap) head += ` · offline progress counts up to ${span(r.cap * TICK_MS)}, the rest is lost`;
  if (r.ticks < Math.min(r.asked, r.cap)) head += ` · stopped early after ${(r.ms / 1000).toFixed(1)}s of simulation`;
  parts.push(`<div class="sub">${head}</div>`);
  if (r.resources.length) parts.push(`<div class="away-row">${r.resources.map(x => `<span class="res" title="${x.label}">${x.icon} ${x.delta > 0 ? '+' : ''}${x.delta}</span>`).join('')}</div>`);
  else parts.push('<div class="sub">No resources changed hands.</div>');
  if (r.missions.length) parts.push(`<div><b>Missions</b> ${r.missions.map(m => `${m.icon} ${m.name} — ${m.result}${m.lost.length ? ` (lost ${m.lost.join(', ')})` : ''}`).join(' · ')}</div>`);
  if (r.active) parts.push(`<div class="sub">${plural(r.active, 'mission')} still out.</div>`);
  if (r.crafted.length) parts.push(`<div><b>Made</b> ${r.crafted.slice(0, 12).map(x => `${x.name} ×${x.count}`).join(', ')}${r.crafted.length > 12 ? ` and ${r.crafted.length - 12} more` : ''}</div>`);
  if (r.spent.length) parts.push(`<div class="sub"><b>Used</b> ${r.spent.slice(0, 8).map(x => `${x.name} ×${x.count}`).join(', ')}</div>`);
  if (r.stageUps.length) parts.push(`<div><b>Aptitudes</b> ${r.stageUps.slice(0, 12).map(x => `${x.name}: ${x.prof} ${x.from}→${x.to}`).join(' · ')}${r.stageUps.length > 12 ? ` and ${r.stageUps.length - 12} more` : ''}</div>`);
  if (r.roster < 0) parts.push(`<div class="warn">${plural(-r.roster, 'character')} did not come back.</div>`);
  if (r.lines.length) parts.push(`<div class="away-log">${r.lines.slice(0, 14).map(l => `<div>${l}</div>`).join('')}</div>`);
  parts.push('<div class="sub">Field sorties run in real time and wait for you; only the town and Gate missions advance while you are away.</div>');
  return parts.join('');
}

/**
 * Project the current rota one hour forward. `io` supplies the game's own rate functions so the
 * estimate uses the same arithmetic the tick does:
 *   io.outputFor(c, job) work per tick, io.JOBS, io.RESOURCES, io.threshold(job), io.trainees()
 * Materials are assumed to hold out; a crafting line that starves will make less.
 */
function estimate(state, io) {
  const gather = {}, crafts = [];
  const busy = state.characters.filter(c => c.job && !c.mission);
  for (const [k, job] of Object.entries(io.JOBS)) {
    const ws = busy.filter(c => c.job === k);
    if (!ws.length) continue;
    const work = ws.reduce((a, c) => a + io.outputFor(c, k), 0);
    if (job.kind === 'gather' || job.kind === 'town') gather[job.produces] = (gather[job.produces] || 0) + work * HOUR_TICKS;
    else if (job.kind === 'process') {
      const perHour = work / job.threshold * HOUR_TICKS;
      const cost = Object.entries(job.consumes || {}).map(([r, v]) => ({ r, v: v * perHour }));
      crafts.push({ label: job.label, icon: job.icon, perHour, cost, workers: ws.length });
      for (const c of cost) gather[c.r] = (gather[c.r] || 0) - c.v;
    }
  }
  const active = (state.missions && state.missions.active || []).map(r => ({ run: r, left: Math.max(0, (io.MISSION[r.mission].ticks - r.progress)) }));
  return { gather, crafts, trainees: busy.filter(c => io.JOBS[c.job].kind === 'train').length, idle: state.characters.filter(c => !c.job && !c.mission).length, active, cap: io.cap };
}

function estimateHtml(e, io) {
  const parts = [];
  const net = Object.entries(e.gather).filter(([, v]) => Math.abs(v) >= 0.5);
  parts.push(net.length ? `<div class="away-row">${net.map(([k, v]) => `<span class="res" title="${io.RESOURCES[k] ? io.RESOURCES[k].label : k} per hour">${io.RESOURCES[k] ? io.RESOURCES[k].icon : k} ${v > 0 ? '+' : ''}${Math.round(v)}/h</span>`).join('')}</div>` : '<div class="sub">Nobody is gathering.</div>');
  if (e.crafts.length) parts.push(`<div class="sub">${e.crafts.map(c => `${c.icon} ${c.label}: ~${c.perHour.toFixed(1)} per hour from ${c.workers}`).join(' · ')}</div>`);
  const bits = [];
  if (e.trainees) bits.push(`${e.trainees} training`);
  if (e.idle) bits.push(`${e.idle} resting`);
  if (e.active.length) bits.push(e.active.map(a => `${io.MISSION[a.run.mission].icon} back in ${a.left} ticks`).join(', '));
  if (bits.length) parts.push(`<div class="sub">${bits.join(' · ')}</div>`);
  parts.push(`<div class="sub">Offline progress is simulated on return, up to ${span(e.cap * io.TICK_MS)}. Crafting stops when materials run out; workers still rotate off shift.</div>`);
  return parts.join('');
}

const OfflineAPI = { HOUR_TICKS, snapshot, report, html, estimate, estimateHtml, span };
if (typeof module !== 'undefined') module.exports = OfflineAPI;
if (typeof window !== 'undefined') window.Offline = OfflineAPI;
})();
