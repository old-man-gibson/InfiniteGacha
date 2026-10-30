// Register lint for code comments. `node test/register.js`; exit code 1 on any finding.
//
// The project's comments state mechanisms and figures in plain engineering prose. Two patterns
// kept coming back in review and are checked here, one per comment line:
//
//   shouted lead-in   a run of three or more all-capital words, 15 characters or longer, anywhere
//                     in a comment line (single A and I count as words). This is how a paragraph
//                     that opens with its own slogan, or a clause shouted mid-sentence, shows up.
//                     State the topic as a normal sentence instead.
//   banned phrase     whole point, is the point, not a detail, a promise, silently, quietly. These
//                     stand in for a stated consequence. Say what fails and how: "throws", "does
//                     nothing and returns false", "reads undefined".
//
// What is scanned: the .js files directly in the project folder, so facet/, vendor/, ulpc/,
// assets/, test/ and the dot folders are not. Also skipped: facet.*.js (the facet engine and its
// bindings keep their own register until the facet pass) and generator*.js. Strings and regular
// expression literals are skipped, so UI text and patterns that contain these words are not
// findings; only comment text is.
//
// DEFERRED lists known violations that have not been rewritten yet. Each entry is tolerated
// while its text is still in the file and fails the run once the text is gone, so the entry has
// to be deleted when the line is rewritten. Do not add entries for new comments; rewrite them.
// The current entries are in game-owned files that the comment pass did not have in its file
// list (economy, elements, lpc, mapgen, tokens, townlife, townview). Every run prints each one
// as DEFERRED file:line, and `node test/register.js --strict` counts them as failures, so a
// clean plain run does not mean the register is clean while DEFERRED is not empty.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const SKIP_FILE = [/^facet\..*\.js$/, /^generator.*\.js$/];

const DEFERRED = [
];

const WORD = "(?:[A-Z]{2,}(?:'[A-Z]+)?|A|I)";
const SHOUT = new RegExp(`(?<![A-Za-z0-9_])${WORD}(?:,? ${WORD}(?![A-Za-z0-9_]))+`, 'g');
const SHOUT_MIN_CHARS = 15, SHOUT_MIN_WORDS = 3;
const PHRASE = /\b(whole point|is the point|not a detail|a promise|silently|quietly)\b/i;

// ---------- comment extraction ----------
// A scanner over the source that tracks strings, template literals and regular expression
// literals, so that '//' inside them is not read as a comment. It returns each comment line as
// { line, text } with the comment markers removed.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'else', 'do', 'instanceof', 'new']);

function commentLines(src) {
  const out = [];
  const n = src.length;
  let i = 0, line = 1;
  let last = '';            // last significant character or word in code, to tell '/' division from a regex
  const tpl = [];           // brace depth at each open template literal's ${ ... }
  let depth = 0;
  const push = (text, atLine) => out.push({ line: atLine, text });
  const regexAllowed = () => last === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || REGEX_AFTER_WORD.has(last);

  while (i < n) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && nx === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      push(src.slice(i + 2, j).replace(/\r$/, ''), line);
      i = j; continue;
    }
    if (ch === '/' && nx === '*') {
      let j = src.indexOf('*/', i + 2);
      if (j < 0) j = n;
      const body = src.slice(i + 2, j).split(/\r?\n/);
      body.forEach((t, k) => push(t.replace(/^\s*\*+ ?/, ''), line + k));
      line += body.length - 1;
      i = j + 2; last = ''; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1; last = 'str'; continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') line++;
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { tpl.push(depth); depth++; j += 2; i = j; last = '{'; break; }
        j++;
      }
      if (src[j] === '`') { i = j + 1; last = 'str'; }
      else if (j >= n) i = n;
      continue;
    }
    if (ch === '{') { depth++; last = '{'; i++; continue; }
    if (ch === '}') {
      depth--;
      i++;
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        // resume the template literal text after the closing brace of ${ ... }
        let j = i;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '\n') line++;
          if (src[j] === '`') { j++; last = 'str'; break; }
          if (src[j] === '$' && src[j + 1] === '{') { tpl.push(depth); depth++; j += 2; last = '{'; break; }
          j++;
        }
        i = j;
      } else last = '}';
      continue;
    }
    if (ch === '/') {
      if (regexAllowed()) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        i = j; last = 'str'; continue;
      }
      last = '/'; i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      last = src.slice(i, j); i = j; continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      last = 'num'; i = j; continue;
    }
    last = ch; i++;
  }
  return out;
}

// ---------- checks ----------
function findings(text) {
  const found = [];
  for (const m of text.matchAll(SHOUT)) {
    if (m[0].length >= SHOUT_MIN_CHARS && m[0].split(/[ ,]+/).length >= SHOUT_MIN_WORDS) found.push('shouted lead-in "' + m[0] + '"');
  }
  const p = text.match(PHRASE);
  if (p) found.push('banned phrase "' + p[0] + '"');
  return found;
}

function scan(file, src) {
  const res = [];
  for (const c of commentLines(src)) for (const what of findings(c.text)) res.push({ file, line: c.line, what, text: c.text.trim() });
  return res;
}

module.exports = { commentLines, findings, scan };

// ---------- self-check ----------
// The lint passes when it finds nothing, so a broken pattern or scanner would pass as well. These
// lines must be flagged, these must not, and the sample source must yield exactly its two comments.
const MUST_FLAG = [
  'THE PAPER DOES NOT CARE HOW IT FELT. A squad that broke off',
  'ACUMEN IS THE EYE, TEMPER IS THE PATIENCE. The tier fixes',
  'its job is to make REST BEFORE A MISSION mean something',
  'a mortality bound that silently does nothing',
  'which is the whole point of it',
  'That asymmetry is the point.',
  'This is not a detail.',
  'the target quietly pockets the gain',
  'a promise this code has made',
];
const MUST_PASS = [
  'MANA / SPIRIT  Only for the half of the roster that casts.',
  'Uses HP, MP and SP for STR and DEX checks.',
  'STAT_MAX is 30 and BROKEN_* thresholds apply.',
  'A star cannot be bought.',
  'Facet.install throws instead of warning, because a silent failure here disables the damage bound',
  'A shape is whole points, none negative',
];
const SAMPLE = [
  "const a = 'http://x'; // first comment",
  'const re = /\\/\\/ silently/g;',
  "const t = `${'//'} quietly ${a}`;",
  'const d = 4 / 2; /* second',
  '   comment */',
  "const s = 'whole point';",
].join('\n');

function selfCheck() {
  let bad = 0;
  for (const t of MUST_FLAG) if (!findings(t).length) { bad++; console.log(`FAIL self-check: not flagged: ${t}`); }
  for (const t of MUST_PASS) if (findings(t).length) { bad++; console.log(`FAIL self-check: flagged: ${t}`); }
  const got = commentLines(SAMPLE).map((c) => `${c.line}:${c.text.trim()}`).join('|');
  const want = '1:first comment|4:second|5:comment';
  if (got !== want) { bad++; console.log(`FAIL self-check: scanner returned ${got}, wanted ${want}`); }
  return bad;
}

// ---------- run ----------
if (require.main === module) {
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.js') && !SKIP_FILE.some((re) => re.test(f))).sort();
  const strict = process.argv.includes('--strict');
  let failed = selfCheck(), deferred = 0, comments = 0;
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    comments += commentLines(src).length;
    for (const r of scan(f, src)) {
      const d = DEFERRED.findIndex((e) => e.file === f && r.text.includes(e.has));
      if (d >= 0) {
        used.add(d); deferred++;
        if (strict) failed++;
        console.log(`${strict ? 'FAIL' : 'DEFERRED'} ${f}:${r.line} ${r.what}\n       ${r.text.slice(0, 140)}`);
        continue;
      }
      failed++;
      console.log(`FAIL ${f}:${r.line} ${r.what}\n       ${r.text.slice(0, 140)}`);
    }
  }
  DEFERRED.forEach((e, d) => {
    if (used.has(d)) return;
    failed++;
    console.log(`FAIL DEFERRED entry for ${e.file} ("${e.has}") matches no finding; delete it from test/register.js`);
  });
  console.log(`scanned ${files.length} files, ${comments} comment lines, ${deferred} deferred`);
  if (failed) console.log(`${failed} failed`);
  else if (deferred) console.log(`passed, but ${deferred} comment lines are tolerated by DEFERRED and still need rewriting (--strict fails on them)`);
  else console.log('all passed');
  process.exit(failed ? 1 : 0);
}
