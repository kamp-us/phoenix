/**
 * `@kampus/doc-links` — the repo-wide dead-internal-link gate for docs (#638).
 * The core (`extractInternalLinks` / `findDeadLinksIn` + helpers) is a pure,
 * IO-free derivation; `bin.ts` wires it to the filesystem as an Effect CLI with a
 * `check` mode (CI gate: fail on any dead internal doc link).
 */
export {
	type DeadLink,
	type DocLink,
	extractInternalLinks,
	findDeadLinksIn,
	findRootDir,
	isExternal,
	maskCode,
	renderReport,
	stripFragment,
} from "./doc-links.ts";
export {CheckFailed, checkLinks, IoError, listMarkdownFiles, scanDeadLinks} from "./gate.ts";
