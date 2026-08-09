/**
 * `ship evidence` — the SHA-bound run-evidence bundle, read as four states.
 *
 * Every claim carries the lookup evidence that makes it falsifiable from the report: the `lookup`
 * line names the run, the artifact and the run's status, so a reader can re-derive the answer
 * instead of trusting it.
 *
 * The two collapses this verb refuses are v1's worst: **pending is not absent** (reporting it absent
 * invents a CI gap, #3913) and a **failed read is not absent** (a 503 body reported as "no
 * run-evidence bundle" for a bundle present the whole time, #3716 — which is why the fetch checks
 * the zip magic number rather than trusting the file's name).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {isRecord, parseJson} from "../io/json.ts";
import {commitExists} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	fetchManifest,
	listRunArtifacts,
	listRunsAtHead,
	makeScratchDirectory,
	workflowExists,
} from "./github.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship evidence";

/** The producer, named by ADR 0054's own contract rather than discovered by a heuristic. */
const PRODUCER_WORKFLOW = "run-evidence.yml";
const ARTIFACT_NAME = "run-evidence";
const SCHEMA_VERSION = 1;

/** The conclusions a bundle's `checks[]` entry may carry and still attest a passing run. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export interface ManifestCheck {
	readonly name: string;
	readonly status: string;
}

export interface Manifest {
	readonly schemaVersion: number;
	readonly commit: string;
	readonly checks: ReadonlyArray<ManifestCheck>;
}

/**
 * The manifest's shape, validated positively.
 *
 * `checks[]` entries carry a **string `status`**, not a boolean `pass` — the wire shape is the
 * producer's, and a parser written against prose that said "boolean" reads everything falsy (#4392).
 */
export const readManifest = (text: string): Manifest | null => {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) return null;
	if (typeof parsed.schemaVersion !== "number" || typeof parsed.commit !== "string") return null;
	if (!Array.isArray(parsed.checks)) return null;
	const checks: ManifestCheck[] = [];
	for (const value of parsed.checks) {
		if (!isRecord(value) || typeof value.name !== "string" || typeof value.status !== "string") {
			return null;
		}
		checks.push({name: value.name, status: value.status});
	}
	return {schemaVersion: parsed.schemaVersion, commit: parsed.commit, checks};
};

export interface EvidenceOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runEvidence = (
	options: EvidenceOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what} for ${bound}: ${reason} — whether a bundle exists is UNKNOWN, never "absent" (#3716).`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable("the pull request", reason),
		});
		if (target._tag === "Refused") return target.outcome;

		const at = yield* commitExists(repo, bound);
		if (at._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: no commit ${bound} on PR #${pr}.`);
		}
		if (at._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the commit", at.reason));
		}

		const diagnostics: string[] = [];
		const emit = (
			state: string,
			run: number | null,
			artifact: number | null,
			status: string | null,
			checks: ReadonlyArray<ManifestCheck>,
		): VerbOutcome =>
			json
				? answer(JSON.stringify({outcome: state, sha: bound, run, artifact, checks}), diagnostics)
				: answer(
						[
							`evidence\t${state}\t${bound}`,
							`lookup\trun:${run ?? NULL_TOKEN}\tartifact:${artifact ?? NULL_TOKEN}\tstatus:${status ?? NULL_TOKEN}`,
							...checks.map((check) => `check\t${check.name}\t${check.status}`),
						].join("\n"),
						diagnostics,
					);

		const producer = yield* workflowExists(repo, PRODUCER_WORKFLOW);
		if (producer._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the workflow inventory", producer.reason));
		}
		if (producer._tag === "Absent") {
			// The foreign-repo degradation (ADR 0086) — confirmed by a SUCCESSFUL inventory read, which
			// is what makes it a fact about the repository rather than a failed lookup wearing a state.
			diagnostics.push(`${VERB}: no ${PRODUCER_WORKFLOW} in ${repo} — no producer, so no bundle.`);
			return emit("absent", null, null, null, []);
		}

		const listed = yield* listRunsAtHead(repo, bound);
		if (listed._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the run list", listed.reason));
		}
		diagnostics.push(
			scannedLine(
				VERB,
				listed.value.runs.length,
				"workflow run",
				`${listed.value.declared} declared`,
			),
		);
		if (listed.value.runs.length < listed.value.declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${listed.value.runs.length} of ${listed.value.declared} declared runs — refusing the partial enumeration.`,
				diagnostics,
			);
		}
		const run = listed.value.runs.find((candidate) => candidate.name.includes(ARTIFACT_NAME));
		if (run === undefined) return emit("absent", null, null, null, []);
		if (run.status !== "completed") return emit("pending", run.id, null, run.status, []);

		const artifacts = yield* listRunArtifacts(repo, run.id);
		if (artifacts._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("the artifact list", artifacts.reason),
				diagnostics,
			);
		}
		if (artifacts.value.artifacts.length < artifacts.value.declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${artifacts.value.artifacts.length} of ${artifacts.value.declared} declared artifacts — refusing the partial enumeration.`,
				diagnostics,
			);
		}
		const artifact = artifacts.value.artifacts.find((entry) => entry.name === ARTIFACT_NAME);
		if (artifact === undefined || artifact.expired) {
			return emit("absent", run.id, artifact?.id ?? null, run.status, []);
		}

		const scratch = yield* makeScratchDirectory;
		if (scratch._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("a scratch directory", scratch.reason),
				diagnostics,
			);
		}
		const fetched = yield* fetchManifest(repo, artifact.id, scratch.value);
		if (fetched._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("the artifact content", fetched.reason),
				diagnostics,
			);
		}
		const manifest = readManifest(fetched.value);
		if (manifest === null || manifest.schemaVersion !== SCHEMA_VERSION) {
			diagnostics.push(
				`${VERB}: the manifest's schema version is not ${SCHEMA_VERSION} — it cannot bind this head.`,
			);
			return emit("unknown", run.id, artifact.id, run.status, []);
		}
		if (manifest.commit !== bound) {
			diagnostics.push(
				`${VERB}: the bundle attests ${manifest.commit}, you asked about ${bound} — a bundle about another tree is not evidence about this one.`,
			);
			return emit("unknown", run.id, artifact.id, run.status, manifest.checks);
		}
		const failing = manifest.checks.filter((check) => !PASSING.has(check.status));
		if (failing.length > 0) {
			diagnostics.push(
				`${VERB}: the bundle binds ${bound} and ${failing.length} of its checks did not pass (${failing
					.map((check) => check.name)
					.join(", ")}) — it attests a run, not a passing one.`,
			);
			return emit("unknown", run.id, artifact.id, run.status, manifest.checks);
		}
		return emit("present", run.id, artifact.id, run.status, manifest.checks);
	});
