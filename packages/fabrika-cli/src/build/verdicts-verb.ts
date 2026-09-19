/**
 * `build verdicts` — the paginated, per-gate verdict fold on a PR, at its live head.
 *
 * Three properties the repair loop rests on:
 *
 * - **A stale marker is visible AS stale, never dropped.** "The FAIL is old" and "there is no FAIL"
 *   are different facts, and folding them is how a FAIL'd PR reads as unreviewed.
 *
 * - **Staleness is the content question**, decided by `bindToContent` off the head digest
 *   `../review/head-content.ts` resolves — the same derivation `ship gate` reads. This verb tells a
 *   builder "your verdicts are void, re-review"; the gate decides whether the PR may merge, and the
 *   two answering one marker differently spent a lane a repair round nobody had found a defect in.
 * - **Native reviews are their own row kind**, never coerced into markers. Whether a
 *   `CHANGES_REQUESTED` with no marker drives a repair is still undecided; this verb reports the
 *   state honestly and pre-rules nothing.
 * - An unreadable page cannot prove there are no verdicts. See ./command.ts help for the answer.
 *
 * - **Mergeability is folded beside the rows**, because a PR conflicting against its base is repair
 *   work no gate emits a FAIL for: without the field, an all-PASS fold over a conflicting PR is the
 *   proven-no-work answer the Repair section routes on, and the lane leaves the PR stranded.
 *   The platform's uncomputed read stays `unknown` all the way out — folded as clean it rebuilds the
 *   bug behind a field that looks like it fixed it.
 *
 * - **`capReached` is the declared cap plus what the founder cleared, never a second constant.** A
 *   recorded clearance (`./clearances.ts`) buys the one round it names, so the field the Repair
 *   section tells a builder to trust stays the only budget number anyone reads.
 *
 * - **`escalatedFindings` is the reader fence 3's escalation comment never had.** A finding raised
 *   at or past the acceptance-criteria freeze becomes a tagged comment and no criterion
 *   (`../review/append-criterion-verb.ts`), so a repair round dispatched past the freeze read a
 *   contract that did not contain the round it was there to repair — and only a driver hand-writing
 *   the comment id into a spawn prompt connected the two ends. Folded here, the round reads
 *   it through the one door it already opens.
 *
 * Every row's `body` is the finding's full text through the content gate — the repair loop consumes
 * findings from here and never raw-fetches a comment, which is what keeps the one-door property over
 * the repair path. `escalatedFindings` carries its comment's body the same way, for the same reason.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9058#issuecomment-5625309255
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {capNote, capReached} from "../cap-clearance.ts";
import {getIssue, listComments} from "../io/issues.ts";
import type {PullMergeability} from "../io/pulls.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {type RoutedRow, readEscalationTag} from "../review/append.ts";
import {headContentFor} from "../review/head-content.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {read as readRangeMarker} from "../wire/range-verdict-marker.ts";
import {bindToContent, read as readMarker, type VerdictMarker} from "../wire/verdict-marker.ts";
import {clearancesOn, grantedFrom} from "./clearances.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {contentOf, gate} from "./content-gate.ts";
import {listReviews} from "./github.ts";
import {closingTargets, proseOf} from "./pr-body.ts";
import {readRangeVerdicts} from "./range-verdicts.ts";
import {countRounds, roundsOn} from "./rounds.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build verdicts";

/** The machine line the fold's mergeability gets, one per value — the fact is never left unsaid. */
const mergeabilityNote = (pr: number, baseRef: string, state: PullMergeability): string => {
	if (state === "conflicting") {
		return `${VERB}: PR #${pr} is CONFLICTING against ${baseRef} — a base conflict is repair work no gate emits a FAIL for, so this fold is not a clean answer.`;
	}
	if (state === "unknown") {
		return `${VERB}: PR #${pr}'s mergeability is UNKNOWN — GitHub had not computed it yet, and that is never "merges cleanly".`;
	}
	return `${VERB}: PR #${pr} merges cleanly into ${baseRef}.`;
};

/** The provenance tag on a reviewer-appended criterion: `<!-- ac:review pr:#<pr> round:<n> -->`. */
const PROVENANCE_RE = /<!--\s*ac:review\s+pr:#(\d+)\s+round:(\d+)\s*-->/;

/**
 * The machine line the escalated findings get — one per fold, whichever way it came out.
 *
 * It is said even at zero, because "no finding was turned away" and "this verb does not look" are
 * different facts, and the second one is what the fold used to print.
 */
const escalatedNote = (rows: ReadonlyArray<{readonly round: number}>): string =>
	rows.length === 0
		? `${VERB}: no finding was escalated past the acceptance-criteria freeze.`
		: `${VERB}: ${rows.length} finding(s) escalated past the freeze, from round(s) ${rows.map((row) => row.round).join(", ")} — they are findings of this repair, and no later round grades them.`;

export interface VerdictsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ChildVerdictsOptions {
	/** The epic child issue whose range-scoped verdicts are folded — it opens no PR. */
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
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
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
		const reviews = yield* listReviews(options.env, repo, pr);
		if (reviews._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the reviews (page 1): ${reviews.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}

		// Latest marker per gate namespace. The round count is `roundsOn`'s, so this verb and `build
		// clear` cannot disagree about how many rounds the PR has been through.
		const latest = new Map<string, {readonly marker: VerdictMarker; readonly commentId: number}>();
		const bodies = new Map<number, string>();
		for (const comment of listed.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag !== "Found") continue;
			latest.set(parsed.value.namespace, {marker: parsed.value, commentId: comment.id});
			bodies.set(
				comment.id,
				contentOf(gate("comment-body", `comment ${comment.id}`, comment.body)),
			);
		}

		// One derivation with `ship gate` (`../review/head-content.ts`), so the repair loop and the
		// merge gate cannot answer one marker's staleness differently.
		const headContent = yield* headContentFor(
			VERB,
			repo,
			pr,
			target.pull,
			null,
			[...latest.values()].map(({marker}) => marker),
			head,
		);
		const rows: Row[] = [...latest.values()].map(({marker, commentId}) => ({
			gate: marker.namespace,
			polarity: marker.polarity,
			sha: marker.sha,
			// A digest this checkout could not derive is `Unbindable`, and `Unbindable` is not-current
			// exactly as `Stale` is: a failed derivation must never launder a stale verdict.
			current: bindToContent(marker, head, headContent.digest)._tag === "Current",
			commentId,
			kind: "marker" as const,
			body: bodies.get(commentId) ?? "",
		}));
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
		const linked = yield* linkedFindings(repo, pr, target.pull.body);
		if (linked._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the linked issue's acceptance criteria and escalated findings: ${linked.reason} — the verdict state is UNKNOWN, never "none".`,
			);
		}

		const granted = grantedFrom(cleared.rows);
		return answer(
			JSON.stringify({
				head,
				mergeability: target.pull.mergeability,
				rows,
				rounds,
				capReached: capReached(rounds, granted),
				clearances: cleared.rows,
				frozenCriteria: linked.frozen,
				escalatedFindings: linked.escalated,
			}),
			[
				`${VERB}: head ${head}; scanned ${listed.value.length} comment(s) and ${reviews.value.length} review(s) on #${pr}.`,
				mergeabilityNote(pr, target.pull.baseRef, target.pull.mergeability),
				escalatedNote(linked.escalated),
				`${VERB}: ${capNote(granted)}, from ${cleared.rows.length} marker(s).`,
				...headContent.diagnostics,
			],
		);
	});

/**
 * The same fold asked of an epic child, whose verdicts are range-bound comments on the issue itself.
 *
 * It exists because the repair route has to be walkable: `build claim --resume` refuses a fresh build
 * over a child's standing `FAIL`, and a lane sent to repair needs the findings through a verb rather
 * than a raw fetch. The rows carry the range each verdict was formed over instead of a head,
 * and a round is one graded tip — the range analogue of one graded head, folded through the same
 * `countRounds`.
 *
 * **It folds escalated findings too**, off the same comment page the verdicts come from: a child's
 * reviewer hits the identical freeze, and the comment it escalates to lands on this issue. Every
 * escalation here was raised over this child's own range, so there is no subject to select on.
 *
 * **It reports no clearance, and says so.** A cap clearance is recorded against a PR's base branch
 * (`./clearances.ts`), and a child has no PR — so the budget here is the declared cap, unmodified,
 * and a lane that needs another round escalates to the operator rather than reading a grant that has
 * nowhere to live.
 */
export const runChildVerdicts = (
	options: ChildVerdictsOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
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
		// Every escalation on a child issue was raised over that child's own range, so the subject
		// filter the PR arm needs has nothing to select here.
		const escalated = escalatedFrom(listed.value, () => true);
		return answer(
			JSON.stringify({
				rows,
				rounds,
				capReached: capReached(rounds, []),
				clearances: [],
				escalatedFindings: escalated,
			}),
			[
				`${VERB}: scanned ${listed.value.length} comment(s) on #${issue}; ${rows.length} standing range verdict(s), ${rounds} graded range(s).`,
				escalatedNote(escalated),
				`${VERB}: ${capNote([])} — a clearance is recorded against a PR's base branch, and a child has no PR, so this budget takes none.`,
				...read.malformed.map(
					(reason) =>
						`${VERB}: a comment on #${issue} reaches for a verdict marker and is not a range one — ${reason}`,
				),
			],
		);
	});

/** One finding fence 3 turned away, folded from the tagged escalation comment that carries it. */
interface EscalatedFinding {
	readonly round: number;
	readonly commentId: number;
	readonly body: string;
}

type Linked =
	| {
			readonly _tag: "Rows";
			readonly frozen: ReadonlyArray<{text: string; appendedRound: number}>;
			readonly escalated: ReadonlyArray<EscalatedFinding>;
	  }
	| {readonly _tag: "Unknown"; readonly reason: string};

/** The escalation comments on `comments` this subject's round produced, oldest first. */
const escalatedFrom = (
	comments: ReadonlyArray<{readonly id: number; readonly body: string}>,
	mine: (routed: RoutedRow) => boolean,
): ReadonlyArray<EscalatedFinding> => {
	const rows: EscalatedFinding[] = [];
	for (const comment of comments) {
		const tag = readEscalationTag(comment.body);
		if (tag === null || !mine(tag)) continue;
		rows.push({
			round: tag.round,
			commentId: comment.id,
			body: contentOf(gate("comment-body", `comment ${comment.id}`, comment.body)),
		});
	}
	return rows;
};

/**
 * The two things this PR's linked issue carries about the freeze: the criteria that landed at or
 * past it, and the findings it turned away.
 *
 * Both are read off one fetch of that issue, because they are two halves of one question — what the
 * contract says about the rounds past the freeze. The tag each artifact carries is what makes it
 * findable at all: the round is written into the row and into the comment, so the freeze is a
 * property of the artifact rather than of a session's memory. A PR with no closing keyword links no
 * issue and freezes nothing, which is an answer.
 *
 * The escalated half is the reader fence 3's comment never had. Without it a repair round past the
 * freeze read a criteria block that did not contain the round it was dispatched to repair, and only
 * a driver hand-writing the comment id into the spawn prompt connected the two ends.
 */
const linkedFindings = (
	repo: string,
	pr: number,
	body: string,
): Effect.Effect<Linked, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const empty = {_tag: "Rows" as const, frozen: [], escalated: []};
		const issue = closingTargets(proseOf(body))[0];
		if (issue === undefined) return empty;
		const found = yield* getIssue(repo, issue);
		if (found._tag === "Unknown") return {_tag: "Unknown" as const, reason: found.reason};
		if (found._tag === "Absent") return empty;
		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return {_tag: "Unknown" as const, reason: comments.reason};
		}
		const escalated = escalatedFrom(
			comments.value,
			(routed) => routed.provenance._tag === "Pull" && routed.provenance.pr === pr,
		);
		const read = readCriteria(contentOf(gate("issue-body", `#${issue}`, found.value.body)));
		if (read._tag !== "Found") return {_tag: "Rows" as const, frozen: [], escalated};
		const frozen: {text: string; appendedRound: number}[] = [];
		for (const criterion of read.value) {
			const tag = PROVENANCE_RE.exec(criterion.text);
			if (tag?.[1] === undefined || tag[2] === undefined) continue;
			if (Number.parseInt(tag[1], 10) !== pr) continue;
			const round = Number.parseInt(tag[2], 10);
			if (round >= CAP_ROUND) {
				frozen.push({
					text: criterion.text.replace(PROVENANCE_RE, "").trim(),
					appendedRound: round,
				});
			}
		}
		return {_tag: "Rows" as const, frozen, escalated};
	});
