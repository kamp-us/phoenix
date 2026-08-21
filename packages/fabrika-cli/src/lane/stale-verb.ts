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
 *
 * The sweep is **offline unless a caller asks for more**. A session limit strands a lane's state and
 * the claim marker its dead builder left on the issue, and only the first is on disk (#6771) — so
 * `claims` pairs the second onto each non-terminal row. It is a reader the caller passes rather than
 * a flag this module reads, which is what keeps the default provable: with no reader there is no
 * seam to reach the board through.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {Claimants} from "../build/claim.ts";
import {exists, readDir} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {deriveStatus, foldLog, type LaneStatus} from "./fold.ts";
import {CHORE_PREFIX} from "./key.ts";
import {type Judgement, judge, lastMoved, type Verdict} from "./stale.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";

const VERB = "fabrika lane stale";

/** The board read that pairs one issue with its claim state — the sweep's only network seam. */
export type ClaimReader<R> = (number: number) => Effect.Effect<Claimants, never, R>;

export interface StaleOptions<R = never> {
	/** The lane roots to sweep, in order. An absent root is an empty one, not a fault. */
	readonly roots: ReadonlyArray<string>;
	readonly olderThanMinutes: number;
	/** The instant the ages are measured against, ISO — the adapter's clock, so the verb stays pure. */
	readonly now: string;
	/** The claim reader, or `null` for the offline sweep every caller gets by default. */
	readonly claims: ClaimReader<R> | null;
}

/**
 * What the board says about the issue a lane drives.
 *
 * `unknown` is a seat rather than an absent field for the reason every read in this protocol keeps
 * it: a comment page that did not load says nothing about whether a claim stands, and calling it
 * `unclaimed` would tell a driver an issue is free to pick up when it may not be.
 */
type LaneClaim =
	| {
			readonly state: "held";
			readonly token: string;
			/** The session to name in `build adopt --session` when that session is gone. */
			readonly session: string;
			readonly author: string;
			readonly commentId: number;
	  }
	| {readonly state: "unclaimed"}
	| {readonly state: "unknown"; readonly reason: string};

interface LaneRow extends Judgement {
	/** The key this lane is addressed by — what a caller passes to any other `lane` verb. */
	readonly key: string;
	readonly root: string;
	readonly stateValue: LaneStatus["stateValue"] | null;
	readonly status: LaneStatus["status"] | null;
	/** Why the lane could not be judged; absent on every readable lane. */
	readonly reason?: string;
	/** The claim on this lane's issue; absent unless a reader was passed and this row was paired. */
	readonly claims?: LaneClaim;
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

/**
 * The issue a lane key names, or `null` when it names none.
 *
 * A chore lane is keyed `chore:<name>` and drives no issue, so there is no thread to pair it with —
 * and a claim is a fact about an issue, never about a lane directory.
 */
const issueOf = (key: string): number | null =>
	/^[0-9]+$/.test(key) ? Number.parseInt(key, 10) : null;

/** The row plus what the board says about its issue — a terminal lane and a chore lane are skipped. */
const pair = <R>(row: LaneRow, read: ClaimReader<R>): Effect.Effect<LaneRow, never, R> =>
	Effect.gen(function* () {
		const issue = issueOf(row.key);
		if (issue === null || row.verdict === "terminal") return row;
		const claimants = yield* read(issue);
		if (claimants._tag === "Unknown") {
			return {...row, claims: {state: "unknown" as const, reason: claimants.reason}};
		}
		const holder = claimants.holder;
		return {
			...row,
			claims:
				holder === null
					? {state: "unclaimed" as const}
					: {
							state: "held" as const,
							token: holder.token,
							session: holder.session,
							author: holder.author,
							commentId: holder.commentId,
						},
		};
	});

export const runStale = <R = never>(
	options: StaleOptions<R>,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path | R> =>
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
		const reader = options.claims;
		const paired: LaneRow[] =
			reader === null
				? lanes
				: yield* Effect.forEach(lanes, (row) => pair(row, reader), {concurrency: 1});
		const sorted = [...paired].sort(byAge);
		const stale = sorted.filter((row) => row.verdict === "stale");
		const held = sorted.flatMap((row) =>
			row.claims?.state === "held" ? [`${row.key} (${row.claims.token})`] : [],
		);
		const unknown = sorted.flatMap((row) => (row.claims?.state === "unknown" ? [row.key] : []));
		return answer(
			JSON.stringify(
				{
					now: options.now,
					olderThanMinutes: options.olderThanMinutes,
					scanned,
					summary,
					// `null` says the board was never asked, which "nothing is held" would silently claim.
					claims:
						reader === null
							? null
							: {
									paired: sorted.filter((row) => row.claims !== undefined).length,
									held: held.length,
									unclaimed: sorted.filter((row) => row.claims?.state === "unclaimed").length,
									unknown: unknown.length,
								},
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
				...(reader === null
					? []
					: [
							held.length === 0
								? `${VERB}: no non-terminal lane's issue carries a live claim.`
								: `${VERB}: ${held.length} lane(s) whose issue is still claimed: ${held.join(
										", ",
									)} — a claim clears through "fabrika build adopt" then "fabrika build release", never on its own (ADR 0295).`,
						]),
				...(unknown.length === 0
					? []
					: [
							`${VERB}: ${unknown.length} lane(s) whose claim state could not be read: ${unknown.join(
								", ",
							)} — UNKNOWN, never "unclaimed".`,
						]),
			],
		);
	});
