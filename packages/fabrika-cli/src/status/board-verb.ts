/**
 * `status board` — counts of the board's decided buckets, each with its own freshness.
 *
 * **Counts only.** `fabrika build pick` and `build eligible` answer which issue is next and
 * `build verdicts` / `ship gate` answer a pull request's state; a second answer here could
 * contradict the verb that actually claims the work. There is no "banked" bucket either — what
 * marks a pull request banked is an open decision.
 *
 * **An absent label renders `absent`, never `0` and never `unknown`.** A zero count means the label
 * exists and nothing carries it; an absent label means the question was never askable — the shape
 * where a fresh repo would be told its queue is clear. The label set was read, so the absence is
 * proven: only a label set that could not be read makes a bucket `unknown`.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {scannedLine} from "../build/target.ts";
import type {StatusNames} from "../config/board.ts";
import type {Shell} from "../io/git.ts";
import {openPullRequests} from "../io/github.ts";
import {listLabels, openIssuesWithLabel} from "../io/issues.ts";
import {PRIORITIES} from "../triage/facets.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, instant, noAsOf, readNow, row} from "./fields.ts";
import {BOARD_SUBJECT, readBoard as readRepoBoard, refusalReason} from "./repo-board.ts";

const VERB = "status board";

/** The verb that creates every label an `absent` bucket names. */
export const LABEL_TAXONOMY_COMMAND = "fabrika status bootstrap label-taxonomy";

/** The label whose absence makes a bucket unaskable, and the selector printed for it. */
const labelBucket = (name: string, label: string) => ({
	name,
	label,
	selector: `labels=${label}`,
});

/**
 * The label buckets, each with the REST call that produces it — never GitHub search syntax, which
 * caps at 1000 results and cannot back a count. A bucket's name is its role and stays put; its
 * label is whatever this board calls that status.
 */
export const labelBuckets = (statuses: StatusNames) => [
	labelBucket("needs-triage", statuses.needsTriage),
	labelBucket("triaged", statuses.triaged),
	...PRIORITIES.map((priority) => labelBucket(priority, priority)),
];

/** The pull-request bucket, read off `/pulls` rather than `/issues` — it counts PRs on purpose. */
export const IN_FLIGHT = {name: "in-flight", selector: "pulls?state=open"} as const;

/**
 * What one bucket's read established: a count, a label the repository proved it lacks, or nothing.
 * `Absent` is a proven negative and `Unknown` a failed read, so neither carries a count.
 */
export type BucketReading =
	| {readonly _tag: "Counted"; readonly count: number; readonly asOf: AsOf}
	| {readonly _tag: "Absent"; readonly label: string; readonly asOf: AsOf}
	| {readonly _tag: "Unknown"; readonly reason: string};

export interface Bucket {
	readonly name: string;
	readonly selector: string;
	readonly reading: BucketReading;
}

/** The number a counted bucket carries; `null` for a bucket that has none to carry. */
export const bucketCount = (reading: BucketReading): number | null =>
	reading._tag === "Counted" ? reading.count : null;

export const bucketDetail = (reading: BucketReading): string | null =>
	reading._tag === "Counted"
		? null
		: reading._tag === "Absent"
			? detail(`label ${reading.label} absent`)
			: detail(reading.reason);

export const bucketState = (reading: BucketReading): "counted" | "absent" | "unknown" =>
	reading._tag === "Counted" ? "counted" : reading._tag === "Absent" ? "absent" : "unknown";

export const bucketAsOf = (reading: BucketReading): AsOf =>
	reading._tag === "Unknown" ? noAsOf : reading.asOf;

export type BoardRead =
	/**
	 * The repository could not be read at all, or its config gave no board to name the status
	 * buckets by — every bucket is UNKNOWN, so there is no readout.
	 */
	| {readonly _tag: "Failed"; readonly repo: string; readonly reason: string}
	| {readonly _tag: "Read"; readonly repo: string; readonly buckets: ReadonlyArray<Bucket>};

const unknownBucket = (name: string, selector: string, reason: string): Bucket => ({
	name,
	selector,
	reading: {_tag: "Unknown", reason},
});

const countedBucket = (name: string, selector: string, count: number, at: Date): Bucket => ({
	name,
	selector,
	reading: {_tag: "Counted", count, asOf: readNow(instant(at))},
});

/**
 * Read every bucket.
 *
 * The label set is read first because it is what separates the two negative answers: with it in
 * hand a `0` is proven, and an absent label is proven `Absent` — the unasked question it is. When the
 * label read itself fails, every label bucket is UNKNOWN — a count taken without it could not be
 * told apart from a proven zero.
 */
const readBuckets = (repo: string, statuses: StatusNames, now: () => Date): Shell<BoardRead> =>
	Effect.gen(function* () {
		const labels = yield* listLabels(repo);
		const labelFailure = labels._tag === "Failure" ? labels.reason : null;
		const known = labels._tag === "Ok" ? new Set(labels.value) : null;
		const buckets: Bucket[] = [];

		for (const bucket of labelBuckets(statuses)) {
			if (known === null) {
				buckets.push(
					unknownBucket(
						bucket.name,
						bucket.selector,
						`${labelFailure ?? "unreadable"} — the label set is UNKNOWN`,
					),
				);
				continue;
			}
			if (!known.has(bucket.label)) {
				buckets.push({
					name: bucket.name,
					selector: bucket.selector,
					reading: {_tag: "Absent", label: bucket.label, asOf: readNow(instant(now()))},
				});
				continue;
			}
			const rows = yield* openIssuesWithLabel(repo, bucket.label);
			if (rows._tag === "Failure") {
				buckets.push(unknownBucket(bucket.name, bucket.selector, rows.reason));
				continue;
			}
			buckets.push(countedBucket(bucket.name, bucket.selector, rows.value.length, now()));
		}

		const pulls = yield* openPullRequests(repo);
		if (pulls._tag === "Failure") {
			buckets.push(unknownBucket(IN_FLIGHT.name, IN_FLIGHT.selector, pulls.reason));
		} else {
			buckets.push(countedBucket(IN_FLIGHT.name, IN_FLIGHT.selector, pulls.value.length, now()));
		}

		return buckets.every((bucket) => bucket.reading._tag === "Unknown")
			? ({
					_tag: "Failed",
					repo,
					reason: labels._tag === "Failure" ? labels.reason : "every bucket read failed",
				} as const)
			: ({_tag: "Read", repo, buckets: ordered(buckets)} as const);
	});

/**
 * Read every bucket of the board the repo above `cwd` declares.
 *
 * A refused config is `Failed`, never a count under the shipped names: a repo that renamed a status
 * carries no issue under the old label, so that read would report its queue clear.
 */
export const readBoard = (
	repo: string,
	cwd: string,
	now: () => Date,
): Effect.Effect<
	BoardRead,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const board = yield* readRepoBoard(cwd);
		if (board._tag === "Refused") {
			return {
				_tag: "Failed" as const,
				repo,
				reason: `${BOARD_SUBJECT} is refused — ${refusalReason(board)}`,
			};
		}
		return yield* readBuckets(repo, board.resolved.board.statuses, now);
	});

/** The fixed print order: the two queue buckets, in-flight, then the priorities. */
const ordered = (buckets: ReadonlyArray<Bucket>): ReadonlyArray<Bucket> => {
	const order = ["needs-triage", "triaged", IN_FLIGHT.name, ...PRIORITIES];
	return [...buckets].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
};

/**
 * The board's header state. One unread bucket makes the whole board `unknown`, because nothing
 * about it can be presented as clear; with every bucket read, one proven-missing label makes it
 * `absent`.
 */
export type BoardState = "counted" | "absent" | "unknown";

export const boardState = (buckets: ReadonlyArray<Bucket>): BoardState =>
	buckets.some((bucket) => bucket.reading._tag === "Unknown")
		? "unknown"
		: buckets.some((bucket) => bucket.reading._tag === "Absent")
			? "absent"
			: "counted";

/** The labels the repository proved it lacks, in bucket order. */
export const absentLabels = (buckets: ReadonlyArray<Bucket>): ReadonlyArray<string> =>
	buckets.flatMap((bucket) => (bucket.reading._tag === "Absent" ? [bucket.reading.label] : []));

export interface BoardInput {
	readonly read: BoardRead;
	readonly json: boolean;
}

export const runBoard = ({read, json}: BoardInput): VerbOutcome => {
	if (read._tag === "Failed") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`${VERB}: cannot read ${read.repo}: ${read.reason} — every bucket is UNKNOWN, never 0.`,
		);
	}
	const state = boardState(read.buckets);
	const unknown = read.buckets.filter((bucket) => bucket.reading._tag === "Unknown");
	const absent = read.buckets.filter((bucket) => bucket.reading._tag === "Absent");
	const missing = absentLabels(read.buckets);
	const counted = read.buckets.reduce((sum, bucket) => sum + (bucketCount(bucket.reading) ?? 0), 0);
	const names = (group: ReadonlyArray<Bucket>) =>
		group.map((bucket) => bucket.name).join(",") || EMPTY_CELL;
	const notices = [
		scannedLine(
			VERB,
			counted,
			"item",
			`counted ${read.buckets.length} buckets over ${read.repo}, ${unknown.length} unknown (${names(
				unknown,
			)}), ${absent.length} absent (${names(absent)})`,
		),
		...(missing.length > 0
			? [
					`${VERB}: ${missing.join(",")} ${missing.length === 1 ? "is" : "are"} not on ${read.repo} — create them with ${LABEL_TAXONOMY_COMMAND}.`,
				]
			: []),
	];

	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: state,
				buckets: read.buckets.map((bucket) => ({
					name: bucket.name,
					state: bucketState(bucket.reading),
					count: bucketCount(bucket.reading),
					selector: bucket.selector,
					detail: bucketDetail(bucket.reading),
					asOf: bucketAsOf(bucket.reading).at,
					asOfKind: bucketAsOf(bucket.reading).kind,
				})),
			})}\n`,
			notices,
		);
	}
	const lines = [
		row("board", state, String(read.buckets.length)),
		...read.buckets.map((bucket) =>
			row(
				"bucket",
				bucket.name,
				bucket.reading._tag === "Counted"
					? String(bucket.reading.count)
					: bucketState(bucket.reading),
				bucket.selector,
				bucketDetail(bucket.reading) ?? EMPTY_CELL,
				asOfToken(bucketAsOf(bucket.reading)),
			),
		),
	];
	return answer(`${lines.join("\n")}\n`, notices);
};
