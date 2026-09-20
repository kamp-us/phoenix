/**
 * The one read behind `review post`'s `18`: did this very round route a finding into the contract?
 *
 * A reviewer that finds an in-scope defect appends it as an acceptance criterion, and that row binds
 * the **next** cycle. A `PASS` has no next cycle — the lane folds to `ship`, the PR merges and the
 * issue auto-closes — so the pair "append on round K, `PASS` on round K" destroys the finding
 * silently, with an artifact left behind that reads as perfectly correct. It has happened: four
 * `PASS` verdicts, a criterion appended on the same round, the queue merging inside twelve minutes,
 * and the regression that criterion named surviving only because a human happened to be told about
 * it in prose.
 *
 * The round is the whole discrimination. A row appended on round 1 is *supposed* to be standing
 * unmet when round 2's `PASS` lands — that is what "binds the next cycle" means — so this read keys
 * on the tag's own round and its own subject, and nothing else. Both come off
 * {@link readProvenanceTag}, the reader that sits beside the writer, so there is no second copy of
 * the grammar to drift.
 *
 * **An unreadable answer is never "no appended criterion".** A body that could not be fetched and a
 * criteria block that drifted are both states in which a routed row may be sitting there unseen, so
 * they resolve to {@link Unreadable} and the post refuses on `11`. A block that is *absent* is the
 * one negative that is proven: `review append-criterion` refuses an issue carrying no conforming
 * block, so no row can have been appended under one that does not exist.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	type CriterionProvenance,
	readProvenanceTag,
	sameSubject,
	withoutProvenanceTag,
} from "./append.ts";

/** What one issue body says about rows routed from this subject's round. */
export type BodyRead =
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<string>}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The criteria on `body` that were appended from `provenance`'s round `round`, as the reviewer
 * wrote them — tag stripped, because the tag is machinery and the refusal quotes a sentence.
 */
export const rowsAppendedOn = (
	body: string,
	provenance: CriterionProvenance,
	round: number,
): BodyRead => {
	const block = readCriteria(body);
	if (block._tag === "Absent") return {_tag: "Rows", rows: []};
	if (block._tag !== "Found") {
		return {
			_tag: "Unreadable",
			reason: `the acceptance-criteria block is malformed: ${block.reason}`,
		};
	}
	const rows = block.value.flatMap((criterion) => {
		const routed = readProvenanceTag(criterion.text);
		return routed !== null && routed.round === round && sameSubject(routed.provenance, provenance)
			? [withoutProvenanceTag(criterion.text)]
			: [];
	});
	return {_tag: "Rows", rows};
};

/** What the issues this verdict's subject is about say about rows routed from this round. */
export type AppendedRead =
	/** Proven: not one of the issues read carries a row tagged for this subject and this round. */
	| {readonly _tag: "None"}
	/** This round routed a finding into `issue`'s contract, and these are the rows it wrote. */
	| {
			readonly _tag: "Appended";
			readonly issue: number;
			readonly rows: ReadonlyArray<string>;
	  }
	/** A read that could not be completed — never collapsed into {@link None}. */
	| {readonly _tag: "Unreadable"; readonly issue: number; readonly reason: string};

/**
 * Read every issue in `issues` for a row this round routed, stopping at the first that carries one.
 *
 * `issues` is a set rather than a number because a PR body names its issue in more than one way — a
 * closing keyword, `Part of #N`, an epic tail's one reference per landed child — and a reviewer
 * appends to whichever one the round was graded against. Taking only the first closing target is how
 * a `--partial` PR's routed row would be invisible to the gate that has to see it.
 */
export const appendedThisRound = (
	repo: string,
	issues: ReadonlyArray<number>,
	provenance: CriterionProvenance,
	round: number,
): Effect.Effect<AppendedRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		for (const issue of issues) {
			const found = yield* getIssue(repo, issue);
			if (found._tag === "Unknown") {
				return {_tag: "Unreadable" as const, issue, reason: found.reason};
			}
			// A 404 is a fact about the repository: an issue that is not there carries no row.
			if (found._tag === "Absent") continue;
			const read = rowsAppendedOn(found.value.body, provenance, round);
			if (read._tag === "Unreadable") {
				return {_tag: "Unreadable" as const, issue, reason: read.reason};
			}
			if (read.rows.length > 0) {
				return {_tag: "Appended" as const, issue, rows: read.rows};
			}
		}
		return {_tag: "None" as const};
	});
