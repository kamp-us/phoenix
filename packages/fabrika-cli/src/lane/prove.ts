/**
 * The proof core — what a lane event claims about the world, and whether the world says it.
 *
 * The retired epic conductor moved on the git graph rather than on its own report. A lane operator
 * owns no branch, so the artifact a lane event claims lives on the board:
 * an open PR tracing to the task's issue, a verdict at that PR's head. Everything here is the pure
 * half — facts in, one verdict out — so the whole table is testable without a network.
 *
 * **Two events carry a claim; the other four carry none.** `DONE` out of a `build` state asserts a
 * PR exists, `PASS` out of a `review` state asserts every derived namespace judged this head. A
 * `BLOCKED`, a `WIP`, an `UNBLOCKED`, a `FAIL`, or a `DONE` out of `ship` asserts nothing a board
 * read could falsify — those answer {@link Claim} `None`, so a caller may prove *every* event and
 * still only pay for the two that can lie.
 *
 * The state names are the shipped templates' (`./templates/coder.workflow.json` and the regions
 * `./emit.ts` renders). A machine that renames them derives no claim and says so, which keeps a
 * foreign workflow routable instead of refused.
 */

/** The leaf state a builder runs in — a `DONE` out of it claims a PR. */
export const BUILD_STATE = "build";

/** The leaf state a reviewer runs in — a `PASS` out of it claims current-head verdicts. */
export const REVIEW_STATE = "review";

/** The label a no-PR builder outcome is only legal under (`build`'s `SUCCESS-NO-PR`). */
export const INVESTIGATION_LABEL = "type:investigation";

export type Claim =
	| {readonly _tag: "OpenPull"}
	| {readonly _tag: "HeadVerdicts"}
	| {readonly _tag: "None"; readonly why: string};

/** What this event, recorded out of this leaf state, asserts about the board. */
export const claimOf = (event: string, leaf: string): Claim => {
	if (event === "DONE" && leaf === BUILD_STATE) return {_tag: "OpenPull"};
	if (event === "PASS" && leaf === REVIEW_STATE) return {_tag: "HeadVerdicts"};
	return {
		_tag: "None",
		why: `${event} out of "${leaf}" asserts no board artifact — only DONE out of "${BUILD_STATE}" and PASS out of "${REVIEW_STATE}" do`,
	};
};

/**
 * The issue a task drives: the child number an emitted region is named for, else the lane's own id.
 *
 * `null` where neither is a number — the proof has nothing to read, and a caller must say so rather
 * than pick a plausible issue.
 */
export const issueOf = (taskId: string, lane: string): number | null => {
	const region = /^issue_(\d+)$/.exec(taskId);
	if (region?.[1] !== undefined) return Number.parseInt(region[1], 10);
	return /^\d+$/.test(lane) ? Number.parseInt(lane, 10) : null;
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

/** One verdict claim in force for a namespace, already ordered by the caller. */
export interface VerdictFact {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL";
	/** Whether the claim still binds this head — head equality, or the content it bound (ADR 0276). */
	readonly binding: "current" | "stale" | "unknown";
	readonly commentId: number;
}

export type NamespaceState = "pass" | "fail" | "absent" | "stale" | "unknown";

export interface NamespaceRow {
	readonly namespace: string;
	readonly state: NamespaceState;
	readonly commentId: number | null;
}

const stateOf = (verdict: VerdictFact | undefined): NamespaceState => {
	if (verdict === undefined) return "absent";
	if (verdict.binding === "stale") return "stale";
	if (verdict.binding === "unknown") return "unknown";
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
 */
export const foldNamespaces = (rows: ReadonlyArray<NamespaceRow>, pr: number): Proof => {
	const failed = rows.filter((row) => row.state === "fail");
	if (failed.length > 0) {
		return {
			_tag: "Contradicted",
			what: `#${pr} holds a current-head FAIL in ${failed.map((row) => row.namespace).join(", ")} — the artifact says FAIL, so PASS is not the event this outcome earns`,
		};
	}
	const pending = rows.filter((row) => row.state !== "pass");
	if (pending.length > 0) {
		return {
			_tag: "InFlight",
			what: `#${pr} has no current-head verdict in ${pending.map((row) => `${row.namespace} (${row.state})`).join(", ")} — the review is not finished, so nothing is recorded`,
		};
	}
	return {
		_tag: "Proven",
		note: `every derived namespace holds a current-head PASS on #${pr}: ${rows.map((row) => row.namespace).join(", ")}`,
	};
};
