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
 * **Two events carry a claim; the other four carry none.** `DONE` out of a `build` state asserts the
 * work exists, `PASS` out of a `review` state asserts every derived namespace judged it. A
 * `BLOCKED`, a `WIP`, an `UNBLOCKED`, a `FAIL`, a `DONE` out of `ship` or a `DONE` out of a child's
 * `integrate` asserts nothing a read could falsify — those answer {@link Claim} `None`, so a caller
 * may prove *every* event and still only pay for the two that can lie.
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

/** The branch grammar's own reader, re-exported so this module's callers take one derivation. */
export {childLaneBranches} from "../build/lane.ts";

/** The leaf state a builder runs in — a `DONE` out of it claims the built work exists. */
export const BUILD_STATE = "build";

/** The leaf state a reviewer runs in — a `PASS` out of it claims a verdict that still binds. */
export const REVIEW_STATE = "review";

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
	| {readonly _tag: "HeadVerdicts"}
	| {readonly _tag: "RangeCommits"; readonly epic: number}
	| {readonly _tag: "RangeVerdict"; readonly epic: number}
	| {readonly _tag: "None"; readonly why: string};

/** What this event, recorded out of this leaf state in this role, asserts about the world. */
export const claimOf = (event: string, leaf: string, role: LaneRole): Claim => {
	const child = role._tag === "Child";
	if (event === "DONE" && leaf === BUILD_STATE) {
		return child ? {_tag: "RangeCommits", epic: role.epic} : {_tag: "OpenPull"};
	}
	if (event === "PASS" && leaf === REVIEW_STATE) {
		return child ? {_tag: "RangeVerdict", epic: role.epic} : {_tag: "HeadVerdicts"};
	}
	return {
		_tag: "None",
		why: `${event} out of "${leaf}" asserts no artifact — only DONE out of "${BUILD_STATE}" and PASS out of "${REVIEW_STATE}" do`,
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
 */
export const traceRange = (
	issue: number,
	base: string,
	facts: ReadonlyArray<BranchFact>,
): RangeTrace => {
	const carrying = facts.filter((fact) =>
		fact.messages.some((message) => issueRefsIn(message).includes(issue)),
	);
	const [first] = carrying;
	if (first !== undefined) {
		return carrying.length === 1
			? {
					_tag: "One",
					branch: first.branch,
					base: first.base,
					tip: first.tip,
					commits: first.messages.length,
					naming: first.messages.filter((message) => issueRefsIn(message).includes(issue)).length,
				}
			: {_tag: "Many", branches: carrying.map((fact) => fact.branch)};
	}
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
	/** The issue the body links, through the closing keyword or `Part of` — never the search term. */
	readonly linkedIssue: number | null;
}

export type PullTrace =
	| {readonly _tag: "One"; readonly pr: number}
	| {readonly _tag: "None"}
	| {readonly _tag: "Many"; readonly prs: ReadonlyArray<number>};

/**
 * The open PR tracing to this issue.
 *
 * The search index only nominates; the trace is the body's own link, so a PR that merely mentions
 * the number in prose is not a proof of it. Several is its own answer — which one the lane owns is
 * not derivable here, and picking the first is how a lane records a DONE against another lane's PR.
 */
export const tracePulls = (issue: number, facts: ReadonlyArray<PullFact>): PullTrace => {
	const matched = facts.filter((fact) => fact.open && fact.linkedIssue === issue);
	const first = matched[0];
	if (first === undefined) return {_tag: "None"};
	return matched.length === 1
		? {_tag: "One", pr: first.number}
		: {_tag: "Many", prs: matched.map((fact) => fact.number)};
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
