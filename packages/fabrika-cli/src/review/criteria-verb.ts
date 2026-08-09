/**
 * `review criteria` — the linked issue's acceptance-criteria block, read through the registered
 * `acceptance-criteria` wire format.
 *
 * The verb fetches the body and hands it to the format's own `read`; there is **no second parser**
 * (`../wire/acceptance-criteria.ts`, imported). A drifted heading therefore reds as `Malformed`
 * rather than reading as "there were none" — the wire module's discrimination carried to the fetch
 * seam.
 *
 * An issue's open/closed state is deliberately not a precondition, asymmetric with
 * `review append-criterion`: reading the contract off a closed issue is a legitimate re-review case,
 * while writing to one buries the row where nobody looks.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria, renderCriteria} from "../wire/acceptance-criteria.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {badNumber, resolveTargetRepo} from "./target.ts";

const VERB = "review criteria";

export interface CriteriaOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runCriteria = (
	options: CriteriaOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;
		const bad = badNumber(VERB, "an issue number", issue);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const found = yield* getIssue(repo, issue);
		if (found._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${issue} not found in ${repo}.`);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} in ${repo}: ${found.reason} — whether a block exists is UNKNOWN.`,
			);
		}

		const diagnostics =
			found.value.state === "open"
				? []
				: [`${VERB}: #${issue} is ${found.value.state} — reading its contract anyway.`];

		const block = readCriteria(found.value.body);
		if (block._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue} carries no acceptance-criteria block — absent: ${block.reason}. Grade nothing; the contract is missing.`,
				diagnostics,
			);
		}
		if (block._tag === "Malformed") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue}'s acceptance-criteria block is malformed: ${block.reason} — a drifted heading is a defect to report, not "there were none".`,
				diagnostics,
			);
		}

		const criteria = block.value;
		return json
			? answer(
					JSON.stringify({
						outcome: "criteria",
						issue,
						count: criteria.length,
						criteria: criteria.map(({text, checked}) => ({text, checked})),
					}),
					diagnostics,
				)
			: answer(
					[`criteria\t${criteria.length}`, ...renderCriteria(criteria)].join("\n"),
					diagnostics,
				);
	});
