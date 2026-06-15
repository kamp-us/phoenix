/**
 * `@phoenix/crabbox-manifest` — the crabbox → ADR 0054 §2 run-evidence adapter.
 *
 * A pure transform between a crabbox run and a SHA-bound bundle manifest. The
 * domain (`Manifest` / `Check` / `TestSummary` / `RunMeta`) is `effect/Schema`;
 * the boundary (`decodeRunSummary` / `parseJUnit`) lowers untrusted crabbox
 * output (the shape verified in spike #235) into it; `buildManifest` is the pure
 * `(RunSummary + TestSummary + commit + logs) => Manifest` core; and `Git` stamps
 * `commit` from `git rev-parse HEAD` (the one gap #235 found — crabbox doesn't
 * emit the SHA). The CLI (`bin.ts`) wires these into an executable that emits the
 * manifest JSON to stdout or a `--output` path. Persistence/transport of the
 * bundle is a sibling's job (#245); the gate reading it is a sibling's (#246/#247).
 */
export {type AdapterInput, buildManifest} from "./adapter.ts";
export {Git, GitLive, MissingCommitError} from "./commit.ts";
export {
	CrabboxArtifact,
	CrabboxCommand,
	CrabboxParseError,
	decodeRunSummary,
	parseJUnit,
	parseRunSummaryJson,
	RunSummary,
} from "./crabbox.ts";
export {
	Check,
	CheckStatus,
	LeaseMeta,
	LogsRef,
	Manifest,
	manifestToJson,
	RunMeta,
	SCHEMA_VERSION,
	TestFailure,
	TestSummary,
} from "./Manifest.ts";
