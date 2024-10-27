# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public contract: renaming one is a breaking change and gets its own entry.

## Unreleased

Fixes from adversarial verification of 0.1.0. Every one of them is pinned by a
test that fails when the fix is removed.

- **A refusal names a budget that works.** The budget is rendered into the
  summary, so the length of the required arrangement depends on the digit count
  of the number being asked for, and `requiredChars` was measured against the
  budget that had just been refused: `--budget-chars 20` named 193, and a run at
  193 named 194. It is now the least budget the arrangement actually fits in.
- **A section that renders to nothing is a missing section.** The
  `section-text-missing` guard tested the text as it was saved; what reaches the
  summary is the sanitised text. A failure reason made only of whitespace or
  control characters was rendered as `failure why: ` with nothing after it, at
  exit 1, with nothing in the report saying the reason had never been obtained.
- **An expired time budget is never a pass.** `--timeout-ms` is documented as
  the budget for the whole run, but the clock was read only inside selection --
  and every reading there sits in a loop over the *optional* sections. A
  document whose sections are all of required kinds leaves that list empty, so
  neither loop runs, the callback is never called, and `--timeout-ms 0` reported
  `status: "pass"` with exit 0 and no findings at all. The clock is now read once
  per saved result while they are inspected and once more before selection
  begins, so the phase that ran out of time is the phase the finding names.
- **A value that cannot be stringified is described, not thrown on.**
  `String({toString: {}})` throws; `sanitize` now renders such a value as its
  shape (`[object]`, `[array]`) and never reproduces it.
- The `assertSummaryInvariants` branch that requires every non-retained optional
  section to appear in the omitted footer is now pinned; so is `O_NOFOLLOW`,
  which moved beside the destination guard it backs up.

## 0.1.0

First release.

- Budget-constrained selection measured on the real rendering, with a
  free-retention pass so the feasibility question is asked against the cheapest
  arrangement rather than the required-only one.
- Failure reasons, identifiers and next actions are never dropped; when they and
  the omitted list do not fit, no summary is produced and the report says how
  many characters it would need.
- Every omitted section is listed inside the summary with its kind, its size, its
  source hash and its retrieval pointer; an omission carrying neither hash nor
  pointer is an error.
- An unknown or absent outcome is carried through as `unknown`, can never roll up
  to `succeeded`, and makes the run incomplete.
- 19 rules, each with a frozen severity and a behavioural outcome test.
- `--out` guarded against a symlinked destination, a non-regular file and a hard
  link to an input. There is no confinement root and a symlinked parent directory
  is followed; the help text and README say so.
