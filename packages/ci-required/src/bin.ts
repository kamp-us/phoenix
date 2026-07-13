/**
 * `ci-required` assertion bin — the CI-callable IO shell for the pure `judge`
 * core (issue #786, ADR 0092): read the gating jobs' `needs.*.result` + the
 * `*_required` booleans from `process.env`, print the per-job verdicts (ADR 0092
 * §1 "emit what you scanned"), exit 0 on PASS / 1 on FAIL.
 *
 * ZERO runtime dependencies on purpose: the `ci-required` gate job runs only
 * `actions/checkout` + `node packages/ci-required/src/bin.ts` — no `pnpm install`
 * — so the always-on aggregator stays fast. Plain Node (no Effect import) for the
 * same reason: the Effect-CLI idiom would pull `@effect/platform-node` + `effect`
 * into the gate's install path.
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
