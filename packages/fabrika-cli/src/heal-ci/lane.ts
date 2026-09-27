/**
 * The note's arrow: which lane a stall class hands the work to, as a **total lookup with no
 * judgment in it** over facts a classification already carries.
 *
 * The arrow names whose work a strand is so a puller can recognise it; it summons nobody
 * (`SKILL.md` §2, anchor `NEVER-DISPATCH`). Two runs over one strand must write the same word, so
 * this is pure and lives beside `stall.ts` rather than in whichever caller composes the line —
 * the scheduled sweep hardcoded `nobody` on every row and told every reader the detector had found
 * nothing for anyone to do, on the two classes the skill exists to catch.
 *
 * Each arm is the lane the skill's own step for that class names. Where the class alone cannot name
 * one — a `red` needs the log classification step 3 runs, which no classifier ran here — the answer
 * is `nobody`, which the skill defines as an answer rather than a gap.
 *
 * **`build` is reached only over a PR the pipeline owns.** A PR belongs to its author, so every arm
 * that would hand the work to `build` hands it to `author` instead unless the PR's standing is
 * `ours` or `granted` (`../ownership/`). A standing nobody could read is not ours: it routes to the
 * author too, because naming `build` on an unproven read is the takeover this check exists to stop.
 */
import type {StallToken} from "./stall.ts";

/** The closed set the first line's arrow draws from — a lane, never a person. */
export const LANE_TOKENS = ["build", "review", "ship", "author", "human", "nobody"] as const;

export type LaneToken = (typeof LANE_TOKENS)[number];

/**
 * Whose PR this is, as the arrow and the skill's later routes read it. `unread` is a standing nobody
 * asked for, because no route over this class hands the work to `build` — see {@link buildBound}.
 */
export const STANDINGS = ["ours", "granted", "foreign", "unknown", "unread"] as const;

export type Standing = (typeof STANDINGS)[number];

export interface LaneFacts {
	/** Who has taken the PR, if anyone — `diagnose`'s owner signal. */
	readonly ownerLogin: string | null;
	/** The PR's author, the operand that splits `author` from `human`. */
	readonly authorLogin: string;
	/** Whether the pipeline owns the PR — the operand that splits `build` from `author`. */
	readonly standing: Standing;
}

/** `build` over a PR the pipeline owns; its author's otherwise. */
const pipelineOr = (standing: Standing): LaneToken =>
	standing === "ours" || standing === "granted" ? "build" : "author";

/**
 * Whether this class's work can reach `build` — so whether its standing must be read at all.
 *
 * Two routes reach it: this arrow (`conflicted`, and `linkage-refused` with a holder), and `SKILL.md`
 * §3's `logic` route over a `red`, which the arrow leaves at `nobody` because the log signature that
 * picks it is read later. §3 sends that red to `build` only on `ours` or `granted`, so the standing
 * is read here for it too. A caller reads ownership only when this is true: every other class ignores
 * it, and a read nobody needs is one more way for a classification to fail.
 */
export const buildBound = (token: StallToken, ownerLogin: string | null): boolean =>
	token === "red" || token === "conflicted" || (token === "linkage-refused" && ownerLogin !== null);

export const laneFor = (token: StallToken, facts: LaneFacts): LaneToken => {
	switch (token) {
		case "ungated":
			return "review";
		case "gated-unshipped":
			return "ship";
		// §2: `author` when the claim holder is this PR's author, `human` when they are anyone else.
		case "claim-stale":
			return facts.ownerLogin !== null && facts.ownerLogin === facts.authorLogin
				? "author"
				: "human";
		// §6 offers two arms — "route it to the author or to `build` to reword the body" — and the
		// holder is what picks between them, so this stays a lookup rather than becoming a choice.
		case "linkage-refused":
			return facts.ownerLogin === null ? "author" : pipelineOr(facts.standing);
		// §7: the repair is a rebase, which is a repair round on a branch — `build`'s when the pipeline
		// owns the PR, and its author's when it does not.
		case "conflicted":
			return pipelineOr(facts.standing);
		// §5: the cancel-and-rerun lever and a required-context change are both an operator's.
		case "wedged":
		case "check-surface":
			return "human";
		// §6: a PR correctly waiting on a person.
		case "blocked-human":
			return "human";
		// §3 routes a red off its log signature — `transient` to a rerun, `logic` to `build`,
		// `unclassified` to intake — and no signature is read at classification time. Naming one of the
		// three from the class alone would be the judgment the arrow forbids.
		case "red":
			return "nobody";
		// Neither is ever noted: §1 says both write nothing, there being no strand to record. The arms
		// exist so the lookup is total over `STALL_TOKENS` rather than partial with a default.
		case "attended":
		case "not-open":
			return "nobody";
	}
};
