/**
 * `review append-criterion` — append one reviewer-authored acceptance criterion under ADR 0079's
 * four fences.
 *
 * The fences run in this order and each is a refusal, never a warning:
 *
 * 1. **ACL-gated, fail-closed** (ADR 0055) — below `write`, or *any* ACL lookup failure, refuses on
 *    `14`. Authority comes from the ACL check, never from the text being plausible.
 * 2. **Append-only** — the new body is the old plus exactly one row, proven by a diff guard before
 *    the PATCH is sent (`./append.ts`).
 * 3. **Frozen at ADR 0079's round K**, read from `../retry-budget.ts`'s `CAP_ROUND` — at or past
 *    the freeze the verb posts the escalation comment and appends nothing. Append-rate stays
 *    bounded by fix-rate; a finding raised at the freeze routes to a human.
 * 4. **In-scope-only is the caller's** — the trace-to-stated-goal test is judgment. What this verb
 *    contributes is the provenance tag, which is what makes a routed row auditable afterwards.
 *
 * v1's `reviewer-append-ac.sh` was mandated at four call sites and called at none — a first-class
 * verb is the difference between a fence and a fence description.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getIssue, patchIssueBody} from "../io/issues.ts";
import {permissionFor, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {appendOnly, criterionRow, grewByOne, insertAfterLastCriterion} from "./append.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {
	ACL_DENIED,
	APPEND_ONLY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {badNumber, resolveTargetRepo} from "./target.ts";

const VERB = "review append-criterion";

/** The permissions that resolve at or above `write`. Anything else, or a failed lookup, refuses. */
const WRITE_OR_ABOVE = new Set(["admin", "maintain", "write"]);

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the criterion",
	emptyMessage: `${VERB}: no criterion on stdin.`,
	bareAtMessage: `${VERB}: the criterion is a bare "@" path reference — the text never arrived. Send it on stdin.`,
	leakCorrection: "rewrite it repo-relative.",
};

export interface AppendCriterionOptions {
	readonly issue: number;
	readonly pr: number;
	readonly round: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

const unreadable = (what: string, reason: string): VerbOutcome =>
	refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${what}: ${reason} — nothing was written.`);

const aclRefusal = (repo: string): VerbOutcome =>
	refuse(
		ACL_DENIED,
		`${VERB}: token resolves below write on ${repo}, or the ACL could not be read — refusing the append (ADR 0055, fail-closed).`,
	);

export const runAppendCriterion = (
	options: AppendCriterionOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, pr, round, json} = options;
		const badIssue = badNumber(VERB, "an issue number", issue);
		if (badIssue !== null) return badIssue;
		const badPr = badNumber(VERB, "a pull-request number", pr);
		if (badPr !== null) return badPr;
		const badRound = badNumber(VERB, "a review round", round);
		if (badRound !== null) return badRound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const leaked = leakRefusal(SURFACE, authored.text);
		if (leaked !== null) return leaked;

		// Fence 1 — the ACL, fail-closed. A failed lookup is a denial, not a pass.
		const me = yield* viewerLogin;
		if (me._tag === "Failure") return aclRefusal(repo);
		const permission = yield* permissionFor(repo, me.value);
		if (permission._tag !== "Present" || !WRITE_OR_ABOVE.has(permission.value)) {
			return aclRefusal(repo);
		}
		const diagnostics = [`${VERB}: ${me.value} resolves ${permission.value} on ${repo}.`];

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${issue} not found in ${repo}.`, diagnostics);
		}
		if (target._tag === "Unknown") {
			return unreadable(`issue #${issue} in ${repo}`, target.reason);
		}
		if (target.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${issue} is closed — an appended row there enters no cycle; file the finding instead.`,
				diagnostics,
			);
		}

		const block = readCriteria(target.value.body);
		if (block._tag !== "Found") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue} carries no conforming acceptance-criteria block (${
					block._tag === "Absent" ? "absent" : "malformed"
				}: ${block.reason}) — nothing to append under.`,
				diagnostics,
			);
		}
		const before = block.value;

		// Fence 3 — frozen at the cap round. The escalation lands and the AC does not; both are exit-0
		// answers, discriminated by the stdout token.
		if (round >= CAP_ROUND) {
			const escalated = yield* createComment(
				repo,
				issue,
				`review append-criterion: a finding from PR #${pr}'s round ${round} was NOT appended — the acceptance-criteria fence is frozen at round ${CAP_ROUND} (ADR 0079). Routing it to a human instead.\n\n${authored.text}`,
			);
			if (escalated._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the escalation comment failed: ${escalated.reason} — UNKNOWN whether it landed; nothing was appended either way. Re-run.`,
					diagnostics,
				);
			}
			return json
				? answer(
						JSON.stringify({
							outcome: "escalated-frozen",
							issue,
							rows: before.length,
							round,
							acl: permission.value,
						}),
						diagnostics,
					)
				: answer(`escalated-frozen\t${issue}\t${round}`, diagnostics);
		}

		// Fence 2 — append-only, proven twice before anything is sent: against the old bytes, and
		// against what the registered format reads back out of the composed body.
		const row = criterionRow(authored.text, pr, round);
		const last = before[before.length - 1]?.text ?? "";
		const composed = insertAfterLastCriterion(target.value.body, last, row);
		const composedBlock = composed === null ? null : readCriteria(composed);
		const wouldGrow = grewByOne(
			before,
			composedBlock !== null && composedBlock._tag === "Found" ? composedBlock.value : null,
			authored.text,
		);
		if (
			composed === null ||
			appendOnly(target.value.body, composed)._tag === "Violates" ||
			!wouldGrow
		) {
			return refuse(
				APPEND_ONLY,
				`${VERB}: the append would drop or mutate an existing row — refusing (append-only fence).`,
				diagnostics,
			);
		}

		const written = yield* patchIssueBody(repo, issue, composed);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: PATCH failed: ${written.reason} — UNKNOWN whether the row landed; re-read #${issue} before retrying.`,
				diagnostics,
			);
		}

		// The read-back re-reads the block through the same format and compares row by row.
		const back = yield* getIssue(repo, issue);
		const reread = back._tag === "Present" ? readCriteria(back.value.body) : null;
		const after = reread !== null && reread._tag === "Found" ? reread.value : null;
		if (!grewByOne(before, after, authored.text) || after === null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: read-back does not show the prior rows plus this one — inspect #${issue}.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						outcome: "appended",
						issue,
						rows: after.length,
						round,
						acl: permission.value,
					}),
					diagnostics,
				)
			: answer(`appended\t${issue}\t${after.length}`, diagnostics);
	});
