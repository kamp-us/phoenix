/**
 * `triage provenance` — was this issue filed by an agent or typed by a human?
 *
 * The predicate itself lives in `./provenance.ts`, exported because `triage kill` re-checks it
 * rather than trusting a caller to have run this verb.
 *
 * **A present-but-empty body answers `human`; an unreadable one refuses.** Those are different
 * facts and this verb keeps them apart. An empty body is a measurement — the body is there, it
 * carries no footer, and the protective reading of "no footer" is `human`, because the only
 * irreversible act downstream is a kill. An unreadable body is not a measurement at all, and
 * answering `human` over it would be a verdict manufactured from a failed read.
 */
import {Effect} from "effect";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {isAgentFiled} from "./provenance.ts";

export interface ProvenanceOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const AGENT_REASON = "the 'Filed by an agent' marker is present in the body";
const HUMAN_REASON = "no line begins '<sub>Filed by an agent' — the body carries no agent footer";
const EMPTY_REASON = "the body is empty, so it carries no footer — answering human (fail-closed)";

const render = (
	json: boolean,
	outcome: "agent" | "human",
	marker: boolean,
	reason: string,
	stderr: ReadonlyArray<string>,
): VerbOutcome =>
	json ? answer(JSON.stringify({outcome, marker, reason}), stderr) : answer(outcome, stderr);

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
	if (body.trim() === "") {
		return render(json, "human", false, EMPTY_REASON, [
			`triage provenance: #${issue} has an empty body — answering human (fail-closed).`,
		]);
	}
	const marker = isAgentFiled(body);
	return render(json, marker ? "agent" : "human", marker, marker ? AGENT_REASON : HUMAN_REASON, [
		`triage provenance: read the body of #${issue} in ${repo} — ${marker ? AGENT_REASON : HUMAN_REASON}.`,
	]);
});
