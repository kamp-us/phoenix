/**
 * `ci-required` gate bin — the CI-callable IO shell over `./required.ts`'s pure `judge`
 * (issue #786, ADR 0092): read the declared gating jobs' `needs.*.result` + `*_required`
 * booleans from `process.env`, print the per-job verdicts (ADR 0092 §1 "emit what you scanned"),
 * exit 0 on PASS / 1 on FAIL.
 *
 * **Not routed through `fabrika`'s bin, and that is the point.** The `ci-required` job runs
 * checkout + setup-node + this file, with no `pnpm install`, so the always-on aggregator stays
 * fast. One `import` of a relative plain-TS module is the whole module graph; an `effect` import
 * anywhere on this path would put the CLI's dependency tree on the gate's critical path.
 */
import {inputFromEnv, judge} from "./required.ts";

const verdict = judge(inputFromEnv(process.env));

for (const reason of verdict.scopeReasons) {
	console.log(`::error::ci-required: ${reason}`);
}
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
