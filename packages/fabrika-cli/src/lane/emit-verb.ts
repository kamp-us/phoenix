/**
 * `lane emit` — generate one epic's lane machine from its board state and place it as a new lane.
 *
 * The board reads ride the shipped readers (`getIssue` via `openIssue`, the native sub-issue list
 * via `plan/github.ts`), the emission is the pure `emit.ts`, and the placement is the same guarded
 * boot `lane open` uses. Every topology defect seats on its own code, because each takes a
 * different remedy: plan the epic, fix the reference, break the cycle.
 *
 * `--children` is the descope escape: a founder who unlinks a child leaves the body's topology naming
 * it, and without the flag that is `16` forever. It is opt-in and not the default because the same
 * stale ref is a typo on the other reading, where dropping the child silently emits a machine short
 * one region. The `16` refusal names both escapes — this flag, and `ledger retopology`, which
 * repairs the body instead of routing around it.
 *
 * An existing lane is refused, and nothing carves an exception into that refusal: an overwrite path
 * for a lane already on disk by name was rejected, and that left
 * `placeMachine`'s refusal standing as the answer. What this verb owes instead is a refusal that
 * names the remedy exactly — retire the directory, then re-run it — so a wrong-template lane
 * is a two-step repair an operator can read off the line rather than a dead end.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {MACHINERY_LAPS, type MachineryLapsSurface} from "../config/keys/machinery-laps.ts";
import type {Read} from "../config/read-key.ts";
import {capAndCount} from "../evidence.ts";
import {listSubIssues} from "../plan/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {
	LANE_EXISTS,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
} from "./codes.ts";
import {capRefusal} from "./concurrency.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine} from "./store.ts";

const VERB = "fabrika lane emit";

/**
 * `dropped` is an evidence-array with no reason vocabulary, so it collapses cap-and-count per the
 * bounded-evidence-output-shape decision.
 */
const DROPPED_CAP = 5;

/** The one spelling of a capped `dropped` list, so the two channels never state different counts. */
const droppedList = (dropped: ReadonlyArray<string>): string => {
	const {rows, more} = capAndCount(dropped, DROPPED_CAP);
	return `${rows.join(", ")}${more === 0 ? "" : ` (+${more} more)`}`;
};

export interface EmitOptions<R = never> {
	readonly epic: number;
	readonly root: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The repo's declared `laneConcurrencyCap` — an epic's lane holds a seat like any other. */
	readonly cap: Read<number | null>;
	/** Which lanes under this root a driver is holding — only a claimed one takes a seat. */
	readonly claimed: ClaimHoldReader<R>;
	/**
	 * The repo's declared `machineryLaps` — whether this emission carries the machinery event class.
	 *
	 * Unreadable refuses rather than falling back to the shipped default, on `park-cause-rule.ts`'s
	 * reasoning: which machine a repo asked for is then UNKNOWN, and a machine is emitted once and
	 * driven for the life of the lane.
	 */
	readonly machinery: Read<MachineryLapsSurface>;
	/**
	 * `--children`: start from the board's live child list, dropping every topology ref it does not
	 * name, instead of refusing on `16`.
	 */
	readonly children: boolean;
}

/** The two escapes a `16` names, worded once so the flag and the repair verb are never named apart. */
const FOREIGN_REMEDIES =
	"re-run with --children to emit from the board's live child list, or repair the body with `fabrika ledger retopology <epic>`";

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
				`${VERB}: the topology references ${result.ref}, which is not a child of #${epic} — ${FOREIGN_REMEDIES}.`,
			);
		case "Emptied":
			return refuse(
				TOPOLOGY_ABSENT,
				`${VERB}: --children dropped every ref #${epic}'s topology places (${droppedList(result.dropped)}), so it declares no child — nothing was placed.`,
			);
		case "Cycle":
			return refuse(
				TOPOLOGY_CYCLE,
				`${VERB}: the topology holds a cycle: ${result.path.map((n) => `#${n}`).join(" → ")}.`,
			);
	}
};

export const runEmit = <R = never>(
	options: EmitOptions<R>,
): Effect.Effect<
	VerbOutcome,
	never,
	| R
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
		if (options.machinery._tag === "Refused") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read \`${MACHINERY_LAPS}\` from ${CONFIG_PATH} (${options.machinery.reason}) — which machine this epic gets is UNKNOWN, and a machine is emitted once, so nothing was emitted.`,
			);
		}
		const emitted = emitMachine(options.epic, target.issue.body, listed.value, {
			machinery: options.machinery.value.onEmit === "on",
			dropForeign: options.children,
		});
		if (emitted._tag !== "Emitted") return emitRefusal(options.epic, emitted);
		const ref: LaneRef = {root: options.root, lane: String(options.epic)};
		const capped = yield* capRefusal(VERB, options.cap, options.root, options.claimed);
		if (capped !== null) return capped;
		const placed = yield* placeMachine(ref, emitted.text);
		if (placed._tag === "Exists") {
			return refuse(
				LANE_EXISTS,
				`${VERB}: a lane already exists at ${placed.dir} — resuming needs no boot, and a lane on disk is never re-emitted over. If it runs the wrong machine — \`fabrika lane migrate --check\` answers 46 and names it — the remedy is exactly two steps: retire ${placed.dir}, then re-run \`${VERB} ${options.epic}\`.`,
			);
		}
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed);
		const dropped = capAndCount(emitted.dropped, DROPPED_CAP);
		return answer(
			JSON.stringify({
				answer: "emitted",
				epic: options.epic,
				workflow: placed.workflow,
				phases: emitted.phases,
				children: emitted.children,
				dropped: {count: emitted.dropped.length, ...dropped},
				bytes: new TextEncoder().encode(emitted.text).length,
			}),
			[
				`${VERB}: read #${options.epic} and ${listed.value.length} sub-issue link(s) from ${resolved.repo}.`,
				...(emitted.dropped.length === 0
					? []
					: [
							`${VERB}: --children dropped ${emitted.dropped.length} ref(s) #${options.epic}'s topology names and its child list does not: ${droppedList(emitted.dropped)}.`,
						]),
			],
		);
	});
