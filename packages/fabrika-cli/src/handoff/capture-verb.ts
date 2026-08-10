/**
 * `handoff capture` — derive the ground state as one JSON object, and write nothing.
 *
 * Every field is a total function of the git repository and the board; *what any of it means for the
 * work* is the caller's. That is what makes it safe for a successor to re-run against a pack it has
 * not yet decided to trust.
 *
 * **There is no empty answer.** A repository always has a git state and an issue always has a state,
 * so this verb either produces the object or refuses. `board.pull` being `null` is a **fact** (no
 * pull request has this head ref), not an absence, and so is `git.upstream` being `null`.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {repoDefaultBranch} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {deriveGround, renderGround} from "./ground.ts";
import {requireIssue, targetRepo} from "./guards.ts";

export interface CaptureOptions {
	readonly issue: number;
	readonly base: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const VERB = "handoff capture";

export const runCapture = (
	options: CaptureOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
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
					`${VERB}: cannot read ${repo}'s default branch: ${named.reason} — the base the work is measured against is UNKNOWN.`,
				);
			}
			base = named.value;
		}

		const ground = yield* deriveGround({
			repo,
			issue: options.issue,
			ref: null,
			base,
			board: {state: issue.value.state, labels: issue.value.labels},
			now: options.now,
		});
		if (ground._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				ground.failure.kind === "git"
					? `${VERB}: not inside a readable git working tree (${ground.failure.reason}) — the ground is UNKNOWN, never clean.`
					: `${VERB}: cannot read #${options.issue}'s pull request or its check runs: ${ground.failure.reason} — reporting checks as none would claim a read that failed.`,
			);
		}

		const pull = ground.value.board.pull;
		return answer(renderGround(ground.value), [
			`${VERB}: ${repo}, branch ${ground.value.git.branch}, base ${base}, pull ${pull === null ? "none" : `#${pull.number}`}.`,
		]);
	});
