/**
 * The three acceptance criteria, each demonstrated through the real CLI.
 *
 *   1. A failure reason and required IDs survive compression.
 *   2. Omitted sections are listed.
 *   3. No summary turns unknown into success.
 *
 * Every assertion names the observable outcome -- the text a reader actually
 * receives, the rule that fired, the report status and the process exit code --
 * rather than agreeing with a table somewhere else in the tool.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanup, filler, findingFor, findingsFor, makeTree, resultsDocument, runReport, section } from './helpers.mjs'

const REASON = 'Refund declined: acquirer code 51 (insufficient funds in the source account).'
const ORDER_ID = 'ord_9F2KQ4'
const IDEMPOTENCY_ID = 'idem_7710BCDE'

const FAILED_CALL = {
  id: 'call-0007',
  tool: 'payments.refund',
  status: 'failed',
  sections: [
    section('error', 'failure', REASON, { sourceHash: 'sha256:9f2c1a4b7e0d3c5a', pointer: 'results/call-0007/error.txt' }),
    section('order', 'identifier', ORDER_ID, { sourceHash: 'sha256:11aa22bb33cc44dd', pointer: 'results/call-0007/ids.json' }),
    section('idempotency', 'identifier', IDEMPOTENCY_ID, { pointer: 'results/call-0007/ids.json' }),
    section('retry', 'next-action', 'Fund the source account, then retry with the same key.', { pointer: 'results/call-0007/next.md' }),
    {
      name: 'transcript',
      kind: 'evidence',
      priority: 9,
      text: `REQUEST POST /v2/refunds ${filler(2000)}`,
      sourceHash: 'sha256:deadbeefdeadbeef',
      pointer: 'results/call-0007/transcript.log',
    },
  ],
}

test('1. the failure reason and every required identifier survive a budget that cannot hold the evidence', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([FAILED_CALL]) })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root, ['--budget-chars', '600'])

  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  const { text } = report.compressed

  // The three things a caller cannot act without are in the text a model reads.
  assert.ok(text.includes(REASON), 'the failure reason did not survive compression')
  assert.ok(text.includes(ORDER_ID), 'a required identifier did not survive compression')
  assert.ok(text.includes(IDEMPOTENCY_ID), 'a second required identifier did not survive compression')
  assert.ok(text.includes('Fund the source account'), 'the next action did not survive compression')

  // And the budget was genuinely binding, so this is not a pass on a roomy run.
  assert.ok(report.compressed.usedChars <= 600)
  assert.equal(report.summary.omitted, 1)
  assert.ok(!text.includes(filler(100)), 'the evidence body was kept after all')
  assert.equal(findingFor(report, 'result-failed').severity, 'error')
})

test('1b. required material is kept even when it is the lowest-priority thing in the document', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([{
      id: 'call-1',
      tool: 'deploy.apply',
      status: 'failed',
      sections: [
        { ...section('why', 'failure', 'quota exceeded in eu-west-1'), priority: 99 },
        { ...section('release', 'identifier', 'rel_22190'), priority: 99 },
        { ...section('do', 'next-action', 'raise the quota, then re-apply'), priority: 99 },
        { ...section('log', 'evidence', filler(900), { pointer: 'runs/1/log.txt' }), priority: 0 },
      ],
    }]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root, ['--budget-chars', '400'])
  assert.equal(status, 1)
  const { text } = report.compressed
  assert.ok(text.includes('quota exceeded in eu-west-1'))
  assert.ok(text.includes('rel_22190'))
  assert.ok(text.includes('raise the quota'))
  assert.equal(report.summary.omitted, 1)
})

test('1c. when the required material cannot fit, no summary is produced rather than a truncated one', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([FAILED_CALL]) })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root, ['--budget-chars', '80'])

  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.compressed, null, 'a summary was produced that cannot have held the required material')
  const finding = findingFor(report, 'budget-too-small-for-required')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /needs \d+ characters; the budget is 80/)
  assert.match(finding.suggestion, /Raise --budget-chars to at least \d+/)

  // And the advice works when it is followed. The budget is rendered into the
  // summary, so the arrangement's length depends on the digit count of the
  // number being named: a refusal measured against the budget it just refused
  // names a number that is refused again.
  const needed = Number(/needs (\d+) characters/.exec(finding.message)[1])
  const raised = runReport(root, ['--budget-chars', String(needed)])
  assert.notEqual(raised.report.compressed, null, `the run at ${needed} was refused again`)
  assert.ok(raised.report.summary.usedChars <= needed)
  // One character less is still refused, so the number is the smallest that
  // works rather than a comfortable over-estimate.
  assert.equal(runReport(root, ['--budget-chars', String(needed - 1)]).report.compressed, null)
})

test('2. every omitted section is listed in the summary with its hash and pointer', async (t) => {
  const root = await makeTree({ 'results.json': resultsDocument([FAILED_CALL]) })
  t.after(() => cleanup(root))

  const { report } = runReport(root, ['--budget-chars', '600'])
  const { text, omitted } = report.compressed

  assert.equal(omitted.length, 1)
  assert.deepEqual(omitted[0], {
    result: 'call-0007',
    name: 'transcript',
    kind: 'evidence',
    priority: 9,
    chars: 2025,
    sourceHash: 'sha256:deadbeefdeadbeef',
    pointer: 'results/call-0007/transcript.log',
  })

  // Listed inside the rendered text, not only in a side channel the reader never sees.
  assert.match(text, /OMITTED 1 section\(s\); retrieve them at these pointers:/)
  assert.ok(text.includes('call-0007/transcript (evidence, 2025 chars) sha256:deadbeefdeadbeef results/call-0007/transcript.log'))

  const omittedFinding = findingFor(report, 'section-omitted')
  assert.equal(omittedFinding.severity, 'info')
  assert.equal(omittedFinding.location.file, 'results/call-0007/transcript.log')
})

test('2b. an omitted section that cannot be fetched back is an error, not a note', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([{
      id: 'call-2',
      tool: 'index.rebuild',
      status: 'succeeded',
      sections: [
        section('id', 'identifier', 'idx_5'),
        // No source hash and no retrieval pointer: once this is omitted it is gone.
        { ...section('dump', 'evidence', filler(900)), priority: 1 },
      ],
    }]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root, ['--budget-chars', '300'])
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  const finding = findingFor(report, 'omitted-section-not-retrievable')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /neither a source hash nor a retrieval pointer/)
  // It is still listed, so the reader at least knows what is missing.
  assert.match(report.compressed.text, /call-2\/dump \(evidence, 900 chars\) no source hash no retrieval pointer/)
})

test('2c. nothing omitted says so explicitly rather than saying nothing', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([{
      id: 'call-3', tool: 'ping', status: 'succeeded', sections: [section('id', 'identifier', 'p_1')],
    }]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)
  assert.equal(status, 0)
  assert.match(report.compressed.text, /OMITTED none/)
})

test('3. an unknown outcome is rendered as unknown, is never rolled up as success, and exits 2', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      { id: 'call-a', tool: 'billing.charge', status: 'succeeded', sections: [section('id', 'identifier', 'ch_1')] },
      { id: 'call-b', tool: 'billing.capture', status: 'unknown', sections: [section('id', 'identifier', 'cap_2')] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.compressed.verdict, 'unknown')
  assert.match(report.compressed.text, /^VERDICT unknown \| results 2 \(succeeded 1, failed 0, unknown 1\)/)
  assert.match(report.compressed.text, /\[call-b\] billing\.capture STATUS unknown/)
  assert.equal(findingFor(report, 'result-status-unknown').severity, 'error')
  // The summary is still produced: the caller needs to see which call is unknown.
  assert.notEqual(report.compressed, null)
})

test('3b. a result with no status at all is an unknown outcome, not a success', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      { id: 'call-c', tool: 'queue.drain', sections: [section('id', 'identifier', 'q_9')] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.compressed.verdict, 'unknown')
  assert.match(report.compressed.text, /STATUS unknown/)
  assert.match(findingFor(report, 'result-status-unknown').message, /records no status at all/)
})

test('3c. a failed result with no saved reason is incomplete, not a summary that omits the reason', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([
      { id: 'call-d', tool: 'dns.update', status: 'failed', sections: [section('id', 'identifier', 'z_1')] },
    ]),
  })
  t.after(() => cleanup(root))

  const { report, status } = runReport(root)

  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.match(findingFor(report, 'failure-reason-missing').message, /the reason it failed was never saved/)
  assert.equal(report.compressed.verdict, 'failed')
})

test('3d. a rollup only reaches "succeeded" when every single result succeeded', async (t) => {
  const clean = await makeTree({
    'results.json': resultsDocument([
      { id: 'a', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', '1')] },
      { id: 'b', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', '2')] },
    ]),
  })
  t.after(() => cleanup(clean))
  const passing = runReport(clean)
  assert.equal(passing.status, 0)
  assert.equal(passing.report.compressed.verdict, 'succeeded')

  const mixed = await makeTree({
    'results.json': resultsDocument([
      { id: 'a', tool: 't', status: 'succeeded', sections: [section('id', 'identifier', '1')] },
      { id: 'b', tool: 't', status: 'failed', sections: [section('why', 'failure', 'nope'), section('do', 'next-action', 'retry')] },
      { id: 'c', tool: 't', status: 'unknown', sections: [section('id', 'identifier', '3')] },
    ]),
  })
  t.after(() => cleanup(mixed))
  const { report, status } = runReport(mixed)
  assert.equal(report.compressed.verdict, 'failed', 'a failure outranks an unknown in the rollup')
  assert.equal(report.status, 'incomplete', 'and the unknown still makes the run incomplete')
  assert.equal(status, 2)
  assert.equal(findingsFor(report, 'result-status-unknown').length, 1)
})
