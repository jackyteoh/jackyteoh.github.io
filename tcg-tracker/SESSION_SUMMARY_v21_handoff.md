# 📌 READ THIS FIRST — TCG Tracker Session Summary & Handoff (v21)

**If you are an AI assistant (or anyone) picking up this project, read this
entire file before touching any code.** Single source of truth for what's
done, confirmed, deferred, or broken.

Lives **inside the project zip** (project root, next to `README.md`). See
"STANDING INSTRUCTIONS" — unchanged from v17-v20.

**Last stable shipped build:** `tcg-tracker-v21.zip` (in `/mnt/user-data/outputs/`)
**Current working source:** `/tmp/work/tcg-tracker/`
**Test status:** 331/331 passing — 321 in `tests.js` (319 carried forward +
2 new this session) + 10 in `tracker.tests.mjs` (unchanged this session).

This supersedes `SESSION_SUMMARY_v20_handoff.md`.

---

## ✅ THE PORYGON/SEARCH-MISS INVESTIGATION FROM v19/v20 IS RESOLVED (user-side)

v20 left this explicitly open with a "do not assume resolved" warning.
Update: the user reported they likely had **a second incognito window open
during testing**. This matters because separate incognito *windows* in the
same browser session share the same storage partition (same IndexedDB,
same localStorage) until the LAST incognito window of that session closes
— they are not isolated from each other the way a normal new
window/profile would be. This lines up exactly with the
`onblocked`-on-IndexedDB-open hypothesis raised in v20: a second window
holding an open connection to `tcg_catalogue` could block a version-change
open in the other window, which (with no `onversionchange`-triggered close
in place — still true, deliberately not added, see v19/v20) can produce
exactly the symptom seen: a catalogue that reports "ready" with a
plausible count, while a specific query mysteriously misses locally.
**No code changes were made for this specific report** — it's recorded
here as resolved-by-explanation, not resolved-by-fix. The `onblocked`
warning logging (v19) and the failed-set-id tracking (v20) remain in place
regardless, since both are real, independently-useful diagnostics — if a
genuine multi-tab block or partial-load happens again for any reason,
they'll still catch it.

**If this pattern resurfaces in a future session despite single-window
testing**, treat it as a fresh report, not a re-occurrence of this one —
don't assume "must be another incognito window" without checking
`tcgDebug.status().diagnostics.dbBlocked` and `enLoad.failedSetIds` first.

---

## STANDING INSTRUCTIONS FOR FUTURE SESSIONS (unchanged from v17-v20)

### A. Bundle this file into the project, every time
In the project root, inside the zip, next to `README.md`.

### B. Update and re-save every big iteration
Bump version + supersedes line · keep prior CONFIRMED DATA FACTS · document
changes with file/line + tests · state test status explicitly · end with
genuinely-open items · ship unprompted, in-zip.

### C. Always add a test for every fix/feature change
Both items this session have tests — see below.

---

## STATUS: v21 — SEARCH RANKING PRIORITY REVERSED (date now beats closeness)

### What was asked
After confirming the catalogue itself was healthy (a "Rebuild search
index" run still gave SWSH as the newest local Charizard — i.e. genuinely
the newest *data* available, not a data gap), the user asked: since this
collection skews toward modern/ultra-modern cards, should release date
outrank match-closeness when ranking search results? Concretely: typing
"Charizard" should surface something like "Mega Charizard X ex" or a
recent "Charizard ex" before a decades-old plain "Charizard" print — even
though the plain print is technically a stricter string match.

### Decision and why it's safe to make
Agreed and implemented. This is a deliberate **reversal** of the v15
design (which this codebase had explicitly tested as "relevance wins over
release date" through v19/v20 — see the test that got rewritten below).
The reversal is safe to make at the ranking stage specifically because of
where it sits in the pipeline: by the time `rankResults()` runs, every
candidate already passed an inclusion filter that requires the query to
appear as a substring of the card name (`nameLower.includes(q)` locally,
or the live API's `name:*query*` wildcard) — so there's no risk of an
unrelated card outranking a relevant one just because it's newer. The only
thing changing is the ORDER among cards that already, definitely, contain
the search term.

### Implementation ✅ DONE
- `core.js`: new `getReleaseDate(card)` helper — reads `card.releaseDate`
  (local catalogue's flat shape) or falls back to `card.set?.releaseDate`
  (live pokemontcg.io API's nested shape), so ranking works correctly
  regardless of which path supplied the results.
- `rankResults()`: sort key changed from `score → idx` to
  `releaseDate (desc) → score → idx`. Release date is now primary;
  `matchScore()` closeness only breaks ties among cards sharing the exact
  same release date (e.g. several variants printed in the same set).
- Updated the file-level doc comment in `catalogue.js`'s
  `searchENCatalogue()` that described the old (now-reversed) priority,
  so it doesn't mislead a future reader.

### Verification this session
- `node --check` clean on `core.js`, `catalogue.js`, `tests.js`.
- Rewrote the one existing test that explicitly asserted the OLD priority
  (`'rankResults() relevance still wins over release date for non-tied
  scores'`) into 3 new tests reflecting the NEW intended behavior:
  newer-but-looser-match now wins; same-date cards still rank by
  closeness (so closeness isn't meaningless, just secondary); and a new
  test confirming `getReleaseDate()` correctly reads the live API's
  nested `set.releaseDate` shape, not just the local catalogue's flat
  field (this exact case wasn't previously tested because the old
  priority order made it matter much less which shape you read from).
- Confirmed the existing v14 `matchScore()`/`rankResults()` tests (which
  use test fixtures with NO releaseDate field at all) still pass unchanged
  — `getReleaseDate()` returns `''` for all of them, so they all tie on
  date and fall through to the same closeness-based ordering as before.
  This is expected and correct, not a coincidence to be suspicious of.
- Full suite: **331/331 passing** (321 `tests.js` + 10 `tracker.tests.mjs`,
  the latter untouched this session and re-run only to confirm no
  cross-file regression).

---

## NOT COVERED BY TESTS
Carried forward from v20 (unchanged, neither touched this session):
1. `tcgDebug.testLocal()`'s cache-bypass guarantee specifically.
2. `tracker.tests.mjs` covers logic flagged as gaps across v16-v20, not
   exhaustive tracker.js coverage.

---

## CONFIRMED DATA FACTS — carried forward unchanged from v15 (don't re-derive)
`pokemon-tcg-data` per-card field shape, sets index shape, "no single file
has both cards+prices," `api.tcgdex.net` sandbox-only restriction, and now
also: **incognito windows in the same browser session share storage** —
worth remembering for any future "works in one window, not another"
report from this user.

---

## FILE LOCATIONS

```
tcg-tracker/
  SESSION_SUMMARY_v21_handoff.md   — THIS FILE (v21)
  README.md
  index.html                        (unchanged this session)
  css/style.css, css/tests.css
  js/core.js                        — getReleaseDate() helper, rankResults()
                                       priority reversed (v21)
  js/catalogue.js                   — searchENCatalogue() doc comment
                                       updated for the new priority (v21)
  js/tracker.js                      (unchanged this session)
  js/tests.js                        — 58 groups / 321 tests (+2 tests,
                                       1 rewritten into 3)
  js/tracker.tests.mjs               — 10 tests (unchanged this session)
  tests.html
proxy/  (unchanged)
```

Last shipped zip: `/mnt/user-data/outputs/tcg-tracker-v21.zip`

## IF CONTINUING IN A FUTURE SESSION
- The Porygon/search-miss report is closed per the explanation above —
  don't reopen it without fresh evidence (see the warning section).
- v16's low-hanging-fruit list (stale-price badge, select-all-visible,
  confirm-on-bulk-delete, export-filtered-CSV, persist sort/filter state)
  — still untouched.
- v15-deferred JP full-catalogue background load — still open, still
  blocked only by this dev sandbox's `api.tcgdex.net` allowlist.
- v19's open item — `db.onversionchange = () => db.close()` for the
  multi-tab-block scenario — still not added (the user's report turned out
  to be self-resolved via single-window testing, but the underlying gap in
  the code is still there if it ever matters again).
- Test harness patterns unchanged from v19/v20 — see `tests.js`/
  `tracker.tests.mjs` header comments directly.
