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
 *   (#4780) — and one homed outside the declared focus is excluded with its own reason. The type
 *   set used to be this file's private constant, which is how a directly-handed `type:decision`
 *   reached `claim` with nothing to refuse it (#5490).
 * - **Any assignee excludes.** Assignment is the one attribute that keeps a human's live document out
 *   of an agent's pool (#4764, #4693).
 * - **A body with no readable acceptance-criteria block excludes**, reported on the same
 *   excluded-with-axis channel: `ready-for:agent` over no contract is a lane that can only be
 *   discovered at the review gate, once a whole build has been spent (#6025).
 *
 * **Either every bucket was read in full, or the answer is `11`.** v1's pool printed nothing for a
 * failed bucket and kept going, so a `gh` 5xx on the p0 bucket read as "no p0s"
 * (`step1-candidate-pool.sh:12-13`); a bucket whose paginated output stops mid-page is the same fact
 * and lands on the same code. An unreadable focus declaration refuses the whole pool too — an
 * unfiltered pool on a failed read is the fail-open shape the fence exists to remove. An empty pool
 * is still a fact and prints on exit 0 with the scanned counts and the per-issue exclusion reasons
 * beside it, which is what makes it auditable rather than merely plausible (ADR 0092).
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {BAD_SECTIONS, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type CandidateIssue, listLabelled} from "./github.ts";
import {
	admissionOf,
	BUILDABLE_TYPE_LABELS,
	exclusionReasonOf,
	focusReport,
	focusScopeLine,
	homeOf,
	readDeclaredFocus,
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

/** One issue the filter kept out, with the axis that refused it (#5013). */
interface ExclusionEntry {
	readonly number: number;
	readonly home: string | null;
	readonly reason: NonNullable<ReturnType<typeof exclusionReasonOf>> | typeof NO_CRITERIA;
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
	if (status.length !== 1 || status[0] !== "status:triaged") return false;
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
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.limit) || options.limit <= 0) {
			return refuse(FAILED, `${VERB}: --limit "${options.limit}" is not a positive integer.`);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const read = yield* readDeclaredFocus();
		if (read._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the "## Focus" declaration: ${read.reason} — the pool is UNKNOWN, never unfiltered.`,
			);
		}
		const focus = read.focus;
		if (focus._tag === "Malformed") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the "## Focus" declaration does not parse: ${focus.reason} — the pool is UNKNOWN, and a malformed declaration is never read as "no focus".`,
			);
		}

		const scanned: Record<Bucket, number> = {p0: 0, p1: 0, p2: 0};
		const pool: PoolEntry[] = [];
		const excluded: ExclusionEntry[] = [];
		for (const bucket of BUCKETS) {
			const listed = yield* listLabelled(resolved.repo, ["status:triaged", bucket]);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the ${bucket} bucket: ${listed.reason} — the pool is UNKNOWN, never partial.`,
				);
			}
			scanned[bucket] = listed.value.length;
			const entries: PoolEntry[] = [];
			for (const issue of listed.value.filter(isCandidate)) {
				const reason = exclusionReasonOf(admissionOf(focus, issue));
				if (reason !== null) {
					excluded.push({number: issue.number, home: homeOf(issue), reason});
					continue;
				}
				if (readCriteria(issue.body)._tag !== "Found") {
					excluded.push({number: issue.number, home: homeOf(issue), reason: NO_CRITERIA});
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

		return answer(
			JSON.stringify({
				pool: pool.slice(0, options.limit),
				excluded,
				scanned,
				focus: focusReport(focus),
			}),
			[
				`${VERB}: scanned p0 ${scanned.p0}, p1 ${scanned.p1}, p2 ${scanned.p2} in ${resolved.repo}; ${pool.length} candidate(s) survived the filter, ${excluded.length} excluded — ${excluded.length - criteriaExcluded} by the admission test, ${criteriaExcluded} for no acceptance-criteria block.`,
				focusScopeLine(VERB, focus),
			],
		);
	});
