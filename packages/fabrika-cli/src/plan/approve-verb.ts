/**
 * `plan approve` — record a control-plane human's approval of one epic's plan (ADR 0289).
 *
 * **The digest is derived here and taken from nowhere.** There is no `--digest` flag, and adding one
 * would be the defect: an approval whose scope its caller supplies attests whatever the caller
 * pleased, which is precisely the binding the marker exists to be. The verb loads the ledger through
 * the same `loadLedger` path `plan check` runs and takes `scopeDigest`'s answer over it.
 *
 * The roster is resolved at write time through `./approval.ts`, and a roster that could not be read
 * is `11` — never "not approved" and never "approved". That is the collapse `ship cp-approval`
 * already refuses to make (#4223), and it is worth more here: this verb's whole output is an
 * authority claim.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {cycleDocOr} from "../config/paths.ts";
import {createComment, getComment} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {approvedEpic, emit, scopeDigest} from "../wire/plan-approval.ts";
import {controlPlaneRoster} from "./approval.ts";
import {
	APPROVAL_UNAUTHORIZED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	loadLedger,
	type PlanMessages,
	readContainmentVocabulary,
	requireEpic,
	scannedChildren,
} from "./load.ts";

const VERB = "plan approve";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: the ledger grammar refused: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero children — there is no plan scope to approve (ADR 0092).`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to approve a plan on it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was posted.`,
};

export interface ApproveOptions {
	readonly number: number;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runApprove = (
	options: ApproveOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* requireEpic(MESSAGES, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		const vocabulary = yield* readContainmentVocabulary(MESSAGES, options.cwd);
		if (vocabulary._tag === "Refused") return vocabulary.outcome;

		const cycle = yield* cycleDocOr(
			VERB,
			options.cwd,
			"where the cycle doc lives is unread, so the containment class cannot be derived.",
		);
		if (cycle._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, cycle.message);

		const read = yield* loadLedger(MESSAGES, repo, target.issue, cycle.path, vocabulary.vocabulary);
		if (read._tag === "Refused") return read.outcome;
		const ledger = read.ledger;
		const notes = [
			scannedChildren(
				VERB,
				ledger.children.map((child) => child.number),
			),
		];

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
				notes,
			);
		}

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${roster.reason} — whether ${viewer.value} may approve is UNKNOWN, neither approved nor unapproved (#4223). Nothing was posted.`,
				notes,
			);
		}
		notes.push(
			`${VERB}: ${roster.logins.size} control-plane account(s) from ${roster.owners.join(", ") || "no owner"} at ${roster.ref}.`,
		);
		if (roster.logins.size === 0) {
			return refuse(
				APPROVAL_UNAUTHORIZED,
				`${VERB}: ${repo}'s CODEOWNERS names no control-plane owner at ${roster.ref}, so no account may approve a plan here.`,
				notes,
			);
		}
		if (!roster.logins.has(viewer.value)) {
			return refuse(
				APPROVAL_UNAUTHORIZED,
				`${VERB}: ${viewer.value} is not on ${repo}'s control-plane roster at ${roster.ref} — refusing to record an approval.`,
				notes,
			);
		}

		const epic = approvedEpic(ledger.epic);
		const digest = scopeDigest(ledger.digest);
		const at = stampOf(options.now());
		if (epic === null || digest === null || at === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(
					"the approval marker",
					`the epic, the digest "${ledger.digest}" or the clock will not brand`,
				),
				notes,
			);
		}

		const body = emit({epic, digest, at});
		const posted = yield* createComment(repo, options.number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the write failed: ${posted.reason} — it may or may not have landed; re-read #${options.number} before retrying.`,
				notes,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker posted and could not be re-read — the outcome is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(back.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker posted but does not read back — the approval needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "approved",
				epic: ledger.epic,
				digest: ledger.digest,
				by: viewer.value,
				at,
				comment: posted.value.id,
			}),
			notes,
		);
	});
