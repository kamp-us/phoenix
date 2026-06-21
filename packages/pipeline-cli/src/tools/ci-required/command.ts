/**
 * The `ci-required` tool — `pipeline-cli ci-required`.
 *
 * The CI aggregator assertion for issue #786 (ADR 0092), moved into the
 * pipeline-cli registry (epic #994, Phase 2 / #999). Reads the gating jobs'
 * `needs.*.result` + the single-sourced `*_required` booleans from `process.env`
 * (the `ci-required` step's `env:` block in ci.yml), runs the pure `judge` core,
 * prints the per-job verdicts (ADR 0092 §1 "emit what you scanned"), and exits 0
 * on PASS / 1 on FAIL.
 *
 * The tool takes no subcommand and no flags — the whole input is the env block,
 * exactly as the former `node packages/ci-required/src/bin.ts` (a bare bin) read
 * it. The print sequence and exit-code contract (0 = PASS / 1 = FAIL) are
 * preserved byte-for-byte; only the IO shell moves from a plain-Node bin to this
 * Effect `Command`. The pure core (`inputFromEnv` + `judge`) is unchanged and
 * stays zero-runtime-dependency plain-Node — `command.ts` is the IO shell: read
 * env, print, exit.
 */
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {inputFromEnv, judge} from "./ci-required.ts";

export const ciRequiredCommand = Command.make(
	"ci-required",
	{},
	Effect.fn(function* () {
		const verdict = judge(inputFromEnv(process.env));

		if (verdict.changesReport) {
			yield* Console.log(`::error::${verdict.changesReport.reason}`);
		}
		for (const job of verdict.jobs) {
			yield* Console.log(job.verdict === "FAIL" ? `::error::${job.reason}` : job.reason);
		}

		if (verdict.pass) {
			yield* Console.log(
				"ci-required PASS — every should-have-run gating job succeeded; all skips were legitimately not-applicable",
			);
			return;
		}
		yield* Console.log(
			"::error::ci-required FAILED — a should-have-run gating job was skipped or failed (see per-job verdicts above)",
		);
		return yield* Effect.sync(() => process.exit(1));
	}),
).pipe(
	Command.withDescription(
		"Require should-have-run gating jobs to have passed; fail-closed on a silent skip (#786, ADR 0092)",
	),
);
