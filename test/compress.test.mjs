/**
 * Selection and rendering, exercised directly.
 *
 * The end-to-end tests prove the guarantees a caller sees. These prove the
 * mechanics underneath: that the budget is measured on the real rendering, that
 * the free-retention pass exists and matters, that the offer order is the one
 * the README documents, and that the in-code invariants actually fire when they
 * are given something wrong.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assemble, assertSummaryInvariants, compareOptional, compress, renderSummary, rollup, sectionKey,
} from '../src/compress.mjs'
import { filler } from './helpers.mjs'

const result = (id, status, sections) => ({
  id, tool: 'some.tool', status, statusDeclared: true, sections, index: 0, pointer: '/results/0',
})

function usableFrom(one, sections) {
  return sections.map((section, index) => {
    const full = { priority: 0, retrieval: undefined, sourceHash: undefined, index, pointer: `/results/0/sections/${index}`, ...section }
    return {
      key: sectionKey(one, full),
      result: one,
      section: full,
      text: full.text,
      retrievable: full.retrieval !== undefined || full.sourceHash !== undefined,
    }
  })
}

test('the rollup never reaches success unless everything succeeded', () => {
  assert.equal(rollup(['succeeded', 'succeeded']), 'succeeded')
  assert.equal(rollup(['succeeded', 'unknown']), 'unknown')
  assert.equal(rollup(['succeeded', 'failed']), 'failed')
  assert.equal(rollup(['unknown', 'failed']), 'failed')
  assert.equal(rollup([]), 'succeeded')
})

test('a rendered summary never exceeds the budget it names', () => {
  const one = result('r', 'succeeded', [])
  const sections = [
    { name: 'id', kind: 'identifier', text: 'abc' },
    { name: 'big', kind: 'evidence', text: filler(4000), priority: 1, retrieval: 'runs/big.log' },
    { name: 'small', kind: 'context', text: 'eu-west-1', priority: 2, retrieval: 'runs/ctx.json' },
  ]
  const usable = usableFrom(one, sections)
  for (const budget of [200, 250, 300, 500, 1000, 4200, 9000]) {
    const selected = compress([one], usable, budget)
    if (!selected.ok) continue
    assert.ok(selected.compressed.text.length <= budget, `${selected.compressed.text.length} > ${budget}`)
    assert.equal(selected.compressed.usedChars, selected.compressed.text.length)
  }
})

test('the free-retention pass keeps a section that is cheaper to show than to list', () => {
  const one = result('r', 'succeeded', [])
  // The omitted-list entry for this section is far longer than the section line,
  // so retaining it makes the whole rendering shorter.
  const usable = usableFrom(one, [
    { name: 'id', kind: 'identifier', text: 'abc' },
    {
      name: 'a-very-long-section-name-indeed',
      kind: 'context',
      text: 'eu',
      priority: 7,
      retrieval: 'runs/a/very/long/retrieval/pointer/for/this/section.json',
      sourceHash: 'sha256:0011223344556677',
    },
  ])

  const withNothingOptional = renderSummary(assemble([one], usable, new Set([usable[0].key]), 10000))
  const withEverything = renderSummary(assemble([one], usable, new Set(usable.map((entry) => entry.key)), 10000))
  assert.ok(withEverything.length < withNothingOptional.length, 'the fixture must actually be cheaper when retained')

  // A budget that only the cheaper arrangement fits: without the free pass the
  // run would report the budget as too small for the required material.
  const selected = compress([one], usable, withEverything.length)
  assert.equal(selected.ok, true)
  assert.match(selected.compressed.text, /OMITTED none/)
})

test('optional sections are offered in priority order, unretrievable first', () => {
  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [
    { name: 'late', kind: 'evidence', text: 'x', priority: 9, retrieval: 'runs/late' },
    { name: 'early-retrievable', kind: 'evidence', text: 'x', priority: 1, retrieval: 'runs/early' },
    { name: 'early-lost', kind: 'evidence', text: 'x', priority: 1 },
  ])
  const order = [...usable].sort(compareOptional).map((entry) => entry.section.name)
  assert.deepEqual(order, ['early-lost', 'early-retrievable', 'late'])
})

test('the omitted list is ordered by result and section name, by code unit', () => {
  const one = result('r', 'succeeded', [])
  const names = ['Z', 'a', 'a-b', 'a_b', 'README', 'assets']
  const usable = usableFrom(one, names.map((name) => (
    { name, kind: 'evidence', text: filler(300), priority: 1, retrieval: `runs/${name}` }
  )))
  const compressed = assemble([one], usable, new Set(), 10000)
  const emitted = compressed.omitted.map((entry) => entry.name)

  // The key sorted is "<result>/<name>", so "r/a" precedes "r/a-b" as a prefix.
  const byCodeUnit = [...names]
    .sort((left, right) => {
      const a = `r/${left}`
      const b = `r/${right}`
      return a === b ? 0 : a < b ? -1 : 1
    })
  assert.deepEqual(emitted, byCodeUnit)
  assert.deepEqual(emitted, ['README', 'Z', 'a', 'a-b', 'a_b', 'assets'])

  // The fixture must actually discriminate, or the assertion above proves nothing.
  const byCollation = [...names].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(byCodeUnit, byCollation)
})

test('a section is retained whole or omitted whole, never truncated', () => {
  const one = result('r', 'succeeded', [])
  const body = filler(500)
  const usable = usableFrom(one, [
    { name: 'id', kind: 'identifier', text: 'abc' },
    { name: 'body', kind: 'evidence', text: body, priority: 1, retrieval: 'runs/body' },
  ])
  for (let budget = 200; budget < 800; budget += 7) {
    const selected = compress([one], usable, budget)
    if (!selected.ok) continue
    const sections = selected.compressed.results[0].sections
    const kept = sections.find((section) => section.name === 'body')
    if (kept !== undefined) assert.equal(kept.text, body, 'a retained section was truncated')
  }
})

test('the invariant check refuses a summary that lost a required section', () => {
  const one = result('r', 'failed', [])
  const usable = usableFrom(one, [{ name: 'why', kind: 'failure', text: 'nope' }])
  const compressed = assemble([one], usable, new Set(), 10000)
  const text = renderSummary(compressed)
  assert.throws(
    () => assertSummaryInvariants(compressed, [one], usable, new Set(), text),
    /required section "r\/why" was dropped/,
  )
})

test('the invariant check refuses a summary that is over its own budget', () => {
  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [{ name: 'id', kind: 'identifier', text: filler(400) }])
  const retained = new Set(usable.map((entry) => entry.key))
  const compressed = assemble([one], usable, retained, 10)
  const text = renderSummary(compressed)
  assert.throws(
    () => assertSummaryInvariants(compressed, [one], usable, retained, text),
    /over its own 10 char budget/,
  )
})

test('the invariant check refuses a summary that reports success for a result that did not succeed', () => {
  const one = result('r', 'unknown', [])
  const usable = usableFrom(one, [{ name: 'id', kind: 'identifier', text: 'abc' }])
  const retained = new Set(usable.map((entry) => entry.key))
  const compressed = assemble([one], usable, retained, 10000)
  const forged = { ...compressed, verdict: 'succeeded' }
  assert.throws(
    () => assertSummaryInvariants(forged, [one], usable, retained, renderSummary(forged)),
    /reports success while a result did not succeed/,
  )
})

test('the invariant check refuses a summary that changed a result status', () => {
  const one = result('r', 'failed', [])
  const usable = usableFrom(one, [{ name: 'why', kind: 'failure', text: 'nope' }])
  const retained = new Set(usable.map((entry) => entry.key))
  const compressed = assemble([one], usable, retained, 10000)
  const forged = { ...compressed, results: [{ ...compressed.results[0], status: 'succeeded' }] }
  assert.throws(
    () => assertSummaryInvariants(forged, [one], usable, retained, renderSummary(forged)),
    /changed status between the input and the summary/,
  )
})

test('two results sharing an id are matched by position, not collapsed', () => {
  const first = { ...result('same', 'succeeded', []), index: 0 }
  const second = { ...result('same', 'failed', []), index: 1 }
  const usable = [
    ...usableFrom(first, [{ name: 'id', kind: 'identifier', text: 'one' }]),
    ...usableFrom(second, [{ name: 'why', kind: 'failure', text: 'two' }]),
  ]
  const selected = compress([first, second], usable, 10000)
  assert.equal(selected.ok, true)
  assert.equal(selected.compressed.results[0].status, 'succeeded')
  assert.equal(selected.compressed.results[1].status, 'failed')
  assert.equal(selected.compressed.verdict, 'failed')
})

test('selection stops when the injected clock says to, and offers nothing', () => {
  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [
    { name: 'id', kind: 'identifier', text: 'abc' },
    { name: 'body', kind: 'evidence', text: filler(50), priority: 1, retrieval: 'runs/body' },
  ])
  const selected = compress([one], usable, 10000, () => true)
  assert.deepEqual(selected, { ok: false, expired: true })
  assert.equal(selected.compressed, undefined, 'a partly selected summary must not be offered')
})
