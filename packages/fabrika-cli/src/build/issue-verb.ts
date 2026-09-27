/**
 * `build issue` — the claimed issue's body and its parsed acceptance criteria, through the content
 * gate. The single door an issue read comes through, so a trust ruling lands in one place.
 *
 * The imported acceptance-criteria reader distinguishes a malformed heading from an absent one.
 * Flattening that distinction could let a gate grade a PR with no criteria.
 * Outside-diff evidence stays attached to its criterion so builders know what proof to produce.
 * @ruling https://github.com/kamp-us/phoenix/issues/9301
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {marked, quoteRows} from "../review/outside-diff-evidence.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import type {AcceptanceCriterion} from "../wire/acceptance-criteria.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {contentOf, gate} from "./content-gate.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

const VERB = "build issue";

export interface IssueOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const criteriaOf = (
	body: string,
):
	| {readonly state: "found"; readonly items: ReadonlyArray<AcceptanceCriterion>}
	| {readonly state: "absent"; readonly reason: string}
	| {readonly state: "malformed"; readonly reason: string} => {
	const read = readCriteria(body);
	if (read._tag === "Found") {
		return {
			state: "found",
			items: read.value.map(({text, checked, evidence}) => ({text, checked, evidence})),
		};
	}
	return read._tag === "Absent"
		? {state: "absent", reason: read.reason}
		: {state: "malformed", reason: read.reason};
};

export const runIssue = (
	options: IssueOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const target = yield* openIssue(
			VERB,
			resolved.repo,
			number,
			(reason) => `${VERB}: cannot read #${number}: ${reason} — its content is UNKNOWN.`,
		);
		if (target._tag === "Refused") return target.outcome;

		const body = contentOf(gate("issue-body", `#${number}`, target.issue.body));
		const criteria = criteriaOf(body);
		const diagnostics = [
			`${VERB}: read #${number} in ${resolved.repo}; acceptance criteria ${criteria.state}${
				criteria.state === "found" ? ` (${criteria.items.length} row(s))` : `: ${criteria.reason}`
			}.`,
		];
		const markedRows = criteria.state === "found" ? marked(criteria.items) : [];
		if (criteria.state === "found" && markedRows.length > 0) {
			diagnostics.push(
				`${VERB}: ${markedRows.length} of ${criteria.items.length} criteria mark evidence outside the diff — write that evidence into the PR body, because the reviewer's PASS is refused unless it cites the source:`,
				quoteRows(markedRows),
			);
		}
		return answer(
			JSON.stringify({
				number,
				title: target.issue.title,
				state: target.issue.state,
				labels: target.issue.labels,
				body,
				criteria,
			}),
			diagnostics,
		);
	});
