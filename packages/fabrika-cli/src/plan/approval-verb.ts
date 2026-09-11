/**
 * `plan approval` reports the approval resolved by `./approval.ts`, which checks the author
 * against the live roster on every read. See `plan approval --help` for reported states.
 * The writing verbs enforce approval through `requireApproval`.
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
		`${VERB}: #${epic} has zero children — there is no plan scope to bind an approval to.`,
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
