/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * empty and the message goes to stderr. An input that could not be read means
 * the run had a subject and failed to obtain evidence about it, so stdout
 * carries an `incomplete` report -- a consumer needs that report to know *which*
 * input was not read.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { cleanup, makeTree, resultsDocument, runCli, section } from './helpers.mjs'

const GOOD = resultsDocument([
  { id: 'call-1', tool: 'some.tool', status: 'succeeded', sections: [section('id', 'identifier', 'abc')] },
])

async function fixture(t, document = GOOD) {
  const root = await makeTree({ 'results.json': document })
  t.after(() => cleanup(root))
  return join(root, 'results.json')
}

test('--help prints the help on stdout and exits 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^tool-result-compressor/)
  assert.match(result.stdout, /Exit codes:/)
  assert.equal(result.stderr, '')
})

test('the help says the budget is characters and not tokens', () => {
  const help = runCli(['--help']).stdout
  assert.match(help, /The budget is characters, not tokens/)
  assert.match(help, /does not tokenize/)
})

test('an unknown option is refused rather than ignored, with empty stdout', () => {
  const result = runCli(['--results', 'x.json', '--budget-chars', '100', '--max-resultz', '5'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--max-resultz"/)
})

test('a repeated flag is refused rather than silently last-wins', async (t) => {
  const results = await fixture(t)
  const result = runCli(['--results', results, '--budget-chars', '4000', '--budget-chars', '40'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--budget-chars was given more than once/)
})

test('a missing --results or --budget-chars is a configuration error with empty stdout', async (t) => {
  const results = await fixture(t)
  const noResults = runCli(['--budget-chars', '100'])
  assert.equal(noResults.status, 2)
  assert.equal(noResults.stdout, '')
  assert.match(noResults.stderr, /--results is required/)

  const noBudget = runCli(['--results', results])
  assert.equal(noBudget.status, 2)
  assert.equal(noBudget.stdout, '')
  assert.match(noBudget.stderr, /--budget-chars is required/)
})

test('a budget of zero is refused: there is no summary that fits nothing', async (t) => {
  const results = await fixture(t)
  const result = runCli(['--results', results, '--budget-chars', '0'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--budget-chars requires an integer of 1 or more/)
})

test('a flag that needs a value and does not get one is refused', () => {
  const result = runCli(['--results'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--results requires a value/)
})

test('an unreadable input produces a report on stdout, per the other shape of exit 2', async (t) => {
  const root = await makeTree({ 'elsewhere.json': '{}' })
  t.after(() => cleanup(root))

  const result = runCli(['--results', join(root, 'results.json'), '--budget-chars', '4000', '--json'])
  assert.equal(result.status, 2)
  assert.notEqual(result.stdout, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'results-unreadable')
})

test('stdout carries the JSON report and nothing else', async (t) => {
  const results = await fixture(t)
  const result = runCli(['--results', results, '--budget-chars', '4000', '--json'])
  assert.equal(result.status, 0)
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(result.stderr, '')
})

test('the human rendering is the default and shows the summary itself', async (t) => {
  const results = await fixture(t)
  const result = runCli(['--results', results, '--budget-chars', '4000'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^PASS {2}every saved result succeeded/)
  assert.match(result.stdout, /--- summary ---/)
  assert.match(result.stdout, /VERDICT succeeded/)
})

test('no absolute host path ever reaches the report', async (t) => {
  const results = await fixture(t, resultsDocument([
    {
      id: 'call-1',
      tool: 'some.tool',
      status: 'failed',
      sections: [section('why', 'failure', 'nope', { pointer: 'runs/why.txt' })],
    },
  ]))
  const result = runCli(['--results', results, '--budget-chars', '4000', '--json'])
  const report = JSON.parse(result.stdout)
  assert.ok(report.findings.length > 0)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false, finding.location.file)
  }
  assert.equal(result.stdout.includes(results), false, 'the absolute input path reached stdout')
})

test('the report envelope matches the house contract', async (t) => {
  const results = await fixture(t)
  const report = JSON.parse(runCli(['--results', results, '--budget-chars', '4000', '--json']).stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'tool-result-compressor')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  assert.equal(typeof report.summary.checked, 'number')
  assert.equal(typeof report.summary.errors, 'number')
  assert.equal(typeof report.summary.warnings, 'number')
  assert.ok(Array.isArray(report.findings))
})

test('the exported tool id equals the package and directory name', async () => {
  const { TOOL_ID } = await import('../src/index.mjs')
  const pkg = await import('../package.json', { with: { type: 'json' } })
  assert.equal(TOOL_ID, 'tool-result-compressor')
  assert.equal(pkg.default.name, TOOL_ID)
})
