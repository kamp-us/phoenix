/**
 * `build pick` — the ranked candidate pool. A filter over a paged listing; the *choice* stays the
 * skill's.
 *
 * The filter is fail-closed on every axis, and two of them are negative tests rather than positive
 * ones:
 *
 * - **The admission test decides all three axes** — type, audience, criteria — imported from
 *   [`./scope-admission.ts`](./scope-admission.ts) and re-derived nowhere. An issue with no
 *   `ready-for:` label is excluded — absence is an unknown audience, never an agent audience. No
 *   campaign state excludes anything. Two of those axes used to be this file's private business,
 *   and both leaked the same way: the type set as a private constant, which is how a
 *   directly-handed `type:decision` reached `claim` with nothing to refuse it, and the criteria
 *   read as a private call, which is how `build issue <n>` built a no-AC issue this pool would have
 *   refused.
 * - **Any assignee excludes.** Assignment is the one attribute that keeps a human's live document out
 *   of an agent's pool.
 * - **A candidate with an open, undischarged `blocked_by` edge excludes**, on the same channel, read
 *   off the native graph and nothing else, minus what the parent epic's assembly branch already
 *   carries — one derivation in [`./discharge.ts`](./discharge.ts), shared with the claim seam so
 *   the pool and the claim cannot state different facts about one edge. It runs last
 *   because it is the only axis that costs a network call, and an unreadable graph excludes the
 *   candidate with its reason on stderr — the whole pool is not refused for one edge list, but a
 *   candidate whose blockedness is UNKNOWN is never offered.
 *
 * **Bets come first.** When the repository keeps a table project, the issues bet on for the current
 * iteration lead the pool in agenda order (`../table/bets.ts`), and everything else follows in the
 * order below. It is an order and never a filter: a bet still passes every axis above, and an issue
 * nobody bet on is still offered. With no table project the pool is exactly the order below.
 *
 * **Either every bucket was read in full, or the answer is `11`.** v1's pool printed nothing for a
 * failed bucket and kept going, so a `gh` 5xx on the p0 bucket read as "no p0s"
 * (`step1-candidate-pool.sh:12-13`); a bucket whose paginated output stops mid-page is the same fact
 * and lands on the same code. A table project that could not be read refuses the whole pool too — a
 * pool ranked as if nothing were bet on, when bets exist, is an order nobody chose. An empty pool is
 * still a fact. No skill consumes individual excluded issues, so the evidence is bounded through
 * ../evidence.ts. See ./command.ts help for the pool answer.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {reasonHistogram} from "../evidence.ts";
import {TRIAGED} from "../labels.ts";
import {betsFirst} from "../table/bets.ts";
import {type BetsRead, readBets} from "../table/bets-read.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {readDischargedGate} from "./discharge.ts";
import {type CandidateIssue, listLabelled} from "./github.ts";
import {
	admissionOf,
	BUILDABLE_TYPE_LABELS,
	exclusionReasonOf,
	homeOf,
	NO_CRITERIA_REASON,
	typeAxisOf,
} from "./scope-admission.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build pick";

/** The priority buckets, in the order the spine reads them. */
const BUCKETS = ["p0", "p1", "p2"] as const;
type Bucket = (typeof BUCKETS)[number];

export interface PickOptions {
	readonly repo: string | null;
	readonly limit: number;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The clock the current iteration is read against. */
	readonly now: () => Date;
}

interface PoolEntry {
	readonly number: number;
	readonly title: string;
	readonly priority: Bucket;
	readonly type: string;
	readonly home: string | null;
}

/**
 * The word for a candidate the native `blocked_by` graph says must not start yet, once the parent
 * epic's assembly branch has been subtracted from it.
 *
 * It is not an admission axis and does not live in `./scope-admission.ts`: that module is pure and
 * total over facts already on an issue, while this one costs a paged network read per candidate. It
 * is a reason on this channel rather than a silent drop because the `status:blocked` label it
 * replaces was dropped by accident — the two-`status:`-label hygiene test above excluded those
 * issues with no reason printed, and with the label retired that accident stops firing at all.
 */
const BLOCKED_REASON = "blocked";

/**
 * One issue the filter kept out, with the axis that refused it.
 *
 * Internal to the scan: what reaches stdout is a `{reason: count}` histogram over these rows, and
 * the stderr scope line's per-axis split is derived from them too.
 */
interface ExclusionEntry {
	readonly number: number;
	readonly home: string | null;
	readonly reason: NonNullable<ReturnType<typeof exclusionReasonOf>> | typeof BLOCKED_REASON;
}

/**
 * Board hygiene, plus the type axis read through the shared predicate.
 *
 * The audience and criteria axes are deliberately absent: they run below, so an issue they exclude is
 * *reported* with its reason instead of vanishing from the pool unexplained. Type stays up here
 * because this pool has never offered a decision or an epic at all, and reporting one as excluded
 * would be a change to what the pool says rather than to where the rule lives.
 */
export const isCandidate = (issue: CandidateIssue): boolean => {
	if (issue.isPullRequest || issue.assigned) return false;
	const status = issue.labels.filter((label) => label.startsWith("status:"));
	if (status.length !== 1 || status[0] !== TRIAGED) return false;
	return typeAxisOf(issue)._tag === "Buildable";
};

const typeOf = (issue: CandidateIssue): string =>
	issue.labels
		.find((label) => BUILDABLE_TYPE_LABELS.some((buildable) => buildable === label))
		?.slice("type:".length) ?? "";

/** Milestone order inside a bucket: homed before unhomed, lower milestone first, then oldest number. */
const rankWithinBucket = (a: PoolEntry, b: PoolEntry): number => {
	const homeA = a.home === null ? Number.POSITIVE_INFINITY : Number.parseInt(a.home, 10);
	const homeB = b.home === null ? Number.POSITIVE_INFINITY : Number.parseInt(b.home, 10);
	const keyA = Number.isNaN(homeA) ? Number.POSITIVE_INFINITY : homeA;
	const keyB = Number.isNaN(homeB) ? Number.POSITIVE_INFINITY : homeB;
	return keyA === keyB ? a.number - b.number : keyA - keyB;
};

type TableBets = Exclude<BetsRead, {readonly _tag: "Unknown"}>;

/** How many bets survived the filter — a bet the pool left out stays out, and says so here. */
const inPool = (bets: TableBets, pool: ReadonlyArray<PoolEntry>): number =>
	bets._tag === "Read"
		? pool.filter((entry) => bets.order.issues.includes(entry.number)).length
		: 0;

/** The `bets` field on the machine channel: where the order came from, and how much of it is here. */
const betsReport = (
	bets: TableBets,
	pool: ReadonlyArray<PoolEntry>,
):
	| {readonly state: "none"}
	| {
			readonly state: "read";
			readonly project: string;
			readonly iteration: string | null;
			readonly bets: number;
			readonly inPool: number;
	  } =>
	bets._tag === "NoTable"
		? {state: "none"}
		: {
				state: "read",
				project: `${bets.source.owner}#${bets.source.number}`,
				iteration: bets.order.iteration?.title ?? null,
				bets: bets.order.issues.length,
				inPool: inPool(bets, pool),
			};

const betsLine = (bets: TableBets, pool: ReadonlyArray<PoolEntry>): string => {
	if (bets._tag === "NoTable") return `${VERB}: bets: ${bets.note}; the pool is in its own order.`;
	const project = `project ${bets.source.owner}#${bets.source.number}`;
	if (bets.order.iteration === null) {
		return `${VERB}: bets: ${project} has no current iteration, so nothing is bet on this week; the pool is in its own order.`;
	}
	return `${VERB}: bets: ${bets.order.issues.length} bet(s) in ${bets.order.iteration.title} on ${project}, ${inPool(bets, pool)} in the pool and first in it.`;
};

export const runPick = (
	options: PickOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.limit) || options.limit <= 0) {
			return refuse(FAILED, `${VERB}: --limit "${options.limit}" is not a positive integer.`);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const bets = yield* readBets(options.cwd, resolved.repo, options.now());
		if (bets._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the bets: ${bets.reason} — the pool order is UNKNOWN, never ranked as if nothing were bet on.`,
			);
		}

		const scanned: Record<Bucket, number> = {p0: 0, p1: 0, p2: 0};
		const pool: PoolEntry[] = [];
		const excluded: ExclusionEntry[] = [];
		const blockedEdges: string[] = [];
		const unreadableEdges: string[] = [];
		const branchNotes: string[] = [];
		for (const bucket of BUCKETS) {
			const listed = yield* listLabelled(options.env, resolved.repo, [TRIAGED, bucket]);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the ${bucket} bucket: ${listed.reason} — the pool is UNKNOWN, never partial.`,
				);
			}
			scanned[bucket] = listed.value.length;
			const entries: PoolEntry[] = [];
			for (const issue of listed.value.filter(isCandidate)) {
				const reason = exclusionReasonOf(admissionOf(issue));
				if (reason !== null) {
					excluded.push({number: issue.number, home: homeOf(issue), reason});
					continue;
				}
				// Last of the two, because it is the only one that costs a network call: every admission
				// axis is answered off facts already in hand, so a candidate they refuse is never paid
				// for here. The discharge read inside is lazier still: a candidate the graph already reads
				// clear resolves no parent and reads no branch. An unreadable graph excludes with its reason
				// stated rather than refusing the whole pool — the candidate is dropped, never kept.
				const {gate, notes} = yield* readDischargedGate(
					VERB,
					options.env,
					resolved.repo,
					issue.number,
				);
				branchNotes.push(...notes);
				if (gate._tag === "Unknown") {
					unreadableEdges.push(
						`${VERB}: cannot read the blocked_by edges of #${issue.number}: ${gate.reason} — excluded, because blockedness UNKNOWN is never "not blocked".`,
					);
					excluded.push({number: issue.number, home: homeOf(issue), reason: "unreadable"});
					continue;
				}
				if (gate._tag === "Blocked") {
					blockedEdges.push(
						`${VERB}: #${issue.number} is blocked by ${gate.open.map((blocker) => `#${blocker}`).join(", ")}.`,
					);
					excluded.push({number: issue.number, home: homeOf(issue), reason: BLOCKED_REASON});
					continue;
				}
				entries.push({
					number: issue.number,
					title: issue.title,
					priority: bucket,
					type: typeOf(issue),
					home: homeOf(issue),
				});
			}
			pool.push(...entries.sort(rankWithinBucket));
		}

		const criteriaExcluded = excluded.filter((row) => row.reason === NO_CRITERIA_REASON).length;
		const graphExcluded = blockedEdges.length + unreadableEdges.length;
		const betIssues = bets._tag === "Read" ? bets.order.issues : [];
		const ranked = betsFirst(pool, betIssues);
		const betSet = new Set(betIssues);

		return answer(
			JSON.stringify({
				pool: ranked
					.slice(0, options.limit)
					.map((entry) => ({...entry, bet: betSet.has(entry.number)})),
				excluded: reasonHistogram(excluded, (entry) => entry.reason),
				scanned,
				bets: betsReport(bets, pool),
			}),
			[
				`${VERB}: scanned p0 ${scanned.p0}, p1 ${scanned.p1}, p2 ${scanned.p2} in ${resolved.repo}; ${pool.length} candidate(s) survived the filter, ${excluded.length} excluded — ${excluded.length - criteriaExcluded - graphExcluded} by the admission test, ${criteriaExcluded} for no acceptance-criteria block, ${graphExcluded} on the blocked_by graph.`,
				betsLine(bets, pool),
				...blockedEdges,
				...unreadableEdges,
				...branchNotes,
			],
		);
	});
