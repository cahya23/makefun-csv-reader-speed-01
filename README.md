# Fast CSV reader — make.fun entry

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/cahya23/makefun-csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/cahya23/makefun-csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0, written for the
[csv-reader-speed-01](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
competition. `solve.js` returns exactly csv-reader 1.0.0's answer
`{columns, rows, errors}` for every `{text, header}` input — including its
broken-row policy (stray CRs, quote junk, unterminated quotes, short and
long rows) — but reads with `indexOf` jumps and slices instead of one
character at a time, with a fast path that splits a whole quote-free record
on commas at once.

Run it on a set of cases:

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

`main.ts` reads `<cases dir>/cases.json` and writes `<out dir>/answers.json`.
