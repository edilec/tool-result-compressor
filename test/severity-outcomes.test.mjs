/**
 * Severity, pinned behaviourally.
 *
 * A frozen `ruleId -> severity` table is a good source of truth and a bad
 * guard: when the test also keeps its own expected-value map, the guarantee is
 * three declarations agreeing with each other, and one coordinated edit passes.
 *
 * So every assertion below writes its expectation out as a literal at the
 * assertion site -- the severity string, the status string and the process exit
 * code -- and takes nothing from a table, a parameter or an import. Flipping one
 * row of RULE_SEVERITY cannot be made to pass by editing the README and one map;
 * it has to be argued with here, rule by rule, and for the rules whose severity
 * decides the verdict it cannot be argued with at all, because an exit code is
 * not editable.
 *
 * Every rule the tool can emit appears exactly once. The closing test asserts
 * that, so a rule added without an outcome test fails the suite.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { cleanup, filler, findingFor, makeTree, resultsDocument, runReport, section } from './helpers.mjs'

const covered = new Set()

async function exercise(t, ruleId, files, args = []) {
  covered.add(ruleId)
  const root = await makeTree(files)
  t.after(() => cleanup(root))
  return runReport(root, args)
}

const doc = (results, extra) => ({ 'results.json': resultsDocument(results, extra) })
const ok = (id, sections) => ({ id, tool: 'some.tool', status: 'succeeded', sections })

test('budget-too-small-for-required is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'budget-too-small-for-required',
    doc([ok('a', [section('id', 'identifier', filler(400))])]), ['--budget-chars', '50'])
  assert.equal(findingFor(report, 'budget-too-small-for-required').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.compressed, null)
})

test('duplicate-result-id is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'duplicate-result-id', doc([
    ok('same', [section('id', 'identifier', 'one')]),
    ok('same', [section('id', 'identifier', 'two')]),
  ]))
  assert.equal(findingFor(report, 'duplicate-result-id').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('duplicate-section-name is a warning: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'duplicate-section-name', doc([
    ok('a', [section('id', 'identifier', 'one'), section('id', 'identifier', 'two')]),
  ]))
  assert.equal(findingFor(report, 'duplicate-section-name').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
})

test('failure-reason-missing is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'failure-reason-missing', doc([
    { id: 'a', tool: 't', status: 'failed', sections: [section('do', 'next-action', 'retry')] },
  ]))
  assert.equal(findingFor(report, 'failure-reason-missing').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('limit-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'limit-exceeded',
    doc([ok('a', [section('id', 'identifier', '1')]), ok('b', [section('id', 'identifier', '2')])]),
    ['--max-results', '1'])
  assert.equal(findingFor(report, 'limit-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('next-action-missing is a warning that contributes no error to the verdict', async (t) => {
  const { report, status } = await exercise(t, 'next-action-missing', doc([
    { id: 'a', tool: 't', status: 'failed', sections: [section('why', 'failure', 'nope')] },
  ]))
  assert.equal(findingFor(report, 'next-action-missing').severity, 'warning')
  // The run fails, but on `result-failed` alone: this warning added no error.
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(findingFor(report, 'result-failed').severity, 'error')
})

test('no-results-declared is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'no-results-declared', doc([]))
  assert.equal(findingFor(report, 'no-results-declared').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.summary.checked, 0)
})

test('omitted-section-not-retrievable is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'omitted-section-not-retrievable', doc([
    ok('a', [section('id', 'identifier', '1'), { ...section('dump', 'evidence', filler(900)), priority: 1 }]),
  ]), ['--budget-chars', '300'])
  assert.equal(findingFor(report, 'omitted-section-not-retrievable').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('result-failed is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'result-failed', doc([
    { id: 'a', tool: 't', status: 'failed', sections: [section('why', 'failure', 'nope'), section('do', 'next-action', 'retry')] },
  ]))
  assert.equal(findingFor(report, 'result-failed').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.notEqual(report.compressed, null, 'the summary is still produced, carrying the reason')
})

test('result-status-unknown is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'result-status-unknown', doc([
    { id: 'a', tool: 't', status: 'unknown', sections: [section('id', 'identifier', '1')] },
  ]))
  assert.equal(findingFor(report, 'result-status-unknown').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('results-invalid-json is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'results-invalid-json', { 'results.json': '{"results": [' })
  assert.equal(findingFor(report, 'results-invalid-json').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('results-not-utf8 is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'results-not-utf8', {
    'results.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  })
  assert.equal(findingFor(report, 'results-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('results-schema-invalid is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'results-schema-invalid', {
    'results.json': JSON.stringify({ schemaVersion: '1', resultz: [], results: [] }),
  })
  assert.equal(findingFor(report, 'results-schema-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('results-unreadable is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'results-unreadable', { 'elsewhere.json': '{}' })
  assert.equal(findingFor(report, 'results-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('retrieval-pointer-invalid is an error: the run fails and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'retrieval-pointer-invalid', doc([
    ok('a', [section('id', 'identifier', '1', { pointer: '/etc/passwd' })]),
  ]))
  assert.equal(findingFor(report, 'retrieval-pointer-invalid').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
})

test('section-omitted is info: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'section-omitted', doc([
    ok('a', [
      section('id', 'identifier', '1'),
      { ...section('dump', 'evidence', filler(900), { pointer: 'runs/a/dump.txt' }), priority: 1 },
    ]),
  ]), ['--budget-chars', '300'])
  assert.equal(findingFor(report, 'section-omitted').severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.equal(report.summary.omitted, 1)
})

test('section-text-missing is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'section-text-missing', doc([
    ok('a', [{ name: 'empty', kind: 'evidence', priority: 0 }, section('id', 'identifier', '1')]),
  ]))
  assert.equal(findingFor(report, 'section-text-missing').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('source-hash-malformed is a warning: the run still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'source-hash-malformed', doc([
    ok('a', [section('id', 'identifier', '1', { sourceHash: 'not a digest' })]),
  ]))
  assert.equal(findingFor(report, 'source-hash-malformed').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
})

test('time-budget-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'time-budget-exceeded', doc([
    ok('a', [section('id', 'identifier', '1'), { ...section('e', 'evidence', filler(50)), priority: 1 }]),
  ]), ['--timeout-ms', '0'])
  assert.equal(findingFor(report, 'time-budget-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
})

test('every rule in the catalog has an outcome test above', () => {
  assert.deepEqual([...covered].sort(), Object.keys(RULE_SEVERITY).sort())
})
