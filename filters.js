// One filter bar, used by every list of people. Browser: window.Filters.
//
// The roster, the training grounds and both halves of the altar ask the same three questions of a
// crowd — how good is the pull, was it born to something, and are its points in the right places —
// so they get one implementation of the answer rather than four. Every list that adopts this gets
// the same controls in the same order, which matters more than it sounds: the altar is where
// characters are killed, and a filter that means something subtly different on that screen than on
// the roster is a filter that will eventually get somebody spent by mistake.
//
// The three screens are the three things you do with a crowd, and they want the same cut of it:
//   roster    who have I got
//   training  who is worth a slot
//   altar     who is worth keeping, and who pays for them
//
// State lives here rather than in the caller because these screens redraw on the tick. A filter
// held in a local would be cleared every few seconds; held here it survives the redraw, and the
// caller only has to ask what is currently showing.
//
// The four questions, and why each one is its own control:
//   star       the pull tier. Coarse, and the only one the player already thinks in.
//   potential  where the points landed for the race (potential.js). Orthogonal to star: every
//              3★ has the same 62 points and they are not all worth the same.
//   class      unclassed, classed, born to it, legendary, or one class by name. Orthogonal to
//              both: a birthright can turn up on a 1★ with a wasted spread.
//   favourite  the only one the player writes themselves. Everything else here is measured off
//              the character; this is the player saying "this one is mine", for the reasons no
//              measurement has — they like the face, they have plans, they have been carrying
//              them since the second pull. It is stored on the character and saved with them.
//   name/race  the escape hatch for "where did that dwarf go".

(() => {
const P = () => (typeof Potential !== 'undefined') ? Potential : require('./potential.js');
const S = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const C = () => (typeof Classes !== 'undefined') ? Classes : require('./classes.js');
// Optional. The gate cares who reads ground nobody has walked; the roster and the altar do not,
// and neither does a unit test, so this one is asked for rather than required.
const AIx = () => (typeof AI !== 'undefined') ? AI : null;

const points = (c) => S().BASE_STATS.reduce((a, k) => a + c.stats.base[k], 0);

// How a list can be ordered. `weakest` is the altar's order and nothing else's: the offering list
// is read from the bottom, and putting the cheapest death first is what makes it usable.
const SORTS = {
  star:      { label: 'by star',      f: (a, b) => b.stats.stars - a.stats.stars || P().rankOf(b) - P().rankOf(a) },
  favourite: { label: 'favourites first', f: (a, b) => (!!b.fav) - (!!a.fav) || b.stats.stars - a.stats.stars },
  potential: { label: 'by potential', f: (a, b) => P().rankOf(b) - P().rankOf(a) || P().of(b).percentile - P().of(a).percentile },
  weakest:   { label: 'weakest first', f: (a, b) => a.stats.stars - b.stats.stars || points(a) - points(b) },
  points:    { label: 'by stat points', f: (a, b) => points(b) - points(a) },
  name:      { label: 'by name',      f: (a, b) => a.name.localeCompare(b.name) },
  race:      { label: 'by race',      f: (a, b) => a.race.localeCompare(b.race) || b.stats.stars - a.stats.stars },
  scout:     { label: 'by scouting',  f: (a, b) => (AIx() ? AIx().scouting(b) - AIx().scouting(a) : 0) || b.stats.stars - a.stats.stars,
               when: () => !!AIx() },
};

/** The orders that can actually be offered here. `scout` drops out where ai.js is not loaded. */
const sortList = () => Object.entries(SORTS).filter(([, v]) => !v.when || v.when());

const blank = (sort) => ({ star: 'all', pot: 'all', klass: 'all', fav: 'all', q: '', sort });
const store = {};
/** The live filter state for a list. `sort` is only the default: it is used on first sight. */
const state = (section, sort = 'star') => (store[section] || (store[section] = blank(sort)));
const isSet = (s) => s.star !== 'all' || s.pot !== 'all' || s.klass !== 'all' || s.fav !== 'all' || s.q !== '';
const active = (section) => isSet(state(section));

// A search box loses the caret when the panel is rebuilt, so remember which one had it and where.
let focused = null;

const matches = (text, q) => String(text || '').toLowerCase().includes(q.toLowerCase());

/**
 * Does one character pass a set of filter VALUES? Takes the values rather than a section so that a
 * screen with its own controls can still ask the question and get the same answer — the trials box
 * on the gate has filters about trials, not about people, but the two questions this file owns
 * mean the same thing there as everywhere else, and they are answered here or they will drift.
 * Every key is optional: what is missing is not asked.
 */
function test(c, f) {
  if (f.star && f.star !== 'all' && String(c.stats.stars) !== f.star) return false;
  if (f.pot && f.pot !== 'all' && P().rankOf(c) < P().rankOfGrade(f.pot)) return false;
  if (f.klass && f.klass !== 'all' && !classPass(f.klass, c)) return false;
  if (f.fav === 'yes' && !c.fav) return false;
  if (f.fav === 'no' && c.fav) return false;
  if (f.q && !(matches(c.name, f.q) || matches(c.race, f.q) || matches(C().title(c), f.q))) return false;
  return true;
}

/** Does one character pass the section's filters? */
const passes = (section, c) => test(c, state(section));

// Grades are thresholds, not equalities: nobody wants to see exactly the B characters, they want
// the ones worth keeping. Only thresholds that would actually SPLIT the list are offered — above
// the best nobody is left, at or below the worst everybody is, and an option that changes nothing
// on screen is an option that makes the player doubt the control works.
function potOptions(all) {
  const pot = P();
  const ranks = all.map(c => pot.rankOf(c));
  const best = ranks.length ? Math.max(...ranks) : -1;
  const worst = ranks.length ? Math.min(...ranks) : -1;
  return [['all', 'any potential'],
    ...pot.GRADES.filter(g => pot.rankOfGrade(g.id) > worst && pot.rankOfGrade(g.id) <= best)
      .map(g => [g.id, `${g.id} or better`])];
}
/** Offered only once something is marked: an empty list of favourites is not a way to sort a crowd. */
const favOptions = (all) => all.some(c => c.fav)
  ? [['all', 'anyone'], ['yes', '♥ favourites'], ['no', 'not favourites']] : null;

function classPass(want, c) {
  const cl = C();
  const held = cl.held(c);
  if (want === 'none') return !held.length;
  if (want === 'any') return held.length > 0;
  if (want === 'birthright') return held.some(h => h.def.summonOnly);
  if (want === 'legendary') return held.some(h => h.def.legendary);
  return held.some(h => h.id === want);
}

/**
 * Filter, then sort. The caller keeps the original list so the bar can say "12 of 40".
 *
 * `first` pins whoever it matches to the top whatever the sort says. The training grounds want
 * the people already in a slot up there — a filter that scrolls the character you are about to
 * take OFF training below the fold has made the screen harder to use, not easier.
 */
function apply(section, list, sort = 'star', first = null) {
  const s = state(section, sort);
  const out = list.filter(c => passes(section, c));
  out.sort((SORTS[s.sort] || SORTS[sort]).f);
  if (!first) return out;
  const pinned = out.filter(first);
  return pinned.length ? [...pinned, ...out.filter(c => !first(c))] : out;
}

// ---------- the controls ----------

/**
 * The row itself. `all` is the unfiltered list — the options are built from what is actually in
 * front of the player, so a roster with no 5★ in it does not offer to filter for one, and the
 * class list names the classes they own rather than all sixty-one.
 */
function bar(section, all, shown, redraw, sort = 'star') {
  const s = state(section, sort);
  const pot = P(), cls = C();
  const row = document.createElement('div');
  row.className = 'filters';

  const stars = [...new Set(all.map(c => c.stats.stars))].sort((a, b) => b - a);
  const heldIds = [...new Set(all.flatMap(c => cls.held(c).map(h => h.id)))]
    .sort((a, b) => cls.CLASSES[a].name.localeCompare(cls.CLASSES[b].name));
  const anyBorn = all.some(c => cls.held(c).some(h => h.def.summonOnly));
  const anyLegend = all.some(c => cls.held(c).some(h => h.def.legendary));

  const potOpts = potOptions(all);

  const klassOpts = [['all', 'any class'], ['none', 'unclassed'], ['any', 'has a class'],
    ...(anyBorn ? [['birthright', '✦ born to it']] : []),
    ...(anyLegend ? [['legendary', '★ legendary']] : []),
    ...heldIds.map(id => {
      const r = cls.rarity(id);
      return [id, `${cls.CLASSES[id].icon} ${cls.CLASSES[id].name}${r ? (r.legendary ? ' ★' : ' ✦') : ''}`];
    })];

  const fields = [
    { key: 'star', options: [['all', 'any star'], ...stars.map(n => [String(n), `${n}★`])], when: stars.length > 1 },
    { key: 'pot', options: potOpts, when: potOpts.length > 1, title: 'How well their points are placed for their race and tier. Every character of a tier has the same number of points; this is where they landed.' },
    { key: 'klass', options: klassOpts, when: klassOpts.length > 3 },
    { key: 'fav', options: favOptions(all) || [['all', 'anyone']], when: !!favOptions(all),
      title: 'Characters you marked yourself. Nothing measures this one.' },
    { key: 'sort', options: sortList().map(([k, v]) => [k, v.label]), when: true },
  ];

  for (const f of fields) {
    if (!f.when) { s[f.key] = f.key === 'sort' ? s.sort : 'all'; continue; }
    const sel = document.createElement('select');
    if (f.title) sel.title = f.title;
    sel.innerHTML = f.options.map(([v, l]) => `<option value="${v}"${s[f.key] === v ? ' selected' : ''}>${l}</option>`).join('');
    if (!f.options.some(([v]) => v === s[f.key])) s[f.key] = f.options[0][0];   // the value went away with the character
    sel.addEventListener('change', () => { s[f.key] = sel.value; redraw(); });
    row.append(sel);
  }

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'name, race or class';
  input.value = s.q;
  input.dataset.filter = `${section}.q`;
  input.addEventListener('input', () => {
    s.q = input.value;
    focused = { id: input.dataset.filter, pos: input.selectionStart };
    redraw();
  });
  row.append(input);

  const count = document.createElement('span');
  count.className = 'sub';
  count.textContent = shown === all.length ? `${all.length}` : `${shown} of ${all.length}`;
  row.append(count);

  if (isSet(s)) {
    const clear = document.createElement('button');
    clear.className = 'ghost';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => { Object.assign(s, blank(s.sort)); redraw(); });
    row.append(clear);
  }
  return row;
}

/** Put the caret back in the search box the rebuild took it out of. Call after the row is in. */
function restoreFocus() {
  if (!focused) return;
  const el = document.querySelector(`[data-filter="${focused.id}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(focused.pos, focused.pos); } catch (e) { /* not a text input */ } }
  focused = null;
}

// ---------- the marks a filter is filtering on ----------
// A filter nobody can read the result of is a filter nobody trusts, so anything filterable is
// also visible on the card: the grade, and a mark on a class the gate had to hand out.

/** The potential chip: one letter in the grade's colour, with the whole derivation in the title. */
const badge = (c) => {
  const p = P().of(c);
  return `<span class="pot" style="color:${p.color};border-color:${p.color}" title="${P().explain(c).replace(/"/g, '&quot;')}">${p.grade}</span>`;
};

const isFav = (c) => !!c.fav;

/**
 * The heart, as a button. Sits on the tile and on the sheet, and stops the click from reaching
 * whatever is underneath it — the roster tile opens the character sheet on any click, and marking
 * somebody should not also be a navigation.
 */
function heart(c, after) {
  const b = document.createElement('button');
  b.className = 'fav-btn' + (c.fav ? ' on' : '');
  b.type = 'button';
  b.textContent = c.fav ? '♥' : '♡';
  b.title = c.fav ? `${c.name} is a favourite — click to unmark` : `Mark ${c.name} a favourite`;
  b.setAttribute('aria-pressed', c.fav ? 'true' : 'false');
  b.addEventListener('click', (e) => { e.stopPropagation(); c.fav = !c.fav; if (after) after(c); });
  b.addEventListener('keydown', (e) => e.stopPropagation());
  return b;
}

/** ✦ for a class only the gate hands out, ★ for one of the two nobody expects to see. */
function rareMark(c) {
  const r = C().rarestOf(c);
  if (!r) return '';
  const cl = C().CLASSES[r.id];
  return `<span class="rare-mark${r.legendary ? ' legend' : ''}" title="${cl.name} cannot be taught, fused or grown into — ${r.text}.">${r.legendary ? '★' : '✦'}</span>`;
}

const FiltersAPI = { SORTS, sortList, state, active, test, passes, potOptions, favOptions, apply, bar, restoreFocus, badge, rareMark, points, isFav, heart };
if (typeof module !== 'undefined') module.exports = FiltersAPI;
if (typeof window !== 'undefined') window.Filters = FiltersAPI;
})();
