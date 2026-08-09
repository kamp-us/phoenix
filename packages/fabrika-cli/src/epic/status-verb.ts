/**
 * `epic status` — the whole run folded, derived fresh from the ledger and the live graph.
 *
 * This fold is the handoff artifact: a successor session resumes from it and the ledger, never from
 * anyone's narrative (#4111). Which is why `verdict` is four-valued — `current`, `fail`, `none`,
 * `unbindable` — and an `unbindable` verdict is surfaced rather than dropped and never rendered as
 * `current` (ADR 0058's shape, and `run-evidence`'s absent ≠ pending ≠ unknown discipline).
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {headSha} from "../build/git.ts";
import {badNumber, scannedLine} from "../build/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {foldRun} from "./fold.ts";
import {readGraph, shasIn} from "./graph.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic status";

export interface StatusOptions {
	readonly number: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runStatus = (
	options: StatusOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		const ground = yield* laneGround(VERB, epic, null, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const run = yield* loadRun(VERB, epic, ground);
		if (run._tag === "Refused") return run.outcome;

		const head = yield* headSha;
		if (head._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read HEAD: ${head.reason} — the run state is UNKNOWN.`,
				ground.notes,
			);
		}
		const graph = yield* readGraph(head.value, shasIn(run.lines));
		const folded = foldRun(run.plan, run.lines, graph);

		return answer(
			JSON.stringify({
				run: run.plan.run,
				epic,
				branch: ground.branch,
				slices: folded.map((slice) => ({
					id: slice.id,
					state: slice.state,
					commit: slice.commit,
					verdict: slice.verdict,
					failAttempts: slice.counters.failAttempts,
					deadAttempts: slice.counters.deadAttempts,
				})),
				counters: {
					landed: folded.filter((slice) => slice.commit !== null).length,
					passed: folded.filter((slice) => slice.state === "passed").length,
					escalated: folded.filter((slice) => slice.state === "escalated").length,
				},
			}),
			[
				...ground.notes,
				scannedLine(VERB, run.lines.length, "event", `${folded.length} slices folded`),
			],
		);
	});
