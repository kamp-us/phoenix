/**
 * `ci-required` assertion bin — the CI-callable surface for issue #786.
 *
 * Reads the gating jobs' `needs.*.result` + the single-sourced `*_required`
 * booleans from `process.env` (the `ci-required` step's `env:` block in ci.yml),
 * runs the pure `judge` core, prints the per-job verdicts (ADR 0092 §1
 * "emit what you scanned"), and exits 0 on PASS / 1 on FAIL.
 *
 * ZERO runtime dependencies on purpose: the `ci-required` gate job runs only
 * `actions/checkout` + `node packages/ci-required/src/bin.ts` — no `pnpm install`,
 * so the always-on aggregator stays fast. This file is plain Node (no Effect
 * import) for the same reason; the repo's Effect-CLI idiom would pull
 * `@effect/platform-node` + `effect` into the gate's install path, which the
 * pure-node form avoids. The pure core (`inputFromEnv` + `judge`) is the
 * unit-tested module per the repo "pure core + thin bin" convention; this bin is
 * the IO shell — read env, print, exit.
 */
import {inputFromEnv, judge} from "./ci-required.ts";

const verdict = judge(inputFromEnv(process.env));

if (verdict.changesReport) {
	console.log(`::error::${verdict.changesReport.reason}`);
}
for (const job of verdict.jobs) {
	console.log(job.verdict === "FAIL" ? `::error::${job.reason}` : job.reason);
}

if (verdict.pass) {
	console.log(
		"ci-required PASS — every should-have-run gating job succeeded; all skips were legitimately not-applicable",
	);
} else {
	console.log(
		"::error::ci-required FAILED — a should-have-run gating job was skipped or failed (see per-job verdicts above)",
	);
	process.exit(1);
}
