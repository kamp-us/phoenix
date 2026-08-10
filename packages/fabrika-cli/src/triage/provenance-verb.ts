/**
 * `triage provenance` — was this issue reported by an agent or typed by a human?
 *
 * The predicate itself lives in `./provenance.ts` — including the operator-account signal the
 * #4619 ruling added — exported because `triage kill` re-checks it rather than trusting a caller
 * to have run this verb.
 *
 * **A present-but-empty body answers `human`; an unreadable one refuses.** Those are different
 * facts and this verb keeps them apart. An empty body is a measurement — the body is there, it
 * carries no footer, and the protective reading of "no footer" is `human`, because the only
 * irreversible act downstream is a kill. An unreadable body is not a measurement at all, and
 * answering `human` over it would be a verdict manufactured from a failed read. The empty-body
 * default is reached only once the author has been tested: an operator-authored filing is
 * agent-reported by the ruling however little it says.
 */
import {Effect} from "effect";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {hasAgentFooter, isOperatorAccount, resolveOperatorAccounts} from "./provenance.ts";

export interface ProvenanceOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const AGENT_REASON = "the 'Filed by an agent' marker is present in the body";
const OPERATOR_REASON =
	"the author is a configured operator account, so the filing is agent-reported whether or not the footer is present (#4619 ruling)";
const HUMAN_REASON =
	"no line begins '<sub>Filed by an agent' and the author is not a configured operator account";
const EMPTY_REASON =
	"the body is empty and the author is not a configured operator account — answering human (fail-closed)";

const render = (
	json: boolean,
	outcome: "agent" | "human",
	marker: boolean,
	operator: boolean,
	reason: string,
	stderr: ReadonlyArray<string>,
): VerbOutcome =>
	json
		? answer(JSON.stringify({outcome, marker, operator, reason}), stderr)
		: answer(outcome, stderr);

export const runProvenance = Effect.fn("runProvenance")(function* (options: ProvenanceOptions) {
	const {issue, json} = options;

	const repoAttempt = yield* resolveRepo(options.repo, options.env);
	if (repoAttempt._tag === "Failure") {
		return refuse(
			FAILED,
			"triage provenance: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
		);
	}
	const repo = repoAttempt.value;

	const record = yield* getIssue(repo, issue);
	if (record._tag === "Absent") {
		return refuse(ZERO_SCOPE, `triage provenance: issue #${issue} not found in ${repo}.`);
	}
	if (record._tag === "Unknown") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage provenance: cannot read #${issue} in ${repo}: ${record.reason} — the provenance is UNKNOWN; refusing to default it.`,
		);
	}

	const body = record.value.body;
	const operator = isOperatorAccount(record.value.author, resolveOperatorAccounts(options.env));
	if (operator) {
		return render(json, "agent", hasAgentFooter(body), true, OPERATOR_REASON, [
			`triage provenance: #${issue} in ${repo} — ${OPERATOR_REASON}.`,
		]);
	}
	if (body.trim() === "") {
		return render(json, "human", false, false, EMPTY_REASON, [
			`triage provenance: #${issue} has an empty body — answering human (fail-closed).`,
		]);
	}
	const marker = hasAgentFooter(body);
	return render(
		json,
		marker ? "agent" : "human",
		marker,
		false,
		marker ? AGENT_REASON : HUMAN_REASON,
		[
			`triage provenance: read the body of #${issue} in ${repo} — ${marker ? AGENT_REASON : HUMAN_REASON}.`,
		],
	);
});
