/**
 * The `review-head` tool — `pipeline-cli review-head resolve` / `materialize`.
 *
 * The shared, tested owner of "materialize the PR's current review head for review" (#793 / #1807),
 * extracted from the inline copies the review-code / review-doc / review-skill gates each hand-rolled
 * and the head-SHA resolution review-design binds its verdict to. A pure resolution core
 * (`resolve-head.ts`) + the checkout step the verb owns (`materialize.ts`).
 *
 *   resolve --pr N         — print the current head SHA + ref as JSON (REST only). review-design.
 *   materialize --pr N      — resolve, fetch `pull/N/head` into a per-run ref, assert it IS the head,
 *     [--worktree]            and (with --worktree) add a throwaway DETACHED worktree. Prints the
 *                             resolved head + prRef (+ worktreeDir) as JSON on stdout for the caller
 *                             to `eval`/read; every refusal prints its reason on stderr and exits non-zero.
 *
 * The caller runs the §RO-iso primary-checkout preflight (gh-issue-intake-formats.md) BEFORE
 * `materialize` — this verb is the deterministic mechanism, not the isolation gate. `ReviewHeadLive`
 * is baked in with `Command.provide(...)` so the residual requirement is the Node platform union.
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {ReviewHead, ReviewHeadLive} from "./materialize.ts";

const FAIL_EXIT_CODE = 1;

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the pull request number"));

const worktreeFlag = Flag.boolean("worktree").pipe(
	Flag.withDescription(
		"also add a throwaway DETACHED worktree on the fetched head (code/skill gates); default is ref-only (review-doc reads via `git show`)",
	),
);

/** Print `reason` on stderr and exit non-zero — the refusal signal a caller branches on. */
const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`review-head: ${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

const resolve = Command.make(
	"resolve",
	{pr: prFlag},
	Effect.fn(function* ({pr}) {
		const head = yield* (yield* ReviewHead).resolve(pr).pipe(
			Effect.catchTag("@kampus/review-head/UnresolvableHeadError", (e) => fail(e.message)),
			// A 404 from `gh api pulls/<pr>` is the missing-PR fail-safe at the IO edge (the null-head
			// case is caught in the core): a clean refusal + non-zero exit, not a raw stack trace.
			Effect.catchTag("@kampus/gh-io/GhCommandError", (e) =>
				fail(`could not read PR #${pr} (gh exit ${e.exitCode}): ${e.stderr.trim() || "not found"}`),
			),
		);
		yield* Console.log(JSON.stringify({pr, ...head}));
	}),
).pipe(
	Command.withDescription(
		"Resolve a PR's current head SHA + ref via REST (exit 0 = a bindable head; non-zero = missing/closed/partial head)",
	),
);

const materialize = Command.make(
	"materialize",
	{pr: prFlag, worktree: worktreeFlag},
	Effect.fn(function* ({pr, worktree}) {
		const result = yield* (yield* ReviewHead).materialize(pr, worktree).pipe(
			Effect.catchTag("@kampus/review-head/UnresolvableHeadError", (e) => fail(e.message)),
			Effect.catchTag("@kampus/review-head/HeadMismatchError", (e) => fail(e.message)),
			Effect.catchTag("@kampus/review-head/GitCommandError", (e) =>
				fail(`git ${e.args.join(" ")} failed (exit ${e.exitCode}): ${e.stderr.trim()}`),
			),
			Effect.catchTag("@kampus/gh-io/GhCommandError", (e) =>
				fail(`could not read PR #${pr} (gh exit ${e.exitCode}): ${e.stderr.trim() || "not found"}`),
			),
		);
		yield* Console.log(JSON.stringify(result));
	}),
).pipe(
	Command.withDescription(
		"Materialize a PR's current head into a per-run ref (+ optional detached worktree), asserting the fetched ref IS the resolved head (§HEAD)",
	),
);

export const reviewHeadCommand = Command.make("review-head").pipe(
	Command.withSubcommands([resolve, materialize]),
	Command.withDescription(
		"Resolve + materialize a PR's current review head deterministically — the shared PR-head-checkout the gate skills cite (#793 / #1807)",
	),
	Command.provide(ReviewHeadLive),
);
