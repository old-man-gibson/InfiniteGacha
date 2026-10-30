// The node driver over the shared corpus. `node --test test/facet.node.js`, or plain `node` on it.
// This repo has no package.json and no installed runner, and this file is four lines of real work so
// that it stays that way: the corpus itself imports nothing, because the other host runs it under a
// different runner and it has to be the same file in both.

const path = require('path');
const dir = path.join(__dirname, '..', 'facet');

for (const m of ['core', 'data', 'registry', 'cells', 'relations', 'pipeline', 'gate', 'mortal', 'forge', 'oracle', 'compile', 'cases']) {
  require(path.join(dir, 'facet.' + m + '.js'));
}

const cases = globalThis.FacetCases;
const names = Object.keys(cases);
let passed = 0;
const failures = [];

for (const name of names) {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
  try {
    globalThis.Facet.uninstall();
    cases[name](assert, globalThis.FacetFakeHost());
    passed++;
  } catch (e) {
    failures.push({ name, message: e && e.message, stack: e && e.stack });
  }
}

console.log(passed + '/' + names.length + ' passed');
for (const f of failures) {
  console.log('\nFAIL  ' + f.name + '\n      ' + f.message);
  if (process.env.FACET_STACK) console.log(f.stack);
}
process.exitCode = failures.length ? 1 : 0;
