/**
 * Selection and rendering.
 *
 * The compressed summary is a *rendering*, and the budget is measured on that
 * rendering rather than on an estimate of it. Selection therefore renders after
 * every candidate and keeps the candidate only if the result still fits, so the
 * invariant `rendered.length <= budget` is established by construction and
 * re-checked before anything is emitted. An estimate that drifts from the thing
 * it estimates is how a "compressed" summary arrives over budget.
 *
 * Two properties are structural:
 *
 * 1. **Sections are atomic.** A section is retained whole or omitted whole.
 *    Half a failure reason and half an identifier are both worse than a clean
 *    omission with a pointer to the full text, because they read as complete.
 * 2. **Required material does not compete.** Failure reasons, identifiers and
 *    next actions are selected before anything else and are never dropped to
 *    make room. If they do not fit, no summary is produced at all.
 */

import { isRequiredKind } from './results.mjs'
import { byCodeUnit, sanitize } from './text.mjs'

export const SUMMARY_SCHEMA_VERSION = '1'

/** A stable key for one section within the whole document. Both parts are integers. */
export const sectionKey = (result, section) => `${result.index}:${section.index}`

/**
 * The order optional sections are offered the remaining budget in.
 *
 * Lower priority number first, as the schema promises. Then **unretrievable
 * before retrievable**: a section carrying neither a source hash nor a
 * retrieval pointer cannot be fetched back once it is omitted, so it is
 * preferred for retention while something recoverable can take its place. Then
 * result id and section name, by code unit, so the order is total.
 */
export function compareOptional(left, right) {
  if (left.section.priority !== right.section.priority) return left.section.priority - right.section.priority
  const retrievable = Number(left.retrievable) - Number(right.retrievable)
  if (retrievable !== 0) return retrievable
  const id = byCodeUnit(left.result.id, right.result.id)
  if (id !== 0) return id
  const name = byCodeUnit(left.section.name, right.section.name)
  if (name !== 0) return name
  return left.section.index - right.section.index
}

/**
 * The rollup verdict.
 *
 * A failure outranks an unknown and an unknown outranks a success, so the only
 * way to reach `succeeded` is for every single result to have recorded success.
 * This is the rule the acceptance criterion names: no summary turns unknown
 * into success.
 */
export function rollup(statuses) {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('unknown')) return 'unknown'
  return 'succeeded'
}

function omittedEntry(result, section, text) {
  return {
    result: sanitize(result.id, 120),
    name: sanitize(section.name, 120),
    kind: section.kind,
    priority: section.priority,
    chars: text.length,
    sourceHash: section.sourceHash === undefined ? null : sanitize(section.sourceHash, 160),
    pointer: section.retrieval === undefined ? null : sanitize(section.retrieval, 200),
  }
}

/**
 * Build the compressed document for one retention set.
 *
 * `usable` is the list of every section that carries text, already sanitised;
 * `retained` is the set of keys selected so far. Everything else is listed as
 * omitted, in an order that does not depend on the order it was considered in.
 */
export function assemble(results, usable, retained, budgetChars) {
  const byResult = new Map()
  const omitted = []
  for (const entry of usable) {
    if (retained.has(entry.key)) {
      const list = byResult.get(entry.result.index) ?? []
      list.push(entry)
      byResult.set(entry.result.index, list)
    } else omitted.push(omittedEntry(entry.result, entry.section, entry.text))
  }
  omitted.sort((left, right) => byCodeUnit(`${left.result}/${left.name}`, `${right.result}/${right.name}`))

  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    verdict: rollup(results.map((result) => result.status)),
    budgetChars,
    results: results.map((result) => ({
      id: sanitize(result.id, 120),
      tool: sanitize(result.tool, 120),
      status: result.status,
      sections: (byResult.get(result.index) ?? []).map((entry) => ({
        name: sanitize(entry.section.name, 120),
        kind: entry.section.kind,
        text: entry.text,
        sourceHash: entry.section.sourceHash === undefined ? null : sanitize(entry.section.sourceHash, 160),
        pointer: entry.section.retrieval === undefined ? null : sanitize(entry.section.retrieval, 200),
      })),
    })),
    omitted,
  }
}

const NO_HASH = 'no source hash'
const NO_POINTER = 'no retrieval pointer'

/**
 * Render the compressed document as the text a model actually reads.
 *
 * The omitted list is part of the rendering, not a side channel. A summary that
 * silently drops material teaches its reader that what it shows is everything
 * there was; a summary that ends with what it left out and where to fetch it
 * does not. That footer is required material and is inside the budget with
 * everything else.
 */
export function renderSummary(compressed) {
  const counts = { succeeded: 0, failed: 0, unknown: 0 }
  for (const result of compressed.results) counts[result.status] += 1

  const lines = [
    `VERDICT ${compressed.verdict} | results ${compressed.results.length} `
    + `(succeeded ${counts.succeeded}, failed ${counts.failed}, unknown ${counts.unknown}) `
    + `| budget ${compressed.budgetChars} chars`,
  ]
  for (const result of compressed.results) {
    lines.push(`[${result.id}] ${result.tool} STATUS ${result.status}`)
    for (const section of result.sections) {
      lines.push(`  ${section.kind} ${section.name}: ${section.text}`)
    }
  }
  if (compressed.omitted.length === 0) lines.push('OMITTED none')
  else {
    lines.push(`OMITTED ${compressed.omitted.length} section(s); retrieve them at these pointers:`)
    for (const entry of compressed.omitted) {
      lines.push(
        `  ${entry.result}/${entry.name} (${entry.kind}, ${entry.chars} chars) `
        + `${entry.sourceHash ?? NO_HASH} ${entry.pointer ?? NO_POINTER}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Re-check, on the finished summary, everything selection is supposed to have
 * guaranteed.
 *
 * These are not tests; they are the last line of defence in the shipped code.
 * A selection bug that drops a failure reason or renders an unknown outcome as
 * a success would otherwise reach a caller looking exactly like a summary that
 * worked, and a caller cannot tell the difference by looking.
 *
 * Results are matched by POSITION, never by id. Two saved results may carry the
 * same id -- the document is untrusted and that is a rule this tool reports
 * rather than a shape it can rule out -- and matching by id silently collapses
 * them, which is how this check first accused correct selection of losing a
 * section.
 */
export function assertSummaryInvariants(compressed, results, usable, retained, text) {
  if (text.length > compressed.budgetChars) {
    throw new Error(`the rendered summary is ${text.length} chars, over its own ${compressed.budgetChars} char budget`)
  }
  if (compressed.results.length !== results.length) {
    throw new Error(`the summary carries ${compressed.results.length} results and the document declared ${results.length}`)
  }
  results.forEach((result, position) => {
    if (compressed.results[position].status !== result.status) {
      throw new Error(`result "${sanitize(result.id, 60)}" changed status between the input and the summary`)
    }
  })
  if (compressed.verdict === 'succeeded' && results.some((result) => result.status !== 'succeeded')) {
    throw new Error('the summary reports success while a result did not succeed')
  }

  const listed = new Set(compressed.omitted.map((entry) => `${entry.result}/${entry.name}`))
  for (const entry of usable) {
    const key = `${sanitize(entry.result.id, 120)}/${sanitize(entry.section.name, 120)}`
    if (retained.has(entry.key)) continue
    if (isRequiredKind(entry.section.kind)) throw new Error(`required section "${key}" was dropped from the summary`)
    if (!listed.has(key)) throw new Error(`section "${key}" was neither retained nor listed as omitted`)
  }
  for (const entry of usable) {
    if (!retained.has(entry.key)) continue
    const inResult = compressed.results[entry.result.index]
    if (inResult === undefined
      || !inResult.sections.some((section) => section.name === sanitize(entry.section.name, 120) && section.text === entry.text)) {
      throw new Error(`section "${sanitize(entry.section.name, 60)}" was selected but is not in the summary`)
    }
  }
}

/**
 * Select what fits, render it, and check the result.
 *
 * Two passes, because the omitted list is inside the budget and therefore
 * retaining a section can make the rendering *shorter*: a one-line piece of
 * context costs less as a line of the summary than as an entry in the omitted
 * footer carrying its kind, its size, its hash and its pointer.
 *
 *   Pass 1 -- free retention. Any optional section whose summary line is no
 *   longer than its omitted-list entry is retained before the budget is
 *   consulted at all. This is what makes the feasibility question well posed:
 *   asking it against the required-only arrangement would refuse budgets that
 *   the cheapest arrangement fits comfortably.
 *
 *   Pass 2 -- paid retention, in the documented order, while the rendering
 *   still fits. One section that does not fit is omitted and the next is still
 *   tried, so a large piece of evidence does not shut out three small ones
 *   behind it.
 *
 * Between them sits the feasibility check, which has one last candidate:
 * retaining everything empties the omitted list and removes its header line
 * too, so an arrangement that is cheapest section by section is not always the
 * shortest overall.
 *
 * Every decision is made on a real rendering. An arithmetic model of the
 * rendering would be faster and would eventually disagree with it, and the
 * disagreement would arrive as a summary that is over the budget it claims.
 */
export function compress(results, usable, budgetChars, shouldStop = () => false) {
  const optional = usable.filter((entry) => !isRequiredKind(entry.section.kind)).sort(compareOptional)
  const retained = new Set(usable.filter((entry) => isRequiredKind(entry.section.kind)).map((entry) => entry.key))
  const lengthOf = (set) => renderSummary(assemble(results, usable, set, budgetChars)).length

  let current = lengthOf(retained)

  for (const entry of optional) {
    if (shouldStop()) return { ok: false, expired: true }
    const trial = new Set(retained)
    trial.add(entry.key)
    const trialLength = lengthOf(trial)
    if (trialLength > current) continue
    retained.add(entry.key)
    current = trialLength
  }

  if (current > budgetChars) {
    const everything = new Set(usable.map((entry) => entry.key))
    const everythingLength = lengthOf(everything)
    if (everythingLength > budgetChars) {
      return { ok: false, requiredChars: Math.min(current, everythingLength) }
    }
    retained.clear()
    for (const key of everything) retained.add(key)
    current = everythingLength
  }

  for (const entry of optional) {
    if (retained.has(entry.key)) continue
    if (shouldStop()) return { ok: false, expired: true }
    const trial = new Set(retained)
    trial.add(entry.key)
    const trialLength = lengthOf(trial)
    if (trialLength > budgetChars) continue
    retained.add(entry.key)
    current = trialLength
  }

  const compressed = assemble(results, usable, retained, budgetChars)
  const text = renderSummary(compressed)
  assertSummaryInvariants(compressed, results, usable, retained, text)
  return { ok: true, retained, compressed: { ...compressed, usedChars: text.length, text } }
}
