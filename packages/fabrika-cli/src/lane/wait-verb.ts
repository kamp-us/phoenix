/**
 * `lane wait` — record that a lane is waiting on something until a date.
 *
 * A quiet lane is flagged as stuck, and a lane that is quiet on purpose says so here: the latest
 * declaration stands until its date, and the lane's record shows it. It writes a fact, never an
 * event, so the machine is untouched and the fold cannot be moved by it. The append runs under the
 * ledger lock, so it cannot interleave with a writer of the same lane.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9855
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {instant, waitingOn} from "../wire/lane-record.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CONCURRENT_WRITE,
	FACT_REFUSED,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
} from "./codes.ts";
import {encodeFact, loadFacts} from "./facts.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane wait";

export interface WaitOptions extends LaneRef {
	readonly on: string;
	readonly until: string;
}

export const runWait = (
	options: WaitOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const on = options.on.trim();
		if (!waitingOn(on)) {
			return refuse(
				FACT_REFUSED,
				`${VERB}: --on must name what the lane waits on in one non-blank line. Nothing was appended.`,
			);
		}
		const until = instant(options.until);
		const now = yield* Effect.sync(() => new Date());
		if (until === null || Date.parse(until) <= now.getTime()) {
			return refuse(
				FACT_REFUSED,
				`${VERB}: --until "${options.until}" is not an ISO date still to come — a wait that has already lapsed keeps nothing unflagged. Nothing was appended.`,
			);
		}
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dir = path.join(options.root, options.lane);
		return yield* withLedgerLock(
			{fs, path, dir, verb: VERB},
			Effect.gen(function* () {
				const loaded = yield* loadLane(options);
				if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
				const facts = yield* loadFacts(loaded.dir);
				if (facts._tag === "Unreadable") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot read ${facts.path}: ${facts.reason} — nothing was appended.`,
					);
				}
				if (facts._tag === "Malformed") {
					return refuse(
						MALFORMED_RECORD,
						`${VERB}: ${facts.path} was read in full and is not the shape — nothing was appended.`,
						facts.defects.map((defect) => `${VERB}: defect: ${defect}`),
					);
				}
				const at = instant(now.toISOString());
				if (at === null)
					return refuse(FACT_REFUSED, `${VERB}: the clock gave no instant — nothing was appended.`);
				const wrote = yield* Effect.result(
					appendText(facts.path, encodeFact({kind: "waiting", on, until, at})),
				);
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the append to ${facts.path} did not land: ${wrote.failure.reason} — the wait is NOT recorded.`,
					);
				}
				return answer(JSON.stringify({answer: "waiting", lane: options.lane, on, until}), [
					`${VERB}: lane ${options.lane} waits on ${on} until ${until}.`,
				]);
			}),
			{
				onAbsent: (absentDir) => loadRefusal(VERB, {_tag: "Absent", dir: absentDir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
			},
		);
	});
