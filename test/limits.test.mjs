/**
 * Every documented limit, enforced.
 *
 * A configuration key accepted and silently ignored is how a one-character typo
 * turns a real failure into a green run, and how a documented bound becomes a
 * decoration. Each limit below is driven to its edge through the real CLI: one
 * run under it that completes, one run over it that reports `incomplete` and
 * exits 2.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, compressToolResults } from '../src/index.mjs'
import { cleanup, filler, findingFor, makeTree, resultsDocument, runCli, runReport, section } from './helpers.mjs'

const ok = (id, sections) => ({ id, tool: 'some.tool', status: 'succeeded', sections })

test('maxDocumentBytes: a document over the limit is not parsed', async (t) => {
  const document = resultsDocument([ok('a', [section('id', 'identifier', 'abc')])])
  const root = await makeTree({ 'results.json': document })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-document-bytes', String(document.length)]).status, 0)
  const over = runReport(root, ['--max-document-bytes', String(document.length - 1)])
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxDocumentBytes limit/)
})

test('maxResults: a document with more results than the limit is not compressed', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      ok('a', [section('id', 'identifier', '1')]),
      ok('b', [section('id', 'identifier', '2')]),
    ]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-results', '2']).status, 0)
  const over = runReport(root, ['--max-results', '1'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxResults limit of 1/)
  assert.equal(over.report.compressed, null)
})

test('maxSectionsPerResult: a result with more sections than the limit is not compressed', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      ok('a', [section('one', 'identifier', '1'), section('two', 'identifier', '2')]),
    ]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-sections-per-result', '2']).status, 0)
  const over = runReport(root, ['--max-sections-per-result', '1'])
  assert.equal(over.status, 2)
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxSectionsPerResult limit of 1/)
})

test('maxSectionChars: an over-long section stops the run rather than being truncated', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([ok('a', [section('body', 'evidence', filler(100), { pointer: 'runs/body' })])]),
  })
  t.after(() => cleanup(root))

  assert.equal(runReport(root, ['--max-section-chars', '100']).status, 0)
  const over = runReport(root, ['--max-section-chars', '99'])
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.match(findingFor(over.report, 'limit-exceeded').message, /maxSectionChars limit of 99/)
  assert.equal(over.report.compressed, null, 'a truncated section must not reach a summary')
})

test('timeoutMs: the budget is enforced against an injected clock, not a real one', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      ok('a', [
        section('id', 'identifier', 'abc'),
        { ...section('body', 'evidence', filler(200), { pointer: 'runs/body' }), priority: 1 },
      ]),
    ]),
  })
  t.after(() => cleanup(root))

  let calls = 0
  const stepping = () => {
    calls += 1
    // The first call starts the budget; the second is already past it.
    return calls === 1 ? 5_000 : 5_000 + 250
  }
  const expired = await compressToolResults({
    results: join(root, 'results.json'), budgetChars: 4000, limits: { timeoutMs: 200 }, now: stepping,
  })
  assert.equal(expired.status, 'incomplete')
  assert.equal(expired.compressed, null)
  assert.match(findingFor(expired, 'time-budget-exceeded').message, /200ms time budget/)

  const patient = await compressToolResults({
    results: join(root, 'results.json'), budgetChars: 4000, limits: { timeoutMs: 1000 }, now: () => 5_000,
  })
  assert.equal(patient.status, 'pass')
})

test('an unknown limit key is refused rather than ignored', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([ok('a', [section('id', 'identifier', '1')])]) })
  t.after(() => cleanup(root))

  await assert.rejects(
    compressToolResults({ results: join(root, 'results.json'), budgetChars: 100, limits: { maxResultz: 5 } }),
    /Unknown limit "maxResultz"/,
  )
})

test('a limit value that is not a positive integer is refused', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([ok('a', [section('id', 'identifier', '1')])]) })
  t.after(() => cleanup(root))
  const results = join(root, 'results.json')

  await assert.rejects(compressToolResults({ results, budgetChars: 100, limits: { maxResults: 0 } }), /integer of 1 or more/)
  await assert.rejects(compressToolResults({ results, budgetChars: 100, limits: { maxResults: 1.5 } }), /integer of 1 or more/)
  await assert.rejects(compressToolResults({ results, budgetChars: 100, limits: { timeoutMs: -1 } }), /integer of 0 or more/)
})

test('a budget that is not a positive integer is refused by the library too', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([ok('a', [section('id', 'identifier', '1')])]) })
  t.after(() => cleanup(root))
  const results = join(root, 'results.json')

  await assert.rejects(compressToolResults({ results, budgetChars: 0 }), /budget of 1 or more characters/)
  await assert.rejects(compressToolResults({ results }), /budget of 1 or more characters/)
  await assert.rejects(compressToolResults({ budgetChars: 10 }), /results document path is required/)
})

test('every documented limit has a CLI flag, and every CLI limit flag is documented', () => {
  const help = runCli(['--help']).stdout
  const flags = new Map([
    ['maxDocumentBytes', '--max-document-bytes'],
    ['maxResults', '--max-results'],
    ['maxSectionChars', '--max-section-chars'],
    ['maxSectionsPerResult', '--max-sections-per-result'],
    ['timeoutMs', '--timeout-ms'],
  ])
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [...flags.keys()].sort())
  for (const [key, flag] of flags) {
    assert.ok(help.includes(flag), `${flag} is missing from the help text`)
    assert.ok(help.includes(String(DEFAULT_LIMITS[key])), `the default for ${key} is missing from the help text`)
  }
})
