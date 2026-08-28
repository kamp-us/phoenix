/**
 * `build tree` — the ground, proven from git state and one whole lane relationship, and never repaired.
 *
 * Two assertions, each with its own code so a caller can act on which one failed: a clean tree at a
 * `--require-clean` open (`13`), and a checked-out branch carrying this claim's nonce (`14`). A fresh
 * proof binds one issue branch to that issue's claim. A repair proof additionally binds the resumed
 * branch to the named PR, that PR's winning claim, and the one issue its live body serves (#7183).
 * Both are location-neutral — where the lane runs is the operator's call, not fabrika's (#5386). It
 * reads and never repairs: no clean, no create, no remove.
 *
 * The skill re-runs this before every git mutation because the shell's cwd resets between calls, so a
 * pass here is a fact about *this* invocation and nothing later.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {currentBranch} from "../io/issues.ts";
import {issueRefsOf} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {laneCaller, requireClaim, requireSession} from "./claim.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, WRONG_LANE} from "./codes.ts";
import {laneNumber, parseLaneBranch} from "./lane.ts";
import {openIssue, openPull, resolveTargetRepo} from "./target.ts";
import {assertGround} from "./tree.ts";

const VERB = "build tree";

export interface TreeOptions {
	readonly requireClean: boolean;
	/** Additionally prove the checked-out branch serves this issue — the pre-mutation posture. */
	readonly issue: number | null;
	/** In repair, the PR claim and resumed branch that must uniquely serve `issue`. */
	readonly repair: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runTree = (
	options: TreeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ground = yield* assertGround(VERB, options.requireClean);
		if (ground._tag === "Refused") return ground.outcome;
		if (options.issue === null) {
			return options.repair === null
				? answer(ground.root)
				: refuse(OFF_VOCABULARY, `${VERB}: --repair <pr> requires --issue <n>.`);
		}

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		// The checked-out branch's nonce IS this lane's identity here, so the claim read asks "does the
		// winning marker belong to my lane" instead of "to my session" (#6037).
		const branch = yield* currentBranch;
		const lane = branch === null ? null : parseLaneBranch(branch);
		if (lane === null) {
			return refuse(
				WRONG_LANE,
				`${VERB}: the checked-out branch "${branch ?? "(detached)"}" is not a lane branch — wrong lane.`,
			);
		}

		const repair = options.repair;
		const issueNumber = options.issue;
		const expectedClaim = repair ?? issueNumber;
		const correctBranch =
			repair === null
				? lane._tag === "Create" && lane.number === issueNumber
				: lane._tag === "Resume" && lane.pr === repair;
		if (!correctBranch) {
			return refuse(
				WRONG_LANE,
				`${VERB}: the checked-out branch "${branch}" names claim #${laneNumber(lane)}, not ${
					repair === null ? `issue #${issueNumber}` : `repair PR #${repair}`
				} — wrong lane.`,
			);
		}

		const held = yield* requireClaim(
			VERB,
			resolved.repo,
			expectedClaim,
			laneCaller(session.id, lane.nonce),
		);
		if (held._tag === "Refused") {
			return held.ownership._tag === "Foreign" && held.ownership.sameSession
				? refuse(
						WRONG_LANE,
						`${VERB}: the checked-out branch "${branch}" does not carry claim ${held.ownership.marker.token}'s nonce — wrong lane.`,
						held.notes,
					)
				: held.outcome;
		}

		if (repair === null) {
			return answer(
				JSON.stringify({
					answer: "proven",
					root: ground.root,
					branch,
					claim: {number: issueNumber, nonce: lane.nonce},
					servedIssue: {number: issueNumber, kind: "issue"},
				}),
				held.notes,
			);
		}

		const pull = yield* openPull(
			VERB,
			resolved.repo,
			repair,
			(reason) =>
				`${VERB}: cannot read repair PR #${repair}: ${reason} — its served issue is UNKNOWN; nothing is proven.`,
		);
		if (pull._tag === "Refused") return pull.outcome;
		const linkage = issueRefsOf(pull.pull.body);
		if (linkage.numbers.length !== 1) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: repair PR #${repair} names ${linkage.numbers.length} served issues through ${linkage.kind}; exactly one is required, so the repair subject is not uniquely readable.`,
				held.notes,
			);
		}
		const servedIssue = linkage.numbers[0];
		if (servedIssue === undefined) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: repair PR #${repair}'s served issue disappeared while reading its linkage — nothing is proven.`,
				held.notes,
			);
		}
		if (servedIssue !== issueNumber) {
			return refuse(
				WRONG_LANE,
				`${VERB}: repair PR #${repair} serves issue #${servedIssue}, not requested issue #${issueNumber} — wrong lane.`,
				held.notes,
			);
		}
		const issue = yield* openIssue(
			VERB,
			resolved.repo,
			servedIssue,
			(reason) =>
				`${VERB}: cannot read issue #${servedIssue}, which repair PR #${repair} serves: ${reason} — the repair subject is UNKNOWN; nothing is proven.`,
		);
		if (issue._tag === "Refused") return issue.outcome;
		if (issue.issue.isPullRequest) {
			return refuse(
				WRONG_LANE,
				`${VERB}: repair PR #${repair} links #${servedIssue}, but that record is itself a pull request, not the served issue — wrong lane.`,
				held.notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "proven",
				root: ground.root,
				branch,
				claim: {number: repair, nonce: lane.nonce},
				servedIssue: {number: servedIssue, kind: linkage.kind},
			}),
			held.notes,
		);
	});
