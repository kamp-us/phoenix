/**
 * `status board` — counts of the board's decided buckets, each with its own freshness.
 *
 * **Counts only.** `fabrika build pick` and `build eligible` answer which issue is next and
 * `build verdicts` / `ship gate` answer a pull request's state; a second answer here could
 * contradict the verb that actually claims the work. There is no "banked" bucket either — what
 * marks a pull request banked is an open decision (#4103).
 *
 * **An absent label renders `unknown`, never `0`.** A zero count means the label exists and nothing
 * carries it; an absent label means the question was never askable — the #4060 shape, where a fresh
 * repo would be told its queue is clear.
 */
import {Effect} from "effect";
import {scannedLine} from "../build/target.ts";
import type {Shell} from "../io/git.ts";
import {openPullRequests} from "../io/github.ts";
import {listLabels, openIssuesWithLabel} from "../io/issues.ts";
import {PRIORITIES} from "../triage/facets.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, instant, noAsOf, readNow, row} from "./fields.ts";

const VERB = "status board";

/** The label whose absence makes a bucket unaskable, and the selector printed for it. */
const labelBucket = (name: string, label: string) => ({
	name,
	label,
	selector: `labels=${label}`,
});

/**
 * The six buckets, each with the REST call that produces it — never GitHub search syntax, which
 * caps at 1000 results and cannot back a count.
 */
export const BUCKETS = [
	labelBucket("needs-triage", "status:needs-triage"),
	labelBucket("triaged", "status:triaged"),
	...PRIORITIES.map((priority) => labelBucket(priority, priority)),
] as const;

/** The pull-request bucket, read off `/pulls` rather than `/issues` — it counts PRs on purpose. */
export const IN_FLIGHT = {name: "in-flight", selector: "pulls?state=open"} as const;

export interface Bucket {
	readonly name: string;
	readonly count: number | null;
	readonly selector: string;
	readonly detail: string | null;
	readonly asOf: AsOf;
}

export type BoardRead =
	/** The repository could not be read at all — every bucket is UNKNOWN, so there is no readout. */
	| {readonly _tag: "Failed"; readonly repo: string; readonly reason: string}
	| {readonly _tag: "Read"; readonly repo: string; readonly buckets: ReadonlyArray<Bucket>};

const unknownBucket = (name: string, selector: string, reason: string): Bucket => ({
	name,
	selector,
	count: null,
	detail: detail(reason),
	asOf: noAsOf,
});

/**
 * Read every bucket.
 *
 * The label set is read first because it is what separates the two negative answers: with it in
 * hand a `0` is proven, and an absent label is reported as the unasked question it is. When the
 * label read itself fails, every label bucket is UNKNOWN — a count taken without it could not be
 * told apart from a proven zero.
 */
export const readBoard = (repo: string, now: () => Date): Shell<BoardRead> =>
	Effect.gen(function* () {
		const labels = yield* listLabels(repo);
		const labelFailure = labels._tag === "Failure" ? labels.reason : null;
		const known = labels._tag === "Ok" ? new Set(labels.value) : null;
		const buckets: Bucket[] = [];

		for (const bucket of BUCKETS) {
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
				buckets.push(unknownBucket(bucket.name, bucket.selector, "label absent"));
				continue;
			}
			const rows = yield* openIssuesWithLabel(repo, bucket.label);
			if (rows._tag === "Failure") {
				buckets.push(unknownBucket(bucket.name, bucket.selector, rows.reason));
				continue;
			}
			buckets.push({
				name: bucket.name,
				selector: bucket.selector,
				count: rows.value.length,
				detail: null,
				asOf: readNow(instant(now())),
			});
		}

		const pulls = yield* openPullRequests(repo);
		if (pulls._tag === "Failure") {
			buckets.push(unknownBucket(IN_FLIGHT.name, IN_FLIGHT.selector, pulls.reason));
		} else {
			buckets.push({
				name: IN_FLIGHT.name,
				selector: IN_FLIGHT.selector,
				count: pulls.value.length,
				detail: null,
				asOf: readNow(instant(now())),
			});
		}

		return buckets.every((bucket) => bucket.count === null)
			? ({
					_tag: "Failed",
					repo,
					reason: labels._tag === "Failure" ? labels.reason : "every bucket read failed",
				} as const)
			: ({_tag: "Read", repo, buckets: ordered(buckets)} as const);
	});

/** The fixed print order: the two queue buckets, in-flight, then the priorities. */
const ordered = (buckets: ReadonlyArray<Bucket>): ReadonlyArray<Bucket> => {
	const order = ["needs-triage", "triaged", IN_FLIGHT.name, ...PRIORITIES];
	return [...buckets].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
};

export type BoardState = "counted" | "unknown";

export const boardState = (buckets: ReadonlyArray<Bucket>): BoardState =>
	buckets.every((bucket) => bucket.count !== null) ? "counted" : "unknown";

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
	const unknown = read.buckets.filter((bucket) => bucket.count === null);
	const counted = read.buckets.reduce((sum, bucket) => sum + (bucket.count ?? 0), 0);
	const notice = scannedLine(
		VERB,
		counted,
		"item",
		`counted ${read.buckets.length} buckets over ${read.repo}, ${unknown.length} unknown (${
			unknown.map((bucket) => bucket.name).join(",") || EMPTY_CELL
		})`,
	);

	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: state,
				buckets: read.buckets.map((bucket) => ({
					name: bucket.name,
					count: bucket.count,
					selector: bucket.selector,
					detail: bucket.detail,
					asOf: bucket.asOf.at,
					asOfKind: bucket.asOf.kind,
				})),
			})}\n`,
			[notice],
		);
	}
	const lines = [
		row("board", state, String(read.buckets.length)),
		...read.buckets.map((bucket) =>
			row(
				"bucket",
				bucket.name,
				bucket.count === null ? "unknown" : String(bucket.count),
				bucket.selector,
				bucket.detail ?? EMPTY_CELL,
				asOfToken(bucket.asOf),
			),
		),
	];
	return answer(`${lines.join("\n")}\n`, [notice]);
};
