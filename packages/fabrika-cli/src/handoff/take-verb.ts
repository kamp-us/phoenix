/**
 * `handoff take` — compose the pack by value, leak-scan it, post it as one comment, read it back.
 *
 * The compose, the scan, the reachability guard, the post and the read-back are mechanical; *what to
 * say in the four sections* is irreducibly the model's. The caller supplies only the asserted half,
 * on stdin: a caller-supplied ground state would be exactly the premise-inheritance (#4133) the
 * two-half split exists to prevent, and a body passed as a file reference is how a machine-local path
 * reached a posted artifact (#3086, #3173), so there is no `--body` and no `--body-file`.
 *
 * <!-- anchor: UNREACHABLE-WORK-IS-REFUSED --> **Unreachability refuses rather than warns.** A
 * successor is a fresh session in a different checkout: an unpushed commit and a modified tracked file
 * are both literally invisible to it, so a pack whose `## Next act` points at work in that state is
 * confidently wrong. The remedy is the caller's, outside this group, which commits and pushes
 * nothing; the refusal names it. `--declare-unreachable` does not silence the fact — the proven half
 * records `reachable` and the counts verbatim, so the successor reads a **stated** loss.
 *
 * **A pack is one comment or it is nothing**, which is why there is no partial-application table: a
 * post that fails is `8` with nothing on the issue, and a post that lands and reads back differently
 * is `9`, naming the comment id so a human can inspect it.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments, repoDefaultBranch} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {emit, packNonce, groundDigest as toGroundDigest} from "../wire/handoff-pack.ts";
import {parseAsserted} from "./asserted.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	EMPTY_STDIN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WORK_UNREACHABLE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {deriveGround, renderGround} from "./ground.ts";
import {leakFree, requireIssue, targetRepo} from "./guards.ts";
import {reachesForPackMarker, stampOf} from "./markers.ts";

export interface TakeOptions {
	readonly issue: number;
	readonly nonce: string;
	readonly base: string | null;
	readonly declareUnreachable: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
	readonly now: () => Date;
}

const VERB = "handoff take";

/** Which of the four `12` rows to print. Each names a different remedy, so they are four messages. */
const unreachableRefusal = (
	branch: string,
	reachable: string,
	aheadBy: number | null,
	trackedModified: number,
): VerbOutcome | null => {
	if (reachable === "unknown") {
		return refuse(
			WORK_UNREACHABLE,
			`${VERB}: ${branch} has no upstream, so whether a successor can reach it is UNKNOWN. Set an upstream and re-run, or re-run with --declare-unreachable to record the loss.`,
		);
	}
	const unpushed = reachable === "unpushed" ? (aheadBy ?? 0) : 0;
	if (unpushed > 0 && trackedModified > 0) {
		return refuse(
			WORK_UNREACHABLE,
			`${VERB}: ${unpushed} commit(s) are not pushed and ${trackedModified} tracked file(s) are modified — a successor cannot see either. Commit and push outside this skill and re-run, or re-run with --declare-unreachable to record the loss.`,
		);
	}
	if (unpushed > 0) {
		return refuse(
			WORK_UNREACHABLE,
			`${VERB}: ${unpushed} commit(s) are not pushed — a successor cannot see them. Push outside this skill and re-run, or re-run with --declare-unreachable to record the loss.`,
		);
	}
	if (trackedModified > 0) {
		return refuse(
			WORK_UNREACHABLE,
			`${VERB}: ${trackedModified} tracked file(s) are modified — a successor cannot see them. Commit and push outside this skill and re-run, or re-run with --declare-unreachable to record the loss.`,
		);
	}
	return null;
};

export const runTake = (
	options: TakeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const nonce = packNonce(options.nonce);
		if (nonce === null) {
			return refuse(
				FAILED,
				`${VERB}: --nonce "${options.nonce}" is not eight lowercase hex characters — a human-readable label two runs would collide on is not a run key.`,
			);
		}

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(FAILED, `${VERB}: could not read stdin: ${read.reason} — the body is UNKNOWN.`);
		}
		const text = read._tag === "Text" ? read.text : "";
		if (text.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				`${VERB}: stdin was read and held nothing — a pack with no asserted half is a capture, not a handoff.`,
			);
		}

		const asserted = parseAsserted(text);
		if (asserted._tag === "Problem") {
			const problem = asserted.problem;
			if (problem._tag === "Empty" && problem.heading === "## Unsure") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: ## Unsure is empty — a successor reads an empty Unsure as certainty. Write what you did not resolve, or say that you resolved everything.`,
				);
			}
			if (problem._tag === "Outside") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: content outside the four sections (${problem.heading}) — the section set is closed so a successor can tell the format's words from someone else's.`,
				);
			}
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the asserted half does not hold the four sections in order (${problem._tag === "Empty" ? `${problem.heading} is empty` : problem.detail}) — nothing was written.`,
			);
		}

		// The bare-`@` predicate asks whether a body ever arrived, so it is applied per **section**:
		// the composed document always opens with this format's own marker and the asserted half
		// always opens with `## Intent`, so testing either whole would make the seat unreachable and
		// let `@/path/to/notes.md` ride into a posted artifact under a heading (#3086).
		const unarrived = Object.entries(asserted.value).find(([, body]) => isBareAtReference(body));
		if (unarrived !== undefined) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the asserted half carries a bare @ path reference (${unarrived[0]}: ${unarrived[1].trim()}) — nothing was written.`,
			);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const issue = yield* requireIssue(VERB, repo, options.issue);
		if (issue._tag === "Refused") return issue.outcome;

		let base = options.base;
		if (base === null) {
			const named = yield* repoDefaultBranch(repo);
			if (named._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot derive the ground state: ${named.reason} — nothing was written and the pack would have asserted a ground it could not prove.`,
				);
			}
			base = named.value;
		}

		const derived = yield* deriveGround({
			repo,
			issue: options.issue,
			ref: null,
			base,
			board: {state: issue.value.state, labels: issue.value.labels},
			now: options.now,
		});
		if (derived._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot derive the ground state: ${derived.failure.reason} — nothing was written and the pack would have asserted a ground it could not prove.`,
			);
		}
		const ground = derived.value;

		if (!options.declareUnreachable) {
			// `git.tree.untracked` deliberately does not participate: an untracked file is not work a
			// pack points at, and blocking on one would refuse every session with a stray scratch file.
			const unreachable = unreachableRefusal(
				ground.git.branch,
				ground.git.reachable,
				ground.git.aheadBy,
				ground.git.tree.trackedModified,
			);
			if (unreachable !== null) return unreachable;
		}

		const listed = yield* listComments(repo, options.issue);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot page #${options.issue}'s comments: ${listed.reason} — nothing was written and supersedes would have been guessed.`,
			);
		}
		// Zero prior packs is a fact: the first handoff on an issue is the ordinary case.
		const supersedes =
			[...listed.value].reverse().find((comment) => reachesForPackMarker(comment.body))?.id ?? null;

		const sealedAt = stampOf(options.now());
		const digest = toGroundDigest(ground.groundDigest);
		if (digest === null) {
			// Unreachable: `bodyDigest` is specified to emit exactly twelve lowercase hex.
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the derived ground digest "${ground.groundDigest}" is not twelve lowercase hex — nothing was written.`,
			);
		}
		const body = emit({
			nonce,
			sealedAt,
			groundDigest: digest,
			intent: asserted.value.intent,
			established: asserted.value.established,
			nextAct: asserted.value.nextAct,
			unsure: asserted.value.unsure,
			groundJson: renderGround(ground),
		});

		// The scan runs over the whole composed document — marker, asserted half and proven half —
		// because the proven half does not exist until the capture above, and a scan that ran first
		// would never see it.
		// The whole-document scan decides; the asserted-half scan only attributes, because the two
		// halves have different remedies — a caller can rewrite their own prose, and a leak in the
		// derived ground is a refusal they cannot fix by editing stdin.
		const composedLeak = leakFree(VERB, "derived ground state", body);
		if (composedLeak !== null) return leakFree(VERB, "asserted half", text) ?? composedLeak;

		const scope = `${VERB}: ${repo}, #${options.issue}, ${listed.value.length} comment(s) scanned, reachable ${ground.git.reachable}.`;
		const posted = yield* createComment(repo, options.issue, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the comment write to #${options.issue} failed: ${posted.reason} — whether the pack landed is UNKNOWN. Read #${options.issue} before re-taking.`,
				[scope],
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted #${posted.value.id} and the read-back differs — the pack may be truncated. Read #${posted.value.id} before re-taking.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				issue: options.issue,
				packComment: posted.value.id,
				packNonce: nonce,
				sealedAt,
				groundDigest: ground.groundDigest,
				reachable: ground.git.reachable,
				supersedes,
			}),
			[scope],
		);
	});
