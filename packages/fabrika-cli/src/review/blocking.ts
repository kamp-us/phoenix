/**
 * The blocking authority: which check contexts at a head may stop a pull request.
 *
 * One module because four verbs answer the same question — `ship checks`, `heal-ci diagnose`,
 * `heal-ci logs` and `review ci` — and three derivations of one predicate are three answers to one
 * question. Each of them used to decide it locally off the name denylist in `./rollup.ts`, or, in
 * `review ci`'s case, not at all.
 *
 * **The base branch's declared required set is the authority.** A red outside it is reported and
 * never blocks. The denylist survives here as the fallback for a branch that declares nothing, and
 * as nothing else.
 *
 * The two zero-signal reads are kept apart because they route differently:
 *
 * - `unprobeable` — the required set could not be read at this token's permission. **No verb may
 *   answer a colour over it.** The read failure itself is the named cause, so a lane waits or parks
 *   on that rather than on a check's conclusion.
 * - `no-requirements` — the read succeeded and the branch declares nothing required. That is a
 *   branch nobody has said what gates, not a branch that gates nothing, so the denylist definition
 *   holds and every non-informational red blocks as it did before. A branch whose repository plan
 *   offers neither rulesets nor branch protection lands here too: it cannot declare a required
 *   check, and GitHub's plan-gate 403 says so to every token, so it is no permission finding.
 *
 * Contexts are matched as the platform names them, against the branch the pull request targets —
 * never `main` by name, because the authority belongs to the base a merge would land on.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9597#issuecomment-5754418554
 */
import {Effect} from "effect";
import {branchProtectionContexts, rulesetContexts} from "../heal-ci/github.ts";
import type {ServedStatus} from "../io/gh-api.ts";
import type {Shell} from "../io/git.ts";
import {isInformational} from "./rollup.ts";

export type DeclaredRead =
	/** The declared set is known, however many members it has. */
	| {readonly _tag: "Declared"; readonly contexts: ReadonlyArray<string>; readonly scanned: number}
	/** The repository's plan offers neither rulesets nor branch protection: nothing can be declared. */
	| {readonly _tag: "PlanGated"}
	/** The token cannot see the protection surface — an answer at exit `0`, never `no-requirements`. */
	| {readonly _tag: "Unprobeable"; readonly reason: string}
	/** The rules enumeration completed and is provably short of a terminal page. */
	| {readonly _tag: "Incomplete"; readonly scanned: number}
	/** A read failed for a reason that is not this token's permission — coverage is UNKNOWN. */
	| {readonly _tag: "Unknown"; readonly what: string; readonly reason: string};

/**
 * The start of GitHub's `message` on a 403 served because the repository's plan lacks the feature —
 * a private repository on the free plan, where rulesets and branch protection are paid. It reaches
 * every token, admin included, so no permission clears it.
 */
const PLAN_GATE = "Upgrade to GitHub Pro or make this repository public";

/** One refused authority read, sorted by what the refusal says about the branch. */
const refused = (answer: ServedStatus, what: string, reason: string): DeclaredRead => {
	if (answer.status === 403 && answer.message?.startsWith(PLAN_GATE) === true) {
		return {_tag: "PlanGated"};
	}
	return answer.status === 401 || answer.status === 403
		? {_tag: "Unprobeable", reason}
		: {_tag: "Unknown", what, reason};
};

/**
 * The declared required contexts for one base branch: branch protection ∪ the rulesets that match it.
 *
 * `no-requirements` needs a **successful** rules read returning zero required contexts *and* the
 * protection endpoint's 404 — both, never the 404 alone.
 */
export const readDeclared = (repo: string, base: string): Shell<DeclaredRead> =>
	Effect.gen(function* () {
		const rules = yield* rulesetContexts(repo, base);
		if (rules._tag === "Failure") return refused(rules, "the ruleset list", rules.reason);
		if (!rules.value.exhausted) {
			return {_tag: "Incomplete" as const, scanned: rules.value.scanned};
		}

		const answered = yield* branchProtectionContexts(repo, base);
		const protection = answered.read;
		if (protection._tag === "Unknown") {
			return refused(answered, "the branch protection", protection.reason);
		}
		const fromProtection = protection._tag === "Present" ? protection.value : [];
		return {
			_tag: "Declared" as const,
			contexts: [...new Set([...fromProtection, ...rules.value.contexts])],
			scanned: rules.value.scanned,
		};
	});

/**
 * One base branch's blocking authority, as a predicate over check-run names.
 *
 * The token names which definition answered, so a caller can say so without re-deriving it from
 * `contexts.length` — the two are one fact, and a reader that recomputes it is the second
 * derivation this module exists to prevent.
 */
export type BlockingSet =
	| {
			readonly token: "required";
			/** The declared contexts, as the platform names them. */
			readonly contexts: ReadonlyArray<string>;
			readonly blocks: (name: string) => boolean;
	  }
	| {
			readonly token: "no-requirements";
			/** Why nothing is declared: nobody declared it, or the repository's plan cannot. */
			readonly because: "undeclared" | "plan-gated";
			readonly contexts: readonly [];
			readonly blocks: (name: string) => boolean;
	  };

/** The answer over a declared read: an authority to judge by, or the read that could not be made. */
export type BlockingRead =
	| {readonly _tag: "Set"; readonly set: BlockingSet}
	| Exclude<DeclaredRead, {readonly _tag: "Declared" | "PlanGated"}>;

const denylistSet = (because: "undeclared" | "plan-gated"): BlockingSet => ({
	token: "no-requirements",
	because,
	contexts: [],
	blocks: (name) => !isInformational(name),
});

/**
 * The authority one declared set carries — the whole of the `required` / `no-requirements` split.
 *
 * Exported so a caller can construct the predicate over a set it already holds, and so the split is
 * provable without a scripted HTTP read standing between the test and the rule.
 */
export const blockingSet = (declared: ReadonlyArray<string>): BlockingSet => {
	if (declared.length === 0) return denylistSet("undeclared");
	const required = new Set(declared);
	return {token: "required", contexts: declared, blocks: (name) => required.has(name.trim())};
};

/** The blocking authority of the branch a pull request targets. */
export const readBlockingSet = (repo: string, base: string): Shell<BlockingRead> =>
	Effect.map(readDeclared(repo, base), (declared): BlockingRead => {
		if (declared._tag === "Declared") return {_tag: "Set", set: blockingSet(declared.contexts)};
		if (declared._tag === "PlanGated") return {_tag: "Set", set: denylistSet("plan-gated")};
		return declared;
	});

/**
 * The refusal line one unreadable authority earns, single-sourced so four verbs name one cause.
 *
 * Every arm names the read failure rather than a check's conclusion: with the authority unread,
 * whether any red blocks is underivable, and a colour served over that would be exactly the merge
 * the governing ruling forbids — a ship over a required set nobody could read.
 */
export const unreadableCause = (
	verb: string,
	base: string,
	read: Exclude<BlockingRead, {readonly _tag: "Set"}>,
): string => {
	const tail = "which checks block is UNKNOWN, never none.";
	if (read._tag === "Unprobeable") {
		return `${verb}: cannot read ${base}'s required status checks at this token's permission: ${read.reason} — ${tail}`;
	}
	if (read._tag === "Incomplete") {
		return `${verb}: ${base}'s ruleset read never reached a terminal page after ${read.scanned} rule(s) — pagination is unexhausted, so ${tail}`;
	}
	return `${verb}: cannot read ${read.what} for ${base}: ${read.reason} — ${tail}`;
};

/** What a verb says about the authority it judged by, so the answer carries its own definition. */
export const authorityNote = (verb: string, base: string, set: BlockingSet): string => {
	if (set.token === "required") {
		return `${verb}: ${base} declares ${set.contexts.length} required context(s): ${[...set.contexts].sort().join(", ")} — a red outside that set is reported, never blocking.`;
	}
	return set.because === "plan-gated"
		? `${verb}: ${base}'s plan offers no branch protection or rulesets — every non-informational check blocks, because the branch cannot declare a required check.`
		: `${verb}: ${base} declares no required status checks, so every non-informational check blocks — an undeclared branch is one nobody has said what gates.`;
};

/**
 * What a verb says when a head produced runs and **none of them blocks** — an answer that may not
 * be green.
 *
 * Narrowing the rollup to the declared set opens this case wherever the required contexts have not
 * posted yet, and `rollupOf` over an empty set answers `green` by construction: every run it was
 * given concluded passing, there having been none. A caller that served that word would merge a head
 * no required check has reported on. Both callers answer `pending` instead and print this.
 */
export const noBlockingRunNote = (verb: string, base: string, set: BlockingSet): string =>
	set.token === "required"
		? `${verb}: no run at this head answers any context ${base} declares required — pending, never green: the required checks have not reported.`
		: `${verb}: every run at this head is informational — pending, never green: nothing here gates.`;

/** The names failing outside the blocking set: real reds a caller reports rather than routes. */
export const reportedLine = (verb: string, names: ReadonlyArray<string>): ReadonlyArray<string> =>
	names.length === 0
		? []
		: [
				`${verb}: failing outside the required set: ${[...names].sort().join(", ")} — reported, never blocking.`,
			];
