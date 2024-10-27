# Design notes

## The summary is a rendering, and the budget is measured on it

Most budget-constrained selectors estimate a cost per item, select against the
estimate, then render. The estimate and the rendering drift, and the drift
arrives as a summary that is over the budget it claims to respect.

Here the cost of an arrangement is the length of its rendering, obtained by
rendering it. Selection renders after every candidate; the finished summary is
rendered once more and checked against the budget before anything is emitted.
There is no model of the rendering to disagree with the rendering.

## The omitted list is inside the budget

A summary that silently drops material teaches its reader that what it shows is
everything there was. So the omitted list is part of the rendered text, not a
side channel: kind, size, source hash and retrieval pointer for every section
that did not fit.

That has a consequence worth stating because it shapes the selector. An omitted
section costs about ninety characters to list. A one-line piece of context costs
less than that to *show*. So retaining a short section can make the summary
shorter.

Selection therefore runs in two passes:

1. **Free retention.** Every optional section whose summary line is no longer
   than its omitted-list entry is retained before the budget is consulted at
   all. Without this pass the feasibility question is asked against the
   required-only arrangement, which is not the cheapest one, and budgets that
   the cheapest arrangement fits comfortably get refused.
2. **Paid retention.** The rest are offered the remaining budget in the
   documented order, and one that does not fit is skipped rather than ending the
   loop, so a large transcript does not shut out three small ones behind it.

Between the passes sits the feasibility check, which has one last candidate:
retaining everything empties the omitted list and removes its header line too,
so the arrangement that is cheapest section by section is not always the
shortest overall.

## Required material does not compete

`failure`, `identifier` and `next-action` sections are selected first and never
dropped. The class is a property of the **kind**, not a per-section flag, so a
document cannot mark its own failure reason droppable.

If the required material and the omitted list together exceed the budget, the
run produces **no summary at all**, reports the number of characters it would
need, and exits 1. A summary missing the reason a call failed is not a smaller
answer; it is a different one, and it looks exactly like a summary that worked.

## Unknown is carried, never converted

A result's status is copied through verbatim, and a result with no status at all
is `unknown` — the absence of a recorded outcome is not a success. The rollup
verdict is `failed` if anything failed, else `unknown` if anything is unknown,
else `succeeded`, so `succeeded` is reachable only when every single result
succeeded.

The run is then `incomplete` and exits 2, while still producing the summary. The
summary is what tells the caller *which* call is unknown, so withholding it
would be unhelpful; the exit code is what stops the loop treating the run as a
pass.

## The time budget bounds the whole run

`--timeout-ms` is documented as the budget for the whole run, so the clock is
read in every phase that can spend it: once per saved result while they are
inspected, once immediately before selection begins, and inside selection for
each optional section it weighs.

The middle one is not redundant. Every reading inside selection sits in a loop
over the *optional* sections, so a document whose sections are all of required
kinds — a failure reason, an identifier, a next action — leaves that list empty,
neither loop runs and the callback is never called. Such a document reported
`pass` and exit 0 on a budget of zero milliseconds: the budget had expired and
the verdict was green. An expired budget is not a verdict, and a phase that
reads no clock is a phase the budget does not bound.

## The invariants are in the shipped code, not only in the tests

`assertSummaryInvariants` runs on every summary before it is emitted and throws
rather than returning one that:

- exceeds its own stated budget,
- carries a different number of results than the document declared,
- changed any result's status,
- reports `succeeded` while a result did not succeed,
- dropped a required section,
- omitted a section without listing it.

These are the last line of defence. A selection bug that drops a failure reason
would otherwise reach a caller looking exactly like a summary that worked, and a
caller cannot tell the difference by looking.

Results are matched by **position**, never by id. Two saved results may carry the
same id — the document is untrusted, and that is a rule this tool reports rather
than a shape it can rule out — and matching by id silently collapses them. That
is not hypothetical: the first version of this check matched by id and accused
correct selection of losing a section.

## What is not here

No tokenizer, no paraphrasing, no retrieval. Every character emitted from a
section came from that section, with whitespace collapsed and control characters
stripped — and a section left with nothing after that is reported as missing,
not rendered as a section that is present and says nothing. The guard that
catches an absent text has to test the text as it will be READ, because that is
what the reader gets. A retrieval pointer is recorded and never followed — retrieving the
full text is the caller's round trip, and it is one they can choose not to make.

Control stripping matters more here than in a tool whose output is a table. The
summary has a line structure a reader is meant to parse: `[id] tool STATUS
status`, then indented section lines, then the omitted list. A section text
carrying a line feed would forge a result line for a call that never happened,
and U+0085 would do it on a terminal. Nothing that arrives from the document can
create a line in the summary.
