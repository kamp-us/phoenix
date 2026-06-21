/**
 * `worker-relevance` classify bin — the CI-callable surface for issue #1014.
 *
 * Reads the PR's changed-file list + the lockfile diff from `process.env` (set by
 * the `changes` job's classify step in ci.yml), runs the pure `classify` core, emits
 * the verdict to the log (ADR 0092 §1 "emit what you scanned"), and writes a
 * `worker_relevant=true|false` line to `$GITHUB_OUTPUT` so the job's
 * `integration_required`/`e2e_required` expressions can AND it in. Exits 0 always —
 * this is a classifier, not a gate; the workflow decides what to do with the verdict.
 *
 * ZERO runtime dependencies on purpose (the `@kampus/ci-required` idiom): the
 * `changes` job runs this with only checkout + setup-node + node — no `pnpm install`
 * — so the always-on changed-area detector stays fast. Plain Node (no Effect import)
 * for the same reason. The pure core (`classify` + `inputFromEnv`) is the
 * unit-tested module; this bin is the IO shell — read env, print, write output.
 */
import {appendFileSync} from "node:fs";

import {classify, inputFromEnv} from "./worker-relevance.ts";

const verdict = classify(inputFromEnv(process.env));

console.log(verdict.reason);

const workerRelevant = verdict.verdict === "relevant";
const output = process.env.GITHUB_OUTPUT;
if (output !== undefined && output !== "") {
	appendFileSync(output, `worker_relevant=${workerRelevant}\n`);
} else {
	// No $GITHUB_OUTPUT (local run) — print the line the workflow would have consumed.
	console.log(`worker_relevant=${workerRelevant}`);
}
