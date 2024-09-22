/**
 * Unknown is never a pass, and never a success.
 *
 * The failure this tool exists to prevent is a summary an agent acts on that
 * says a call succeeded when nobody established that it did. Every path that
 * stops short of complete evidence is exercised here, and each is asserted on
 * the report status, the process exit code, and what the rendered text actually
 * says -- because any one of the three could be restored by an edit while the
 * other two still tell the truth.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { compressToolResults } from '../src/index.mjs'
import {
  cleanup, fakeClock, filler, findingFor, findingsFor, makeTree, resultsDocument, runReport, section,
} from './helpers.mjs'

test('an unknown outcome makes the run incomplete however many other results succeeded', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      { id: 'a', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', '1')] },
      { id: 'b', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', '2')] },
      { id: 'c', tool: 't', status: 'unknown', sections: [section('id', 'identifier', '3')] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.compressed.verdict, 'unknown')
  assert.equal(report.compressed.text.includes('VERDICT succeeded'), false)
})

test('a section whose text was never saved is incomplete, not an empty section', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      {
        id: 'a',
        tool: 't',
        status: 'succeeded',
        sections: [
          section('id', 'identifier', '1'),
          { name: 'stdout', kind: 'evidence', priority: 1, pointer: 'runs/a/stdout.log' },
        ],
      },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  const finding = findingFor(report, 'section-text-missing')
  assert.match(finding.message, /carries no text, so its content was never obtained/)
  assert.equal(finding.location.file, 'runs/a/stdout.log')
  // It is not quietly reported as an omission, which would imply it was there to omit.
  assert.deepEqual(findingsFor(report, 'section-omitted'), [])
  assert.equal(report.compressed.text.includes('stdout'), false)
})

test('a missing failure reason says the reason was never saved, not that none was supplied', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      { id: 'a', tool: 't', status: 'failed', sections: [section('id', 'identifier', '1')] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 2)
  assert.equal(report.status, 'incomplete')
  assert.match(findingFor(report, 'failure-reason-missing').message, /was never saved and cannot survive compression/)
})

test('an expired clock stops selection and offers no summary at all', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      {
        id: 'a',
        tool: 't',
        status: 'succeeded',
        sections: [
          section('id', 'identifier', 'abc'),
          { ...section('body', 'evidence', filler(200), { pointer: 'runs/a/body' }), priority: 1 },
        ],
      },
    ]),
  })
  t.after(() => cleanup(root))

  // The clock is injected, never read: the first call starts the budget and
  // every later call reports that ten seconds have already gone by.
  const expired = await compressToolResults({
    results: join(root, 'results.json'),
    budgetChars: 4000,
    limits: { timeoutMs: 5000 },
    now: fakeClock(1_000_000, 10_000),
  })
  assert.equal(expired.status, 'incomplete')
  assert.equal(expired.compressed, null, 'the arrangement selection had reached must not be offered')
  assert.match(findingFor(expired, 'time-budget-exceeded').message, /during selection/)

  // The same document with a clock that does not jump produces a summary.
  const finished = await compressToolResults({
    results: join(root, 'results.json'),
    budgetChars: 4000,
    limits: { timeoutMs: 5000 },
    now: fakeClock(1_000_000, 0),
  })
  assert.equal(finished.status, 'pass')
  assert.notEqual(finished.compressed, null)
})

test('an unreadable document says so, and does not report "no results were declared"', async (t) => {
  const root = await makeTree({ 'elsewhere.json': '{}' })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.deepEqual(findingsFor(report, 'no-results-declared'), [])
  assert.match(findingFor(report, 'results-unreadable').message, /could not be inspected \(ENOENT\)/)
  assert.equal(report.compressed, null)
})

test('a document declaring no results is a failure, not a green summary of nothing', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([]) })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.compressed, null)
  assert.equal(findingFor(report, 'no-results-declared').severity, 'error')
})

test('an incomplete report is still valid JSON on stdout, per the exit-2 contract', async (t) => {
  const root = await makeTree({ 'results.json': 'not json at all' })
  t.after(() => cleanup(root))

  const { report, status, stdout } = runReport(root)
  assert.equal(status, 2)
  assert.notEqual(stdout, '')
  assert.equal(report.tool, 'tool-result-compressor')
  assert.equal(report.status, 'incomplete')
})

test('a summary that cannot hold the required material is not produced at all', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      {
        id: 'a',
        tool: 't',
        status: 'failed',
        sections: [
          section('why', 'failure', filler(500)),
          section('do', 'next-action', filler(500)),
        ],
      },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root, ['--budget-chars', '200'])
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.compressed, null)
  assert.equal(report.summary.usedChars, null)
  assert.equal(report.summary.retained, 0)
  assert.match(findingFor(report, 'budget-too-small-for-required').message, /no summary was produced/)
})
