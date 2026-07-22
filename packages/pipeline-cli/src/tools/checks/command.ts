/**
 * The `checks` tool — `pipeline-cli checks read --pr N | --sha S [--expect green|red|pending]`.
 *
 *   node src/bin.ts checks read --pr 3733            # exit 0 = the head is green
 *   node src/bin.ts checks read --pr 3733 --expect red   # exit 0 = the head is genuinely red
 *
 * The single tested head-CI read every consumer that gates on check-run state cites instead of
 * hand-rolling the query (#3762, the same single-source move as `verdict read` in #3686). It
 * exists because the naive `conclusion != "success"` filter over
 * `commits/{sha}/check-runs` reads SUPERSEDED runs as current and calls a green head red —
 * `checks.ts` documents the verified endpoint behavior that makes that so.
 *
 * The exit status is the answer, mirroring `verdict read`: 0 when the rollup equals `--expect`
 * (default `green`), non-zero otherwise, with the reason on stderr and the full rollup as JSON
 * on stdout for a caller that wants the failing context names. `GithubLive` is baked in with
 * `Command.provide(...)` so the registered command's residual requirement is the Node platform
 * union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import type {ChecksConclusion} from "./checks.ts";
import {Github, GithubLive} from "./github.ts";

const FAIL_EXIT_CODE = 1;

const CONCLUSIONS: ReadonlyArray<ChecksConclusion> = ["green", "red", "pending"];

const prFlag = Flag.integer("pr").pipe(
	Flag.optional,
	Flag.withDescription("the pull request whose current head to read (resolves the head SHA)"),
);

const shaFlag = Flag.string("sha").pipe(
	Flag.optional,
	Flag.withDescription("the head SHA to read directly (alternative to --pr)"),
);

const expectFlag = Flag.string("expect").pipe(
	Flag.optional,
	Flag.withDescription(`the rollup an exit 0 means: ${CONCLUSIONS.join(" | ")} (default: green)`),
);

/** Print `reason` on stderr and exit non-zero — the "not satisfied / bad input" signal a caller branches on. */
const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`checks: ${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

const parseExpect = (raw: Option.Option<string>): Effect.Effect<ChecksConclusion, never> => {
	const value = Option.getOrElse(raw, () => "green")
		.trim()
		.toLowerCase();
	return (CONCLUSIONS as ReadonlyArray<string>).includes(value)
		? Effect.succeed(value as ChecksConclusion)
		: fail(`invalid --expect '${value}' — expected one of ${CONCLUSIONS.join(" | ")}`);
};

const read = Command.make(
	"read",
	{pr: prFlag, sha: shaFlag, expect: expectFlag},
	Effect.fn(function* ({pr, sha, expect}) {
		const expected = yield* parseExpect(expect);
		const gh = yield* Github;
		const pinned = Option.getOrUndefined(sha);
		const prNumber = Option.getOrUndefined(pr);
		if ((pinned === undefined) === (prNumber === undefined)) {
			return yield* fail("pass exactly one of --pr <n> or --sha <sha>");
		}
		const head = pinned ?? (yield* gh.headSha(prNumber as number));
		const rollup = yield* gh.read(head);
		yield* Console.log(
			JSON.stringify({
				conclusion: rollup.conclusion,
				sha: head,
				contexts: rollup.latest.length,
				failing: rollup.failing.map((c) => c.name),
				running: rollup.running.map((c) => c.name),
			}),
		);
		const detail =
			rollup.conclusion === "red"
				? ` (failing: ${rollup.failing.map((c) => c.name).join(", ")})`
				: rollup.conclusion === "pending"
					? ` (running: ${rollup.running.map((c) => c.name).join(", ") || "nothing has reported yet"})`
					: "";
		if (rollup.conclusion === expected) {
			process.stderr.write(
				`checks: ${head} is ${rollup.conclusion} over ${rollup.latest.length} contexts${detail}\n`,
			);
			return;
		}
		return yield* fail(
			`${head} is ${rollup.conclusion} over ${rollup.latest.length} contexts${detail}, expected ${expected}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Roll a head's check-runs up latest-per-context (exit 0 = the rollup matches --expect, default green)",
	),
);

export const checksCommand = Command.make("checks").pipe(
	Command.withSubcommands([read]),
	Command.withDescription(
		"Read a PR/commit head's CI state latest-per-context — the shared head-CI reader a stale superseded run can't red (#3762)",
	),
	Command.provide(GithubLive),
);
