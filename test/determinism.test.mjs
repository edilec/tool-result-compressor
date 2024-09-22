/**
 * The same document produces the same bytes.
 *
 * A compressed summary is cached, diffed and fed back to a model, so its byte
 * layout is part of the contract. Nothing about the host may reach it: not the
 * wall clock, not the locale, not the order the filesystem happens to enumerate
 * anything in, not an absolute path.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { compressToolResults } from '../src/index.mjs'
import { cleanup, filler, makeTree, resultsDocument, runCli } from './helpers.mjs'

const BUSY = resultsDocument([
  {
    id: 'zeta',
    tool: 'payments.refund',
    status: 'failed',
    sections: [
      { name: 'Z-reason', kind: 'failure', priority: 0, text: 'declined', pointer: 'runs/Z.txt' },
      { name: 'a-id', kind: 'identifier', priority: 0, text: 'ord_1', pointer: 'runs/a.json' },
      { name: 'a_next', kind: 'next-action', priority: 0, text: 'retry later', pointer: 'runs/a_b.md' },
      { name: 'README', kind: 'evidence', priority: 3, text: filler(600), sourceHash: 'sha256:0011223344556677', pointer: 'runs/README.md' },
      { name: 'assets', kind: 'context', priority: 1, text: filler(400), sourceHash: 'sha256:8899aabbccddeeff', pointer: 'runs/assets.json' },
    ],
  },
  {
    id: 'Alpha',
    tool: 'ledger.post',
    status: 'succeeded',
    sections: [{ name: 'entry', kind: 'identifier', priority: 0, text: 'led_2', pointer: 'runs/entry.json' }],
  },
])

test('two runs over one document produce byte-identical stdout', async (t) => {
  const root = await makeTree({ 'results.json': BUSY })
  t.after(() => cleanup(root))

  const args = ['--results', join(root, 'results.json'), '--budget-chars', '700', '--json']
  const first = runCli(args)
  const second = runCli(args)

  assert.equal(first.status, second.status)
  assert.equal(first.stdout, second.stdout)
  const report = JSON.parse(first.stdout)
  assert.ok(report.findings.length >= 2, 'the fixture must actually produce findings')
  assert.ok(report.summary.omitted >= 1, 'the fixture must actually omit something')
})

test('the same document in two different directories produces the same report', async (t) => {
  const one = await makeTree({ 'results.json': BUSY })
  const two = await makeTree({ 'results.json': BUSY })
  t.after(() => cleanup(one))
  t.after(() => cleanup(two))

  const first = runCli(['--results', join(one, 'results.json'), '--budget-chars', '700', '--json'])
  const second = runCli(['--results', join(two, 'results.json'), '--budget-chars', '700', '--json'])
  assert.equal(first.stdout, second.stdout)
})

test('no wall clock reaches the report: two very different clocks agree', async (t) => {
  const root = await makeTree({ 'results.json': BUSY })
  t.after(() => cleanup(root))

  const early = await compressToolResults({ results: join(root, 'results.json'), budgetChars: 700, now: () => 0 })
  const late = await compressToolResults({
    results: join(root, 'results.json'), budgetChars: 700, now: () => 4_102_444_800_000,
  })
  assert.equal(JSON.stringify(early), JSON.stringify(late))
})

test('the key order of the report is fixed, not inherited from an object literal', async (t) => {
  const root = await makeTree({ 'results.json': BUSY })
  t.after(() => cleanup(root))

  const report = JSON.parse(runCli(['--results', join(root, 'results.json'), '--budget-chars', '700', '--json']).stdout)
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'compressed', 'findings'])
  assert.deepEqual(Object.keys(report.summary), [
    'checked', 'errors', 'warnings', 'results', 'sections', 'retained', 'omitted', 'budgetChars', 'usedChars',
  ])
  assert.deepEqual(Object.keys(report.compressed), [
    'schemaVersion', 'verdict', 'budgetChars', 'results', 'omitted', 'usedChars', 'text',
  ])
  for (const finding of report.findings) {
    const keys = Object.keys(finding)
    assert.deepEqual(keys.slice(0, 4), ['ruleId', 'severity', 'message', 'location'])
    for (const key of keys.slice(4)) assert.ok(['evidence', 'suggestion'].includes(key), key)
  }
})

test('results keep their declared order, because a trace is chronological', async (t) => {
  const root = await makeTree({ 'results.json': BUSY })
  const parsed = JSON.parse(BUSY)
  const reversed = await makeTree({
    'results.json': JSON.stringify({ ...parsed, results: [...parsed.results].reverse() }, null, 2),
  })
  t.after(() => cleanup(root))
  t.after(() => cleanup(reversed))

  const forwards = JSON.parse(runCli(['--results', join(root, 'results.json'), '--budget-chars', '700', '--json']).stdout)
  const backwards = JSON.parse(runCli(['--results', join(reversed, 'results.json'), '--budget-chars', '700', '--json']).stdout)

  assert.deepEqual(forwards.compressed.results.map((result) => result.id), ['zeta', 'Alpha'])
  assert.deepEqual(backwards.compressed.results.map((result) => result.id), ['Alpha', 'zeta'])
  // The verdict and the rules fired do not depend on that order.
  assert.equal(forwards.status, backwards.status)
  assert.equal(forwards.compressed.verdict, backwards.compressed.verdict)
  assert.deepEqual(
    forwards.findings.map((finding) => finding.ruleId).sort(),
    backwards.findings.map((finding) => finding.ruleId).sort(),
  )
})

test('the summary written to --out is the same document the report carries', async (t) => {
  const root = await makeTree({ 'results.json': BUSY })
  t.after(() => cleanup(root))
  const destination = join(root, 'summary.json')

  const result = runCli([
    '--results', join(root, 'results.json'), '--budget-chars', '700', '--out', destination, '--json',
  ])
  const report = JSON.parse(result.stdout)
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(destination, 'utf8'), `${JSON.stringify(report.compressed, null, 2)}\n`)
})
