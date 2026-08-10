/**
 * The in-memory corpus the `glossary` verb tests resolve against.
 *
 * Deliberately **not** a copy of the committed fixture register under
 * `claude-plugins/fabrika/skills/glossary/evals/fixtures/` — that one is read for real by
 * `contract-examples.test.ts`, and a second copy here would be free to drift from the bytes the
 * contract's examples are pinned to.
 */

export const REPO = "/repo";
export const DIR = ".glossary";
export const TERMS_PATH = "/repo/.glossary/TERMS.md";
export const LANGUAGE_PATH = "/repo/.glossary/LANGUAGE.md";

/** Two sections, five rows, one planted duplicate key and one citation to resolve. */
export const TERMS = `# repo domain vocabulary (TERMS)

Prose that mentions #3227). as a bare hash, which is not a heading.

## Core / shape

| Term | Definition | Not |
|---|---|---|
| pano | The board product. | |
| worker | The edge worker. Cites 0044. | "server" |

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| depo | The internal asset store. | the public image product |
| pano | The board product, declared a second time. | |
| sozluk | The dictionary product. | "dictionary" |

## Indexing

| Term | Definition | Not |
|---|---|---|
| Database (tag) | The row-version marker. | a user-applied label |
`;

/** A register that exists, holds prose, and has no table — zero rows, never malformed. */
export const LANGUAGE_NO_ROWS = `# repo architecture vocabulary (LANGUAGE)

This file exists and holds no term table.
`;

/** One clean section, so `check` can reach `clean` rather than only `defects`. */
export const TERMS_CLEAN = `# repo domain vocabulary (TERMS)

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| depo | The internal asset store. | |
| sozluk | The dictionary product. | |
`;
