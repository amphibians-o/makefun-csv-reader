# csv-reader-speed: a faster drop-in for csv-reader 1.0.0

`solve.js` is a dependency-free ES module whose `run(input)` returns, for every input `{text, header}`,
exactly what csv-reader 1.0.0 returns: `{columns, rows, errors}` — including csv-reader's broken-row
policy (stray CRs dropped, quote junk appended, unterminated quotes re-read as unquoted text, short rows
padded, long rows cut, and every error reported with the line its record starts on and its index in
`rows`). `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with
`run`, and writes `/output/answers.json`.

## How it works

csv-reader reads one character at a time and builds each field a character at a time. This reader makes
one left-to-right pass too, but crosses the common stretches with `String#indexOf`, which scans natively:

- an unquoted field is found by jumping to the next comma or line feed, and taken with a single `slice`;
- inside a quoted field, the next quote is found the same way, segment by segment;
- the next CR and next LF positions are cached and only move forward, so a file whose CRs are rare never
  pays to rescan for them, and a CR that turns out to be part of a CRLF or a stray is handled exactly as
  csv-reader handles it;
- the rare paths (a stray CR splitting a field, a CR inside a quoted field, an unterminated quote) fall
  back to segment-by-segment handling that reproduces csv-reader's reading character for character.

No state is kept from one call to the next.

## Verification

- The kit's practice set: 6/6 cases identical to the reference (also passed through the kit's scorer:
  `passed: 1, cases_passed: 6`).
- Fuzzed against csv-reader 1.0.0 itself on ~61,000 generated broken-CSV inputs — including every string
  up to length 6 over {a, comma, quote, LF, CR} — with zero mismatches.

## Benchmark

Practice set (6 cases, 10,193,953 characters), Node 24, median of 7 rounds of `run()` over the whole set:

| reader | median |
| --- | --- |
| csv-reader 1.0.0 (house baseline) | ~500–520 ms |
| this entry | ~84 ms |

About **6x faster** in `run()`; end to end through `main.ts` (JSON in, JSON out) about **2.1x faster**
than the baseline entry on the same set.
