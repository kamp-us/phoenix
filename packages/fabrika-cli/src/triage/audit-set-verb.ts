/**
 * `triage audit-set` — the whole open issue set a read-only backlog audit judges, for one label.
 *
 * `triage queue`'s read with two differences an audit needs: the label has no default, so the set a
 * sweep judges is always named by its caller, and nothing is truncated, because a merge checks its
 * rows against this set and a capped set would pass a merge over a subset. It reads and never writes.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9834
 */
import {Effect} from "effect";
import {openQueueIssues, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse} from "../verb.ts";
import type {AuditIssue} from "./audit.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {labelPrecondition} from "./queue-verb.ts";
import {scannedLine} from "./scope.ts";

const VERB = "triage audit-set";

export interface AuditSetOptions {
	readonly label: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runAuditSet = Effect.fn("runAuditSet")(function* (options: AuditSetOptions) {
	const {label, json} = options;
	if (label.trim() === "") return refuse(FAILED, `${VERB}: --label must name a label.`);

	const repoAttempt = yield* resolveRepo(options.repo, options.env);
	if (repoAttempt._tag === "Failure") {
		return refuse(
			FAILED,
			`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
		);
	}
	const repo = repoAttempt.value;

	const absent = yield* labelPrecondition(VERB, "audit set", repo, label);
	if (absent !== null) return absent;

	const read = yield* openQueueIssues(repo, label);
	if (read._tag === "Failure") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`${VERB}: cannot read the open ${label} issues in ${repo}: ${read.reason} — the audit set is UNKNOWN, never "empty".`,
		);
	}

	const issues: ReadonlyArray<AuditIssue> = [...read.value]
		.sort((a, b) => a.number - b.number)
		.map(({number, title}) => ({number, title}));
	const scanned = issues.length;
	const scope = scannedLine(VERB, repo, scanned, `open ${label} issue`);
	const outcome = scanned === 0 ? "empty" : "set";

	if (json) {
		return answer(JSON.stringify({outcome, label, repo, issues, scanned}), [scope]);
	}
	return answer([outcome, ...issues.map((issue) => `${issue.number}\t${issue.title}`)].join("\n"), [
		scope,
	]);
});
