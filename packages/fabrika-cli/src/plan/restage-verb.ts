/**
 * `plan restage` — reconcile an already-minted epic's `## Dependencies` region against its children's
 * observed close state, byte-verified.
 *
 * The gap it closes: nothing in `plan` or `lane` could re-stage a topology after a child was closed.
 * `lane emit` builds one machine region per child the region names and boots a non-`completed` close
 * in `frozen`, which trips the phase the moment the machine starts — so an epic that lost a child to
 * a duplicate close could only emit a machine that dies, and the sole repair was a human editing the
 * epic body. This verb is that repair, and it is the whole of it: it drops abandoned refs and does
 * nothing else. It adds no child, re-phases nothing, and touches no byte outside the region.
 *
 * **The observations are the epic's native sub-issue links**, which is the same set `lane emit`
 * checks every ref against, so the two never disagree about one edge. What the links do not name,
 * this verb does not judge — `restage.ts` states why.
 *
 * Idempotence is decided on the *refs*, not the bytes: a region naming only live issues answers
 * `unchanged` and issues no PATCH at all, so a re-run neither rewrites formatting nor moves the
 * body digest a standing approval is bound to.
 */

import {Effect, type FileSystem} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireCallerToken, requireClaim, requireSession} from "../build/claim.ts";
import {badNumber, resolveTargetRepo, scannedLine} from "../build/target.ts";
import {getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	TOPOLOGY_EMPTIED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {listSubIssues} from "./github.ts";
import {type PlanMessages, requireEpic, scannedChildren} from "./load.ts";
import {restageBody} from "./restage.ts";

const VERB = "plan restage";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero sub-issue children — there is no topology to reconcile.`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to restage its plan.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

export interface RestageOptions {
	readonly number: number;
	/** The claim token `build claim <epic> --purpose gate` handed this lane — which lane is asking. */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRestage = (
	options: RestageOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* requireEpic(MESSAGES, repo, options.number);
		if (target._tag === "Refused") return target.outcome;
		const epic = target.issue;

		const asking = requireCallerToken(VERB, session.id, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const held = yield* requireClaim(VERB, repo, options.number, asking.caller);
		if (held._tag === "Refused") return held.outcome;

		const links = yield* listSubIssues(repo, epic.number, options.env);
		if (links._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`the sub-issue list of #${epic.number}`, links.reason),
				held.notes,
			);
		}
		if (links.value.length === 0) {
			return refuse(ZERO_SCOPE, MESSAGES.zeroChildren(epic.number), held.notes);
		}
		const notes = [
			...held.notes,
			scannedChildren(
				VERB,
				links.value.map((link) => link.number),
			),
		];

		const restaged = restageBody(epic.body, links.value);
		switch (restaged._tag) {
			case "Absent":
				return refuse(
					ZERO_SCOPE,
					`${VERB}: #${epic.number} carries no \`## Dependencies\` region — plan the epic before restaging it.`,
					notes,
				);
			case "Ambiguous":
				return refuse(
					REGION_UNRESOLVABLE,
					`${VERB}: #${epic.number}'s body carries ${restaged.count} "## Dependencies" headings — the region has no single meaning, and nothing was written.`,
					notes,
				);
			case "InPreservedBrief":
				return refuse(
					REGION_UNRESOLVABLE,
					`${VERB}: #${epic.number}'s only "## Dependencies" heading resolves inside the preserved brief envelope — that is filed content, not a machine-owned region, and nothing was written.`,
					notes,
				);
			case "Unparseable":
				return refuse(
					BAD_SECTIONS,
					`${VERB}: #${epic.number}'s ## Dependencies block is unparseable at line ${restaged.line}: ${restaged.text} — nothing was written.`,
					notes,
				);
			case "Emptied":
				return refuse(
					TOPOLOGY_EMPTIED,
					`${VERB}: every issue #${epic.number}'s topology names closed without landing (${restaged.dropped.map((n) => `#${n}`).join(", ")}) — restaging would leave no phase at all, so re-plan the epic instead. Nothing was written.`,
					notes,
				);
			case "ReadbackMismatch":
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: the reconciled region does not parse back to the edges it was composed from — refusing to write it.`,
					notes,
				);
			case "Unchanged":
				return answer(
					JSON.stringify({
						answer: "unchanged",
						epic: epic.number,
						dropped: [],
						kept: restaged.kept,
						written: false,
					}),
					notes,
				);
			case "Restaged":
				break;
		}

		const patched = yield* patchIssueBody(repo, epic.number, restaged.body);
		if (patched._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				[...notes, `${VERB}: ${patched.reason}.`],
			);
		}

		const reread = yield* getIssue(repo, epic.number);
		if (reread._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(reread.value.body) !== normalizeForReadback(restaged.body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the body was written and does not read back as composed — it needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "restaged",
				epic: epic.number,
				dropped: restaged.dropped,
				kept: restaged.kept,
				written: true,
				verified: true,
			}),
			[...notes, scannedLine(VERB, 1, "epic body", `dropped ${restaged.dropped.length}`)],
		);
	});
