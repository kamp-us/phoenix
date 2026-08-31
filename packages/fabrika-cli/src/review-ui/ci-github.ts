/**
 * The governed Actions evidence resolver. Its failure union is closed so a caller can distinguish a
 * proven missing/unusable producer tuple from transport, token, authority, scratch, unzip, and
 * runtime states that prove nothing about evidence availability.
 */
import {isUtf8} from "node:buffer";
import {lstat, mkdtemp, readFile, realpath, writeFile} from "node:fs/promises";
import {join, sep} from "node:path";
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {
	ambientToken,
	type EnvelopeRead,
	onTransport,
	pagedEnvelope,
	restBytes,
} from "../io/gh-api.ts";
import type {Shell} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import {type LocalhostHarnessDeclaration, parseCiCaptureManifest} from "./localhost-evidence.ts";

export interface RunRecord {
	readonly id: number;
	readonly status: string;
	readonly conclusion: string | null;
	readonly event: string;
	readonly path: string;
	readonly repository: string;
	readonly subjectHead: string;
	readonly title: string;
	readonly checkSuiteId: number;
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
	/** Bytes read only after every central-directory member passed lstat/realpath containment. */
	readonly memberBytes: Readonly<Record<string, Uint8Array>>;
}

export type CiEvidenceFailure =
	| {readonly _tag: "ProducerUnavailable"; readonly reason: string}
	| {readonly _tag: "MalformedArtifact"; readonly reason: string}
	| {readonly _tag: "TransportUnknown"; readonly reason: string}
	| {readonly _tag: "TokenUnknown"; readonly reason: string}
	| {readonly _tag: "AuthorityReadUnknown"; readonly reason: string}
	| {readonly _tag: "ScratchUnknown"; readonly reason: string}
	| {readonly _tag: "UnzipUnknown"; readonly reason: string}
	| {readonly _tag: "RuntimeUnknown"; readonly reason: string};

export type CiEvidenceAttempt<A> = {readonly _tag: "Ok"; readonly value: A} | CiEvidenceFailure;
export type CiBundleAttempt = CiEvidenceAttempt<CiBundle>;

export const ciOk = <A>(value: A): CiEvidenceAttempt<A> => ({_tag: "Ok", value});
export const producerUnavailable = (reason: string): CiEvidenceFailure => ({
	_tag: "ProducerUnavailable",
	reason,
});
export const malformedArtifact = (reason: string): CiEvidenceFailure => ({
	_tag: "MalformedArtifact",
	reason,
});
export const transportUnknown = (reason: string): CiEvidenceFailure => ({
	_tag: "TransportUnknown",
	reason,
});
export const tokenUnknown = (reason: string): CiEvidenceFailure => ({_tag: "TokenUnknown", reason});
export const authorityReadUnknown = (reason: string): CiEvidenceFailure => ({
	_tag: "AuthorityReadUnknown",
	reason,
});
export const scratchUnknown = (reason: string): CiEvidenceFailure => ({
	_tag: "ScratchUnknown",
	reason,
});
export const unzipUnknown = (reason: string): CiEvidenceFailure => ({_tag: "UnzipUnknown", reason});
export const runtimeUnknown = (reason: string): CiEvidenceFailure => ({
	_tag: "RuntimeUnknown",
	reason,
});

export const decodeWorkflowRuns = (
	entries: readonly unknown[],
): CiEvidenceAttempt<readonly RunRecord[]> => {
	const runs: RunRecord[] = [];
	for (const value of entries) {
		if (
			!isRecord(value) ||
			typeof value.id !== "number" ||
			typeof value.status !== "string" ||
			typeof value.event !== "string" ||
			typeof value.path !== "string" ||
			(value.conclusion !== null && typeof value.conclusion !== "string") ||
			!isRecord(value.repository) ||
			typeof value.repository.full_name !== "string" ||
			typeof value.head_sha !== "string" ||
			typeof value.display_title !== "string" ||
			typeof value.check_suite_id !== "number"
		) {
			return runtimeUnknown("GitHub answered 200 but one workflow run is incomplete");
		}
		runs.push({
			id: value.id,
			status: value.status,
			conclusion: value.conclusion,
			event: value.event,
			path: value.path,
			repository: value.repository.full_name,
			subjectHead: value.head_sha,
			title: value.display_title,
			checkSuiteId: value.check_suite_id,
		});
	}
	return ciOk(runs);
};

export const completeEnvelope = (
	read: EnvelopeRead,
	kind: "workflow runs" | "check runs" | "artifacts",
): CiEvidenceAttempt<readonly unknown[]> => {
	if (!read.exhausted) return runtimeUnknown(`${kind} pagination did not reach a terminal page`);
	if (read.declared !== read.entries.length) {
		return runtimeUnknown(
			`${kind} declared ${read.declared} row(s), but GitHub returned ${read.entries.length}`,
		);
	}
	return ciOk(read.entries);
};

/** Exhaustively enumerate one governed workflow's runs without selecting an evidence state. */
export const runsForWorkflow = (
	repo: string,
	workflow: string,
): Shell<CiEvidenceAttempt<readonly RunRecord[]>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		if (token._tag === "Failure") return tokenUnknown(token.reason);
		const read = yield* onTransport(
			pagedEnvelope(
				token.value,
				`repos/${repo}/actions/workflows/${encodeURIComponent(workflow.split("/").at(-1) ?? workflow)}/runs`,
				"workflow_runs",
			),
		);
		if (read._tag === "Failure") return transportUnknown(read.reason);
		const complete = completeEnvelope(read.value, "workflow runs");
		return complete._tag === "Ok" ? decodeWorkflowRuns(complete.value) : complete;
	});

export const selectTrustedRun = (
	runs: readonly RunRecord[],
	repo: string,
	pr: number,
	head: string,
	authorityHead: string,
	harness: LocalhostHarnessDeclaration,
): CiEvidenceAttempt<RunRecord> => {
	const expectedTitle = `review-ui localhost evidence / ${harness.id} / PR #${pr} / subject ${head} / authority ${authorityHead}`;
	const associated = runs.filter(
		(run) =>
			run.path === harness.workflow &&
			run.event === harness.event &&
			run.repository === repo &&
			run.subjectHead === head &&
			run.title === expectedTitle,
	);
	if (associated.length !== 1) {
		return producerUnavailable(
			associated.length === 0
				? `no ${harness.workflow} run is associated with PR #${pr} at ${head}`
				: `${associated.length} ${harness.workflow} runs are associated with PR #${pr} at ${head} — the producer is ambiguous`,
		);
	}
	const run = associated[0] as RunRecord;
	return run.status === "completed" && run.conclusion === "success"
		? ciOk(run)
		: producerUnavailable(
				`run ${run.id} is ${run.status}/${run.conclusion ?? "null"}, not completed/success`,
			);
};

export const selectUniqueCompleted = (
	rows: readonly unknown[],
	name: string,
	kind: "check" | "artifact",
): CiEvidenceAttempt<Record<string, unknown>> => {
	for (const value of rows) {
		if (
			!isRecord(value) ||
			typeof value.id !== "number" ||
			typeof value.name !== "string" ||
			(kind === "check" &&
				(typeof value.status !== "string" ||
					(value.conclusion !== null && typeof value.conclusion !== "string"))) ||
			(kind === "artifact" && typeof value.expired !== "boolean")
		) {
			return runtimeUnknown(`GitHub answered 200 but one ${kind} row is incomplete`);
		}
	}
	const named = rows.filter((value) => isRecord(value) && value.name === name);
	if (named.length !== 1) {
		return producerUnavailable(
			named.length === 0
				? `produced no ${name} ${kind}`
				: `produced ${named.length} ${name} ${kind}s — the ${kind} is ambiguous`,
		);
	}
	const selected = named[0] as Record<string, unknown>;
	if (kind === "check" && (selected.status !== "completed" || selected.conclusion !== "success")) {
		return producerUnavailable(`the ${name} check is not completed/success`);
	}
	if (kind === "artifact" && selected.expired === true) {
		return producerUnavailable(`the ${name} artifact is expired`);
	}
	return ciOk(selected);
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

const u16 = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, offset: number): number =>
	(u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;

/** Names only regular central-directory entries; symlinks/devices/directories refuse pre-extract. */
export const safeCentralDirectoryMembers = (archive: Uint8Array): readonly string[] | null => {
	const minimum = Math.max(0, archive.length - 22 - 65_535);
	let eocd = -1;
	for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
		if (u32(archive, offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0 || u16(archive, eocd + 4) !== 0 || u16(archive, eocd + 6) !== 0) return null;
	const entries = u16(archive, eocd + 10);
	if (entries === 0 || entries !== u16(archive, eocd + 8)) return null;
	const centralSize = u32(archive, eocd + 12);
	const centralOffset = u32(archive, eocd + 16);
	if (centralOffset + centralSize !== eocd || centralOffset > archive.length) return null;
	const decoder = new TextDecoder();
	const names: string[] = [];
	let offset = centralOffset;
	for (let index = 0; index < entries; index += 1) {
		if (offset + 46 > eocd || u32(archive, offset) !== 0x02014b50) return null;
		const madeBy = u16(archive, offset + 4) >>> 8;
		const nameLength = u16(archive, offset + 28);
		const extraLength = u16(archive, offset + 30);
		const commentLength = u16(archive, offset + 32);
		const external = u32(archive, offset + 38);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (nameLength === 0 || end > eocd) return null;
		const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
		if (!isUtf8(nameBytes)) return null;
		const name = decoder.decode(nameBytes);
		const unixType = (external >>> 16) & 0xf000;
		const regular =
			madeBy === 3 || madeBy === 19
				? unixType === 0x8000
				: !name.endsWith("/") && (external & 0x10) === 0;
		if (!regular) return null;
		names.push(name);
		offset = end;
	}
	if (offset !== eocd) return null;
	return safeArtifactMembers(`${names.join("\n")}\n`);
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
): Shell<CiEvidenceAttempt<CiIdentity>> =>
	Effect.gen(function* () {
		const listed = yield* runsForWorkflow(repo, harness.workflow);
		if (listed._tag !== "Ok") return listed;
		const selectedRun = selectTrustedRun(listed.value, repo, pr, head, authorityHead, harness);
		if (selectedRun._tag !== "Ok") return selectedRun;
		const run = selectedRun.value;

		const token = yield* ambientToken;
		if (token._tag === "Failure") return tokenUnknown(token.reason);
		const checks = yield* onTransport(
			pagedEnvelope(
				token.value,
				`repos/${repo}/check-suites/${run.checkSuiteId}/check-runs`,
				"check_runs",
			),
		);
		if (checks._tag === "Failure") return transportUnknown(checks.reason);
		const completeChecks = completeEnvelope(checks.value, "check runs");
		if (completeChecks._tag !== "Ok") return completeChecks;
		const selectedCheck = selectUniqueCompleted(completeChecks.value, harness.check, "check");
		if (selectedCheck._tag !== "Ok") return selectedCheck;
		const check = selectedCheck.value;
		if (typeof check.id !== "number") return runtimeUnknown(`the ${harness.check} check has no id`);

		const artifacts = yield* onTransport(
			pagedEnvelope(token.value, `repos/${repo}/actions/runs/${run.id}/artifacts`, "artifacts"),
		);
		if (artifacts._tag === "Failure") return transportUnknown(artifacts.reason);
		const completeArtifacts = completeEnvelope(artifacts.value, "artifacts");
		if (completeArtifacts._tag !== "Ok") return completeArtifacts;
		const selectedArtifact = selectUniqueCompleted(
			completeArtifacts.value,
			harness.artifact,
			"artifact",
		);
		if (selectedArtifact._tag !== "Ok") return selectedArtifact;
		const artifact = selectedArtifact.value;
		if (typeof artifact.id !== "number") {
			return runtimeUnknown(`the ${harness.artifact} artifact has no id`);
		}
		return ciOk({
			runId: run.id,
			checkId: check.id,
			artifactId: artifact.id,
			artifactName: harness.artifact,
			authorityHead,
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
		if (identity._tag !== "Ok") return identity;
		const token = yield* ambientToken;
		if (token._tag === "Failure") return tokenUnknown(token.reason);
		const downloaded = yield* onTransport(
			restBytes(token.value, `repos/${repo}/actions/artifacts/${identity.value.artifactId}/zip`),
		);
		if (downloaded._tag === "Unreachable") return transportUnknown(downloaded.reason);
		if (downloaded.status < 200 || downloaded.status >= 300) {
			return transportUnknown(`GitHub answered HTTP ${downloaded.status}`);
		}
		if (downloaded.value[0] !== 0x50 || downloaded.value[1] !== 0x4b) {
			return runtimeUnknown("the downloaded artifact is not a zip archive");
		}
		const directory = yield* Effect.tryPromise({
			try: () => mkdtemp(join(scratchRoot, "ci-artifact-")),
			catch: (cause) => scratchUnknown(`cannot allocate artifact scratch: ${String(cause)}`),
		}).pipe(Effect.result);
		if (directory._tag === "Failure") return directory.failure;
		const zip = join(directory.success, "artifact.zip");
		const written = yield* Effect.tryPromise({
			try: () => writeFile(zip, downloaded.value),
			catch: (cause) => scratchUnknown(`cannot write the artifact: ${String(cause)}`),
		}).pipe(Effect.result);
		if (written._tag === "Failure") return written.failure;
		const members = safeCentralDirectoryMembers(downloaded.value);
		if (members === null || !members.includes("manifest.json")) {
			return malformedArtifact(
				"the artifact central directory has unsafe, duplicate, incomplete, symlink, or non-regular members",
			);
		}
		const extracted = yield* execCapture("unzip", ["-qq", zip, "-d", directory.success]);
		if (!extracted.ok) return unzipUnknown(`cannot extract the artifact: ${extracted.reason}`);
		const inspected = yield* Effect.tryPromise({
			try: async () => {
				const root = await realpath(directory.success);
				const paths: Record<string, string> = {};
				for (const member of members) {
					const candidate = join(directory.success, member);
					const stat = await lstat(candidate);
					if (!stat.isFile() || stat.isSymbolicLink()) {
						return {_tag: "Unsafe" as const, reason: `${member} is not a regular extracted file`};
					}
					const resolved = await realpath(candidate);
					if (!resolved.startsWith(`${root}${sep}`)) {
						return {_tag: "Unsafe" as const, reason: `${member} resolves outside artifact scratch`};
					}
					paths[member] = resolved;
				}
				return {_tag: "Safe" as const, paths};
			},
			catch: (cause) =>
				malformedArtifact(`cannot prove extracted member containment: ${String(cause)}`),
		}).pipe(Effect.result);
		if (inspected._tag === "Failure") return inspected.failure;
		if (inspected.success._tag === "Unsafe") {
			return malformedArtifact(inspected.success.reason);
		}
		const paths = inspected.success.paths;
		const manifestBytes = yield* Effect.tryPromise({
			try: () => readFile(paths["manifest.json"] ?? ""),
			catch: (cause) => scratchUnknown(`cannot read the artifact manifest: ${String(cause)}`),
		}).pipe(Effect.result);
		if (manifestBytes._tag === "Failure") return manifestBytes.failure;
		if (!isUtf8(manifestBytes.success)) {
			return malformedArtifact("the artifact manifest is not UTF-8");
		}
		const manifestText = new TextDecoder().decode(manifestBytes.success);
		if (hasExactManifestMembers(members, manifestText) !== true) {
			return malformedArtifact("the artifact has extra, unmanifested, or malformed members");
		}
		const memberBytes: Record<string, Uint8Array> = {"manifest.json": manifestBytes.success};
		for (const member of members) {
			if (member === "manifest.json") continue;
			const bytes = yield* Effect.tryPromise({
				try: () => readFile(paths[member] ?? ""),
				catch: (cause) => scratchUnknown(`cannot read artifact member ${member}: ${String(cause)}`),
			}).pipe(Effect.result);
			if (bytes._tag === "Failure") return bytes.failure;
			memberBytes[member] = bytes.success;
		}
		return ciOk({
			...identity.value,
			directory: directory.success,
			manifestText,
			memberBytes,
		});
	});
