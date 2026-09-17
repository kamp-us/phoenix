/**
 * The one read behind `review post`'s `19`: does this verdict name the evidence its marked criteria
 * rest on?
 *
 * A criterion carrying the outside-diff evidence marker (`../wire/acceptance-criteria.ts`) says out
 * loud that the diff's bytes cannot settle it either way — a checkpoint written before the fix, a
 * desk verified by hand, a runtime observation. Before the marker existed the grader had exactly one
 * rule and applied it to every row, so such a criterion read as undischarged and undischarged read
 * as FAIL: one adjudicated-clean PR drew three FAILs in a row on a single criterion of that shape,
 * at temperature 0.0 over byte-identical input.
 *
 * The marker fixes the polarity, and this read is what keeps the fix honest. A marked criterion is
 * graded **on the evidence it names**, so a PASS owes the reader which evidence it rested on; a PASS
 * that names none has graded the criterion on nothing at all, which is the same hole pointing the
 * other way. So the two answers are the whole design: evidence named is a `Pass`, evidence unnamed
 * is a `Fail` that quotes the criterion and the source it pointed at.
 *
 * **"Names" is a substring, deliberately, and it is the reviewer's claim rather than a proof.** No
 * verb can reach a hand-verification on a real desk, and one that pretended to would be inventing
 * the very evidence at issue. What is mechanical here is that the verdict body *cites* the source
 * the contract named — enough that a human reading the merge record can follow it, and enough that
 * a PASS which never considered the criterion cannot pass silently.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9200
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import type {
	AcceptanceCriterion,
	CriterionText,
	EvidenceSource,
} from "../wire/acceptance-criteria.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";

/** One criterion the contract marked, and the source it named. */
export interface MarkedCriterion {
	readonly text: CriterionText;
	readonly evidence: EvidenceSource;
}

/** Every criterion carrying the outside-diff evidence marker, in contract order. */
export const marked = (
	criteria: ReadonlyArray<AcceptanceCriterion>,
): ReadonlyArray<MarkedCriterion> =>
	criteria.flatMap((criterion) =>
		criterion.evidence === null ? [] : [{text: criterion.text, evidence: criterion.evidence}],
	);

/**
 * What a verdict body says about the marked criteria it is the terminal of.
 *
 * `Pass` carries the criteria whose evidence the body named, so a caller can say which evidence the
 * verdict rested on rather than only that it rested on some.
 */
export type EvidenceGrade =
	| {readonly _tag: "Pass"; readonly named: ReadonlyArray<MarkedCriterion>}
	| {
			readonly _tag: "Fail";
			readonly missing: ReadonlyArray<MarkedCriterion>;
			readonly named: ReadonlyArray<MarkedCriterion>;
	  };

/**
 * Whitespace-collapsed and case-folded, so a source wrapped across two lines in the verdict body
 * still matches the one written on a single line in the contract. Neither side's line breaks are a
 * fact about the evidence.
 */
const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Does `body` cite `source`? */
export const namesEvidence = (body: string, source: string): boolean =>
	fold(body).includes(fold(source));

/**
 * Grade a contract's marked criteria against the verdict body that is about to carry them.
 *
 * A contract with no marked criterion grades `Pass` with nothing named — the unmarked rows keep
 * today's rule, and this read has no opinion about them.
 */
export const gradeEvidence = (
	criteria: ReadonlyArray<AcceptanceCriterion>,
	verdictBody: string,
): EvidenceGrade => {
	const rows = marked(criteria);
	const named = rows.filter((row) => namesEvidence(verdictBody, row.evidence));
	const missing = rows.filter((row) => !namesEvidence(verdictBody, row.evidence));
	return missing.length === 0 ? {_tag: "Pass", named} : {_tag: "Fail", missing, named};
};

/** One `  - "<criterion>" — evidence: <source>` line per row, for a refusal that has to quote them. */
export const quoteRows = (rows: ReadonlyArray<MarkedCriterion>): string =>
	rows.map((row) => `  - "${row.text}" — evidence: ${row.evidence}`).join("\n");

/** What the issues this verdict is about say about evidence the body still owes. */
export type OwedRead =
	/** Proven: every marked criterion on every issue read is named in the body. */
	| {readonly _tag: "None"}
	/** `issue`'s contract marks criteria this body cites no evidence for. */
	| {
			readonly _tag: "Unnamed";
			readonly issue: number;
			readonly missing: ReadonlyArray<MarkedCriterion>;
	  }
	/** A read that could not be completed — never collapsed into {@link None}. */
	| {readonly _tag: "Unreadable"; readonly issue: number; readonly reason: string};

/**
 * Read every issue in `issues` for a marked criterion this body names no evidence for, stopping at
 * the first that carries one.
 *
 * **An unreadable answer is never "no marked criterion".** A body that could not be fetched and a
 * criteria block that drifted are both states in which a marked row may be sitting there unseen, so
 * both resolve to {@link OwedRead} `Unreadable` and the post refuses on `11`. A block that is
 * *absent* is the one negative that is proven: there is no contract, so there is no marker in it.
 *
 * `issues` is a set for the same reason `./appended-this-round.ts`'s is: a PR body names its issue
 * through a closing keyword, through `Part of #N`, and through an epic tail's one reference per
 * landed child, and the marked criterion may sit on any of them.
 */
export const evidenceOwed = (
	repo: string,
	issues: ReadonlyArray<number>,
	verdictBody: string,
): Effect.Effect<OwedRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		for (const issue of issues) {
			const found = yield* getIssue(repo, issue);
			if (found._tag === "Unknown") {
				return {_tag: "Unreadable" as const, issue, reason: found.reason};
			}
			// A 404 is a fact about the repository: an issue that is not there carries no contract.
			if (found._tag === "Absent") continue;
			const block = readCriteria(found.value.body);
			if (block._tag === "Malformed") {
				return {
					_tag: "Unreadable" as const,
					issue,
					reason: `the acceptance-criteria block is malformed: ${block.reason}`,
				};
			}
			if (block._tag === "Absent") continue;
			const grade = gradeEvidence(block.value, verdictBody);
			if (grade._tag === "Fail") {
				return {_tag: "Unnamed" as const, issue, missing: grade.missing};
			}
		}
		return {_tag: "None" as const};
	});
