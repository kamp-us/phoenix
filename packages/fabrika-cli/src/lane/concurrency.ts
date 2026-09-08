/**
 * How many seats the lanes root is holding, and the refusal a boot takes when the repo's declared
 * `laneConcurrencyCap` is full.
 *
 * The count is over the boot's own root and nothing beside it, which is what keeps
 * `.fabrika/lanes-archived` and `.fabrika/chores` out of it without either name appearing here: both
 * are sibling roots, so a lane archived is a lane already gone from this read, and a
 * chore lane is counted by nobody.
 *
 * **A seat is a lane somebody is driving.** A lane whose log folds to `active` holds one only while
 * its issue carries a live `lane claim` marker; an active lane nobody claims is idle, and it is
 * named separately in the refusal rather than counted. The cap was counting every unsettled
 * directory, so finished lanes refused every boot against a live driver count of one. There is no
 * TTL and no heartbeat on the marker — a claim ends when its driver releases it.
 *
 * **What cannot be read still counts.** A lane whose record will not load, whose log will not replay,
 * or whose claim the board would not answer for is not finished — it is a seat nobody can account for
 * — so it counts, and the refusal names it as such. Reading any of those the other way is the
 * permissive arm: a stale directory would silently raise the cap the operator set. The remedy for a
 * dead seat is `lane archive`, `lane settle` or `lane reconcile`, and the refusal says so.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "../config/document.ts";
import {LANE_CONCURRENCY_CAP} from "../config/keys/lane-concurrency-cap.ts";
import type {Read} from "../config/read-key.ts";
import {exists, readDir} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {CONCURRENCY_CAPPED, LANE_UNREADABLE} from "./codes.ts";
import {deriveStatus, foldLog, standingCauses} from "./fold.ts";
import {loadLane} from "./store.ts";

/** One lane holding a seat, and why it is not free. */
export interface Seat {
	readonly lane: string;
	/**
	 * `claimed` where its log folds to `active` and a live `lane claim` marker holds it; `unaccountable`
	 * where the record would not load, would not replay, or whose claim the board would not answer for.
	 */
	readonly held: "claimed" | "unaccountable";
}

export type Seats =
	| {
			readonly _tag: "Counted";
			readonly seats: ReadonlyArray<Seat>;
			/** Active lanes no driver claims — carried through so the refusal can name the number. */
			readonly idle: ReadonlyArray<string>;
	  }
	/** The root itself could not be listed — how full it is is UNKNOWN, never zero. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** Numeric lane ids in numeric order, so a refusal reads the same twice over one root. */
const byLane = (a: string, b: string): number => Number(a) - Number(b) || a.localeCompare(b);

export const seatsIn = <R = never>(
	root: string,
	claimed: ClaimHoldReader<R>,
): Effect.Effect<Seats, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const there = yield* Effect.result(exists(root));
		if (there._tag === "Failure") {
			return {_tag: "Unreadable", reason: there.failure.reason} as const;
		}
		if (!there.success) return {_tag: "Counted", seats: [], idle: []} as const;
		const listed = yield* Effect.result(readDir(root));
		if (listed._tag === "Failure") {
			return {_tag: "Unreadable", reason: listed.failure.reason} as const;
		}
		const seats: Seat[] = [];
		const idle: string[] = [];
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
			if (status.status !== "active") continue;
			const hold = yield* claimed(lane);
			if (hold._tag === "Unknown") seats.push({lane, held: "unaccountable"});
			else if (hold._tag === "Claimed") seats.push({lane, held: "claimed"});
			else idle.push(lane);
		}
		return {
			_tag: "Counted",
			seats: [...seats].sort((a, b) => byLane(a.lane, b.lane)),
			idle: [...idle].sort(byLane),
		} as const;
	});

const seatList = (seats: ReadonlyArray<Seat>): string =>
	seats
		.map((seat) => (seat.held === "claimed" ? `#${seat.lane}` : `#${seat.lane} (unaccountable)`))
		.join(", ");

/**
 * The refusal a boot owes the declared cap, or `null` where it may proceed.
 *
 * There is no `--override` and no environment escape, by design: a cap you can step around on the
 * machine it protects is the spoken instruction again. Raising the number in {@link CONFIG_PATH} is
 * the override, and it is the only one.
 */
export const capRefusal = <R = never>(
	verb: string,
	cap: Read<number | null>,
	root: string,
	claimed: ClaimHoldReader<R>,
): Effect.Effect<VerbOutcome | null, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (cap._tag === "Refused") {
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot read \`${LANE_CONCURRENCY_CAP}\` from ${CONFIG_PATH} (${cap.reason}) — how many lanes this repo allows is UNKNOWN, and nothing was booted.`,
			);
		}
		const limit = cap.value;
		if (limit === null) return null;
		const counted = yield* seatsIn(root, claimed);
		if (counted._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot list ${root} to count the lanes standing against \`${LANE_CONCURRENCY_CAP}\` (${counted.reason}) — nothing was booted.`,
			);
		}
		const {seats, idle} = counted;
		if (seats.length < limit) return null;
		const idleNote =
			idle.length === 0
				? "No other lane under this root is active and unclaimed."
				: `${idle.length} further active lane(s) under this root carry no live \`lane claim\` and are idle, so they hold nothing: ${idle.map((lane) => `#${lane}`).join(", ")}.`;
		return refuse(
			CONCURRENCY_CAPPED,
			`${verb}: ${CONFIG_PATH} caps this repo at ${limit} lane(s) and ${root} holds ${seats.length} claimed — ${seatList(seats)}. ${idleNote} Nothing was booted. Drive one of the claimed lanes to done and \`fabrika lane archive <n>\` it (\`fabrika lane reconcile\` first if its ledger is behind the board), or release its claim; an unaccountable seat is freed the same way, never by a cap that ignores it. There is no override flag: raising \`${LANE_CONCURRENCY_CAP}\` in ${CONFIG_PATH} is how the number changes.`,
		);
	});
