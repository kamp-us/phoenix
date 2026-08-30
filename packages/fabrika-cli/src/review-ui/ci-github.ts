import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {ambientToken, authed, onTransport, pagedEnvelope, restBytes} from "../io/gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import {type LocalhostHarnessDeclaration, parseCiCaptureManifest} from "./localhost-evidence.ts";

export interface PullAssociation {
	readonly number: number;
	readonly head: string;
}

export interface RunRecord {
	readonly id: number;
	readonly status: string;
	readonly conclusion: string | null;
	readonly event: string;
	readonly path: string;
	readonly repository: string;
	readonly authorityHead: string;
	readonly checkSuiteId: number;
	readonly pulls: readonly PullAssociation[];
}

export interface CiIdentity {
	readonly runId: number;
	readonly checkId: number;
	readonly artifactId: number;
	readonly artifactName: string;
	readonly authorityHead: string;
}

export interface CiBundle extends CiIdentity {
	readonly directory: string;
	readonly manifestText: string;
}

export type CiBundleAttempt =
	| {readonly _tag: "Ok"; readonly value: CiBundle}
	| {readonly _tag: "Failure"; readonly reason: string; readonly kind?: "malformed-members"};

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

const runsForWorkflow = (repo: string, workflow: string): Shell<Attempt<readonly RunRecord[]>> =>
	authed((token) =>
		Effect.map(
			pagedEnvelope(
				token,
				`repos/${repo}/actions/workflows/${encodeURIComponent(workflow.split("/").at(-1) ?? workflow)}/runs`,
				"workflow_runs",
			),
			(read) => {
				if (read._tag === "Failure") return read;
				const runs: RunRecord[] = [];
				for (const value of read.value.entries) {
					if (
						!isRecord(value) ||
						typeof value.id !== "number" ||
						typeof value.status !== "string" ||
						typeof value.event !== "string" ||
						typeof value.head_sha !== "string" ||
						typeof value.check_suite_id !== "number" ||
						!Array.isArray(value.pull_requests)
					) {
						return fail("GitHub answered 200 but one workflow run is incomplete");
					}
					const pulls: PullAssociation[] = [];
					for (const pull of value.pull_requests) {
						if (
							!isRecord(pull) ||
							typeof pull.number !== "number" ||
							!isRecord(pull.head) ||
							typeof pull.head.sha !== "string"
						) {
							return fail("GitHub answered 200 but one workflow run association is incomplete");
						}
						pulls.push({number: pull.number, head: pull.head.sha});
					}
					runs.push({
						id: value.id,
						status: value.status,
						conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
						event: value.event,
						path: stringOf(value.path),
						repository: isRecord(value.repository) ? stringOf(value.repository.full_name) : "",
						authorityHead: value.head_sha,
						checkSuiteId: value.check_suite_id,
						pulls,
					});
				}
				return ok(runs);
			},
		),
	);

export const selectTrustedRun = (
	runs: readonly RunRecord[],
	repo: string,
	pr: number,
	head: string,
	authorityHead: string,
	harness: LocalhostHarnessDeclaration,
): Attempt<RunRecord> => {
	const associated = runs.filter(
		(run) =>
			run.path === harness.workflow &&
			run.event === harness.event &&
			run.repository === repo &&
			run.authorityHead === authorityHead &&
			run.pulls.some((pull) => pull.number === pr && pull.head === head),
	);
	if (associated.length !== 1) {
		return fail(
			associated.length === 0
				? `no ${harness.workflow} run is associated with PR #${pr} at ${head}`
				: `${associated.length} ${harness.workflow} runs are associated with PR #${pr} at ${head} — the producer is ambiguous`,
		);
	}
	const run = associated[0] as RunRecord;
	return run.status === "completed" && run.conclusion === "success"
		? ok(run)
		: fail(`run ${run.id} is ${run.status}/${run.conclusion ?? "null"}, not completed/success`);
};

export const selectUniqueCompleted = (
	rows: readonly unknown[],
	name: string,
	kind: "check" | "artifact",
): Attempt<Record<string, unknown>> => {
	const named = rows.filter((value) => isRecord(value) && value.name === name);
	if (named.length !== 1) {
		return fail(
			named.length === 0
				? `produced no ${name} ${kind}`
				: `produced ${named.length} ${name} ${kind}s — the ${kind} is ambiguous`,
		);
	}
	const selected = named[0] as Record<string, unknown>;
	if (kind === "check" && (selected.status !== "completed" || selected.conclusion !== "success")) {
		return fail(`the ${name} check is not completed/success`);
	}
	if (kind === "artifact") {
		if (typeof selected.expired !== "boolean") {
			return fail(`the ${name} artifact has no valid expiration state`);
		}
		if (selected.expired) return fail(`the ${name} artifact is expired`);
	}
	return ok(selected);
};

export const safeArtifactMembers = (listing: string): readonly string[] | null => {
	const rows = listing.split(/\r?\n/).filter((row) => row !== "");
	if (rows.length === 0 || !rows.includes("manifest.json") || new Set(rows).size !== rows.length)
		return null;
	return rows.every(
		(row) =>
			!row.startsWith("/") &&
			!row.startsWith("\\") &&
			!row.split(/[\\/]/).includes("..") &&
			(row === "manifest.json" || /^captures\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(row)),
	)
		? rows
		: null;
};

export const hasExactManifestMembers = (
	members: readonly string[],
	manifestText: string,
): boolean | null => {
	const parsed = parseCiCaptureManifest(manifestText);
	if (parsed._tag !== "Manifest") return null;
	const expected = new Set([
		"manifest.json",
		...parsed.value.captures.map((capture) => capture.path),
	]);
	return members.length === expected.size && members.every((member) => expected.has(member));
};

export const resolveCiIdentity = (
	repo: string,
	pr: number,
	head: string,
	authorityHead: string,
	harness: LocalhostHarnessDeclaration,
): Shell<Attempt<CiIdentity>> =>
	Effect.gen(function* () {
		const listed = yield* runsForWorkflow(repo, harness.workflow);
		if (listed._tag === "Failure") return listed;
		const selectedRun = selectTrustedRun(listed.value, repo, pr, head, authorityHead, harness);
		if (selectedRun._tag === "Failure") return selectedRun;
		const run = selectedRun.value;

		const token = yield* ambientToken;
		if (token._tag === "Failure") return token;
		const checks = yield* onTransport(
			pagedEnvelope(
				token.value,
				`repos/${repo}/check-suites/${run.checkSuiteId}/check-runs`,
				"check_runs",
			),
		);
		if (checks._tag === "Failure") return checks;
		const selectedCheck = selectUniqueCompleted(checks.value.entries, harness.check, "check");
		if (selectedCheck._tag === "Failure") return fail(`run ${run.id} ${selectedCheck.reason}`);
		const check = selectedCheck.value;
		if (typeof check.id !== "number") return fail(`the ${harness.check} check has no id`);

		const artifacts = yield* onTransport(
			pagedEnvelope(token.value, `repos/${repo}/actions/runs/${run.id}/artifacts`, "artifacts"),
		);
		if (artifacts._tag === "Failure") return artifacts;
		const selectedArtifact = selectUniqueCompleted(
			artifacts.value.entries,
			harness.artifact,
			"artifact",
		);
		if (selectedArtifact._tag === "Failure")
			return fail(`run ${run.id} ${selectedArtifact.reason}`);
		const artifact = selectedArtifact.value;
		if (typeof artifact.id !== "number") return fail(`the ${harness.artifact} artifact has no id`);
		return ok({
			runId: run.id,
			checkId: check.id,
			artifactId: artifact.id,
			artifactName: harness.artifact,
			authorityHead: run.authorityHead,
		});
	});

export const fetchCiBundle = (
	repo: string,
	pr: number,
	head: string,
	authorityHead: string,
	harness: LocalhostHarnessDeclaration,
	scratchRoot: string,
): Shell<CiBundleAttempt> =>
	Effect.gen(function* () {
		const identity = yield* resolveCiIdentity(repo, pr, head, authorityHead, harness);
		if (identity._tag === "Failure") return identity;
		const token = yield* ambientToken;
		if (token._tag === "Failure") return token;
		const downloaded = yield* onTransport(
			restBytes(token.value, `repos/${repo}/actions/artifacts/${identity.value.artifactId}/zip`),
		);
		if (downloaded._tag === "Unreachable") return fail(downloaded.reason);
		if (downloaded.status < 200 || downloaded.status >= 300) {
			return fail(`GitHub answered HTTP ${downloaded.status}`);
		}
		if (downloaded.value[0] !== 0x50 || downloaded.value[1] !== 0x4b) {
			return fail("the downloaded artifact is not a zip archive");
		}
		const directory = yield* Effect.tryPromise({
			try: () => mkdtemp(join(scratchRoot, "ci-artifact-")),
			catch: (cause) => `cannot allocate artifact scratch: ${String(cause)}`,
		}).pipe(Effect.match({onFailure: fail, onSuccess: ok}));
		if (directory._tag === "Failure") return directory;
		const zip = join(directory.value, "artifact.zip");
		const written = yield* Effect.tryPromise({
			try: () => writeFile(zip, downloaded.value),
			catch: (cause) => `cannot write the artifact: ${String(cause)}`,
		}).pipe(Effect.match({onFailure: fail, onSuccess: () => ok(undefined)}));
		if (written._tag === "Failure") return written;
		const list = yield* execCapture("unzip", ["-Z1", zip]);
		if (!list.ok) return fail(`cannot enumerate the artifact: ${list.reason}`);
		const members = safeArtifactMembers(list.stdout);
		if (members === null || !members.includes("manifest.json")) {
			return {
				...fail("the artifact has unsafe, duplicate, or incomplete members"),
				kind: "malformed-members" as const,
			};
		}
		const extracted = yield* execCapture("unzip", ["-qq", zip, "-d", directory.value]);
		if (!extracted.ok) return fail(`cannot extract the artifact: ${extracted.reason}`);
		const manifest = yield* Effect.tryPromise({
			try: () => readFile(join(directory.value, "manifest.json"), "utf8"),
			catch: (cause) => `cannot read the artifact manifest: ${String(cause)}`,
		}).pipe(Effect.match({onFailure: fail, onSuccess: ok}));
		if (manifest._tag === "Failure") return manifest;
		if (hasExactManifestMembers(members, manifest.value) === false) {
			return {
				...fail("the artifact has extra or unmanifested members"),
				kind: "malformed-members" as const,
			};
		}
		return ok({
			...identity.value,
			directory: directory.value,
			manifestText: manifest.value,
		});
	});
