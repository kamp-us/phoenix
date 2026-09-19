/**
 * `ship cp-approval` — the §CP approval cardinality discharge, transcribed.
 *
 * Identical single-owner PRs merged in one run and were refused in another while this was judgment.
 * The case table ended that, and this verb **is** that table: roster cardinality in, one of
 * `discharge` / `stop` / `n/a` out, every signal bound to `--sha`.
 *
 * The roster is the union of every owner the boundary's control-plane rows name — GitHub's own
 * any-listed-owner semantics. A team is expanded through the members endpoint; an individual
 * `@login` owner is already a roster entry and no roster is read for it, which is what lets a repo
 * with no org behind it discharge the gate at all.
 *
 * The two collapses this verb refuses to make are the ones v1 shipped. A failed read is never
 * `stop` and never "awaiting approval" — it is `11`. And head-binding is checked here, always,
 * rather than delegated to the ruleset's `dismiss_stale_reviews_on_push`, which has been seen to
 * leave a patch-changing push's approval undismissed.
 *
 * **The §CP classification is taken over the enumerated file list, not over GitHub's `changed_files`.**
 * A list short of that declared count used to refuse at `13`, and this verb gates the control-plane
 * discharge, so the refusal left a §CP merge with no act available to clear it. The count is the
 * stale side — GitHub computes it against a base cached at the PR's last push.
 * {@link platformFileSet} owns that argument; the disagreement leaves as a `scanned` line.
 *
 * **The empty-list refusal below is new, and it is what the retired arm used to cover by accident.**
 * `classify` over no files answers `not-control-plane`, so a zero would have rendered as a discharged
 * §CP boundary rather than as an unread one. The other `13` this verb keeps for that list is the
 * endpoint's own 3000-file ceiling (`PULL_FILES_CAP`), where the Link chain ends as a complete read
 * ends: a control-plane path could sit in the part the platform never served. Its `13` refusals on
 * unexhausted review and comment pagination are untouched — those are the platform's own exhaustion
 * proofs, not a count comparison.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9322#issuecomment-5703498377
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listComments} from "../io/issues.ts";
import {listPullFiles} from "../io/pulls.ts";
import {platformCapLine, platformFileSet} from "../review/local-file-set.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readBoundary} from "./boundary.ts";
import {classify, controlPlaneOwnersOf, splitTeam} from "./codeowners.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {behindBase, listReviews, listTeamMembers} from "./github.ts";
import {
	badNumber,
	inspectedSha,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship cp-approval";

/**
 * The self-approval marker's token, deliberately outside every auto-merge namespace so no gate can
 * mistake it for a verdict.
 */
const SELF_APPROVAL = /control-plane-self-approval[ \t]*@[ \t]*([0-9a-f]{7,40})\b/i;

export interface CpApprovalOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Latest-per-author, computed **after** the pages are joined — never per page. */
export const latestPerAuthor = <A extends {login: string; submittedAt: string}>(
	reviews: ReadonlyArray<A>,
): ReadonlyArray<A> => {
	const byAuthor = new Map<string, A>();
	for (const review of reviews) {
		const held = byAuthor.get(review.login);
		if (held === undefined || review.submittedAt >= held.submittedAt) {
			byAuthor.set(review.login, review);
		}
	}
	return [...byAuthor.values()];
};

export const runCpApproval = (
	options: CpApprovalOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what}: ${reason} — the discharge is UNRESOLVED, not "awaiting approval".`;
		const unknownRead = (what: string, reason: string, extra: ReadonlyArray<string> = []) =>
			refuse(PRECONDITION_UNKNOWN, unreadable(what, reason), extra);

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to discharge.",
			unknownMessage: (reason) => unreadable(`PR #${pr}`, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const listed = platformFileSet(
			VERB,
			`#${pr}`,
			pull.changedFiles,
			yield* listPullFiles(repo, pr),
		);
		if (listed._tag === "Unreadable") {
			return unknownRead(`#${pr}'s changed files`, listed.reason);
		}
		const files = listed.set.files;
		const diagnostics = [
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared`),
			...(listed.set.disagreement === null ? [] : [listed.set.disagreement]),
		];
		// `classify` over no files answers `not-control-plane`, so an empty list would emit a discharged
		// boundary over a diff nobody read. With the declared count no longer refusing, this is the seat
		// that keeps a zero from rendering as `n/a`.
		if (files.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} has zero changed files — whether it crosses the §CP boundary is unanswerable.`,
				diagnostics,
			);
		}
		// The ceiling is the one truncation the enumeration cannot rule out on its own: the endpoint
		// stops serving files there and ends its Link chain as a complete read ends.
		if (listed.set.capped) {
			return refuse(
				INCOMPLETE_SCAN,
				platformCapLine(
					VERB,
					`#${pr}`,
					"a control-plane path could sit in the part the platform never served.",
				),
				diagnostics,
			);
		}

		const boundary = yield* readBoundary(repo, pull.baseRef);
		if (boundary._tag === "Unreadable") {
			return unknownRead("the §CP boundary", boundary.reason, diagnostics);
		}
		const rows = boundary.rows;

		const drift = yield* behindBase(repo, pull.baseRef, bound);
		const behind = drift._tag === "Ok" ? drift.value : 0;
		if (behind > 0) {
			diagnostics.push(
				`${VERB}: base-drift: head is ${behind} commits behind ${pull.baseRef} — rebase, re-gate and re-bank BEFORE soliciting an approval, or the rebase destroys it.`,
			);
		}

		const emit = (outcome: string, mechanism: string, roster: number): VerbOutcome =>
			json
				? answer(
						JSON.stringify({outcome, mechanism, sha: bound, roster, baseDrift: behind}),
						diagnostics,
					)
				: answer(`cp-approval\t${outcome}\t${mechanism}`, diagnostics);

		if (classify(rows, files) === "not-control-plane") {
			return emit("n/a", "not-control-plane", 0);
		}

		// An individual `@login` owner IS a roster entry, so it is added directly. Only a team needs
		// the members endpoint — which a personal repo has no org to serve at all.
		const roster = new Set<string>();
		for (const owner of controlPlaneOwnersOf(rows)) {
			const split = splitTeam(owner);
			if (split === null) {
				roster.add(owner.slice(1));
				continue;
			}
			const members = yield* listTeamMembers(split.org, split.team);
			if (members._tag === "Unknown") {
				return unknownRead(`the ${owner} roster`, members.reason, diagnostics);
			}
			if (members._tag === "Present") for (const login of members.value) roster.add(login);
		}
		diagnostics.push(scannedLine(VERB, roster.size, "control-plane owner"));
		// An EMPTY roster is a fact — a proven stop. An UNREADABLE one refused above; the two never
		// fold, and folding them is the collapse that reports a failed read as awaiting approval.
		if (roster.size === 0) return emit("stop", "zero-owners", 0);

		const soleOwner = roster.size === 1 ? ([...roster][0] ?? null) : null;
		if (soleOwner !== null && soleOwner === pull.authorLogin) {
			const commented = yield* listComments(repo, pr);
			if (commented._tag === "Failure") {
				return unknownRead(`#${pr}'s marker comments`, commented.reason, diagnostics);
			}
			diagnostics.push(
				scannedLine(VERB, commented.value.length, "comment", `${pull.comments} declared`),
			);
			if (commented.value.length < pull.comments) {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: received ${commented.value.length} of ${pull.comments} comments — refusing the partial sweep.`,
					diagnostics,
				);
			}
			const marked = commented.value.some((comment) => {
				if (comment.author !== soleOwner) return false;
				const stamp = SELF_APPROVAL.exec(comment.body);
				return stamp?.[1] !== undefined && prefixMatch(stamp[1], bound);
			});
			return marked
				? emit("discharge", `self-approval-marker@${bound}`, roster.size)
				: emit("stop", "awaiting-approval", roster.size);
		}

		const reviewed = yield* listReviews(repo, pr);
		if (reviewed._tag === "Failure") {
			return unknownRead(`#${pr}'s reviews`, reviewed.reason, diagnostics);
		}
		diagnostics.push(
			scannedLine(
				VERB,
				reviewed.value.reviews.length,
				"review",
				reviewed.value.exhausted ? "pagination exhausted" : "pagination NOT exhausted",
			),
		);
		if (!reviewed.value.exhausted) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the review read never reached a terminal page — pagination is unexhausted, so an approval could sit on a page nobody read; refusing the partial sweep.`,
				diagnostics,
			);
		}
		const approver = latestPerAuthor(reviewed.value.reviews).find(
			(review) =>
				review.state === "APPROVED" &&
				review.login !== pull.authorLogin &&
				roster.has(review.login) &&
				prefixMatch(review.commitId, bound),
		);
		return approver === undefined
			? emit("stop", "awaiting-approval", roster.size)
			: emit("discharge", `member-approval:${approver.login}@${bound}`, roster.size);
	});
