/**
 * `@kampus/gh-phoenix` — the harness tooling that kills the Projects-classic
 * GraphQL error class on the kamp-us org (issue #743). Two pure cores:
 *
 *   - `router` — decides, for a `gh` argv, whether to pass it through, rewrite
 *     the GraphQL-breaking verb to a REST `gh api` call, or block it with a hint.
 *     `bin.ts` shadows `gh` on the subagent PATH and executes that decision.
 *   - `lint` — flags GraphQL-path `gh` invocations AND invalid YAML frontmatter
 *     (#1766) in the skill corpus and fails closed on zero scope (ADR 0092);
 *     `bin.ts lint-skills` / the `pipeline-cli gh-phoenix lint-skills` CI gate runs it.
 *
 * Both cores are pure and IO-free; the IO (shelling the real `gh`, reading skill
 * files) lives in `bin.ts`, exactly the leak-guard / epic-ledger idiom. This package
 * is the single source of truth for both cores — `pipeline-cli`'s `gh-phoenix` tool
 * imports them from here rather than carrying a copy (#2442).
 */

export {
	checkFrontmatter,
	type Finding,
	type FrontmatterFinding,
	isFrontmatterScoped,
	isSelfExempt,
	isZeroScope,
	type LintResult,
	lintCorpus,
	type ScanFile,
	scanFile,
} from "./lint.ts";
export {fileExists, isExecutable, resolveRealGh, resolveRepo, selfPath} from "./resolve.ts";
export {type GhRoute, isMilestoneTitle, route} from "./router.ts";
