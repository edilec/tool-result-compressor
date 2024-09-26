# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public contract: renaming one is a breaking change and gets its own entry.

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
