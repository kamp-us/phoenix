/**
 * `lane emit` — generate one epic's lane machine from its board state and place it as a new lane.
 *
 * The board reads ride the shipped readers (`getIssue` via `openIssue`, the native sub-issue list
 * via `plan/github.ts`), the emission is the pure `emit.ts`, and the placement is the same guarded
 * boot `lane open` uses. Every topology defect seats on its own code, because each takes a
 * different remedy: plan the epic, fix the reference, break the cycle.
 *
 * An existing lane is still refused, with **one proven exception** (#7024): a lane whose machine was
 * *booted* from a committed template is the wrong machine for an epic by construction, and its log
 * can only name tasks this epic's machine does not have. Where both hold, the lane is re-emitted in
 * place rather than sending the operator to `rm -rf` — which removed the same log, with no proof.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
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
import {compileText} from "./machine.ts";
import {loadRefusal, placementRefusal} from "./refusals.ts";
import {originOf} from "./shape.ts";
import {type LaneRef, loadLane, placeMachine, replaceMachine} from "./store.ts";

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

type Reboot =
	| {readonly _tag: "Rebooted"; readonly workflow: string; readonly droppedEvents: number}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const exists = (dir: string): VerbOutcome =>
	refuse(
		LANE_EXISTS,
		`${VERB}: a lane already exists at ${dir} — resuming needs no boot; remove the directory to rebuild it.`,
	);

/**
 * Decide whether the lane already at this key may be re-emitted over, and do it — the whole of the
 * exception the module docblock names. Both halves of the proof are made here and nowhere else.
 */
const reboot = (
	ref: LaneRef,
	epic: number,
	text: string,
): Effect.Effect<Reboot, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const refused = (outcome: VerbOutcome): Reboot => ({_tag: "Refused", outcome});
		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") {
			return refused(loaded._tag === "Absent" ? exists(loaded.dir) : loadRefusal(VERB, loaded));
		}
		const onDisk = yield* Effect.result(readFile(path.join(loaded.dir, "workflow.json")));
		if (Result.isFailure(onDisk)) {
			return refused(
				refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot re-read ${loaded.dir}/workflow.json: ${onDisk.failure.reason} — nothing was written.`,
				),
			);
		}
		const document = parseJson(onDisk.success);
		const id = isRecord(document) && typeof document.id === "string" ? document.id : null;
		if (id === null) return refused(exists(loaded.dir));
		const origin = originOf(id);
		if (origin._tag === "Generated") return refused(exists(loaded.dir));

		const candidate = compileText(text);
		if (candidate._tag === "Malformed") {
			return refused(
				refuse(
					MALFORMED_RECORD,
					`${VERB}: the machine emitted for #${epic} does not compile: ${candidate.defects.join("; ")}.`,
				),
			);
		}
		const carried = loaded.entries.filter((entry) => entry.task in candidate.lane.tasks);
		if (carried.length > 0) {
			const tasks = [...new Set(carried.map((entry) => entry.task))].join(", ");
			return refused(
				refuse(
					LANE_EXISTS,
					`${VERB}: the lane at ${loaded.dir} runs the booted "${origin.template}" machine, but its log records ${carried.length} event(s) on ${tasks} — task(s) #${epic}'s machine also carries, so this is history, not a wrong-template boot. Decide it by hand.`,
				),
			);
		}
		const replaced = yield* replaceMachine(ref, text);
		if (replaced._tag !== "Replaced") {
			return refused(placementRefusal(VERB, replaced));
		}
		return {
			_tag: "Rebooted",
			workflow: replaced.workflow,
			droppedEvents: loaded.entries.length,
		};
	});

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
		let workflow: string;
		let replaced: {readonly droppedEvents: number} | null = null;
		if (placed._tag === "Placed") {
			workflow = placed.workflow;
		} else if (placed._tag !== "Exists") {
			return placementRefusal(VERB, placed);
		} else {
			const rebooted = yield* reboot(ref, options.epic, emitted.text);
			if (rebooted._tag === "Refused") return rebooted.outcome;
			workflow = rebooted.workflow;
			replaced = {droppedEvents: rebooted.droppedEvents};
		}
		return answer(
			JSON.stringify({
				answer: "emitted",
				epic: options.epic,
				workflow,
				phases: emitted.phases,
				children: emitted.children,
				bytes: new TextEncoder().encode(emitted.text).length,
				replaced: replaced !== null,
				droppedEvents: replaced?.droppedEvents ?? 0,
			}),
			[
				`${VERB}: read #${options.epic} and ${listed.value.length} sub-issue link(s) from ${resolved.repo}.`,
				...(replaced === null
					? []
					: [
							`${VERB}: replaced a booted-template lane at ${options.root}/${options.epic} and dropped its ${replaced.droppedEvents} orphaned event(s) — no event named a task this machine carries.`,
						]),
			],
		);
	});
