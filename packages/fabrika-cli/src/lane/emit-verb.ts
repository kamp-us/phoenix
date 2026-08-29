/**
 * `lane emit` — generate one epic's lane machine from its board state and place it as a new lane.
 *
 * The board reads ride the shipped readers (`getIssue` via `openIssue`, the native sub-issue list
 * via `plan/github.ts`), the emission is the pure `emit.ts`, and the placement is the same guarded
 * boot `lane open` uses. Every topology defect seats on its own code, because each takes a
 * different remedy: plan the epic, fix the reference, break the cycle.
 *
 * An existing lane is refused, and nothing carves an exception into that refusal: ADR 0313's
 * 2026-08-20 amendment rejected an overwrite path for a lane already on disk by name, and left
 * `placeMachine`'s refusal standing as the answer. What this verb owes instead is a refusal that
 * names the remedy exactly — retire the directory, then re-run it — so a wrong-template lane (#7024)
 * is a two-step repair an operator can read off the line rather than a dead end.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {listSubIssues} from "../plan/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	LANE_EXISTS,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
} from "./codes.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine} from "./store.ts";

const VERB = "fabrika lane emit";

export interface EmitOptions {
	readonly epic: number;
	readonly root: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const emitRefusal = (epic: number, result: Exclude<EmitResult, {_tag: "Emitted"}>): VerbOutcome => {
	switch (result._tag) {
		case "NoTopology":
			return refuse(
				TOPOLOGY_ABSENT,
				`${VERB}: #${epic} carries no readable \`## Dependencies\` topology — plan the epic before emitting a machine.`,
			);
		case "Unparseable":
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: #${epic}'s topology line ${result.line} does not parse: "${result.text}".`,
			);
		case "Duplicate":
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: #${epic}'s topology places #${result.child} in more than one phase.`,
			);
		case "Unplaced":
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: #${epic}'s topology names #${result.child} in a requires line but places it in no phase.`,
			);
		case "Foreign":
			return refuse(
				TOPOLOGY_FOREIGN,
				`${VERB}: the topology references ${result.ref}, which is not a child of #${epic}.`,
			);
		case "Cycle":
			return refuse(
				TOPOLOGY_CYCLE,
				`${VERB}: the topology holds a cycle: ${result.path.map((n) => `#${n}`).join(" → ")}.`,
			);
	}
};

export const runEmit = (
	options: EmitOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.epic);
		if (bad !== null) return bad;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const target = yield* openIssue(
			VERB,
			resolved.repo,
			options.epic,
			(reason) => `${VERB}: cannot read #${options.epic}: ${reason} — nothing was emitted.`,
		);
		if (target._tag === "Refused") return target.outcome;
		const listed = yield* listSubIssues(resolved.repo, options.epic, options.env);
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read #${options.epic}'s children: ${listed.reason} — nothing was emitted.`,
			);
		}
		const emitted = emitMachine(options.epic, target.issue.body, listed.value);
		if (emitted._tag !== "Emitted") return emitRefusal(options.epic, emitted);
		const ref: LaneRef = {root: options.root, lane: String(options.epic)};
		const placed = yield* placeMachine(ref, emitted.text);
		if (placed._tag === "Exists") {
			return refuse(
				LANE_EXISTS,
				`${VERB}: a lane already exists at ${placed.dir} — resuming needs no boot, and a lane on disk is never re-emitted over (ADR 0313, amendment 2026-08-20). If it runs the wrong machine — \`fabrika lane migrate --check\` answers 46 and names it — the remedy is exactly two steps: retire ${placed.dir}, then re-run \`${VERB} ${options.epic}\`.`,
			);
		}
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed);
		return answer(
			JSON.stringify({
				answer: "emitted",
				epic: options.epic,
				workflow: placed.workflow,
				phases: emitted.phases,
				children: emitted.children,
				bytes: new TextEncoder().encode(emitted.text).length,
			}),
			[
				`${VERB}: read #${options.epic} and ${listed.value.length} sub-issue link(s) from ${resolved.repo}.`,
			],
		);
	});
