/**
 * How many seats the lanes root is holding, and the refusal a boot takes when the repo's declared
 * `laneConcurrencyCap` is full.
 *
 * The count is over the boot's own root and nothing beside it, which is what keeps
 * `.fabrika/lanes-archived` and `.fabrika/chores` out of it without either name appearing here: both
 * are sibling roots, so a lane archived is a lane already gone from this read, and a
 * chore lane is counted by nobody.
 *
 * **Only a lane proven done frees its seat.** A lane whose record will not load or whose log will not
 * replay is not finished — it is a seat nobody can account for — so it counts, and the refusal names
 * it as such. Reading it the other way is the permissive arm: a stale directory would silently raise
 * the cap the operator set, which is the spoken-instruction failure all over again. The remedy for a
 * dead seat is `lane archive` or `lane reconcile`, and the refusal says so.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "../config/document.ts";
import {LANE_CONCURRENCY_CAP} from "../config/keys/lane-concurrency-cap.ts";
import type {Read} from "../config/read-key.ts";
import {exists, readDir} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {CONCURRENCY_CAPPED, LANE_UNREADABLE} from "./codes.ts";
import {deriveStatus, foldLog, standingCauses} from "./fold.ts";
import {loadLane} from "./store.ts";

/** One lane holding a seat, and why it is not free. */
export interface Seat {
	readonly lane: string;
	/** `active` folded from its log; `unaccountable` where the record would not load or replay. */
	readonly held: "active" | "unaccountable";
}

export type Seats =
	| {readonly _tag: "Counted"; readonly seats: ReadonlyArray<Seat>}
	/** The root itself could not be listed — how full it is is UNKNOWN, never zero. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** Numeric lane ids in numeric order, so a refusal reads the same twice over one root. */
const ordered = (seats: ReadonlyArray<Seat>): ReadonlyArray<Seat> =>
	[...seats].sort((a, b) => Number(a.lane) - Number(b.lane) || a.lane.localeCompare(b.lane));

export const seatsIn = (
	root: string,
): Effect.Effect<Seats, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const there = yield* Effect.result(exists(root));
		if (there._tag === "Failure") {
			return {_tag: "Unreadable", reason: there.failure.reason} as const;
		}
		if (!there.success) return {_tag: "Counted", seats: []} as const;
		const listed = yield* Effect.result(readDir(root));
		if (listed._tag === "Failure") {
			return {_tag: "Unreadable", reason: listed.failure.reason} as const;
		}
		const seats: Seat[] = [];
		for (const lane of listed.success) {
			const loaded = yield* loadLane({root, lane});
			// A directory with no workflow.json is not a lane, so it is not a seat — the same read
			// `lane reconcile` makes of a scratch directory under the root.
			if (loaded._tag === "Absent") continue;
			if (loaded._tag !== "Loaded") {
				seats.push({lane, held: "unaccountable"});
				continue;
			}
			const folded = foldLog(loaded.lane, loaded.entries);
			if (folded._tag !== "Folded") {
				seats.push({lane, held: "unaccountable"});
				continue;
			}
			const status = deriveStatus(loaded.lane, folded.states, standingCauses(loaded.entries));
			if (status.status === "active") seats.push({lane, held: "active"});
		}
		return {_tag: "Counted", seats: ordered(seats)} as const;
	});

const seatList = (seats: ReadonlyArray<Seat>): string =>
	seats
		.map((seat) => (seat.held === "active" ? `#${seat.lane}` : `#${seat.lane} (unaccountable)`))
		.join(", ");

/**
 * The refusal a boot owes the declared cap, or `null` where it may proceed.
 *
 * There is no `--override` and no environment escape, by design: a cap you can step around on the
 * machine it protects is the spoken instruction again. Raising the number in {@link CONFIG_PATH} is
 * the override, and it is the only one.
 */
export const capRefusal = (
	verb: string,
	cap: Read<number | null>,
	root: string,
): Effect.Effect<VerbOutcome | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (cap._tag === "Refused") {
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot read \`${LANE_CONCURRENCY_CAP}\` from ${CONFIG_PATH} (${cap.reason}) — how many lanes this repo allows is UNKNOWN, and nothing was booted.`,
			);
		}
		const limit = cap.value;
		if (limit === null) return null;
		const counted = yield* seatsIn(root);
		if (counted._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot list ${root} to count the lanes standing against \`${LANE_CONCURRENCY_CAP}\` (${counted.reason}) — nothing was booted.`,
			);
		}
		const {seats} = counted;
		if (seats.length < limit) return null;
		return refuse(
			CONCURRENCY_CAPPED,
			`${verb}: ${CONFIG_PATH} caps this repo at ${limit} lane(s) and ${root} already holds ${seats.length} — ${seatList(seats)}. Nothing was booted. Drive one of them to done and \`fabrika lane archive <n>\` it (\`fabrika lane reconcile\` first if its ledger is behind the board); an unaccountable seat is freed the same way, never by a cap that ignores it. There is no override flag: raising \`${LANE_CONCURRENCY_CAP}\` in ${CONFIG_PATH} is how the number changes.`,
		);
	});
