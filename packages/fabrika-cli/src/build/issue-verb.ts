/**
 * `build issue` — the claimed issue's body and its parsed acceptance criteria, through the content
 * gate. The single door an issue read comes through, so a trust ruling lands in one place.
 *
 * The criteria arrive from the **imported** `acceptance-criteria` wire read and keep its three answers
 * as positive tokens. `found`, `absent` and `malformed` are three different facts and this verb
 * transports them rather than flattening them: a heading that drifted by one character is a *defect*
 * the skill must surface, and folding it into "absent" is how a gate comes to grade a PR over nothing
 * (#4735's class).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {contentOf, gate} from "./content-gate.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

const VERB = "build issue";

export interface IssueOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The wire read's three arms, as the tokens and payload stdout carries. */
const criteriaOf = (
	body: string,
):
	| {readonly state: "found"; readonly items: ReadonlyArray<{text: string; checked: boolean}>}
	| {readonly state: "absent"; readonly reason: string}
	| {readonly state: "malformed"; readonly reason: string} => {
	const read = readCriteria(body);
	if (read._tag === "Found") {
		return {
			state: "found",
			items: read.value.map((criterion) => ({text: criterion.text, checked: criterion.checked})),
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
		return answer(
			JSON.stringify({
				number,
				title: target.issue.title,
				state: target.issue.state,
				labels: target.issue.labels,
				body,
				criteria,
			}),
			[
				`${VERB}: read #${number} in ${resolved.repo}; acceptance criteria ${criteria.state}${
					criteria.state === "found" ? ` (${criteria.items.length} row(s))` : `: ${criteria.reason}`
				}.`,
			],
		);
	});
