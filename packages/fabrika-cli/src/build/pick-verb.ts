/**
 * `build pick` — the ranked candidate pool. A filter over a paged listing; the *choice* stays the
 * skill's.
 *
 * The filter is fail-closed on every axis, and two of them are negative tests rather than positive
 * ones:
 *
 * - **The admission test decides the scope, audience and type axes**, imported from
 *   [`./scope-admission.ts`](./scope-admission.ts) and re-derived nowhere (ADR 0245). An issue with
 *   no `ready-for:` label is excluded — absence is an unknown audience, never an agent audience
 *   (#4780) — and one homed outside every active campaign is excluded with its own reason. The type
 *   set used to be this file's private constant, which is how a directly-handed `type:decision`
 *   reached `claim` with nothing to refuse it (#5490).
 * - **Any assignee excludes.** Assignment is the one attribute that keeps a human's live document out
 *   of an agent's pool (#4764, #4693).
 * - **A body with no readable acceptance-criteria block excludes**, reported on the same
 *   excluded-with-axis channel: `ready-for:agent` over no contract is a lane that can only be
 *   discovered at the review gate, once a whole build has been spent (#6025).
 * - **A candidate with an open `blocked_by` edge excludes**, on the same channel, read off the
 *   native graph and nothing else (ADR 0301). It runs last because it is the only axis that costs a
 *   network call, and an unreadable graph excludes the candidate with its reason on stderr — the
 *   whole pool is not refused for one edge list, but a candidate whose blockedness is UNKNOWN is
 *   never offered.
 *
 * **Either every bucket was read in full, or the answer is `11`.** v1's pool printed nothing for a
 * failed bucket and kept going, so a `gh` 5xx on the p0 bucket read as "no p0s"
 * (`step1-candidate-pool.sh:12-13`); a bucket whose paginated output stops mid-page is the same fact
 * and lands on the same code. An unreadable campaigns table refuses the whole pool too — an
 * unfiltered pool on a failed read is the fail-open shape the fence exists to remove. An empty pool
 * is still a fact and prints on exit 0 with the scanned counts and the per-issue exclusion reasons
 * beside it, which is what makes it auditable rather than merely plausible (ADR 0092).
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {TRIAGED} from "../labels.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {readBlockedGate} from "./blockedness.ts";
import {BAD_SECTIONS, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type CandidateIssue, listLabelled} from "./github.ts";
import {
	admissionOf,
	BUILDABLE_TYPE_LABELS,
	dispatchReport,
	dispatchScopeLine,
	exclusionReasonOf,
	homeOf,
	readDeclaredDispatch,
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
}

interface PoolEntry {
	readonly number: number;
	readonly title: string;
	readonly priority: Bucket;
	readonly type: string;
	readonly home: string | null;
}

/**
 * The word for a candidate whose body carries no contract to build against.
 *
 * It is reported on the same channel as the admission test's axes but lives here rather than in
 * `./scope-admission.ts`, because that module is shared with the claim seam, where a `plan` or
 * `gate` claim targets an epic — a document whose criteria arrive per child from the plan ledger,
 * never in its own body. Reading the block there would refuse exactly the claims that are supposed
 * to precede it (#6025).
 */
const NO_CRITERIA = "no-acceptance-criteria";

/**
 * The word for a candidate the native `blocked_by` graph says must not start yet (ADR 0301).
 *
 * It is not an admission axis and does not live in `./scope-admission.ts`: that module is pure and
 * total over facts already on an issue, while this one costs a paged network read per candidate. It
 * is a reason on this channel rather than a silent drop because the `status:blocked` label it
 * replaces was dropped by accident — the two-`status:`-label hygiene test above excluded those
 * issues with no reason printed, and with the label retired that accident stops firing at all.
 */
const BLOCKED_REASON = "blocked";

/** One issue the filter kept out, with the axis that refused it (#5013). */
interface ExclusionEntry {
	readonly number: number;
	readonly home: string | null;
	readonly reason:
		| NonNullable<ReturnType<typeof exclusionReasonOf>>
		| typeof NO_CRITERIA
		| typeof BLOCKED_REASON;
}

/**
 * Board hygiene, plus the type axis read through the shared predicate.
 *
 * The audience and scope axes are deliberately absent: they run below, so an issue they exclude is
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

export const runPick = (
	options: PickOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.limit) || options.limit <= 0) {
			return refuse(FAILED, `${VERB}: --limit "${options.limit}" is not a positive integer.`);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const read = yield* readDeclaredDispatch(options.cwd);
		if (read._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the "## Campaigns" table: ${read.reason} — the pool is UNKNOWN, never unfiltered.`,
			);
		}
		const dispatch = read.dispatch;
		if (dispatch._tag === "Malformed") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the "## Campaigns" table does not parse: ${dispatch.reason} — the pool is UNKNOWN, and a malformed table is never read as "nothing is active".`,
			);
		}

		const scanned: Record<Bucket, number> = {p0: 0, p1: 0, p2: 0};
		const pool: PoolEntry[] = [];
		const excluded: ExclusionEntry[] = [];
		const blockedEdges: string[] = [];
		const unreadableEdges: string[] = [];
		for (const bucket of BUCKETS) {
			const listed = yield* listLabelled(resolved.repo, [TRIAGED, bucket]);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the ${bucket} bucket: ${listed.reason} — the pool is UNKNOWN, never partial.`,
				);
			}
			scanned[bucket] = listed.value.length;
			const entries: PoolEntry[] = [];
			for (const issue of listed.value.filter(isCandidate)) {
				const reason = exclusionReasonOf(admissionOf(dispatch, issue));
				if (reason !== null) {
					excluded.push({number: issue.number, home: homeOf(issue), reason});
					continue;
				}
				if (readCriteria(issue.body)._tag !== "Found") {
					excluded.push({number: issue.number, home: homeOf(issue), reason: NO_CRITERIA});
					continue;
				}
				// Last of the three, because it is the only one that costs a network call: the admission
				// test and the criteria block are both answered off facts already in hand, so a candidate
				// they refuse is never paid for here. An unreadable graph excludes with its reason stated
				// rather than refusing the whole pool (ADR 0301) — the candidate is dropped, never kept.
				const gate = yield* readBlockedGate(resolved.repo, issue.number);
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

		const criteriaExcluded = excluded.filter((row) => row.reason === NO_CRITERIA).length;
		const graphExcluded = blockedEdges.length + unreadableEdges.length;

		return answer(
			JSON.stringify({
				pool: pool.slice(0, options.limit),
				excluded,
				scanned,
				campaigns: dispatchReport(dispatch),
			}),
			[
				`${VERB}: scanned p0 ${scanned.p0}, p1 ${scanned.p1}, p2 ${scanned.p2} in ${resolved.repo}; ${pool.length} candidate(s) survived the filter, ${excluded.length} excluded — ${excluded.length - criteriaExcluded - graphExcluded} by the admission test, ${criteriaExcluded} for no acceptance-criteria block, ${graphExcluded} on the blocked_by graph.`,
				dispatchScopeLine(VERB, dispatch),
				...blockedEdges,
				...unreadableEdges,
			],
		);
	});
