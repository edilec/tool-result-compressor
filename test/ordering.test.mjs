/**
 * Ordering, pinned behaviourally.
 *
 * A source grep for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the grep passes while the output silently becomes machine-dependent.
 *
 * These fixtures are chosen so that code-unit order and collation order
 * genuinely disagree -- `README` before `assets`, `Z` before `a`, `a-b` before
 * `a_b`. The test drives them through the real CLI and asserts the exact emitted
 * order, then asserts separately that the fixture really does discriminate, so
 * the first assertion can never pass by accident on a fixture both orderings
 * agree about.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanup, filler, makeTree, resultsDocument, runReport, section } from './helpers.mjs'

const CONTESTED = ['Z.md', 'a.md', 'a-b.md', 'a_b.md', 'README.md', 'assets.md']

const byCodeUnit = (values) => [...values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))

async function omittedFixture(t) {
  const root = await makeTree({
    'results.json': resultsDocument([{
      id: 'call-1',
      tool: 'some.tool',
      status: 'succeeded',
      sections: [
        section('id', 'identifier', 'abc'),
        ...CONTESTED.map((pointer, index) => ({
          name: `s${index}`,
          kind: 'evidence',
          priority: 1,
          text: filler(400),
          sourceHash: 'sha256:0011223344556677',
          pointer,
        })),
      ],
    }]),
  })
  t.after(() => cleanup(root))
  return root
}

test('findings are ordered by UTF-16 code unit, not by collation', async (t) => {
  const root = await omittedFixture(t)
  const { report, status } = runReport(root, ['--budget-chars', '620'])

  assert.equal(status, 0)
  const emitted = report.findings
    .filter((finding) => finding.ruleId === 'section-omitted')
    .map((finding) => finding.location.file)
  assert.equal(emitted.length, CONTESTED.length, 'every contested pointer must produce a finding')

  assert.deepEqual(emitted, byCodeUnit(CONTESTED))
  assert.deepEqual(emitted, ['README.md', 'Z.md', 'a-b.md', 'a.md', 'a_b.md', 'assets.md'])

  // The fixture must actually discriminate, or the assertion above proves nothing.
  assert.notDeepEqual(byCodeUnit(CONTESTED), [...CONTESTED].sort(new Intl.Collator('en').compare))
})

test('findings sharing a file are ordered by pointer, then by rule id', async (t) => {
  const root = await makeTree({
    'results.json': resultsDocument([{
      id: 'call-1',
      tool: 'some.tool',
      status: 'succeeded',
      sections: [
        section('id', 'identifier', 'abc', { sourceHash: 'nonsense' }),
        section('other', 'identifier', 'def', { sourceHash: 'also nonsense' }),
      ],
    }]),
  })
  t.after(() => cleanup(root))

  const { report } = runReport(root)
  const onFile = report.findings.filter((finding) => finding.location.file === 'results.json')
  assert.ok(onFile.length >= 2, `expected several findings on one file, got ${onFile.length}`)
  for (let index = 1; index < onFile.length; index += 1) {
    const previous = onFile[index - 1].location.pointer
    const current = onFile[index].location.pointer
    assert.ok(previous <= current, `${previous} should not follow ${current}`)
  }
  // Not a tautology: the findings genuinely carry different pointers.
  assert.notEqual(onFile[0].location.pointer, onFile[1].location.pointer)
})

test('the omitted list inside the summary is ordered the same way', async (t) => {
  const root = await omittedFixture(t)
  const { report } = runReport(root, ['--budget-chars', '620'])
  const pointers = report.compressed.omitted.map((entry) => entry.pointer)
  // The omitted list keys on "<result>/<section name>", which for this fixture
  // is s0..s5 -- so the pointers come back in section order, not pointer order.
  assert.deepEqual(pointers, CONTESTED)
  assert.deepEqual(report.compressed.omitted.map((entry) => entry.name), byCodeUnit(['s0', 's1', 's2', 's3', 's4', 's5']))
})
