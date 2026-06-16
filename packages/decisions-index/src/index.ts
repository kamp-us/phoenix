/**
 * `@kampus/decisions-index` — derive `.decisions/index.md` from the ADR files
 * (ADR 0066). The core (`buildIndex` + its parse/sort/dup helpers) is a pure,
 * IO-free derivation; `bin.ts` wires it to the filesystem as an Effect CLI with
 * `generate` (write the index) and `check` (CI gate: fail on a stale index or a
 * duplicate ADR id) modes.
 */
export {
	type AdrEntry,
	type AdrFile,
	buildIndex,
	DuplicateIdError,
	FrontmatterError,
	findDuplicateId,
	parseAdrFile,
	parseFrontmatter,
	renderIndex,
	sortEntries,
} from "./decisions-index.ts";
