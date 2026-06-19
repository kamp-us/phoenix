/**
 * `@kampus/gh-phoenix` — the harness tooling that kills the Projects-classic
 * GraphQL error class on the kamp-us org (issue #743). Two pure cores:
 *
 *   - `router` — decides, for a `gh` argv, whether to pass it through, rewrite
 *     the GraphQL-breaking verb to a REST `gh api` call, or block it with a hint.
 *     `bin.ts` shadows `gh` on the subagent PATH and executes that decision.
 *   - `lint` — flags GraphQL-path `gh` invocations in the skill corpus and fails
 *     closed on zero scope (ADR 0092); `bin.ts lint-skills` / CI runs it.
 *
 * Both cores are pure and IO-free; the IO (shelling the real `gh`, reading skill
 * files) lives in `bin.ts`, exactly the leak-guard / epic-ledger idiom.
 */

export {
	type Finding,
	isSelfExempt,
	isZeroScope,
	type LintResult,
	lintCorpus,
	type ScanFile,
	scanFile,
} from "./lint.ts";
export {type GhRoute, isMilestoneTitle, route} from "./router.ts";
