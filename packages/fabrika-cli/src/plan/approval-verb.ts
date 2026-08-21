/**
 * `plan approval` — report whether an epic's plan carries a current founder approval.
 *
 * **A reporting surface, never the enforcement.** It exits `0` on `absent` exactly as it does on
 * `current`, because a missing approval is this verb's *answer*. The refusal that keeps an unapproved
 * plan out of the gate lives in `plan check` / `plan flip` / `plan verdict`, each of which re-derives
 * the approval through `./approval.ts`'s `requireApproval` rather than trusting this report or any
 * caller — the same discipline that makes `plan check`'s defective floor an answer and `plan flip`'s
 * re-gate the guard.
 *
 * **What the state is safe to be read as.** `current` means a marker whose author the control-plane
 * roster resolves *at this read* — the author gate lives here, in the read, not only in `plan
 * approve`'s write, because bytes carrying the right digest can reach the epic from any account that
 * can comment on it (ADR 0289; `./approval.ts` says why).
 *
 * Both digests are printed, the marker's and the freshly derived one, so a `stale` answer shows what
 * moved rather than asserting that something did.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {cycleDocOr} from "../config/paths.ts";
import {listComments} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {controlPlaneRoster, scanApprovals, stateOf} from "./approval.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	loadLedger,
	type PlanMessages,
	readContainmentVocabulary,
	requireEpic,
	scannedChildren,
} from "./load.ts";

const VERB = "plan approval";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: the ledger grammar refused: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero children — there is no plan scope to bind an approval to (ADR 0092).`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to read an approval on it.`,
	unreadable: (what, reason) =>
		`${VERB}: cannot read ${what}: ${reason} — the approval state is UNKNOWN, not absent.`,
};

export interface ApprovalOptions {
	readonly number: number;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runApproval = (
	options: ApprovalOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
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

		const read = yield* loadLedger(
			MESSAGES,
			repo,
			target.issue,
			cycle.path,
			vocabulary.vocabulary,
			options.env,
		);
		if (read._tag === "Refused") return read.outcome;
		const ledger = read.ledger;

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${roster.reason} — who may approve is unread, so the approval state is UNKNOWN, not absent.`,
				[
					scannedChildren(
						VERB,
						ledger.children.map((child) => child.number),
					),
				],
			);
		}

		const listed = yield* listComments(repo, options.number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`the comments on #${options.number}`, listed.reason),
				[
					scannedChildren(
						VERB,
						ledger.children.map((child) => child.number),
					),
				],
			);
		}

		const scan = scanApprovals(listed.value, ledger.epic, roster.logins);
		const state = stateOf(scan, ledger.epic, ledger.digest);
		const notes = [
			scannedChildren(
				VERB,
				ledger.children.map((child) => child.number),
			),
			`${VERB}: ${roster.logins.size} control-plane account(s) from ${roster.owners.join(", ") || "no owner"} at ${roster.ref}.`,
			`${VERB}: read ${listed.value.length} comment(s) on #${options.number}; ${scan.disregarded} disregarded marker(s), ${scan.unauthorized} from an account off that roster.`,
		];

		return answer(
			JSON.stringify({
				answer: "approval",
				epic: ledger.epic,
				state,
				by: scan.standing?.by ?? null,
				markerDigest: scan.standing?.approval.digest ?? null,
				derivedDigest: ledger.digest,
				at: scan.standing?.approval.at ?? null,
				comment: scan.standing?.comment ?? null,
				disregarded: scan.disregarded,
				unauthorized: scan.unauthorized,
			}),
			notes,
		);
	});
