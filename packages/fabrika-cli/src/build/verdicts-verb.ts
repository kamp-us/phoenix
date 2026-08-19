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
import {capNote, capReached} from "../cap-clearance.ts";
import {getIssue, listComments} from "../io/issues.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {read as readRangeMarker} from "../wire/range-verdict-marker.ts";
import {bindToHead, read as readMarker} from "../wire/verdict-marker.ts";
import {clearancesOn, grantedFrom} from "./clearances.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {contentOf, gate} from "./content-gate.ts";
import {listReviews} from "./github.ts";
import {closingTargets, proseOf} from "./pr-body.ts";
import {readRangeVerdicts} from "./range-verdicts.ts";
import {countRounds, roundsOn} from "./rounds.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build verdicts";

/** ADR 0079's provenance tag on a reviewer-appended criterion: `<!-- ac:review pr:#<pr> round:<n> -->`. */
const PROVENANCE_RE = /<!--\s*ac:review\s+pr:#(\d+)\s+round:(\d+)\s*-->/;

export interface VerdictsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ChildVerdictsOptions {
	/** The epic child issue whose range-scoped verdicts are folded — it opens no PR (ADR 0285). */
	readonly issue: number;
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

		// Latest marker per gate namespace. The round count is `roundsOn`'s, so this verb and `build
		// clear` cannot disagree about how many rounds the PR has been through (#6137).
		const latest = new Map<string, Row>();
		for (const comment of listed.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag !== "Found") continue;
			const marker = parsed.value;
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

		const rounds = roundsOn(listed.value);
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
				`${VERB}: ${capNote(granted)}, from ${cleared.rows.length} marker(s).`,
			],
		);
	});

/**
 * The same fold asked of an epic child, whose verdicts are range-bound comments on the issue itself.
 *
 * It exists because the repair route has to be walkable: `build claim --resume` refuses a fresh build
 * over a child's standing `FAIL`, and a lane sent to repair needs the findings through a verb rather
 * than a raw fetch (#6386). The rows carry the range each verdict was formed over instead of a head,
 * and a round is one graded tip — the range analogue of one graded head, folded through the same
 * `countRounds`.
 *
 * **It reports no clearance, and says so.** A cap clearance is recorded against a PR's base branch
 * (`./clearances.ts`), and a child has no PR — so the budget here is the declared cap, unmodified,
 * and a lane that needs another round escalates to the operator rather than reading a grant that has
 * nowhere to live.
 */
export const runChildVerdicts = (
	options: ChildVerdictsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}: ${target.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: #${issue} is proven absent in ${repo}.`);
		}
		if (target.value.isPullRequest) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue} is a pull request — its verdicts are head-bound; drop --issue and pass --pr.`,
			);
		}

		const listed = yield* listComments(repo, issue);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${issue} (page 1): ${listed.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}

		const byId = new Map(listed.value.map((comment) => [comment.id, comment]));
		const read = readRangeVerdicts(listed.value);
		const rows = read.standing.map((verdict) => ({
			gate: verdict.namespace,
			polarity: verdict.polarity,
			range: verdict.range,
			commentId: verdict.commentId,
			kind: "range-marker" as const,
			body: contentOf(
				gate(
					"comment-body",
					`comment ${verdict.commentId}`,
					byId.get(verdict.commentId)?.body ?? "",
				),
			),
		}));
		const rounds = countRounds(
			listed.value.flatMap((comment) => {
				const parsed = readRangeMarker(comment.body);
				return parsed._tag === "Found" && parsed.value.polarity === "FAIL"
					? [{sha: parsed.value.range.tip, createdAt: comment.createdAt}]
					: [];
			}),
		);
		return answer(
			JSON.stringify({rows, rounds, capReached: capReached(rounds, []), clearances: []}),
			[
				`${VERB}: scanned ${listed.value.length} comment(s) on #${issue}; ${rows.length} standing range verdict(s), ${rounds} graded range(s).`,
				`${VERB}: ${capNote([])} — a clearance is recorded against a PR's base branch, and a child has no PR, so this budget takes none.`,
				...read.malformed.map(
					(reason) =>
						`${VERB}: a comment on #${issue} reaches for a verdict marker and is not a range one — ${reason}`,
				),
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
