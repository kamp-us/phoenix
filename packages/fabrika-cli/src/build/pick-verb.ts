/**
 * `build pick` — the ranked candidate pool. A filter over a paged listing; the *choice* stays the
 * skill's.
 *
 * The filter is fail-closed on every axis, and two of them are negative tests rather than positive
 * ones:
 *
 * - **`ready-for:agent` must be present.** An issue with no `ready-for:` label is excluded — absence
 *   is an unknown audience, never an agent audience (#4780).
 * - **Any assignee excludes.** Assignment is the one attribute that keeps a human's live document out
 *   of an agent's pool (#4764, #4693).
 *
 * **Either every bucket was read in full, or the answer is `11`.** v1's pool printed nothing for a
 * failed bucket and kept going, so a `gh` 5xx on the p0 bucket read as "no p0s"
 * (`step1-candidate-pool.sh:12-13`). An empty pool is still a fact and prints on exit 0 with the
 * scanned counts beside it, which is what makes it auditable rather than merely plausible (ADR 0092).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type CandidateIssue, listLabelled} from "./github.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build pick";

/** The priority buckets, in the order the spine reads them. */
const BUCKETS = ["p0", "p1", "p2"] as const;
type Bucket = (typeof BUCKETS)[number];

/** The four types an agent lane may take. `type:decision` and `type:epic` never enter. */
const TYPES = new Set(["type:feature", "type:chore", "type:bug", "type:investigation"]);

/**
 * The lane labels that stand in for a milestone.
 *
 * A standing lane is a home an issue can have without a milestone, so reporting `null` for one would
 * read as unhomed. The set is closed: a new lane is a deliberate edit here, not a pattern match.
 */
const STANDING_LANES = ["wayfinder:backlog", "axis:pipeline-hardening"] as const;

export interface PickOptions {
	readonly repo: string | null;
	readonly limit: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface PoolEntry {
	readonly number: number;
	readonly title: string;
	readonly priority: Bucket;
	readonly type: string;
	readonly home: string | null;
}

const homeOf = (issue: CandidateIssue): string | null =>
	issue.milestone !== null
		? String(issue.milestone)
		: (STANDING_LANES.find((lane) => issue.labels.includes(lane)) ?? null);

/** Whether a row survives every axis of the filter. */
export const isCandidate = (issue: CandidateIssue): boolean => {
	if (issue.isPullRequest || issue.assigned) return false;
	const status = issue.labels.filter((label) => label.startsWith("status:"));
	if (status.length !== 1 || status[0] !== "status:triaged") return false;
	if (!issue.labels.includes("ready-for:agent")) return false;
	return issue.labels.filter((label) => label.startsWith("type:")).every((t) => TYPES.has(t));
};

const typeOf = (issue: CandidateIssue): string =>
	issue.labels.find((label) => TYPES.has(label))?.slice("type:".length) ?? "";

/** Milestone order inside a bucket: homed before unhomed, lower milestone first, then oldest number. */
const rankWithinBucket = (a: PoolEntry, b: PoolEntry): number => {
	const homeA = a.home === null ? Number.POSITIVE_INFINITY : Number.parseInt(a.home, 10);
	const homeB = b.home === null ? Number.POSITIVE_INFINITY : Number.parseInt(b.home, 10);
	const keyA = Number.isNaN(homeA) ? Number.POSITIVE_INFINITY : homeA;
	const keyB = Number.isNaN(homeB) ? Number.POSITIVE_INFINITY : homeB;
	return keyA === keyB ? a.number - b.number : keyA - keyB;
};

export const runPick = (
	options: PickOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.limit) || options.limit <= 0) {
			return refuse(FAILED, `${VERB}: --limit "${options.limit}" is not a positive integer.`);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const scanned: Record<Bucket, number> = {p0: 0, p1: 0, p2: 0};
		const pool: PoolEntry[] = [];
		for (const bucket of BUCKETS) {
			const listed = yield* listLabelled(resolved.repo, ["status:triaged", bucket]);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the ${bucket} bucket: ${listed.reason} — the pool is UNKNOWN, never partial.`,
				);
			}
			scanned[bucket] = listed.value.length;
			const entries = listed.value.filter(isCandidate).map((issue) => ({
				number: issue.number,
				title: issue.title,
				priority: bucket,
				type: typeOf(issue),
				home: homeOf(issue),
			}));
			pool.push(...entries.sort(rankWithinBucket));
		}

		return answer(JSON.stringify({pool: pool.slice(0, options.limit), scanned}), [
			`${VERB}: scanned p0 ${scanned.p0}, p1 ${scanned.p1}, p2 ${scanned.p2} in ${resolved.repo}; ${pool.length} candidate(s) survived the filter.`,
		]);
	});
