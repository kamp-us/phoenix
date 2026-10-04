/**
 * `build push` — publish the lane's branch, then **independently confirm the remote ref moved**.
 *
 * `git push`'s own report is not evidence: a push that died mid-hook read as sent, and every stage
 * downstream assumed a branch that was not there. So the verdict comes from `git ls-remote`
 * asking the remote directly, compared against the local head.
 *
 * On a fresh lane the verb then opens the PR through `build pr`'s own guards and create, so no death
 * between two steps can leave a pushed branch with no PR. The body is vetted before the push, so a
 * body `build pr` would refuse pushes nothing. A repair lane's PR is already open, so it reads no body.
 *
 * See the push help in ./command.ts for the report channels and verdict line.
 *
 * `--force-with-lease` is the only force shape. A bare `--force` flag does not exist, and neither does
 * `--no-verify`: the ban is enforced by the flag not existing rather than by prose.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6933#issuecomment-5519864602
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {isAncestor} from "../io/git.ts";
import {currentBranch, type IssueRecord} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireSession} from "./claim.ts";
import {
	HEAD_DROPS_REMOTE,
	PRECONDITION_UNKNOWN,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commitsDropped,
	ensureCommitPresent,
	headSha,
	publishTarget,
	push,
	remoteSha,
} from "./git.ts";
import {type Lane, requireLane} from "./lane-guard.ts";
import {openLanePull, pullAnswerLine, vetBody} from "./pr-verb.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

const VERB = "build push";
const VERDICT = "PUSH-VERDICT: MOVED";

export interface PushOptions {
	readonly forceWithLease: boolean;
	/** Publish a head that drops the remote's commits anyway — a deliberate rewrite, never a default. */
	readonly dropRemoteCommits: boolean;
	/** The acceptance criteria are not all met: the PR body must say `Part of #<n>`, not `Fixes #<n>`. */
	readonly partial: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The PR body. Read only on a fresh lane; a repair lane's PR is already open. */
	readonly stdin: Effect.Effect<StdinRead>;
}

/** What the push does after the ref moves: open this lane's PR, or nothing on a repair lane. */
type PullStep =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Open"; readonly issue: IssueRecord; readonly body: string}
	| {readonly _tag: "Repair"};

/** Every read and guard the PR create needs before a write, run before the push. */
const pullStep = (
	options: PushOptions,
	repo: string,
	lane: Extract<Lane, {readonly _tag: "Lane"}>,
): Effect.Effect<PullStep, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (lane.lane._tag === "Resume") {
			return options.partial
				? {
						_tag: "Refused" as const,
						outcome: refuse(
							UNSAFE_PUSH,
							`${VERB}: --partial describes a new PR's body, and this repair lane's PR #${lane.lane.pr} is already open — nothing was pushed. Rewrite its body with build pr-body.`,
							lane.notes,
						),
					}
				: {_tag: "Repair" as const};
		}
		const number = lane.lane.number;
		const vetted = vetBody(VERB, yield* options.stdin, number, options.partial);
		if (vetted._tag === "Refused") return vetted;
		const target = yield* openIssue(
			VERB,
			repo,
			number,
			(reason) => `${VERB}: cannot read #${number}: ${reason} — nothing was pushed.`,
		);
		if (target._tag === "Refused") return target;
		return {_tag: "Open" as const, issue: target.issue, body: vetted.text};
	});

export const runPush = (
	options: PushOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		// Detached HEAD is refused HERE, ahead of the lane guard, so it lands on `19` (refused before
		// pushing) rather than on the guard's `14` (wrong lane) — they are different facts.
		if ((yield* currentBranch) === null) {
			return refuse(UNSAFE_PUSH, `${VERB}: HEAD is detached — refusing to guess a branch.`);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const lane = yield* requireLane(VERB, resolved.repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;

		const step = yield* pullStep(options, resolved.repo, lane);
		if (step._tag === "Refused") return step.outcome;

		const local = yield* headSha;
		if (local._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve HEAD: ${local.reason} — nothing was pushed.`,
				lane.notes,
			);
		}

		const {remote, ref} = yield* publishTarget(lane.branch);

		const before = yield* remoteSha(remote, ref);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${remote}/${ref}: ${before.reason} — nothing was pushed.`,
				lane.notes,
			);
		}
		const notes = [...lane.notes];

		// The containment test runs on BOTH paths, and that is the whole fix. It used to be
		// guarded by `!forceWithLease`, so the repair path — which mandates the lease — got no
		// containment evidence at all: `--force-with-lease` defends the ref against ANOTHER writer,
		// never against this lane's own head having dropped the remote's commits, and a bare lease is
		// refreshed by any fetch the lane already ran, so it cannot refuse the drop either. The verb's
		// own success test (remote === local) then reported the drop as `MOVED`.
		if (before.value !== null) {
			if (!(yield* ensureCommitPresent(remote, ref, before.value))) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot prove containment — ${remote}/${ref} is at ${before.value}, which this checkout does not hold and could not fetch. Nothing was pushed.`,
					notes,
				);
			}
			const contains = yield* isAncestor(before.value, local.value);
			if (!contains && !options.forceWithLease) {
				return refuse(
					UNSAFE_PUSH,
					`${VERB}: non-fast-forward — pass --force-with-lease only for this lane's own repair resubmission.`,
					notes,
				);
			}
			if (!contains && !options.dropRemoteCommits) {
				const dropped = yield* commitsDropped(local.value, before.value);
				return refuse(
					HEAD_DROPS_REMOTE,
					`${VERB}: the local head does not contain ${remote}/${ref} (${before.value}) — this push would DROP ${
						dropped.lines.length === 0
							? "commits the remote holds and this head does not"
							: `${dropped.lines.join("; ")}${dropped.truncated ? "; …" : ""}`
					}. Rebase onto the published head, or pass --drop-remote-commits to rewrite it deliberately.`,
					notes,
				);
			}
			if (!contains) {
				notes.push(
					`${VERB}: --drop-remote-commits given — publishing a head that drops ${remote}/${ref} (${before.value}).`,
				);
			}
		}

		const pushed = yield* push(remote, ref, options.forceWithLease);
		const after = yield* remoteSha(remote, ref);
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: pushed, but the remote ref could not be re-read: ${after.reason} — the outcome is UNKNOWN.`,
				notes,
			);
		}
		if (after.value !== local.value) {
			return refuse(
				REF_NOT_MOVED,
				`${VERB}: the remote ref did not move (remote ${after.value ?? "absent"} ≠ local ${local.value}).`,
				[
					...notes,
					...(pushed._tag === "Failure" ? [`${VERB}: git push reported: ${pushed.reason}.`] : []),
				],
			);
		}
		const report = [
			`pushed ${lane.branch} → ${remote}/${ref}`,
			`remote ref read back: ${after.value}`,
		];
		if (step._tag === "Repair") return answer([...report, VERDICT].join("\n"), notes);

		// A refusal past here carries the push report on stderr: the ref moved, and a re-run of this
		// verb finishes the create, since the re-run's push is a no-op and the create answers `existing`.
		const pull = yield* openLanePull({
			verb: VERB,
			env: options.env,
			repo: resolved.repo,
			head: ref,
			issue: step.issue,
			body: step.body,
			notes: [...notes, ...report.map((line) => `${VERB}: ${line}.`), `${VERB}: ${VERDICT}`],
		});
		if (pull._tag === "Refused") return pull.outcome;
		return answer([...report, pullAnswerLine(pull), VERDICT].join("\n"), notes);
	});
