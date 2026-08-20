/**
 * `plan check` — the deterministic floor, and the whole pass/fail decision.
 *
 * **Both arms exit `0`** and the discriminator is a state word on stdout (`clean` / `defective`), per
 * the interface convention's pipe clause. v1's gate exited `0` on FAIL *and* printed only a `✓`/`✗`
 * glyph, so `run-gate.sh && proceed` proceeded on a failure. The guard against acting on a defective
 * plan is not at *this* read at all — it is at the **write**: `plan flip` re-derives the floor itself
 * and refuses on `20` rather than trusting any caller's reading of an exit code.
 *
 * There is deliberately no `20` here: a defective floor is this verb's answer, not its refusal.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {cycleDocOr} from "../config/paths.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import type {Floor} from "./defects.ts";
import {
	deriveFloorFor,
	loadLedger,
	type PlanMessages,
	readContainmentVocabulary,
	requireEpic,
	scannedChildren,
} from "./load.ts";
import type {Ledger} from "./model.ts";

const VERB = "plan check";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: the ledger grammar refused: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero children — refusing to answer over zero scope (ADR 0092).`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to gate it.`,
	unreadable: (what, reason) =>
		`${VERB}: cannot read ${what}: ${reason} — the floor is UNKNOWN, not clean.`,
};

export interface CheckOptions {
	readonly number: number;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The answer both arms share.
 *
 * `defective` outranks everything: a plan with defects is `defective` however many classes were
 * skipped, and a skipped class never makes the floor clean by omission — it is named on the answer.
 */
export const floorAnswer = (ledger: Ledger, floor: Floor): string =>
	JSON.stringify({
		answer: floor.defects.length === 0 ? "clean" : "defective",
		epic: ledger.epic,
		scanned: ledger.children.map((child) => child.number),
		digest: ledger.digest,
		skipped: floor.skipped,
		defects: floor.defects,
	});

export const runCheck = (
	options: CheckOptions,
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

		const derived = yield* deriveFloorFor(MESSAGES, repo, ledger, vocabulary.vocabulary);
		if (derived._tag === "Refused") return derived.outcome;
		const floor = derived.floor;

		const scanned = scannedChildren(
			VERB,
			ledger.children.map((child) => child.number),
		);
		// A notice on an exit-0 answer, not an error — which is why it is not in the Errors table.
		const notice =
			floor.defects.length === 0
				? []
				: [
						`${VERB}: ${floor.defects.length} hard defect(s) over ${ledger.children.length} child(ren) — see stdout.`,
					];
		return answer(floorAnswer(ledger, floor), [scanned, ...notice]);
	});
