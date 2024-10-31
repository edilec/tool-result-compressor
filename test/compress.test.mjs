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
  /**
   * One pair per documented tie-breaker, each built so that every LATER key
   * would order the pair the other way round.
   *
   * A fixture whose keys all agree cannot fail when one of them is deleted.
   * This test used to be three entries whose names happened to sort into the
   * same order as their priorities, so deleting the priority comparison, the
   * retrievable comparison, the result id or the section name each left it
   * green -- while the order decides which optional sections survive a tight
   * budget, and the README documents it as a guarantee.
   */
  const entry = ({ priority = 1, retrievable = false, id = 'r', name = 'n', index = 0 }) => (
    { result: { id }, section: { priority, name, index }, retrievable }
  )
  const decides = (key, first, second) => {
    assert.ok(compareOptional(first, second) < 0, `${key} must decide this pair`)
    assert.ok(compareOptional(second, first) > 0, `${key} must decide it in both directions`)
  }

  // Lower priority number first, against a retrievable flag, a result id and a
  // section name that each say the opposite.
  decides('priority',
    entry({ priority: 1, retrievable: true, id: 'z', name: 'z' }),
    entry({ priority: 9, retrievable: false, id: 'a', name: 'a' }))

  // Unretrievable before retrievable, against an id and a name that disagree.
  decides('retrievable',
    entry({ priority: 1, retrievable: false, id: 'z', name: 'z' }),
    entry({ priority: 1, retrievable: true, id: 'a', name: 'a' }))

  // Result id by code unit -- "Z" before "a", which collation reverses --
  // against a section name that disagrees.
  decides('result id',
    entry({ priority: 1, retrievable: true, id: 'Z', name: 'z' }),
    entry({ priority: 1, retrievable: true, id: 'a', name: 'a' }))

  // Section name by code unit, against the order the sections were declared in.
  decides('section name',
    entry({ priority: 1, retrievable: true, id: 'r', name: 'Z', index: 9 }),
    entry({ priority: 1, retrievable: true, id: 'r', name: 'a', index: 0 }))

  // Total, not merely documented: two sections alike in every key above fall
  // back to the order they were declared in rather than comparing equal.
  assert.ok(compareOptional(entry({ name: 'same', index: 0 }), entry({ name: 'same', index: 1 })) < 0)
  assert.equal(compareOptional(entry({ name: 'same' }), entry({ name: 'same' })), 0)

  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [
    { name: 'late', kind: 'evidence', text: 'x', priority: 9, retrieval: 'runs/late' },
    { name: 'early-retrievable', kind: 'evidence', text: 'x', priority: 1, retrieval: 'runs/early' },
    { name: 'early-lost', kind: 'evidence', text: 'x', priority: 1 },
  ])
  const order = [...usable].sort(compareOptional).map((entry_) => entry_.section.name)
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

test('the invariant check refuses a summary that omitted a section without listing it', () => {
  // The footer is what makes an omission honest: a summary that silently drops
  // material teaches its reader that what it shows is everything there was.
  // This is the branch that says so, and it was the one branch of the three
  // that nothing failed on when it was disabled.
  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [
    { name: 'id', kind: 'identifier', text: 'abc' },
    { name: 'log', kind: 'evidence', text: filler(50), priority: 1, retrieval: 'runs/1/log.txt' },
  ])
  const retained = new Set([usable[0].key])
  const compressed = assemble([one], usable, retained, 10000)
  assert.equal(compressed.omitted.length, 1, 'the honest summary lists it')

  const silent = { ...compressed, omitted: [] }
  assert.throws(
    () => assertSummaryInvariants(silent, [one], usable, retained, renderSummary(silent)),
    /section "r\/log" was neither retained nor listed as omitted/,
  )
  // The honest one passes, so the check is not simply refusing everything.
  assertSummaryInvariants(compressed, [one], usable, retained, renderSummary(compressed))
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

test('the invariant check refuses a summary that lost a whole result', () => {
  // A result that never reaches the summary is worse than a dropped section:
  // the caller sees a verdict over calls it does not know were made. The two
  // branches around this one are pinned; this one was not.
  const first = { ...result('a', 'succeeded', []), index: 0 }
  const second = { ...result('b', 'failed', []), index: 1 }
  const usable = [
    ...usableFrom(first, [{ name: 'id', kind: 'identifier', text: 'one' }]),
    ...usableFrom(second, [{ name: 'why', kind: 'failure', text: 'two' }]),
  ]
  const retained = new Set(usable.map((entry) => entry.key))
  const compressed = assemble([first, second], usable, retained, 10000)
  const truncated = { ...compressed, results: compressed.results.slice(0, 1) }
  assert.throws(
    () => assertSummaryInvariants(truncated, [first, second], usable, retained, renderSummary(truncated)),
    /carries 1 results and the document declared 2/,
  )
  // The complete one passes, so the check is not refusing every summary.
  assertSummaryInvariants(compressed, [first, second], usable, retained, renderSummary(compressed))
})

test('the invariant check refuses a summary missing a section it says it retained', () => {
  // The mirror of the omission branch: selection said it kept this section, and
  // the rendered summary does not carry it. Nothing failed when this branch was
  // disabled either.
  const one = result('r', 'succeeded', [])
  const usable = usableFrom(one, [
    { name: 'id', kind: 'identifier', text: 'abc' },
    { name: 'log', kind: 'evidence', text: filler(50), priority: 1, retrieval: 'runs/1/log.txt' },
  ])
  const retained = new Set(usable.map((entry) => entry.key))
  const compressed = assemble([one], usable, retained, 10000)

  const stripped = {
    ...compressed,
    results: [{
      ...compressed.results[0],
      sections: compressed.results[0].sections.filter((section) => section.name !== 'log'),
    }],
  }
  assert.throws(
    () => assertSummaryInvariants(stripped, [one], usable, retained, renderSummary(stripped)),
    /section "log" was selected but is not in the summary/,
  )
  assertSummaryInvariants(compressed, [one], usable, retained, renderSummary(compressed))
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

test('the budget a refusal names is one the arrangement actually fits in', () => {
  // The budget is rendered into the summary, so the length of the required
  // arrangement depends on the digit count of the number being asked for.
  // Measuring it against the budget that was just refused names a number that
  // is refused too -- advice that fails when it is followed.
  const one = result('r0', 'failed', [])
  const usable = usableFrom(one, [
    { name: 'why', kind: 'failure', text: 'declined' },
    { name: 'oid', kind: 'identifier', text: 'ord_1' },
    { name: 'do', kind: 'next-action', text: 'retry once' },
    { name: 'log', kind: 'evidence', text: filler(300), priority: 1, retrieval: 'runs/1/log.txt' },
  ])

  for (const budget of [1, 8, 20, 99, 150, 193]) {
    const refused = compress([one], usable, budget)
    if (refused.ok) continue
    const needed = refused.requiredChars

    // Sufficient: the number it names produces a summary.
    const atNeeded = compress([one], usable, needed)
    assert.equal(atNeeded.ok, true, `budget ${budget} named ${needed}, which is still refused`)
    assert.ok(atNeeded.compressed.text.length <= needed)

    // Minimal: one character less is still refused, so the advice is not merely
    // safe -- a guard that named a huge number would pass the check above.
    assert.equal(compress([one], usable, needed - 1).ok, false, `${needed - 1} should not be enough`)
  }
})
