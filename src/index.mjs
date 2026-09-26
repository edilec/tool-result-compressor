/**
 * tool-result-compressor
 *
 * Turns a set of saved tool results into a summary that fits a budget, keeping
 * the things a caller cannot act without -- the outcome, the reason a call
 * failed, the identifiers it produced, and what to do next -- and saying
 * exactly what it left out and where to fetch it.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Required material never competes for the budget.** Failure reasons,
 *    identifiers and next actions are selected before anything else and are
 *    never dropped to make room. If they alone do not fit, the run produces
 *    **no summary at all** and exits 1. A summary missing a failure reason is
 *    not a smaller answer, it is a wrong one.
 * 2. **Nothing is omitted silently.** Every section that did not fit is listed
 *    inside the rendered summary with its kind, its size, its source hash and
 *    its retrieval pointer. That footer is required material and is inside the
 *    budget with everything else.
 * 3. **No summary turns unknown into success.** A result whose outcome was not
 *    determined -- declared `unknown`, or carrying no status at all -- is
 *    rendered as `unknown`, the rollup verdict can only be `succeeded` when
 *    every result succeeded, and the run reports `incomplete` and exits 2.
 * 4. **Output is stable.** No clock reading, no locale, no absolute host path
 *    and no object key order reaches stdout, so the same document always
 *    produces byte-identical output.
 *
 * Nothing is executed, nothing is re-run, nothing is fetched and no retrieval
 * pointer is followed. The document is data; it never acquires authority over
 * what this tool does.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { compress, rollup, sectionKey } from './compress.mjs'
import { REQUIRED_KINDS, SECTION_KINDS, validateResultsDocument } from './results.mjs'
import { byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export const TOOL_ID = 'tool-result-compressor'
export const SCHEMA_VERSION = '1'

/**
 * The one place a severity is decided.
 *
 * Severity decides the exit code, so a severity written as a literal at each
 * construction site drifts silently: flipping one rule to `warning` turns a
 * refusal into a green build. Every finding takes its severity from here and an
 * unknown rule id throws. This table is a source of truth, not a test: the suite
 * pins severity by driving real inputs through the CLI and asserting the exit
 * code, which no coordinated edit of three declarations can satisfy.
 */
export const RULE_SEVERITY = Object.freeze({
  'budget-too-small-for-required': 'error',
  'duplicate-result-id': 'error',
  'duplicate-section-name': 'warning',
  'failure-reason-missing': 'error',
  'limit-exceeded': 'error',
  'next-action-missing': 'warning',
  'no-results-declared': 'error',
  'omitted-section-not-retrievable': 'error',
  'result-failed': 'error',
  'result-status-unknown': 'error',
  'results-invalid-json': 'error',
  'results-not-utf8': 'error',
  'results-schema-invalid': 'error',
  'results-unreadable': 'error',
  'retrieval-pointer-invalid': 'error',
  'section-omitted': 'info',
  'section-text-missing': 'error',
  'source-hash-malformed': 'warning',
  'time-budget-exceeded': 'error',
})

/**
 * Rules that mean the run did not obtain the evidence it needed.
 *
 * Any one of them forces `status: "incomplete"` and exit 2 even though it is
 * also an error, because the two say different things to a consumer: `fail`
 * means the results were read and something in them failed, `incomplete` means
 * the outcome of at least one call was never established. A compressor cannot
 * manufacture an outcome that was never recorded, and it must not let one be
 * mistaken for a success.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'failure-reason-missing',
  'limit-exceeded',
  'result-status-unknown',
  'results-invalid-json',
  'results-not-utf8',
  'results-schema-invalid',
  'results-unreadable',
  'section-text-missing',
  'time-budget-exceeded',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)

export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxResults: 500,
  maxSectionsPerResult: 100,
  maxSectionChars: 20000,
  timeoutMs: 10000,
})

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS))

/**
 * A source hash is `algorithm:hex`.
 *
 * A malformed one is not echoed. It arrived from the same untrusted document as
 * everything else, and a field that is supposed to be a digest but is not could
 * be anything at all -- including the credential somebody pasted into the wrong
 * key. The finding names the section instead, which is what a caller needs.
 */
const SOURCE_HASH = /^[a-z0-9]+:[0-9a-f]{8,128}$/

/**
 * A retrieval pointer is a relative path inside the caller's own artifact
 * store. Absolute paths and `..` segments are refused rather than echoed: the
 * report contract says a location is never an absolute host path, and a pointer
 * that climbs out of the store is not one this tool will repeat.
 */
export function validRetrievalPointer(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function makeFinding(ruleId, { file, pointer, message, evidence, suggestion }) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown rule id "${ruleId}"`)
  const location = { file: sanitize(file, 200) }
  if (pointer !== undefined) location.pointer = sanitize(pointer, 200)
  const finding = { ruleId, severity, message: sanitize(message, 400), location }
  if (evidence !== undefined) finding.evidence = sanitize(evidence)
  if (suggestion !== undefined) finding.suggestion = sanitize(suggestion, 300)
  return finding
}

/**
 * The documented sort key: `(location.file, location.pointer, ruleId, message)`.
 *
 * Code unit, never collation. `Intl` consults ICU data that differs between Node
 * builds, so a collated report is a report two correct machines disagree about.
 */
function compareFindings(left, right) {
  const file = byCodeUnit(left.location.file, right.location.file)
  if (file !== 0) return file
  const pointer = byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
  if (pointer !== 0) return pointer
  const rule = byCodeUnit(left.ruleId, right.ruleId)
  if (rule !== 0) return rule
  return byCodeUnit(left.message, right.message)
}

function resolveLimits(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!LIMIT_KEYS.includes(key)) throw new Error(`Unknown limit "${key}"; expected one of ${LIMIT_KEYS.join(', ')}`)
    const value = overrides[key]
    const minimum = key === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Limit "${key}" must be an integer of ${minimum} or more`)
    }
  }
  return { ...DEFAULT_LIMITS, ...overrides }
}

function report(status, findings, extra) {
  const ordered = [...findings].sort(compareFindings)
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: extra.checked,
      errors: ordered.filter((finding) => finding.severity === 'error').length,
      warnings: ordered.filter((finding) => finding.severity === 'warning').length,
      results: extra.results,
      sections: extra.sections,
      retained: extra.retained,
      omitted: extra.omitted,
      budgetChars: extra.budgetChars,
      usedChars: extra.usedChars,
    },
    compressed: extra.compressed,
    findings: ordered,
  }
}

const nothing = (budgetChars) => ({
  checked: 0, results: 0, sections: 0, retained: 0, omitted: 0, budgetChars, usedChars: null, compressed: null,
})

/**
 * Compress a saved result set into a budget.
 *
 * `now` is injected -- as a default parameter, never read unconditionally --
 * because the time budget is a documented limit, and a documented limit no test
 * can reach is a limit that is not enforced. A test steps a fake clock past the
 * deadline; nothing else in this module consults a clock at all.
 */
export async function compressToolResults(options = {}) {
  const { results: resultsPath, budgetChars, limits: limitOverrides = {}, now = Date.now } = options
  if (typeof resultsPath !== 'string' || resultsPath.length === 0) {
    throw new Error('A results document path is required')
  }
  if (!Number.isInteger(budgetChars) || budgetChars < 1) {
    throw new Error('A budget of 1 or more characters is required')
  }
  const limits = resolveLimits(limitOverrides)

  /**
   * Elapsed time, not a precomputed instant, so `--timeout-ms 0` genuinely
   * leaves no time at all. A budget no test can reach is not enforced.
   */
  const started = now()
  const expired = () => now() - started >= limits.timeoutMs

  const documentName = sanitize(basename(resultsPath), 200)
  const findings = []
  const add = (ruleId, detail) => findings.push(makeFinding(ruleId, detail))
  const blank = nothing(budgetChars)

  let size
  try {
    size = (await stat(resultsPath)).size
  } catch (error) {
    add('results-unreadable', {
      file: documentName,
      message: `the results document could not be inspected (${error.code ?? 'unknown error'})`,
      suggestion: 'Check the path passed to --results.',
    })
    return report('incomplete', findings, blank)
  }
  if (size > limits.maxDocumentBytes) {
    add('limit-exceeded', {
      file: documentName,
      message: `the results document is ${size} bytes, over the maxDocumentBytes limit of ${limits.maxDocumentBytes}`,
      suggestion: 'Split the document, or raise --max-document-bytes deliberately.',
    })
    return report('incomplete', findings, blank)
  }

  let bytes
  try {
    bytes = await readFile(resultsPath)
  } catch (error) {
    add('results-unreadable', {
      file: documentName,
      message: `the results document could not be read (${error.code ?? 'unknown error'})`,
    })
    return report('incomplete', findings, blank)
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    add('results-not-utf8', {
      file: documentName,
      message: 'the results document is not valid UTF-8, so it was not interpreted',
      suggestion: 'Re-save the document as UTF-8.',
    })
    return report('incomplete', findings, blank)
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    add('results-invalid-json', {
      file: documentName,
      message: `the results document is not valid JSON: ${parseFailureDetail(error)}`,
    })
    return report('incomplete', findings, blank)
  }

  const validated = validateResultsDocument(parsed)
  if (!validated.ok) {
    for (const problem of validated.problems) {
      add('results-schema-invalid', { file: documentName, pointer: problem.pointer, message: problem.detail })
    }
    return report('incomplete', findings, blank)
  }

  const { results } = validated.document

  if (results.length === 0) {
    add('no-results-declared', {
      file: documentName,
      pointer: '/results',
      message: 'the document declares no results, so there is nothing to compress and nothing can be said about any call',
      suggestion: 'Save at least one tool result before compressing.',
    })
    return report('fail', findings, blank)
  }
  if (results.length > limits.maxResults) {
    add('limit-exceeded', {
      file: documentName,
      pointer: '/results',
      message: `the document declares ${results.length} results, over the maxResults limit of ${limits.maxResults}`,
    })
    return report('incomplete', findings, blank)
  }

  // ---- inspect every result and section -------------------------------------
  const usable = []
  const seenIds = new Set()
  let sectionCount = 0

  /**
   * The budget bounds the whole run, not only selection.
   *
   * `compress` is handed the clock and stops mid-loop, which covers the phase
   * that costs the most -- but every reading of that clock happens inside a
   * loop over the OPTIONAL sections. A document whose sections are all of
   * required kinds leaves that list empty, so neither loop runs, the callback
   * is never called, and a run given no time at all reached the end reporting
   * `pass` with exit 0 and not one finding. An expired budget is not a verdict.
   *
   * Inspecting the saved results is work the budget is documented to bound as
   * well -- the help text says "the whole run" -- so the clock is read once per
   * result and once more before selection begins.
   */
  const outOfTime = (during) => {
    add('time-budget-exceeded', {
      file: documentName,
      message: `the ${limits.timeoutMs}ms time budget expired ${during}, so no arrangement was selected and nothing is offered as a summary`,
      suggestion: 'Raise --timeout-ms deliberately. A run that ran out of time has not established what fits.',
    })
    return report('incomplete', findings, {
      ...blank, checked: results.length, results: results.length, sections: sectionCount,
    })
  }

  for (const result of results) {
    if (expired()) return outOfTime('while the saved results were being inspected')
    const label = sanitize(result.id, 80)
    if (seenIds.has(result.id)) {
      add('duplicate-result-id', {
        file: documentName,
        pointer: `${result.pointer}/id`,
        message: `result id "${label}" is declared more than once, so a caller cannot tell which call a finding is about`,
        suggestion: 'Give every saved result a distinct id.',
      })
    } else seenIds.add(result.id)

    if (result.sections.length > limits.maxSectionsPerResult) {
      add('limit-exceeded', {
        file: documentName,
        pointer: `${result.pointer}/sections`,
        message: `result "${label}" carries ${result.sections.length} sections, over the maxSectionsPerResult limit of ${limits.maxSectionsPerResult}`,
      })
      return report('incomplete', findings, blank)
    }

    if (result.status === 'unknown') {
      add('result-status-unknown', {
        file: documentName,
        pointer: `${result.pointer}/status`,
        message: result.statusDeclared
          ? `result "${label}" records an unknown outcome, so this run cannot report success for it`
          : `result "${label}" records no status at all, which is an outcome that was never determined, not a success`,
        suggestion: 'Record the outcome of the call, or leave this run incomplete deliberately.',
      })
    }
    if (result.status === 'failed') {
      add('result-failed', {
        file: documentName,
        pointer: `${result.pointer}/status`,
        message: `result "${label}" records a failure; its reason and identifiers are preserved in the summary`,
      })
    }

    const seenNames = new Set()
    const kinds = new Set()
    for (const section of result.sections) {
      sectionCount += 1
      const sectionLabel = sanitize(section.name, 80)
      kinds.add(section.kind)
      if (seenNames.has(section.name)) {
        add('duplicate-section-name', {
          file: documentName,
          pointer: `${section.pointer}/name`,
          message: `result "${label}" carries two sections named "${sectionLabel}"`,
          suggestion: 'Name each section of a result distinctly so an omission can be identified.',
        })
      } else seenNames.add(section.name)

      let retrieval = section.retrieval
      if (retrieval !== undefined && !validRetrievalPointer(retrieval)) {
        add('retrieval-pointer-invalid', {
          file: documentName,
          pointer: `${section.pointer}/pointer`,
          message: `the retrieval pointer on section "${sectionLabel}" of result "${label}" is not a relative path inside an artifact store, so it was discarded rather than repeated`,
          suggestion: 'Write the pointer relative to the artifact store root, with no "..' + '" segment.',
        })
        retrieval = undefined
      }

      let sourceHash = section.sourceHash
      if (sourceHash !== undefined && !SOURCE_HASH.test(sourceHash)) {
        add('source-hash-malformed', {
          file: documentName,
          pointer: `${section.pointer}/sourceHash`,
          message: `the source hash on section "${sectionLabel}" of result "${label}" is not "algorithm:hex", so it was discarded rather than repeated`,
          suggestion: 'Write the digest as, for example, sha256:<hex>.',
        })
        sourceHash = undefined
      }

      const where = validRetrievalPointer(retrieval) ? retrieval : documentName

      if (section.text === undefined || section.text.length === 0) {
        add('section-text-missing', {
          file: where,
          pointer: section.pointer,
          message: `section "${sectionLabel}" of result "${label}" carries no text, so its content was never obtained and cannot be compressed`,
          suggestion: 'Save the section text, or remove the section from the document.',
        })
        continue
      }
      if (section.text.length > limits.maxSectionChars) {
        add('limit-exceeded', {
          file: where,
          pointer: section.pointer,
          message: `section "${sectionLabel}" of result "${label}" is ${section.text.length} characters, over the maxSectionChars limit of ${limits.maxSectionChars}`,
          suggestion: 'Store the full text behind its retrieval pointer and save a bounded section here.',
        })
        return report('incomplete', findings, blank)
      }

      /**
       * The guard above tests the text as it was saved; this one tests the text
       * as it will be READ. Whitespace collapses and control characters are
       * stripped on the way to the summary, so a section whose text is a
       * non-breaking run of them is not a short section -- it is an empty one,
       * and it used to be rendered as "failure why: " with nothing after it
       * while the report said nothing at all about the reason being absent.
       */
      const rendered = sanitize(section.text, limits.maxSectionChars)
      if (rendered.length === 0) {
        add('section-text-missing', {
          file: where,
          pointer: section.pointer,
          message: `section "${sectionLabel}" of result "${label}" carries nothing but whitespace or control characters, so none of its content survives into a summary`,
          suggestion: 'Save the section text, or remove the section from the document.',
        })
        continue
      }

      usable.push({
        key: sectionKey(result, section),
        result,
        section: { ...section, retrieval, sourceHash },
        text: rendered,
        retrievable: retrieval !== undefined || sourceHash !== undefined,
      })
    }

    if (result.status === 'failed' && !kinds.has('failure')) {
      add('failure-reason-missing', {
        file: documentName,
        pointer: `${result.pointer}/sections`,
        message: `result "${label}" records a failure but carries no "failure" section, so the reason it failed was never saved and cannot survive compression`,
        suggestion: 'Save the failure reason as a section of kind "failure".',
      })
    }
    if (result.status === 'failed' && !kinds.has('next-action')) {
      add('next-action-missing', {
        file: documentName,
        pointer: `${result.pointer}/sections`,
        message: `result "${label}" records a failure but carries no "next-action" section, so the summary says what went wrong and not what to do`,
        suggestion: 'Save the recovery step as a section of kind "next-action".',
      })
    }
  }

  // ---- select what fits ------------------------------------------------------
  /**
   * The time budget is handed to selection as a callback, so an expiry stops it
   * mid-loop rather than being noticed afterwards. A selection that stopped
   * partway has a perfectly valid summary in hand -- required material kept,
   * everything else listed -- and offering it would be the defect: it is not the
   * arrangement that fits, it is the arrangement selection had reached, and
   * nothing in the output would say so.
   */
  if (expired()) return outOfTime('before selection began')

  const selected = compress(results, usable, budgetChars, expired)

  if (selected.expired === true) {
    add('time-budget-exceeded', {
      file: documentName,
      message: `the ${limits.timeoutMs}ms time budget expired during selection, so the arrangement it had reached is not offered as the one that fits`,
      suggestion: 'Raise --timeout-ms deliberately. A partly selected summary is a different answer, not a smaller one.',
    })
    return report('incomplete', findings, { ...blank, checked: results.length, results: results.length, sections: sectionCount })
  }

  if (!selected.ok) {
    add('budget-too-small-for-required', {
      file: documentName,
      message: `the shortest arrangement that keeps every failure reason, identifier and next action, and lists everything it omits, needs ${selected.requiredChars} characters; the budget is ${budgetChars}, so no summary was produced`,
      suggestion: `Raise --budget-chars to at least ${selected.requiredChars}. Dropping required material to fit is not an option this tool offers.`,
    })
    return report('fail', findings, {
      ...blank, checked: results.length, results: results.length, sections: sectionCount,
    })
  }

  const { compressed, retained: retainedKeys } = selected

  for (const entry of usable) {
    if (retainedKeys.has(entry.key)) continue
    const label = sanitize(entry.section.name, 80)
    const resultLabel = sanitize(entry.result.id, 80)
    const where = validRetrievalPointer(entry.section.retrieval) ? entry.section.retrieval : documentName
    if (!entry.retrievable) {
      add('omitted-section-not-retrievable', {
        file: where,
        pointer: entry.section.pointer,
        message: `section "${label}" of result "${resultLabel}" did not fit the budget and carries neither a source hash nor a retrieval pointer, so its content cannot be fetched back`,
        suggestion: 'Give every optional section a retrieval pointer, so omitting it costs nothing but a round trip.',
      })
      continue
    }
    add('section-omitted', {
      file: where,
      pointer: entry.section.pointer,
      message: `section "${label}" of result "${resultLabel}" did not fit the budget and is listed in the summary with its retrieval pointer`,
    })
  }

  const hasIncomplete = findings.some((finding) => INCOMPLETE.has(finding.ruleId))
  const hasError = findings.some((finding) => finding.severity === 'error')
  const status = hasIncomplete ? 'incomplete' : hasError ? 'fail' : 'pass'

  return report(status, findings, {
    checked: results.length,
    results: results.length,
    sections: sectionCount,
    retained: retainedKeys.size,
    omitted: compressed.omitted.length,
    budgetChars,
    usedChars: compressed.usedChars,
    compressed,
  })
}

const VERDICT = Object.freeze({
  pass: 'PASS  every saved result succeeded and the summary fits',
  fail: 'FAIL  the summary carries a failure, or could not be produced',
  incomplete: 'INCOMPLETE  at least one outcome was never established',
})

/** A short human rendering. The JSON report on stdout is the machine contract. */
export function formatReport(reportDocument) {
  const lines = [`${VERDICT[reportDocument.status]} (${TOOL_ID})`]
  const s = reportDocument.summary
  lines.push(
    `results ${s.results}, sections ${s.sections}, retained ${s.retained}, omitted ${s.omitted}, `
    + `budget ${s.budgetChars} chars, used ${s.usedChars ?? 'none'}, errors ${s.errors}, warnings ${s.warnings}`,
  )
  if (reportDocument.compressed === null) lines.push('no summary was produced')
  else {
    lines.push('--- summary ---')
    lines.push(reportDocument.compressed.text)
    lines.push('--- end ---')
  }
  for (const finding of reportDocument.findings) {
    lines.push(`  ${finding.severity.padEnd(7)} ${finding.ruleId}  ${finding.location.file}`)
    lines.push(`          ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export { REQUIRED_KINDS, SECTION_KINDS, escapePointerSegment, parseFailureDetail, rollup }
