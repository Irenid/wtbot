# Nick search

How the player search (`/api/players`, the home page; `/scout`'s player
autocomplete) finds a nick typed with mistakes, and why its weights are what
they are. Code: `src/nick-search.ts`; contract: AGENTS.md section 8, "Player
search". Measured on 2026-10-08 on a database copy: 20,086 nick keys of
replays, identities and aliases.

## What nicks look like

Of 20,031 replay nicks (2026-10-08):

| Variant | Nicks | Examples |
|---|---|---|
| Cyrillic only | 1,207 (6.0%) | `шурупавёрт`, `Пивной пророк` |
| A lone digit for a letter (leet) | 924 (4.6%) | `Vad1m`, `Bl0ckm0nst3rLP`, `rom4ik19` (4 is ч) |
| Latin and Cyrillic mixed (look-alikes) | 470 (2.3%) | `Zоroaster` (the most active nick, Cyrillic о), `Taнгаж` |
| A letter repeated three times | 288 (1.4%) | `miiinatoo`, `Tipstafff` |
| Volapuk: Russian drawn in Latin letters and digits | ~100 | `AKYJIA` (акула), `4ert_Ha_CB9I3u` (черт на связи) |
| Greek look-alikes | 37 | `MΛRS`, `Λthena` |
| Fancy Unicode letters (NFKC folds them) | 2 | `尺乇Ｇ丨` |

No stored nick holds a symbol beyond `_`, `-`, space, `#` and the
`@psn`/`@live` suffix.

## How a match is scored

Three views of the query and of every nick; the cheapest match counts:

- **look**: Latin look-alikes (`LOOK`); a letter typed for a nick's lone digit
  costs a quarter edit (`leetSlot`); a digit typed for a letter, or a digit of a
  number (`2008`), is an edit;
- **read**: Russian reading (`READ`, `READ_DIGRAPHS`: `JI` л, `bI` ы, `II` п,
  `IO` ю, `9I` я, `III` ш);
- **sound**: Cyrillic transliterated, spellings merged (`SOUND_RULES`: zh/j,
  kh/h, ts/c, ya/ja, ee/i, doubled letters).

The query's other keyboard layout is a fourth, look view. Costs are quarter
edits (`Q` = 4): look-alikes 1–3, a doubled letter `DOUBLED` (2), anything else
an edit; the read and sound views and the layout switch add an edit, a fuzzy
match inside a nick `INSIDE` (3). A nick passes within `maxEdits(length)` edits
(1 from 4 characters, 2 from 8) plus a quarter. Ranking: cost, whole before
start before inside, as typed before folded, then battles.

## Benchmark

`npm run bench:nick-search -- <copy.db> [--seed N] [--cases N] [--misses]`
simulates what people type, from real nicks: one slip (a neighbouring key 45%,
a dropped key 25%, an extra one 15%, a swap 15%), a mixed nick read all as Latin
or all as Russian, leet typed as letters, Cyrillic nicks transliterated by
random schemes (GOST, ICAO, gamer: ж as zh/j/g/x, х as h/kh/x, …), Latin nicks
spelt by ear in Cyrillic, the wrong layout with a slip, and 32 volapuk nicks
read by hand. The transliteration and spelling schemes are drawn independently
of the matcher's rules, so the test is not circular.

Share of queries whose nick comes first / in the first 5 (the suggestion
box), seeds 1–3 × 600 cases (2026-10-08):

| Query | Before (917e6a6) | Now |
|---|---|---|
| exact nick | 100 / 100 | 100 / 100 |
| typo, Latin nick | 98.1 / 99.1 | 98.0 / 99.2 |
| typo, Cyrillic nick | 98.1 / 99.2 | 98.1 / 99.1 |
| look-alikes as seen | 87.4 / 93.6 | 94.6 / 100 |
| look-alikes and a typo | 72.7 / 79.1 | 84.7 / 93.1 |
| leet typed as letters | 85.5 / 89.9 | 93.5 / 97.8 |
| leet and a typo | 58.6 / 61.1 | 82.9 / 88.9 |
| Cyrillic nick in Latin letters | 1.6 / 1.9 | 93.8 / 97.5 |
| Latin nick in Cyrillic by ear | 1.1 / 1.1 | 93.7 / 96.6 |
| wrong layout and a typo | 4.6 / 4.8 | 93.0 / 96.2 |
| volapuk read in Russian (32) | 15.6 / 15.6 | 78.1 / 100 |

A query scans the index in 8–10 ms (before: 1.5 ms) in the worker task
`search-player-nicks`; building the index takes 240 ms per worker every
`NICK_INDEX_TTL_MS`. On the main thread, ranking 100 nicks (`rankNicks`) takes
1 ms.

## Decisions

Fitted by grid search on the benchmark (108 settings), plain typos held at
their level before the change:

- **Views rank an edit lower.** At half an edit, a nick that merely sounds
  alike beat the right one with a typo: plain typos first 95.0% instead of
  97.7%.
- **Leet only from a typed letter to a nick's lone digit.** Cheap both ways, a
  typed digit matched any letter and numbers matched letters (`pick3_` found
  `NiclPickel` before `Picl3_`, `e902` matched inside `a3221339023`).
- **No discount for neighbouring keys.** It moved first places by under a
  point either way, although 45% of the simulated slips hit a neighbouring
  key, so the code went.
- **A doubled letter costs half an edit**, not a quarter: `exxx` flooded every
  `exx…` nick and the intended `Ezxx` fell out of the first 20.
- **A fuzzy match inside a nick costs 3 more**: cheap ones beat whole nicks one
  edit away (`rez4` found `ALir3z4` before `R_E_Z_E`).
- **Battles break ties**, not the shared start: one-typo queries of 4–5 letters
  found their nick first in 68% instead of 82% (a slip makes the shared start
  of other nicks longer).
- **No bit-parallel prefilter** (Myers/Hyyrö): it might cut a query to ~3 ms,
  but at closed-access traffic 10 ms in a worker is far from a limit.

## Limits

- Index keys are lower case, so case-only look-alikes are guessed: `b` reads as
  в (`B`), not ь; Greek `μ` as M.
- Volapuk spellings beyond `READ_DIGRAPHS` (`TI` for П, `|<` for К) cost edits.
- English spelling by ear is approximate (`Pine` is "пайн").
- A query under 4 characters gets no typo; from 3 characters, one look-alike or
  leet letter. A query of digits gets neither.
- A nick first seen within `NICK_INDEX_TTL_MS` is found only by its prefix.
