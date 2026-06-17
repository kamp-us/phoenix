---
id: 0080
title: "Site search v1 is a lexical search bar; semantic discovery is a separate product"
status: accepted
date: 2026-06-16
tags: [search, product, d1, fts5, vectorize, turkish]
---

# 0080 — Site search v1 is a lexical search bar; semantic discovery is a separate product

## Context

There is no server-side search today. The sözlük home's "search" box is purely
client-side `title.includes(query)` over the first `HOME_PAGE_SIZE = 5` loaded terms
(`apps/web/src/pages/SozlukHome.tsx`); pano has no search; the Topbar's `⌘K` hint
implies a palette that does not exist. All content lives in D1 (`term_summary`,
`post_summary`, …) read through Drizzle keyset connections (ADR
[0019](0019-connection-pagination-strategy.md)) under the d1-direct convention (ADR
[0009](0009-d1-direct-defer-dos-and-workflows.md)). #120 is the fork the rest of the
search epic hangs on: scope + matching technique + result shape.

The framing is **product-driven, not engineering-driven** (the doctrine that the
product layer leads and engineering follows). The seductive engineering question —
"should search be semantic?" — is the **wrong** question, because lexical and semantic
search serve **different product surfaces with opposite tolerance for fuzziness**:

- **Search bar** = directed lookup ("find the thing I typed"). A fuzzy result here is
  a **failure**. It wants lexical precision.
- **Discovery rails** (related / see-also / gündem / recommendations) = serendipity
  ("show me what's near this"). A fuzzy result here is **delight**. It wants semantic
  meaning.

That is *why* lexical belongs in the bar and semantic belongs in discovery — they are
two different features on two different surfaces, not two versions of one feature.
**#120 scopes ONLY the search bar.**

## Decision

**Search v1 is a lexical search bar.** Semantic discovery is a separate product,
sequenced later (see *The ladder*). The v1 engine is **SQLite FTS5 in D1**
(Cloudflare-native, lexical).

**Engine + ranking.** FTS5 virtual table, **bm25-ranked** results (relevance-first —
the real-search UX; not insertion order). Search sits behind a **provider seam**: a
search provider returns the existing connection contract
`{rows, hasNextPage, endCursor, totalCount}` (ADR
[0019](0019-connection-pagination-strategy.md)). The v1 provider is FTS5; swapping or
adding a provider later never changes the route or the UI consumers (#122 / #123).

**Result shape.** Per-type list roots — `searchTerms` / `searchPosts` — reusing the
existing `TermRow` / post-card components. **No** unified `SearchResult` view. This
keeps the request-key → root-name 1:1 constraint (ADR
[0021](0021-frontend-on-react-fate.md), `.patterns/fate-views-and-requests.md`) and
lets #122 reuse components verbatim.

**Scope v1.** Sözlük **term titles** + pano **post titles** (unified — both cheap).
Definition bodies, comment bodies, and users are explicitly **deferred**. Min query
length **2**. `⌘K` (#125) **focuses the search input** — it is not a command palette.

**Sync.** App-level **dual-write** in the d1-direct mutation handlers — the worker
already owns every write to `term_summary` / `post_summary`, so it writes the FTS rows
in the same place. **Not** SQLite triggers. *Export caveat:* D1 cannot export a
database that contains virtual tables; migrating out requires dropping and recreating
the FTS tables first — note this for any future export/migration.

**Turkish handling** (the one part with real depth — recorded here so #121 does not
rediscover it):

- Tokenizer `unicode61` with `remove_diacritics=2`. **Not `porter`** — porter is an
  English stemmer and is actively harmful for Turkish.
- An app-side **normalized search column**, folded **symmetrically at write AND query
  time**: Turkish-correct lowercase, fold `ı`/`i` and `ç`/`ş`/`ğ`/`ö`/`ü` → ASCII, so
  search is both diacritic-insensitive and dotted-`i`-insensitive. This sidesteps
  `unicode61`'s ASCII-wrong `I → i` case-folding.
- **Prefix indexing** (`prefix='2 3 4'`) as a poor-man's stemmer for Turkish
  agglutination.
- Named as **accepted-for-v1** (out of lexical reach, handed to the semantic lane):
  consonant-mutation suffixes (`kitap` / `kitabı`), true morphological stemming, and
  synonymy.

## Consequences

### The ladder — two axes, both CF-native at the base

- **Lexical axis:** FTS5 in D1 (v1, CF-native) → managed lexical
  (Typesense / Algolia — best-in-class typo-tolerance, **external**, only if we outgrow
  FTS5).
- **Semantic axis:** **Vectorize** (CF-native) — the meaning/discovery engine. This is
  a **separate product** (the discovery layer: related / see-also / explore — "the
  rabbit hole"), **not "search v2."** Sequenced for when the corpus is dense enough
  that discovery is delightful. Turkish *strengthens* the semantic case — embeddings
  absorb the morphology and synonymy that lexical cannot.
- **End-state is hybrid:** a precision bar + semantic rails (CF's AI Search hybrid /
  Algolia NeuralSearch are exactly this pattern). **AI Search / AutoRAG is
  named-and-deferred** as the future natural-language-Q&A capability (RAG over docs);
  today it is blocked by D1-not-a-source, open-beta, and ranked-list-not-keyset.

**Vectorize is NOT "a better FTS5."** It is the **other axis** (semantic) — a
different feature on a different surface. A future agent must not mis-file Vectorize
as "search v2"; it is the discovery product, sequenced on its own merits.

### For the children

- **#121 (resolver):** FTS5 provider — needs a **virtual-table migration** + the
  normalized column + dual-write sync + a bm25 resolver. (The earlier "no migration
  needed" note applied to the **rejected** `LIKE`/`instr` option; FTS5 adds the
  migration.)
- **#122 (`/ara` route + page):** unchanged shape — per-type roots, reuse components.
- **#123 (wire `onSearchSubmit`):** unchanged.
- **#125 (`⌘K`):** focus the search input.

### Trade-offs

- FTS5 buys real ranking and prefix matching at the cost of a migration and write-path
  maintenance (the dual-write) — accepted, because directed lookup must be precise and
  ranked, and the corpus is small enough that FTS5 in D1 is ample.
- The export caveat (virtual tables block D1 export) is a known operational tax,
  recorded so it does not surprise a future migration.
- Keeping result roots per-type (no unified `SearchResult`) preserves ADR 0021's 1:1
  request-key→root mapping and maximizes component reuse, at the cost of two roots on
  one screen — the constraint, not a limitation.
