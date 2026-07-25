/**
 * The pure classifier behind `run-evidence read` — IO-free, total, unit-testable.
 *
 * One decision, and the whole point of the tool: given what a lookup actually observed at a PR's
 * head SHA, is the SHA-bound run-evidence bundle PRESENT, PENDING, ABSENT, or UNKNOWN?
 *
 * The four states are not a taxonomy for its own sake — they are four different facts that a
 * binary present/absent read collapsed into one false claim (#3991). `review-code` reported
 * "absent for this head SHA" twice for bundles that were present or merely unpublished-yet,
 * because every non-success path in its inline lookup — a producer that had not run, a run still
 * in flight, a 5xx during the download, a non-archive error body — left the same empty variable
 * and was narrated as absence. So:
 *
 *   - PENDING is not ABSENT. A producer that exists but has not published for this head yet says
 *     nothing about the PR; reporting it absent invents a CI gap (the #3913 instance).
 *   - UNKNOWN is not ABSENT. A read that failed is a failed read, not a missing bundle; collapsing
 *     the two makes a GitHub hiccup look like a producer that never ran (the #3693 / #3716 class,
 *     which `ship-it` Step 3.5 already separates and `review-code` did not).
 *   - ABSENT is claimed only on positive evidence that the producer yielded nothing for this head:
 *     no producer workflow in the repo, a run that COMPLETED and published no artifact, or an
 *     expired artifact.
 *
 * Every reading also carries the lookup evidence it was decided from (the queried SHA, the run id,
 * the run's status, the artifact id), so the claim is falsifiable from the verdict comment alone
 * instead of being free prose.
 */
import {SCHEMA_VERSION} from "../crabbox-manifest/Manifest.ts";

/** The GitHub Actions workflow + artifact name the producer publishes under (ADR 0056 fetch contract). */
export const PRODUCER_NAME = "run-evidence";

/** The manifest entry inside the artifact archive. */
export const MANIFEST_ENTRY = "manifest.json";

/** The four states a bundle lookup can resolve to. Exhaustive, and pairwise distinct by design. */
export type BundleState = "present" | "pending" | "absent" | "unknown";

/** Why the lookup resolved to its state — a stable code a consumer may branch on. */
export type ReasonCode =
	| "validated"
	| "no-producer-workflow"
	| "no-run-at-head-yet"
	| "run-not-completed"
	| "run-completed-without-artifact"
	| "artifact-expired"
	| "producer-unreadable"
	| "runs-unreadable"
	| "artifacts-unreadable"
	| "download-unreadable"
	| "archive-unreadable"
	| "manifest-unreadable"
	| "unsupported-schema-version"
	| "manifest-commit-mismatch";

/** A producer workflow run, as the runs endpoint surfaces it (only these fields decide). */
export interface ProducerRun {
	readonly id: number;
	/** The commit the run executed against — the binding key; only an EXACT head match counts. */
	readonly headSha: string;
	/** `queued` | `in_progress` | `completed` — anything but `completed` is PENDING, never absent. */
	readonly status: string;
	readonly conclusion: string | null;
	readonly createdAt: string;
}

/** The manifest fields a verdict cites (ADR 0054 §2), folded once for the report line. */
export interface ManifestSummary {
	readonly commit: string;
	readonly schemaVersion: number;
	readonly checks: ReadonlyArray<{readonly name: string; readonly status: string}>;
	readonly tests: {
		readonly total: number;
		readonly passed: number;
		readonly failed: number;
		readonly skipped: number;
		readonly failingSuites: ReadonlyArray<string>;
	};
}

/**
 * What the lookup terminated on. The shell's only job is to produce exactly one of these; every
 * classification decision — including validating the manifest before interpreting it — is made here.
 */
export type Observation =
	| {readonly _tag: "ProducerUnreadable"; readonly cause: string}
	| {readonly _tag: "ProducerWorkflowAbsent"}
	| {readonly _tag: "RunsUnreadable"; readonly cause: string}
	| {readonly _tag: "NoRunAtHead"}
	| {readonly _tag: "RunNotCompleted"; readonly run: ProducerRun}
	| {readonly _tag: "ArtifactsUnreadable"; readonly run: ProducerRun; readonly cause: string}
	| {readonly _tag: "ArtifactMissing"; readonly run: ProducerRun}
	| {readonly _tag: "ArtifactExpired"; readonly run: ProducerRun; readonly artifactId: number}
	| {
			readonly _tag: "DownloadUnreadable";
			readonly run: ProducerRun;
			readonly artifactId: number;
			readonly cause: string;
	  }
	| {
			readonly _tag: "ArchiveUnreadable";
			readonly run: ProducerRun;
			readonly artifactId: number;
			readonly cause: string;
	  }
	| {
			readonly _tag: "ManifestUnreadable";
			readonly run: ProducerRun;
			readonly artifactId: number;
			readonly cause: string;
	  }
	| {
			readonly _tag: "ManifestRead";
			readonly run: ProducerRun;
			readonly artifactId: number;
			readonly manifest: ManifestSummary;
	  };

export interface Probe {
	/** The PR's live head SHA the lookup keyed on — the whole binding (ADR 0054 §1). */
	readonly queriedSha: string;
	/** Producer runs found at that exact head; `null` when the runs list itself was unreadable. */
	readonly runsAtHead: number | null;
	readonly observation: Observation;
}

/** The checkable lookup evidence a verdict line carries, so a reader can re-derive the claim. */
export interface LookupEvidence {
	readonly queriedSha: string;
	readonly runsAtHead: number | null;
	readonly runId: number | null;
	readonly runStatus: string | null;
	readonly runConclusion: string | null;
	readonly artifactId: number | null;
}

export interface BundleReading {
	readonly state: BundleState;
	readonly reason: ReasonCode;
	/** The human cause — a captured `gh` stderr line, a magic mismatch, a decode message. */
	readonly detail: string;
	readonly evidence: LookupEvidence;
	/** The validated manifest. Non-null iff `state === "present"`. */
	readonly manifest: ManifestSummary | null;
}

/**
 * The newest producer run whose `head_sha` EXACTLY equals the queried head. The exact-match filter
 * is load-bearing: a run from an earlier push is not evidence for this commit (ADR 0056 §2).
 */
export const resolveProducerRun = (
	runs: ReadonlyArray<ProducerRun>,
	headSha: string,
): ProducerRun | null => {
	const atHead = runs.filter((run) => run.headSha === headSha);
	return atHead.reduce<ProducerRun | null>((newest, run) => {
		if (newest === null) return run;
		if (run.createdAt !== newest.createdAt) return run.createdAt > newest.createdAt ? run : newest;
		return run.id > newest.id ? run : newest;
	}, null);
};

const runEvidence = (probe: Probe, run: ProducerRun | null, artifactId: number | null) => ({
	queriedSha: probe.queriedSha,
	runsAtHead: probe.runsAtHead,
	runId: run?.id ?? null,
	runStatus: run?.status ?? null,
	runConclusion: run?.conclusion ?? null,
	artifactId,
});

/** Classify one lookup. Total over `Observation`; the manifest is validated before it is trusted. */
export const classifyBundle = (probe: Probe): BundleReading => {
	const observation = probe.observation;
	const reading = (
		state: BundleState,
		reason: ReasonCode,
		detail: string,
		run: ProducerRun | null,
		artifactId: number | null,
		manifest: ManifestSummary | null = null,
	): BundleReading => ({
		state,
		reason,
		detail,
		evidence: runEvidence(probe, run, artifactId),
		manifest,
	});

	switch (observation._tag) {
		case "ProducerUnreadable":
			return reading("unknown", "producer-unreadable", observation.cause, null, null);
		case "ProducerWorkflowAbsent":
			return reading(
				"absent",
				"no-producer-workflow",
				`this repo defines no \`${PRODUCER_NAME}\` workflow, so no bundle is produced for any head`,
				null,
				null,
			);
		case "RunsUnreadable":
			return reading("unknown", "runs-unreadable", observation.cause, null, null);
		case "NoRunAtHead":
			return reading(
				"pending",
				"no-run-at-head-yet",
				`the \`${PRODUCER_NAME}\` producer exists but has no run at this head yet`,
				null,
				null,
			);
		case "RunNotCompleted":
			return reading(
				"pending",
				"run-not-completed",
				`producer run is \`${observation.run.status}\`, not \`completed\``,
				observation.run,
				null,
			);
		case "ArtifactsUnreadable":
			return reading("unknown", "artifacts-unreadable", observation.cause, observation.run, null);
		case "ArtifactMissing":
			return reading(
				"absent",
				"run-completed-without-artifact",
				`producer run completed (${observation.run.conclusion ?? "no conclusion"}) and published no \`${PRODUCER_NAME}\` artifact`,
				observation.run,
				null,
			);
		case "ArtifactExpired":
			return reading(
				"absent",
				"artifact-expired",
				"the published artifact has expired (GitHub artifact retention)",
				observation.run,
				observation.artifactId,
			);
		case "DownloadUnreadable":
			return reading(
				"unknown",
				"download-unreadable",
				observation.cause,
				observation.run,
				observation.artifactId,
			);
		case "ArchiveUnreadable":
			return reading(
				"unknown",
				"archive-unreadable",
				observation.cause,
				observation.run,
				observation.artifactId,
			);
		case "ManifestUnreadable":
			return reading(
				"unknown",
				"manifest-unreadable",
				observation.cause,
				observation.run,
				observation.artifactId,
			);
		case "ManifestRead": {
			const {run, artifactId, manifest} = observation;
			if (manifest.schemaVersion !== SCHEMA_VERSION) {
				return reading(
					"unknown",
					"unsupported-schema-version",
					`bundle schemaVersion ${manifest.schemaVersion}, this reader understands ${SCHEMA_VERSION}`,
					run,
					artifactId,
				);
			}
			// A run resolved by exact head_sha whose manifest attests a DIFFERENT commit is a
			// producer/consumer binding break, not an absent bundle: something published evidence for
			// another tree. Unreadable-as-evidence ⇒ UNKNOWN, never a claim about this head.
			if (manifest.commit !== probe.queriedSha) {
				return reading(
					"unknown",
					"manifest-commit-mismatch",
					`manifest.commit ${manifest.commit} != queried head ${probe.queriedSha}`,
					run,
					artifactId,
				);
			}
			return reading(
				"present",
				"validated",
				`manifest.commit == head, schemaVersion ${manifest.schemaVersion}`,
				run,
				artifactId,
				manifest,
			);
		}
	}
};

const short = (sha: string): string => (sha.length > 8 ? sha.slice(0, 8) : sha);

const checksSummary = (manifest: ManifestSummary): string => {
	const passed = manifest.checks.filter((check) => check.status === "pass").length;
	const failing = manifest.checks
		.filter((check) => check.status !== "pass")
		.map((check) => check.name);
	const total = manifest.checks.length;
	return failing.length === 0
		? `checks ${passed}/${total} pass`
		: `checks ${passed}/${total} pass (failing: ${failing.join(", ")})`;
};

const testsSummary = (manifest: ManifestSummary): string => {
	const {total, passed, failed, skipped, failingSuites} = manifest.tests;
	const counts = `tests ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`;
	return failingSuites.length === 0 ? counts : `${counts} (${failingSuites.join("; ")})`;
};

/**
 * The `Run-evidence bundle:` line a verdict carries. Every state names itself and the evidence it
 * was decided from, and the two non-ABSENT non-passing states say so in the line — the reader of a
 * verdict comment must be able to tell a not-yet-published bundle and a failed read apart from a
 * missing one without re-running the lookup.
 */
export const renderReportLine = (reading: BundleReading): string => {
	const {evidence, manifest} = reading;
	const head = short(evidence.queriedSha);
	const run = evidence.runId === null ? "no producer run" : `producer run ${evidence.runId}`;
	const queried = `queried head_sha=${head}, ${evidence.runsAtHead ?? "unreadable"} \`${PRODUCER_NAME}\` run(s) at head`;
	switch (reading.state) {
		case "present":
			return manifest === null
				? `Run-evidence bundle: PRESENT for head \`${head}\` — ${run} (${queried}).`
				: `Run-evidence bundle: PRESENT for head \`${head}\` — ${run}, artifact ${evidence.artifactId}, ${reading.detail}; ${checksSummary(manifest)}; ${testsSummary(manifest)}.`;
		case "pending":
			return `Run-evidence bundle: PENDING for head \`${head}\` — ${reading.detail} (${queried}${evidence.runId === null ? "" : `, ${run}`}). PENDING is not ABSENT: the producer has not published for this head yet.`;
		case "absent":
			return `Run-evidence bundle: ABSENT for head \`${head}\` — ${reading.detail} (${queried}${evidence.runId === null ? "" : `, ${run}`}).`;
		case "unknown":
			return `Run-evidence bundle: UNKNOWN for head \`${head}\` — the lookup could not be read (${reading.reason}: ${reading.detail}) (${queried}). UNKNOWN is not ABSENT: this is a failed read, not a missing bundle.`;
	}
};
