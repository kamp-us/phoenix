/**
 * `build verdicts` — the paginated, current-head, per-gate verdict fold on a PR.
 *
 * Three properties the repair loop rests on:
 *
 * - **A stale marker is visible AS stale, never dropped.** "The FAIL is old" and "there is no FAIL"
 *   are different facts, and folding them is how a FAIL'd PR reads as unreviewed (#4105).
 * - **Native reviews are their own row kind**, never coerced into markers. Whether a
 *   `CHANGES_REQUESTED` with no marker drives a repair is the open decision #4555; this verb reports
 *   the state honestly and pre-rules nothing.
 * - **An unreadable page is `11`, never a shorter list.** `{"rows": []}` on exit 0 is a proven "no
 *   verdicts", readable against the scope line's counts (ADR 0092, #4208 / #4219).
 *
 * - **`capReached` is the declared cap plus what the founder cleared, never a second constant.** A
 *   recorded clearance (`./clearances.ts`) buys the one round it names, so the field the Repair
 *   section tells a builder to trust stays the only budget number anyone reads (#5959).
 *
 * Every row's `body` is the finding's full text through the content gate — the repair loop consumes
 * findings from here and never raw-fetches a comment, which is what keeps the one-door property over
 * the repair path.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {capReached, effectiveCap, grantedRounds} from "../cap-clearance.ts";
import {getIssue, listComments} from "../io/issues.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {bindToHead, read as readMarker} from "../wire/verdict-marker.ts";
import {clearancesOn, grantedFrom} from "./clearances.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {contentOf, gate} from "./content-gate.ts";
import {listReviews} from "./github.ts";
import {closingTargets, proseOf} from "./pr-body.ts";
import {countRounds} from "./rounds.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build verdicts";

/** ADR 0079's provenance tag on a reviewer-appended criterion: `<!-- ac:review pr:#<pr> round:<n> -->`. */
const PROVENANCE_RE = /<!--\s*ac:review\s+pr:#(\d+)\s+round:(\d+)\s*-->/;

export interface VerdictsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface Row {
	readonly gate: string;
	readonly polarity: string;
	readonly sha: string | null;
	readonly current: boolean | null;
	readonly commentId?: number;
	readonly reviewId?: number;
	readonly kind: "marker" | "native";
	readonly body: string;
}

export const runVerdicts = (
	options: VerdictsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(
			VERB,
			repo,
			pr,
			(reason) =>
				`${VERB}: cannot read PR #${pr} (page 1): ${reason} — the verdict state is UNKNOWN, never "none".`,
		);
		if (target._tag === "Refused") return target.outcome;
		const head = target.pull.headSha;

		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments (page 1): ${listed.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}
		const reviews = yield* listReviews(repo, pr);
		if (reviews._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the reviews (page 1): ${reviews.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}

		// Latest marker per gate namespace, and every FAIL's timestamp for the round count.
		const latest = new Map<string, Row>();
		const failedAt: string[] = [];
		for (const comment of listed.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag !== "Found") continue;
			const marker = parsed.value;
			if (marker.polarity === "FAIL") failedAt.push(comment.createdAt);
			latest.set(marker.namespace, {
				gate: marker.namespace,
				polarity: marker.polarity,
				sha: marker.sha,
				current: bindToHead(marker, head)._tag === "Current",
				commentId: comment.id,
				kind: "marker",
				body: contentOf(gate("comment-body", `comment ${comment.id}`, comment.body)),
			});
		}
		const rows: Row[] = [...latest.values()];
		for (const review of reviews.value) {
			if (review.state === "COMMENTED" || review.state === "PENDING") continue;
			rows.push({
				gate: "native-review",
				polarity: review.state,
				sha: null,
				current: null,
				reviewId: review.id,
				kind: "native",
				body: contentOf(gate("review-body", `review ${review.id}`, review.body)),
			});
		}

		const rounds = countRounds(failedAt);
		const cleared = yield* clearancesOn(repo, target.pull.baseRef, listed.value);
		if (cleared._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the recorded cap clearances: ${cleared.reason} — whether the budget is spent is UNKNOWN, never "capped".`,
			);
		}
		const frozen = yield* frozenCriteria(repo, pr, target.pull.body);
		if (frozen._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the linked issue's acceptance criteria: ${frozen.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}

		const granted = grantedFrom(cleared.rows);
		return answer(
			JSON.stringify({
				head,
				rows,
				rounds,
				capReached: capReached(rounds, granted),
				clearances: cleared.rows,
				frozenCriteria: frozen.rows,
			}),
			[
				`${VERB}: head ${head}; scanned ${listed.value.length} comment(s) and ${reviews.value.length} review(s) on #${pr}.`,
				`${VERB}: cap ${effectiveCap(granted)} = ${CAP_ROUND} declared + ${grantedRounds(granted)} cleared round(s), from ${cleared.rows.length} marker(s).`,
			],
		);
	});

type Frozen =
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<{text: string; appendedRound: number}>}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * The reviewer-appended criteria on this PR's linked issue that landed at or past the freeze round.
 *
 * The provenance tag ADR 0079 requires is what makes them findable at all — the round is written into
 * the row, so the freeze is a property of the artifact rather than of a session's memory. A PR with no
 * closing keyword links no issue and freezes nothing, which is an answer.
 */
const frozenCriteria = (
	repo: string,
	pr: number,
	body: string,
): Effect.Effect<Frozen, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const issue = closingTargets(proseOf(body))[0];
		if (issue === undefined) return {_tag: "Rows" as const, rows: []};
		const found = yield* getIssue(repo, issue);
		if (found._tag === "Unknown") return {_tag: "Unknown" as const, reason: found.reason};
		if (found._tag === "Absent") return {_tag: "Rows" as const, rows: []};
		const read = readCriteria(contentOf(gate("issue-body", `#${issue}`, found.value.body)));
		if (read._tag !== "Found") return {_tag: "Rows" as const, rows: []};
		const rows: {text: string; appendedRound: number}[] = [];
		for (const criterion of read.value) {
			const tag = PROVENANCE_RE.exec(criterion.text);
			if (tag?.[1] === undefined || tag[2] === undefined) continue;
			if (Number.parseInt(tag[1], 10) !== pr) continue;
			const round = Number.parseInt(tag[2], 10);
			if (round >= CAP_ROUND) {
				rows.push({text: criterion.text.replace(PROVENANCE_RE, "").trim(), appendedRound: round});
			}
		}
		return {_tag: "Rows" as const, rows};
	});
