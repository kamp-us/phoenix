/**
 * The ADR 0054 §2 run-evidence bundle manifest, as Effect Schema — the output
 * shape this adapter emits, and the trust unit the `ship-it`/`review-code` gates
 * consume (`bundle.commit == head SHA` + every check passed).
 *
 * The contract is defined by its *fields*, not its producer (ADR 0054 §2):
 * `commit`/`run`/`checks[]`/`tests`/`logs` are required, `coverage`/`media`/`lease`
 * optional. This module is the domain; `crabbox.ts` is the boundary that decodes
 * untrusted crabbox output into it, and `adapter.ts` is the pure transform that
 * folds a decoded run-summary + JUnit + the stamped commit into a `Manifest`.
 */
import * as Schema from "effect/Schema";

/** The manifest schema this package emits; bumped when the shape changes (ADR 0054, sibling #243). */
export const SCHEMA_VERSION = 1;

/** A gate step's outcome — derived from a crabbox command's `exitCode` (0 → `pass`). */
export const CheckStatus = Schema.Literals(["pass", "fail"]);
export type CheckStatus = (typeof CheckStatus)["Type"];

/**
 * One gate step (`typecheck`, `lint`, a test suite, …) → its `status` plus a
 * pointer to its machine-readable result (ADR 0054 §2 `checks[]`). `exitCode`
 * is retained as the evidence the `status` was derived from; `resultRef` points
 * at the artifact (e.g. a JUnit path) when one exists.
 */
export const Check = Schema.Struct({
	name: Schema.String,
	status: CheckStatus,
	exitCode: Schema.Number,
	resultRef: Schema.optional(Schema.String),
});
export type Check = (typeof Check)["Type"];

/** One JUnit `<testcase>` failure: the suite it belongs to + the failure message. */
export const TestFailure = Schema.Struct({
	suite: Schema.String,
	name: Schema.String,
	message: Schema.String,
});
export type TestFailure = (typeof TestFailure)["Type"];

/**
 * The folded JUnit summary (ADR 0054 §2 `tests`): totals + each failure's suite +
 * message. A run that produced no JUnit still carries a zeroed, present `tests`
 * (the adapter degrades, never crashes), so a consumer never has to branch on its
 * absence.
 */
export const TestSummary = Schema.Struct({
	total: Schema.Number,
	passed: Schema.Number,
	failed: Schema.Number,
	skipped: Schema.Number,
	failures: Schema.Array(TestFailure),
});
export type TestSummary = (typeof TestSummary)["Type"];

/**
 * Producer + run metadata (ADR 0054 §2 `run`): producer id, optional run URL,
 * an ISO timestamp, and the environment/stage. Folded from the crabbox
 * run-summary's provider/lease/timing.
 */
export const RunMeta = Schema.Struct({
	producer: Schema.String,
	url: Schema.optional(Schema.String),
	timestamp: Schema.String,
	environment: Schema.optional(Schema.String),
});
export type RunMeta = (typeof RunMeta)["Type"];

/** A reference to captured stdout/stderr for the run (ADR 0054 §2 `logs`). */
export const LogsRef = Schema.Struct({
	ref: Schema.String,
});
export type LogsRef = (typeof LogsRef)["Type"];

/**
 * Optional provider/lease metadata, populated only when a remote producer
 * generated the bundle (ADR 0054 §2 `lease` / §5). crabbox is such a producer,
 * so the adapter carries through the lease facts it emits.
 */
export const LeaseMeta = Schema.Struct({
	provider: Schema.String,
	leaseId: Schema.optional(Schema.String),
	slug: Schema.optional(Schema.String),
	leaseStopped: Schema.optional(Schema.Boolean),
});
export type LeaseMeta = (typeof LeaseMeta)["Type"];

/**
 * The full ADR 0054 §2 run-evidence manifest. `commit` is the binding key (the
 * head SHA the run executed against — `ship-it` asserts `commit == head SHA`);
 * `checks[]` carries the per-step pass/fail the gate folds; `tests`/`logs`/`run`
 * are the structured evidence `review-code` cites instead of scraping logs.
 */
export const Manifest = Schema.Struct({
	schemaVersion: Schema.Number,
	commit: Schema.String,
	run: RunMeta,
	checks: Schema.Array(Check),
	tests: TestSummary,
	logs: LogsRef,
	lease: Schema.optional(LeaseMeta),
});
export type Manifest = (typeof Manifest)["Type"];

const encodeManifest = Schema.encodeUnknownSync(Manifest);

/** Serialize a `Manifest` to the canonical, tab-indented JSON the adapter emits. */
export const manifestToJson = (manifest: Manifest): string =>
	`${JSON.stringify(encodeManifest(manifest), null, "\t")}\n`;
