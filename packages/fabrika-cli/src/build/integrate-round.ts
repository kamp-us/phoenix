/**
 * The integrate `FAIL` standing over an epic child, read off its epic lane's ledger for `build claim`.
 *
 * A child that passed review and then failed `lane integrate` carries only `PASS` range verdicts, so
 * the comments alone read it as finished. The machine sent it back to `build` all the same, and the
 * one record of why is the `FAIL` line `lane report` wrote with the exit and assembly head on it
 * (`../lane/integrate-failure.ts`). The ledger is local to the driver's machine, so the caller names
 * it — the `lane` and `root` its brief carries — and nothing here guesses a path.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9761
 */
import {Effect, type FileSystem, type Path} from "effect";
import {childTaskId} from "../lane/emit.ts";
import {
	INTEGRATE_STATE,
	type IntegrateFailure,
	standingIntegrateFailure,
} from "../lane/integrate-failure.ts";
import {loadLane} from "../lane/store.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, WRONG_LANE} from "./codes.ts";

/** The epic lane a child's claim reads, as the brief names it: its key and its lanes root. */
export interface ChildLedger {
	readonly lane: string;
	readonly root: string;
}

export type LedgerFlags =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Read"; readonly ledger: ChildLedger | null};

/** `--lane` and `--lane-root` are one address: both or neither, and neither may be blank. */
export const readLedgerFlags = (
	verb: string,
	lane: string | null,
	root: string | null,
): LedgerFlags => {
	if (lane === null && root === null) return {_tag: "Read", ledger: null};
	if (lane === null || root === null || lane.trim() === "" || root.trim() === "") {
		return {
			_tag: "Refused",
			outcome: refuse(
				FAILED,
				`${verb}: --lane and --lane-root name one ledger — pass both, as the brief's \`lane\` and \`root\`, or neither; nothing was written.`,
			),
		};
	}
	return {_tag: "Read", ledger: {lane: lane.trim(), root: root.trim()}};
};

export type IntegrateRound =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Read";
			readonly failure: IntegrateFailure | null;
			readonly notes: ReadonlyArray<string>;
	  };

/**
 * Read the ledger and answer the child's standing integrate `FAIL`, or `null`.
 *
 * Every read that did not answer is UNKNOWN, never "no integrate FAIL": a ledger that is not there,
 * cannot be read or is not the shape refuses on `11`, and a ledger holding no task for this child is
 * the wrong lane, `14` — reading it as "nothing recorded" would refuse a repair that is owed.
 */
export const readIntegrateRound = (
	verb: string,
	ledger: ChildLedger,
	child: number,
	lines: ReadonlyArray<string>,
): Effect.Effect<IntegrateRound, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(ledger);
		if (loaded._tag !== "Loaded") {
			const what =
				loaded._tag === "Absent"
					? `no lane at ${loaded.dir}`
					: loaded._tag === "Unreadable"
						? `cannot read ${loaded.path}: ${loaded.reason}`
						: `${loaded.path} is not the shape: ${loaded.defects.join("; ")}`;
			return {
				_tag: "Refused",
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: ${what} — whether #${child} holds an integrate FAIL is UNKNOWN, never "no"; nothing was written.`,
					lines,
				),
			};
		}
		const task = childTaskId(child);
		if (loaded.lane.tasks[task] === undefined) {
			return {
				_tag: "Refused",
				outcome: refuse(
					WRONG_LANE,
					`${verb}: lane ${ledger.lane} holds no task ${task} — it is not #${child}'s epic lane, so it records nothing about this child; nothing was written.`,
					lines,
				),
			};
		}
		const failure = standingIntegrateFailure(loaded.entries, task);
		return {
			_tag: "Read",
			failure,
			notes: [
				failure === null
					? `${verb}: lane ${ledger.lane} records no standing ${INTEGRATE_STATE} FAIL for ${task}.`
					: `${verb}: lane ${ledger.lane} records a standing ${INTEGRATE_STATE} FAIL for ${task} — lane integrate exit ${failure.exit} against assembly head ${failure.head}.`,
			],
		};
	});
