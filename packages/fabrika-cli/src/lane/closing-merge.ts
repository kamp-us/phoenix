/**
 * What a closing merge left its issue as — the pure half of the issue read-back `lane report` takes
 * after a ship-stage `DONE`.
 *
 * A merged `Fixes #N` is not proof that #N closed. Merge-queue merges have left the issue open, and
 * reading "the body says Fixes" as "the issue is closed" folded those lanes to `complete` over open
 * issues. So once the closure read answers `Closes`, the issue itself is read, and this module
 * judges that read. The read and the close are the verbs'; this reads no board and writes nothing.
 *
 * Three answers, never two: `Open` is the one `lane report` acts on, `Closed` is left alone, and
 * `Unread` is recorded as unread rather than folded into either — a read that failed says nothing
 * about the issue.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10272
 */
import {Effect} from "effect";
import type {Existence} from "../io/issues.ts";

/** The part of one issue read this judgement stands on. */
export type IssueRead = Existence<{readonly state: string; readonly isPullRequest: boolean}>;

export type IssueState =
	| {readonly _tag: "Open"}
	| {readonly _tag: "Closed"}
	| {readonly _tag: "Unread"; readonly reason: string};

/**
 * The state one issue read proves. A pull request on the issue's number, an absent issue and a
 * state this reader does not know are all `Unread`: none of them says the issue is closed.
 */
export const issueStateOf = (issue: number, read: IssueRead): IssueState => {
	if (read._tag === "Unknown")
		return {_tag: "Unread", reason: `cannot read #${issue}: ${read.reason}`};
	if (read._tag === "Absent") return {_tag: "Unread", reason: `#${issue} is not there`};
	if (read.value.isPullRequest) {
		return {_tag: "Unread", reason: `#${issue} is a pull request, not an issue`};
	}
	if (read.value.state === "open") return {_tag: "Open"};
	if (read.value.state === "closed") return {_tag: "Closed"};
	return {_tag: "Unread", reason: `#${issue} reads state "${read.value.state}"`};
};

export type ClosingMerge =
	| {readonly _tag: "Closed"; readonly issue: number}
	| {readonly _tag: "Open"; readonly issue: number; readonly merged: ReadonlyArray<number>}
	| {readonly _tag: "Unread"; readonly issue: number; readonly reason: string};

export type OpenMerge = Extract<ClosingMerge, {readonly _tag: "Open"}>;

/** Judge the issue a closing merge named, off one read of it. `merged` is the closing PRs. */
export const judgeClosingMerge = (
	issue: number,
	merged: ReadonlyArray<number>,
	read: IssueRead,
): ClosingMerge => {
	const state = issueStateOf(issue, read);
	switch (state._tag) {
		case "Open":
			return {_tag: "Open", issue, merged};
		case "Closed":
			return {_tag: "Closed", issue};
		case "Unread":
			return {_tag: "Unread", issue, reason: state.reason};
	}
};

/**
 * What the ledger line says about the issue after a closing merge — the `issueClose` field.
 *
 * `already-closed` and `closed-by-lane` are the two ways the issue ended closed, kept apart so a
 * later reader can tell "the board closed it" from "the lane had to". `close-failed` and `unread`
 * are the two ways it did not provably end closed, and neither reads as a plain `complete`.
 */
export const ISSUE_CLOSES = ["already-closed", "closed-by-lane", "close-failed", "unread"] as const;

export type IssueClose = (typeof ISSUE_CLOSES)[number];

export const isIssueClose = (value: unknown): value is IssueClose =>
	typeof value === "string" && (ISSUE_CLOSES as ReadonlyArray<string>).includes(value);

/** What closing an open issue did. */
export type CloseAct =
	| {readonly _tag: "Closed"}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface SettledClose {
	readonly close: IssueClose;
	readonly note: string;
}

/** The comment the lane posts on an issue it closes itself, naming the merged PRs by URL. */
export const closeComment = (issue: number, pulls: ReadonlyArray<string>): string =>
	`${pulls.join(", ")} merged with a closing keyword for #${issue}, and #${issue} was still open afterwards, so \`fabrika lane report\` closed it as completed.`;

/**
 * Act on a closing merge's judgement: close an `Open` issue through `close`, and leave every other
 * answer untouched. Only `Open` reaches `close`, so an issue already closed is never written to.
 */
export const settleClosingMerge = <R>(
	merge: ClosingMerge,
	close: (open: OpenMerge) => Effect.Effect<CloseAct, never, R>,
): Effect.Effect<SettledClose, never, R> => {
	switch (merge._tag) {
		case "Closed":
			return Effect.succeed({
				close: "already-closed",
				note: `#${merge.issue} is already closed, so nothing was written to it.`,
			});
		case "Unread":
			return Effect.succeed({
				close: "unread",
				note: `${merge.reason}, so whether #${merge.issue} closed is UNKNOWN — the line records \`issueClose: unread\`, and \`lane record\` will not post a complete record over it while it reads open.`,
			});
		case "Open":
			return Effect.map(
				close(merge),
				(act): SettledClose =>
					act._tag === "Closed"
						? {
								close: "closed-by-lane",
								note: `#${merge.issue} was still open after its closing merge, so this lane closed it as completed with a pointer to the merge.`,
							}
						: {
								close: "close-failed",
								note: `#${merge.issue} was still open after its closing merge and closing it failed: ${act.reason} — the line records \`issueClose: close-failed\`; close #${merge.issue} by hand.`,
							},
			);
	}
};
