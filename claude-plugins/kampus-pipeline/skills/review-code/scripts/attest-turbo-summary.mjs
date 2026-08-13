// Read a turbo `--summarize` run summary and say, in one citable line, whether its tasks EXECUTED
// in this invocation or were REPLAYED from cache (#4887). Called by `attested-turbo-run.sh`; kept in
// its own file so `verify-turbo-attestation.sh` can exercise the judgement against fixtures without
// a materialized review worktree.
//
// usage: node attest-turbo-summary.mjs <run-summary.json> <task>
// exits: 0 attested RAN (line on stdout) · 3 zero scope · 4 REPLAYED (line on stdout) · 2 usage
//
// `cache.status` is turbo's own field — MISS means the task executed, HIT means it was restored.
// Anything else counts as not-executed, because an unrecognized status is UNKNOWN and UNKNOWN is
// never the permissive answer (ADR 0092).
import {readFileSync} from "node:fs";

const [summaryPath, task] = process.argv.slice(2);
if (!summaryPath || !task) {
	process.stderr.write("usage: node attest-turbo-summary.mjs <run-summary.json> <task>\n");
	process.exit(2);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
if (tasks.length === 0) {
	process.stderr.write(
		"attest-turbo-summary: the run summary lists 0 tasks — nothing was checked, which is UNKNOWN, not clean (ADR 0092 zero scope).\n",
	);
	process.exit(3);
}

const replayed = tasks.filter((t) => !t.cache || t.cache.status !== "MISS");
const verdict = replayed.length === 0 ? "RAN" : "REPLAYED";
const parts = [
	`TURBO-ATTESTATION: task=${task}`,
	`verdict=${verdict}`,
	`turbo=${summary.turboVersion}`,
	`tasks=${tasks.length}`,
	`executed=${tasks.length - replayed.length}`,
	`replayed=${replayed.length}`,
];
if (replayed.length > 0) {
	const named = replayed.map((t) => `${t.taskId}:${t.cache ? t.cache.status : "unknown"}`);
	parts.push(`replayed-tasks=${named.join(",")}`);
}
process.stdout.write(`${parts.join(" ")}\n`);
process.exit(verdict === "RAN" ? 0 : 4);
