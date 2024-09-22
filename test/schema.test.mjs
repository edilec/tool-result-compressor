/**
 * The results document schema.
 *
 * Unknown keys are the point of this file. A key accepted and silently ignored
 * is how `sourceHashes` for `sourceHash` loses a provenance record without
 * anybody noticing, and how a `kind` typo turns a required failure reason into
 * a section the budget may drop. Every level of the document is checked, and
 * every rejection is checked for the JSON Pointer that says where it is.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RESULT_STATUSES, SECTION_KINDS, isRequiredKind, validateResultsDocument } from '../src/results.mjs'
import { cleanup, findingFor, findingsFor, makeTree, resultsDocument, runReport, section } from './helpers.mjs'

const good = () => ({
  schemaVersion: '1',
  results: [{ id: 'a', tool: 't', status: 'succeeded', sections: [{ name: 'id', kind: 'identifier', priority: 0, text: 'x' }] }],
})

test('a well-formed document validates, and an absent status becomes unknown', () => {
  const validated = validateResultsDocument(good())
  assert.equal(validated.ok, true)
  assert.equal(validated.document.results[0].status, 'succeeded')
  assert.equal(validated.document.results[0].statusDeclared, true)

  const noStatus = good()
  delete noStatus.results[0].status
  const second = validateResultsDocument(noStatus)
  assert.equal(second.document.results[0].status, 'unknown')
  assert.equal(second.document.results[0].statusDeclared, false)
})

test('an unknown key is rejected at every level, with a pointer to it', () => {
  const cases = [
    [(document) => { document.resultz = [] }, '/resultz', /unknown top-level key/],
    [(document) => { document.results[0].statuz = 'ok' }, '/results/0/statuz', /unknown result key/],
    [(document) => { document.results[0].sections[0].sourceHashes = 'x' }, '/results/0/sections/0/sourceHashes', /unknown section key/],
  ]
  for (const [mutate, pointer, detail] of cases) {
    const document = good()
    mutate(document)
    const validated = validateResultsDocument(document)
    assert.equal(validated.ok, false, `${pointer} should have been rejected`)
    const problem = validated.problems.find((entry) => entry.pointer === pointer)
    assert.ok(problem !== undefined, `expected a problem at ${pointer}, got ${validated.problems.map((p) => p.pointer).join(', ')}`)
    assert.match(problem.detail, detail)
  }
})

test('every required field is required, and every optional field is typed', () => {
  const cases = [
    [(document) => { document.schemaVersion = '2' }, '/schemaVersion'],
    [(document) => { delete document.results }, '/results'],
    [(document) => { document.results = {} }, '/results'],
    [(document) => { delete document.results[0].id }, '/results/0/id'],
    [(document) => { delete document.results[0].tool }, '/results/0/tool'],
    [(document) => { document.results[0].status = 'maybe' }, '/results/0/status'],
    [(document) => { document.results[0].sections = 'lots' }, '/results/0/sections'],
    [(document) => { delete document.results[0].sections[0].name }, '/results/0/sections/0/name'],
    [(document) => { document.results[0].sections[0].kind = 'notes' }, '/results/0/sections/0/kind'],
    [(document) => { document.results[0].sections[0].priority = -1 }, '/results/0/sections/0/priority'],
    [(document) => { document.results[0].sections[0].priority = 1.5 }, '/results/0/sections/0/priority'],
    [(document) => { document.results[0].sections[0].text = 42 }, '/results/0/sections/0/text'],
    [(document) => { document.results[0].sections[0].sourceHash = 42 }, '/results/0/sections/0/sourceHash'],
    [(document) => { document.results[0].sections[0].pointer = 42 }, '/results/0/sections/0/pointer'],
  ]
  for (const [mutate, pointer] of cases) {
    const document = good()
    mutate(document)
    const validated = validateResultsDocument(document)
    assert.equal(validated.ok, false, `${pointer} should have been rejected`)
    assert.ok(
      validated.problems.some((entry) => entry.pointer === pointer),
      `expected a problem at ${pointer}, got ${validated.problems.map((p) => p.pointer).join(', ')}`,
    )
  }
})

test('a document that is not an object at all is rejected', () => {
  for (const value of [null, [], 'text', 7]) {
    assert.equal(validateResultsDocument(value).ok, false)
  }
})

test('every problem in a document is reported, not only the first', () => {
  const document = good()
  document.alpha = 1
  document.beta = 2
  document.results[0].gamma = 3
  const validated = validateResultsDocument(document)
  assert.equal(validated.ok, false)
  assert.deepEqual(validated.problems.map((entry) => entry.pointer).sort(), ['/alpha', '/beta', '/results/0/gamma'])
})

test('the kinds are split into required and optional, and nothing is in both', () => {
  const required = SECTION_KINDS.filter(isRequiredKind)
  const optional = SECTION_KINDS.filter((kind) => !isRequiredKind(kind))
  assert.deepEqual(required.sort(), ['failure', 'identifier', 'next-action'])
  assert.deepEqual(optional.sort(), ['context', 'evidence'])
  assert.equal(required.length + optional.length, SECTION_KINDS.length)
})

test('the statuses are exactly the three the tool reasons about', () => {
  assert.deepEqual([...RESULT_STATUSES], ['succeeded', 'failed', 'unknown'])
})

test('a schema problem reaches the report as one finding per problem, and exits 2', async (t) => {
  const document = JSON.parse(resultsDocument([
    { id: 'a', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', 'x')] },
  ]))
  document.alpha = 1
  document.results[0].beta = 2
  const root = await makeTree({ 'results.json': JSON.stringify(document) })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'results-schema-invalid').length, 2)
  assert.equal(findingFor(report, 'results-schema-invalid').location.file, 'results.json')
  assert.equal(report.compressed, null)
})
