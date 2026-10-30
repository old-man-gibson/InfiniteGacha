export const meta = {
  name: 'game-team',
  description: 'InfiniteGacha review team: 3 Sonnet builders propose or build, 2 Fable antagonists attack, builders revise',
  whenToUse: 'Propose: {mode:"propose", focus?, lenses?:[{key,title,brief}], brief?} returns proposals for the overseer to publish with the decision-board skill. Build: {mode:"build", runTag, wave, units:[{id, owner, title, files, after?, specs, overseer, userNote?}]} builds approved units under file locks, then both antagonists review the wave and builders fix. Run one wave per invocation.',
  phases: [
    { title: 'Survey', detail: 'three Sonnet builders, one lens each', model: 'sonnet' },
    { title: 'Attack', detail: 'two Fable antagonists, design and engineering', model: 'fable' },
    { title: 'Revise', detail: 'builders answer the attacks', model: 'sonnet' },
    { title: 'Build', detail: 'builders implement approved proposals', model: 'sonnet' },
    { title: 'Review', detail: 'antagonists check the built code', model: 'fable' },
    { title: 'Fix', detail: 'builders fix what the review confirmed', model: 'sonnet' },
  ],
}

// Setup chosen by the user (2026-10-23): the main session is the overseer and publishes every
// proposal as an Artifact; three Sonnet agents at xhigh brainstorm and build; two Fable agents at
// max effort act as antagonists. Builders never publish anything themselves.
const BUILDER = { model: 'sonnet', effort: 'xhigh' }
const ANTAGONIST = { model: 'fable', effort: 'max' }

const ROOT = 'C:\\Users\\mersi\\Documents\\InfiniteGacha'
const MEMORY = 'C:\\Users\\mersi\\.claude\\projects\\C--Users-mersi-Documents-InfiniteGacha\\memory'

const CONTEXT = `
You are on a team improving InfiniteGacha, a plain-JS browser game (no build step) at ${ROOT}.
game.html is the game; its <script> tags give the load order. Every module is an IIFE exporting
window.X and module.exports, so most modules can be required from Node for headless checks.
test/ holds Node harnesses. For any figure about how the game plays use test/sortie.harness.js
(boots game.html's scripts via test/game.boot.js and runs real sorties on combat.js; usage at its
top). test/field.harness.js is the plain attrition resolver with invented stats: only for comparing
field.js/tactics.js variants with each other. Run every test/*.js that covers what you touched;
new or edited comments must pass node test/register.js --strict.

Before anything else read ${MEMORY}\\MEMORY.md and every memory file it lists. They hold the
user's standing preferences, and proposals that ignore them are rejected. The most load-bearing:
- axes-not-hardcoded-behaviors: prefer a few interacting axes over special-cased behaviours.
- wire-second-order-effects: a new system must change how the existing ones play.
- numbers-must-be-traceable: every figure shown is derivable from things the player can point at.
- ui-prose-engineer-style: plain engineering prose in UI text and comments; no mood or metaphor.
- user-browser-games: adult proportions, no chibi.
- Permadeath: anything that prevents a death is valued far above damage.

Rules for everyone:
- Do NOT use the browser tools; the overseer owns the one browser pane. Use Node instead.
- Another Claude session may edit this folder at the same time. Re-read a file right before
  you edit it and keep edits narrow.
- Cite evidence as file:line. Claims you did not check against the code are worthless here.
- Match the surrounding code's naming, comment density and idiom.`

const LENSES = [
  {
    key: 'loop',
    title: 'Core loop and engagement',
    brief: `What does a player actually do minute to minute and hour to hour? Trace the loop
from summoning through roster management, missions/sorties, rewards and back. Find where the
player has no meaningful decision, waits with nothing to plan, cannot see why they won or lost,
or has no reason to care about a specific character. Propose changes that create decisions and
attachment, built from the systems already present.`,
  },
  {
    key: 'systems',
    title: 'Systems depth and interaction',
    brief: `The codebase has many systems (elements, conditions, temper, bonds, lodging, crew,
gifts, potential, spellcraft, psionics, martial, prowess, facet, townlife, quests ...). Find
systems that are computed but never change a decision, systems that do not touch each other where
they obviously should, and parallel mechanisms that should be one axis. Propose wiring and
consolidation that makes the existing systems matter more, rather than new systems.`,
  },
  {
    key: 'cleanup',
    title: 'Code health and player-facing clarity',
    brief: `Find dead code, duplicated logic across modules, stale ids, broken or unreachable
UI flows, errors you can reproduce by requiring modules in Node, numbers shown without a
traceable source, and UI text that violates the engineer-prose rule. Propose a cleanup set that
lowers maintenance cost and makes the game easier to read for a player, with a concrete list of
what to delete, merge or rename.`,
  },
]

const PROPOSAL = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short kebab-case id, prefixed with the lens key' },
    title: { type: 'string' },
    problem: { type: 'string', description: 'what is wrong or missing today, from the player view' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'file:line citations with one-line notes' },
    change: { type: 'string', description: 'the concrete change: mechanics, numbers, UI, data' },
    playerEffect: { type: 'string', description: 'which decision or feeling this creates and why it is more engaging' },
    secondOrder: { type: 'string', description: 'how existing systems play differently afterwards' },
    files: { type: 'array', items: { type: 'string' } },
    size: { type: 'string', enum: ['S', 'M', 'L'] },
    risks: { type: 'string' },
  },
  required: ['id', 'title', 'problem', 'evidence', 'change', 'playerEffect', 'secondOrder', 'files', 'size', 'risks'],
}

const SURVEY = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    stateOfGame: { type: 'string', description: 'what you found, 1-3 paragraphs' },
    proposals: { type: 'array', items: PROPOSAL, description: '3 to 6 proposals, best first' },
  },
  required: ['lens', 'stateOfGame', 'proposals'],
}

const ATTACK = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['keep', 'rework', 'kill'] },
          attack: { type: 'string', description: 'the strongest case against it' },
          evidenceCheck: { type: 'string', description: 'which cited evidence you verified or found false' },
          demand: { type: 'string', description: 'what must change for you to accept it' },
        },
        required: ['id', 'verdict', 'attack', 'evidenceCheck', 'demand'],
      },
    },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'proposals that contradict or overlap each other' },
    missed: { type: 'array', items: { type: 'string' }, description: 'problems all three builders missed' },
  },
  required: ['verdicts', 'conflicts', 'missed'],
}

const ANTAGONISTS = [
  {
    key: 'design',
    brief: `You are the design antagonist. Assume each proposal makes the game worse or no more
interesting until shown otherwise. Ask: does it create a real decision or only a bigger number?
Does it fight the user's stated preferences (axes, traceable numbers, permadeath value, engineer
prose)? Is it a new system bolted on where wiring existing ones would do? Would a player notice?`,
  },
  {
    key: 'engineering',
    brief: `You are the engineering antagonist. Assume each proposal's evidence is wrong until you
have opened the cited lines yourself. Ask: is the problem real in the current code? Is the change
feasible at the stated size? What breaks (save compatibility, load order, other modules, the
concurrent session's files)? Is the cleanup deleting something still referenced? Run Node checks.`,
  },
]

const REVISION = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...PROPOSAL.properties,
          status: { type: 'string', enum: ['kept', 'reworked', 'dropped'] },
          response: { type: 'string', description: 'answer to each antagonist attack' },
        },
        required: [...PROPOSAL.required, 'status', 'response'],
      },
    },
  },
  required: ['proposals'],
}

const BUILT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    filesCreated: { type: 'array', items: { type: 'string' } },
    filesDeleted: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' }, description: 'Node commands run and their results' },
    openIssues: { type: 'string', description: 'what is not done, not verified, or needs a file outside the lock' },
  },
  required: ['id', 'done', 'summary', 'filesChanged', 'filesCreated', 'filesDeleted', 'checks', 'openIssues'],
}

const REVIEW = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'string', description: 'id of the unit that caused it' },
          file: { type: 'string' },
          line: { type: 'number' },
          problem: { type: 'string' },
          repro: { type: 'string' },
          severity: { type: 'string', enum: ['bug', 'regression', 'spec-miss', 'style'] },
        },
        required: ['unit', 'file', 'line', 'problem', 'repro', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const mode = (args && args.mode) || 'propose'
const focus = args && args.focus ? `\nThe user asked this run to focus on: ${args.focus}\n` : ''
// A focused round passes its own lenses ({key, title, brief}) and a brief every builder follows.
const lenses = (args && args.lenses) || LENSES
const roundBrief = args && args.brief ? `\n${args.brief}\n` : ''

if (mode === 'propose') {
  phase('Survey')
  const surveys = await parallel(lenses.map(l => () =>
    agent(`${CONTEXT}${focus}${roundBrief}
You are a builder. Your lens: ${l.title}.
${l.brief}
Read the code that matters for your lens and run Node checks where they settle a question.
Return 3 to 6 proposals, best first, ids prefixed "${l.key}-", unless the round brief sets the
ids and count. Other builders cover other lenses, so stay inside yours. Two antagonists will attack every claim, so cite real lines.`,
      { ...BUILDER, label: `builder:${l.key}`, phase: 'Survey', schema: SURVEY })))

  const live = surveys.map((s, i) => s && { ...s, lens: lenses[i].key }).filter(Boolean)
  const dropped = lenses.filter((l, i) => !surveys[i]).map(l => l.key)
  if (dropped.length) log(`no survey from: ${dropped.join(', ')}`)
  const all = JSON.stringify(live, null, 1)

  // Barrier above is intended: antagonists must see every proposal to find conflicts and gaps.
  phase('Attack')
  const attacks = await parallel(ANTAGONISTS.map(a => () =>
    agent(`${CONTEXT}
${a.brief}
Here are all builder proposals as JSON:
${all}
Give a verdict on every proposal id. Then list conflicts between proposals and problems all
builders missed. Default to "rework" or "kill" when uncertain.`,
      { ...ANTAGONIST, label: `antagonist:${a.key}`, phase: 'Attack', schema: ATTACK })))

  phase('Revise')
  const revisions = await parallel(live.map(s => () => {
    const ids = new Set(s.proposals.map(p => p.id))
    const against = ANTAGONISTS.map((a, i) => attacks[i] && {
      antagonist: a.key,
      verdicts: attacks[i].verdicts.filter(v => ids.has(v.id)),
      conflicts: attacks[i].conflicts,
      missed: attacks[i].missed,
    }).filter(Boolean)
    return agent(`${CONTEXT}
You are the "${s.lens}" builder. Your proposals:
${JSON.stringify(s.proposals, null, 1)}
The antagonists replied:
${JSON.stringify(against, null, 1)}
${roundBrief}For each proposal: rework it to meet a demand you accept, defend it with checked evidence where
the attack is wrong, or drop it. You may add at most one new proposal from the "missed" list if
it belongs to your lens. Return the full final list.`,
      { ...BUILDER, label: `revise:${s.lens}`, phase: 'Revise', schema: REVISION })
  }))

  return {
    mode,
    surveys: live,
    attacks: ANTAGONISTS.map((a, i) => attacks[i] && { antagonist: a.key, ...attacks[i] }).filter(Boolean),
    revised: live.map((s, i) => revisions[i] && { lens: s.lens, stateOfGame: s.stateOfGame, ...revisions[i] }).filter(Boolean),
  }
}

if (mode === 'build') {
  // args: { runTag, wave, units: [{ id, owner, title, files, after?, specs, overseer, userNote? }] }
  // files is the lock set: a unit starts only when no running unit holds any of its files and
  // every unit named in after has finished. Almost every unit edits sortie.js, so the locks, not
  // the owners, decide what runs in parallel.
  const units = (args && args.units) || []
  const tag = (args && args.runTag) || 'run'
  const wave = (args && args.wave) || tag
  if (!units.length) return { mode, error: 'no units passed in args.units' }
  const backup = `${ROOT}\\.team-backup\\${tag}`
  const norm = f => String(f).replace(/\//g, '\\').replace(ROOT + '\\', '').toLowerCase()

  async function schedule(list, run) {
    const ids = new Set(list.map(u => u.id))
    const done = new Map(), locked = new Set(), running = new Map()
    const waiting = [...list]
    while (waiting.length || running.size) {
      for (let i = 0; i < waiting.length;) {
        const u = waiting[i]
        const ready = (u.after || []).every(d => !ids.has(d) || done.has(d))
        const free = u.files.every(f => !locked.has(norm(f)))
        if (ready && free) {
          waiting.splice(i, 1)
          u.files.forEach(f => locked.add(norm(f)))
          running.set(u.id, Promise.resolve(run(u)).catch(e => ({ error: String(e) })).then(r => ({ u, r })))
        } else i++
      }
      if (!running.size) { log(`cannot schedule: ${waiting.map(u => u.id).join(', ')}`); break }
      const { u, r } = await Promise.race(running.values())
      running.delete(u.id)
      u.files.forEach(f => locked.delete(norm(f)))
      done.set(u.id, r)
    }
    return list.map(u => ({ id: u.id, result: done.get(u.id) || null }))
  }

  const lockRules = u => `
You hold a lock on exactly these files and may create, edit or delete only them:
${u.files.map(f => '- ' + f).join('\n')}
Other builders are editing other files at this moment. If the work needs a change to a file outside
your list, do not make it: describe it in openIssues. Before your first edit to an existing file,
copy it to ${backup}\\<same relative path> unless a copy is already there (the folder has no git
history; this is the only undo). Copy a file there before deleting it too.`

  phase('Build')
  const builds = await schedule(units, u => agent(`${CONTEXT}
You are the "${u.owner}" builder. ${wave}, unit "${u.id}": ${u.title}.
The user approved this unit on the proposals page. The overseer's instruction, which wins where
it narrows or merges the proposals below:
${u.overseer}
${u.userNote ? `The user's note on this unit, which wins over everything else: ${u.userNote}\n` : ''}
The approved proposal text, each with the antagonists' verdicts and the builder's answers:
${u.specFile ? `Read it from ${u.specFile} before anything else.` : JSON.stringify(u.specs, null, 1)}
${lockRules(u)}
Implement it. Line numbers in the proposals may have moved; re-read before each edit. Verify with
Node: require the modules you touched, run the tests the proposal names (write them if it says to),
and run any existing test/ script that covers the area. Report every command and its result.`,
    { ...BUILDER, label: `build:${u.id}`, phase: 'Build', schema: BUILT }))

  // Barrier: each antagonist reviews the whole wave, so it can see interactions between units.
  phase('Review')
  const summary = units.map((u, i) => ({ id: u.id, title: u.title, files: u.files, specFile: u.specFile || null, overseer: u.overseer, userNote: u.userNote || null, report: builds[i].result }))
  const reviews = await parallel(ANTAGONISTS.map(a => () => agent(`${CONTEXT}
${a.brief}
${wave} has just been built. Every unit, its instruction and its builder's report:
${JSON.stringify(summary, null, 1)}
The approved proposal text is in each unit's specFile; the overseer instruction above summarises it.
Originals of every edited or deleted file are under ${backup} (same relative paths); diff them
against the current files. Look for: spec misses, regressions, broken load order, save-format
breaks, units that interfere with each other, and tests that pass without testing the claim.
Report only problems you reproduced or can point at a line for, each tagged with its unit id.
An empty list is a fine answer.`,
    { ...ANTAGONIST, label: `review:${a.key}`, phase: 'Review', schema: REVIEW })))

  const findings = ANTAGONISTS.flatMap((a, i) => (reviews[i] ? reviews[i].findings : []).map(f => ({ ...f, by: a.key })))
  const toFix = units.map(u => ({ ...u, findings: findings.filter(f => f.unit === u.id && f.severity !== 'style') }))
    .filter(u => u.findings.length)
  const unowned = findings.filter(f => !units.some(u => u.id === f.unit))
  if (unowned.length) log(`${unowned.length} findings name no unit; returned for the overseer`)

  phase('Fix')
  const fixes = await schedule(toFix, u => agent(`${CONTEXT}
You are the "${u.owner}" builder who built unit "${u.id}" (${u.title}).${u.specFile ? ` Its approved spec is in ${u.specFile}.` : ''} The antagonists reported:
${JSON.stringify(u.findings, null, 1)}
${lockRules(u)}
Reproduce each finding. Fix the real ones; for each false one, say why with evidence. Re-run the
unit's checks and report the commands and results.`,
    { ...BUILDER, label: `fix:${u.id}`, phase: 'Fix', schema: BUILT }))

  return { mode, wave, backup, builds, findings, unowned, fixes }
}

return { mode, error: `unknown mode ${mode}` }
