/**
 * `epic next` — the state relay: ledger + git graph folded into exactly one next action.
 *
 * The model-walked state tree does not port (#4891): the model asks, the verb answers. So this verb
 * reads no GitHub beyond the lane guard's own claim proof, spawns nothing, and judges nothing — the
 * whole answer is a deterministic fold, and the retry breakers are its arithmetic (ADR 0130).
 *
 * `escalate-slice` is an **answer**, not the `23` refusal: `next` reports a tripped breaker as the
 * next action; `23` is what the acting verbs return when asked to act past one.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {headSha} from "../build/git.ts";
import {badNumber, scannedLine} from "../build/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {nextAction} from "./fold.ts";
import {readGraph, shasIn} from "./graph.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic next";

export interface NextOptions {
	readonly number: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runNext = (
	options: NextOptions,
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
		const action = nextAction(run.plan, run.lines, graph, run.plan.run);
		return answer(JSON.stringify(action), [
			...ground.notes,
			scannedLine(VERB, run.lines.length, "event", `${run.plan.order.length} slices folded`),
		]);
	});
