/**
 * The saved-results document: what it may say, and what it may not.
 *
 * Validation is written out by hand. There is no schema library here because
 * there is no dependency here, and a hand-written validator has one property a
 * generated one usually loses: it can say *which* field is wrong and *where*,
 * as a JSON Pointer the caller can follow.
 *
 * Unknown keys are rejected rather than ignored. A one-character typo --
 * `sourceHashes` for `sourceHash`, `nextAction` for a `next-action` kind --
 * must not quietly turn a required section into an optional one, and silently
 * ignoring the key is exactly how it would.
 */

export const RESULTS_SCHEMA_VERSION = '1'

const DOCUMENT_KEYS = new Set(['schemaVersion', 'results'])
const RESULT_KEYS = new Set(['id', 'tool', 'status', 'sections'])
const SECTION_KEYS = new Set(['name', 'kind', 'priority', 'text', 'sourceHash', 'pointer'])

/**
 * The outcomes a saved result may record.
 *
 * `unknown` is a first-class value, not an omission: a harness that could not
 * determine what a call did must be able to say so, and the whole point of this
 * tool is that saying so survives compression. A result with no `status` at all
 * is treated as `unknown` too -- the absence of an outcome is not a success.
 */
export const RESULT_STATUSES = Object.freeze(['succeeded', 'failed', 'unknown'])

/**
 * Section kinds, split into the material that must survive and the material
 * that competes for what is left of the budget.
 *
 * The split is a property of the kind, not of a per-section flag, so a document
 * cannot mark its own failure reason droppable.
 */
export const REQUIRED_KINDS = Object.freeze(['failure', 'identifier', 'next-action'])
export const OPTIONAL_KINDS = Object.freeze(['context', 'evidence'])
export const SECTION_KINDS = Object.freeze([...REQUIRED_KINDS, ...OPTIONAL_KINDS].sort())

const REQUIRED = new Set(REQUIRED_KINDS)

export const isRequiredKind = (kind) => REQUIRED.has(kind)

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate a parsed results document.
 *
 * Returns `{ ok: true, document }` or `{ ok: false, problems }`. Every problem
 * carries a JSON Pointer, and the caller turns each one into its own
 * `results-schema-invalid` finding: reporting only the first would send a caller
 * round the loop once per mistake.
 */
export function validateResultsDocument(parsed) {
  const problems = []
  if (!isPlainObject(parsed)) {
    return { ok: false, problems: [{ pointer: '', detail: 'the document must be a JSON object' }] }
  }
  for (const key of Object.keys(parsed)) {
    if (!DOCUMENT_KEYS.has(key)) {
      problems.push({ pointer: `/${key}`, detail: `unknown top-level key; expected one of ${[...DOCUMENT_KEYS].sort().join(', ')}` })
    }
  }
  if (parsed.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    problems.push({ pointer: '/schemaVersion', detail: `schemaVersion must be the string "${RESULTS_SCHEMA_VERSION}"` })
  }
  if (parsed.results === undefined || !Array.isArray(parsed.results)) {
    problems.push({ pointer: '/results', detail: 'results must be an array' })
    return { ok: false, problems }
  }

  const results = []
  parsed.results.forEach((result, index) => {
    const pointer = `/results/${index}`
    if (!isPlainObject(result)) {
      problems.push({ pointer, detail: 'each result must be a JSON object' })
      return
    }
    for (const key of Object.keys(result)) {
      if (!RESULT_KEYS.has(key)) {
        problems.push({ pointer: `${pointer}/${key}`, detail: `unknown result key; expected one of ${[...RESULT_KEYS].sort().join(', ')}` })
      }
    }
    if (typeof result.id !== 'string' || result.id.length === 0) {
      problems.push({ pointer: `${pointer}/id`, detail: 'a result needs a non-empty string id' })
      return
    }
    if (typeof result.tool !== 'string' || result.tool.length === 0) {
      problems.push({ pointer: `${pointer}/tool`, detail: 'a result needs a non-empty string tool name' })
      return
    }
    if (result.status !== undefined && !RESULT_STATUSES.includes(result.status)) {
      problems.push({
        pointer: `${pointer}/status`,
        detail: `status must be one of ${RESULT_STATUSES.join(', ')}; omit it only when the outcome is genuinely unknown`,
      })
      return
    }

    const sections = []
    if (result.sections !== undefined && !Array.isArray(result.sections)) {
      problems.push({ pointer: `${pointer}/sections`, detail: 'sections must be an array' })
      return
    }
    for (const [sectionIndex, section] of (result.sections ?? []).entries()) {
      const sectionPointer = `${pointer}/sections/${sectionIndex}`
      if (!isPlainObject(section)) {
        problems.push({ pointer: sectionPointer, detail: 'each section must be a JSON object' })
        continue
      }
      for (const key of Object.keys(section)) {
        if (!SECTION_KEYS.has(key)) {
          problems.push({ pointer: `${sectionPointer}/${key}`, detail: `unknown section key; expected one of ${[...SECTION_KEYS].sort().join(', ')}` })
        }
      }
      if (typeof section.name !== 'string' || section.name.length === 0) {
        problems.push({ pointer: `${sectionPointer}/name`, detail: 'a section needs a non-empty string name' })
        continue
      }
      if (!SECTION_KINDS.includes(section.kind)) {
        problems.push({ pointer: `${sectionPointer}/kind`, detail: `kind must be one of ${SECTION_KINDS.join(', ')}` })
        continue
      }
      if (!Number.isInteger(section.priority) || section.priority < 0) {
        problems.push({ pointer: `${sectionPointer}/priority`, detail: 'priority must be an integer of 0 or more; lower is retained first' })
        continue
      }
      if (section.text !== undefined && typeof section.text !== 'string') {
        problems.push({ pointer: `${sectionPointer}/text`, detail: 'text must be a string when it is present' })
        continue
      }
      if (section.sourceHash !== undefined && typeof section.sourceHash !== 'string') {
        problems.push({ pointer: `${sectionPointer}/sourceHash`, detail: 'sourceHash must be a string when it is present' })
        continue
      }
      if (section.pointer !== undefined && typeof section.pointer !== 'string') {
        problems.push({ pointer: `${sectionPointer}/pointer`, detail: 'pointer must be a string when it is present' })
        continue
      }
      sections.push({
        name: section.name,
        kind: section.kind,
        priority: section.priority,
        text: section.text,
        sourceHash: section.sourceHash,
        retrieval: section.pointer,
        index: sectionIndex,
        pointer: sectionPointer,
      })
    }

    results.push({
      id: result.id,
      tool: result.tool,
      // An absent status is an unknown outcome, never a successful one.
      status: result.status ?? 'unknown',
      statusDeclared: result.status !== undefined,
      sections,
      index,
      pointer,
    })
  })

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, document: { results } }
}
