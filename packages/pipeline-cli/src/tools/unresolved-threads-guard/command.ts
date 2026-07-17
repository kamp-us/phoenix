/**
 * The `unresolved-threads-guard` tool — `pipeline-cli unresolved-threads-guard check --pr N`
 * (ADR 0158 enforcement, #3331).
 *
 * The fail-closed machine gate behind ADR 0158's unresolved-inline-thread merge gate, giving
 * review-code Step 3e the teeth it lacked (soft reviewer-prose a PASS could omit) AND covering
 * the §CP manual-merge path, which never touches ship-it Step 3.6. It reds when a live
 * unresolved inline review thread (human OR github-advanced-security[bot]/CodeQL) is
 * unaccounted-for in the latest authorized review-code verdict — the scan/IO lives in
 * `github.ts`, the decision in the pure core (`unresolved-threads-guard.ts`).
 *
 *   pipeline-cli unresolved-threads-guard check --pr <n>
 *
 * Exit-code contract: 0 = clean (no unaccounted unresolved thread), non-zero = failure — a
 * gate failure (report on stderr) AND an IO failure that can't determine thread state both
 * exit non-zero, FAIL-CLOSED: an unreadable review-thread channel reds rather than waves the
 * PR through (ADR 0092's zero-scope stance at the unreadable-channel seam). `GithubLive` is
 * baked in with `Command.provide(...)` so the registered command's residual requirement is the
 * Node platform union (the registry seam, epic #994).
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "./github.ts";
import {judge} from "./unresolved-threads-guard.ts";

const GATE_FAIL_EXIT_CODE = 1;

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription(
		"the pull request number to check for unaccounted unresolved review threads",
	),
);

/** Print `reason` on stderr and exit non-zero — both a gate fail and an unreadable-channel fail. */
const failClosed = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`${reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const check = Command.make(
	"check",
	{pr: prFlag},
	Effect.fn(function* ({pr}) {
		// Any failure to READ the thread state (repo unresolved, gh non-zero, malformed JSON)
		// fails closed: the guard reds rather than passing a PR whose review-thread channel it
		// could not read (the ADR 0092 zero-scope stance — an unreadable channel is not a clean one).
		const result = yield* (yield* Github).gather(pr).pipe(
			Effect.catchTags({
				"@kampus/unresolved-threads-guard/RepoResolutionError": (e) => failClosed(e.message),
				"@kampus/unresolved-threads-guard/GhCommandError": (e) =>
					failClosed(
						`unresolved-threads-guard: could not read PR #${pr} review-thread state (gh exit ${e.exitCode}: ${e.stderr.trim() || "no stderr"}) — failing closed`,
					),
				"@kampus/unresolved-threads-guard/GhParseError": (e) =>
					failClosed(
						`unresolved-threads-guard: could not parse PR #${pr} review-thread state (${e.message}) — failing closed`,
					),
				SchemaError: (e) =>
					failClosed(
						`unresolved-threads-guard: unexpected review-thread/comment shape for PR #${pr} (${e.message}) — failing closed`,
					),
			}),
		);
		const verdict = judge(result);
		if (verdict.pass) {
			yield* Console.log(verdict.report);
			return;
		}
		return yield* failClosed(verdict.report);
	}),
).pipe(
	Command.withDescription(
		"Red the PR when a substantive unresolved inline review thread is unaccounted-for in the review-code verdict",
	),
);

export const unresolvedThreadsGuardCommand = Command.make("unresolved-threads-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: no unaccounted unresolved inline review thread reaches a merge-ready PR (ADR 0158, #3331)",
	),
	Command.provide(GithubLive),
);
