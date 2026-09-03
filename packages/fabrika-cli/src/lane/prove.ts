/**
 * The proof core — what a lane event claims about the world, and whether the world says it.
 *
 * The retired epic conductor moved on the git graph rather than on its own report. A lane operator
 * owns no branch, so the artifact a lane event claims is one it cannot author: for a single-issue
 * lane and for an epic run's tail, an open PR tracing to the task's issue and a verdict at that PR's
 * head; for an epic run's *child*, which never opens a PR at all (ADR 0285), the commits its range
 * adds and a range-bound verdict on the child issue. Everything here is the pure half — facts in,
 * one verdict out — so the whole table is testable without a network and without a checkout.
 *
 * **Three events carry a claim, and one of them claims a negative.** `DONE` out of a `build` state
 * asserts the work exists, `PASS` out of a review state asserts the namespaces that state owes
 * judged it — every derived one out of `review:ui`, every one the plain `review` cell can itself
 * reach out of `review` (see {@link REVIEW_UI_STATE} for why the two differ). `BLOCKED` out of a
 * review state asserts the reviewer's run reached **no** verdict, which one still-binding `FAIL`
 * falsifies ({@link foldPark}). A `WIP`, an `UNBLOCKED`, a `FAIL`, a `BLOCKED` out of `build`, a
 * `DONE` out of `ship` or a `DONE` out of a child's `integrate` asserts nothing a read could
 * falsify — those answer {@link Claim} `None`, so a caller may prove *every* event and still only
 * pay for the three that can lie.
 *
 * **What the two events claim is the same question asked of a different artifact**, and which
 * artifact is structural: {@link roleOf} reads it off the task's own name, exactly as the emitter
 * wrote it. Nothing here chooses a per-run policy, so a child cannot be proven against a PR it was
 * never allowed to open, and a tail cannot be proven against a range nobody judged.
 *
 * The state names are the shipped templates' (`./templates/coder.workflow.json` and the regions
 * `./emit.ts` renders). A machine that renames them derives no claim and says so, which keeps a
 * foreign workflow routable instead of refused.
 */

import {issueRefsIn} from "../build/commit-message.ts";
import type {ParentedCommit} from "../io/git.ts";
import type {PullScope} from "../io/pulls.ts";
import {type IssueRefs, ROUTED_NAMESPACES} from "../review/classes.ts";

/** The branch grammar's own reader, re-exported so this module's callers take one derivation. */
export {childLaneBranches} from "../build/lane.ts";

/** The leaf state a builder runs in — a `DONE` out of it claims the built work exists. */
export const BUILD_STATE = "build";

/** The leaf state a reviewer runs in — a `PASS` out of it claims a verdict that still binds. */
export const REVIEW_STATE = "review";

/**
 * The leaf state the rendered-visual gate runs in — the second review cell, and the one whose `PASS`
 * stands on the **whole** required set.
 *
 * Splitting the two cells is what makes the machine's `review → review:ui` arm walkable. That arm is
 * taken on the `PASS` out of {@link REVIEW_STATE}, so proving that `PASS` against `review-ui` asked
 * a lane to hold a verdict only the cell it had not reached yet could produce — every rendered-surface
 * lane deadlocked at exit 23 and needed a hand-spawned reviewer to get out (#6664, #6793). Each cell
 * now proves what it owes: `review` the namespaces it can reach **when this arm is the one it is
 * taking**, `review:ui` all of them. A lane that is not taking it holds the whole set at `review`,
 * so the deferral can never outlive the routing that earns it (ADR 0320).
 *
 * An epic child is the one role this state name does not reach at all — its region has no such cell
 * to route to and no verb can post the namespace at its scope, so its deferral is unconditional and
 * its creditor is the tail. {@link claimOf} carries that reading.
 */
export const REVIEW_UI_STATE = "review:ui";

/**
 * The two leaves a shipper runs in — `ship` and the queue dwell it re-enters (ADR 0313).
 *
 * A `DONE` out of either claims no artifact ({@link claimOf} answers `None` for both), and that is
 * unchanged: what the merge closed is a *routing* question, not a proof, so it is read by
 * {@link traceClosure} beside the proof rather than folded into it. A refused proof would strand the
 * shipper with no legal terminal over a merge that really did land.
 */
export const SHIP_STATES: ReadonlyArray<string> = ["ship", "ship:queued"];

/** The label a no-PR builder outcome is only legal under (`build`'s `SUCCESS-NO-PR`). */
export const INVESTIGATION_LABEL = "type:investigation";

/**
 * Which of the two shapes a task sits in — the union that makes "a child with no epic" unwritable.
 *
 * `Tail` and `Single` are separate even though they claim the same artifacts: they reach the same
 * arms by different routes, and folding them would leave the epic number unreadable at the one place
 * a diagnostic wants to name it.
 */
export type LaneRole =
	| {readonly _tag: "Single"}
	| {readonly _tag: "Child"; readonly epic: number}
	| {readonly _tag: "Tail"; readonly epic: number};

/**
 * The epic a lane's tail phase reviews and ships, read off the tail task's own name — `null` on a
 * single-issue lane, which has no tail. That name is the emitter's structural mark of the one-PR
 * shape (`./emit.ts`'s `epicTaskId`), so recognising it needs no second declaration.
 */
export const epicOf = (taskIds: ReadonlyArray<string>): number | null => {
	for (const taskId of taskIds) {
		const named = /^epic_(\d+)$/.exec(taskId);
		if (named?.[1] !== undefined) return Number.parseInt(named[1], 10);
	}
	return null;
};

/** The role a task plays: on an epic lane every task but the tail is a child region. */
export const roleOf = (taskId: string, epic: number | null): LaneRole => {
	if (epic === null) return {_tag: "Single"};
	return taskId === `epic_${epic}` ? {_tag: "Tail", epic} : {_tag: "Child", epic};
};

export type Claim =
	| {readonly _tag: "OpenPull"}
	/**
	 * `defers` is the slice of the required set this cell hands to a later one, subtracted before the
	 * proof is taken. Non-empty only on a `review` `PASS` this lane's own machine routes into
	 * {@link REVIEW_UI_STATE} — the cell that then owes it. Empty everywhere else, including on a
	 * `review` `PASS` that walks to `ship`.
	 */
	| {readonly _tag: "HeadVerdicts"; readonly defers: ReadonlyArray<string>}
	/**
	 * A reviewer's park out of a review cell, which claims the run reached no verdict. It is the one
	 * negative claim here, so it is refused only by a still-binding `FAIL` and by nothing else — see
	 * {@link foldPark}.
	 */
	| {readonly _tag: "ParkUncontradicted"}
	| {readonly _tag: "RangeCommits"; readonly epic: number}
	/**
	 * `defers` is {@link Claim}'s one subtraction asked of a range instead of a head, and on this arm
	 * it is constant rather than routed — see {@link claimOf} for why a child's scope can hold no
	 * routed namespace's verdict at all.
	 */
	| {readonly _tag: "RangeVerdict"; readonly epic: number; readonly defers: ReadonlyArray<string>}
	| {readonly _tag: "None"; readonly why: string};

/**
 * What this event, recorded out of this leaf state in this role, asserts about the world.
 *
 * `next` is the leaf this event would land in, read off the caller's own machine — the one input
 * that decides whether the plain `review` cell may defer. It defers exactly when the event routes
 * into {@link REVIEW_UI_STATE}, so the subtraction and the routing are one fact rather than two:
 * a machine with no such arm (a `chore` workflow), or a `PASS` whose class flag never raised `ui`
 * and so walks straight to `ship`, defers nothing and stands on the whole derived set.
 *
 * **A child's `PASS` defers the routed set unconditionally, and `next` decides nothing there.** A
 * child opens no PR (ADR 0285) and every verb that may post a {@link ROUTED_NAMESPACES} verdict
 * resolves live PR state, so that namespace is unpostable at child scope by construction — the same
 * closed circle #6664 closed for the single lane, met at the other seam: requiring it of a child
 * demanded a verdict no cell of that child's region and no verb of this CLI could ever produce, and
 * every ui-bearing child deadlocked at exit 23 with no legal exit (#7041). The cell that owes it is
 * the epic's tail, and the bar moves there rather than down: one epic run is one branch and one PR
 * (ADR 0285), so every rendered file a child's range added is in the tail PR's own diff, where the
 * tail's `PASS` derives it, defers nothing and stands on the whole set at a head a preview exists
 * for. A child whose range renders nothing never derives the namespace at all, so the subtraction
 * takes nothing off its bar and its proof is byte-for-byte what it was. See ADR 0340 for why this
 * one deferral is a constant where ADR 0320 rules every other one derived from the machine.
 */
export const claimOf = (
	event: string,
	leaf: string,
	role: LaneRole,
	next: string | null = null,
): Claim => {
	const child = role._tag === "Child";
	if (event === "DONE" && leaf === BUILD_STATE) {
		return child ? {_tag: "RangeCommits", epic: role.epic} : {_tag: "OpenPull"};
	}
	if (event === "PASS" && leaf === REVIEW_STATE) {
		if (child) return {_tag: "RangeVerdict", epic: role.epic, defers: ROUTED_NAMESPACES};
		return {
			_tag: "HeadVerdicts",
			defers: next === REVIEW_UI_STATE ? ROUTED_NAMESPACES : [],
		};
	}
	if (event === "PASS" && leaf === REVIEW_UI_STATE && !child) {
		return {_tag: "HeadVerdicts", defers: []};
	}
	// A child's park has no PR to read, and its range verdicts are the other arm's read (#6112).
	if (event === "BLOCKED" && (leaf === REVIEW_STATE || leaf === REVIEW_UI_STATE) && !child) {
		return {_tag: "ParkUncontradicted"};
	}
	return {
		_tag: "None",
		why: `${event} out of "${leaf}" asserts no artifact — only DONE out of "${BUILD_STATE}", PASS out of "${REVIEW_STATE}" / "${REVIEW_UI_STATE}" and BLOCKED out of those two review cells do`,
	};
};

/**
 * The issue a task drives: the number an emitted region is named for — a child's `issue_<n>` or the
 * tail's `epic_<n>` — else the lane's own id.
 *
 * `null` where neither is a number — the proof has nothing to read, and a caller must say so rather
 * than pick a plausible issue.
 */
export const issueOf = (taskId: string, lane: string): number | null => {
	const region = /^(?:issue|epic)_(\d+)$/.exec(taskId);
	if (region?.[1] !== undefined) return Number.parseInt(region[1], 10);
	const key = lane.trim();
	return /^\d+$/.test(key) ? Number.parseInt(key, 10) : null;
};

/** One local branch, with the commits it adds over its own fork point already read off the tree. */
export interface BranchFact {
	readonly branch: string;
	/** Where this branch left the epic branch — the near end of the range, as an object name. */
	readonly base: string;
	/** The branch tip as an object name — what a range read is taken against, never the ref name. */
	readonly tip: string;
	/** Every message the range adds, whole. Empty where the branch adds nothing. */
	readonly messages: ReadonlyArray<string>;
	/**
	 * The other candidates' tips this branch's history already contains, as object names.
	 *
	 * Ancestry arrives as data so {@link traceRange} stays pure — the read itself is git's, taken
	 * once per pair by `locateRange` (`./range.ts`).
	 */
	readonly contains: ReadonlyArray<string>;
}

/**
 * The epic-side commit the merge that integrated `tip` joined it to — `null` where nothing did.
 *
 * A child lands on the assembly branch as `git merge --no-ff <child>` run *from* the epic branch, so
 * the child's tip is that merge's second parent and the epic branch as it stood is the first.
 * Reading the first parent — never merely "the parent that is not the tip" — is what keeps a branch
 * that was cut and never built on out of this arm: its tip IS an epic commit, so it turns up as some
 * later merge's *first* parent, and answering with that merge's second parent would hand back a
 * sibling's fork point and dress an empty range up as work.
 *
 * Oldest match wins: a tip merged twice still forked once, and the first landing is where.
 */
export const integratedFrom = (tip: string, rows: ReadonlyArray<ParentedCommit>): string | null => {
	let joined: string | null = null;
	// `rows` is newest-first, so the last match is the oldest merge that took this tip in.
	for (const row of rows) {
		const [first, ...rest] = row.parents;
		if (first === undefined || first === tip || !rest.includes(tip)) continue;
		joined = first;
	}
	return joined;
};

export type RangeTrace =
	| {
			readonly _tag: "One";
			readonly branch: string;
			/** Where the branch forked from the epic branch — the range's near end. */
			readonly base: string;
			readonly tip: string;
			/** Every commit the range adds — the artifact's size. */
			readonly commits: number;
			/** How many of those name this issue — the evidence the range is this child's. */
			readonly naming: number;
	  }
	| {readonly _tag: "None"; readonly why: string}
	| {readonly _tag: "Many"; readonly branches: ReadonlyArray<string>};

/**
 * The one range a child's `DONE` out of `build` stands on.
 *
 * A child opens no PR, so the artifact is the commits themselves — and a branch alone is not one: a
 * `build branch` that was cut and never built on adds nothing, and commits that name another issue
 * are another child's work sitting on a name this issue happens to match. Both are `None` with the
 * reason, because their remedies differ and an operator reading "absent" needs told which.
 *
 * Several branches carrying this child's commits is its own answer for the same reason
 * {@link tracePulls} keeps `Many`: which one the lane owns is not derivable here, and picking the
 * first records a `DONE` against a range nobody reviewed.
 *
 * The one exception is supersession, and it is derived rather than guessed: a repair round is a new
 * claim, so it is a new nonce, so it is a new branch name (`../build/lane.ts`), and the machine
 * budgets for repair rounds — every one of them used to wedge the lane at the ambiguous arm (#6049).
 * When exactly one candidate's history contains every other candidate's tip, that candidate is the
 * later round of the same work and it is the range. A genuine fork — no candidate containing all the
 * others, or two of them containing each other — stays `Many`.
 */
export const traceRange = (
	issue: number,
	base: string,
	facts: ReadonlyArray<BranchFact>,
): RangeTrace => {
	const carrying = facts.filter((fact) =>
		fact.messages.some((message) => issueRefsIn(message).includes(issue)),
	);
	const superseding = carrying.filter((fact, at) =>
		carrying.every((other, other_at) => other_at === at || fact.contains.includes(other.tip)),
	);
	const one =
		carrying.length === 1 ? carrying[0] : superseding.length === 1 ? superseding[0] : undefined;
	if (one !== undefined) {
		return {
			_tag: "One",
			branch: one.branch,
			base: one.base,
			tip: one.tip,
			commits: one.messages.length,
			naming: one.messages.filter((message) => issueRefsIn(message).includes(issue)).length,
		};
	}
	if (carrying.length > 0) return {_tag: "Many", branches: carrying.map((fact) => fact.branch)};
	const names = facts.map((fact) => fact.branch).join(", ");
	if (facts.length === 0) {
		return {
			_tag: "None",
			why: `no local branch in this tree was cut for #${issue}, so nothing was built here for ${base} to carry`,
		};
	}
	return facts.every((fact) => fact.messages.length === 0)
		? {
				_tag: "None",
				why: `${names} adds no commit over ${base} — the branch was cut and not built on`,
			}
		: {_tag: "None", why: `no commit ${names} adds over ${base} names #${issue}`};
};

/** One candidate pull request, read off the board rather than off the search row. */
export interface PullFact {
	readonly number: number;
	readonly open: boolean;
	/**
	 * Whether it merged. Not derivable from {@link open}: a merged PR and a rejected one both read
	 * closed, and the one park whose clearing case is a *landed* PR has to tell them apart (#6717).
	 */
	readonly merged: boolean;
	/**
	 * **Every** issue the body links, through the closing keywords or `Part of` — never the search
	 * term. Plural because an epic tail links one issue per landed child plus the epic itself, and a
	 * scalar field there can only ever report one of them (#6797).
	 */
	readonly linkedIssues: ReadonlyArray<number>;
	/**
	 * Which kind of reference {@link linkedIssues} came off — a closing keyword, or the explicit
	 * non-closing `Part of #N`. Only the closing kind discharges the issue on merge, so it is the one
	 * fact that tells a ship's `DONE` whether the lane it folds is finished (#7382).
	 */
	readonly linkKind: IssueRefs["kind"];
}

export type PullTrace =
	| {readonly _tag: "One"; readonly pr: number}
	| {readonly _tag: "None"; readonly why: string}
	| {readonly _tag: "Many"; readonly prs: ReadonlyArray<number>};

/**
 * The PR tracing to this issue, within the caller's scope.
 *
 * The search index only nominates; the trace is the body's own links, so a PR that merely mentions
 * the number in prose is not a proof of it. Several is its own answer — which one the lane owns is
 * not derivable here, and picking the first is how a lane records a DONE against another lane's PR.
 *
 * `None` carries its own reason for the same purpose `traceRange`'s does: "nothing was nominated"
 * and "candidates were read and every one linked elsewhere" have different remedies, and a refusal
 * saying the first of a board that shows the second is false of the board (#6797).
 */
export const tracePulls = (
	issue: number,
	facts: ReadonlyArray<PullFact>,
	scope: PullScope = "open",
): PullTrace => {
	const counts = (fact: PullFact): boolean =>
		fact.open || (scope === "open-or-merged" && fact.merged);
	const live = facts.filter(counts);
	const matched = live.filter((fact) => fact.linkedIssues.includes(issue));
	const first = matched[0];
	const noun = scope === "open" ? "open PR" : "open or merged PR";
	if (first === undefined) {
		if (facts.length === 0) return {_tag: "None", why: `no ${noun} links #${issue}`};
		const read = facts.map((fact) => `#${fact.number}`).join(", ");
		return live.length === 0
			? {
					_tag: "None",
					why: `read ${read} — every candidate has closed since it was nominated`,
				}
			: {_tag: "None", why: `read ${read} — no candidate's body links #${issue}`};
	}
	return matched.length === 1
		? {_tag: "One", pr: first.number}
		: {_tag: "Many", prs: matched.map((fact) => fact.number)};
};

/**
 * Whether the merge a shipped lane stands on discharged its issue, or landed part of it.
 *
 * `Partial` is the arm that diverts the lane, and it is taken on positive evidence alone: a merged
 * PR reaching this issue through `Part of #N` and through no closing keyword. Everything else — a
 * closing merge, merges that link elsewhere, nothing nominated — answers `Closes`, which is what the
 * machine did before this read existed, so the closing path cannot move on a read that saw less than
 * it hoped. A read that *failed* is neither: the nominator answers `Unreadable` and never reaches
 * here, so an unread board refuses the event rather than folding the lane on a guess.
 *
 * Several merged partials answer `Partial` together where {@link tracePulls} would answer `Many`.
 * That arm exists there because picking one PR out of several is not derivable; here nothing is
 * picked — every candidate says the same thing about the issue.
 */
export type Closure =
	| {readonly _tag: "Closes"; readonly why: string}
	| {readonly _tag: "Partial"; readonly prs: ReadonlyArray<number>};

export const traceClosure = (issue: number, facts: ReadonlyArray<PullFact>): Closure => {
	const landed = facts.filter((fact) => fact.merged && fact.linkedIssues.includes(issue));
	if (landed.length === 0) return {_tag: "Closes", why: `no merged PR's body links #${issue}`};
	const closing = landed.filter((fact) => fact.linkKind === "fixes");
	return closing.length > 0
		? {
				_tag: "Closes",
				why: `${closing.map((fact) => `#${fact.number}`).join(", ")} closes #${issue} on merge`,
			}
		: {_tag: "Partial", prs: landed.map((fact) => fact.number)};
};

/** One comment on the driven issue, as much of it as the diagnosis question needs. */
export interface CommentFact {
	readonly id: number;
	readonly createdAt: string;
}

export type Diagnosis =
	| {readonly _tag: "Posted"; readonly commentId: number}
	| {readonly _tag: "Absent"; readonly why: string};

/**
 * The no-PR arm: `build`'s `SUCCESS-NO-PR`, proven rather than taken on the spawn's word.
 *
 * That terminal is legal only for a `type:investigation`, and its deliverable is a diagnosis posted
 * with `build note` — so the two artifacts are the label and a comment written **after** the task
 * entered build. Without the recency the issue's own triage comment would prove a diagnosis nobody
 * wrote; `since` is the log's own timestamp for the event that moved the task here.
 */
export const traceDiagnosis = (
	issue: number,
	labels: ReadonlyArray<string>,
	comments: ReadonlyArray<CommentFact>,
	since: string | null,
): Diagnosis => {
	if (!labels.includes(INVESTIGATION_LABEL)) {
		return {
			_tag: "Absent",
			why: `#${issue} does not carry ${INVESTIGATION_LABEL}, so a no-PR outcome is not one it may have`,
		};
	}
	const posted = comments.filter((comment) => since === null || comment.createdAt > since);
	const latest = posted.at(-1);
	return latest === undefined
		? {
				_tag: "Absent",
				why: `#${issue} carries no comment written since the task entered ${BUILD_STATE}${since === null ? "" : ` at ${since}`}, so no diagnosis was posted`,
			}
		: {_tag: "Posted", commentId: latest.id};
};

/** One claim in force for a namespace, already ordered by the caller. */
export interface VerdictFact {
	readonly namespace: string;
	/**
	 * `ROUTED` is a `routed-elsewhere` record rather than a verdict, so it borrows neither
	 * polarity — folding it into `PASS` would ship "I judged nothing" as "I judged it and it
	 * passed" (ADR 0316).
	 */
	readonly polarity: "PASS" | "FAIL" | "ROUTED";
	/** Whether the claim still binds this head — head equality, or the content it bound (ADR 0276). */
	readonly binding: "current" | "stale" | "unknown";
	readonly commentId: number;
}

export type NamespaceState = "pass" | "fail" | "absent" | "stale" | "unknown" | "routed";

export interface NamespaceRow {
	readonly namespace: string;
	readonly state: NamespaceState;
	readonly commentId: number | null;
}

const stateOf = (verdict: VerdictFact | undefined): NamespaceState => {
	if (verdict === undefined) return "absent";
	if (verdict.binding === "stale") return "stale";
	if (verdict.binding === "unknown") return "unknown";
	// The binding question is asked first, so a route at a head this claim no longer binds rows
	// `stale` exactly as a verdict does — a route that survived a push would attest a tree nobody read.
	if (verdict.polarity === "ROUTED") return "routed";
	return verdict.polarity === "PASS" ? "pass" : "fail";
};

/** Every required namespace's state at this head, in the required order — never only the present. */
export const judgeVerdicts = (
	required: ReadonlyArray<string>,
	inForce: ReadonlyArray<VerdictFact>,
): ReadonlyArray<NamespaceRow> =>
	required.map((namespace) => {
		const verdict = inForce.find((row) => row.namespace === namespace);
		return {namespace, state: stateOf(verdict), commentId: verdict?.commentId ?? null};
	});

export type Proof =
	| {readonly _tag: "Proven"; readonly note: string}
	| {readonly _tag: "Absent"; readonly what: string}
	| {readonly _tag: "InFlight"; readonly what: string}
	| {readonly _tag: "Contradicted"; readonly what: string}
	| {readonly _tag: "Ambiguous"; readonly what: string};

/**
 * Fold the namespace rows into the one verdict a `PASS` claim earns.
 *
 * The three refusals stay apart because their remedies are opposite: a `fail` at the head says
 * record `FAIL` instead, an `absent`/`stale`/`unknown` says the read is incomplete — re-read and
 * record nothing, which is exactly the in-flight refusal `operate` states in prose.
 *
 * `subject` is what the verdicts were read on — `#<pr>` for a PR-scoped read, the child's range for
 * a range-scoped one. One fold serves both, so the bar a child's review must clear cannot drift
 * from the bar the tail's does. That is also why the strings say "still binds" rather than
 * "current-head": a range has no head, and only the caller knows which binding it asked for.
 *
 * `routed` satisfies beside `pass`, and for `ship gate`'s reason (`../ship/gate-verb.ts`): the
 * question is whether every required namespace has answered, and "this diff is not mine to judge"
 * is an answer — the one `review-ui`'s evidence-required emit path cannot give for a diff that
 * renders nothing (ADR 0316). Without it a lane that ships clean stalls here forever, because no
 * further work can fill the namespace.
 */
export const foldNamespaces = (rows: ReadonlyArray<NamespaceRow>, subject: string): Proof => {
	const failed = rows.filter((row) => row.state === "fail");
	if (failed.length > 0) {
		return {
			_tag: "Contradicted",
			what: `${subject} holds a FAIL that still binds in ${failed.map((row) => row.namespace).join(", ")} — the artifact says FAIL, so PASS is not the event this outcome earns`,
		};
	}
	const pending = rows.filter((row) => row.state !== "pass" && row.state !== "routed");
	if (pending.length > 0) {
		return {
			_tag: "InFlight",
			what: `${subject} has no verdict that still binds in ${pending.map((row) => `${row.namespace} (${row.state})`).join(", ")} — the review is not finished, so nothing is recorded`,
		};
	}
	return {
		_tag: "Proven",
		note: `every derived namespace has answered on ${subject}: ${rows.map((row) => `${row.namespace} (${row.state})`).join(", ")}`,
	};
};

/**
 * Fold the namespace rows into the one verdict a reviewer's **park** earns — one `FAIL` refuses it,
 * everything else lets it through (ADR 0329, #6112).
 *
 * A park says "this run reached no verdict", and only one row can say otherwise: a `FAIL` that still
 * binds. An `absent` or `stale` row cannot, because that is the very state a run parks in the middle
 * of, and a `pass` row cannot either — the reviewer's own precedence is that an unseen input blocks
 * `PASS` and never `FAIL`, so a namespace that passed beside an unreadable one still parks.
 *
 * The asymmetry with {@link foldNamespaces} is the point: a `PASS` must clear a floor, a park must
 * only survive a contradiction. Nothing here is an "is the review finished" test, so a park is never
 * held for a namespace nobody has judged yet.
 */
export const foldPark = (rows: ReadonlyArray<NamespaceRow>, subject: string): Proof => {
	const failed = rows.filter((row) => row.state === "fail");
	if (failed.length > 0) {
		return {
			_tag: "Contradicted",
			what: `${subject} holds a FAIL that still binds in ${failed.map((row) => row.namespace).join(", ")} — the run reached a verdict, so its terminal is that FAIL and not a park`,
		};
	}
	return {
		_tag: "Proven",
		note: `no verdict on ${subject} contradicts the park: ${rows.length === 0 ? "no derived namespace holds one" : rows.map((row) => `${row.namespace} (${row.state})`).join(", ")}`,
	};
};
