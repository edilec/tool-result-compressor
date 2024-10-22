# Tool Result Compressor

Compress saved tool results into a summary that fits a budget — keeping every
outcome, failure reason, identifier and next action, listing everything it
leaves out, and preserving each omitted section's source hash and retrieval
pointer so the full text can be fetched back.

- **Repository:** [edilec/tool-result-compressor](https://github.com/edilec/tool-result-compressor)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

An agent loop accumulates tool results faster than any context window can hold
them, so something has to be dropped. The usual approach — truncate the longest
thing, or paraphrase — drops exactly what the next step needs: the reason a call
failed, the order id it produced, and the fact that one call's outcome was never
established at all.

This tool reads one document of saved results and produces a summary in which:

- the **outcome of every call** is carried through verbatim, including
  `unknown`;
- **failure reasons, identifiers and next actions** are never dropped to make
  room, whatever their priority;
- everything that did not fit is **listed inside the summary** with its kind, its
  size, its source hash and its retrieval pointer;
- the rollup verdict can only be `succeeded` when every single result succeeded.

Nothing is executed, nothing is re-run, nothing is fetched and no retrieval
pointer is followed. One JSON document in, one JSON report out.

## Why it exists

A compressed summary is read by something that will act on it, and it has no way
to tell a summary that says "succeeded" because everything succeeded from one
that says "succeeded" because the unknown result was the boring-looking one that
got dropped. The two are indistinguishable at the point of use and their
consequences are not.

So the guarantees here are about what a summary is *not allowed* to say. If the
required material and the omitted list do not fit the budget, this tool produces
no summary at all rather than a smaller, wronger one.

## Quick start

```sh
cat > results.json <<'JSON'
{
  "schemaVersion": "1",
  "results": [
    {
      "id": "call-0007",
      "tool": "payments.refund",
      "status": "failed",
      "sections": [
        { "name": "error", "kind": "failure", "priority": 0,
          "text": "Refund declined: acquirer code 51.",
          "sourceHash": "sha256:9f2c1a4b7e0d3c5a", "pointer": "results/call-0007/error.txt" },
        { "name": "order", "kind": "identifier", "priority": 0, "text": "ord_9F2KQ4" },
        { "name": "retry", "kind": "next-action", "priority": 0,
          "text": "Fund the source account, then retry with the same key." },
        { "name": "transcript", "kind": "evidence", "priority": 5,
          "text": "REQUEST POST /v2/refunds ...",
          "sourceHash": "sha256:deadbeefdeadbeef", "pointer": "results/call-0007/transcript.log" }
      ]
    }
  ]
}
JSON

node bin/tool-result-compressor.mjs --results results.json --budget-chars 600
node bin/tool-result-compressor.mjs --results results.json --budget-chars 600 --json
```

Two runnable examples ship with the tool:

```sh
npm run example          # examples/clean-run.json     -> exit 0
npm run example:failing  # examples/failed-refund.json -> exit 1
```

## The results document

| Key | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | the string `"1"` |
| `results` | yes | array of saved results; an empty array is a failure, not a pass |
| `results[].id` | yes | the call id |
| `results[].tool` | yes | the tool that was called |
| `results[].status` | no | `succeeded`, `failed` or `unknown`; **absent means unknown** |
| `results[].sections` | no | the saved material, split by kind |
| `sections[].name` | yes | distinct within a result |
| `sections[].kind` | yes | see the table below |
| `sections[].priority` | yes | integer of 0 or more; lower is retained first |
| `sections[].text` | no | the saved text; a section without it is missing evidence |
| `sections[].sourceHash` | no | `algorithm:hex`, e.g. `sha256:9f2c1a4b…` |
| `sections[].pointer` | no | a **relative** path in your artifact store |

Unknown keys are **rejected**, at the document, result and section level. A
one-character typo must not quietly turn a required section into an optional one,
and ignoring the key is exactly how it would.

### Section kinds

The kind decides whether a section can be dropped, so a document cannot mark its
own failure reason droppable.

| Kind | Class | Meaning |
| --- | --- | --- |
| `failure` | required | why the call failed |
| `identifier` | required | an id the next step needs (order, transaction, run) |
| `next-action` | required | what to do about it |
| `evidence` | optional | transcripts, responses, logs |
| `context` | optional | the surrounding facts |

Required sections are never dropped. Optional sections compete for what is left
of the budget, offered in this order:

1. lower `priority` first;
2. then **unretrievable before retrievable** — a section carrying neither a
   source hash nor a retrieval pointer cannot be fetched back once it is
   omitted, so it is preferred for retention while something recoverable can
   take its place;
3. then result id, then section name, by UTF-16 code unit.

A section is **atomic**: retained whole or omitted whole. Half a failure reason
reads as a complete one, which is worse than a clean omission with a pointer.

## The budget

`--budget-chars N` is measured in UTF-16 code units of the **rendered summary** —
the text a model actually reads, including its omitted list. Selection renders
after every candidate and keeps the candidate only if the result still fits, and
the finished summary is re-checked before it is emitted, so the rendering can
never drift from the number the report claims.

This is characters, not tokens. **This tool does not tokenize and does not
implement byte-pair encoding.** For English prose a token is roughly four
characters; divide accordingly and leave headroom.

The omitted list is inside the budget, which has one consequence worth knowing:
retaining a short section can make the summary *shorter*, because its one-line
entry in the omitted list carries a kind, a size, a hash and a pointer. The
selector exploits that before it consults the budget at all, so the feasibility
question is asked against the cheapest arrangement rather than against the
required-only one.

## Rules

| Rule | Severity | Fires when |
| --- | --- | --- |
| `budget-too-small-for-required` | error | the required material and the omitted list do not fit; no summary is produced |
| `duplicate-result-id` | error | two results share an id, so a finding cannot be attributed |
| `duplicate-section-name` | warning | one result carries two sections of the same name |
| `failure-reason-missing` | error | a result records a failure but no `failure` section was saved |
| `limit-exceeded` | error | a documented limit was reached before the run finished |
| `next-action-missing` | warning | a failed result carries no `next-action` section |
| `no-results-declared` | error | the document declares no results, so a pass would be vacuous |
| `omitted-section-not-retrievable` | error | an omitted section carries neither a source hash nor a retrieval pointer |
| `result-failed` | error | a saved result records a failure; its reason and identifiers are in the summary |
| `result-status-unknown` | error | a result records an unknown outcome, or no status at all |
| `results-invalid-json` | error | the results document is not valid JSON |
| `results-not-utf8` | error | the results document is not valid UTF-8 |
| `results-schema-invalid` | error | the results document does not match the schema above |
| `results-unreadable` | error | the results document could not be opened or read |
| `retrieval-pointer-invalid` | error | a pointer is absolute, or climbs out of the artifact store; it is discarded rather than repeated |
| `section-omitted` | info | an optional section did not fit and is listed with its pointer |
| `section-text-missing` | error | a section carries no text, or none that survives rendering, so its content was never obtained |
| `source-hash-malformed` | warning | a source hash is not `algorithm:hex`; it is discarded rather than repeated |
| `time-budget-exceeded` | error | the time budget expired before selection finished |

Nine of these mean the run did not obtain the evidence it needed, and force
`status: "incomplete"` and exit 2 rather than exit 1: `failure-reason-missing`,
`limit-exceeded`, `result-status-unknown`, `results-invalid-json`,
`results-not-utf8`, `results-schema-invalid`, `results-unreadable`,
`section-text-missing`, `time-budget-exceeded`.

## Guarantees

Each of these is pinned by a test that fails when the guarantee is removed from
the source — not by a test that reads a declaration and agrees with it.

1. **No summary turns unknown into success.** A result recorded as `unknown`, or
   carrying no status at all, is rendered as `unknown`; the rollup can only be
   `succeeded` when every result succeeded; and the run reports `incomplete` and
   exits 2. The shipped code re-checks this on the finished summary and throws
   rather than emitting one that fails it.
2. **A failure reason, an identifier and a next action always survive.** They are
   never dropped to make room. If they and the omitted list do not fit, **no
   summary is produced**, the report names the smallest budget that arrangement
   actually fits in, and the run exits 1. Smallest, and sufficient: the budget is
   rendered into the summary, so the number depends on its own digit count, and a
   refusal measured against the budget it just refused names a budget that is
   refused again. A section whose text is present but renders to nothing —
   whitespace, control characters — is reported as missing rather than rendered
   as a section that says nothing.
3. **Nothing is omitted silently.** Every omitted section is listed inside the
   rendered summary with its kind, its size, its source hash and its retrieval
   pointer, and an omission that carries neither is an error.
4. **A section is never truncated.** Retained whole, or omitted whole.
5. **The rendered summary never exceeds its budget.** Measured on the rendering,
   not on an estimate of it, and re-checked before anything is emitted.
6. **Ordering is by UTF-16 code unit**, never by `localeCompare` or
   `Intl.Collator`, whose ICU data differs between Node builds. Findings sort by
   `(location.file, location.pointer, ruleId, message)`.
7. **The clock is injected.** `compressToolResults` takes `now` as a default
   parameter and nothing else in the tool reads a clock, so the same document
   produces byte-identical stdout whenever it is run.
8. **No untrusted string reaches output carrying a control character.** C0, DEL,
   C1 (including NEL and the 8-bit CSI), U+2028/U+2029 and the bidi controls are
   stripped from result ids, tool names, section names, section text, pointers
   and hashes alike. This matters twice over here: the summary has a line
   structure a reader is meant to parse, and a section text carrying a line feed
   would otherwise forge a result line for a call that never happened.
9. **A JSON parse failure never reproduces the document.** V8 embeds the
   offending input in its own error message; the helper that describes the
   failure keeps the position and discards the quoted span, with a closing
   backstop for wordings it has never seen.
10. **`--out` never destroys a file it was not asked to touch.** See below.

## Writing a file

`--out FILE` writes the compressed summary document. Nothing is written when no
summary was produced. The destination is checked before anything is opened:

| Refused | Why |
| --- | --- |
| a symbolic link at the destination | writing through it puts the output wherever the link points, which is not the path you named |
| anything that is not a regular file | a directory, a socket, a device |
| the same file as an input | including as a **hard link**, which shares no path with the input and resolves to nothing, so only device plus inode sees it |
| a parent directory that does not exist | nothing is created on the way |

**Not refused: a symbolically linked parent directory.** This tool has no
confinement root — `--out` is an arbitrary path you name — so there is nothing
for a symlinked ancestor to escape from, and following it is what naming a path
means, exactly as it does for `cp` and for shell redirection. Refusing every
symlinked ancestor would refuse every run under the macOS temp directory, since
`/var` is a link to `/private/var`. This is stated rather than papered over:
documenting a confinement the code does not perform reads as coverage and is
worse than silence.

A refused destination is a configuration error: exit 2 with **empty stdout**.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every saved result succeeded and the summary fits | the report |
| `1` | the summary carries a failed result, or could not be produced within the budget | the report |
| `2` | invalid usage, an unknown option, or a refused `--out` | **empty** |
| `2` | evidence missing, unreadable, bounded out, or an outcome never determined | an `incomplete` report |

A consumer that pipes stdout must handle an empty stdout on exit 2. That is
documented rather than papered over: emitting a fake report for a run that never
started would be worse.

## Limits

Every limit is enforced and every one has a CLI flag. Reaching one produces an
`incomplete` report naming the limit — never a silent truncation and never a
pass.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxDocumentBytes` | `--max-document-bytes` | 1048576 |
| `maxResults` | `--max-results` | 500 |
| `maxSectionsPerResult` | `--max-sections-per-result` | 100 |
| `maxSectionChars` | `--max-section-chars` | 20000 |
| `timeoutMs` | `--timeout-ms` | 10000 |

## Non-goals

- **It is not a tokenizer.** The budget is characters. No byte-pair encoding, no
  model-specific vocabulary, no estimate dressed up as a count.
- **It does not paraphrase, summarise or rewrite text.** Every character it
  emits from a section came from that section. Whitespace is collapsed and
  control characters are stripped; nothing else is changed. What a language
  model would add here is exactly what nobody could verify afterwards.
- **It does not fetch anything.** A retrieval pointer is recorded, never
  followed. Retrieving the full text is the caller's job and the caller's
  round trip.
- **It does not decide what failed.** It carries through what the saved result
  recorded. A result with no `failure` section and a `failed` status makes the
  run incomplete rather than inviting the tool to guess.
- **It does not verify a source hash.** The hash is preserved and its shape is
  checked; whether it matches the artifact is a question about a file this tool
  never opens.
- **It has no network access, no telemetry and no provider calls**, in the tool
  and in its tests.

## Repository layout

- `src/` — the library: the schema, the selector and renderer, the write guard
- `bin/` — the CLI
- `test/` — `node:test` suites
- `examples/` — runnable documents, one passing and one failing
- `docs/` — design notes

## Verification

```sh
npm run check   # lint + test + both examples + npm pack --dry-run
```

## License

MIT. See [LICENSE](./LICENSE).
