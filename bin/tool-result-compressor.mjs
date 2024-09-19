#!/usr/bin/env node

import { constants } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertWritableDestination } from '../src/destination.mjs'
import { compressToolResults, formatReport } from '../src/index.mjs'

/**
 * Create or truncate, and refuse to follow a link at the last component.
 *
 * `assertWritableDestination` refuses a symbolic link on sight, before anything
 * is opened. This flag closes the window between that check and the open: a link
 * planted in between is an ELOOP from the kernel rather than a write through it.
 * Two independent checks, because one of them can be raced.
 */
const WRITE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

const HELP = `tool-result-compressor

Compress saved tool results into a summary that fits a character budget --
keeping every outcome, failure reason, identifier and next action, listing
everything it leaves out, and preserving each omitted section's source hash and
retrieval pointer so the full text can be fetched back.

Nothing is executed, nothing is re-run, nothing is fetched and no retrieval
pointer is followed. One JSON document in, one JSON report out.

Usage:
  tool-result-compressor --results FILE --budget-chars N
                         [--json] [--out FILE] [limits]

Options:
  --results FILE          Saved results document to read (required)
  --budget-chars N        Size of the summary, in UTF-16 code units of the
                          rendered text (required)
  --json                  Emit the machine-readable report on stdout
  --out FILE              Also write the compressed summary document to this
                          file. Nothing is written when no summary was
                          produced. The path is NOT confined to any root --
                          this tool has no root to confine it to, so a
                          symbolically linked PARENT directory is followed,
                          exactly as it is for "cp" and for shell redirection.
                          The destination itself may not be a symbolic link,
                          may not be anything other than a regular file, and may
                          not be the same file as any input this run read,
                          including by hard link
  --max-document-bytes N  Maximum results document size (default 1048576)
  --max-results N         Maximum results in a document (default 500)
  --max-sections-per-result N   Maximum sections on one result (default 100)
  --max-section-chars N   Maximum characters in one section (default 20000)
  --timeout-ms N          Time budget for the whole run (default 10000; 0 leaves
                          no time at all and is only useful for proving the
                          budget is enforced)
  -h, --help              Show this help

The budget is characters, not tokens. This tool does not tokenize and does not
implement byte-pair encoding; for English prose a token is roughly four
characters, so divide accordingly and leave headroom. Counting what is actually
rendered is exact, which an estimate of a tokenizer would not be.

Section kinds. The kind decides whether a section can be dropped, so a document
cannot mark its own failure reason droppable:

  failure, identifier, next-action   required -- never dropped
  evidence, context                  optional -- dropped lowest priority first

What cannot happen:

  - A failure reason, an identifier or a next action is never dropped to make
    room. If the required material and the omitted list together do not fit,
    NO summary is produced, the report says how many characters it would need,
    and the run exits 1.
  - Nothing is omitted silently. Every omitted section is listed inside the
    summary with its kind, its size, its source hash and its retrieval pointer.
  - No summary turns unknown into success. A result recorded as "unknown", or
    carrying no status at all, is rendered as unknown, the rollup verdict can
    only be "succeeded" when every result succeeded, and the run reports
    "incomplete" and exits 2.
  - A section is never half-kept. Sections are retained whole or omitted whole.

Every option is accepted once; a repeated flag is a configuration error rather
than a silent last-wins. An unknown option is refused rather than ignored.

Exit codes:
  0  every saved result succeeded and the summary fits the budget
  1  the summary carries a failed result, or could not be produced within the
     budget
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out, including an outcome that was never
     determined (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-results', 'maxResults'],
  ['--max-section-chars', 'maxSectionChars'],
  ['--max-sections-per-result', 'maxSectionsPerResult'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { results: null, budgetChars: null, json: false, out: null, limits: {} }
  const given = new Set()

  /**
   * Every flag is accepted once.
   *
   * Letting one repeat discards the earlier value with no diagnostic, so
   * `--budget-chars 4000 --budget-chars 40` compresses against a budget nobody
   * asked for. That is the same defect as an ignored typo, which this tool
   * already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--results') {
      once('--results')
      options.results = takeValue('--results')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (argument === '--budget-chars') {
      once('--budget-chars')
      const raw = takeValue('--budget-chars')
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error('--budget-chars requires an integer of 1 or more')
      options.budgetChars = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const key = LIMIT_FLAGS.get(argument)
      const minimum = key === 'timeoutMs' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[key] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.results === null) throw new Error('--results is required')
  if (options.budgetChars === null) throw new Error('--budget-chars is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await compressToolResults({
      results: options.results,
      budgetChars: options.budgetChars,
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (options.out !== null) {
    if (report.compressed === null) {
      process.stderr.write('No summary was produced, so nothing was written to --out.\n')
    } else {
      /**
       * Checked here, with the run finished, because only now is the list of
       * files this run opened complete. A destination that turns out to be one
       * of them -- by name, through a symbolic link, or as a hard link sharing
       * no name with it at all -- is refused, and refusing means nothing is
       * written and nothing reaches stdout. A configuration that would destroy
       * an input is not a configuration to carry on with.
       *
       * `root` is null and that is a real answer, not a shortcut: the
       * destination is an arbitrary path the caller named and there is no tree
       * for it to escape from. The help text says so rather than claiming a
       * confinement the code does not perform.
       */
      let target
      try {
        target = await assertWritableDestination(resolve(options.out), {
          inputs: [resolve(options.results)],
          root: null,
          label: '--out',
        })
      } catch (error) {
        process.stderr.write(`${error.message}\n`)
        return 2
      }
      try {
        await writeFile(target, `${JSON.stringify(report.compressed, null, 2)}\n`, {
          encoding: 'utf8', flag: WRITE_NO_FOLLOW,
        })
      } catch (error) {
        process.stderr.write(`--out could not be written: ${error.code ?? error.message}\n`)
        return 2
      }
      process.stderr.write(
        `wrote a ${report.compressed.usedChars} character summary retaining `
        + `${report.summary.retained} section(s) and listing ${report.summary.omitted} omitted\n`,
      )
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      'incomplete: at least one outcome was never established, or evidence was missing, so this run is not a pass.\n',
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
