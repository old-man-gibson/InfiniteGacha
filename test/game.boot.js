// Boots game.html under Node. The page's own <script> list is read at run time and evaluated in
// one vm context against a stub DOM, then the page's start-up is replayed: DOMContentLoaded, the
// async init() in game.js, and the timers sortie.js uses to wait for it. No game file is patched.
// A script that throws is recorded and the remaining scripts still load, as in a browser.
//
// Command line
//   node test/game.boot.js [--html=game.html] [--gaps] [--verbose]
//     Boots and prints the scripts loaded, the uncaught exceptions during boot, and the console
//     output counts. Exit status 1 when a script or a boot callback threw, a listed script file
//     is missing, or Game.state never appeared.
//     --gaps     list the DOM properties the code read that the stub does not define
//     --verbose  forward the game's console output instead of counting it
//
// From a test
//   const { boot } = require('./game.boot.js');
//   const b = await boot();         // { context, Game, Sortie, registry, errors, ... }
//                                   // boot({ html, root, verbose, storage }): storage is a Map or object of localStorage
//                                   // entries to start with; a second boot given the first one's b.localStorage.map is a reload
//   b.click('#pull');               // runs the listeners registered on #pull
//   b.advance(10000);               // moves the virtual clock; timers due in that span run in order
//   b.withSeed(7, () => ...);       // pins Rng.withSource and the context's Math.random to one stream
//   b.fire('window', 'beforeunload');
//
// Time is virtual. Date.now() and performance.now() in the context only move in advance(), and
// setTimeout / setInterval / requestAnimationFrame callbacks run only when advance() / frame() are
// called, so a run does not depend on the wall clock. Images never finish loading and canvas
// drawing calls do nothing; fetch() is served from the project folder.
//
// Stub limits: element trees are not parsed out of innerHTML, so querySelector on an element
// returns a stand-in element (one per selector per parent) instead of null, and document.querySelector
// returns a stand-in for a selector that matches nothing in the page (game.js reads elements it wrote
// with innerHTML through `$`). document.getElementById answers by id: the page's own element for an id
// in the html, a stand-in for an id that has appeared as id="..." in a string given to innerHTML or
// insertAdjacentHTML, and null for any other id, as a browser returns null for an id that is not in the
// document. An element given an id from script is not found by getElementById. A selector with a
// pseudo-class or an attribute operator other than = matches nothing. A lookup that fell through to
// a stand-in is counted in `fabricated`, and a property read that the stub lacks in `unknown`.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const EPOCH = Date.UTC(2026, 9, 1);              // Date.now() at boot, in virtual milliseconds
const NOISE = [/Unable to connect room/];        // vendor/rot.js prints this on some maps
const MAX_CALLBACKS = 1e6;                       // timer callbacks one advance() may run
const SKIP_TAGS = new Set(['html', 'head', 'meta', 'link', 'title', 'base', 'body']);
const PLAIN_ATTRS = new Set(['value', 'title', 'type', 'name', 'placeholder']);   // attributes mirrored as properties
const HTML_ID = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;                           // an id attribute in a string of markup

/** Seeded [0,1) stream (mulberry32). */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the page ----------

/** Script list and static elements of an html file. Comments are removed first, so a commented-out tag is not loaded. */
function readPage(root, htmlName) {
  const html = fs.readFileSync(path.resolve(root, htmlName), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [];
  const rest = html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (all, attrs, code) => {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      scripts.push({ src: src ? (src[1] || src[2] || src[3]) : null, code, type: type ? (type[1] || type[2] || type[3]) : '' });
      return '';
    })
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  const tags = [];
  const tagRe = /<([a-z][\w-]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  for (let m; (m = tagRe.exec(rest));) {
    const attrs = [];
    const attrRe = /([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    for (let a; (a = attrRe.exec(m[2]));) attrs.push([a[1].toLowerCase(), a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '']);
    tags.push({ tag: m[1].toLowerCase(), attrs });
  }
  return { scripts, tags };
}

// ---------- selectors ----------
// Compound selectors of tag, #id, .class, [attr] and [attr=value], comma separated. Combinators are
// matched on the last compound only. Anything else (pseudo-classes, [a^=b]) parses to null and matches nothing.

function parseCompound(text) {
  const c = { tag: null, id: null, cls: [], attrs: [] };
  let rest = text.trim();
  const tag = /^(\*|[\w-]+)/.exec(rest);
  if (tag) { c.tag = tag[1] === '*' ? null : tag[1].toLowerCase(); rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) c.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(rest))) c.cls.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) c.attrs.push([m[1], m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]]);
    else return null;
    rest = rest.slice(m[0].length);
  }
  return c;
}

const parseSelector = (sel) => String(sel).split(',').map(part => {
  const last = part.trim().split(/\s*[>+~]\s*|\s+/).pop();
  return parseCompound(last);
}).filter(Boolean);

function matchCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.cls) if (!el._classes.has(k)) return false;
  for (const [name, val] of c.attrs) {
    const got = el.getAttribute(name);
    if (got === null || (val !== undefined && got !== val)) return false;
  }
  return true;
}

// ---------- elements ----------

const camel = (s) => s.replace(/-([a-z])/g, (all, ch) => ch.toUpperCase());

function ctx2d() {
  const data = { measureText: () => ({ width: 8 }), getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) };
  for (const k of ['createLinearGradient', 'createRadialGradient', 'createPattern']) data[k] = () => ({ addColorStop() {} });
  return new Proxy(data, {
    get: (t, p) => (p in t ? t[p] : typeof p === 'symbol' ? undefined : () => {}),
  });
}

const styleBag = () => new Proxy({
  setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; }, removeProperty(k) { delete this[k]; },
}, { get: (t, p) => (p in t ? t[p] : typeof p === 'symbol' ? undefined : '') });

class El {
  constructor(boot, tag) {
    this._boot = boot;
    this.tagName = this.nodeName = String(tag).toUpperCase();
    this.nodeType = 1;
    this._kids = []; this.parentNode = null;
    this._l = {}; this._attrs = new Map(); this._q = new Map();
    this._classes = new Set();
    this._html = ''; this._text = '';
    this.dataset = {}; this.style = styleBag();
    this.id = ''; this.title = ''; this.type = ''; this.value = ''; this.name = ''; this.placeholder = '';
    this.hidden = false; this.disabled = false; this.checked = false; this.selected = false;
    this.files = []; this.isConnected = true;
    this.scrollTop = 0; this.scrollLeft = 0;
    this.width = tag === 'canvas' ? 300 : 0; this.height = tag === 'canvas' ? 150 : 0;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = () => this._classes;
    return {
      add: (...c) => c.forEach(x => set().add(x)),
      remove: (...c) => c.forEach(x => set().delete(x)),
      toggle: (x, force) => { const on = force === undefined ? !set().has(x) : !!force; if (on) set().add(x); else set().delete(x); return on; },
      contains: (x) => set().has(x),
      replace: (a, b) => { if (!set().has(a)) return false; set().delete(a); set().add(b); return true; },
      get length() { return set().size; },
      toString: () => [...set()].join(' '),
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._boot.noteHtml(this._html); this._text = ''; this._clear(); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = ''; this._clear(); }
  get innerText() { return this._text; }
  set innerText(v) { this.textContent = v; }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>${this._html}</${this.tagName.toLowerCase()}>`; }
  get children() { return this._kids.filter(k => k.nodeType === 1); }
  get childNodes() { return this._kids; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this._kids[0] || null; }
  get lastChild() { return this._kids[this._kids.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p._kids.indexOf(this); return i < 0 ? null : p._kids[i + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; const i = p._kids.indexOf(this); return i < 1 ? null : p._kids[i - 1]; }
  get nextElementSibling() { return this.nextSibling; }
  get offsetWidth() { return this.width || 100; }
  get offsetHeight() { return this.height || 100; }
  get clientWidth() { return this.width || 100; }
  get clientHeight() { return this.height || 100; }
  get scrollHeight() { return 100; }
  get scrollWidth() { return 100; }
  get selectionStart() { return this.value.length; }

  _clear() { for (const k of this._kids) k.parentNode = null; this._kids = []; }
  _adopt(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; return k; }
  appendChild(k) { this._kids.push(this._adopt(k)); return k; }
  append(...ks) { for (const k of ks) this.appendChild(typeof k === 'string' ? this._boot.text(k) : k); }
  prepend(...ks) { for (const k of ks.reverse()) this._kids.unshift(this._adopt(typeof k === 'string' ? this._boot.text(k) : k)); }
  insertBefore(k, ref) {
    this._adopt(k);
    const i = ref ? this._kids.indexOf(ref) : -1;
    if (i < 0) this._kids.push(k); else this._kids.splice(i, 0, k);
    return k;
  }
  insertAdjacentHTML(where, html) { this._boot.noteHtml(html); if (where === 'beforeend' || where === 'afterbegin') this._html += html; }
  insertAdjacentElement(where, k) { return where === 'afterbegin' ? (this.prepend(k), k) : this.appendChild(k); }
  after(...ks) { const p = this.parentNode; if (p) for (const k of ks) p.insertBefore(k, this.nextSibling); }
  before(...ks) { const p = this.parentNode; if (p) for (const k of ks) p.insertBefore(k, this); }
  replaceChildren(...ks) { this._clear(); this._html = this._text = ''; this.append(...ks); }
  removeChild(k) { const i = this._kids.indexOf(k); if (i >= 0) { this._kids.splice(i, 1); k.parentNode = null; } return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(k) { for (let n = k; n; n = n.parentNode) if (n === this) return true; return false; }
  cloneNode() { const e = this._boot.create(this.tagName.toLowerCase()); e.className = this.className; e._html = this._html; e._text = this._text; return e; }

  setAttribute(k, v) {
    const val = String(v);
    this._attrs.set(k, val);
    if (k === 'id') this.id = val;
    else if (k === 'class') this.className = val;
    else if (k === 'hidden') this.hidden = true;
    else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = val;
    else if (PLAIN_ATTRS.has(k)) this[k] = val;
    else if (k === 'disabled' || k === 'checked') this[k] = true;
  }
  getAttribute(k) {
    if (k === 'id') return this.id || (this._attrs.has('id') ? this._attrs.get('id') : null);
    if (k === 'class') return this._classes.size ? this.className : null;
    if (k === 'hidden') return this.hidden ? '' : null;
    if (k.startsWith('data-')) { const v = this.dataset[camel(k.slice(5))]; return v === undefined ? null : String(v); }
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { this._attrs.delete(k); if (k === 'hidden') this.hidden = false; if (k === 'disabled') this.disabled = false; }

  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    (this._l[type] = this._l[type] || []).push({ fn, once: !!(opts && typeof opts === 'object' && opts.once) });
  }
  removeEventListener(type, fn) { this._l[type] = (this._l[type] || []).filter(x => x.fn !== fn); }
  dispatchEvent(ev) { return this._boot.dispatch(this, ev); }
  click() { if (!this.disabled) this._boot.dispatch(this, { type: 'click' }); }
  focus() {} blur() {} select() {} scrollIntoView() {} scrollTo() {} setSelectionRange() {}
  setPointerCapture() {} releasePointerCapture() {} showModal() {} close() {}
  animate() { return { cancel() {}, finished: Promise.resolve() }; }
  getContext() { return ctx2d(); }
  toDataURL() { return 'data:,'; }
  getBoundingClientRect() { const w = this.offsetWidth, h = this.offsetHeight; return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h }; }
  closest() { return null; }
  matches(sel) { return parseSelector(sel).some(c => matchCompound(this, c)); }
  querySelectorAll() { return []; }
  querySelector(sel) {
    if (/^#[\w-]+$/.test(sel) && this._boot.staticById.has(sel)) return this._boot.staticById.get(sel);
    if (!this._q.has(sel)) { this._boot.noteFabricated(sel); this._q.set(sel, this._boot.create('div')); }
    return this._q.get(sel);
  }
  getElementsByTagName() { return []; }
  getElementsByClassName() { return []; }
}

// ---------- the boot ----------

/**
 * Evaluate the page's scripts and replay its start-up. Resolves once Game.state exists and the
 * boot timers have run; it does not reject for a failing script, it records it in `errors`.
 */
async function boot(opts = {}) {
  const root = opts.root || ROOT;
  const htmlName = opts.html || 'game.html';
  const verbose = !!opts.verbose;
  const page = readPage(root, htmlName);

  const errors = [], unknown = new Map(), fabricated = new Map(), missing = [], loaded = [], skipped = [];
  const consoleLines = [], consoleCount = { log: 0, info: 0, debug: 0, warn: 0, error: 0 }, noise = { n: 0 };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const stackHead = (e) => String((e && e.stack) || e).split('\n').slice(0, 3).map(s => s.trim()).join(' | ');
  const record = (where, e) => errors.push({ where, name: (e && e.name) || 'Error', message: String((e && e.message) || e), at: stackHead(e) });

  // virtual time
  let vnow = EPOCH, seq = 0, frameSeq = 0;
  const t0 = EPOCH;
  const timers = new Map(), frames = new Map();

  const b = {};                       // the object boot() returns; elements keep a reference for create()/dispatch()
  const registry = new Map();         // '#id' -> element for every id in the html, and selector -> stand-in for the rest
  const staticById = new Map();       // the html's own ids only
  const htmlIds = new Set();          // ids that appeared as id="..." in a string given to innerHTML / insertAdjacentHTML
  const elements = [];                // the html's own elements, in document order
  const winL = {}, docL = {};

  // elements are wrapped so that a property the stub lacks is counted instead of silently undefined
  const wrap = (el) => new Proxy(el, {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      if (typeof p !== 'symbol' && p !== 'then' && p !== 'toJSON') bump(unknown, 'element.' + p);
      return undefined;
    },
  });
  const create = (tag) => wrap(new El(b, tag));
  const text = (s) => { const e = create('#text'); e.nodeType = 3; e._text = String(s); return e; };
  const describe = (t) => {
    if (t === win) return 'window';
    if (t === doc) return 'document';
    return t.id ? '#' + t.id : String(t.tagName || '?').toLowerCase() + (t.className ? '.' + t.className.split(' ')[0] : '');
  };

  function dispatch(target, ev) {
    const e = Object.assign({ bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; } }, ev);
    e.target = e.target || target;
    for (let n = target; n && !e._stop; n = n === win || n === doc ? null : n.parentNode) {
      e.currentTarget = n;
      const store = n === win ? winL : n === doc ? docL : n._l;
      for (const l of (store[e.type] || []).slice()) {
        if (l.once) store[e.type] = store[e.type].filter(x => x !== l);
        try { l.fn.call(n, e); } catch (err) { record(`event ${e.type} on ${describe(n)}`, err); }
      }
      if (e.bubbles === false) break;
    }
    return !e.defaultPrevented;
  }

  // document: the html's static elements, found by selector; anything else is a stand-in
  const query = (sel) => {
    const alts = parseSelector(sel);
    return elements.filter(el => alts.some(c => matchCompound(el, c)));
  };
  const lookup = (sel) => {
    const hit = query(sel)[0];
    if (hit) return hit;
    if (registry.has(sel)) return registry.get(sel);
    bump(fabricated, sel);
    const el = create('div');
    registry.set(sel, el);
    return el;
  };
  const doc = new Proxy({
    readyState: 'loading', hidden: false, visibilityState: 'visible',
    querySelector: lookup,
    querySelectorAll: (sel) => query(sel),
    getElementById: (id) => (staticById.has('#' + id) || htmlIds.has(String(id)) ? lookup('#' + id) : null),
    getElementsByClassName: (c) => query('.' + c),
    getElementsByTagName: (t) => query(t),
    createElement: (t) => create(t),
    createElementNS: (ns, t) => create(t),
    createTextNode: text,
    createDocumentFragment: () => create('fragment'),
    addEventListener(type, fn, o) { if (typeof fn === 'function') (docL[type] = docL[type] || []).push({ fn, once: !!(o && o.once) }); },
    removeEventListener(type, fn) { docL[type] = (docL[type] || []).filter(x => x.fn !== fn); },
    dispatchEvent: (ev) => dispatch(doc, ev),
    hasFocus: () => true,
    title: 'InfiniteGacha', cookie: '',
  }, {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      if (typeof p !== 'symbol') bump(unknown, 'document.' + p);
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  doc.body = create('body');
  doc.documentElement = create('html');
  doc.head = create('head');
  doc.activeElement = doc.body;

  for (const { tag, attrs } of page.tags) {
    if (SKIP_TAGS.has(tag)) continue;
    const el = create(tag);
    for (const [k, v] of attrs) el.setAttribute(k, v);
    elements.push(el);
    if (el.id) { registry.set('#' + el.id, el); staticById.set('#' + el.id, el); }
  }

  // window
  const storage = (() => {
    const m = new Map(opts.storage instanceof Map ? opts.storage : Object.entries(opts.storage || {}));
    return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] || null,
      get length() { return m.size; }, map: m,
    };
  })();
  const loose = (name, base) => new Proxy(base, {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      if (typeof p !== 'symbol' && p !== 'then' && p !== 'toJSON') bump(unknown, name + '.' + p);
      return undefined;
    },
  });
  const reloads = { n: 0 };
  const respond = (url) => {
    const rel = decodeURIComponent(String(url).split(/[?#]/)[0]).replace(/^https?:\/\/[^/]+\//, '').replace(/^\.?\//, '');
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      missing.push(rel);
      const fail = () => Promise.reject(new SyntaxError(`${rel}: not found`));
      return { ok: false, status: 404, url: String(url), json: fail, text: async () => '', arrayBuffer: fail, blob: fail };
    }
    const buf = fs.readFileSync(file);
    return {
      ok: true, status: 200, url: String(url),
      json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  const out = (level) => (...args) => {
    const line = util.format(...args);
    if (NOISE.some(re => re.test(line))) { noise.n++; return; }
    consoleCount[level]++;
    if (consoleLines.length < 200) consoleLines.push({ level, line });
    if (verbose) console[level === 'debug' ? 'log' : level](line);
  };
  const timerFor = (every) => (fn, ms = 0, ...args) => {
    const id = ++seq, d = Math.max(0, +ms || 0);
    timers.set(id, { id, fn, args, due: vnow + d, every: every ? Math.max(1, d) : 0 });
    return id;
  };
  class Img {
    constructor() { this.complete = false; this.width = 0; this.height = 0; this.naturalWidth = 0; this.naturalHeight = 0; }
    addEventListener() {} removeEventListener() {} decode() { return new Promise(() => {}); }
  }
  const sandbox = {
    console: { log: out('log'), info: out('info'), debug: out('debug'), warn: out('warn'), error: out('error'), trace() {}, table() {}, group() {}, groupEnd() {}, time() {}, timeEnd() {}, assert() {}, dir() {} },
    document: doc, localStorage: storage, sessionStorage: (() => { const s = new Map(); return { getItem: k => (s.has(k) ? s.get(k) : null), setItem: (k, v) => { s.set(k, String(v)); }, removeItem: k => { s.delete(k); }, clear: () => s.clear() }; })(),
    setTimeout: timerFor(false), setInterval: timerFor(true),
    clearTimeout: (id) => { timers.delete(id); }, clearInterval: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => { const id = ++frameSeq; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { frames.delete(id); },
    requestIdleCallback: (fn) => timerFor(false)(() => fn({ didTimeout: false, timeRemaining: () => 10 }), 1),
    cancelIdleCallback: (id) => { timers.delete(id); },
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    performance: { now: () => vnow - t0, timeOrigin: t0, mark() {}, measure() {} },
    fetch: async (url) => respond(url),
    Image: Img, Audio: class { play() { return Promise.resolve(); } pause() {} },
    navigator: loose('navigator', { userAgent: 'node-stub', language: 'en-US', languages: ['en-US'], onLine: true, maxTouchPoints: 0, hardwareConcurrency: 4, clipboard: { writeText: async () => {} } }),
    location: loose('location', { href: 'http://localhost/' + htmlName, origin: 'http://localhost', pathname: '/' + htmlName, search: '', hash: '', reload() { reloads.n++; }, replace() {}, assign() {} }),
    history: { pushState() {}, replaceState() {} },
    innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    matchMedia: (q) => ({ matches: false, media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => styleBag(),
    scrollTo() {}, open() { return null; }, focus() {}, blur() {},
    confirm: () => false, alert() {}, prompt: () => null,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    URL: Object.assign(class extends URL {}, { createObjectURL: () => 'blob:stub', revokeObjectURL() {} }),
    URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, structuredClone, atob, btoa,
    FileReader: class { readAsText() {} readAsDataURL() {} },
    crypto: require('crypto').webcrypto,
    addEventListener(type, fn, o) { if (typeof fn === 'function') (winL[type] = winL[type] || []).push({ fn, once: !!(o && o.once) }); },
    removeEventListener(type, fn) { winL[type] = (winL[type] || []).filter(x => x.fn !== fn); },
    dispatchEvent: (ev) => dispatch(win, ev),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext('this.window = this; this.self = this; this.top = this; this.parent = this;', context);
  const win = vm.runInContext('this', context);
  const ctxMath = vm.runInContext('Math', context);
  // a Date whose "now" is the virtual clock; `new Date()` and Date.now() agree
  vm.runInContext(`(function (now) {
    const Real = Date;
    class VDate extends Real {
      constructor(...a) { if (a.length) super(...a); else super(now()); }
      static now() { return now(); }
    }
    this.Date = VDate;
  })`, context).call(win, () => vnow);

  // ---- driving ----
  function advance(ms) {
    const end = vnow + ms;
    let ran = 0;
    for (;;) {
      let next = null;
      for (const t of timers.values()) if (t.due <= end && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) break;
      vnow = Math.max(vnow, next.due);
      if (next.every) next.due += next.every; else timers.delete(next.id);
      if (typeof next.fn === 'function') { try { next.fn(...next.args); } catch (e) { record('timer', e); } }
      if (++ran > MAX_CALLBACKS) { record('timer', new Error('advance() stopped after ' + MAX_CALLBACKS + ' callbacks')); break; }
    }
    vnow = end;
    return ran;
  }
  function frame(n = 1) {
    for (let i = 0; i < n; i++) {
      advance(16);
      const due = [...frames.entries()];
      frames.clear();
      for (const [, fn] of due) { try { fn(vnow - t0); } catch (e) { record('frame', e); } }
    }
  }
  const idle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(r => setImmediate(r)); };
  function fire(target, type, init = {}) {
    const t = target === 'window' ? win : target === 'document' ? doc : typeof target === 'string' ? lookup(target) : target;
    if (target === 'document' && type === 'visibilitychange' && init.hidden !== undefined) doc.hidden = init.hidden;
    return dispatch(t, { type, ...init });
  }
  function withSeed(seed, fn) {
    const rand = mulberry(seed);
    const prev = ctxMath.random;
    ctxMath.random = rand;
    try { return context.Rng ? context.Rng.withSource(rand, fn) : fn(); } finally { ctxMath.random = prev; }
  }

  const onRejection = (e) => record('unhandled rejection', e);
  process.on('unhandledRejection', onRejection);

  Object.assign(b, {
    context, registry, errors, unknown, fabricated, missing, scripts: loaded, skipped, reloads,
    console: consoleLines, consoleCount, noise, localStorage: storage, staticById,
    create, text, dispatch, fire, advance, frame, idle, withSeed, mulberry, record,
    el: lookup, click: (target) => (typeof target === 'string' ? lookup(target) : target).click(),
    noteFabricated: (sel) => bump(fabricated, sel),
    noteHtml: (html) => { for (const m of String(html).matchAll(HTML_ID)) htmlIds.add(m[1] !== undefined ? m[1] : m[2]); },
    now: () => vnow, pendingTimers: () => timers.size,
    eval: (code) => vm.runInContext(code, context),
    dispose: () => process.off('unhandledRejection', onRejection),
  });
  Object.defineProperty(b, 'Game', { get: () => context.Game, enumerable: true });
  Object.defineProperty(b, 'Sortie', { get: () => context.Sortie, enumerable: true });

  // ---- load the scripts in page order ----
  for (const s of page.scripts) {
    if (s.type && !/^(text|application)\/(x-)?(java|ecma)script$/i.test(s.type)) { skipped.push(s.src || '(inline)'); record('load ' + (s.src || '(inline)'), new Error('script type "' + s.type + '" is not supported by the stub')); continue; }
    const name = s.src || '(inline)';
    try {
      const code = s.src ? fs.readFileSync(path.join(root, s.src.split(/[?#]/)[0]), 'utf8') : s.code;
      new vm.Script(code, { filename: name }).runInContext(context);
      loaded.push(name);
    } catch (e) { record('load ' + name, e); }
  }

  // ---- the browser's own order after the last script ----
  doc.readyState = 'interactive';
  dispatch(doc, { type: 'DOMContentLoaded', bubbles: false });
  doc.readyState = 'complete';
  dispatch(win, { type: 'load', bubbles: false });
  for (let i = 0; i < 200 && !(context.Game && context.Game.state); i++) { await idle(); if (!(context.Game && context.Game.state)) advance(50); }
  if (!(context.Game && context.Game.state)) record('boot', new Error('Game.state never appeared'));
  else { advance(100); await idle(); advance(100); await idle(); }
  return b;
}

// ---------- command line ----------

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const hit = args.find(a => a.startsWith('--' + name + '=')); return hit ? hit.slice(name.length + 3) : null; };
  const b = await boot({ html: opt('html') || 'game.html', verbose: args.includes('--verbose') });
  const state = b.Game && b.Game.state;
  console.log(`scripts: ${b.scripts.length} loaded${b.skipped.length ? ', ' + b.skipped.length + ' skipped' : ''}`);
  console.log(`uncaught exceptions during boot: ${b.errors.length}`);
  for (const e of b.errors) console.log(`  ${e.where}: ${e.name}: ${e.message}\n    ${e.at}`);
  console.log(`Game.state: ${state ? 'yes, ' + state.characters.length + ' characters' : 'missing'}; Sortie: ${b.Sortie ? 'yes' : 'missing'}`);
  console.log(`console: ${Object.entries(b.consoleCount).map(([k, v]) => k + ' ' + v).join(', ')}; filtered rot.js lines: ${b.noise.n}`);
  for (const l of b.console.slice(0, 10)) console.log(`  ${l.level}: ${l.line.split('\n')[0]}`);
  if (b.missing.length) console.log(`fetch 404: ${[...new Set(b.missing)].join(', ')}`);
  console.log(`stub gaps: ${b.unknown.size} properties read and absent; ${b.fabricated.size} selectors answered by a stand-in element${args.includes('--gaps') ? '' : ' (--gaps lists them)'}`);
  if (args.includes('--gaps')) {
    for (const [k, n] of [...b.unknown].sort((x, y) => y[1] - x[1])) console.log(`  property ${k} x${n}`);
    for (const [k, n] of [...b.fabricated].sort((x, y) => y[1] - x[1])) console.log(`  selector ${k} x${n}`);
  }
  b.dispose();
  process.exitCode = b.errors.length || !state ? 1 : 0;
}

module.exports = { boot, mulberry, readPage };
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 2; });
