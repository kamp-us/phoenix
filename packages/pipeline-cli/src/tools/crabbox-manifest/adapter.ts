/**
 * The pure transform: a decoded crabbox `RunSummary` + a parsed JUnit
 * `TestSummary` + the stamped commit + a logs ref → an ADR 0054 §2 `Manifest`.
 *
 * `buildManifest` is total over its decoded inputs — no IO, no throw — so the
 * whole adapter's correctness is unit-testable without git or a filesystem
 * (#244's T0 tests run it directly). It derives `checks[]` from per-command
 * `exitCode` (0 → `pass`, non-zero → `fail`), preferring the run-summary's
 * `commands[]` and falling back to a single check from the top-level `exitCode`;
 * folds the JUnit into `tests`; and carries crabbox's provider/lease facts into
 * the optional `lease` block. Commit stamping (the IO seam) lives in `commit.ts`;
 * this function just receives the resolved SHA.
 */
import type {CrabboxCommand, RunSummary} from "./crabbox.ts";
import type {Check, Manifest, TestSummary} from "./Manifest.ts";
import {SCHEMA_VERSION} from "./Manifest.ts";

/** Everything `buildManifest` needs, already lowered past the boundary. */
export interface AdapterInput {
	readonly summary: RunSummary;
	readonly tests: TestSummary;
	readonly commit: string;
	readonly logsRef: string;
	readonly timestamp: string;
	readonly runUrl?: string;
	readonly environment?: string;
}

const checkName = (cmd: CrabboxCommand, index: number): string =>
	cmd.name ?? cmd.command ?? `command-${index + 1}`;

/**
 * Derive one `checks[]` entry per crabbox command (0 → `pass`, non-zero →
 * `fail`). When crabbox emitted no per-command breakdown, fall back to a single
 * `run` check from the top-level `exitCode` — one check is always present, so the
 * gate's "all checks pass" assertion is meaningful even for a single-command run.
 */
const deriveChecks = (summary: RunSummary): ReadonlyArray<Check> => {
	const commands = summary.commands ?? [];
	if (commands.length === 0) {
		return [
			{name: "run", status: summary.exitCode === 0 ? "pass" : "fail", exitCode: summary.exitCode},
		];
	}
	return commands.map((cmd, i) => ({
		name: checkName(cmd, i),
		status: cmd.exitCode === 0 ? "pass" : "fail",
		exitCode: cmd.exitCode,
	}));
};

/** Fold crabbox's provider/lease facts into the optional ADR 0054 §2 `lease` block. */
const deriveLease = (summary: RunSummary): Manifest["lease"] => ({
	provider: summary.provider,
	...(summary.leaseId !== undefined ? {leaseId: summary.leaseId} : {}),
	...(summary.slug !== undefined ? {slug: summary.slug} : {}),
	...(summary.leaseStopped !== undefined ? {leaseStopped: summary.leaseStopped} : {}),
});

/**
 * Build the ADR 0054 §2 manifest. Pure: same inputs → same manifest, no IO. The
 * commit is the binding key (stamped upstream, asserted non-empty there); this
 * function trusts it as already-resolved.
 */
export const buildManifest = (input: AdapterInput): Manifest => ({
	schemaVersion: SCHEMA_VERSION,
	commit: input.commit,
	run: {
		producer: "crabbox",
		...(input.runUrl !== undefined ? {url: input.runUrl} : {}),
		timestamp: input.timestamp,
		...(input.environment !== undefined ? {environment: input.environment} : {}),
	},
	checks: deriveChecks(input.summary),
	tests: input.tests,
	logs: {ref: input.logsRef},
	lease: deriveLease(input.summary),
});
