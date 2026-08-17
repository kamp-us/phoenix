/**
 * `lane stale` — every lane on disk, with how long since it moved, and which ones nothing is driving.
 *
 * The one verb in the group that reads across lanes rather than into one, because the question it
 * answers is a sweep: a driver (or a cron) asks which lanes are non-terminal and have gone quiet, and
 * gets a list. It writes nothing and stores nothing — the age comes off the `at` each event line
 * already carries (#5897).
 *
 * A lane that could not be read is a row, not the end of the sweep: refusing the whole answer over
 * one broken lane would hide every other lane's silence, which is the failure this verb exists to
 * end. The sweep itself refuses only when a root it was asked to scan is there and cannot be listed —
 * that leaves the lane set UNKNOWN, and an UNKNOWN lane set is never a short list.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, readDir} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {deriveStatus, foldLog, type LaneStatus} from "./fold.ts";
import {CHORE_PREFIX} from "./key.ts";
import {type Judgement, judge, lastMoved, type Verdict} from "./stale.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";

const VERB = "fabrika lane stale";

export interface StaleOptions {
	/** The lane roots to sweep, in order. An absent root is an empty one, not a fault. */
	readonly roots: ReadonlyArray<string>;
	readonly olderThanMinutes: number;
	/** The instant the ages are measured against, ISO — the adapter's clock, so the verb stays pure. */
	readonly now: string;
}

interface LaneRow extends Judgement {
	/** The key this lane is addressed by — what a caller passes to any other `lane` verb. */
	readonly key: string;
	readonly root: string;
	readonly stateValue: LaneStatus["stateValue"] | null;
	readonly status: LaneStatus["status"] | null;
	/** Why the lane could not be judged; absent on every readable lane. */
	readonly reason?: string;
}

interface ScannedRoot {
	readonly root: string;
	/** Whether the root directory is there at all — an absent root holds no lanes and is not a fault. */
	readonly present: boolean;
	readonly lanes: number;
}

const VERDICTS: ReadonlyArray<Verdict> = [
	"stale",
	"moving",
	"parked",
	"terminal",
	"unstarted",
	"unreadable",
];

/** How a caller addresses this lane: a chore root's entries are keyed `chore:<name>` (`key.ts`). */
const keyOf = (root: string, name: string): string =>
	root === DEFAULT_CHORES_ROOT ? `${CHORE_PREFIX}${name}` : name;

const unreadableRow = (key: string, root: string, reason: string): LaneRow => ({
	key,
	root,
	stateValue: null,
	status: null,
	verdict: "unreadable",
	ageMinutes: null,
	lastEventAt: null,
	reason,
});

/** Read and judge one lane directory. `null` when the entry holds no lane at all. */
const judgeLane = (
	root: string,
	name: string,
	nowEpochMs: number,
	olderThanMinutes: number,
): Effect.Effect<LaneRow | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const key = keyOf(root, name);
		const loaded = yield* loadLane({root, lane: name});
		// An entry with no workflow.json is not a lane — a scratch directory under the root is not a
		// silence to report, and calling it one would put noise in front of every real stall.
		if (loaded._tag === "Absent") return null;
		if (loaded._tag === "Unreadable") {
			return unreadableRow(key, root, `cannot read ${loaded.path}: ${loaded.reason}`);
		}
		if (loaded._tag === "Malformed") {
			return unreadableRow(
				key,
				root,
				`${loaded.path} is not the shape: ${loaded.defects.join("; ")}`,
			);
		}
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") {
			return unreadableRow(
				key,
				root,
				`${loaded.logPath} does not replay: ${fold.defects.join("; ")}`,
			);
		}
		const status = deriveStatus(loaded.lane, fold.states);
		const judged = judge(
			status,
			lastMoved(loaded.entries.map((entry) => entry.at)),
			nowEpochMs,
			olderThanMinutes,
		);
		const row: LaneRow = {
			key,
			root,
			stateValue: status.stateValue,
			status: status.status,
			...judged,
		};
		return judged.verdict === "unreadable"
			? {...row, reason: `${loaded.logPath} carries no parseable \`at\``}
			: row;
	});

/** Oldest silence first, then the ages nobody can compute, then alphabetically — stable per run. */
const byAge = (left: LaneRow, right: LaneRow): number => {
	if (left.ageMinutes !== right.ageMinutes) {
		if (left.ageMinutes === null) return 1;
		if (right.ageMinutes === null) return -1;
		return right.ageMinutes - left.ageMinutes;
	}
	return left.key.localeCompare(right.key);
};

export const runStale = (
	options: StaleOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (!Number.isFinite(options.olderThanMinutes) || options.olderThanMinutes < 0) {
			return refuse(FAILED, `${VERB}: --older-than must be a non-negative number of minutes.`);
		}
		const nowEpochMs = Date.parse(options.now);
		if (Number.isNaN(nowEpochMs)) {
			return refuse(FAILED, `${VERB}: "${options.now}" is not an instant to measure ages against.`);
		}

		const scanned: ScannedRoot[] = [];
		const lanes: LaneRow[] = [];
		for (const root of options.roots) {
			const probe = yield* Effect.result(exists(root));
			if (Result.isFailure(probe)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether ${root} is there: ${probe.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			if (!probe.success) {
				scanned.push({root, present: false, lanes: 0});
				continue;
			}
			const names = yield* Effect.result(readDir(root));
			if (Result.isFailure(names)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot list ${root}: ${names.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			let found = 0;
			for (const name of [...names.success].sort()) {
				const row = yield* judgeLane(root, name, nowEpochMs, options.olderThanMinutes);
				if (row === null) continue;
				found += 1;
				lanes.push(row);
			}
			scanned.push({root, present: true, lanes: found});
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const sorted = [...lanes].sort(byAge);
		const stale = sorted.filter((row) => row.verdict === "stale");
		return answer(
			JSON.stringify(
				{
					now: options.now,
					olderThanMinutes: options.olderThanMinutes,
					scanned,
					summary,
					lanes: sorted,
				},
				null,
				2,
			),
			[
				`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}.`,
				stale.length === 0
					? `${VERB}: no lane has been silent for ${options.olderThanMinutes} minute(s) with something owed on it.`
					: `${VERB}: ${stale.length} stale: ${stale.map((row) => `${row.key} (${String(row.ageMinutes)}m)`).join(", ")}.`,
			],
		);
	});
