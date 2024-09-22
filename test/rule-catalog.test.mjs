/**
 * The documented catalog and the frozen table, checked in both directions.
 *
 * This is a documentation test, not a severity test: the behavioural pinning
 * lives in `severity-outcomes.test.mjs`, which drives real inputs through the
 * CLI and asserts exit codes. What this file catches is the other failure --
 * a rule that exists in the code and not in the README, or a rule the README
 * promises that the code cannot emit. A documentation overclaim is a defect
 * here, so it is tested like one.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { DEFAULT_LIMITS, INCOMPLETE_RULES, RULE_SEVERITY, TOOL_ID } from '../src/index.mjs'
import { OPTIONAL_KINDS, REQUIRED_KINDS, RESULT_STATUSES, SECTION_KINDS } from '../src/results.mjs'

const README = new URL('../README.md', import.meta.url)

async function documentedRules() {
  const text = await readFile(README, 'utf8')
  const rows = [...text.matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|info) \| /gm)]
  return new Map(rows.map((row) => [row[1], row[2]]))
}

test('every rule the tool can emit appears in the README rule table', async () => {
  const documented = await documentedRules()
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(documented.has(ruleId), `${ruleId} is missing from the README rule table`)
  }
})

test('every rule the README promises exists in the tool', async () => {
  const documented = await documentedRules()
  for (const ruleId of documented.keys()) {
    assert.ok(ruleId in RULE_SEVERITY, `the README documents ${ruleId}, which the tool cannot emit`)
  }
})

test('the documented severity matches the frozen table for every rule', async () => {
  const documented = await documentedRules()
  for (const [ruleId, severity] of documented) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `${ruleId} is documented as ${severity}`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
})

test('every rule that forces an incomplete run is named in the README', async () => {
  const text = await readFile(README, 'utf8')
  const start = text.indexOf('Nine of these mean the run did not obtain the evidence')
  assert.notEqual(start, -1, 'the README must name the count of incomplete-forcing rules')
  const paragraph = text.slice(start, text.indexOf('## Guarantees'))
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(paragraph.includes(`\`${ruleId}\``), `${ruleId} forces an incomplete run but the README does not say so`)
  }
  // "Nine" is a number written out in the prose; it has to stay true.
  assert.equal(INCOMPLETE_RULES.length, 9)
})

test('every incomplete rule is a real rule', () => {
  for (const ruleId of INCOMPLETE_RULES) assert.ok(ruleId in RULE_SEVERITY, ruleId)
})

test('the README limits table matches the defaults the tool uses', async () => {
  const text = await readFile(README, 'utf8')
  const rows = [...text.matchAll(/^\| `(max[A-Za-z]+|timeoutMs)` \| `(--[a-z-]+)` \| (\d+) \|$/gm)]
  const documented = new Map(rows.map((row) => [row[1], Number(row[3])]))
  assert.deepEqual([...documented.keys()].sort(), Object.keys(DEFAULT_LIMITS).sort())
  for (const [key, value] of documented) assert.equal(DEFAULT_LIMITS[key], value, key)
})

test('the README section-kind table matches the kinds the tool accepts', async () => {
  const text = await readFile(README, 'utf8')
  const rows = [...text.matchAll(/^\| `([a-z-]+)` \| (required|optional) \| /gm)]
  const documented = new Map(rows.map((row) => [row[1], row[2]]))

  assert.deepEqual([...documented.keys()].sort(), [...SECTION_KINDS].sort())
  for (const kind of REQUIRED_KINDS) assert.equal(documented.get(kind), 'required', kind)
  for (const kind of OPTIONAL_KINDS) assert.equal(documented.get(kind), 'optional', kind)
  assert.equal(REQUIRED_KINDS.length + OPTIONAL_KINDS.length, SECTION_KINDS.length)
})

test('the README names every status the schema accepts, and says an absent one is unknown', async () => {
  const text = await readFile(README, 'utf8')
  for (const status of RESULT_STATUSES) assert.ok(text.includes(`\`${status}\``), status)
  assert.match(text, /absent means unknown/)
})

test('the README names the tool and its exit codes', async () => {
  const text = await readFile(README, 'utf8')
  assert.ok(text.includes(TOOL_ID))
  for (const code of ['`0`', '`1`', '`2`']) assert.ok(text.includes(code), code)
  assert.match(text, /empty stdout|\*\*empty\*\*/)
})

test('the README does not promise a confinement the code does not perform', async () => {
  const text = await readFile(README, 'utf8')
  // Hole 2 is followed, deliberately, and the README must say so rather than
  // claiming a root this tool does not have.
  assert.match(text, /Not refused: a symbolically linked parent directory/)
  assert.match(text, /no\s+confinement root/)
})

test('the README does not claim to tokenize', async () => {
  const text = await readFile(README, 'utf8')
  assert.match(text, /does not tokenize and does not\s+implement byte-pair encoding/)
  assert.match(text, /It is not a tokenizer/)
})
