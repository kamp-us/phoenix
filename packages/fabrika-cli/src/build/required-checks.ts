/**
 * The required-check state at a PR's head, as `build verdicts` folds it beside mergeability.
 *
 * A red required check is repair work no gate emits a FAIL for, the same kind of fact a base
 * conflict is: a reviewer's PASS can land before CI settles, and an all-PASS fold over a red head
 * read as the proven no-work answer. "Required" is `../review/blocking.ts`'s authority, the one
 * `review ci` and `ship checks` judge by, so the three verbs cannot disagree about which check blocks.
 *
 * Only `green` says the head needs no CI repair, and it is served only when every blocking run
 * concluded passing and every declared context reported. An unfinished, unreported or unreadable
 * check is `pending` or `unknown`, never green. This `green` is not merge authority: gate coverage and
 * the wait belong to `ship checks`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9949
 */
import {Effect} from "effect";
import type {Shell} from "../io/git.ts";
import {listCheckRuns} from "../io/pulls.ts";
import {owedRollup, readBlockingSet, reportingAt, unreadableCause} from "../review/blocking.ts";
import {isFailing, rollupOf} from "../review/rollup.ts";

export type RequiredChecks =
	| {readonly state: "green"}
	/** Each failing blocking context by name — a red with nobody named to fix is no finding. */
	| {readonly state: "red"; readonly failing: readonly [string, ...string[]]}
	/** Blocking runs still in flight, and declared contexts that have posted nothing at this head. */
	| {readonly state: "pending"; readonly awaiting: ReadonlyArray<string>}
	| {readonly state: "unknown"; readonly reason: string};

const sortedUnique = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(names)].sort();

/** The required-check state at `head`, judged by the declared set of the branch the PR targets. */
export const requiredChecksAt = (
	verb: string,
	repo: string,
	base: string,
	head: string,
): Shell<RequiredChecks> =>
	Effect.gen(function* () {
		const authority = yield* readBlockingSet(repo, base);
		if (authority._tag !== "Set") {
			return {state: "unknown", reason: unreadableCause(verb, base, authority)} as const;
		}
		const set = authority.set;

		const enumerated = yield* listCheckRuns(repo, head);
		if (enumerated._tag === "Failure") {
			return {
				state: "unknown",
				reason: `${verb}: cannot enumerate check runs at ${head}: ${enumerated.reason} — the required checks are UNKNOWN, never green.`,
			} as const;
		}
		const {declared, runs} = enumerated.value;
		if (runs.length < declared) {
			return {
				state: "unknown",
				reason: `${verb}: received ${runs.length} of ${declared} declared check runs at ${head} — a partial enumeration leaves the required checks UNKNOWN, never green.`,
			} as const;
		}

		const blocked = runs.filter((run) => set.blocks(run.name));
		const reporting = reportingAt(
			set,
			runs.map((run) => run.name),
		);
		const rollup = owedRollup(rollupOf(blocked), reporting);
		if (rollup === "green") return {state: "green"} as const;
		if (rollup === "red") {
			const [first, ...rest] = sortedUnique(blocked.filter(isFailing).map((run) => run.name));
			// `rollupOf` answers red only over a failing run, so the list cannot be empty here.
			if (first !== undefined) return {state: "red", failing: [first, ...rest]} as const;
		}
		const running = blocked.filter((run) => run.status !== "completed").map((run) => run.name);
		const owed =
			reporting._tag === "Unreported"
				? reporting.contexts
				: reporting._tag === "Silent"
					? set.contexts
					: [];
		return {state: "pending", awaiting: sortedUnique([...running, ...owed])} as const;
	});

/** The machine line the fold's required-check state gets, one per value. */
export const requiredChecksNote = (
	verb: string,
	pr: number,
	head: string,
	checks: RequiredChecks,
): string => {
	switch (checks.state) {
		case "green":
			return `${verb}: every required check on PR #${pr} passed at ${head}.`;
		case "red":
			return `${verb}: required check(s) RED on PR #${pr} at ${head}: ${checks.failing.join(", ")} — a red required check is repair work no gate emits a FAIL for, so this fold is not a clean answer.`;
		case "pending":
			return `${verb}: PR #${pr}'s required checks at ${head} have not concluded${checks.awaiting.length === 0 ? "" : ` (awaiting ${checks.awaiting.join(", ")})`} — PENDING, never green.`;
		case "unknown":
			return checks.reason;
	}
};
